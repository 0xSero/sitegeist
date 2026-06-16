import { i18n } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Checkbox } from "@mariozechner/mini-lit/dist/Checkbox.js";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { Label } from "@mariozechner/mini-lit/dist/Label.js";
import { Select } from "@mariozechner/mini-lit/dist/Select.js";
import { getProviders, type Model } from "@mariozechner/pi-ai";
import type { CustomProvider, CustomProviderType } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { state } from "lit/decorators.js";
import { Toast } from "../components/Toast.js";
import { getSitegeistStorage } from "../storage/app-storage.js";
import { syncCustomProviderCorsRules } from "../utils/custom-provider-cors.js";

/** Manual (model-list) custom provider types supported by the editor. */
const MANUAL_TYPES: { value: CustomProviderType; label: string }[] = [
	{ value: "openai-completions", label: "OpenAI Compatible (Chat Completions)" },
	{ value: "openai-responses", label: "OpenAI Compatible (Responses)" },
	{ value: "anthropic-messages", label: "Anthropic Compatible (Messages)" },
];

const BASE_URL_PLACEHOLDER: Record<string, string> = {
	"openai-completions": "https://api.example.com/v1",
	"openai-responses": "https://api.example.com/v1",
	"anthropic-messages": "https://api.example.com",
};

interface ModelRow {
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	vision: boolean;
}

function emptyModelRow(): ModelRow {
	return { id: "", name: "", contextWindow: 128000, maxTokens: 8192, reasoning: false, vision: false };
}

function modelToRow(model: Model<any>): ModelRow {
	return {
		id: model.id,
		name: model.name ?? model.id,
		contextWindow: model.contextWindow ?? 128000,
		maxTokens: model.maxTokens ?? 8192,
		reasoning: !!model.reasoning,
		vision: Array.isArray(model.input) && model.input.includes("image"),
	};
}

/**
 * Add/edit dialog for custom (BYO base URL + key) providers.
 *
 * Unlike the upstream CustomProviderDialog, this one lets you define the model
 * list for manual provider types, which is what makes OpenAI-/Anthropic-compatible
 * endpoints actually usable. On save the provider's API key is mirrored into the
 * provider-keys store (keyed by provider name) so the existing model selector,
 * send gate, and API-key resolution all pick it up unchanged.
 */
export class CustomProviderEditDialog extends DialogBase {
	private provider?: CustomProvider;
	private onSaveCallback?: () => void;

	@state() private name = "";
	@state() private type: CustomProviderType = "openai-completions";
	@state() private baseUrl = "";
	@state() private apiKey = "";
	@state() private models: ModelRow[] = [emptyModelRow()];

	protected override modalWidth = "min(720px, 92vw)";
	protected override modalHeight = "min(760px, 92vh)";

	static open(provider: CustomProvider | undefined, onSave?: () => void) {
		const dialog = new CustomProviderEditDialog();
		dialog.provider = provider;
		dialog.onSaveCallback = onSave;
		document.body.appendChild(dialog);
		dialog.initializeFromProvider();
		dialog.open();
		dialog.requestUpdate();
	}

	private initializeFromProvider() {
		if (this.provider) {
			this.name = this.provider.name;
			this.type = this.provider.type;
			this.baseUrl = this.provider.baseUrl;
			this.apiKey = this.provider.apiKey ?? "";
			const rows = (this.provider.models ?? []).map(modelToRow);
			this.models = rows.length > 0 ? rows : [emptyModelRow()];
		} else {
			this.name = "";
			this.type = "openai-completions";
			this.baseUrl = "";
			this.apiKey = "";
			this.models = [emptyModelRow()];
		}
	}

	private validate(): string | null {
		const name = this.name.trim();
		if (!name) return i18n("Please enter a provider name");
		if (!this.baseUrl.trim()) return i18n("Please enter a base URL");

		// Don't shadow a built-in provider (would clobber its stored key/credentials).
		const builtIn = getProviders().map((p) => String(p).toLowerCase());
		if (builtIn.includes(name.toLowerCase())) {
			return i18n("That name is reserved by a built-in provider. Choose a different name.");
		}

		const definedModels = this.models.filter((m) => m.id.trim());
		if (definedModels.length === 0) return i18n("Add at least one model");

		const ids = definedModels.map((m) => m.id.trim());
		if (new Set(ids).size !== ids.length) return i18n("Model IDs must be unique");

		return null;
	}

