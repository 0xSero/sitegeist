/**
 * `sitegeist mcp`: stdio MCP server that exposes the browser bridge to any MCP
 * client (Claude Code, Codex, omp, ...). Tool names mirror Claude in Chrome so
 * prompts written for it carry over.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BridgeClient, BridgeRpcError } from "./client.ts";
import { install, isInstalled } from "./install.ts";
import { VERSION } from "./version.ts";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

function text(value: unknown): Content[] {
	return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }];
}

interface SnapNode {
	ref: string;
	role: string;
	name: string;
	value?: string;
	href?: string;
	visible: boolean;
}

/** One line per element; same-origin links shortened to their path. */
function formatNodes(nodes: SnapNode[], pageUrl: string): string {
	let origin = "";
	try {
		origin = new URL(pageUrl).origin;
	} catch {
		/* no origin */
	}
	return nodes
		.map((n) => {
			let line = `${n.ref} ${n.role} ${JSON.stringify(n.name)}`;
			if (n.value) line += ` value=${JSON.stringify(n.value)}`;
			if (n.href) line += ` -> ${origin && n.href.startsWith(origin) ? n.href.slice(origin.length) || "/" : n.href}`;
			if (!n.visible) line += " (offscreen)";
			return line;
		})
		.join("\n");
}

/** read_page as compact text: a fraction of the tokens of pretty JSON, same information. */
function formatSnapshot(snap: {
	url: string;
	title: string;
	viewport: { width: number; height: number; scrollY: number; pageHeight: number };
	nodes: SnapNode[];
	text: string;
}): string {
	const v = snap.viewport;
	const parts = [
		`Page: ${snap.title} | ${snap.url}`,
		`Viewport ${v.width}x${v.height}, scrollY ${v.scrollY} of ${v.pageHeight}`,
		`Elements (${snap.nodes.length}; use the ref with click/type/fill/scroll):`,
		formatNodes(snap.nodes, snap.url),
	];
	if (snap.text) parts.push("", "Text:", snap.text);
	return parts.join("\n");
}

function harnessName(): string {
	const explicit = process.env.SITEGEIST_CLIENT_NAME;
	if (explicit) return explicit;
	if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT) return "claude";
	if (process.env.CODEX_HOME || process.env.CODEX_SANDBOX) return "codex";
	if (process.env.OMP_SESSION_ID || process.env.PI_SESSION_ID) return "omp";
	return "mcp";
}

/**
 * The browser session this server drives. Always set: without one every reconnect
 * (extension reload, worker restart) got a fresh session and lost its tabs. One MCP
 * server process serves one harness session, so the process identity is the fallback.
 */
function sessionKey(): string {
	return (
		process.env.SITEGEIST_SESSION ||
		process.env.CLAUDE_SESSION_ID ||
		process.env.CODEX_THREAD_ID ||
		process.env.OMP_SESSION_ID ||
		process.env.PI_SESSION_ID ||
		`p${process.pid}-${Date.now().toString(36)}`
	);
}

