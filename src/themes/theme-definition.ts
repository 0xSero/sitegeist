export interface ThemeDefinition {
	id: string;
	name: string;
	preview: { bg: string; accent: string; card: string };
	vars: Record<string, string>;
}
