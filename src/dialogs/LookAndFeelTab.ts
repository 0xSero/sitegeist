import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Select } from "@mariozechner/mini-lit/dist/Select.js";
import { getAppStorage, SettingsTab } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { Minus, Plus, RotateCcw } from "lucide";
import { DEFAULT_THEME_ID, getThemeById, THEMES } from "../themes/index.js";
import {
	clampUiZoom,
	DEFAULT_UI_ZOOM,
	persistTheme,
	persistUiZoom,
	THEME_KEY,
	UI_ZOOM_KEY,
	UI_ZOOM_STEP,
} from "../utils/look-and-feel.js";

export class LookAndFeelTab extends SettingsTab {
	private themeId = DEFAULT_THEME_ID;
	private uiZoom = DEFAULT_UI_ZOOM;

	getTabName(): string {
		return "Look & Feel";
	}

	override async connectedCallback() {
		super.connectedCallback();
		const storage = getAppStorage();
		const storedTheme = await storage.settings.get<string>(THEME_KEY);
		const storedZoom = await storage.settings.get<number>(UI_ZOOM_KEY);
		this.themeId = getThemeById(storedTheme || "") ? (storedTheme as string) : DEFAULT_THEME_ID;
		this.uiZoom = clampUiZoom(storedZoom ?? DEFAULT_UI_ZOOM);
		this.requestUpdate();
	}

	private async setTheme(nextThemeId: string) {
		this.themeId = await persistTheme(nextThemeId);
		this.requestUpdate();
	}

	private async setZoom(nextZoom: number) {
		this.uiZoom = await persistUiZoom(nextZoom);
		this.requestUpdate();
	}

	private async adjustZoom(delta: number) {
		await this.setZoom(this.uiZoom + delta);
	}

	private async resetLookAndFeel() {
		this.themeId = await persistTheme(DEFAULT_THEME_ID);
		this.uiZoom = await persistUiZoom(DEFAULT_UI_ZOOM);
		this.requestUpdate();
	}

	protected renderContent(): TemplateResult {
		return this.render();
	}

	render(): TemplateResult {
		const activeTheme = getThemeById(this.themeId) || THEMES[0];

		return html`
			<div class="flex flex-col gap-6">
				<div class="space-y-2">
					<h3 class="text-sm font-semibold text-foreground">Theme</h3>
					<p class="text-sm text-muted-foreground">
						Choose from the full Parchi theme catalog. Applied immediately and stored locally.
					</p>
				</div>

				<div class="rounded-lg border border-border bg-card p-4 space-y-4">
					${Select({
						value: this.themeId,
						options: THEMES.map((theme) => ({
							label: theme.name,
							value: theme.id,
						})),
						onChange: (value) => this.setTheme(value),
					})}

					<div class="rounded-lg border border-border bg-background px-4 py-3">
						<div class="flex items-center justify-between gap-3">
							<div class="flex items-center gap-3">
								<span
									class="inline-flex h-3 w-3 rounded-full border"
									style="background:${activeTheme.preview.bg}; border-color:${activeTheme.preview.accent};"
								></span>
								<div>
									<div class="text-sm font-medium text-foreground">${activeTheme.name}</div>
									<div class="text-xs text-muted-foreground">${THEMES.length} themes available</div>
								</div>
							</div>
							<div class="flex items-center gap-2">
								<span class="h-4 w-4 rounded-sm border border-border" style="background:${activeTheme.preview.bg};"></span>
								<span class="h-4 w-4 rounded-sm border border-border" style="background:${activeTheme.preview.card};"></span>
								<span class="h-4 w-4 rounded-sm border border-border" style="background:${activeTheme.preview.accent};"></span>
							</div>
						</div>
					</div>
				</div>

				<div class="space-y-2">
					<h3 class="text-sm font-semibold text-foreground">Zoom</h3>
					<p class="text-sm text-muted-foreground">
						Adjust the full panel density without changing your browser zoom.
					</p>
				</div>

				<div class="rounded-lg border border-border bg-card p-4 space-y-4">
					<div class="flex items-center justify-between gap-4">
						<div>
							<div class="text-sm font-medium text-foreground">UI zoom</div>
							<div class="text-xs text-muted-foreground">${Math.round(this.uiZoom * 100)}%</div>
						</div>
						<div class="flex items-center gap-2">
							${Button({
								variant: "outline",
								size: "sm",
								children: html`<span class="inline-flex items-center gap-1">${icon(Minus, "sm")} Out</span>`,
								onClick: () => this.adjustZoom(-UI_ZOOM_STEP),
							})}
							${Button({
								variant: "outline",
								size: "sm",
								children: html`<span class="inline-flex items-center gap-1">${icon(RotateCcw, "sm")} Reset</span>`,
								onClick: () => this.setZoom(DEFAULT_UI_ZOOM),
							})}
							${Button({
								variant: "default",
								size: "sm",
								children: html`<span class="inline-flex items-center gap-1">${icon(Plus, "sm")} In</span>`,
								onClick: () => this.adjustZoom(UI_ZOOM_STEP),
							})}
						</div>
					</div>

					<input
						type="range"
						min="0.85"
						max="1.5"
						step="0.05"
						.value=${this.uiZoom.toFixed(2)}
						@input=${(e: Event) => this.setZoom(Number((e.target as HTMLInputElement).value))}
						class="w-full"
					/>
				</div>

				<div class="flex justify-end">
					${Button({
						variant: "outline",
						size: "sm",
						onClick: () => this.resetLookAndFeel(),
						children: "Reset Look & Feel",
					})}
				</div>
			</div>
		`;
	}
}
