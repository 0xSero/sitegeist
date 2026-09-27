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
	screenshotToCss,
	startScreencast,
	stopScreencast,
	typeText,
} from "../browser/cdp.js";
import { injectScript } from "../browser/inject.js";
import {
	fillElement,
	goBack,
	goForward,
	locate,
	navigateTabDetailed,
	pageHtml,
	pageText,
	runInPage,
	scrollPage,
	snapshot,
	waitFor,
	waitForLoad,
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
	/** Stable id of the calling client. */
	clientId: string;
	/** Push an event to the calling client only. */
	emit(event: string, data: Record<string, unknown>): void;
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

/** `stillLoading`: the wait gave up before DOMContentLoaded (the page may be incomplete). */
async function tabSummary(tabId: number, stillLoading = false) {
	const tab = await chrome.tabs.get(tabId);
	return {
		tabId,
		url: tab.url ?? tab.pendingUrl ?? "",
		title: tab.title ?? "",
		...(stillLoading ? { loading: true } : {}),
	};
}

function target(params: Params): { ref?: string; selector?: string } {
	return { ref: str(params, "ref"), selector: str(params, "selector") };
}

async function pointFor(_ctx: HandlerContext, params: Params, tabId: number): Promise<{ x: number; y: number }> {
	const x = num(params, "x");
	const y = num(params, "y");
	if (x !== undefined && y !== undefined) return screenshotToCss(tabId, { x, y });
	const t = target(params);
	if (!t.ref && !t.selector) throw new BridgeError(ERR.BAD_PARAMS, "Provide ref, selector, or x and y");
	const rect = await locate(tabId, t);
	return { x: rect.x, y: rect.y };
}

/** One `actions` step as [handler, params]; accepts the spellings models reach for. */
function normalizeStep(step: Params, i: number): [string, Params] {
	const obj = (v: unknown): Params => (v && typeof v === "object" ? (v as Params) : {});
	if ("press" in step) return ["press", typeof step.press === "string" ? { key: step.press } : obj(step.press)];
	if ("key" in step) return ["press", { key: String(step.key), ...(step.repeat ? { repeat: step.repeat } : {}) }];
	if ("type" in step) return ["type", typeof step.type === "string" ? { text: step.type } : obj(step.type)];
	if ("text" in step) return ["type", { text: String(step.text) }];
	if ("click" in step) return ["click", obj(step.click)];
	if ("doubleClick" in step || "dblclick" in step)
		return ["click", { ...obj(step.doubleClick ?? step.dblclick), clickCount: 2 }];
	if ("drag" in step) return ["drag", obj(step.drag)];
	if ("hover" in step || "move" in step) return ["hover", obj(step.hover ?? step.move)];
	if ("scroll" in step) return ["scroll", obj(step.scroll)];
	for (const k of ["wait", "sleep", "pause"])
		if (k in step) return ["wait", typeof step[k] === "number" ? { ms: step[k] } : obj(step[k])];
	if ("screenshot" in step) return ["screenshot", {}];
	throw new BridgeError(
		ERR.BAD_PARAMS,
		`step ${i}: expected one of press, click, doubleClick, drag, type, hover, scroll, wait, screenshot`,
	);
}

export const handlers: Record<string, Handler> = {
	"tabs.context": async (ctx) => {
		const tabs = await ctx.session.tabs();
		return {
			tabs: tabs.map((t) => ({
				tabId: t.id,
				url: t.url,
				title: t.title,
				current: t.current,
				...(t.inGroup ? {} : { inGroup: false }),
			})),
		};
	},

	"tabs.create": async (ctx, params) => {
		const url = str(params, "url");
		if (url) await ctx.checkUrl(url);
		const tab = await ctx.session.createTab(url);
		const ready = url ? await waitForLoad(tab.id!, 20000) : true;
		return tabSummary(tab.id!, !ready);
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
		const history = url === "back" || url === "forward";
		if (!history) await ctx.checkUrl(url);
		// The first navigate of a session opens its tab straight on the URL (no blank tab).
		if (!history && num(params, "tabId") === undefined && !(await ctx.session.currentTab())) {
			const tab = await ctx.session.createTab(url);
			const ready = await waitForLoad(tab.id!, num(params, "timeoutMs") ?? 20000);
			return tabSummary(tab.id!, !ready);
		}
		const tabId = await resolveTab(ctx, params, false);
		let timedOut = false;
		if (url === "back") timedOut = !(await goBack(tabId));
		else if (url === "forward") timedOut = !(await goForward(tabId));
		else {
			const waitUntil = str(params, "waitUntil") === "load" ? "load" : "domcontentloaded";
			timedOut = (await navigateTabDetailed(tabId, url, { waitUntil, timeoutMs: num(params, "timeoutMs") ?? 20000 }))
				.timedOut;
		}
		return tabSummary(tabId, timedOut);
	},

	screenshot: async (ctx, params) => {
		const tabId = await resolveTab(ctx, params, true);
		const clip = params.clip as { x: number; y: number; width: number; height: number } | undefined;
		const shot = await captureScreenshot(tabId, {
			maxWidth: num(params, "maxWidth"),
			fullPage: params.fullPage === true,
			clip,
			format: str(params, "format") === "png" ? "png" : "jpeg",
			quality: num(params, "quality"),
		});
		return shot;
	},

	"screencast.start": async (ctx, params) => {
		const tabId = await resolveTab(ctx, params, true);
		await startScreencast(
			tabId,
			ctx.clientId,
			{
				format: str(params, "format") === "png" ? "png" : "jpeg",
				quality: num(params, "quality"),
				maxWidth: num(params, "maxWidth"),
				maxHeight: num(params, "maxHeight"),
				maxFps: num(params, "maxFps"),
				initScript: str(params, "initScript"),
			},
			(frame) => ctx.emit("screencast_frame", { tabId, data: frame.data, metadata: frame.metadata }),
			(reason) => ctx.emit("screencast_stopped", { tabId, reason }),
		);
		return { tabId, streaming: true };
	},

	"screencast.stop": async (ctx, params) => {
		const tabId = await resolveTab(ctx, params, false);
		return { tabId, stopped: await stopScreencast(tabId) };
	},

	snapshot: async (ctx, params) => {
		const tabId = await resolveTab(ctx, params, true);
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
		await drag(tabId, screenshotToCss(tabId, from), screenshotToCss(tabId, to));
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
		const tabId = await resolveTab(ctx, params, true);
		const x = num(params, "x");
		const y = num(params, "y");
		const dx = num(params, "dx") ?? 0;
		const dy = num(params, "dy") ?? 0;
		if (x !== undefined && y !== undefined && !params.ref && !params.selector && !params.to) {
			// Wheel at a point: scrolls the innermost scrollable under the cursor.
			const at = screenshotToCss(tabId, { x, y });
			await cdpScroll(tabId, at.x, at.y, dx, dy);
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
		const tabId = await resolveTab(ctx, params, true);
		return { value: await injectScript(tabId, code) };
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

	/**
	 * Several input steps in one call (press / click / drag / type / hover / scroll / wait),
	 * optionally ending with a screenshot. Canvas work (draw, label, connect) is otherwise one
	 * model turn per keystroke. Stops at the first failing step and says which.
	 */
	actions: async (ctx, params) => {
		const steps = params.steps;
		if (!Array.isArray(steps) || steps.length === 0)
			throw new BridgeError(ERR.BAD_PARAMS, "steps must be a non-empty array");
		if (steps.length > 40) throw new BridgeError(ERR.BAD_PARAMS, "at most 40 steps per call");
		// Apps react to input a frame later (a text editor opens after Enter, a tool arms after
		// its shortcut); without a short settle the next keystroke lands before it and is lost.
		const settleMs = Math.max(0, Math.min(1000, num(params, "settleMs") ?? 80));
		let wantShot = params.screenshot === true;
		const done: unknown[] = [];
		for (let i = 0; i < steps.length; i++) {
			const [kind, sub] = normalizeStep(steps[i] as Params, i);
			if (kind === "screenshot") {
				wantShot = true;
				continue;
			}
			const withTab = params.tabId !== undefined && sub.tabId === undefined ? { ...sub, tabId: params.tabId } : sub;
			try {
				done.push(await handlers[kind](ctx, withTab));
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				throw new BridgeError(ERR.BAD_PARAMS, `step ${i} (${kind}) failed after ${i} steps succeeded: ${message}`);
			}
			if (settleMs > 0 && i < steps.length - 1) await new Promise((r) => setTimeout(r, settleMs));
		}
		const out: Record<string, unknown> = { steps: done.length };
		if (wantShot) out.screenshot = await handlers.screenshot(ctx, { tabId: params.tabId });
		return out;
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
