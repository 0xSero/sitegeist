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
	@state() private showScreenshots = true;
	@state() private showSteps = true;
	private onSaved?: () => void;

	protected modalWidth = "min(820px, 94vw)";
	protected modalHeight = "min(860px, 92vh)";

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

	private sectionHeader(label: string, count: number, expanded: boolean, onToggle: () => void): TemplateResult {
		return html`
			<div class="flex items-center justify-between gap-3">
				<div class="min-w-0">
					<div class="text-sm font-semibold text-white">${label}</div>
					<div class="text-xs text-white/60">${count} captured</div>
				</div>
				<button
					type="button"
					class="shrink-0 rounded-md border border-white/20 bg-white/10 px-3 py-1.5 text-xs font-medium text-white hover:bg-white/15"
					aria-expanded=${expanded ? "true" : "false"}
					@click=${onToggle}
				>
					${expanded ? "Hide" : "Show"}
				</button>
			</div>
		`;
	}

	private renderScreenshots(): TemplateResult {
		const screenshots = this.rec?.screenshots ?? [];
		return html`
			<section class="rounded-md border border-white/15 bg-black/40 p-3">
				${this.sectionHeader("Screenshots", screenshots.length, this.showScreenshots, () => {
					this.showScreenshots = !this.showScreenshots;
				})}
				${
					this.showScreenshots
						? screenshots.length
							? html`
								<div class="mt-3 grid max-h-80 grid-cols-1 gap-3 overflow-y-auto pr-1 sm:grid-cols-2">
									${screenshots.map(
										(src, index) => html`
											<figure class="overflow-hidden rounded-md border border-white/15 bg-black">
												<img
													src=${src}
													class="block h-44 w-full object-cover"
													alt=${`Recording screenshot ${index + 1}`}
												/>
												<figcaption class="border-t border-white/10 px-3 py-1.5 text-xs text-white/70">
													Screenshot ${index + 1}
												</figcaption>
											</figure>
										`,
									)}
								</div>
							`
							: html`<div class="mt-3 rounded-md border border-white/10 bg-black/30 p-3 text-sm text-white/70">
								No screenshots were captured for this recording.
							</div>`
						: ""
				}
			</section>
		`;
	}

	private renderSteps(steps: RecordingResult["steps"]): TemplateResult {
		return html`
			<section class="rounded-md border border-white/15 bg-black/40 p-3">
				${this.sectionHeader("Steps", steps.length, this.showSteps, () => {
					this.showSteps = !this.showSteps;
				})}
				${
					this.showSteps
						? html`
							<div
								class="mt-3 max-h-72 overflow-y-auto rounded-md border border-white/15 bg-black text-sm font-mono text-white"
							>
								${
									steps.length === 0
										? html`<div class="p-3 text-white/70">No interactions were captured.</div>`
										: steps.map(
												(step, i) => html`
												<div class="grid grid-cols-[2.5rem_1fr] gap-2 border-b border-white/10 px-3 py-2 last:border-0">
													<span class="text-right font-semibold text-white/60">${i + 1}.</span>
													<span class="min-w-0 whitespace-pre-wrap break-words text-white">${this.stepLabel(step)}</span>
												</div>
											`,
											)
								}
							</div>
						`
						: ""
				}
			</section>
		`;
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
				className: "overflow-y-auto text-white",
				children: html`
					${DialogHeader({
						title: "Save recording as skill",
						description: `${steps.length} step(s) captured on ${this.rec?.hostname ?? ""}`,
						className: "[&_h2]:text-white [&_p]:text-white/60",
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

						${this.renderScreenshots()} ${this.renderSteps(steps)}
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
