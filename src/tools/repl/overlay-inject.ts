import { getCurrentBrowserSession, hasCurrentBrowserSession } from "../../browser/current.js";
import { injectScript } from "../../browser/inject.js";
import { createOverlayScript, removeOverlayScript } from "./overlay-content.js";

const OVERLAY_WORLD_ID = "sitegeist-repl-overlay";

/**
 * The session's current tab id, if the session has one.
 * @throws Error if there is no session or it has no tab yet
 */
async function getActiveTabId(): Promise<number> {
	if (!hasCurrentBrowserSession()) throw new Error("No browser session");
	const tab = await getCurrentBrowserSession().currentTab();
	if (!tab?.id) {
		throw new Error("Session has no tab yet");
	}
	return tab.id;
}

/**
 * Inject the REPL overlay into the active tab.
 * @param tabId - ID of the tab to inject into
 * @param taskName - Name of the task being executed (shown in overlay)
 */
export async function injectOverlay(tabId: number, taskName: string): Promise<void> {
	try {
		// Check if tab is a restricted URL
		const tab = await chrome.tabs.get(tabId);
		if (
			tab.url?.startsWith("chrome://") ||
			tab.url?.startsWith("chrome-extension://") ||
			tab.url?.startsWith("moz-extension://") ||
			tab.url?.startsWith("about:")
		) {
			// Can't inject into system pages - skip overlay
			console.warn("[Overlay] Cannot inject overlay into system page:", tab.url);
			return;
		}

		await injectScript(tabId, createOverlayScript(taskName), {
			worldId: OVERLAY_WORLD_ID,
			csp: "script-src 'unsafe-eval' 'unsafe-inline'; style-src 'unsafe-inline'; default-src 'none';",
		});
		console.log("[Overlay] Injected overlay into tab", tabId);
	} catch (error) {
		// Don't fail the REPL if overlay injection fails
		console.warn("[Overlay] Failed to inject overlay:", error);
	}
}

/**
 * Remove the REPL overlay from the active tab.
 * @param tabId - ID of the tab to remove overlay from
 */
export async function removeOverlay(tabId: number): Promise<void> {
	try {
		await injectScript(tabId, removeOverlayScript(), { worldId: OVERLAY_WORLD_ID });
		console.log("[Overlay] Removed overlay from tab", tabId);
	} catch (error) {
		// Don't fail the REPL if overlay removal fails (tab might be closed)
		console.warn("[Overlay] Failed to remove overlay:", error);
	}
}

/**
 * Inject overlay for the currently active tab.
 * Automatically determines the active tab.
 * @param taskName - Name of the task being executed
 * @returns Tab ID where overlay was injected
 */
export async function injectOverlayForActiveTab(taskName: string): Promise<number> {
	const tabId = await getActiveTabId();
	await injectOverlay(tabId, taskName);
	return tabId;
}

/**
 * Remove overlay from the currently active tab.
 * Automatically determines the active tab.
 */
export async function removeOverlayForActiveTab(): Promise<void> {
	try {
		const tabId = await getActiveTabId();
		await removeOverlay(tabId);
	} catch (error) {
		// Tab might have been closed
		console.warn("[Overlay] Failed to remove overlay from active tab:", error);
	}
}
