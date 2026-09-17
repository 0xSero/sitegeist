/**
 * Bridge method handlers. Each runs against one BrowserSession (one per connected
 * harness) and uses the same primitives as the sidepanel tools. Nothing here
 * changes the active tab except `tabs.show`.
 */

import {
	captureScreenshot,
	scroll as cdpScroll,
	click,
	drag,
	enableConsoleCapture,
	enableNetworkCapture,
	evaluateMain,
	hover,
	pressKey,
	readConsole,
	readNetwork,
	typeText,
} from "../browser/cdp.js";
import {
	fillElement,
	goBack,
	goForward,
	locate,
	navigateTab,
	pageHtml,
	pageText,
	runInPage,
	scrollPage,
	snapshot,
	waitFor,
} from "../browser/page.js";
import type { BrowserSession } from "../browser/session.js";
import { ERR, type RpcError } from "./protocol.js";

export class BridgeError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
	toRpc(): RpcError {
		return { code: this.code, message: this.message };
	}
}

type Params = Record<string, unknown>;

export interface HandlerContext {
	session: BrowserSession;
	/** Ask before a navigation to a host that is not allowed yet; throws when denied. */
	checkUrl(url: string): Promise<void>;
}

type Handler = (ctx: HandlerContext, params: Params) => Promise<unknown>;

function num(params: Params, key: string): number | undefined {
	const v = params[key];
	if (v === undefined || v === null) return undefined;
	const n = Number(v);
	if (!Number.isFinite(n)) throw new BridgeError(ERR.BAD_PARAMS, `${key} must be a number`);
	return n;
}

function str(params: Params, key: string): string | undefined {
	const v = params[key];
	if (v === undefined || v === null) return undefined;
	return String(v);
}

function requireStr(params: Params, key: string): string {
	const v = str(params, key);
	if (!v) throw new BridgeError(ERR.BAD_PARAMS, `${key} is required`);
	return v;
}

async function resolveTab(ctx: HandlerContext, params: Params, attach: boolean): Promise<number> {
	const tabId = num(params, "tabId");
	if (tabId !== undefined) {
		if (!ctx.session.tabIds.includes(tabId)) {
			throw new BridgeError(ERR.NOT_FOUND, `Tab ${tabId} is not owned by this session. Call tabs.context.`);
		}
		await ctx.session.setCurrent(tabId);
	}
	const tab = attach ? await ctx.session.attachedCurrentTab() : await ctx.session.requireCurrentTab();
	if (tab.id === undefined) throw new BridgeError(ERR.NO_TAB, "No tab available");
	return tab.id;
}

async function tabSummary(tabId: number) {
	const tab = await chrome.tabs.get(tabId);
	return { tabId, url: tab.url ?? tab.pendingUrl ?? "", title: tab.title ?? "" };
}

function target(params: Params): { ref?: string; selector?: string } {
	return { ref: str(params, "ref"), selector: str(params, "selector") };
}

async function pointFor(_ctx: HandlerContext, params: Params, tabId: number): Promise<{ x: number; y: number }> {
	const x = num(params, "x");
	const y = num(params, "y");
	if (x !== undefined && y !== undefined) return { x, y };
	const t = target(params);
	if (!t.ref && !t.selector) throw new BridgeError(ERR.BAD_PARAMS, "Provide ref, selector, or x and y");
	const rect = await locate(tabId, t);
	return { x: rect.x, y: rect.y };
}

