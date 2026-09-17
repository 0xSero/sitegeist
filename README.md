<p align="center">
  <img src="media/hero.png" alt="Sitegeist" width="400">
</p>

An AI assistant that lives in your browser sidebar, and a bridge that lets coding agents
use your browser too. Built for collaboration, not autonomy theater. You guide, it executes.

Sitegeist automates repetitive web tasks, extracts data from any website, navigates across
pages, fills out forms, compiles research, and turns what it finds into documents,
spreadsheets, or whatever you need. It works on any website through a Chromium side panel
(Chrome, Brave, Edge, Arc, Vivaldi, Opera, Chromium), using the AI provider of your choice.

Bring your own API key or log in with an existing subscription (Anthropic Claude,
OpenAI/ChatGPT, GitHub Copilot, Google Gemini). Your data stays on your machine. Nothing
is collected or tracked.

This fork (0xSero/sitegeist) adds three things to upstream (badlogic/sitegeist):

1. **Background operation.** Every chat owns its own tab group. Tabs open inactive, the
   agent acts on its own current tab, and it never sees or touches your other tabs.
2. **Dynamic model lists.** Models are fetched from the connected providers at runtime
   instead of a hardcoded table.
3. **A harness bridge.** Claude Code, Codex, omp, pi, or any MCP client can drive the
   browser through Sitegeist, in the background, with no configuration.

## Install the extension

1. Download or build (`npm run build`) the unpacked extension in `dist-chrome/`.
2. Open `chrome://extensions` (or `brave://extensions`), enable Developer mode, click
   Load unpacked, select `dist-chrome/`.
3. Open the side panel with `Cmd+Shift+S` / `Ctrl+Shift+S` and connect a provider.

No toggles are required. In-page JavaScript runs through the `userScripts` API when the
browser exposes it (an isolated world whose CSP blocks network access from injected code)
and through the debugger's `Runtime.evaluate` otherwise (the page's main world; Chrome
shows its "is debugging this browser" bar). If you want the stricter sandbox, enable
**Allow user scripts** in the extension's details; everything works either way.

Requires Chrome 141+ or the equivalent Chromium release.

## Use it from a coding agent

```bash
cd cli && npm install && npm run build && npm link   # until published to npm
sitegeist install                                     # native-messaging manifest for every Chromium browser found
claude mcp add sitegeist -- sitegeist mcp             # Claude Code
sitegeist pi-extension                                # pi: writes ~/.pi/agent/extensions/sitegeist.ts
sitegeist status                                      # is the extension reachable?
```

Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.sitegeist]
command = "sitegeist"
args = ["mcp"]
```

omp: add an MCP server entry that runs `sitegeist mcp`.

`sitegeist mcp` installs the manifest itself on first run, so the only manual step is
loading the extension once. Reload the extension after the first install.

How it is wired, and why it is safe:

```
harness ── stdio MCP ── sitegeist mcp ── unix socket ── native host ── native messaging ── extension
```

The browser spawns the native host. The host owns a socket in
`/tmp/sitegeist-bridge-<user>/` (0700 directory, 0600 socket) that only your user can
reach, and it only relays frames; all logic and all permission checks live in the
extension. Nothing listens on the network. Each harness gets its own tab group
("Sitegeist · claude", "Sitegeist · pi") and works in the background; `tabs_show` is the
only tool that changes what you see.

Site access: by default the extension asks before an agent opens a new site. Claude Code
and Codex show the prompt inline (MCP elicitation). Otherwise answer it in the side panel
under Settings > Bridge, run `sitegeist allow <host>`, or switch to "allow any site".

CLI commands: `mcp`, `install`, `status`, `allow <host>`, `reload`, `debug`,
`pi-extension`. See `cli/README.md`.

## What changed in this fork

Extension:

- `src/browser/` is new and is the only code that touches tabs: `session.ts` (tab group
  per session, current tab, persistence in `chrome.storage.session`), `cdp.ts`
  (`chrome.debugger` screenshots, real input events, focus emulation so hidden tabs keep
  running `requestAnimationFrame` and lazy loading), `page.ts` (navigation with load
  wait, in-page scripts with `userScripts` → `scripting` → CDP fallbacks, snapshot with
  element refs), `foreground-guard.ts` (popups opened by agent tabs no longer steal
  focus).
- Every tool now acts on the session's current tab instead of the active tab:
  `navigate` (new `showTab`, `closeTab`, `back`/`forward`; `switchToTab` no longer
  focuses), `browserjs()`, native input events, debugger, skills, element picker,
  `extract_image` (CDP screenshot instead of `captureVisibleTab`).
- The side panel only reacts to URL changes on its own tab. A link icon in the header
  shares the tab you are viewing with the agent.
- `src/models/`: runtime model discovery for Anthropic, OpenAI, ChatGPT/Codex, Gemini,
  GitHub Copilot, OpenRouter, Mistral, Groq, xAI, Cerebras, Hugging Face; metadata from
  the generated table and models.dev; cached in IndexedDB (`discovered-models` store).
  Providers without a list endpoint keep the static table. `registerModels` was added to
  `pi-ai` (`../pi-mono/packages/ai/src/models.ts`).
- `src/bridge/`: native messaging port, one browser session per connected harness,
  request routing, site permissions, diagnostics (`bridge.debug`, `bridge.bench`,
  `bridge.reload`). Settings gained a Bridge tab.
- Manifest: fixed `key` (stable id `bbkgpflnkggdfabgjhofdmdopgjopamc`), new permissions
  `tabGroups`, `nativeMessaging`, `alarms`.
- Fixed the type errors in the custom provider dialogs.

CLI (`cli/`, package `sitegeist`): native host, socket client, MCP server with 22 tools,
installer for all Chromium browser directories (macOS, Linux, Windows registry), pi
extension generator.

Design and evidence (reference implementations, experiments, protocol): see
`docs/agent-bridge-design.md`. Live task results and bridge latencies: `docs/benchmarks.md`.
Full list of changes: `CHANGELOG.md`.

## Development

Clone this repo plus its sibling dependencies into the same parent directory:

```
parent/
  mini-lit/          # https://github.com/badlogic/mini-lit
  pi-mono/           # https://github.com/badlogic/pi-mono
  sitegeist/         # this repo
