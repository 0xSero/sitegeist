/**
 * Keeps pi-ai's model registry in sync with what providers actually offer.
 *
 * For every provider the user has a credential for and that has a list endpoint,
 * the discovered ids are authoritative. Each id gets metadata from, in order: the
 * provider's own response, the generated table entry with the same id, models.dev,
 * then conservative defaults. Results are cached in IndexedDB and re-registered on
 * startup, so the selector never waits on the network.
 */

import { type Api, getGeneratedModels, type Model, registerModels, resetProviderModels } from "@mariozechner/pi-ai";
import { isOAuthCredentials, parseOAuthCredentials, resolveApiKey } from "../oauth/index.js";
import type { SitegeistAppStorage } from "../storage/app-storage.js";
import { canDiscover, type DiscoveredModel, discoverProviderModels } from "./discovery.js";

const STALE_MS = 60 * 60 * 1000;
const METADATA_STALE_MS = 24 * 60 * 60 * 1000;
const MODELS_DEV_URL = "https://models.dev/api.json";

interface ModelsDevModel {
	name?: string;
	reasoning?: boolean;
	tool_call?: boolean;
	modalities?: { input?: string[] };
	cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
	limit?: { context?: number; output?: number };
}

type ModelsDevData = Record<string, { models?: Record<string, ModelsDevModel> }>;

/** models.dev uses slightly different provider keys for a few providers. */
const MODELS_DEV_KEYS: Record<string, string[]> = {
	"openai-codex": ["openai"],
	"github-copilot": ["github-copilot"],
	huggingface: ["huggingface"],
};

let metadataCache: ModelsDevData | undefined;
const inFlight = new Map<string, Promise<void>>();

async function loadMetadata(storage: SitegeistAppStorage): Promise<ModelsDevData | undefined> {
	if (metadataCache) return metadataCache;
	const cached = await storage.discoveredModels.getMetadata<ModelsDevData>();
	if (cached && Date.now() - cached.fetchedAt < METADATA_STALE_MS) {
		metadataCache = cached.data;
		return metadataCache;
	}
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 8000);
		const response = await fetch(MODELS_DEV_URL, { signal: controller.signal });
		clearTimeout(timer);
		if (!response.ok) throw new Error(`${response.status}`);
		const data = (await response.json()) as ModelsDevData;
		metadataCache = data;
		await storage.discoveredModels.setMetadata(data);
		return data;
	} catch (err) {
		console.warn("[models] models.dev unavailable:", err);
		if (cached) {
			metadataCache = cached.data;
			return metadataCache;
		}
		return undefined;
	}
}

function findMetadata(data: ModelsDevData | undefined, provider: string, id: string): ModelsDevModel | undefined {
	if (!data) return undefined;
	const keys = [provider, ...(MODELS_DEV_KEYS[provider] ?? [])];
	for (const key of keys) {
		const hit = data[key]?.models?.[id];
		if (hit) return hit;
	}
	// Ids like "openai/gpt-5" (routers) or provider-prefixed ids: try the bare tail.
	const tail = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : undefined;
	for (const entry of Object.values(data)) {
		const hit = entry.models?.[id] ?? (tail ? entry.models?.[tail] : undefined);
		if (hit) return hit;
	}
	return undefined;
}

