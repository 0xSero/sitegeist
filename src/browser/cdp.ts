/**
 * chrome.debugger helpers: one attachment per tab, kept for as long as the tab is
 * owned, with focus emulation so hidden tabs keep running requestAnimationFrame and
 * IntersectionObserver. Screenshots come from the compositor surface, which works
 * on tabs that are not visible; nothing here activates a tab.
 */

const PROTOCOL_VERSION = "1.3";

/** Tabs where the user cancelled the debugger (closed the infobar). Cleared on navigation. */
const bannedTabs = new Set<number>();
const attachedTabs = new Set<number>();
let listenersInstalled = false;

export function isRestrictedUrl(url: string): boolean {
	return (
		url.startsWith("chrome://") ||
		url.startsWith("chrome-extension://") ||
		url.startsWith("brave://") ||
		url.startsWith("edge://") ||
		url.startsWith("arc://") ||
		url.startsWith("vivaldi://") ||
		url.startsWith("opera://") ||
		url.startsWith("about:") ||
		url.startsWith("devtools://") ||
		url.startsWith("https://chrome.google.com/webstore") ||
		url.startsWith("https://chromewebstore.google.com")
	);
}

function installListeners(): void {
	if (listenersInstalled) return;
	listenersInstalled = true;
	chrome.debugger.onDetach.addListener((source, reason) => {
		if (source.tabId === undefined) return;
		attachedTabs.delete(source.tabId);
		if (reason === "canceled_by_user") bannedTabs.add(source.tabId);
	});
	chrome.webNavigation.onCommitted.addListener((details) => {
		if (details.frameId === 0) bannedTabs.delete(details.tabId);
	});
	chrome.tabs.onRemoved.addListener((tabId) => {
		attachedTabs.delete(tabId);
		bannedTabs.delete(tabId);
	});
}

async function send<T = unknown>(tabId: number, method: string, params?: Record<string, unknown>): Promise<T> {
	return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T;
}

/** Attach if needed. Idempotent; tolerates attachments made before a service worker restart. */
export async function ensureAttached(tabId: number): Promise<void> {
	installListeners();
	if (bannedTabs.has(tabId)) {
		throw new Error("The debugger was closed by the user on this tab. Navigate the tab to a new page to continue.");
	}
	if (!attachedTabs.has(tabId)) {
		const targets = await chrome.debugger.getTargets();
		const already = targets.some((t) => t.tabId === tabId && t.attached);
		if (!already) {
			try {
				await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (!message.includes("already attached")) throw new Error(`Cannot attach to tab ${tabId}: ${message}`);
			}
		}
		attachedTabs.add(tabId);
		// Hidden tabs freeze rAF; focus emulation unfreezes it and makes the page report
		// itself visible, so lazy loading and infinite scroll keep working off-screen.
		await send(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => undefined);
	}
}

export async function detachTab(tabId: number): Promise<void> {
	attachedTabs.delete(tabId);
	try {
		await chrome.debugger.detach({ tabId });
	} catch {
		/* not attached or tab gone */
	}
}

export async function cdpSend<T = unknown>(
	tabId: number,
	method: string,
	params?: Record<string, unknown>,
): Promise<T> {
	await ensureAttached(tabId);
	return send<T>(tabId, method, params);
}

export interface ScreenshotOptions {
	/** Resize so the width is at most this many CSS pixels. */
	maxWidth?: number;
	fullPage?: boolean;
	/** Clip to this rectangle (CSS pixels, page coordinates). */
	clip?: { x: number; y: number; width: number; height: number };
	format?: "png" | "jpeg";
	quality?: number;
}

