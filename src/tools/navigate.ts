import { i18n, icon } from "@mariozechner/mini-lit";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { registerToolRenderer, type ToolRenderer, type ToolRenderResult } from "@mariozechner/pi-web-ui";
import { type Static, Type } from "@sinclair/typebox";
import { html } from "lit";
import { Loader2 } from "lucide";
import { getCurrentBrowserSession } from "../browser/current.js";
import { goBack, goForward, navigateTab } from "../browser/page.js";
import { SkillPill } from "../components/SkillPill.js";
import { TabPill } from "../components/TabPill.js";
import { NAVIGATE_TOOL_DESCRIPTION } from "../prompts/prompts.js";
import { getSitegeistStorage } from "../storage/app-storage.js";
import type { Skill } from "../storage/stores/skills-store.js";
import { formatSkills } from "../utils/format-skills.js";
import "../utils/i18n-extension.js";

// Track tool-initiated navigations to filter out duplicate navigation messages
let isNavigating = false;

export function isToolNavigating(): boolean {
	return isNavigating;
}

function markNavigationStart() {
	isNavigating = true;
}

function markNavigationEnd() {
	isNavigating = false;
}

// ============================================================================
// TYPES
// ============================================================================

const navigateSchema = Type.Object({
	url: Type.Optional(
		Type.String({
			description:
				'URL to open in the current tab (or a new tab if newTab is true). "back" and "forward" move in history.',
		}),
	),
	newTab: Type.Optional(Type.Boolean({ description: "Open the URL in a new tab instead of the current tab" })),
	listTabs: Type.Optional(Type.Boolean({ description: "List the tabs this session owns" })),
	switchToTab: Type.Optional(
		Type.Number({
			description: "Tab ID to make current (get IDs from listTabs). Does not change what the user sees.",
		}),
	),
	showTab: Type.Optional(
		Type.Number({
			description: "Tab ID to bring in front of the user. Use only when the user asked to see the page.",
		}),
	),
	closeTab: Type.Optional(Type.Number({ description: "Tab ID to close" })),
});

export type NavigateParams = Static<typeof navigateSchema>;

export interface TabInfo {
	id: number;
	url: string;
	title: string;
	active: boolean;
	favicon?: string;
}

export interface NavigateResult {
	finalUrl?: string;
	title?: string;
	favicon?: string;
	tabId?: number;
	skills?: Array<{ name: string; shortDescription: string; fullDetails?: Skill }>;
	tabs?: TabInfo[];
	switchedToTab?: number;
}

type NavigateOutput = { content: Array<{ type: "text"; text: string }>; details: NavigateResult };

// ============================================================================
// TOOL
// ============================================================================

export class NavigateTool implements AgentTool<typeof navigateSchema, NavigateResult> {
	label = "Navigate";
	name = "navigate";
	description = NAVIGATE_TOOL_DESCRIPTION;
	parameters = navigateSchema;

	async execute(_toolCallId: string, args: NavigateParams, signal?: AbortSignal): Promise<NavigateOutput> {
		if (signal?.aborted) {
			throw new Error("Navigation aborted");
		}
		const session = getCurrentBrowserSession();

		if (args.listTabs) {
			return this.listTabs();
		}

		if (args.closeTab !== undefined) {
			await session.closeTab(Number(args.closeTab));
			return { content: [{ type: "text", text: `Closed tab ${args.closeTab}` }], details: {} };
		}

		if (args.showTab !== undefined) {
			const tabId = Number(args.showTab);
			await session.show(tabId);
			return this.describeTab(tabId, `Showing tab ${tabId} to the user`);
		}

		if (args.switchToTab !== undefined) {
			markNavigationStart();
			try {
				const tab = await session.setCurrent(Number(args.switchToTab));
				return this.describeTab(tab.id!, `Switched to tab ${tab.id}`, tab.id);
			} finally {
				markNavigationEnd();
			}
		}

		if (args.url === undefined) {
			throw new Error("Invalid navigation parameters");
		}

		markNavigationStart();
		try {
			let tabId: number;
			let finalUrl: string;
			if (args.url === "back" || args.url === "forward") {
				const tab = await session.requireCurrentTab();
				tabId = tab.id!;
				if (args.url === "back") await goBack(tabId);
				else await goForward(tabId);
				finalUrl = (await chrome.tabs.get(tabId)).url ?? "";
			} else if (args.newTab) {
				const tab = await session.createTab(args.url);
				tabId = tab.id!;
				finalUrl = await navigateTab(tabId, args.url, { signal });
			} else {
				const tab = await session.requireCurrentTab();
				tabId = tab.id!;
				finalUrl = await navigateTab(tabId, args.url, { signal });
			}
			const prefix = args.newTab
				? `Opened in new tab: ${finalUrl} (tab ${tabId})`
				: `Navigated to: ${finalUrl} (tab ${tabId})`;
			return this.describeTab(tabId, prefix);
		} finally {
			markNavigationEnd();
		}
	}

	private async describeTab(tabId: number, headline: string, switchedToTab?: number): Promise<NavigateOutput> {
		const tab = await chrome.tabs.get(tabId);
		const finalUrl = tab.url ?? "";
		const title = tab.title || "Untitled";
		const favicon = tab.favIconUrl;

		const skillsRepo = getSitegeistStorage().skills;
		const matchingSkills = finalUrl ? await skillsRepo.getSkillsForUrl(finalUrl) : [];
		const { newOrUpdated, unchanged, formattedText: skillsOutput } = formatSkills(matchingSkills);
		const skills = [...newOrUpdated, ...unchanged].map((s) => ({
			name: s.name,
			shortDescription: s.shortDescription,
			fullDetails: s,
		}));

		const details: NavigateResult = { finalUrl, title, favicon, tabId, skills, switchedToTab };
		const output = `${headline}\nTitle: ${title}\nURL: ${finalUrl}\n\n${skillsOutput}`;
		return { content: [{ type: "text", text: output }], details };
	}

