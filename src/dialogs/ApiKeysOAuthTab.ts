import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { getProviders } from "@mariozechner/pi-ai";
import { getAppStorage, SettingsTab } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { Toast } from "../components/Toast.js";
import {
	getOAuthProviderName,
	isOAuthCredentials,
	type OAuthProviderId,
	oauthLogin,
	parseOAuthCredentials,
	serializeOAuthCredentials,
} from "../oauth/index.js";

const OAUTH_PROVIDERS: OAuthProviderId[] = ["anthropic", "openai-codex", "github-copilot", "google-gemini-cli", "xai"];

const PROVIDER_KEY_MAP: Record<OAuthProviderId, string> = {
	anthropic: "anthropic",
	"openai-codex": "openai-codex",
	"github-copilot": "github-copilot",
	"google-gemini-cli": "google-gemini-cli",
	xai: "xai",
};

// Providers to hide from the API key list (OAuth-only or irrelevant for browser use)
const HIDDEN_PROVIDERS = new Set([
	"amazon-bedrock",
	"azure-openai-responses",
	"github-copilot",
	"google-antigravity",
	"google-vertex",
	"openai-codex",
	"google-gemini-cli",
	"opencode",
	"opencode-go",
	"kimi-coding",
]);

export class ApiKeysOAuthTab extends SettingsTab {
	private oauthStatuses: Record<string, "none" | "logged-in" | "logging-in" | "error"> = {};
	private oauthErrors: Record<string, string> = {};
	private deviceCode: string | null = null;

	getTabName(): string {
		return "API Keys & OAuth";
	}

	override async connectedCallback() {
		super.connectedCallback();
		await this.loadOAuthStatuses();
	}

	private async loadOAuthStatuses() {
		const storage = getAppStorage();
		for (const provider of OAUTH_PROVIDERS) {
			const key = PROVIDER_KEY_MAP[provider];
			const stored = await storage.providerKeys.get(key);
			if (stored && isOAuthCredentials(stored)) {
				const creds = parseOAuthCredentials(stored);
				const expired = Date.now() >= creds.expires;
				this.oauthStatuses[provider] = expired ? "none" : "logged-in";
			} else {
				this.oauthStatuses[provider] = "none";
			}
		}
		this.requestUpdate();
	}

	private async handleLogin(provider: OAuthProviderId) {
		this.oauthStatuses[provider] = "logging-in";
		this.oauthErrors[provider] = "";
		this.deviceCode = null;
		this.requestUpdate();

		try {
			const storage = getAppStorage();

			const credentials = await oauthLogin(provider, undefined, (info) => {
				this.deviceCode = info.userCode;
				this.requestUpdate();
			});

			const key = PROVIDER_KEY_MAP[provider];
			await storage.providerKeys.set(key, serializeOAuthCredentials(credentials));

			this.oauthStatuses[provider] = "logged-in";
			this.deviceCode = null;
			Toast.success(`Logged in to ${getOAuthProviderName(provider)}`);
		} catch (error) {
			console.error(`OAuth login failed for ${provider}:`, error);
			this.oauthStatuses[provider] = "error";
			this.oauthErrors[provider] = error instanceof Error ? error.message : "Login failed";
			this.deviceCode = null;
		}
		this.requestUpdate();
	}

	private async handleLogout(provider: OAuthProviderId) {
		const storage = getAppStorage();
		const key = PROVIDER_KEY_MAP[provider];
		await storage.providerKeys.delete(key);
		this.oauthStatuses[provider] = "none";
		this.oauthErrors[provider] = "";
		this.requestUpdate();
	}

	private renderOAuthProvider(provider: OAuthProviderId): TemplateResult {
		const status = this.oauthStatuses[provider] || "none";
		const error = this.oauthErrors[provider] || "";

		return html`
			<div class="flex items-center justify-between p-4 rounded-lg border border-border bg-card">
				<div class="flex-1">
					<div class="text-sm font-medium text-foreground">${getOAuthProviderName(provider)}</div>
					<div class="text-xs text-muted-foreground mt-1">
						${
							status === "logged-in"
								? html`<span class="text-green-600 dark:text-green-400">Connected</span>`
								: status === "logging-in"
									? this.deviceCode
										? html`<span>Enter code: <strong class="text-foreground font-mono">${this.deviceCode}</strong></span>`
										: html`<span>Logging in...</span>`
									: status === "error"
										? html`<span class="text-destructive">${error}</span>`
										: html`<span>Not connected</span>`
						}
					</div>
				</div>
				<div class="flex gap-2">
					${
						status === "logged-in"
							? Button({
									variant: "outline",
									size: "sm",
									onClick: () => this.handleLogout(provider),
									children: "Logout",
								})
							: Button({
									variant: "default",
									size: "sm",
									disabled: status === "logging-in",
									loading: status === "logging-in",
									onClick: () => this.handleLogin(provider),
									children: "Login",
								})
					}
				</div>
			</div>
		`;
	}

	private renderOAuthSection(): TemplateResult {
		return html`
			<div class="flex flex-col gap-4">
				<div>
					<h3 class="text-sm font-semibold text-foreground mb-2">Subscription Login</h3>
					<p class="text-sm text-muted-foreground mb-4">
						Log in with your existing subscription. No API key needed.
						Tokens are stored locally and refreshed automatically.
					</p>
				</div>

				<div class="flex flex-col gap-3">
					${OAUTH_PROVIDERS.map((p) => this.renderOAuthProvider(p))}
				</div>
			</div>
		`;
	}

	private renderApiKeysSection(): TemplateResult {
		const providers = getProviders().filter((p) => !HIDDEN_PROVIDERS.has(p));

		return html`
			<div class="flex flex-col gap-6">
				<div>
					<h3 class="text-sm font-semibold text-foreground mb-2">API Keys</h3>
					<p class="text-sm text-muted-foreground mb-4">
						Enter API keys for cloud providers. Keys are stored locally in your browser.
					</p>
				</div>
				<div class="flex flex-col gap-6">
					${providers.map((provider) => html`<provider-key-input .provider=${provider}></provider-key-input>`)}
				</div>
			</div>
		`;
	}

	render(): TemplateResult {
		return html`
			<div class="flex flex-col gap-8">
				${this.renderOAuthSection()}
				<div class="border-t border-border"></div>
				${this.renderApiKeysSection()}
			</div>
		`;
	}
}

if (!customElements.get("api-keys-oauth-tab")) {
	customElements.define("api-keys-oauth-tab", ApiKeysOAuthTab);
}
