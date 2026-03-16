import { getModel, getModels, type Model } from "@mariozechner/pi-ai";
import type { SitegeistAppStorage } from "../storage/app-storage.js";

export const DEFAULT_MODELS: Record<string, string> = {
	"amazon-bedrock": "us.anthropic.claude-opus-4-6-v1",
	anthropic: "claude-sonnet-4-6",
	"azure-openai-responses": "gpt-5.2",
	cerebras: "zai-glm-4.6",
	"github-copilot": "gpt-4o",
	google: "gemini-2.5-flash",
	"google-antigravity": "gemini-3.1-pro-high",
	"google-gemini-cli": "gemini-2.5-pro",
	"google-vertex": "gemini-3-pro-preview",
	groq: "openai/gpt-oss-20b",
	huggingface: "moonshotai/Kimi-K2.5",
	"kimi-coding": "kimi-k2-thinking",
	minimax: "MiniMax-M2.1",
	"minimax-cn": "MiniMax-M2.1",
	mistral: "devstral-medium-latest",
	openai: "gpt-4o-mini",
	"openai-codex": "gpt-5.1-codex-mini",
	opencode: "claude-opus-4-6",
	"opencode-go": "kimi-k2.5",
	openrouter: "openai/gpt-5.1-codex",
	"vercel-ai-gateway": "anthropic/claude-opus-4-6",
	xai: "grok-4-fast-non-reasoning",
	zai: "glm-4.6",
};

export async function getProvidersWithKeys(storage: SitegeistAppStorage): Promise<string[]> {
	const providers = await storage.providerKeys.list();
	const result: string[] = [];
	for (const provider of providers) {
		const key = await storage.providerKeys.get(provider);
		if (key) result.push(provider);
	}
	return result;
}

export async function resolveDefaultModel(
	storage: SitegeistAppStorage,
	initialModel?: Model<any>,
): Promise<Model<any> | undefined> {
	if (initialModel) return undefined;

	const savedModel = await storage.settings.get<Model<any>>("lastUsedModel");
	if (savedModel) {
		return savedModel;
	}

	const providersWithKeys = await getProvidersWithKeys(storage);
	for (const provider of providersWithKeys) {
		const modelId = DEFAULT_MODELS[provider];
		if (!modelId) continue;
		const model = getModel(provider as any, modelId);
		if (model) return model;
	}

	for (const provider of providersWithKeys) {
		const models = getModels(provider as any);
		if (models.length > 0) return models[0];
	}

	return getModel("anthropic", "claude-sonnet-4-6");
}
