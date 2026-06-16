import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { type CustomProvider, SettingsTab } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { Toast } from "../components/Toast.js";
import { getSitegeistStorage } from "../storage/app-storage.js";
import { syncCustomProviderCorsRules } from "../utils/custom-provider-cors.js";
import { CustomProviderEditDialog } from "./CustomProviderEditDialog.js";

/**
 * Settings tab for managing custom (BYO base URL + key) providers.
 * Models defined here show up in the model selector alongside the built-in providers.
 */
export class CustomProvidersTab extends SettingsTab {
	private providers: CustomProvider[] = [];

	getTabName(): string {
		return "Custom Providers";
	}

	override async connectedCallback() {
		super.connectedCallback();
		await this.loadProviders();
	}

	private async loadProviders() {
		try {
			this.providers = await getSitegeistStorage().customProviders.getAll();
			this.requestUpdate();
		} catch (error) {
			console.error("Failed to load custom providers:", error);
		}
	}

	private add() {
		CustomProviderEditDialog.open(undefined, () => this.loadProviders());
	}

	private edit(provider: CustomProvider) {
		CustomProviderEditDialog.open(provider, () => this.loadProviders());
	}

	private async remove(provider: CustomProvider) {
		if (!confirm(`Delete custom provider "${provider.name}"?`)) return;
		try {
			const storage = getSitegeistStorage();
			await storage.customProviders.delete(provider.id);
			// Remove the mirrored key entry created on save.
			await storage.providerKeys.delete(provider.name);
			await syncCustomProviderCorsRules();
			await this.loadProviders();
			Toast.success("Provider deleted");
		} catch (error) {
			console.error("Failed to delete custom provider:", error);
			Toast.error("Failed to delete provider");
		}
	}

	private renderProvider(provider: CustomProvider): TemplateResult {
		const modelCount = provider.models?.length ?? 0;
		return html`
			<div class="flex items-center justify-between p-4 rounded-lg border border-border bg-card">
				<div class="flex-1 min-w-0">
					<div class="text-sm font-medium text-foreground truncate">${provider.name}</div>
					<div class="text-xs text-muted-foreground mt-1 truncate">
						<span class="capitalize">${provider.type}</span>
						${provider.baseUrl ? html` • ${provider.baseUrl}` : ""}
						• ${modelCount} ${modelCount === 1 ? "model" : "models"}
					</div>
				</div>
				<div class="flex gap-2 flex-shrink-0">
					${Button({ variant: "outline", size: "sm", onClick: () => this.edit(provider), children: "Edit" })}
					${Button({ variant: "ghost", size: "sm", onClick: () => this.remove(provider), children: "Delete" })}
				</div>
			</div>
		`;
	}

	render(): TemplateResult {
		return html`
			<div class="flex flex-col gap-4">
				<div class="flex items-start justify-between gap-4">
					<div>
						<h3 class="text-sm font-semibold text-foreground mb-2">Custom Providers</h3>
						<p class="text-sm text-muted-foreground">
							Add OpenAI- or Anthropic-compatible endpoints (e.g. OpenRouter, Together, or a self-hosted server)
							by base URL and API key. Defined models appear in the model selector. Keys are stored locally.
						</p>
					</div>
					${Button({ variant: "default", size: "sm", onClick: () => this.add(), children: "Add Provider" })}
				</div>

				${
					this.providers.length === 0
						? html`<div class="text-sm text-muted-foreground text-center py-8">
								No custom providers yet. Click "Add Provider" to get started.
							</div>`
						: html`<div class="flex flex-col gap-3">
								${this.providers.map((p) => this.renderProvider(p))}
							</div>`
				}
			</div>
		`;
	}
}

if (!customElements.get("custom-providers-tab")) {
	customElements.define("custom-providers-tab", CustomProvidersTab);
}
