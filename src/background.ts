import { startBridge } from "./bridge/native.js";
import { startForegroundGuard } from "./browser/foreground-guard.js";
import { cleanupOrphanGroups, listSessions } from "./browser/session.js";
import type { LockedSessionsMessage, LockResultMessage, SidepanelToBackgroundMessage } from "./utils/port.js";

// Keep popups opened by agent-driven background tabs from stealing the user's focus.
startForegroundGuard();

// Groups from before an extension reload have no owning session any more; give the tabs back.
cleanupOrphanGroups().catch(() => undefined);

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
const PANEL_TRACE_KEY = "sidepanel_trace";
let panelTrace: string[] = [];
let traceFlush: ReturnType<typeof setTimeout> | undefined;

/** Timestamped log of panel-related events, readable through `sitegeist debug`. */
function panelLog(line: string): void {
	panelTrace.push(`${new Date().toISOString().slice(11, 23)} ${line}`);
	if (panelTrace.length > 120) panelTrace = panelTrace.slice(-120);
	if (!traceFlush) {
		traceFlush = setTimeout(() => {
			traceFlush = undefined;
			chrome.storage.session.set({ [PANEL_TRACE_KEY]: panelTrace }).catch(() => undefined);
		}, 150);
	}
}
chrome.storage.session.get(PANEL_TRACE_KEY).then((d) => {
	const saved = d[PANEL_TRACE_KEY] as string[] | undefined;
	if (saved?.length) panelTrace = [...saved, ...panelTrace].slice(-120);
	panelLog("worker started");
});

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

const PANEL_PATH = "sidepanel.html";
// Tabs the panel was just opened on: never disabled until they are genuinely owned,
// so a sync racing ahead of adoption cannot hide (and thereby close) a fresh panel.
const protectedTabs = new Map<number, number>();
const PROTECT_MS = 15000;

function protectTab(tabId: number): void {
	protectedTabs.set(tabId, Date.now() + PROTECT_MS);
}
function isProtected(tabId: number): boolean {
	const until = protectedTabs.get(tabId);
	if (until === undefined) return false;
	if (Date.now() > until) {
		protectedTabs.delete(tabId);
		return false;
	}
	return true;
}

async function setPanelEnabled(tabId: number, enabled: boolean): Promise<void> {
	if (panelEnabledCache.get(tabId) === enabled) return;
	panelEnabledCache.set(tabId, enabled);
	try {
		// A tab-specific option must carry the path, or Chrome has no panel to open there.
		await chrome.sidePanel.setOptions({ tabId, path: PANEL_PATH, enabled });
		panelLog(`setOptions tab=${tabId} enabled=${enabled}`);
	} catch (err) {
		panelEnabledCache.delete(tabId);
		panelLog(`setOptions tab=${tabId} enabled=${enabled} FAILED ${err instanceof Error ? err.message : String(err)}`);
	}
}

function recordPanelError(where: string, err: unknown): void {
	const message = `${where}: ${err instanceof Error ? err.message : String(err)}`;
	console.warn("[Background]", message);
	panelLog(`ERROR ${message}`);
	chrome.storage.session
		.set({ sidepanel_last_error: `${new Date().toISOString()} ${message}` })
		.catch(() => undefined);
}

/**
 * Enable the side panel on the tabs the current session owns in a window. This only ever
 * ENABLES tabs; it never disables, so it cannot close a panel. Hiding is handled solely by
 * {@link hideForForeignTab} when the user switches to a tab the session does not own.
 */
async function enableOwnedTabs(windowId: number): Promise<void> {
	const owned = await ownedTabsForWindow(windowId);
	if (!owned) return;
	for (const tabId of owned) await setPanelEnabled(tabId, true);
}

/**
 * When the user switches tabs, hide the panel if the newly active tab is foreign, or show
 * it if the tab is owned. This is the only place a tab is ever disabled — Chrome hides the
 * panel exactly when the active tab has `enabled:false`. Skipped while the agent is mid-run
 * (hiding destroys the panel document and would abort the run) and for protected tabs.
 */
