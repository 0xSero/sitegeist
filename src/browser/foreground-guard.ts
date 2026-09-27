/**
 * Foreground guard, runs in the service worker.
 *
 * Pages driven in the background open popups and target=_blank links, and Chrome
 * makes those new tabs active, stealing the user's focus. When a new tab's opener
 * is a tab some session owns, hand the tab to that session's group and put the
 * user's previous tab back in front.
 */

import { allOwnedTabIds, BrowserSession, sessionOwningTab } from "./session.js";

/** Tabs already handled, so the two events that report one popup adopt it once. */
const handled = new Set<number>();
let guardLog: (line: string) => void = () => undefined;

/** Route guard decisions into the bridge's debug log. */
export function setGuardLogger(log: (line: string) => void): void {
	guardLog = log;
}

async function onNewTab(tabId: number, sourceTabId: number, via: string): Promise<void> {
	if (handled.has(tabId)) return;
	const owned = await allOwnedTabIds();
	if (!owned.has(sourceTabId) || owned.has(tabId)) return;
	guardLog(`new tab=${tabId} from owned tab=${sourceTabId} (${via})`);
	const owner = await sessionOwningTab(sourceTabId);
	if (!owner) return;
	handled.add(tabId);
	setTimeout(() => handled.delete(tabId), 60000);
	const tab = await chrome.tabs.get(tabId).catch(() => undefined);
	if (!tab) return;

	// Restore whatever the user had active in that window before this tab appeared, but only
	// when the agent opened it from a hidden tab. If the user is looking at the opener (they
	// clicked a link on a shared tab themselves), the new tab is theirs to see.
	const now = activeTab.get(tab.windowId);
	const userWasOn = now === tabId ? previousActiveTab.get(tab.windowId) : now;
	let restored = false;
	if (tab.active && userWasOn !== sourceTabId) {
		const previous = await chrome.tabs.query({ windowId: tab.windowId });
		// The tab active right before the popup is what the user was looking at; lastActive is
		// the fallback (it can already point at the popup, which is not owned when activated).
		const restore =
			previous.find((t) => t.id !== tabId && t.id === userWasOn) ??
			previous.find((t) => t.id !== tabId && t.id === lastActive.get(tab.windowId));
		const target = restore ?? previous.find((t) => t.id !== tabId && !owned.has(t.id ?? -1));
		if (target?.id !== undefined) {
			await chrome.tabs.update(target.id, { active: true }).catch(() => undefined);
			restored = true;
		}
	}

	const session = await BrowserSession.open(owner.id, owner.label, owner.windowId);
	// The popup becomes the session's current tab, as the model would expect after a click.
	await session.adopt(tabId, true);
	guardLog(`popup tab=${tabId} from=${sourceTabId} -> ${owner.id}${restored ? " (focus restored)" : ""}`);
}

export function startForegroundGuard(): void {
	chrome.tabs.onCreated.addListener((tab) => {
		if (tab.id !== undefined && tab.openerTabId !== undefined)
			void onNewTab(tab.id, tab.openerTabId, "opener").catch((e) => guardLog(`guard error ${e}`));
	});
	// target=_blank implies noopener, and then Chrome may not set openerTabId; this event
	// still names the source tab.
	chrome.webNavigation.onCreatedNavigationTarget.addListener(
		(d) => void onNewTab(d.tabId, d.sourceTabId, "target").catch((e) => guardLog(`guard error ${e}`)),
	);

	// Remember the user's active tab per window so the guard can restore it.
	chrome.tabs.onActivated.addListener(async (info) => {
		const before = activeTab.get(info.windowId);
		if (before !== undefined && before !== info.tabId) previousActiveTab.set(info.windowId, before);
		activeTab.set(info.windowId, info.tabId);
		const owned = await allOwnedTabIds();
		if (!owned.has(info.tabId)) lastActive.set(info.windowId, info.tabId);
	});
}

const lastActive = new Map<number, number>();
/** Active tab per window (any tab) and the one before it, to tell who opened a new tab. */
const activeTab = new Map<number, number>();
const previousActiveTab = new Map<number, number>();