export async function runMcpServer(): Promise<void> {
	if (!isInstalled()) {
		// First run from any harness completes setup; the extension reconnects on its alarm.
		const result = install();
		process.stderr.write(`[sitegeist] installed native host manifest (${result.written.length} browser dir(s))\n`);
	}

	const server = new McpServer(
		{ name: "sitegeist", version: VERSION },
		{
			instructions: [
				"sitegeist drives the user's real Chromium browser in the background.",
				"You get your own tab group; your tabs never take focus and you cannot see the user's other tabs.",
				"Workflow: navigate(url) -> read_page (refs) -> click/type/fill by ref -> read_page again to confirm.",
				"For canvas apps and multi-step input, batch steps with actions (one call, screenshot at the end) instead of one tool call per key or drag.",
				"Canvas editors (Excalidraw, tldraw, Figma-like): use the app's keyboard shortcuts and mouse drags, check the result on the screenshot, and do not reverse-engineer the app's internals with run_js.",
				"Reuse your current tab for step-by-step browsing; tabs_create only when two pages must stay open.",
				"Close tabs you no longer need with tabs_close. Prefer read_page/get_page_text over screenshots for reading.",
				"Refs expire when the page changes; take a new read_page after navigation or big updates.",
			].join(" "),
		},
	);
	const client = new BridgeClient({
		name: harnessName(),
		session: sessionKey(),
		onEvent: (event, data) => {
			if (event === "permission_request") void handlePermission(data);
		},
	});

	async function handlePermission(data: Record<string, unknown>): Promise<void> {
		const requestId = String(data.requestId);
		const host = String(data.host);
		let decision: "allow_once" | "allow_host" | "deny" = "deny";
		if (process.env.SITEGEIST_AUTO_ALLOW === "1") {
			await client.call("permission.respond", { requestId, decision: "allow_once" }).catch(() => undefined);
			return;
		}
		try {
			const answer = await server.server.elicitInput({
				message: `sitegeist: the browser agent wants to open ${host}. Allow?`,
				requestedSchema: {
					type: "object",
					properties: {
						decision: {
							type: "string",
							title: "Decision",
							enum: ["allow_host", "allow_once", "deny"],
							enumNames: [`Allow ${host} from now on`, "Allow once", "Deny"],
						},
					},
					required: ["decision"],
				},
			});
			if (answer.action === "accept") {
				const d = (answer.content as { decision?: string } | undefined)?.decision;
				if (d === "allow_host" || d === "allow_once" || d === "deny") decision = d;
			}
		} catch {
			// Client without elicitation support (headless runs): deny now instead of stalling
			// the tool call; the error text tells the model how the user can allow the host.
			process.stderr.write(
				`[sitegeist] ${host} needs approval: run \`sitegeist allow ${host}\`, use the side panel (Settings > Bridge), or set SITEGEIST_AUTO_ALLOW=1.\n`,
			);
		}
		await client.call("permission.respond", { requestId, decision }).catch(() => undefined);
	}

	function errorResult(err: unknown): { content: Content[]; isError: true } {
		const message = err instanceof BridgeRpcError ? `${err.rpc.code}: ${err.rpc.message}` : err instanceof Error ? err.message : String(err);
		return { content: text(message), isError: true };
	}

	async function call(method: string, params: Record<string, unknown> = {}): Promise<{ content: Content[]; isError?: boolean }> {
		try {
			const result = await client.call(method, params);
			return { content: text(result) };
		} catch (err) {
			return errorResult(err);
		}
	}

	const tabId = z.number().int().optional().describe("Tab to act on; defaults to the session's current tab");

	server.registerTool(
		"tabs_context",
		{
			description:
				"List the tabs in your session's own tab group (background tabs, separate from the user's). A new session has none: navigate opens the first one.",
			inputSchema: {},
		},
		() => call("tabs.context"),
	);
	server.registerTool(
		"tabs_create",
		{
			description:
				"Open a URL in an additional background tab in your group and make it current. Only for keeping a second page open; for normal browsing use navigate.",
			inputSchema: { url: z.string().url() },
		},
		(args) => call("tabs.create", args),
	);
	server.registerTool(
		"tabs_close",
		{ description: "Close one of the session's tabs.", inputSchema: { tabId: z.number().int() } },
		(args) => call("tabs.close", args),
	);
	server.registerTool(
		"tabs_select",
		{ description: "Make one of the session's tabs current without showing it to the user.", inputSchema: { tabId: z.number().int() } },
		(args) => call("tabs.select", args),
	);
	server.registerTool(
		"tabs_show",
		{
			description: "Bring a tab in front of the user. Only when they asked to see it or must act themselves (login, captcha).",
			inputSchema: { tabId },
		},
		(args) => call("tabs.show", args),
	);
	server.registerTool(
		"navigate",
		{
			description:
				"Load a URL in your current tab (the first call opens your tab), or 'back' / 'forward'. Waits for the page; the result has tabId, url, title, and loading:true if it is still loading.",
			inputSchema: {
				url: z.string(),
				tabId,
				waitUntil: z.enum(["domcontentloaded", "load"]).optional(),
			},
		},
		(args) => call("navigate", args),
	);
	server.registerTool(
		"screenshot",
		{
			description:
				"JPEG screenshot of the current tab's viewport (works while it is hidden). For layout and visual checks; read_page / get_page_text are faster and cheaper for reading.",
			inputSchema: {
				tabId,
				fullPage: z.boolean().optional(),
				maxWidth: z
					.number()
					.int()
					.optional()
					.describe("Image width in pixels. Default: the viewport's CSS width (max 1280), so image x/y can be clicked directly"),
			},
		},
		async (args) => {
			try {
				const shot = (await client.call("screenshot", args)) as {
					data: string;
					mimeType: string;
					width: number;
					height: number;
					cssWidth?: number;
					cssHeight?: number;
				};
				const note = "Give click/drag/hover/scroll x/y in this image's pixels; they are mapped to the page for you.";
				return {
					content: [
						{ type: "image", data: shot.data, mimeType: shot.mimeType },
						{ type: "text", text: `${shot.width}x${shot.height} screenshot. ${note}` },
					],
				};
			} catch (err) {
				return errorResult(err);
			}
		},
	);
	server.registerTool(
		"read_page",
		{
			description:
				"Compact snapshot of the page: interactive elements with refs (e1, e2, ...) and coordinates, plus readable text. Use refs with click/type/fill.",
			inputSchema: {
				tabId,
				filter: z.enum(["all", "interactive"]).optional(),
				maxNodes: z.number().int().optional(),
				maxTextChars: z.number().int().optional(),
			},
		},
		async (args) => {
			try {
				const snap = (await client.call("snapshot", { ...args, maxTextChars: args.maxTextChars ?? 3000 })) as Parameters<typeof formatSnapshot>[0];
				return { content: text(formatSnapshot(snap)) };
			} catch (err) {
				return errorResult(err);
			}
		},
	);
	server.registerTool(
		"get_page_text",
		{ description: "Readable text of the page or of a CSS selector.", inputSchema: { tabId, selector: z.string().optional(), maxChars: z.number().int().optional() } },
		(args) => call("text", args),
	);
	server.registerTool(
		"get_page_html",
		{ description: "Outer HTML of the page or of a CSS selector.", inputSchema: { tabId, selector: z.string().optional(), maxChars: z.number().int().optional() } },
		(args) => call("html", args),
	);
	server.registerTool(
		"find",
		{
			description: "Find elements by words in their role, label, value or href. Returns refs for click/type/fill.",
			inputSchema: { query: z.string(), tabId, limit: z.number().int().optional() },
		},
		async (args) => {
			try {
				const found = (await client.call("find", args)) as { matches: SnapNode[] };
				if (found.matches.length === 0) return { content: text(`No elements match "${args.query}". Try read_page or other words.`) };
				return { content: text(formatNodes(found.matches, "")) };
			} catch (err) {
				return errorResult(err);
			}
		},
	);
	const targetSchema = {
		tabId,
		ref: z.string().optional().describe("Element ref from read_page or find"),
		selector: z.string().optional().describe("CSS selector"),
		x: z.number().optional().describe("Pixel x in the latest screenshot"),
		y: z.number().optional().describe("Pixel y in the latest screenshot"),
	};
	server.registerTool(
		"click",
		{
			description: "Click an element by ref or selector, or at x/y pixels of the latest screenshot, with real input events.",
			inputSchema: { ...targetSchema, button: z.enum(["left", "right", "middle"]).optional(), clickCount: z.number().int().optional() },
		},
		(args) => call("click", args),
	);
	server.registerTool("hover", { description: "Move the mouse over an element.", inputSchema: targetSchema }, (args) => call("hover", args));
	server.registerTool(
		"type",
		{
			description: "Type text with real key events. Clicks the target first when ref/selector is given. submit presses Enter afterwards.",
			inputSchema: { text: z.string(), tabId, ref: z.string().optional(), selector: z.string().optional(), submit: z.boolean().optional() },
		},
		(args) => call("type", args),
	);
	server.registerTool(
		"press",
		{
			description: "Press a key or chord: Enter, Escape, Tab, ArrowDown, Control+a, Meta+Shift+p ...",
			inputSchema: { key: z.string(), tabId, repeat: z.number().int().optional() },
		},
		(args) => call("press", args),
	);
	server.registerTool(
		"fill",
		{
			description: "Set a form control's value directly (inputs, textareas, selects, checkboxes, contenteditable).",
			inputSchema: { value: z.string(), tabId, ref: z.string().optional(), selector: z.string().optional() },
		},
		(args) => call("fill", args),
	);
	server.registerTool(
		"scroll",
		{
			description: "Scroll the page by dx/dy, to top/bottom, or to an element (ref/selector).",
			inputSchema: {
				tabId,
				dx: z.number().optional(),
				dy: z.number().optional(),
				to: z.enum(["top", "bottom"]).optional(),
				ref: z.string().optional(),
				selector: z.string().optional(),
			},
		},
		(args) => call("scroll", args),
	);
	server.registerTool(
		"drag",
		{
			description: "Drag with the mouse between two points given in the latest screenshot's pixels (draw shapes, move items, connect arrows).",
			inputSchema: { tabId, from: z.object({ x: z.number(), y: z.number() }), to: z.object({ x: z.number(), y: z.number() }) },
		},
		(args) => call("drag", args),
	);
	server.registerTool(
		"actions",
		{
			description:
				"Run several input steps in one call, then optionally screenshot. Best for canvas apps and forms: " +
				'e.g. steps [{"press":"r"},{"drag":{"from":{"x":200,"y":200},"to":{"x":360,"y":300}}},{"press":"Enter"},{"type":"Start"},{"press":"Escape"}], screenshot true. ' +
				"Step kinds: press (key or chord), click ({x,y} | {ref} | {selector}, optional clickCount), doubleClick ({x,y}), drag ({from,to}), type (text), hover ({x,y}|{ref}), scroll ({dx,dy}|{to}), wait (ms). " +
				"x/y are pixels of the latest screenshot. Steps are spaced by settleMs (default 80) so the app can react. Stops at the first failing step.",
			inputSchema: {
				steps: z.array(z.record(z.string(), z.any())).min(1).max(40),
				screenshot: z.boolean().optional().describe("Return a screenshot after the last step"),
				settleMs: z.number().int().optional().describe("Pause between steps in ms (default 80)"),
				tabId,
			},
		},
		async (args) => {
			try {
				const res = (await client.call("actions", args)) as {
					steps: number;
					screenshot?: { data: string; mimeType: string; width: number; height: number };
				};
				const content: Content[] = [{ type: "text", text: `${res.steps} steps done.` }];
				if (res.screenshot) {
					content.unshift({ type: "image", data: res.screenshot.data, mimeType: res.screenshot.mimeType });
					content.push({
						type: "text",
						text: `${res.screenshot.width}x${res.screenshot.height} screenshot. Give x/y in this image's pixels.`,
					});
				}
				return { content };
			} catch (err) {
				return errorResult(err);
			}
		},
	);
	server.registerTool(
		"run_js",
		{
			description:
				"Run JavaScript in the page and return its JSON value. world=user (default) is an isolated world with DOM access; world=main sees the page's own globals.",
			inputSchema: { code: z.string(), tabId, world: z.enum(["user", "main"]).optional() },
		},
		(args) => call("evaluate", args),
	);
	server.registerTool(
		"wait",
		{
			description: "Wait for a selector, text, URL fragment, or a fixed number of milliseconds.",
			inputSchema: {
				tabId,
				selector: z.string().optional(),
				text: z.string().optional(),
				urlIncludes: z.string().optional(),
				ms: z.number().int().optional(),
				timeoutMs: z.number().int().optional(),
			},
		},
		(args) => call("wait", args),
	);
	server.registerTool(
		"read_console",
		{
			description: "Console messages captured on the tab since capture started (first call starts capture).",
			inputSchema: { tabId, onlyErrors: z.boolean().optional(), pattern: z.string().optional(), clear: z.boolean().optional(), limit: z.number().int().optional() },
		},
		(args) => call("console.read", args),
	);
	server.registerTool(
		"read_network",
		{
			description: "Network requests captured on the tab since capture started (first call starts capture).",
			inputSchema: { tabId, urlPattern: z.string().optional(), clear: z.boolean().optional(), limit: z.number().int().optional() },
		},
		(args) => call("network.read", args),
	);

	const transport = new StdioServerTransport();
	await server.connect(transport);
	// Connect lazily on the first call, but try once now so a missing extension is reported early.
	client.connect().catch((err) => process.stderr.write(`[sitegeist] ${err instanceof Error ? err.message : String(err)}\n`));
}
