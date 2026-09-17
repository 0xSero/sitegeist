import { startBridge } from "./bridge/native.js";
import { startForegroundGuard } from "./browser/foreground-guard.js";
import { listSessions } from "./browser/session.js";
import type { LockedSessionsMessage, LockResultMessage, SidepanelToBackgroundMessage } from "./utils/port.js";

// Keep popups opened by agent-driven background tabs from stealing the user's focus.
startForegroundGuard();

// External harnesses (omp, pi, Claude Code, Codex) drive the browser through the
// native-messaging bridge. Connects when the CLI has installed the host manifest.
startBridge();

// ============================================================================
// SIDE PANEL FOLLOWS ITS TAB GROUP
// ============================================================================
// While a side panel is open in a window, it stays available only on the tabs its
// session owns (the session's tab group). Switching to any other tab hides it;
// switching back shows it again. When no panel is open, every tab can open one.

const panelEnabledCache = new Map<number, boolean>();
const PANEL_BUSY_PREFIX = "sidepanel_busy_";

/** True while the panel's agent in this window is mid-run; the panel must not be torn down then. */
async function panelBusy(windowId: number): Promise<boolean> {
	const key = `${PANEL_BUSY_PREFIX}${windowId}`;
	const data = await chrome.storage.session.get(key);
	return data[key] === true;
}

async function ownedTabsForWindow(windowId: number): Promise<Set<number> | null> {
	const sessions = (await listSessions()).filter((s) => !s.id.startsWith("bridge-") && s.windowId === windowId);
	const owned = new Set<number>();
	for (const s of sessions) for (const id of s.tabIds) owned.add(id);
	return owned.size > 0 ? owned : null;
}

async function setPanelEnabled(tabId: number, enabled: boolean): Promise<void> {
	if (panelEnabledCache.get(tabId) === enabled) return;
	panelEnabledCache.set(tabId, enabled);
	try {
		await chrome.sidePanel.setOptions({ tabId, enabled });
	} catch {
		panelEnabledCache.delete(tabId);
	}
}

async function syncPanelForWindow(windowId: number): Promise<void> {
	const tabs = await chrome.tabs.query({ windowId }).catch(() => []);
	// Chrome tears the panel document down while it is hidden on a foreign tab and
	// recreates it on an owned one, so "no port" does not mean "closed by the user".
	// The per-tab state therefore follows the session's tabs alone; opening the panel
	// explicitly (icon or shortcut) re-enables the tab it is opened on.
	// Hiding the panel destroys its document, which would abort a running agent. While
	// the agent works the panel stays available everywhere in the window; once it is idle
	// the panel is confined to its own tabs again.
	const owned = (await panelBusy(windowId)) ? null : await ownedTabsForWindow(windowId);
	for (const tab of tabs) {
		if (tab.id === undefined) continue;
		await setPanelEnabled(tab.id, owned === null ? true : owned.has(tab.id));
	}
}

/**
 * Make the panel available on a tab the user is deliberately opening it on. Not awaited
 * by callers: sidePanel.open must run in the same tick as the user gesture, and Chrome
 * applies the two calls in order.
 */
function enablePanelForTab(tabId: number): void {
	panelEnabledCache.set(tabId, true);
	chrome.sidePanel.setOptions({ tabId, enabled: true }).catch(() => undefined);
}

async function syncAllPanels(): Promise<void> {
	const windows = await chrome.windows.getAll({ windowTypes: ["normal"] }).catch(() => []);
	for (const w of windows) if (w.id !== undefined) await syncPanelForWindow(w.id);
}

chrome.tabs.onActivated.addListener((info) => void syncPanelForWindow(info.windowId));
chrome.tabs.onCreated.addListener((tab) => void syncPanelForWindow(tab.windowId));
chrome.tabs.onRemoved.addListener((tabId) => panelEnabledCache.delete(tabId));
chrome.storage.onChanged.addListener((changes, area) => {
	if (area !== "session") return;
	if ("browser_sessions" in changes || Object.keys(changes).some((k) => k.startsWith(PANEL_BUSY_PREFIX))) {
		void syncAllPanels();
	}
});

// Called when Sitegeist icon is clicked - opens sidepanel for current tab
chrome.action.onClicked.addListener((tab: chrome.tabs.Tab) => {
	const tabId = tab?.id;
	if (tabId && chrome.sidePanel.open) {
		// The tab may be outside the current session's group; opening here adopts it.
		enablePanelForTab(tabId);
		chrome.sidePanel.open({ tabId }).catch((err) => console.warn("[Background] sidePanel.open failed:", err));
	}
});

// Listen for messages from userScripts (overlay in page)
console.log("[Background] onUserScriptMessage available:", !!chrome.runtime.onUserScriptMessage);
if (chrome.runtime.onUserScriptMessage) {
	chrome.runtime.onUserScriptMessage.addListener((message, sender, sendResponse) => {
		console.log("[Background] Received userScript message:", message, "from:", sender);
		if (message.type === "abort-repl") {
			// Forward to all open sidepanels (they'll check if they're streaming)
			console.log("[Background] Relaying abort-repl to sidepanels");
			chrome.runtime.sendMessage(message);
			sendResponse({ success: true });
			return true;
		}
	});
	console.log("[Background] onUserScriptMessage listener registered");
} else {
	console.error("[Background] onUserScriptMessage NOT available!");
}

