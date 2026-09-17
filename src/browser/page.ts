/**
 * Page-level primitives addressed by tab id: navigation with load wait, in-page
 * JavaScript through the userScripts API, and a compact interactive snapshot with
 * stable element refs for click/fill by reference. Everything works on tabs that
 * are not active.
 */

import { cdpSend, isRestrictedUrl } from "./cdp.js";

const SNAPSHOT_WORLD_ID = "sitegeist-snapshot";
const SNAPSHOT_CSP = "script-src 'unsafe-eval' 'unsafe-inline'; default-src 'none';";

export interface NavigateOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	/** Resolve on DOMContentLoaded (default) or on load complete. */
	waitUntil?: "domcontentloaded" | "load";
}

/** Navigate a tab and wait for its top frame. Returns the final URL. */
export async function navigateTab(tabId: number, url: string, options: NavigateOptions = {}): Promise<string> {
	const { signal, timeoutMs = 30000, waitUntil = "domcontentloaded" } = options;
	if (signal?.aborted) throw new Error("Aborted");
	const event = waitUntil === "load" ? chrome.webNavigation.onCompleted : chrome.webNavigation.onDOMContentLoaded;
	return new Promise<string>((resolve, reject) => {
		let settled = false;
		const cleanup = () => {
			settled = true;
			event.removeListener(listener);
			signal?.removeEventListener("abort", onAbort);
			clearTimeout(timer);
		};
		const listener = (details: chrome.webNavigation.WebNavigationFramedCallbackDetails) => {
			if (details.tabId === tabId && details.frameId === 0) {
				cleanup();
				resolve(details.url);
			}
		};
		const onAbort = () => {
			cleanup();
			reject(new Error("Aborted"));
		};
		const timer = setTimeout(async () => {
			if (settled) return;
			cleanup();
			// Slow pages: report where the tab is instead of failing outright.
			try {
				const tab = await chrome.tabs.get(tabId);
				resolve(tab.url ?? url);
			} catch {
				reject(new Error("Navigation timed out"));
			}
		}, timeoutMs);
		signal?.addEventListener("abort", onAbort);
		event.addListener(listener);
		chrome.tabs.update(tabId, { url }).catch((err: Error) => {
			cleanup();
			reject(err);
		});
	});
}

/** Wait for the top frame of a tab to finish its current load, bounded. */
export function waitForLoad(tabId: number, timeoutMs = 15000): Promise<void> {
	return new Promise((resolve) => {
		const done = () => {
			chrome.webNavigation.onCompleted.removeListener(listener);
			clearTimeout(timer);
			resolve();
		};
		const listener = (d: chrome.webNavigation.WebNavigationFramedCallbackDetails) => {
			if (d.tabId === tabId && d.frameId === 0) done();
		};
		const timer = setTimeout(done, timeoutMs);
		chrome.webNavigation.onCompleted.addListener(listener);
		chrome.tabs.get(tabId).then((tab) => {
			if (tab.status === "complete") done();
		});
	});
}

export async function goBack(tabId: number): Promise<void> {
	await chrome.tabs.goBack(tabId);
	await waitForLoad(tabId);
}

export async function goForward(tabId: number): Promise<void> {
	await chrome.tabs.goForward(tabId);
	await waitForLoad(tabId);
}

interface UserScriptsApi {
	configureWorld(config: { worldId: string; messaging?: boolean; csp?: string }): Promise<void>;
	execute(config: {
		js: Array<{ code: string }>;
		target: { tabId: number; allFrames?: boolean };
		world: "USER_SCRIPT";
		worldId: string;
		injectImmediately?: boolean;
	}): Promise<Array<{ result?: unknown; error?: unknown }>>;
}

function userScripts(): UserScriptsApi {
	const api = (chrome as unknown as { userScripts?: UserScriptsApi }).userScripts;
	if (!api || typeof api.execute !== "function") {
		throw new Error('userScripts API not available. Enable "Allow user scripts" for the extension.');
	}
	return api;
}

const configuredWorlds = new Set<string>();

/**
 * Run code in a tab's USER_SCRIPT world and return its JSON-serialisable result.
 * `code` must be an expression or an IIFE; promises are awaited.
 */