	private async save() {
		const error = this.validate();
		if (error) {
			Toast.error(error);
			return;
		}

		const name = this.name.trim();
		const baseUrl = this.baseUrl.trim();
		const apiKey = this.apiKey.trim();

		const models: Model<any>[] = this.models
			.filter((m) => m.id.trim())
			.map((m) => ({
				id: m.id.trim(),
				name: m.name.trim() || m.id.trim(),
				api: this.type as Model<any>["api"],
				provider: name,
				baseUrl,
				reasoning: m.reasoning,
				input: (m.vision ? ["text", "image"] : ["text"]) as ("text" | "image")[],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: Number(m.contextWindow) || 128000,
				maxTokens: Number(m.maxTokens) || 8192,
			}));

		try {
			const storage = getSitegeistStorage();

			// Reject a name already used by a *different* custom provider.
			const existing = await storage.customProviders.getAll();
			const clash = existing.find((p) => p.name === name && p.id !== this.provider?.id);
			if (clash) {
				Toast.error(i18n("A custom provider with that name already exists"));
				return;
			}

			const record: CustomProvider = {
				id: this.provider?.id ?? crypto.randomUUID(),
				name,
				type: this.type,
				baseUrl,
				apiKey: apiKey || undefined,
				models,
			};

			await storage.customProviders.set(record);

			// Mirror the key into the provider-keys store (keyed by provider name) so the
			// model selector, send gate, and getApiKey resolution treat it like any other
			// configured provider. Use a placeholder for keyless endpoints so the gate passes.
			await storage.providerKeys.set(name, apiKey || "-");

			// Clean up the old key entry if the provider was renamed.
			if (this.provider && this.provider.name !== name) {
				await storage.providerKeys.delete(this.provider.name);
			}

			await syncCustomProviderCorsRules();

			Toast.success(i18n("Provider saved"));
			this.onSaveCallback?.();
			this.close();
		} catch (err) {
			console.error("Failed to save custom provider:", err);
			Toast.error(i18n("Failed to save provider"));
		}
	}

	private updateModel(index: number, patch: Partial<ModelRow>) {
		this.models = this.models.map((m, i) => (i === index ? { ...m, ...patch } : m));
	}

	private addModelRow() {
		this.models = [...this.models, emptyModelRow()];
	}

	private removeModelRow(index: number) {
		const next = this.models.filter((_, i) => i !== index);
		this.models = next.length > 0 ? next : [emptyModelRow()];
	}

	private renderModelRow(model: ModelRow, index: number): TemplateResult {
		return html`
			<div class="border border-border rounded-lg p-3 flex flex-col gap-3 bg-card">
				<div class="flex items-end gap-2">
					<div class="flex-1 flex flex-col gap-1">
						${Label({ children: i18n("Model ID") })}
						${Input({
							value: model.id,
							placeholder: "e.g. gpt-4o-mini",
							onInput: (e: Event) => this.updateModel(index, { id: (e.target as HTMLInputElement).value }),
						})}
					</div>
					<div class="flex-1 flex flex-col gap-1">
						${Label({ children: i18n("Display Name (optional)") })}
						${Input({
							value: model.name,
							placeholder: model.id || i18n("Defaults to model ID"),
							onInput: (e: Event) => this.updateModel(index, { name: (e.target as HTMLInputElement).value }),
						})}
					</div>
					${Button({
						variant: "ghost",
						size: "sm",
						onClick: () => this.removeModelRow(index),
						children: i18n("Remove"),
					})}
				</div>
				<div class="flex flex-wrap items-end gap-4">
					<div class="flex flex-col gap-1 w-36">
						${Label({ children: i18n("Context window") })}
						${Input({
							type: "number",
							value: String(model.contextWindow),
							onInput: (e: Event) =>
								this.updateModel(index, { contextWindow: Number((e.target as HTMLInputElement).value) }),
						})}
					</div>
					<div class="flex flex-col gap-1 w-36">
						${Label({ children: i18n("Max output tokens") })}
						${Input({
							type: "number",
							value: String(model.maxTokens),
							onInput: (e: Event) =>
								this.updateModel(index, { maxTokens: Number((e.target as HTMLInputElement).value) }),
						})}
					</div>
					<label class="flex items-center gap-2 text-sm text-foreground cursor-pointer">
						${Checkbox({
							checked: model.reasoning,
							onChange: (checked: boolean) => this.updateModel(index, { reasoning: checked }),
						})}
						${i18n("Reasoning")}
					</label>
					<label class="flex items-center gap-2 text-sm text-foreground cursor-pointer">
						${Checkbox({
							checked: model.vision,
							onChange: (checked: boolean) => this.updateModel(index, { vision: checked }),
						})}
						${i18n("Vision")}
					</label>
				</div>
			</div>
		`;
	}