function merge(
	provider: string,
	discovered: DiscoveredModel,
	generated: Model<Api> | undefined,
	meta: ModelsDevModel | undefined,
): Model<Api> {
	const inputFromMeta = meta?.modalities?.input?.includes("image") ? (["text", "image"] as const) : undefined;
	const input = discovered.input ?? generated?.input ?? (inputFromMeta ? [...inputFromMeta] : ["text"]);
	const cost =
		discovered.cost ??
		generated?.cost ??
		(meta?.cost
			? {
					input: meta.cost.input ?? 0,
					output: meta.cost.output ?? 0,
					cacheRead: meta.cost.cache_read ?? 0,
					cacheWrite: meta.cost.cache_write ?? 0,
				}
			: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	const model: Model<Api> = {
		id: discovered.id,
		name: discovered.name ?? generated?.name ?? meta?.name ?? discovered.id,
		api: generated?.api ?? discovered.api,
		provider,
		baseUrl: generated?.baseUrl ?? discovered.baseUrl,
		reasoning: discovered.reasoning ?? generated?.reasoning ?? meta?.reasoning ?? false,
		input: input as ("text" | "image")[],
		cost,
		contextWindow: discovered.contextWindow ?? generated?.contextWindow ?? meta?.limit?.context ?? 128000,
		maxTokens: discovered.maxTokens ?? generated?.maxTokens ?? meta?.limit?.output ?? 8192,
	};
	const headers = generated?.headers ?? discovered.headers;
	if (headers) model.headers = headers;
	if (generated?.compat) (model as Model<Api> & { compat?: unknown }).compat = generated.compat;
	return model;
}

async function credentialFor(storage: SitegeistAppStorage, provider: string) {
	const stored = await storage.providerKeys.get(provider);
	if (!stored) return undefined;
	const token = await resolveApiKey(stored, provider, storage.providerKeys);
	const accountId = isOAuthCredentials(stored) ? parseOAuthCredentials(stored).accountId : undefined;
	return { token, accountId };
}

/** Register the cached discovery result for a provider, if any. */
export async function applyCachedModels(storage: SitegeistAppStorage, provider: string): Promise<boolean> {
	const entry = await storage.discoveredModels.get(provider);
	if (!entry || entry.models.length === 0) return false;
	registerModels(provider, entry.models);
	return true;
}

/**
 * Discover models for one provider and register them. Errors are recorded on the
 * cache entry and the generated table stays in effect.
 */
export async function refreshProviderModels(storage: SitegeistAppStorage, provider: string): Promise<void> {
	if (!canDiscover(provider)) return;
	const existing = inFlight.get(provider);
	if (existing) return existing;
	const task = (async () => {
		const credential = await credentialFor(storage, provider);
		if (!credential) {
			resetProviderModels(provider);
			await storage.discoveredModels.delete(provider);
			return;
		}
		try {
			const [discovered, meta] = await Promise.all([
				discoverProviderModels(provider, credential),
				loadMetadata(storage),
			]);
			if (discovered.length === 0) throw new Error("provider returned no models");
			const generated = new Map(getGeneratedModels(provider).map((m) => [m.id, m]));
			const models = discovered.map((d) =>
				merge(provider, d, generated.get(d.id), findMetadata(meta, provider, d.id)),
			);
			models.sort((a, b) => a.id.localeCompare(b.id));
			registerModels(provider, models);
			await storage.discoveredModels.set({ provider, fetchedAt: Date.now(), models });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.warn(`[models] discovery failed for ${provider}: ${message}`);
			const cached = await storage.discoveredModels.get(provider);
			if (cached && cached.models.length > 0) {
				registerModels(provider, cached.models);
				await storage.discoveredModels.set({ ...cached, error: message });
			} else {
				resetProviderModels(provider);
				await storage.discoveredModels.set({ provider, fetchedAt: Date.now(), models: [], error: message });
			}
		}
	})().finally(() => inFlight.delete(provider));
	inFlight.set(provider, task);
	return task;
}

/**
 * Bring every configured provider up to date: cached lists register immediately,
 * stale ones refresh in the background (or are awaited when `wait` is set).
 */
export async function refreshDiscoveredModels(
	storage: SitegeistAppStorage,
	options: { wait?: boolean; force?: boolean; timeoutMs?: number } = {},
): Promise<void> {
	const providers = (await storage.providerKeys.list()).filter(canDiscover);
	const pending: Promise<void>[] = [];
	for (const provider of providers) {
		const entry = await storage.discoveredModels.get(provider);
		const fresh = entry && Date.now() - entry.fetchedAt < STALE_MS && entry.models.length > 0;
		if (entry && entry.models.length > 0) registerModels(provider, entry.models);
		if (!fresh || options.force) pending.push(refreshProviderModels(storage, provider));
	}
	if (!options.wait) return;
	const timeout = new Promise<void>((resolve) => setTimeout(resolve, options.timeoutMs ?? 5000));
	await Promise.race([Promise.allSettled(pending).then(() => undefined), timeout]);
}

/** Human-readable state for settings UI. */
export async function discoveryStatus(storage: SitegeistAppStorage, provider: string): Promise<string> {
	if (!canDiscover(provider)) return "static list";
	const entry = await storage.discoveredModels.get(provider);
	if (!entry) return "not fetched yet";
	if (entry.models.length === 0) return `discovery failed: ${entry.error ?? "unknown error"}`;
	const age = Math.round((Date.now() - entry.fetchedAt) / 60000);
	return `${entry.models.length} models, fetched ${age} min ago${entry.error ? ` (last refresh failed: ${entry.error})` : ""}`;
}
