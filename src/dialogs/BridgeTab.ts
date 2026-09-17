import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { SettingsTab } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
	allowHost,
	getAllowedHosts,
	getPendingRequests,
	getPermissionMode,
	isBridgeEnabled,
	type PendingRequest,
	type PermissionMode,
	recordDecision,
	revokeHost,
	setBridgeEnabled,
	setPermissionMode,
} from "../bridge/permissions.js";
import { listSessions } from "../browser/session.js";

/**
 * Settings > Bridge: who may drive the browser from outside (omp, pi, Claude
 * Code, Codex through `sitegeist mcp`), which hosts they may open, and pending
 * permission requests.
 */
@customElement("bridge-tab")
export class BridgeTab extends SettingsTab {
	@state() private enabled = true;
	@state() private mode: PermissionMode = "ask";
	@state() private hosts: string[] = [];
	@state() private pending: PendingRequest[] = [];
	@state() private sessions: Array<{ id: string; label: string; tabs: number }> = [];
	@state() private newHost = "";

	private storageListener = (_changes: Record<string, chrome.storage.StorageChange>, area: string) => {
		if (area === "session" || area === "local") this.load();
	};

	getTabName(): string {
		return "Bridge";
	}

	override async connectedCallback() {
		super.connectedCallback();
		chrome.storage.onChanged.addListener(this.storageListener);
		await this.load();
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		chrome.storage.onChanged.removeListener(this.storageListener);
	}

	private async load() {
		this.enabled = await isBridgeEnabled();
		this.mode = await getPermissionMode();
		this.hosts = await getAllowedHosts();
		this.pending = await getPendingRequests();
		this.sessions = (await listSessions())
			.filter((s) => s.id.startsWith("bridge-"))
			.map((s) => ({ id: s.id, label: s.label, tabs: s.tabIds.length }));
	}

	private async decide(request: PendingRequest, decision: "allow_once" | "allow_host" | "deny") {
		await recordDecision(request.requestId, decision);
		await this.load();
	}

	private async addHost() {
		const host = this.newHost
			.trim()
			.toLowerCase()
			.replace(/^https?:\/\//, "")
			.split("/")[0];
		if (!host) return;
		await allowHost(host);
		this.newHost = "";
		await this.load();
	}

	render(): TemplateResult {
		return html`
			<div class="flex flex-col gap-5">
				<div class="space-y-1">
					<h3 class="text-lg font-semibold text-foreground">Bridge</h3>
					<p class="text-sm text-muted-foreground">
						Lets coding agents on this computer (Claude Code, Codex, omp, pi) drive the browser through
						Sitegeist. Each agent gets its own tab group and works in the background. Set up with
						<code class="text-xs">npx sitegeist mcp</code>.
					</p>
				</div>

				<label class="flex items-center gap-2 text-sm text-foreground">
					<input
						type="checkbox"
						.checked=${this.enabled}
						@change=${async (e: Event) => {
							await setBridgeEnabled((e.target as HTMLInputElement).checked);
							await this.load();
						}}
					/>
					Allow external agents to use the browser
				</label>

				<div class="space-y-2">
					<div class="text-sm font-medium text-foreground">Site access</div>
					<label class="flex items-center gap-2 text-sm text-foreground">
						<input type="radio" name="bridge-mode" value="ask" .checked=${this.mode === "ask"} @change=${async () => {
							await setPermissionMode("ask");
							await this.load();
						}} />
						Ask before opening a new site (the agent prompts you, or you answer here)
					</label>
					<label class="flex items-center gap-2 text-sm text-foreground">
						<input type="radio" name="bridge-mode" value="allow_all" .checked=${this.mode === "allow_all"} @change=${async () => {
							await setPermissionMode("allow_all");
							await this.load();
						}} />
						Allow any site
					</label>
				</div>

				${
					this.pending.length > 0
						? html`
							<div class="space-y-2">
								<div class="text-sm font-medium text-foreground">Waiting for your answer</div>
								${this.pending.map(
									(p) => html`
										<div class="p-3 rounded-lg border border-orange-500/40 bg-orange-500/10 space-y-2">
											<div class="text-sm text-foreground"><span class="font-medium">${p.clientName}</span> wants to open <span class="font-mono">${p.host}</span></div>
											<div class="text-xs text-muted-foreground break-all">${p.url}</div>
											<div class="flex gap-2 flex-wrap">
												${Button({ size: "sm", variant: "default", children: "Allow site", onClick: () => this.decide(p, "allow_host") })}
												${Button({ size: "sm", variant: "secondary", children: "Allow once", onClick: () => this.decide(p, "allow_once") })}
												${Button({ size: "sm", variant: "outline", children: "Deny", onClick: () => this.decide(p, "deny") })}
											</div>
										</div>
									`,
								)}
							</div>
						`
						: ""
				}

				<div class="space-y-2">
					<div class="text-sm font-medium text-foreground">Allowed sites</div>
					${
						this.hosts.length === 0
							? html`<div class="text-xs text-muted-foreground">None yet. Sites you allow show up here; subdomains are included.</div>`
							: this.hosts.map(
									(h) => html`
										<div class="flex items-center justify-between gap-2 text-sm">
											<span class="font-mono text-foreground">${h}</span>
											${Button({
												size: "sm",
												variant: "ghost",
												children: "Remove",
												onClick: async () => {
													await revokeHost(h);
													await this.load();
												},
											})}
										</div>
									`,
								)
					}
					<div class="flex gap-2 items-center">
						${Input({
							placeholder: "example.com",
							value: this.newHost,
							className: "text-sm flex-1",
							onInput: (e: Event) => {
								this.newHost = (e.target as HTMLInputElement).value;
							},
							onKeyDown: (e: KeyboardEvent) => {
								if (e.key === "Enter") this.addHost();
							},
						})}
						${Button({ size: "sm", variant: "secondary", children: "Add", onClick: () => this.addHost() })}
					</div>
				</div>

				<div class="space-y-2">
					<div class="text-sm font-medium text-foreground">Agent sessions in this browser</div>
					${
						this.sessions.length === 0
							? html`<div class="text-xs text-muted-foreground">No external agent has connected since the browser started.</div>`
							: this.sessions.map(
									(s) =>
										html`<div class="text-sm text-foreground">${s.label} <span class="text-muted-foreground">(${s.tabs} tab${s.tabs === 1 ? "" : "s"})</span></div>`,
								)
					}
				</div>
			</div>
		`;
	}
}