```

Install dependencies in each repo:

```bash
(cd ../mini-lit && npm install)
(cd ../pi-mono && npm install)
npm install
(cd cli && npm install)
```

Start all dev watchers (mini-lit, pi-mono, sitegeist extension, marketing site):

```bash
./dev.sh
```

This fork needs one addition in `../pi-mono/packages/ai/src/models.ts` that upstream pi-ai
does not have yet (runtime model discovery registers into its model registry):

```ts
export function registerModels(provider: string, models: Model<Api>[]): void {
	const providerModels = new Map<string, Model<Api>>();
	for (const model of models) providerModels.set(model.id, model);
	modelRegistry.set(provider, providerModels);
}

export function resetProviderModels(provider: string): void {
	const generated = (MODELS as Record<string, Record<string, Model<Api>>>)[provider];
	if (!generated) {
		modelRegistry.delete(provider);
		return;
	}
	const providerModels = new Map<string, Model<Api>>();
	for (const [id, model] of Object.entries(generated)) providerModels.set(id, model);
	modelRegistry.set(provider, providerModels);
}

export function getGeneratedModels(provider: string): Model<Api>[] {
	const generated = (MODELS as Record<string, Record<string, Model<Api>>>)[provider];
	return generated ? Object.values(generated) : [];
}
```

Without the watchers, build the sibling declarations once so type checking resolves:

```bash
(cd ../pi-mono/packages/ai && npx tsc -p tsconfig.build.json)
(cd ../pi-mono/packages/web-ui && npx tsc -p tsconfig.build.json)
```

Rebuild the extension and reload it from the terminal:

```bash
npm run build && sitegeist reload
```

Note: a production build bumps the version in `static/manifest.chrome.json`.

## Checks

```bash
./check.sh        # biome + tsc for the extension and the site
(cd cli && npm run check)
```

The Husky pre-commit hook runs `./check.sh`.

## Updating the website

```bash
cd site && ./run.sh deploy
```

Builds the static site and uploads it to `sitegeist.ai`. Requires SSH access to
`slayer.marioslab.io`.

## Releasing

```bash
./release.sh patch   # 1.0.0 -> 1.0.1
./release.sh minor   # 1.0.0 -> 1.1.0
./release.sh major   # 1.0.0 -> 2.0.0
```

Bumps the version in `static/manifest.chrome.json`, commits, tags, and pushes. GitHub
Actions builds the extension and creates a release.

## License

AGPL-3.0. See [LICENSE](LICENSE). Upstream: [badlogic/sitegeist](https://github.com/badlogic/sitegeist).
