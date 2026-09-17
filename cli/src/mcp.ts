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
	return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }];
}

function harnessName(): string {
	const explicit = process.env.SITEGEIST_CLIENT_NAME;
	if (explicit) return explicit;
	if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT) return "claude";
	if (process.env.CODEX_HOME || process.env.CODEX_SANDBOX) return "codex";
	if (process.env.OMP_SESSION_ID || process.env.PI_SESSION_ID) return "omp";
	return "mcp";
}

function sessionKey(): string | undefined {
	return (
		process.env.SITEGEIST_SESSION ||
		process.env.CLAUDE_SESSION_ID ||
		process.env.CODEX_THREAD_ID ||
		process.env.OMP_SESSION_ID ||
		process.env.PI_SESSION_ID ||
		undefined
	);
}

export async function runMcpServer(): Promise<void> {
	if (!isInstalled()) {
		// First run from any harness completes setup; the extension reconnects on its alarm.
		const result = install();
		process.stderr.write(`[sitegeist] installed native host manifest (${result.written.length} browser dir(s))\n`);
	}

	const server = new McpServer({ name: "sitegeist", version: VERSION });
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

	async function call(method: string, params: Record<string, unknown> = {}): Promise<{ content: Content[]; isError?: boolean }> {
		try {
			const result = await client.call(method, params);
			return { content: text(result) };
		} catch (err) {
			const message = err instanceof BridgeRpcError ? `${err.rpc.code}: ${err.rpc.message}` : err instanceof Error ? err.message : String(err);
			return { content: text(message), isError: true };
		}
	}

	const tabId = z.number().int().optional().describe("Tab to act on; defaults to the session's current tab");

	server.registerTool(
		"tabs_context",
		{
			description:
				"List the tabs this session owns (its own tab group, running in the background). Call first. A new session has no tabs until navigate or tabs_create.",
			inputSchema: {},
		},
		() => call("tabs.context"),
	);
	server.registerTool(
		"tabs_create",
		{ description: "Open a new background tab in the session and make it current.", inputSchema: { url: z.string().url().optional() } },
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
			description: "Navigate the current tab to a URL, or 'back' / 'forward'. Waits for the page to load.",
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
			description: "Screenshot the current tab (works while it is hidden). Returns an image.",
			inputSchema: {
				tabId,
				fullPage: z.boolean().optional(),
				maxWidth: z.number().int().optional().describe("Downscale to this width (default 1200)"),
			},
		},
		async (args) => {
			try {
				const shot = (await client.call("screenshot", args)) as { data: string; mimeType: string; width: number; height: number };
				return {
					content: [
						{ type: "image", data: shot.data, mimeType: shot.mimeType },
						{ type: "text", text: `${shot.width}x${shot.height} screenshot` },
					],
				};
			} catch (err) {
				return { content: text(err instanceof Error ? err.message : String(err)), isError: true };
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
		(args) => call("snapshot", args),
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
		(args) => call("find", args),
	);
	const targetSchema = {
		tabId,
		ref: z.string().optional().describe("Element ref from read_page or find"),
		selector: z.string().optional().describe("CSS selector"),
		x: z.number().optional(),
		y: z.number().optional(),
	};
	server.registerTool(
		"click",
		{
			description: "Click an element (by ref, selector, or viewport x/y) with real input events.",
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
			description: "Drag from one viewport point to another.",
			inputSchema: { tabId, from: z.object({ x: z.number(), y: z.number() }), to: z.object({ x: z.number(), y: z.number() }) },
		},
		(args) => call("drag", args),
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
