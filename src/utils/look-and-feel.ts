import { getAppStorage } from "@mariozechner/pi-web-ui";
import { applyTheme, DEFAULT_THEME_ID, getThemeById } from "../themes/index.js";

export const UI_ZOOM_KEY = "ui.zoom";
export const THEME_KEY = "ui.themePreset";
export const DEFAULT_UI_ZOOM = 1;
export const MIN_UI_ZOOM = 0.85;
export const MAX_UI_ZOOM = 1.5;
export const UI_ZOOM_STEP = 0.05;

export function clampUiZoom(value: number): number {
	return Math.min(MAX_UI_ZOOM, Math.max(MIN_UI_ZOOM, value));
}

export function applyUiZoom(value: number): number {
	const clamped = clampUiZoom(value);
	document.documentElement.style.setProperty("--ui-zoom", clamped.toFixed(2));
	return clamped;
}

export async function loadLookAndFeelSettings() {
	const storage = getAppStorage();
	const storedTheme = await storage.settings.get<string>(THEME_KEY);
	const storedZoom = await storage.settings.get<number>(UI_ZOOM_KEY);

	const themeId = getThemeById(storedTheme || "") ? (storedTheme as string) : DEFAULT_THEME_ID;
	const zoom = applyUiZoom(storedZoom ?? DEFAULT_UI_ZOOM);
	applyTheme(themeId);

	return { themeId, zoom };
}

export async function persistTheme(themeId: string) {
	const storage = getAppStorage();
	const nextTheme = getThemeById(themeId) ? themeId : DEFAULT_THEME_ID;
	applyTheme(nextTheme);
	await storage.settings.set(THEME_KEY, nextTheme);
	return nextTheme;
}

export async function persistUiZoom(value: number) {
	const storage = getAppStorage();
	const clamped = applyUiZoom(value);
	await storage.settings.set(UI_ZOOM_KEY, clamped);
	return clamped;
}
