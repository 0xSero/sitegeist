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

const OAUTH_PROVIDERS: OAuthProviderId[] = ["anthropic", "openai-codex", "github-copilot", "google-gemini-cli"];

const PROVIDER_KEY_MAP: Record<OAuthProviderId, string> = {
	anthropic: "anthropic",
	"openai-codex": "openai-codex",
	"github-copilot": "github-copilot",
	"google-gemini-cli": "google-gemini-cli",
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
]);

export class ApiKeysOAuthTab extends SettingsTab {
	private oauthStatuses: Record<string, "none" | "logged-in" | "logging-in" | "error"> = {};
	private oauthErrors: Record<string, string> = {};
	private deviceCode: string | null = null;
	private proxyEnabled = false;
	private proxyUrl = "";

	getTabName(): string {
		return "API Keys & OAuth";
	}

	override async connectedCallback() {
		super.connectedCallback();
		await this.refreshProxyStatus();
		await this.loadOAuthStatuses();

		// Poll proxy settings so changes in the Proxy tab are reflected here
		this.proxyPollInterval = window.setInterval(() => this.refreshProxyStatus(), 1000);
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		if (this.proxyPollInterval) {
			clearInterval(this.proxyPollInterval);
		}
	}

	private proxyPollInterval?: number;

	private providerNeedsProxy(provider: OAuthProviderId): boolean {
		// Google Gemini CLI endpoints have CORS enabled, no proxy needed
		return provider !== "google-gemini-cli";
	}

	private async refreshProxyStatus() {
		const storage = getAppStorage();
		const enabled = (await storage.settings.get<boolean>("proxy.enabled")) || false;
		const url = (await storage.settings.get<string>("proxy.url")) || "";
		if (enabled !== this.proxyEnabled || url !== this.proxyUrl) {
			this.proxyEnabled = enabled;
			this.proxyUrl = url;
			this.requestUpdate();
		}
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
			const proxyEnabled = await storage.settings.get<boolean>("proxy.enabled");
			const proxyUrl = proxyEnabled ? (await storage.settings.get<string>("proxy.url")) || undefined : undefined;

			const credentials = await oauthLogin(provider, proxyUrl, (info) => {
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
									disabled:
										status === "logging-in" || (this.providerNeedsProxy(provider) && !this.proxyEnabled),
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

				<div class="p-3 rounded-lg border ${this.proxyEnabled ? "border-orange-500/30 bg-orange-500/10" : "border-destructive/50 bg-destructive/10"}">
					<p class="text-xs ${this.proxyEnabled ? "text-muted-foreground" : "text-destructive"}">
						${
							this.proxyEnabled
								? html`Requests routed through <strong class="text-foreground font-mono text-[10px]">${this.proxyUrl}</strong>. <span class="text-orange-500">An untrusted proxy can see your credentials.</span> Change in Proxy settings.`
								: html`<strong>CORS proxy is disabled.</strong> Subscription logins require a proxy. Enable it in Proxy settings.`
						}
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