export async function runInPage<T = unknown>(tabId: number, code: string, worldId = SNAPSHOT_WORLD_ID): Promise<T> {
	const tab = await chrome.tabs.get(tabId);
	if (tab.url && isRestrictedUrl(tab.url)) {
		throw new Error(`Cannot run scripts on ${tab.url}: browser-internal pages are protected.`);
	}
	const wrapped = `(async () => { try { const __v = await (${code}); return { ok: true, value: __v }; } catch (e) { return { ok: false, error: String(e && e.stack || e) }; } })()`;
	// userScripts needs the "Allow user scripts" toggle; without it, use an isolated
	// content-script world, and as a last resort the debugger's main-world evaluate.
	let api: UserScriptsApi | undefined;
	try {
		api = userScripts();
	} catch {
		api = undefined;
	}
	if (!api) {
		try {
			const [res] = await chrome.scripting.executeScript({
				target: { tabId },
				world: "ISOLATED",
				// biome-ignore lint/security/noGlobalEval: the code is our own snippet, run in an isolated world when userScripts is unavailable
				func: (src: string) => (0, eval)(src) as unknown,
				args: [wrapped],
			});
			return unwrap<T>(res?.result);
		} catch (err) {
			console.debug("[page] scripting fallback failed, using debugger:", err);
			const result = await cdpEvaluate<T>(tabId, wrapped);
			return result;
		}
	}
	if (!configuredWorlds.has(worldId)) {
		try {
			await api.configureWorld({ worldId, messaging: true, csp: SNAPSHOT_CSP });
		} catch {
			/* already configured with the same settings */
		}
		configuredWorlds.add(worldId);
	}
	const results = await api.execute({
		js: [{ code: wrapped }],
		target: { tabId, allFrames: false },
		world: "USER_SCRIPT",
		worldId,
		injectImmediately: true,
	});
	const first = results[0];
	if (!first) throw new Error("Script returned no result");
	if (first.error) throw new Error(String((first.error as { message?: string }).message ?? first.error));
	return unwrap<T>(first.result);
}

function unwrap<T>(raw: unknown): T {
	const outcome = raw as { ok: boolean; value?: T; error?: string } | undefined;
	if (!outcome) throw new Error("Script returned no result");
	if (!outcome.ok) throw new Error(outcome.error ?? "Script failed");
	return outcome.value as T;
}

async function cdpEvaluate<T>(tabId: number, wrapped: string): Promise<T> {
	const result = await cdpSend<{
		result: { value?: unknown };
		exceptionDetails?: { exception?: { description?: string }; text?: string };
	}>(tabId, "Runtime.evaluate", { expression: wrapped, returnByValue: true, awaitPromise: true });
	if (result.exceptionDetails) {
		throw new Error(
			result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Evaluation failed",
		);
	}
	return unwrap<T>(result.result.value);
}

// ---------------------------------------------------------------------------
// Snapshot: compact list of interactive and text nodes with refs
// ---------------------------------------------------------------------------

export interface SnapshotNode {
	ref: string;
	role: string;
	name: string;
	value?: string;
	href?: string;
	/** Viewport-relative center, for CDP clicks. */
	x: number;
	y: number;
	width: number;
	height: number;
	visible: boolean;
}

export interface Snapshot {
	url: string;
	title: string;
	viewport: { width: number; height: number; scrollX: number; scrollY: number; pageHeight: number };
	nodes: SnapshotNode[];
	/** Readable text of the page (truncated). */
	text: string;
}

/**
 * Page-side snapshot function. Stringified and injected, so it must be
 * self-contained. Stores element refs on window.__sitegeistRefs (same world),
 * so a later click/fill by ref resolves without a second scan.
 */
