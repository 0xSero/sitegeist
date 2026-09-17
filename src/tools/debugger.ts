import type { AgentTool } from "@mariozechner/pi-agent-core";
import { StringEnum, type ToolResultMessage } from "@mariozechner/pi-ai";
import {
	registerToolRenderer,
	renderCollapsibleHeader,
	renderHeader,
	type ToolRenderer,
	type ToolRenderResult,
} from "@mariozechner/pi-web-ui";
import { type Static, Type } from "@sinclair/typebox";
import { html } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { Bug } from "lucide";
import { evaluateMain } from "../browser/cdp.js";
import { getCurrentBrowserSession } from "../browser/current.js";

// ============================================================================
// TYPES
// ============================================================================

const debuggerSchema = Type.Object({
	action: StringEnum(["eval", "cookies"], {
		description: "Action to perform",
	}),
	code: Type.Optional(
		Type.String({
			description: "JavaScript code to execute in MAIN world context (required for eval action)",
		}),
	),
});

export type DebuggerParams = Static<typeof debuggerSchema>;

export interface DebuggerResult {
	value: any;
}

// ============================================================================
// TOOL
// ============================================================================

export class DebuggerTool implements AgentTool<typeof debuggerSchema, DebuggerResult> {
	label = "Debugger";
	name = "debugger";
	description = `Execute JavaScript in the MAIN world or access browser APIs that browserjs() and repl tool cannot.

ACTIONS:

1. eval - Execute JavaScript in MAIN world context
   USE CASES (what browserjs() and repl tool CANNOT access):
   - Page's own JavaScript variables, functions, framework instances (React, Vue, Angular state)
   - window properties set by page scripts
   - All other MAIN world internals that USER_SCRIPT world cannot see

   Examples:
   { action: "eval", code: "window.myApp.state" } - Access app state
   { action: "eval", code: "window.myFunction()" } - Call page function
   { action: "eval", code: "JSON.stringify(localStorage)" } - Get localStorage

2. cookies - Get all cookies for current domain (including HttpOnly)
   Returns cookies in format: name: value (one per line)

   Example:
   { action: "cookies" } - Get all cookies

CRITICAL: Use browserjs() and repl tool for DOM manipulation. Use this ONLY for MAIN world access or browser APIs.`;
	parameters = debuggerSchema;

	async execute(
		_toolCallId: string,
		args: DebuggerParams,
		signal?: AbortSignal,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: DebuggerResult }> {
		if (signal?.aborted) {
			throw new Error("Debugger command aborted");
		}

		// The session's current tab
		const tab = await getCurrentBrowserSession().requireCurrentTab();
		if (!tab.id) {
			throw new Error("No tab available");
		}

		try {
			// Handle cookies action
			if (args.action === "cookies") {
				// Check if cookies API is available
				if (!chrome.cookies) {
					throw new Error(
						`TELL THE USER: Cookie access is not available. The "cookies" permission needs to be added to the extension manifest.\n\n` +
							`INSTRUCT THE USER TO:\n` +
							`1. Find where you unpacked the Sitegeist extension files on your computer\n` +
							`2. Open the manifest.json file in a text editor\n` +
							`3. Find the "permissions" array\n` +
							`4. Add "cookies" to the array if it's not already there. Example:\n\n` +
							`   "permissions": [\n` +
							`     "activeTab",\n` +
							`     "storage",\n` +
							`     "cookies"\n` +
							`   ]\n\n` +
							`5. Save the file\n` +
							`6. Go to chrome://extensions (or about:addons for Firefox)\n` +
							`7. Click the reload/refresh button (circular arrow icon) on the Sitegeist extension card\n` +
							`8. Try the cookies command again\n\n` +
							`THEN: Ask the user to confirm when they've completed these steps so you can retry.`,
					);
				}

				try {
					const cookies = await chrome.cookies.getAll({ url: tab.url });
					const output = cookies.map((c: { name: string; value: string }) => `${c.name}: ${c.value}`).join("\n");
					const details: DebuggerResult = { value: cookies };
					return { content: [{ type: "text", text: output }], details };
				} catch (err: any) {
					throw new Error(`Failed to get cookies: ${err.message}`);
				}
			}

			// Handle eval action
			if (args.action === "eval") {
				if (!args.code) {
					throw new Error("eval action requires code parameter");
				}

				// Execute code in MAIN world through the session's debugger attachment
				const result = await evaluateMain(tab.id, args.code);

				// Extract the actual value
				const details: DebuggerResult = { value: result };

				// Format output
				let output = "";
				if (result === undefined) {
					output = "undefined";
				} else if (typeof result === "string") {
					output = result;
				} else {
					output = JSON.stringify(result, null, 2);
				}

				return { content: [{ type: "text", text: output }], details };
			}

			throw new Error(`Unknown action: ${args.action}`);
		} catch (error: any) {
			throw new Error(`Debugger error: ${error.message}`);
		}
	}
}

// ============================================================================
// RENDERER
// ============================================================================

export const debuggerRenderer: ToolRenderer<DebuggerParams, DebuggerResult> = {
	render(
		params: DebuggerParams | undefined,
		result: ToolResultMessage<DebuggerResult> | undefined,
		isStreaming?: boolean,
	): ToolRenderResult {
		// Determine status
		const state = result ? (result.isError ? "error" : "complete") : isStreaming ? "inprogress" : "complete";

		// Create refs for collapsible code section
		const codeContentRef = createRef<HTMLDivElement>();
		const codeChevronRef = createRef<HTMLSpanElement>();

		// With result: show params + result
		if (result && params) {
			const output = result.content.find((c) => c.type === "text")?.text || "";
			const title = params.action === "cookies" ? "Get Cookies" : "MAIN World";

			return {
				content: html`
				<div>
					${renderCollapsibleHeader(state, Bug, title, codeContentRef, codeChevronRef, false)}
					<div ${ref(codeContentRef)} class="max-h-0 overflow-hidden transition-all duration-300 space-y-3">
						${params.action === "eval" && params.code ? html`<code-block .code=${params.code} language="javascript"></code-block>` : ""}
						${output ? html`<console-block .content=${output} .variant=${result.isError ? "error" : "default"}></console-block>` : ""}
					</div>
				</div>
			`,
				isCustom: false,
			};
		}

		// Just params (streaming or waiting for result)
		if (params) {
			const title = params.action === "cookies" ? "Getting Cookies" : "MAIN World";

			return {
				content: html`
				<div>
					${renderCollapsibleHeader(state, Bug, title, codeContentRef, codeChevronRef, false)}
					<div ${ref(codeContentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
						${params.action === "eval" && params.code ? html`<code-block .code=${params.code} language="javascript"></code-block>` : ""}
					</div>
				</div>
			`,
				isCustom: false,
			};
		}

		// No params or result yet
		return {
			content: renderHeader(state, Bug, "Preparing debugger..."),
			isCustom: false,
		};
	},
};

// Auto-register the renderer
registerToolRenderer("debugger", debuggerRenderer);