async function reconcileActiveTab(windowId: number, tabId: number): Promise<void> {
	if (!openSidepanels.has(windowId)) return; // no panel open in this window; leave tabs alone
	const owned = await ownedTabsForWindow(windowId);
	if (owned === null) return; // session owns nothing yet; nothing to confine to
	if (owned.has(tabId)) {
		await setPanelEnabled(tabId, true);
		return;
	}
	if (isProtected(tabId)) return;
	if (await panelBusy(windowId)) return; // keep visible everywhere while working
	await setPanelEnabled(tabId, false);
}

/**
 * Make the panel available on a tab the user is deliberately opening it on. Not awaited by
 * callers: sidePanel.open must run in the same tick as the user gesture, and Chrome applies
 * the two calls in order.
 */
function enablePanelForTab(tabId: number): void {
	panelLog(`enable+open tab=${tabId}`);
	protectTab(tabId);
	panelEnabledCache.set(tabId, true);
	chrome.sidePanel
		.setOptions({ tabId, path: PANEL_PATH, enabled: true })
		.catch((err) => recordPanelError("setOptions", err));
}

chrome.tabs.onActivated.addListener((info) => void reconcileActiveTab(info.windowId, info.tabId));
chrome.tabs.onRemoved.addListener((tabId) => {
	panelEnabledCache.delete(tabId);
	protectedTabs.delete(tabId);
});
chrome.storage.onChanged.addListener((changes, area) => {
	// A session gained tabs (adoption, navigation): make sure those tabs are enabled, and
	// re-check the active tab of each window in case it just became owned or foreign.
	if (area === "local" && "browser_sessions" in changes) void onSessionsChanged();
	if (area === "session" && Object.keys(changes).some((k) => k.startsWith(PANEL_BUSY_PREFIX))) void onBusyChanged();
});

async function onSessionsChanged(): Promise<void> {
	const windows = await chrome.windows.getAll({ windowTypes: ["normal"] }).catch(() => []);
	for (const w of windows) {
		if (w.id === undefined) continue;
		await enableOwnedTabs(w.id);
		const [active] = await chrome.tabs.query({ active: true, windowId: w.id }).catch(() => []);
		if (active?.id !== undefined) await reconcileActiveTab(w.id, active.id);
	}
}

async function onBusyChanged(): Promise<void> {
	// When a run ends, confine the panel again by re-checking each window's active tab.
	const windows = await chrome.windows.getAll({ windowTypes: ["normal"] }).catch(() => []);
	for (const w of windows) {
		if (w.id === undefined) continue;
		const [active] = await chrome.tabs.query({ active: true, windowId: w.id }).catch(() => []);
		if (active?.id !== undefined) await reconcileActiveTab(w.id, active.id);
	}
}

// Called when Sitegeist icon is clicked - opens sidepanel for current tab
chrome.action.onClicked.addListener((tab: chrome.tabs.Tab) => {
	const tabId = tab?.id;
	if (tabId && chrome.sidePanel.open) {
		// The tab may be outside the current session's group; opening here adopts it.
		enablePanelForTab(tabId);
		chrome.sidePanel.open({ tabId }).catch((err) => recordPanelError("open(action)", err));
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
	panelLog(`panel port connected window=${windowId}`);

	// Update cache synchronously
	openSidepanels.add(windowId);

	// The panel is showing on this window's active tab; protect that tab so no sync can
	// disable it before the session adopts it, and enable the session's tabs.
	chrome.tabs.query({ active: true, windowId }).then(([active]) => {
		if (active?.id !== undefined) protectTab(active.id);
	});
	void enableOwnedTabs(windowId);

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
		panelLog(`panel port disconnected window=${windowId}`);
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
			chrome.sidePanel.open({ tabId }).catch((err) => recordPanelError("open(command)", err));
		} else {
			chrome.sidePanel.open({ windowId });
		}
	}
});

function closeSidepanel(windowId: number, callCloseOnSidePanelAPI: boolean = true) {
	if (callCloseOnSidePanelAPI) {
		panelLog(`sidePanel.close window=${windowId} (toggle)`);
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
