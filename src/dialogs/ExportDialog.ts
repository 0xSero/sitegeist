import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import { html, type TemplateResult } from "lit";
import {
	buildExportPayload,
	buildMarkdownExport,
	downloadExport,
	type ExportFormat,
	type ExportScope,
} from "../utils/session-export.js";

type ExportContext = {
	messages: any[];
	title: string;
	sessionId?: string;
};

export class ExportDialog extends DialogBase {
	private context: ExportContext | null = null;

	protected modalWidth = "min(520px, 92vw)";

	static open(context: ExportContext) {
		const dialog = new ExportDialog();
		dialog.context = context;
		document.body.appendChild(dialog);
		dialog.open();
	}

	private doExport(scope: ExportScope, format: ExportFormat) {
		if (!this.context) return;
		const slug = this.context.title
			? this.context.title
					.replace(/[^a-z0-9]+/gi, "-")
					.replace(/^-|-$/g, "")
					.toLowerCase()
			: "sitegeist-export";
		const scopeSlug = scope === "last-assistant" ? "last-response" : "full-conversation";
		const filename = `${slug || "sitegeist-export"}-${scopeSlug}.${format === "markdown" ? "md" : "json"}`;

		if (format === "markdown") {
			const content = buildMarkdownExport(this.context.messages, scope, this.context.title, this.context.sessionId);
			downloadExport(content, filename, "text/markdown");
		} else {
			const payload = buildExportPayload(this.context.messages, scope, this.context.title, this.context.sessionId);
			downloadExport(JSON.stringify(payload, null, 2), filename, "application/json");
		}

		this.close();
	}

	protected override renderContent(): TemplateResult {
		return html`
			<div class="flex flex-col gap-6">
				<div class="space-y-2">
					<h2 class="text-lg font-semibold text-foreground">Export session</h2>
					<p class="text-sm text-muted-foreground">
						Export the last assistant message or the full conversation as Markdown or JSON.
					</p>
				</div>

				<div class="grid grid-cols-1 gap-3">
					${this.renderAction("Last response", "Markdown", "last-assistant", "markdown")}
					${this.renderAction("Last response", "JSON", "last-assistant", "json")}
					${this.renderAction("Full conversation", "Markdown", "full-conversation", "markdown")}
					${this.renderAction("Full conversation", "JSON", "full-conversation", "json")}
				</div>
			</div>
		`;
	}

	private renderAction(label: string, formatLabel: string, scope: ExportScope, format: ExportFormat) {
		return Button({
			variant: "outline",
			size: "md",
			onClick: () => this.doExport(scope, format),
			children: `${label} → ${formatLabel}`,
		});
	}
}

if (!customElements.get("export-dialog")) {
	customElements.define("export-dialog", ExportDialog);
}
