/**
 * Foreground guard, runs in the service worker.
 *
 * Pages driven in the background open popups and target=_blank links, and Chrome
 * makes those new tabs active, stealing the user's focus. When a new tab's opener
 * is a tab some session owns, hand the tab to that session's group and put the
 * user's previous tab back in front.
 */

import { allOwnedTabIds, BrowserSession, sessionOwningTab } from "./session.js";

export function startForegroundGuard(): void {
	chrome.tabs.onCreated.addListener(async (tab) => {
		if (tab.id === undefined || tab.openerTabId === undefined) return;
		const owned = await allOwnedTabIds();
		if (!owned.has(tab.openerTabId)) return;
		const owner = await sessionOwningTab(tab.openerTabId);
		if (!owner) return;

		// Restore whatever the user had active in that window before this tab appeared.
		if (tab.active) {
			const previous = await chrome.tabs.query({ windowId: tab.windowId });
			const restore = previous.find((t) => t.id !== tab.id && t.id === lastActive.get(tab.windowId));
			if (restore?.id !== undefined) {
				await chrome.tabs.update(restore.id, { active: true }).catch(() => undefined);
			} else {
				const opener = await chrome.tabs.get(tab.openerTabId).catch(() => undefined);
				// Opener is a background agent tab; the user was looking at something else.
				if (opener && !opener.active) {
					const others = previous.filter((t) => t.id !== tab.id && !owned.has(t.id ?? -1));
					if (others[0]?.id !== undefined)
						await chrome.tabs.update(others[0].id, { active: true }).catch(() => undefined);
				}
			}
		}

		const session = await BrowserSession.open(owner.id, owner.label, owner.windowId);
		// The popup becomes the session's current tab, as the model would expect after a click.
		await session.adopt(tab.id, true);
	});

	// Remember the user's active tab per window so the guard can restore it.
	chrome.tabs.onActivated.addListener(async (info) => {
		const owned = await allOwnedTabIds();
		if (!owned.has(info.tabId)) lastActive.set(info.windowId, info.tabId);
	});
}

const lastActive = new Map<number, number>();
