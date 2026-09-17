/**
 * Sidepanel -> background lifecycle port.
 *
 * The port carries no messages. It exists solely so the background service worker can
 * track which windows currently have an open side panel, via `chrome.runtime.onConnect`
 * / `onDisconnect` on a port named `sidepanel:${windowId}`. It reconnects automatically
 * if Chrome drops it (after ~5min inactivity).
 */

// ============================================================================
// MESSAGE INTERFACES
// ============================================================================

// The lifecycle port no longer carries request/response messages. These aliases remain
// (as `never`) so existing imports in the background worker keep resolving.
export type SidepanelToBackgroundMessage = never;
export type BackgroundToSidepanelMessage = never;

// ============================================================================
// PORT COMMUNICATION
// ============================================================================

let port: chrome.runtime.Port | null = null;
let currentWindowId: number | undefined;

/**
 * Initialize port system with window ID.
 * Must be called before the lifecycle connection can be established.
 */
export function initialize(windowId: number): void {
	currentWindowId = windowId;
	connect();
}

/**
 * Create new port connection and set up listeners.
 * Background script will receive this connection via runtime.onConnect.
 */
function connect(): chrome.runtime.Port {
	if (!currentWindowId) {
		throw new Error("[Port] Cannot connect: windowId not initialized");
	}

	console.log(`[Port] Connecting... (${new Date().toISOString()})`);
	const tmpPort = chrome.runtime.connect({ name: `sidepanel:${currentWindowId}` });

	// Set up disconnect listener
	tmpPort.onDisconnect.addListener(() => {
		console.log(`[Port] Disconnected (likely due to inactivity timeout) (${new Date().toISOString()})`);
		port = null;
	});

	console.log(`[Port] Connected (${new Date().toISOString()})`);
	port = tmpPort;
	return tmpPort;
}

/**
 * Check if port is currently connected.
 * Note: This is best-effort - port can disconnect immediately after this check.
 */
export function isConnected(): boolean {
	return port !== null;
}