/** Screenshot of a tab, active or not. Returns base64 without the data URL prefix. */
export async function captureScreenshot(
	tabId: number,
	options: ScreenshotOptions = {},
): Promise<{ data: string; mimeType: string; width: number; height: number }> {
	await ensureAttached(tabId);
	const format = options.format ?? "png";
	const params: Record<string, unknown> = {
		format,
		fromSurface: true,
		captureBeyondViewport: options.fullPage === true,
	};
	if (format === "jpeg") params.quality = options.quality ?? 80;
	if (options.clip) params.clip = { ...options.clip, scale: 1 };
	if (options.fullPage) {
		const metrics = await send<{ cssContentSize: { width: number; height: number } }>(tabId, "Page.getLayoutMetrics");
		const { width, height } = metrics.cssContentSize;
		params.clip = { x: 0, y: 0, width, height: Math.min(height, 16384), scale: 1 };
	}
	const { data } = await send<{ data: string }>(tabId, "Page.captureScreenshot", params);
	const mimeType = format === "png" ? "image/png" : "image/jpeg";
	return resizeImage(data, mimeType, options.maxWidth);
}

async function resizeImage(
	base64: string,
	mimeType: string,
	maxWidth?: number,
): Promise<{ data: string; mimeType: string; width: number; height: number }> {
	const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
	const bitmap = await createImageBitmap(new Blob([bytes], { type: mimeType }));
	const scale = maxWidth && bitmap.width > maxWidth ? maxWidth / bitmap.width : 1;
	if (scale === 1) return { data: base64, mimeType, width: bitmap.width, height: bitmap.height };
	const width = Math.round(bitmap.width * scale);
	const height = Math.round(bitmap.height * scale);
	const canvas = new OffscreenCanvas(width, height);
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("Failed to get canvas context");
	ctx.drawImage(bitmap, 0, 0, width, height);
	const blob = await canvas.convertToBlob({ type: mimeType, quality: 0.85 });
	const buffer = new Uint8Array(await blob.arrayBuffer());
	let binary = "";
	for (let i = 0; i < buffer.length; i += 0x8000) {
		binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
	}
	return { data: btoa(binary), mimeType, width, height };
}

/** Evaluate in the page's MAIN world and return the value (JSON-serialisable). */
export async function evaluateMain<T = unknown>(tabId: number, expression: string): Promise<T> {
	const result = await cdpSend<{
		result: { value?: T; description?: string };
		exceptionDetails?: { exception?: { description?: string }; text?: string };
	}>(tabId, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (result.exceptionDetails) {
		throw new Error(
			result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Evaluation failed",
		);
	}
	return result.result.value as T;
}

export type MouseButton = "left" | "right" | "middle";

export async function click(
	tabId: number,
	x: number,
	y: number,
	options: { button?: MouseButton; clickCount?: number; modifiers?: number } = {},
): Promise<void> {
	const button = options.button ?? "left";
	const clickCount = options.clickCount ?? 1;
	const modifiers = options.modifiers ?? 0;
	await cdpSend(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers });
	for (let i = 1; i <= clickCount; i++) {
		await send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: i, modifiers });
		await send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: i, modifiers });
	}
}

export async function hover(tabId: number, x: number, y: number): Promise<void> {
	await cdpSend(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
}

export async function drag(tabId: number, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
	await cdpSend(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y });
	await send(tabId, "Input.dispatchMouseEvent", {
		type: "mousePressed",
		x: from.x,
		y: from.y,
		button: "left",
		clickCount: 1,
	});
	const steps = 8;
	for (let i = 1; i <= steps; i++) {
		const x = from.x + ((to.x - from.x) * i) / steps;
		const y = from.y + ((to.y - from.y) * i) / steps;
		await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left" });
	}
	await send(tabId, "Input.dispatchMouseEvent", {
		type: "mouseReleased",
		x: to.x,
		y: to.y,
		button: "left",
		clickCount: 1,
	});
}

