import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { DialogContent, DialogHeader } from "@mariozechner/mini-lit/dist/Dialog.js";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { html, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Toast } from "../components/Toast.js";
import { buildSkillFromRecording, type RecordingResult } from "../recording/recorder.js";
import { getSitegeistStorage } from "../storage/app-storage.js";

/**
 * Review a recording and save it as a site-scoped Skill. The agent will then
 * see the skill id on that site (via URL matching) and can retrieve/replay it.
 */
@customElement("record-skill-dialog")
export class RecordSkillDialog extends DialogBase {
	@state() private rec!: RecordingResult;
	@state() private name = "";
	@state() private domains = "";
	private onSaved?: () => void;

	protected modalWidth = "min(560px, 92vw)";
	protected modalHeight = "auto";

	static open(rec: RecordingResult, onSaved?: () => void) {
		const dialog = new RecordSkillDialog();
		dialog.rec = rec;
		const shortHost = rec.hostname.replace(/^www\./, "").split(".")[0] || "site";
		dialog.name = `${shortHost}-workflow`;
		dialog.domains = rec.hostname;
		dialog.onSaved = onSaved;
		document.body.appendChild(dialog);
		dialog.open();
	}

	private stepLabel(step: RecordingResult["steps"][number]): string {
		switch (step.type) {
			case "navigate":
				return `Navigate → ${step.url}`;
			case "click":
				return `Click ${step.text ? `"${step.text}"` : step.selector || ""}`;
			case "input":
				return `Type "${step.value || ""}" → ${step.selector || ""}`;
			case "submit":
				return `Submit ${step.selector || ""}`;
			default:
				return step.type;
		}
	}

	private async save() {
		const name = this.name.trim();
		if (!name) {
			Toast.error("Please enter a skill name");
			return;
		}
		const storage = getSitegeistStorage();
		const existing = await storage.skills.get(name);
		if (existing && !confirm(`A skill named "${name}" already exists. Overwrite it?`)) return;

		const domainPatterns = this.domains
			.split(",")
			.map((d) => d.trim())
			.filter(Boolean);

		const skill = buildSkillFromRecording(this.rec, {
			name,
			domainPatterns: domainPatterns.length ? domainPatterns : undefined,
		});
		await storage.skills.save(skill);
		Toast.success(`Saved skill "${name}"`);
		this.onSaved?.();
		this.close();
	}

	protected renderContent(): TemplateResult {
		const steps = this.rec?.steps ?? [];
		return html`
			${DialogContent({
				children: html`
					${DialogHeader({
						title: "Save recording as skill",
						description: `${steps.length} step(s) captured on ${this.rec?.hostname ?? ""}`,
					})}

					<div class="flex flex-col gap-4 mt-4">
						${Input({
							label: "Skill name (id)",
							type: "text",
							value: this.name,
							onInput: (e: Event) => {
								this.name = (e.target as HTMLInputElement).value;
							},
						})}
						${Input({
							label: "Domain patterns (comma-separated)",
							type: "text",
							value: this.domains,
							onInput: (e: Event) => {
								this.domains = (e.target as HTMLInputElement).value;
							},
						})}

						${
							this.rec?.screenshots?.length
								? html`<div class="flex gap-2 overflow-x-auto py-1">
										${this.rec.screenshots.map(
											(src) =>
												html`<img
													src=${src}
													class="h-20 rounded border border-border shrink-0"
													alt="snapshot"
												/>`,
										)}
									</div>`
								: ""
						}

						<div class="space-y-1">
							<label class="text-sm font-medium text-foreground">Steps</label>
							<div class="max-h-56 overflow-y-auto rounded-md border border-border bg-background text-xs font-mono">
								${
									steps.length === 0
										? html`<div class="p-3 text-muted-foreground">No interactions were captured.</div>`
										: steps.map(
												(
													step,
													i,
												) => html`<div class="px-3 py-1.5 border-b border-border last:border-0 truncate">
													<span class="text-muted-foreground mr-2">${i + 1}.</span>${this.stepLabel(step)}
												</div>`,
											)
								}
							</div>
						</div>
					</div>

					<div class="mt-6 flex justify-end gap-2">
						${Button({ variant: "outline", onClick: () => this.close(), children: "Cancel" })}
						${Button({ variant: "default", onClick: () => this.save(), children: "Save skill", disabled: steps.length === 0 })}
					</div>
				`,
			})}
		`;
	}
}