// Storage keys for tracking state (persists across service worker sleep)
const SIDEPANEL_OPEN_KEY = "sidepanel_open_windows";
const SESSION_LOCKS_KEY = "session_locks"; // sessionId -> windowId mapping

// Synchronously readable cache of which sidepanels are open
// Gets populated on startup and updated by port events
let openSidepanels = new Set<number>();

// Initialize cache from storage on startup
chrome.storage.session.get(SIDEPANEL_OPEN_KEY, (data) => {
	openSidepanels = new Set<number>((data[SIDEPANEL_OPEN_KEY] as number[]) || []);
	console.log("[Background] Initialized openSidepanels cache:", Array.from(openSidepanels));
});

// Handle port connections from sidepanels
chrome.runtime.onConnect.addListener((port: chrome.runtime.Port) => {
	// Port name format: "sidepanel:${windowId}"
	const match = /^sidepanel:(\d+)$/.exec(port.name);
	if (!match) return;

	const windowId = Number(match[1]);

	// Update cache synchronously
	openSidepanels.add(windowId);

	// Mark sidepanel as open in persistent storage (survives service worker sleep)
	chrome.storage.session.get(SIDEPANEL_OPEN_KEY, (data) => {
		const openWindows = new Set<number>((data[SIDEPANEL_OPEN_KEY] as number[]) || []);
		openWindows.add(windowId);
		chrome.storage.session.set({ [SIDEPANEL_OPEN_KEY]: Array.from(openWindows) });
	});

	port.onMessage.addListener((msg: SidepanelToBackgroundMessage) => {
		if (msg.type === "acquireLock") {
			const { sessionId, windowId: reqWindowId } = msg;

			// Read current locks from persistent storage
			chrome.storage.session.get(SESSION_LOCKS_KEY, (data) => {
				const sessionLocks: Record<string, number> = (data[SESSION_LOCKS_KEY] as Record<string, number>) || {};
				const ownerWindowId = sessionLocks[sessionId];
				const ownerSidepanelOpen = ownerWindowId !== undefined && openSidepanels.has(ownerWindowId);

				// Grant lock if: no owner, owner sidepanel closed, or requesting window is owner
				const success = !ownerWindowId || !ownerSidepanelOpen || ownerWindowId === reqWindowId;

				const response: LockResultMessage = success
					? {
							type: "lockResult",
							sessionId,
							success: true,
						}
					: {
							type: "lockResult",
							sessionId,
							success: false,
							ownerWindowId,
						};

				if (success) {
					// Update locks in storage
					sessionLocks[sessionId] = reqWindowId;
					chrome.storage.session.set({ [SESSION_LOCKS_KEY]: sessionLocks });
				}

				port.postMessage(response);
			});
		} else if (msg.type === "getLockedSessions") {
			// Read current locks from persistent storage
			chrome.storage.session.get(SESSION_LOCKS_KEY, (data) => {
				const locks: Record<string, number> = (data[SESSION_LOCKS_KEY] as Record<string, number>) || {};
				const response: LockedSessionsMessage = {
					type: "lockedSessions",
					locks,
				};
				port.postMessage(response);
			});
		}
	});

	port.onDisconnect.addListener(() => {
		closeSidepanel(windowId, false);
	});
});

// Clean up locks when entire window closes (belt-and-suspenders)
chrome.windows.onRemoved.addListener((windowId: number) => {
	closeSidepanel(windowId, false);
});

// Handle keyboard shortcut - toggle sidepanel open/close
chrome.commands.onCommand.addListener((command: string, sender?: chrome.tabs.Tab) => {
	if (command === "toggle-sidepanel") {
		if (!sender?.windowId) {
			console.log("[Background] Cannot toggle sidepanel: sender windowId not available");
			return;
		}

		const windowId = sender.windowId;

		// Check synchronous cache (populated from storage on startup and updated by port events)
		if (openSidepanels.has(windowId)) {
			// Sidepanel is open - close it using Chrome 141+ API
			closeSidepanel(windowId);
		} else if (sender?.id !== undefined) {
			// Sidepanel is closed - open it on this tab (enabling it there if it was outside the group)
			const tabId = sender.id;
			enablePanelForTab(tabId);
			chrome.sidePanel.open({ tabId }).catch((err) => console.warn("[Background] sidePanel.open failed:", err));
		} else {
			chrome.sidePanel.open({ windowId });
		}
	}
});

function closeSidepanel(windowId: number, callCloseOnSidePanelAPI: boolean = true) {
	if (callCloseOnSidePanelAPI) {
		(chrome.sidePanel as any).close({ windowId });
	}

	// Update cache synchronously
	openSidepanels.delete(windowId);

	// Clean up storage state (same logic as onDisconnect)
	chrome.storage.session.get([SESSION_LOCKS_KEY, SIDEPANEL_OPEN_KEY], (data) => {
		// Release session locks for this window
		const sessionLocks: Record<string, number> = (data[SESSION_LOCKS_KEY] as Record<string, number>) || {};
		for (const sessionId in sessionLocks) {
			if (sessionLocks[sessionId] === windowId) {
				delete sessionLocks[sessionId];
			}
		}

		// Mark sidepanel as closed
		const openWindows = new Set<number>((data[SIDEPANEL_OPEN_KEY] as number[]) || []);
		openWindows.delete(windowId);

		// Save both updates atomically
		chrome.storage.session.set({
			[SESSION_LOCKS_KEY]: sessionLocks,
			[SIDEPANEL_OPEN_KEY]: Array.from(openWindows),
		});
	});
}