	protected override renderContent(): TemplateResult {
		return html`
			<div class="flex flex-col h-full overflow-hidden">
				<div class="p-6 flex-shrink-0 border-b border-border">
					<h2 class="text-lg font-semibold text-foreground">
						${this.provider ? i18n("Edit Custom Provider") : i18n("Add Custom Provider")}
					</h2>
				</div>

				<div class="flex-1 overflow-y-auto p-6">
					<div class="flex flex-col gap-4">
						<div class="flex flex-col gap-2">
							${Label({ children: i18n("Provider Name") })}
							${Input({
								value: this.name,
								placeholder: i18n("e.g. OpenRouter, Together, My Server"),
								onInput: (e: Event) => {
									this.name = (e.target as HTMLInputElement).value;
									this.requestUpdate();
								},
							})}
						</div>

						<div class="flex flex-col gap-2">
							${Label({ children: i18n("API Type") })}
							${Select({
								value: this.type,
								options: MANUAL_TYPES.map((t) => ({ value: t.value, label: t.label })),
								onChange: (value: string) => {
									this.type = value as CustomProviderType;
									this.requestUpdate();
								},
								width: "100%",
							})}
						</div>

						<div class="flex flex-col gap-2">
							${Label({ children: i18n("Base URL") })}
							${Input({
								value: this.baseUrl,
								placeholder: BASE_URL_PLACEHOLDER[this.type] ?? "https://api.example.com/v1",
								onInput: (e: Event) => {
									this.baseUrl = (e.target as HTMLInputElement).value;
									this.requestUpdate();
								},
							})}
							<p class="text-xs text-muted-foreground">
								${
									this.type === "anthropic-messages"
										? i18n("Root URL — the client appends /v1/messages.")
										: i18n("OpenAI-compatible base — usually ends in /v1.")
								}
							</p>
						</div>

						<div class="flex flex-col gap-2">
							${Label({ children: i18n("API Key (optional)") })}
							${Input({
								type: "password",
								value: this.apiKey,
								placeholder: i18n("Leave empty if the endpoint needs no key"),
								onInput: (e: Event) => {
									this.apiKey = (e.target as HTMLInputElement).value;
									this.requestUpdate();
								},
							})}
						</div>

						<div class="flex flex-col gap-3 mt-2">
							<div class="flex items-center justify-between">
								<h3 class="text-sm font-semibold text-foreground">${i18n("Models")}</h3>
								${Button({
									variant: "outline",
									size: "sm",
									onClick: () => this.addModelRow(),
									children: i18n("Add Model"),
								})}
							</div>
							${this.models.map((model, index) => this.renderModelRow(model, index))}
						</div>
					</div>
				</div>

				<div class="p-6 flex-shrink-0 border-t border-border flex justify-end gap-2">
					${Button({ variant: "ghost", onClick: () => this.close(), children: i18n("Cancel") })}
					${Button({ variant: "default", onClick: () => this.save(), children: i18n("Save") })}
				</div>
			</div>
		`;
	}
}

if (!customElements.get("custom-provider-edit-dialog")) {
	customElements.define("custom-provider-edit-dialog", CustomProviderEditDialog);
}