export async function scroll(tabId: number, x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
	await cdpSend(tabId, "Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY });
}

/** Type text as key events (works in inputs, contenteditable, and for shortcuts). */
export async function typeText(tabId: number, text: string): Promise<void> {
	await ensureAttached(tabId);
	for (const char of text) {
		if (char === "\n") {
			await pressKey(tabId, "Enter");
			continue;
		}
		await send(tabId, "Input.dispatchKeyEvent", { type: "keyDown", text: char, key: char });
		await send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", text: char, key: char });
	}
}

interface KeyInfo {
	key: string;
	code: string;
	keyCode: number;
	text?: string;
}

const KEY_MAP: Record<string, KeyInfo> = {
	Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
	Tab: { key: "Tab", code: "Tab", keyCode: 9 },
	Escape: { key: "Escape", code: "Escape", keyCode: 27 },
	Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
	Delete: { key: "Delete", code: "Delete", keyCode: 46 },
	ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
	ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
	ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
	ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
	Home: { key: "Home", code: "Home", keyCode: 36 },
	End: { key: "End", code: "End", keyCode: 35 },
	PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
	PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
	Space: { key: " ", code: "Space", keyCode: 32, text: " " },
	Shift: { key: "Shift", code: "ShiftLeft", keyCode: 16 },
	Control: { key: "Control", code: "ControlLeft", keyCode: 17 },
	Alt: { key: "Alt", code: "AltLeft", keyCode: 18 },
	Meta: { key: "Meta", code: "MetaLeft", keyCode: 91 },
	F1: { key: "F1", code: "F1", keyCode: 112 },
	F2: { key: "F2", code: "F2", keyCode: 113 },
	F3: { key: "F3", code: "F3", keyCode: 114 },
	F4: { key: "F4", code: "F4", keyCode: 115 },
	F5: { key: "F5", code: "F5", keyCode: 116 },
	F6: { key: "F6", code: "F6", keyCode: 117 },
	F7: { key: "F7", code: "F7", keyCode: 118 },
	F8: { key: "F8", code: "F8", keyCode: 119 },
	F9: { key: "F9", code: "F9", keyCode: 120 },
	F10: { key: "F10", code: "F10", keyCode: 121 },
	F11: { key: "F11", code: "F11", keyCode: 122 },
	F12: { key: "F12", code: "F12", keyCode: 123 },
};

const MODIFIER_BITS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

export function keyInfo(name: string): KeyInfo {
	if (KEY_MAP[name]) return KEY_MAP[name];
	if (name.length === 1) {
		const upper = name.toUpperCase();
		const isLetter = /[A-Z]/.test(upper);
		const isDigit = /[0-9]/.test(name);
		return {
			key: name,
			code: isLetter ? `Key${upper}` : isDigit ? `Digit${name}` : "",
			keyCode: isLetter || isDigit ? upper.charCodeAt(0) : 0,
			text: name,
		};
	}
	return { key: name, code: name, keyCode: 0 };
}

/**
 * Press a key or chord such as "Enter", "Control+a", "Meta+Shift+p". Modifier names:
 * Control, Alt, Shift, Meta (also Cmd, Ctrl, Option as aliases).
 */
export async function pressKey(tabId: number, chord: string): Promise<void> {
	await ensureAttached(tabId);
	const parts = chord.split("+").map((p) => p.trim());
	const alias: Record<string, string> = { Cmd: "Meta", Command: "Meta", Ctrl: "Control", Option: "Alt", Win: "Meta" };
	const mods = parts.slice(0, -1).map((m) => alias[m] ?? m);
	const main = parts[parts.length - 1];
	let modifiers = 0;
	for (const m of mods) modifiers |= MODIFIER_BITS[m] ?? 0;
	for (const m of mods) {
		const info = keyInfo(m);
		await send(tabId, "Input.dispatchKeyEvent", {
			type: "rawKeyDown",
			...info,
			windowsVirtualKeyCode: info.keyCode,
			nativeVirtualKeyCode: info.keyCode,
			modifiers,
		});
	}
	const info = keyInfo(main);
	const base = {
		key: info.key,
		code: info.code,
		windowsVirtualKeyCode: info.keyCode,
		nativeVirtualKeyCode: info.keyCode,
		modifiers,
	};
	await send(tabId, "Input.dispatchKeyEvent", {
		type: info.text && modifiers === 0 ? "keyDown" : "rawKeyDown",
		...base,
		...(info.text && modifiers === 0 ? { text: info.text } : {}),
	});
	await send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
	for (const m of mods.reverse()) {
		const minfo = keyInfo(m);
		await send(tabId, "Input.dispatchKeyEvent", {
			type: "keyUp",
			...minfo,
			windowsVirtualKeyCode: minfo.keyCode,
			nativeVirtualKeyCode: minfo.keyCode,
		});
	}
}

// ---------------------------------------------------------------------------
// Console and network capture (per tab ring buffers, on demand)
// ---------------------------------------------------------------------------

export interface ConsoleEntry {
	level: string;
	text: string;
	timestamp: number;
}

export interface NetworkEntry {
	requestId: string;
	method: string;
	url: string;
	status?: number;
	mimeType?: string;
	timestamp: number;
	failed?: string;
}

const MAX_ENTRIES = 300;
const consoleBuffers = new Map<number, ConsoleEntry[]>();
const networkBuffers = new Map<number, Map<string, NetworkEntry>>();
let captureListenerInstalled = false;

function installCaptureListener(): void {
	if (captureListenerInstalled) return;
	captureListenerInstalled = true;
	chrome.debugger.onEvent.addListener((source, method, params) => {
		const tabId = source.tabId;
		if (tabId === undefined) return;
		const p = (params ?? {}) as Record<string, unknown>;
		if (method === "Runtime.consoleAPICalled") {
			const buf = consoleBuffers.get(tabId);
			if (!buf) return;
			const args = (p.args as Array<{ value?: unknown; description?: string }>) ?? [];
			const text = args.map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? ""))).join(" ");
			buf.push({ level: String(p.type ?? "log"), text, timestamp: Date.now() });
			if (buf.length > MAX_ENTRIES) buf.splice(0, buf.length - MAX_ENTRIES);
		} else if (method === "Runtime.exceptionThrown") {
			const buf = consoleBuffers.get(tabId);
			if (!buf) return;
			const details = p.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
			buf.push({
				level: "error",
				text: details?.exception?.description ?? details?.text ?? "Uncaught exception",
				timestamp: Date.now(),
			});
		} else if (method === "Network.requestWillBeSent") {
			const buf = networkBuffers.get(tabId);
			if (!buf) return;
			const request = p.request as { method: string; url: string };
			buf.set(String(p.requestId), {
				requestId: String(p.requestId),
				method: request.method,
				url: request.url,
				timestamp: Date.now(),
			});
			if (buf.size > MAX_ENTRIES) buf.delete(buf.keys().next().value as string);
		} else if (method === "Network.responseReceived") {
			const entry = networkBuffers.get(tabId)?.get(String(p.requestId));
			if (!entry) return;
			const response = p.response as { status: number; mimeType: string };
			entry.status = response.status;
			entry.mimeType = response.mimeType;
		} else if (method === "Network.loadingFailed") {
			const entry = networkBuffers.get(tabId)?.get(String(p.requestId));
			if (entry) entry.failed = String(p.errorText ?? "failed");
		}
	});
	chrome.tabs.onRemoved.addListener((tabId) => {
		consoleBuffers.delete(tabId);
		networkBuffers.delete(tabId);
	});
}

/** Start buffering console output for a tab (no-op if already on). */
export async function enableConsoleCapture(tabId: number): Promise<void> {
	installCaptureListener();
	if (consoleBuffers.has(tabId)) return;
	consoleBuffers.set(tabId, []);
	await cdpSend(tabId, "Runtime.enable");
}

export function readConsole(tabId: number, clear = false): ConsoleEntry[] {
	const buf = consoleBuffers.get(tabId) ?? [];
	const out = [...buf];
	if (clear) buf.length = 0;
	return out;
}

export async function enableNetworkCapture(tabId: number): Promise<void> {
	installCaptureListener();
	if (networkBuffers.has(tabId)) return;
	networkBuffers.set(tabId, new Map());
	await cdpSend(tabId, "Network.enable");
}

export function readNetwork(tabId: number, clear = false): NetworkEntry[] {
	const buf = networkBuffers.get(tabId);
	if (!buf) return [];
	const out = [...buf.values()];
	if (clear) buf.clear();
	return out;
}
