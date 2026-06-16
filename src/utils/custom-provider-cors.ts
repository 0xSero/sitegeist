/**
 * Dynamic CORS rules for custom providers.
 *
 * The static `cors-rules.json` rewrites CORS response headers for the built-in
 * provider domains (api.anthropic.com, api.z.ai, ...). Custom providers can point
 * at arbitrary domains, so we register one dynamic declarativeNetRequest rule per
 * custom-provider host to apply the same permissive CORS headers. Without this the
 * browser blocks the cross-origin API responses from the side panel.
 *
 * Rules are reconciled idempotently: every call removes the previously managed
 * rules (ids in [RULE_ID_BASE, RULE_ID_MAX]) and re-adds the current set, so
 * saving/deleting a provider or reloading the extension always converges.
 */

import { getSitegeistStorage } from "../storage/app-storage.js";

const RULE_ID_BASE = 2000;
const RULE_ID_MAX = 2999;

const CORS_RESPONSE_HEADERS = [
	{ header: "Access-Control-Allow-Origin", operation: "set", value: "*" },
	{ header: "Access-Control-Allow-Methods", operation: "set", value: "GET, POST, OPTIONS" },
	{ header: "Access-Control-Allow-Headers", operation: "set", value: "*" },
	{ header: "Access-Control-Max-Age", operation: "set", value: "86400" },
];

/** Extract the hostname from a base URL, tolerating bare hosts like "api.example.com/v1". */
function hostnameFromUrl(url: string): string | null {
	const trimmed = url.trim();
	if (!trimmed) return null;
	try {
		return new URL(trimmed).hostname || null;
	} catch {
		const cleaned = trimmed
			.replace(/^[a-z]+:\/\//i, "")
			.split("/")[0]
			.split("?")[0]
			.trim();
		return cleaned || null;
	}
}

/**
 * Reconcile dynamic CORS rules so every configured custom-provider host has one.
 * Safe to call repeatedly (on save, on delete, and on startup).
 */
export async function syncCustomProviderCorsRules(): Promise<void> {
	const dnr = (globalThis as typeof globalThis & { chrome?: typeof chrome }).chrome?.declarativeNetRequest;
	if (!dnr?.updateDynamicRules) return;

	const storage = getSitegeistStorage();
	const providers = await storage.customProviders.getAll();

	const hostnames = new Set<string>();
	for (const provider of providers) {
		const host = hostnameFromUrl(provider.baseUrl);
		if (host) hostnames.add(host);
	}

	const addRules: unknown[] = [];
	let id = RULE_ID_BASE;
	for (const host of hostnames) {
		if (id > RULE_ID_MAX) {
			console.warn(`Too many custom-provider CORS rules; skipping host ${host}`);
			break;
		}
		addRules.push({
			id: id++,
			priority: 1,
			action: { type: "modifyHeaders", responseHeaders: CORS_RESPONSE_HEADERS },
			condition: { urlFilter: `||${host}`, resourceTypes: ["xmlhttprequest", "other"] },
		});
	}

	const existing = await dnr.getDynamicRules();
	const removeRuleIds = existing
		.filter((rule) => rule.id >= RULE_ID_BASE && rule.id <= RULE_ID_MAX)
		.map((rule) => rule.id);

	await dnr.updateDynamicRules({
		removeRuleIds,
		addRules: addRules as chrome.declarativeNetRequest.Rule[],
	});
}
