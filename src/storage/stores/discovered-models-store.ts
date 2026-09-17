import type { Model } from "@mariozechner/pi-ai";
import { Store, type StoreConfig } from "@mariozechner/pi-web-ui";

export interface DiscoveredProviderEntry {
	provider: string;
	fetchedAt: number;
	models: Model<any>[];
	/** Last error, kept so the UI can explain why the static list is in use. */
	error?: string;
}

/**
 * Cache of models discovered from providers at runtime, one entry per provider,
 * plus the models.dev metadata blob under a reserved key.
 */
export class DiscoveredModelsStore extends Store {
	static readonly METADATA_KEY = "__models_dev";

	getConfig(): StoreConfig {
		return { name: "discovered-models" };
	}

	async get(provider: string): Promise<DiscoveredProviderEntry | null> {
		return this.getBackend().get<DiscoveredProviderEntry>("discovered-models", provider);
	}

	async set(entry: DiscoveredProviderEntry): Promise<void> {
		await this.getBackend().set("discovered-models", entry.provider, entry);
	}

	async delete(provider: string): Promise<void> {
		await this.getBackend().delete("discovered-models", provider);
	}

	async listProviders(): Promise<string[]> {
		const keys = await this.getBackend().keys("discovered-models");
		return keys.filter((k) => k !== DiscoveredModelsStore.METADATA_KEY);
	}

	async getMetadata<T>(): Promise<{ fetchedAt: number; data: T } | null> {
		return this.getBackend().get<{ fetchedAt: number; data: T }>(
			"discovered-models",
			DiscoveredModelsStore.METADATA_KEY,
		);
	}

	async setMetadata<T>(data: T): Promise<void> {
		await this.getBackend().set("discovered-models", DiscoveredModelsStore.METADATA_KEY, {
			fetchedAt: Date.now(),
			data,
		});
	}
}