export const handlers: Record<string, Handler> = {
	"tabs.context": async (ctx) => {
		const tabs = await ctx.session.tabs();
		return { tabs: tabs.map((t) => ({ tabId: t.id, url: t.url, title: t.title, current: t.current })) };
	},

	"tabs.create": async (ctx, params) => {
		const url = str(params, "url");
		if (url) await ctx.checkUrl(url);
		const tab = await ctx.session.createTab(url);
		if (url && tab.id !== undefined) await navigateTab(tab.id, url).catch(() => undefined);
		return tabSummary(tab.id!);
	},

	"tabs.close": async (ctx, params) => {
		const tabId = num(params, "tabId");
		if (tabId === undefined) throw new BridgeError(ERR.BAD_PARAMS, "tabId is required");
		await ctx.session.closeTab(tabId);
		return { closed: tabId };
	},

	"tabs.select": async (ctx, params) => {
		const tabId = num(params, "tabId");
		if (tabId === undefined) throw new BridgeError(ERR.BAD_PARAMS, "tabId is required");
		const tab = await ctx.session.setCurrent(tabId);
		return tabSummary(tab.id!);
	},

	"tabs.show": async (ctx, params) => {
		const tabId = num(params, "tabId") ?? ctx.session.currentTabId;
		if (tabId === undefined) throw new BridgeError(ERR.NO_TAB, "No tab to show");
		await ctx.session.show(tabId);
		return tabSummary(tabId);
	},

	navigate: async (ctx, params) => {
		const url = requireStr(params, "url");
		const tabId = await resolveTab(ctx, params, false);
		if (url === "back") await goBack(tabId);
		else if (url === "forward") await goForward(tabId);
		else {
			await ctx.checkUrl(url);
			const waitUntil = str(params, "waitUntil") === "load" ? "load" : "domcontentloaded";
			await navigateTab(tabId, url, { waitUntil, timeoutMs: num(params, "timeoutMs") ?? 30000 });
		}
		return tabSummary(tabId);
	},

	screenshot: async (ctx, params) => {
		const tabId = await resolveTab(ctx, params, true);
		const clip = params.clip as { x: number; y: number; width: number; height: number } | undefined;
		const shot = await captureScreenshot(tabId, {
			maxWidth: num(params, "maxWidth") ?? 1200,
			fullPage: params.fullPage === true,
			clip,
			format: str(params, "format") === "jpeg" ? "jpeg" : "png",
		});
		return shot;
	},

	snapshot: async (ctx, params) => {
		const tabId = await resolveTab(ctx, params, false);
		const filter = str(params, "filter") === "interactive" ? "interactive" : "all";
		return snapshot(tabId, {
			filter,
			maxNodes: num(params, "maxNodes"),
			maxTextChars: num(params, "maxTextChars"),
		});
	},

	text: async (ctx, params) => {
		const tabId = await resolveTab(ctx, params, false);
		const text = await pageText(tabId, str(params, "selector"), num(params, "maxChars"));
		return { ...(await tabSummary(tabId)), text };
	},

	html: async (ctx, params) => {
		const tabId = await resolveTab(ctx, params, false);
		const html = await pageHtml(tabId, str(params, "selector"), num(params, "maxChars"));
		return { ...(await tabSummary(tabId)), html };
	},

	find: async (ctx, params) => {
		const query = requireStr(params, "query").toLowerCase();
		const tabId = await resolveTab(ctx, params, false);
		const snap = await snapshot(tabId, { filter: "all", maxNodes: 600, maxTextChars: 0 });
		const words = query.split(/\s+/).filter(Boolean);
		const scored = snap.nodes
			.map((n) => {
				const hay = `${n.role} ${n.name} ${n.value ?? ""} ${n.href ?? ""}`.toLowerCase();
				let score = 0;
				for (const w of words) if (hay.includes(w)) score += w.length;
				if (n.name.toLowerCase() === query) score += 100;
				return { node: n, score };
			})
			.filter((s) => s.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, num(params, "limit") ?? 20);
		return { matches: scored.map((s) => s.node) };
	},

	click: async (ctx, params) => {
		const tabId = await resolveTab(ctx, params, true);
		const p = await pointFor(ctx, params, tabId);
		const button = str(params, "button");
		await click(tabId, p.x, p.y, {
			button: button === "right" || button === "middle" ? button : "left",
			clickCount: num(params, "clickCount") ?? 1,
		});
		return { clicked: p };
	},

	hover: async (ctx, params) => {
		const tabId = await resolveTab(ctx, params, true);
		const p = await pointFor(ctx, params, tabId);
		await hover(tabId, p.x, p.y);
		return { hovered: p };
	},

	drag: async (ctx, params) => {
		const tabId = await resolveTab(ctx, params, true);
		const from = params.from as { x: number; y: number } | undefined;
		const to = params.to as { x: number; y: number } | undefined;
		if (!from || !to) throw new BridgeError(ERR.BAD_PARAMS, "from and to are required");
		await drag(tabId, from, to);
		return { dragged: { from, to } };
	},

	type: async (ctx, params) => {
		const text = requireStr(params, "text");
		const tabId = await resolveTab(ctx, params, true);
		const t = target(params);
		if (t.ref || t.selector) {
			const rect = await locate(tabId, t);
			await click(tabId, rect.x, rect.y);
		}
		await typeText(tabId, text);
		if (params.submit === true) await pressKey(tabId, "Enter");
		return { typed: text.length };
	},

	press: async (ctx, params) => {
		const key = requireStr(params, "key");
		const tabId = await resolveTab(ctx, params, true);
		const repeat = num(params, "repeat") ?? 1;
		for (let i = 0; i < repeat; i++) await pressKey(tabId, key);
		return { pressed: key, repeat };
	},

	scroll: async (ctx, params) => {
		const tabId = await resolveTab(ctx, params, false);
		const x = num(params, "x");
		const y = num(params, "y");
		const dx = num(params, "dx") ?? 0;
		const dy = num(params, "dy") ?? 0;
		if (x !== undefined && y !== undefined && !params.ref && !params.selector && !params.to) {
			// Wheel at a point: scrolls the innermost scrollable under the cursor.
			await cdpScroll(tabId, x, y, dx, dy);
			return runInPage(tabId, "({ scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY) })");
		}
		const to = str(params, "to");
		return scrollPage(tabId, {
			dx,
			dy,
			ref: str(params, "ref"),
			selector: str(params, "selector"),
			to: to === "top" || to === "bottom" ? to : undefined,
		});
	},

	fill: async (ctx, params) => {
		const value = str(params, "value") ?? "";
		const tabId = await resolveTab(ctx, params, false);
		const t = target(params);
		if (!t.ref && !t.selector) throw new BridgeError(ERR.BAD_PARAMS, "ref or selector is required");
		await fillElement(tabId, t, value);
		return { filled: t };
	},

	evaluate: async (ctx, params) => {
		const code = requireStr(params, "code");
		const world = str(params, "world") === "main" ? "main" : "user";
		if (world === "main") {
			const tabId = await resolveTab(ctx, params, true);
			return { value: await evaluateMain(tabId, code) };
		}
		const tabId = await resolveTab(ctx, params, false);
		return { value: await runInPage(tabId, code) };
	},

	wait: async (ctx, params) => {
		const ms = num(params, "ms");
		if (ms !== undefined && !params.selector && !params.text && !params.urlIncludes) {
			await new Promise((r) => setTimeout(r, Math.min(ms, 30000)));
			return { waited: ms };
		}
		const tabId = await resolveTab(ctx, params, false);
		const ok = await waitFor(
			tabId,
			{ selector: str(params, "selector"), text: str(params, "text"), urlIncludes: str(params, "urlIncludes") },
			num(params, "timeoutMs") ?? 10000,
		);
		if (!ok) throw new BridgeError(ERR.TIMEOUT, "Condition not met before timeout");
		return { ...(await tabSummary(tabId)), matched: true };
	},

	"console.read": async (ctx, params) => {
		const tabId = await resolveTab(ctx, params, true);
		await enableConsoleCapture(tabId);
		let entries = readConsole(tabId, params.clear === true);
		if (params.onlyErrors === true) entries = entries.filter((e) => e.level === "error");
		const pattern = str(params, "pattern");
		if (pattern) {
			const re = new RegExp(pattern, "i");
			entries = entries.filter((e) => re.test(e.text));
		}
		return { entries: entries.slice(-(num(params, "limit") ?? 100)) };
	},

	"network.read": async (ctx, params) => {
		const tabId = await resolveTab(ctx, params, true);
		await enableNetworkCapture(tabId);
		let entries = readNetwork(tabId, params.clear === true);
		const pattern = str(params, "urlPattern");
		if (pattern) {
			const re = new RegExp(pattern, "i");
			entries = entries.filter((e) => re.test(e.url));
		}
		return { entries: entries.slice(-(num(params, "limit") ?? 100)) };
	},
};
