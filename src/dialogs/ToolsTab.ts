import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { getAppStorage, SettingsTab } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import {
	parseAllowedDomains,
	TOOL_ALLOWED_DOMAINS_KEY,
	TOOL_LABELS,
	TOOL_SETTINGS_KEY,
	type ToolEnabledMap,
} from "../tools/tool-settings.js";

const TOOL_NAMES = Object.keys(TOOL_LABELS);

export class ToolsTab extends SettingsTab {
	private enabledMap: ToolEnabledMap = {};
	private allowedDomains = "";

	getTabName(): string {
		return "Tools";
	}

	override async connectedCallback() {
		super.connectedCallback();
		const storage = getAppStorage();
		this.enabledMap = (await storage.settings.get<ToolEnabledMap>(TOOL_SETTINGS_KEY)) || {};
		this.allowedDomains = (await storage.settings.get<string>(TOOL_ALLOWED_DOMAINS_KEY)) || "";
		this.requestUpdate();
	}

	private async toggleTool(name: string, checked: boolean) {
		this.enabledMap = { ...this.enabledMap, [name]: checked };
		await getAppStorage().settings.set(TOOL_SETTINGS_KEY, this.enabledMap);
		this.requestUpdate();
	}

	private async updateAllowedDomains(value: string) {
		this.allowedDomains = value;
		await getAppStorage().settings.set(TOOL_ALLOWED_DOMAINS_KEY, value);
		this.requestUpdate();
	}

	private async resetTools() {
		this.enabledMap = {};
		this.allowedDomains = "";
		await getAppStorage().settings.set(TOOL_SETTINGS_KEY, this.enabledMap);
		await getAppStorage().settings.set(TOOL_ALLOWED_DOMAINS_KEY, "");
		this.requestUpdate();
	}

	protected renderContent(): TemplateResult {
		return this.render();
	}

	render(): TemplateResult {
		const domainCount = parseAllowedDomains(this.allowedDomains).length;

		return html`
			<div class="flex flex-col gap-6">
				<div class="space-y-2">
					<h3 class="text-sm font-semibold text-foreground">Tool availability</h3>
					<p class="text-sm text-muted-foreground">
						Enable or disable individual tools and optionally restrict page-acting tools to approved domains.
					</p>
				</div>

				<div class="rounded-lg border border-border bg-card divide-y divide-border">
					${TOOL_NAMES.map((name) => {
						const enabled = this.enabledMap[name] !== false;
						return html`
							<label class="flex items-center justify-between gap-4 px-4 py-3 cursor-pointer">
								<div>
									<div class="text-sm font-medium text-foreground">${TOOL_LABELS[name]}</div>
									<div class="text-xs text-muted-foreground font-mono">${name}</div>
								</div>
								<input
									type="checkbox"
									.checked=${enabled}
									@change=${(e: Event) => this.toggleTool(name, (e.target as HTMLInputElement).checked)}
								/>
							</label>
						`;
					})}
				</div>

				<div class="space-y-2">
					<h3 class="text-sm font-semibold text-foreground">Allowed domains</h3>
					<p class="text-sm text-muted-foreground">
						Leave empty to allow all sites. When populated, page-acting tools only run on matching domains.
					</p>
					<textarea
						class="w-full min-h-[120px] px-3 py-2 text-sm text-foreground bg-card border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
						.placeholder=${"example.com\napp.example.com"}
						.value=${this.allowedDomains}
						@input=${(e: Event) => this.updateAllowedDomains((e.target as HTMLTextAreaElement).value)}
					></textarea>
					<div class="text-xs text-muted-foreground">${domainCount} allowed domain${domainCount === 1 ? "" : "s"}</div>
				</div>

				<div class="flex justify-end">
					${Button({
						variant: "outline",
						size: "sm",
						onClick: () => this.resetTools(),
						children: "Reset Tools",
					})}
				</div>
			</div>
		`;
	}
}