function pageSnapshot(maxNodes: number, maxTextChars: number, filter: string): unknown {
	const w = window as unknown as { __sitegeistRefs?: Map<string, Element>; __sitegeistRefSeq?: number };
	const refs = new Map<string, Element>();
	w.__sitegeistRefs = refs;
	let seq = 0;
	const interactiveSel =
		"a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=textbox],[role=combobox],[contenteditable=true],[onclick],[tabindex]:not([tabindex='-1'])";
	const headingSel = "h1,h2,h3,h4,label,[role=heading]";
	const selector = filter === "interactive" ? interactiveSel : `${interactiveSel},${headingSel}`;
	const isVisible = (el: Element) => {
		const r = el.getBoundingClientRect();
		if (r.width === 0 || r.height === 0) return false;
		const style = getComputedStyle(el);
		return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
	};
	const roleOf = (el: Element): string => {
		const role = el.getAttribute("role");
		if (role) return role;
		const tag = el.tagName.toLowerCase();
		if (tag === "a") return "link";
		if (tag === "input") {
			const type = (el as HTMLInputElement).type;
			if (type === "submit" || type === "button") return "button";
			if (type === "checkbox" || type === "radio") return type;
			return "textbox";
		}
		if (tag === "textarea") return "textbox";
		if (tag === "select") return "combobox";
		if (tag === "button" || tag === "summary") return "button";
		if (/^h[1-6]$/.test(tag)) return "heading";
		if (tag === "label") return "label";
		if (el.getAttribute("contenteditable") === "true") return "textbox";
		return "generic";
	};
	const nameOf = (el: Element): string => {
		const aria = el.getAttribute("aria-label");
		if (aria) return aria.trim();
		const labelledBy = el.getAttribute("aria-labelledby");
		if (labelledBy) {
			const t = labelledBy
				.split(/\s+/)
				.map((id) => document.getElementById(id)?.textContent ?? "")
				.join(" ")
				.trim();
			if (t) return t;
		}
		if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
			const id = el.id;
			if (id) {
				const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
				if (label?.textContent?.trim()) return label.textContent.trim();
			}
			const parentLabel = el.closest("label");
			if (parentLabel?.textContent?.trim()) return parentLabel.textContent.trim();
			if (el instanceof HTMLInputElement && (el.placeholder || el.value) && el.type !== "password")
				return el.placeholder || el.value;
			if (el instanceof HTMLTextAreaElement && el.placeholder) return el.placeholder;
			return el.getAttribute("name") ?? el.getAttribute("title") ?? "";
		}
		const img = el.querySelector("img[alt]");
		if (img && !el.textContent?.trim()) return img.getAttribute("alt") ?? "";
		return (el.textContent ?? "").replace(/\s+/g, " ").trim() || (el.getAttribute("title") ?? "");
	};
	const nodes: unknown[] = [];
	const all = Array.from(document.querySelectorAll(selector));
	for (const el of all) {
		if (nodes.length >= maxNodes) break;
		if (!isVisible(el)) continue;
		const r = el.getBoundingClientRect();
		const ref = `e${++seq}`;
		refs.set(ref, el);
		const node: Record<string, unknown> = {
			ref,
			role: roleOf(el),
			name: nameOf(el).slice(0, 120),
			x: Math.round(r.left + r.width / 2),
			y: Math.round(r.top + r.height / 2),
			width: Math.round(r.width),
			height: Math.round(r.height),
			visible: r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth,
		};
		if (el instanceof HTMLAnchorElement && el.href) node.href = el.href.slice(0, 200);
		if (el instanceof HTMLInputElement) {
			if (el.type === "checkbox" || el.type === "radio") node.value = el.checked ? "checked" : "unchecked";
			else if (el.type !== "password" && el.value) node.value = el.value.slice(0, 120);
		} else if (el instanceof HTMLTextAreaElement && el.value) node.value = el.value.slice(0, 120);
		else if (el instanceof HTMLSelectElement) node.value = el.options[el.selectedIndex]?.text ?? "";
		nodes.push(node);
	}
	w.__sitegeistRefSeq = seq;
	const text = (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").slice(0, maxTextChars);
	return {
		url: location.href,
		title: document.title,
		viewport: {
			width: window.innerWidth,
			height: window.innerHeight,
			scrollX: Math.round(window.scrollX),
			scrollY: Math.round(window.scrollY),
			pageHeight: document.documentElement.scrollHeight,
		},
		nodes,
		text,
	};
}

export async function snapshot(
	tabId: number,
	options: { maxNodes?: number; maxTextChars?: number; filter?: "interactive" | "all" } = {},
): Promise<Snapshot> {
	const { maxNodes = 300, maxTextChars = 20000, filter = "all" } = options;
	return runInPage<Snapshot>(
		tabId,
		`(${pageSnapshot.toString()})(${maxNodes}, ${maxTextChars}, ${JSON.stringify(filter)})`,
	);
}

/** Resolve a ref (from a snapshot) or CSS selector to its viewport center. */
export async function locate(
	tabId: number,
	target: { ref?: string; selector?: string },
): Promise<{ x: number; y: number; width: number; height: number }> {
	const code = `(() => {
		const refs = window.__sitegeistRefs;
		let el = null;
		const ref = ${JSON.stringify(target.ref ?? "")};
		const sel = ${JSON.stringify(target.selector ?? "")};
		if (ref) el = refs ? refs.get(ref) : null;
		if (!el && sel) el = document.querySelector(sel);
		if (!el) throw new Error(ref ? "Ref " + ref + " not found; take a new snapshot" : "Selector not found: " + sel);
		if (!el.isConnected) throw new Error("Element is no longer in the page; take a new snapshot");
		el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
		const r = el.getBoundingClientRect();
		return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height };
	})()`;
	return runInPage(tabId, code);
}

