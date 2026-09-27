import { startBridge, trace } from "./bridge/native.js";
import { setGuardLogger, startForegroundGuard } from "./browser/foreground-guard.js";
import { BrowserSession, cleanupOrphanGroups, listSessions } from "./browser/session.js";

// Keep popups opened by agent-driven background tabs from stealing the user's focus.
startForegroundGuard();
setGuardLogger(trace);

// Groups from before an extension reload have no owning session any more; give the tabs back.
cleanupOrphanGroups().catch(() => undefined);

// Prerendered / instant pages commit into a new tab id; keep the owning session pointed at it.
chrome.webNavigation.onTabReplaced.addListener(async ({ replacedTabId, tabId }) => {
	for (const s of await listSessions()) {
		if (!s.tabIds.includes(replacedTabId) && s.homeTabId !== replacedTabId) continue;
		const session = await BrowserSession.open(s.id, s.label, s.windowId);
		await session.replaceTabId(replacedTabId, tabId);
	}
});

// External harnesses (omp, pi, Claude Code, Codex) drive the browser through the
// native-messaging bridge. Connects when the CLI has installed the host manifest.
startBridge();

// ============================================================================
// PER-TAB SIDE PANEL (Claude-in-Chrome model)
// ============================================================================
// The manifest declares no default side panel, so a tab shows the panel only when we
// enable it for that tab. Each task lives on the tab its panel was opened on (its "home
// tab"); every tab a task's session owns opens the same panel document via
// `sidepanel.html?tabId=<homeTab>`. Switching to a tab no task owns leaves that tab with
// no panel, so the panel is naturally confined to its task's tabs. Two tasks = two tabs,
// each with its own panel; put them in two windows to see both at once.
//
// The one exception: sitegeist's agent runs inside the panel document, and Chrome tears
// that document down when the panel is hidden. So while a task is mid-run we keep its
// panel enabled on the window's active tab even if the user peeks at another tab, and
// confine again once the run ends.

const PANEL_PATH = "sidepanel.html";
const PANEL_BUSY_PREFIX = "sidepanel_busy_";
const PANEL_TRACE_KEY = "sidepanel_trace";
const SIDEPANEL_OPEN_KEY = "sidepanel_open_windows";

// Desired per-tab panel path (undefined = disabled). Avoids redundant setOptions calls.
const panelPathCache = new Map<number, string | undefined>();
let openSidepanels = new Set<number>();

chrome.storage.session.get(SIDEPANEL_OPEN_KEY, (data) => {
	openSidepanels = new Set<number>((data[SIDEPANEL_OPEN_KEY] as number[]) || []);
});

let panelTrace: string[] = [];
let traceFlush: ReturnType<typeof setTimeout> | undefined;
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

function recordPanelError(where: string, err: unknown): void {
	const message = `${where}: ${err instanceof Error ? err.message : String(err)}`;
	console.warn("[Background]", message);
	panelLog(`ERROR ${message}`);
	chrome.storage.session
		.set({ sidepanel_last_error: `${new Date().toISOString()} ${message}` })
		.catch(() => undefined);
}

/** Home tab of the task running in this window's panel, if one is mid-run. */
async function busyHomeTab(windowId: number): Promise<number | undefined> {
	const key = `${PANEL_BUSY_PREFIX}${windowId}`;
	const data = await chrome.storage.session.get(key);
	const value = data[key];
	return typeof value === "number" ? value : undefined;
}

interface OwnedTab {
	sessionId: string;
	homeTabId: number;
}

/** Map every tab owned by a non-bridge session to its session's home tab (for the panel URL). */
async function ownedTabs(windowId: number): Promise<Map<number, OwnedTab>> {
	const map = new Map<number, OwnedTab>();
	for (const s of await listSessions()) {
		if (s.id.startsWith("bridge-") || s.windowId !== windowId) continue;
		const homeTabId = s.homeTabId ?? s.tabIds[0];
		if (homeTabId === undefined) continue;
		for (const tabId of s.tabIds) map.set(tabId, { sessionId: s.id, homeTabId });
		// The home tab may be owned by an agent session (the panel was opened on its tab);
		// it still shows this task's panel.
		map.set(homeTabId, { sessionId: s.id, homeTabId });
	}
	return map;
}

/** Apply the desired panel path to a tab, skipping redundant calls. */
async function applyTab(tabId: number, path: string | undefined): Promise<void> {
	if (panelPathCache.get(tabId) === path) return;
	panelPathCache.set(tabId, path);
	try {
		if (path) await chrome.sidePanel.setOptions({ tabId, path, enabled: true });
		else await chrome.sidePanel.setOptions({ tabId, enabled: false });
		panelLog(`setOptions tab=${tabId} ${path ?? "disabled"}`);
	} catch (err) {
		panelPathCache.delete(tabId);
		panelLog(`setOptions tab=${tabId} FAILED ${err instanceof Error ? err.message : String(err)}`);
	}
}

/** Enable the panel on every tab each of this window's tasks owns. Only ever enables. */
async function enableOwnedTabs(windowId: number): Promise<void> {
	const owned = await ownedTabs(windowId);
	for (const [tabId, info] of owned) await applyTab(tabId, `${PANEL_PATH}?tabId=${info.homeTabId}`);
}

