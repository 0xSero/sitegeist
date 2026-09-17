/**
 * Browser OAuth integration for sitegeist.
 *
 * Credentials are stored as JSON strings in the provider keys store.
 * When getApiKey encounters a JSON string, it parses it as OAuthCredentials,
 * refreshes the token if expired, and returns the access token.
 */

import { loginAnthropic, refreshAnthropic } from "./anthropic.js";
import { loginGitHubCopilot, refreshGitHubCopilot } from "./github-copilot.js";
import { loginGeminiCli, refreshGeminiCli } from "./google-gemini-cli.js";
import { loginOpenAICodex, refreshOpenAICodex } from "./openai-codex.js";
import {
	isOAuthCredentials,
	type OAuthCredentials,
	parseOAuthCredentials,
	serializeOAuthCredentials,
} from "./types.js";

export { isOAuthCredentials, type OAuthCredentials, parseOAuthCredentials, serializeOAuthCredentials };

export type OAuthProviderId = "anthropic" | "openai-codex" | "github-copilot" | "google-gemini-cli";

const OAUTH_PROVIDERS: Record<OAuthProviderId, { name: string }> = {
	anthropic: { name: "Anthropic (Claude Pro/Max)" },
	"openai-codex": { name: "ChatGPT Plus/Pro" },
	"github-copilot": { name: "GitHub Copilot" },
	"google-gemini-cli": { name: "Google Gemini" },
};

/**
 * Check if a provider supports OAuth login.
 */
export function isOAuthProvider(provider: string): provider is OAuthProviderId {
	return provider in OAUTH_PROVIDERS;
}

/**
 * Get display name for an OAuth provider.
 */
export function getOAuthProviderName(provider: OAuthProviderId): string {
	return OAUTH_PROVIDERS[provider].name;
}

/**
 * Callback for device code flows (GitHub Copilot).
 * Called with the user code and verification URL that the user needs to enter.
 */
export type DeviceCodeCallback = (info: { userCode: string; verificationUri: string }) => void;

/**
 * Run the OAuth login flow for a provider.
 * Returns credentials to store.
 */
export async function oauthLogin(
	provider: OAuthProviderId,
	_proxyUrl?: string,
	onDeviceCode?: DeviceCodeCallback,
): Promise<OAuthCredentials> {
	switch (provider) {
		case "anthropic":
			return loginAnthropic();
		case "openai-codex":
			return loginOpenAICodex();
		case "github-copilot":
			return loginGitHubCopilot(onDeviceCode || (() => {}));
		case "google-gemini-cli":
			return loginGeminiCli();
		default:
			throw new Error(`Unknown OAuth provider: ${provider}`);
	}
}

/**
 * Refresh OAuth credentials for a provider.
 * Returns updated credentials to store.
 */
export async function oauthRefresh(credentials: OAuthCredentials, _proxyUrl?: string): Promise<OAuthCredentials> {
	switch (credentials.providerId) {
		case "anthropic":
			return refreshAnthropic(credentials);
		case "openai-codex":
			return refreshOpenAICodex(credentials);
		case "github-copilot":
			return refreshGitHubCopilot(credentials);
		case "google-gemini-cli":
			return refreshGeminiCli(credentials);
		default:
			throw new Error(`Unknown OAuth provider: ${credentials.providerId}`);
	}
}

/**
 * Resolve an API key from stored value.
 * If the value is a plain string, return it directly.
 * If it is JSON (OAuth credentials), refresh if expired and return the access token.
 * Updates storage with refreshed credentials.
 */
export async function resolveApiKey(
	storedValue: string,
	provider: string,
	storage: { set: (provider: string, value: string) => Promise<void> },
	proxyUrl?: string,
): Promise<string> {
	if (!isOAuthCredentials(storedValue)) {
		return storedValue;
	}

	let credentials = parseOAuthCredentials(storedValue);

	// Refresh if expired (or within 60s of expiry)
	if (Date.now() >= credentials.expires - 60_000) {
		try {
			credentials = await oauthRefresh(credentials, proxyUrl);
			await storage.set(provider, serializeOAuthCredentials(credentials));
		} catch (error) {
			console.error(`Failed to refresh OAuth token for ${provider}:`, error);
			throw new Error(`OAuth token expired and refresh failed for ${provider}`);
		}
	}

	// Gemini CLI expects the API key as JSON with token and projectId
	if (credentials.providerId === "google-gemini-cli") {
		return JSON.stringify({ token: credentials.access, projectId: credentials.projectId });
	}

	return credentials.access;
}
