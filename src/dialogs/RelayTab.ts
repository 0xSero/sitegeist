import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { SettingsTab } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";

const RELAY_ENABLED_KEY = "relayEnabled";
const RELAY_URL_KEY = "relayUrl";
const RELAY_TOKEN_KEY = "relayToken";

export class RelayTab extends SettingsTab {
	private relayEnabled = false;
	private relayUrl = "http://127.0.0.1:17373";
	private relayToken = "";
	private relayConnected = false;
	private relayLastError = "";

	getTabName(): string {
		return "Relay";
	}

	override async connectedCallback() {
		super.connectedCallback();
		await this.load();
	}

	private async load() {
		const storage = await chrome.storage.local.get([
			RELAY_ENABLED_KEY,
			RELAY_URL_KEY,
			RELAY_TOKEN_KEY,
			"relayConnected",
			"relayLastError",
		]);
		this.relayEnabled = storage[RELAY_ENABLED_KEY] === true || storage[RELAY_ENABLED_KEY] === "true";
		this.relayUrl =
			typeof storage[RELAY_URL_KEY] === "string" && storage[RELAY_URL_KEY] ? storage[RELAY_URL_KEY] : this.relayUrl;
		this.relayToken = typeof storage[RELAY_TOKEN_KEY] === "string" ? storage[RELAY_TOKEN_KEY] : "";
		this.relayConnected = storage.relayConnected === true;
		this.relayLastError = typeof storage.relayLastError === "string" ? storage.relayLastError : "";
		this.requestUpdate();
	}

	private async save() {
		await chrome.storage.local.set({
			[RELAY_ENABLED_KEY]: this.relayEnabled,
			[RELAY_URL_KEY]: this.relayUrl.trim(),
			[RELAY_TOKEN_KEY]: this.relayToken.trim(),
		});
		await chrome.runtime.sendMessage({ type: "relay_reconfigure" });
		await this.load();
	}

	protected renderContent(): TemplateResult {
		return this.render();
	}

	render(): TemplateResult {
		return html`
			<div class="flex flex-col gap-6">
				<div class="space-y-2">
					<h3 class="text-sm font-semibold text-foreground">Local relay daemon</h3>
					<p class="text-sm text-muted-foreground">
						Connect Sitegeist to the local relay daemon for CLI, remote tool calls, and Electron-agent routing.
					</p>
				</div>

				<label class="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3">
					<div>
						<div class="text-sm font-medium text-foreground">Enable relay</div>
						<div class="text-xs text-muted-foreground">Requires a running local daemon and token.</div>
					</div>
					<input
						type="checkbox"
						.checked=${this.relayEnabled}
						@change=${(e: Event) => {
							this.relayEnabled = (e.target as HTMLInputElement).checked;
							void this.save();
						}}
					/>
				</label>

				<div class="space-y-3">
					<label class="block space-y-1">
						<div class="text-sm font-medium text-foreground">Relay URL</div>
						<input
							class="w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground"
							.value=${this.relayUrl}
							@input=${(e: Event) => {
								this.relayUrl = (e.target as HTMLInputElement).value;
							}}
						/>
					</label>
					<label class="block space-y-1">
						<div class="text-sm font-medium text-foreground">Relay token</div>
						<input
							class="w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground"
							type="password"
							.value=${this.relayToken}
							@input=${(e: Event) => {
								this.relayToken = (e.target as HTMLInputElement).value;
							}}
						/>
					</label>
				</div>

				<div class="rounded-lg border border-border bg-card px-4 py-3 text-sm">
					<div class="font-medium ${this.relayConnected ? "text-green-600 dark:text-green-400" : "text-muted-foreground"}">
						${this.relayConnected ? "Connected" : "Disconnected"}
					</div>
					${this.relayLastError ? html`<div class="mt-1 text-xs text-destructive">${this.relayLastError}</div>` : ""}
				</div>

				<div class="flex justify-end">
					${Button({
						variant: "default",
						size: "sm",
						onClick: () => this.save(),
						children: "Save relay settings",
					})}
				</div>
			</div>
		`;
	}
}