	private async listTabs(): Promise<NavigateOutput> {
		const session = getCurrentBrowserSession();
		const tabs = await session.tabs();
		const tabInfos: TabInfo[] = tabs.map((t) => ({
			id: t.id,
			url: t.url,
			title: t.title || "Untitled",
			active: t.current,
			favicon: t.favicon,
		}));

		const details: NavigateResult = { tabs: tabInfos };
		let output =
			tabInfos.length === 0
				? "This session has no tabs yet. Use navigate with a url to open one.\n"
				: `This session owns ${tabInfos.length} tab(s):\n`;
		for (const tab of tabInfos) {
			const marker = tab.active ? " [CURRENT]" : "";
			output += `  - Tab ${tab.id}: ${tab.title}${marker}\n    URL: ${tab.url}\n`;
		}
		return { content: [{ type: "text", text: output }], details };
	}
}

// ============================================================================
// RENDERER
// ============================================================================

function getFallbackFavicon(url: string): string {
	try {
		const urlObj = new URL(url);
		return `https://www.google.com/s2/favicons?domain=${urlObj.hostname}&sz=32`;
	} catch {
		return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%23999' d='M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z'/%3E%3C/svg%3E";
	}
}

function showTab(tabId?: number): void {
	if (tabId === undefined) return;
	chrome.tabs
		.get(tabId)
		.then(async (tab) => {
			await chrome.tabs.update(tabId, { active: true });
			await chrome.windows.update(tab.windowId, { focused: true });
		})
		.catch(() => undefined);
}

export const navigateRenderer: ToolRenderer<NavigateParams, NavigateResult> = {
	render(
		params: NavigateParams | undefined,
		result: ToolResultMessage<NavigateResult> | undefined,
		_isStreaming?: boolean,
	): ToolRenderResult {
		// Loading state (params but no result)
		if (params && !result) {
			let displayText = "";
			if (params.url) {
				displayText = params.url;
			} else if (params.listTabs) {
				displayText = "Listing tabs...";
			} else if (params.switchToTab !== undefined) {
				displayText = `Switching to tab ${params.switchToTab}`;
			} else if (params.showTab !== undefined) {
				displayText = `Showing tab ${params.showTab}`;
			} else if (params.closeTab !== undefined) {
				displayText = `Closing tab ${params.closeTab}`;
			}

			return {
				content: html`
					<div class="my-2">
						<div
							class="inline-flex items-center gap-2 px-3 py-2 text-sm text-card-foreground bg-card border border-border rounded-lg max-w-full shadow-lg"
						>
							<div class="w-4 h-4 flex-shrink-0 flex items-center justify-center">
								${icon(Loader2, "sm", "animate-spin")}
							</div>
							<span class="truncate font-medium">${i18n("Navigating to")} ${displayText}</span>
						</div>
					</div>
				`,
				isCustom: true,
			};
		}

		// Complete state (with result)
		if (result && !result.isError && result.details) {
			const { finalUrl, title, favicon, skills, tabs, tabId } = result.details;

			// Handle tab listing
			if (tabs) {
				return {
					content: html`
						<div class="flex items-center gap-2 flex-wrap">
							<span class="text-sm text-muted-foreground">${i18n("Open tabs")}</span>
							${tabs.map((tab) => TabPill(tab, true))}
						</div>
					`,
					isCustom: false,
				};
			}

			// Handle navigation/switch results
			if (finalUrl && title) {
				const faviconUrl = favicon || getFallbackFavicon(finalUrl);

				// Convert skills to Skill objects for SkillPill
				const skillObjects: Skill[] = (skills || []).map((s) =>
					s.fullDetails
						? s.fullDetails
						: {
								name: s.name,
								shortDescription: s.shortDescription,
								description: "",
								examples: "",
								library: "",
								domainPatterns: [],
								createdAt: new Date().toISOString(),
								lastUpdated: new Date().toISOString(),
							},
				);

				return {
					content: html`
						<div class="my-2 space-y-2">
							<button
								class="inline-flex items-center gap-2 px-3 py-2 text-sm text-card-foreground bg-card border border-border rounded-lg hover:bg-accent/50 transition-colors max-w-full cursor-pointer shadow-lg"
								@click=${() => showTab(tabId)}
								title="${i18n("Click to open")}: ${finalUrl}"
							>
								<img src="${faviconUrl}" alt="" class="w-4 h-4 flex-shrink-0" />
								<span class="truncate font-medium">${title}</span>
							</button>
							${
								skillObjects.length > 0
									? html`
										<div class="flex flex-wrap gap-2">
											${skillObjects.map((s) => SkillPill(s, true))}
										</div>
								  `
									: ""
							}
						</div>
					`,
					isCustom: true,
				};
			}

			const text = result.content.find((c) => c.type === "text")?.text;
			if (text) {
				return {
					content: html`<div class="my-2 text-sm text-muted-foreground">${text}</div>`,
					isCustom: true,
				};
			}
		}

		// Error state
		if (result?.isError) {
			const errorText = result.content.find((c) => c.type === "text")?.text || "Unknown error";
			return {
				content: html`
					<div class="my-2">
						<div class="text-sm text-destructive">${errorText}</div>
					</div>
				`,
				isCustom: true,
			};
		}

		// Waiting state
		return {
			content: html`<div class="my-2 text-sm text-muted-foreground">${i18n("Waiting...")}</div>`,
			isCustom: true,
		};
	},
};

// Auto-register renderer
registerToolRenderer("navigate", navigateRenderer);
