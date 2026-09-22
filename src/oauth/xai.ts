/**
 * xAI Grok OAuth flow (SuperGrok / X Premium subscription) for browser extensions.
 *
 * Uses the RFC 8628 device code flow against auth.x.ai as a public client.
 * The access token is a Bearer token for https://api.x.ai/v1, so the regular
 * `xai` provider and its model discovery work unchanged.
 * CORS restrictions on auth.x.ai are handled by declarativeNetRequest rules
 * in the manifest.
 */

import type { OAuthCredentials } from "./types.js";

const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const SCOPE = "openid profile email offline_access grok-cli:access api:access";
const DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
const TOKEN_URL = "https://auth.x.ai/oauth2/token";

interface DeviceCodeResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
	verification_uri_complete?: string;
	interval: number;
	expires_in: number;
}

/**
 * POST a form to auth.x.ai. RFC 8628 reports pending/slow_down as HTTP 400
 * with a JSON error body, so error bodies are returned rather than thrown.
 */
async function postForm(url: string, params: Record<string, string>): Promise<any> {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams(params).toString(),
	});
	const text = await response.text();
	let data: any;
	try {
		data = JSON.parse(text);
	} catch {
		throw new Error(`${response.status}: ${text}`);
	}
	if (!response.ok && typeof data.error !== "string") {
		throw new Error(`${response.status}: ${text}`);
	}
	return data;
}

function toCredentials(data: any, previousRefresh?: string): OAuthCredentials {
	const access = data.access_token;
	const refresh = data.refresh_token ?? previousRefresh;
	const expiresIn = data.expires_in;
	if (typeof access !== "string" || typeof refresh !== "string" || typeof expiresIn !== "number") {
		throw new Error("Token response missing required fields");
	}
	return {
		providerId: "xai",
		access,
		refresh,
		expires: Date.now() + expiresIn * 1000,
	};
}

async function startDeviceFlow(): Promise<DeviceCodeResponse> {
	const data = await postForm(DEVICE_CODE_URL, { client_id: CLIENT_ID, scope: SCOPE });
	if (data.error) {
		throw new Error(
			`Device code request failed: ${data.error}${data.error_description ? `: ${data.error_description}` : ""}`,
		);
	}
	if (
		typeof data.device_code !== "string" ||
		typeof data.user_code !== "string" ||
		typeof data.verification_uri !== "string" ||
		typeof data.expires_in !== "number"
	) {
		throw new Error("Invalid device code response");
	}
	return { ...data, interval: typeof data.interval === "number" ? data.interval : 5 } as DeviceCodeResponse;
}

async function pollForToken(deviceCode: string, intervalSeconds: number, expiresIn: number): Promise<OAuthCredentials> {
	const deadline = Date.now() + expiresIn * 1000;
	let intervalMs = Math.max(1000, intervalSeconds * 1000);

	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, intervalMs));

		const data = await postForm(TOKEN_URL, {
			client_id: CLIENT_ID,
			device_code: deviceCode,
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
		});

		if (typeof data.access_token === "string") {
			return toCredentials(data);
		}

		if (data.error === "authorization_pending") {
			continue;
		}

		if (data.error === "slow_down") {
			intervalMs += 5000;
			continue;
		}

		if (data.error) {
			throw new Error(
				`Device flow failed: ${data.error}${data.error_description ? `: ${data.error_description}` : ""}`,
			);
		}
	}

	throw new Error("Device flow timed out");
}

/**
 * Run the xAI device code login flow.
 * Reports the user code via the callback and opens the verification page.
 */
export async function loginXai(
	onDeviceCode: (info: { userCode: string; verificationUri: string }) => void,
): Promise<OAuthCredentials> {
	const device = await startDeviceFlow();

	onDeviceCode({
		userCode: device.user_code,
		verificationUri: device.verification_uri,
	});

	// The complete URI pre-fills the code on accounts.x.ai
	chrome.tabs.create({ url: device.verification_uri_complete ?? device.verification_uri, active: true });

	return pollForToken(device.device_code, device.interval, device.expires_in);
}

/**
 * Refresh an xAI OAuth token. Access tokens last about six hours and
 * refresh tokens rotate, so the returned refresh token replaces the old one.
 */
export async function refreshXai(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const data = await postForm(TOKEN_URL, {
		grant_type: "refresh_token",
		refresh_token: credentials.refresh,
		client_id: CLIENT_ID,
	});
	if (data.error) {
		throw new Error(
			`Token refresh failed: ${data.error}${data.error_description ? `: ${data.error_description}` : ""}`,
		);
	}
	return toCredentials(data, credentials.refresh);
}