/** Set a form control's value the way frameworks expect (native setter + input/change). */
export async function fillElement(
	tabId: number,
	target: { ref?: string; selector?: string },
	value: string,
): Promise<void> {
	const code = `(() => {
		const refs = window.__sitegeistRefs;
		let el = null;
		const ref = ${JSON.stringify(target.ref ?? "")};
		const sel = ${JSON.stringify(target.selector ?? "")};
		if (ref) el = refs ? refs.get(ref) : null;
		if (!el && sel) el = document.querySelector(sel);
		if (!el) throw new Error(ref ? "Ref " + ref + " not found; take a new snapshot" : "Selector not found: " + sel);
		const value = ${JSON.stringify(value)};
		el.focus();
		if (el instanceof HTMLSelectElement) {
			const opt = Array.from(el.options).find(o => o.value === value || o.text.trim() === value);
			if (!opt) throw new Error("No option matches " + value);
			el.value = opt.value;
			el.dispatchEvent(new Event("input", { bubbles: true }));
			el.dispatchEvent(new Event("change", { bubbles: true }));
			return true;
		}
		if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
			const want = value === "true" || value === "checked" || value === "1";
			if (el.checked !== want) el.click();
			return true;
		}
		if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
			const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
			const setter = Object.getOwnPropertyDescriptor(proto, "value");
			if (setter && setter.set) setter.set.call(el, value); else el.value = value;
			el.dispatchEvent(new Event("input", { bubbles: true }));
			el.dispatchEvent(new Event("change", { bubbles: true }));
			return true;
		}
		if (el.isContentEditable) {
			el.textContent = value;
			el.dispatchEvent(new InputEvent("input", { bubbles: true }));
			return true;
		}
		throw new Error("Element is not a form control");
	})()`;
	await runInPage(tabId, code);
}

export async function pageText(tabId: number, selector?: string, maxChars = 50000): Promise<string> {
	const code = `(() => {
		const sel = ${JSON.stringify(selector ?? "")};
		const el = sel ? document.querySelector(sel) : document.body;
		if (!el) throw new Error("Selector not found: " + sel);
		return (el.innerText || el.textContent || "").slice(0, ${maxChars});
	})()`;
	return runInPage<string>(tabId, code);
}

export async function pageHtml(tabId: number, selector?: string, maxChars = 200000): Promise<string> {
	const code = `(() => {
		const sel = ${JSON.stringify(selector ?? "")};
		const el = sel ? document.querySelector(sel) : document.documentElement;
		if (!el) throw new Error("Selector not found: " + sel);
		return el.outerHTML.slice(0, ${maxChars});
	})()`;
	return runInPage<string>(tabId, code);
}

/** Scroll the page or an element; returns the new scroll position. */
export async function scrollPage(
	tabId: number,
	options: { dx?: number; dy?: number; selector?: string; ref?: string; to?: "top" | "bottom" },
): Promise<{ scrollX: number; scrollY: number; pageHeight: number }> {
	const code = `(() => {
		const o = ${JSON.stringify(options)};
		let target = null;
		if (o.ref && window.__sitegeistRefs) target = window.__sitegeistRefs.get(o.ref);
		if (!target && o.selector) target = document.querySelector(o.selector);
		if (target) target.scrollIntoView({ block: "center", behavior: "instant" });
		else if (o.to === "top") window.scrollTo(0, 0);
		else if (o.to === "bottom") window.scrollTo(0, document.documentElement.scrollHeight);
		else window.scrollBy(o.dx || 0, o.dy || 0);
		return { scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY), pageHeight: document.documentElement.scrollHeight };
	})()`;
	return runInPage(tabId, code);
}

/** Wait until a selector appears, text is present, or the URL matches. */
export async function waitFor(
	tabId: number,
	condition: { selector?: string; text?: string; urlIncludes?: string },
	timeoutMs = 10000,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const tab = await chrome.tabs.get(tabId);
			if (condition.urlIncludes && (tab.url ?? "").includes(condition.urlIncludes)) return true;
			if (condition.selector || condition.text) {
				const found = await runInPage<boolean>(
					tabId,
					`(() => { const s = ${JSON.stringify(condition.selector ?? "")}; const t = ${JSON.stringify(condition.text ?? "")};
					if (s && document.querySelector(s)) return true;
					if (t && (document.body?.innerText || "").includes(t)) return true;
					return false; })()`,
				);
				if (found) return true;
			}
		} catch {
			/* page is navigating; try again */
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	return false;
}