/**
 * Decide what the given (active) tab should show. Owned tabs show their task's panel.
 * A foreign tab shows nothing, unless a task in this window is mid-run — then it keeps
 * that task's panel so switching tabs during a run doesn't tear the agent down.
 */
async function reconcileActiveTab(windowId: number, tabId: number): Promise<void> {
	const owned = await ownedTabs(windowId);
	const own = owned.get(tabId);
	if (own) {
		await applyTab(tabId, `${PANEL_PATH}?tabId=${own.homeTabId}`);
		return;
	}
	const runningHome = openSidepanels.has(windowId) ? await busyHomeTab(windowId) : undefined;
	if (runningHome !== undefined) {
		await applyTab(tabId, `${PANEL_PATH}?tabId=${runningHome}`);
		return;
	}
	await applyTab(tabId, undefined);
}

/**
 * Open the panel on a tab the user deliberately clicked. A tab that already shows a panel
 * (its own task, or a running task kept visible while the user looks around) opens that
 * panel as is: re-pointing it would reload the panel document and kill the agent running
 * in it. Any other tab gets a fresh task bound to it.
 */
function openPanelOnTab(tabId: number, source: string): void {
	const existing = panelPathCache.get(tabId);
	if (existing) {
		chrome.sidePanel.open({ tabId }).catch((err) => recordPanelError(`open(${source})`, err));
		panelLog(`open tab=${tabId} (${source}, existing ${existing})`);
		return;
	}
	const path = `${PANEL_PATH}?tabId=${tabId}`;
	panelPathCache.set(tabId, path);
	// Both calls must run in the click's user-gesture tick; Chrome applies them in order.
	chrome.sidePanel.setOptions({ tabId, path, enabled: true }).catch((err) => recordPanelError("setOptions", err));
	chrome.sidePanel.open({ tabId }).catch((err) => recordPanelError(`open(${source})`, err));
	panelLog(`open tab=${tabId} (${source})`);
}

chrome.tabs.onActivated.addListener((info) => void reconcileActiveTab(info.windowId, info.tabId));
chrome.tabs.onRemoved.addListener((tabId) => panelPathCache.delete(tabId));

chrome.storage.onChanged.addListener((changes, area) => {
	if (area === "local" && "browser_sessions" in changes) void onSessionsChanged();
	if (area === "session" && Object.keys(changes).some((k) => k.startsWith(PANEL_BUSY_PREFIX)))
		void onActiveTabsChanged();
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

async function onActiveTabsChanged(): Promise<void> {
	const windows = await chrome.windows.getAll({ windowTypes: ["normal"] }).catch(() => []);
	for (const w of windows) {
		if (w.id === undefined) continue;
		const [active] = await chrome.tabs.query({ active: true, windowId: w.id }).catch(() => []);
		if (active?.id !== undefined) await reconcileActiveTab(w.id, active.id);
	}
}

// Toolbar icon: open a task on the current tab.
chrome.action.onClicked.addListener((tab: chrome.tabs.Tab) => {
	if (tab?.id !== undefined) openPanelOnTab(tab.id, "action");
});

// Listen for messages from userScripts (overlay in page).
if (chrome.runtime.onUserScriptMessage) {
	chrome.runtime.onUserScriptMessage.addListener((message, _sender, sendResponse) => {
		if (message.type === "abort-repl") {
			chrome.runtime.sendMessage(message);
			sendResponse({ success: true });
			return true;
		}
	});
}

// Track which windows currently have an open panel document (for the keyboard toggle).
chrome.runtime.onConnect.addListener((port: chrome.runtime.Port) => {
	const match = /^sidepanel:(\d+)$/.exec(port.name);
	if (!match) return;
	const windowId = Number(match[1]);
	panelLog(`panel connected window=${windowId}`);
	openSidepanels.add(windowId);
	void enableOwnedTabs(windowId);
	chrome.storage.session.get(SIDEPANEL_OPEN_KEY, (data) => {
		const open = new Set<number>((data[SIDEPANEL_OPEN_KEY] as number[]) || []);
		open.add(windowId);
		chrome.storage.session.set({ [SIDEPANEL_OPEN_KEY]: Array.from(open) });
	});
	port.onDisconnect.addListener(() => {
		panelLog(`panel disconnected window=${windowId}`);
		openSidepanels.delete(windowId);
		chrome.storage.session.get(SIDEPANEL_OPEN_KEY, (data) => {
			const open = new Set<number>((data[SIDEPANEL_OPEN_KEY] as number[]) || []);
			open.delete(windowId);
			chrome.storage.session.set({ [SIDEPANEL_OPEN_KEY]: Array.from(open) });
		});
	});
});

// Keyboard shortcut: open a task on the current tab (Chrome offers no per-tab close API).
chrome.commands.onCommand.addListener((command: string, sender?: chrome.tabs.Tab) => {
	if (command !== "toggle-sidepanel") return;
	if (sender?.id !== undefined) openPanelOnTab(sender.id, "command");
	else if (sender?.windowId !== undefined) chrome.sidePanel.open({ windowId: sender.windowId }).catch(() => undefined);
});
