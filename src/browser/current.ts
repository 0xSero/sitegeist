/**
 * The BrowserSession the sidepanel tools act on. Set once per sidepanel page by
 * sidepanel.ts; tools read it instead of asking Chrome for the active tab.
 */

import type { BrowserSession } from "./session.js";

let current: BrowserSession | undefined;

export function setCurrentBrowserSession(session: BrowserSession | undefined): void {
	current = session;
}

export function getCurrentBrowserSession(): BrowserSession {
	if (!current) throw new Error("No browser session is active");
	return current;
}

export function hasCurrentBrowserSession(): boolean {
	return current !== undefined;
}
