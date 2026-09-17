# Background browser agent + harness bridge: investigation and design

Date: 2026-09-16. Status: implemented on 2026-09-16 (see CHANGELOG, Unreleased); this document is the design it was built from. Written against sitegeist 1.1.6
(working tree has uncommitted `relay/` and `src/relay/bridge.ts`), Brave 152 with
Claude in Chrome 1.0.93, ChatGPT/Codex extension 1.26.901 and sitegeist loaded unpacked
in Profile 5.

Three goals:

1. Sitegeist works inside its own tab group, in the background. It never takes the
   browser from the user and never looks at the user's tabs.
2. Model lists come from the connected providers at runtime, not a hardcoded table.
3. Any harness (omp, pi, Claude Code, Codex, anything speaking MCP) can drive the
   browser through sitegeist, in the background, securely, with no configuration.

## 1. What sitegeist does today

Every tool resolves its target as "the active tab of the current window" and every
screenshot uses `chrome.tabs.captureVisibleTab`, which by definition captures the
tab the user is looking at.

| Call site | Assumption |
| --- | --- |
| `src/tools/navigate.ts:98` | navigates the active tab; `newTab` creates with `active: true`; `switchToTab` calls `windows.update({focused:true})` |
| `src/tools/repl/runtime-providers.ts:119` | `browserjs()` runs in the active tab |
| `src/tools/NativeInputEventsRuntimeProvider.ts:25` | CDP input goes to the active tab |
| `src/tools/debugger.ts:78`, `src/tools/skill.ts:206`, `src/tools/ask-user-which-element.ts:543`, `src/tools/repl/overlay-inject.ts:12` | same |
| `src/tools/extract-image.ts:142,169` | `captureVisibleTab(windowId)` |
| `src/recording/recorder.ts:177,221` | same |
| `src/sidepanel.ts:600,862-905` | steers the agent whenever the user switches tabs or navigates in this window while it is streaming, i.e. it watches the user's tabs |

The uncommitted relay (`relay/server.mjs`, `src/relay/bridge.ts`) inherits all of this
(every handler starts with `activeTab()`), and adds a localhost HTTP endpoint with no
auth unless a token is configured. That endpoint is reachable from any web page:
`fetch("http://127.0.0.1:7717/rpc", {method:"POST", mode:"no-cors", body})` executes
the call even though the page cannot read the reply. The relay should be replaced, not
extended.

Manifest permissions today: `storage, unlimitedStorage, activeTab, scripting, sidePanel,
userScripts, webNavigation, debugger, declarativeNetRequest`. Missing for this design:
`tabGroups`, `nativeMessaging`, `alarms`. The manifest has no `key`, so the unpacked
extension ID differs per install path (here `ochciecobgccggjiofaopmgifpnapoli`).

## 2. How the references do it

Three implementations were read on this machine. Details and evidence are in the
appendix; this is the comparison that matters for the design.

| | Claude Code + Claude in Chrome | Codex + ChatGPT extension | omp browser relay |
| --- | --- | --- | --- |
| Who listens | Native host spawned by the browser; unix socket `/tmp/claude-mcp-browser-bridge-<user>/<pid>.sock` | Native host spawned by the browser; unix socket `/tmp/codex-browser-use/<uuid>.sock` | Node daemon on `127.0.0.1:9224`; extension dials out over WebSocket |
| Harness side | `claude --claude-in-chrome-mcp` stdio MCP server dials the socket | `node_repl` MCP server plus trusted browser service dials the socket | omp connects with puppeteer to the relay's fake CDP endpoint |
| Setup | CLI writes the native-messaging manifest into every browser's dir. Zero user config | ChatGPT desktop app writes the manifest. Zero user config | `omp browser-relay install` then manual "Load unpacked" |
| Auth | Chrome `allowed_origins`; dir 0700 / socket 0600 / uid checks on the client | Chrome `allowed_origins`; socket 0600; host verifies the peer's code signature (OpenAI team ID) | Optional shared token; Origin header check on the WebSocket |
| Tab isolation | Per-session tab group in the user's last-focused window; tabs created inactive; popups re-created inactive by a "foreground guard" | Per-session tab group titled by the model; `tabs.create({active:false})`; fallback `windows.create({focused:false})` | Tabs it drives are moved into an "omp" group; `Target.activateTarget` does focus |
| Screenshots | `chrome.debugger` `Page.captureScreenshot {fromSurface:true}` | `chrome.debugger` `Page.captureScreenshot {fromSurface:true, optimizeForSpeed:true}` | CDP, but activates the page first unless it adopted the visible tab |
| Input | CDP `Input.dispatchMouseEvent` | CDP plus DOM and Playwright-style locators | CDP via puppeteer |
| Permissions | Per-site prompt relayed to the CLI as `permission_request`; hosted URL category check; enterprise block list | Origin policy in the browser service; approvals via MCP elicitation ("allow once / this site / all sites") | None |
| Multi-session | Every CLI session dials the same socket; replies are broadcast and matched by `tool_use_id`; one tab group per session | One connection per session; tabs leased per turn, cleaned up on `turn_ended` hook | One extension socket, CDP sessions multiplexed |
| Liveness | Extension pings host every 10 s; backoff reconnect; `chrome.alarms` keepalive | Reconnect alarm plus heartbeat alarm every 30 s | Keepalive alarm every 30 s; exponential reconnect |

Both first-party integrations converge on the same shape: browser-spawned native host,
unix socket in a user-only temp dir, a stdio MCP server on the harness side, per-session
tab groups with inactive tabs, and CDP for pixels and input. That is the shape to copy.

## 3. Verified: background tabs can be driven without focus

Run in a headed Chrome for Testing 150 with two tabs, tab A in front, tab B hidden
(`document.visibilityState === "hidden"`). All commands went to B over CDP.

| Check | Result |
| --- | --- |
| `Page.captureScreenshot` on hidden tab | 33 to 55 ms, pixels are B's, A stays visible |
| `Input.dispatchMouseEvent` click on hidden tab | click handler fired |
| Navigation in hidden tab | loaded in 61 ms, A stays visible |
| `setTimeout(100)` in hidden tab | 103 ms (no throttling at this scale) |
| `requestAnimationFrame` in hidden tab | frozen (never fires) |
| rAF after `Emulation.setFocusEmulationEnabled {enabled:true}` | fires; page reports `visibilityState: "visible"` |
| IntersectionObserver after scroll, with focus emulation | fires (lazy-load and infinite scroll work) |

Conclusion: attach `chrome.debugger` to every tab the agent owns, enable focus emulation
on attach, and use `Page.captureScreenshot {fromSurface:true}`. Nothing needs to be
activated. `captureVisibleTab` is out. Cost: Chrome shows the "Sitegeist started
debugging this browser" bar, which both Claude and Codex accept. If the user closes
that bar, `debugger.onDetach` fires with `canceled_by_user`; mark the tab unusable until
its next navigation instead of re-attaching in a loop.

## 4. Design

### 4.1 One session model for everything

Introduce `src/browser/` as the single place that touches tabs. Both the sidepanel
agent and external harnesses become clients of it.

```
BrowserSession
  id            sidepanel session id, or bridge client id
  label         shown as the tab group title: "Sitegeist · <label>"
  color         one of Chrome's 9 group colors, rotated per session
  windowId      window the session was started from (sidepanel window, or last focused)
  groupId       created lazily on first tab, persisted in chrome.storage.session
  tabs          ordered tab ids owned by the session
  currentTabId  the tab tools act on; set by navigate/newTab/switchTo, never by user focus

TabHandle (per owned tab)
  attached      chrome.debugger attached with focus emulation on
  banned        user cancelled the debugger; cleared on next navigation
```

Rules:

- Tools take a session, not a window. Every `chrome.tabs.query({active:true, currentWindow:true})`
  becomes `session.currentTab()`. The twelve call sites in section 1 are the migration list.
- New tabs: `chrome.tabs.create({url, windowId, active:false})` then `chrome.tabs.group`.
  `switchToTab` changes `currentTabId` only. A separate `show` action (and a click on a
  tab pill in the UI) is the only thing that calls `tabs.update({active:true})`.
- Page access by tab id: `chrome.scripting.executeScript({target:{tabId}})`,
  `chrome.userScripts.execute({target:{tabId}})`, `chrome.debugger.sendCommand({tabId})`.
  All of these work on inactive tabs.
- Screenshots: `Page.captureScreenshot {format:"png", fromSurface:true}` on the current tab;
  `Emulation.setDeviceMetricsOverride` when a fixed viewport is wanted.
- Foreground guard: `chrome.tabs.onCreated` where `openerTabId` is an owned tab means a
  popup or `target=_blank`. Immediately `tabs.update(newTab, {active:false})`, re-activate
  whatever the user had active, and add the new tab to the group. Claude does this with a
  content script that intercepts clicks; the `onCreated` version is a few lines and
  covers the common case. Upgrade later if flicker is noticeable.
- The user's tabs are invisible to the agent. `listTabs` lists the session's group only.
  Handing a tab to the agent is a user gesture in the sidepanel ("use this tab"), which
  moves the tab into the group and makes it current. The model cannot claim tabs.
- Navigation steering (`sidepanel.ts` `onUpdated`/`onActivated`) only reacts to owned tabs.
- Lifecycle: the group and its tabs outlive the session (they are the user's results).
  Closing a session detaches the debugger from its tabs and forgets them. On service
  worker restart, rebuild sessions from `chrome.storage.session` plus
  `chrome.debugger.getTargets()` (omp and Claude both reconcile this way). Groups are
  found again by title if the storage is gone.
- One debugger client per tab is a Chrome rule. Sessions own disjoint tabs, so there is
  no conflict inside sitegeist. A tab the user hands over that another extension is
  debugging will fail to attach; surface that as an error.

Manifest changes: add `tabGroups`, `nativeMessaging`, `alarms`; add a fixed `key` so the
extension ID is stable across machines (required for `allowed_origins`, see 4.3).

Browser scope: everything here is plain Manifest V3 (`tabGroups`, `debugger`,
`nativeMessaging`, `sidePanel`, `userScripts`) and works identically in Brave, Chrome,
Chromium, Edge, Arc, Vivaldi and Opera. The only browser-specific code is the list of
native-messaging manifest directories in the installer. Firefox is out of scope (no
`sidePanel`, `debugger` or `userScripts` parity).

### 4.2 Where tools run

Today the tools execute in the sidepanel page. External harnesses need them without a
sidepanel, so the primitives move to the service worker and the sidepanel tools become
wrappers:

- `src/browser/session.ts` session and tab bookkeeping.
- `src/browser/cdp.ts` attach/detach, screenshot, input events, focus emulation.
- `src/browser/page.ts` navigate with load wait, text and accessibility snapshot,
  in-page JavaScript via `userScripts.execute`, click/fill/scroll helpers.
- The REPL sandbox (`sandbox.html`) needs a document, so the sidepanel keeps it. For the
  bridge, in-page JavaScript runs through `page.ts` directly; that is what
  `browserjs()` already does underneath.

`NativeInputEventsRuntimeProvider` and the recorder move onto `cdp.ts` unchanged in
behaviour.

### 4.3 The bridge: native host + unix socket + MCP

```
harness (omp, pi, claude, codex, ...)
  └─ stdio ─► sitegeist mcp            (npm package "sitegeist", also the installer)
                 │  dials
                 ▼
  /tmp/sitegeist-bridge-<user>/<hostpid>.sock      0700 dir, 0600 socket
                 ▲
                 │  unix socket, 4-byte length-prefixed JSON
  sitegeist-host (spawned by the browser via native messaging, one per browser profile)
                 ▲
                 │  native messaging stdio, same framing
  extension service worker  ─► src/bridge/  ─► src/browser/ (one BrowserSession per client)
```

Why this and not the WebSocket relay already in the tree:

- Zero config. The extension calls `chrome.runtime.connectNative("ai.sitegeist.bridge")`
  on startup, on a 30 s alarm, and on toolbar click. The browser spawns the host. No
  daemon, no port, no token, nothing to type into `chrome.storage`.
- No network surface. There is no TCP listener a web page or another machine could
  reach. The only inbound path is a filesystem socket owned by the user.
- Chrome enforces `allowed_origins`, so only the sitegeist extension can spawn the host,
  and the host only relays what Chrome piped in.

Host: a dumb relay. Framing on both legs is `[uint32 LE length][UTF-8 JSON]`, exactly
Chrome's native messaging framing, so the host copies frames and adds one field:

- socket client connects → host assigns `clientId`, sends `{type:"client_connected", clientId}`
  to the extension. Extension creates a `BrowserSession` labelled with the client's
  declared name (`omp`, `pi`, `claude`, ...).
- client frame `{id, method, params}` → `{type:"request", clientId, id, method, params}`.
- extension `{type:"response", clientId, id, result|error}` → routed to that one client
  (Claude broadcasts and lets clients filter; routing is simpler and leaks nothing).
- extension `{type:"event", clientId?, ...}` for permission prompts and progress.
- socket client disconnect → `{type:"client_disconnected", clientId}` → session ends,
  debugger detached, tabs kept.
- Host startup: `mkdir 0700`, sweep `*.sock` whose PID is dead, `listen`, `chmod 0600`.
  Shutdown unlinks the socket. Same as Claude's host.

Client (`sitegeist mcp`): before dialing, refuse if the directory is a symlink, not
0700, or not owned by the current uid, or the socket is not 0600 and owned by the uid.
Then MCP over stdio. Multiple sockets means multiple browsers; expose
`list_browsers`/`select_browser` like Claude and default to the newest.

Sizes: native messaging allows 64 MiB extension→host but only 1 MiB host→extension.
Screenshots flow the large direction. Anything a harness sends into the browser above
1 MiB (file upload) has to be chunked; Codex has `appendChunk` for this. Not in v1.

Service worker lifetime: a native port alone does not reliably keep an MV3 worker
alive, so keep the 30 s alarm both references use and make reconnection idempotent on
the host side.

Installation, the one thing an extension cannot do itself: writing the native-messaging
manifest. `sitegeist mcp` does it on first run if the manifest is missing, for every
browser directory that exists (Chrome, Brave, Chromium, Edge, Arc, Vivaldi, Opera under
`~/Library/Application Support/...`, Linux `~/.config/...`, Windows registry). This is
exactly what Claude Code does at startup, and it is why the manifest needs a fixed
extension ID (`key` in the manifest). The user runs nothing extra; the first
`sitegeist mcp` invocation from any harness completes setup, then tells the user to
reload the extension once if the extension was loaded before the manifest existed.

Harness recipes (all the same server):

- Claude Code: `claude mcp add sitegeist -- npx sitegeist mcp`
- Codex: `[mcp_servers.sitegeist] command = "npx" args = ["sitegeist","mcp"]`
- omp: MCP server entry in its config; omp's own relay keeps working independently
  (different extension, different tab group).
- pi: pi has no MCP client, it loads TypeScript extensions. Ship
  `sitegeist pi-extension` that writes a small `~/.pi/agent/extensions/sitegeist.ts`
  registering the same tools via the socket client library.

Tool surface, deliberately Claude-shaped so prompts written for Claude in Chrome carry
over:

| Tool | Params |
| --- | --- |
| `tabs_context` | `createIfEmpty` → session's tabs |
| `tabs_create`, `tabs_close` | `url?` / `tabId` |
| `navigate` | `url` or `back`/`forward`, `tabId?` |
| `screenshot` | `tabId?`, `fullPage?`, `selector?` |
| `read_page` | `tabId?`, `mode: text|accessibility|html`, `selector?`, `maxChars?` |
| `find` | `query`, `tabId?` → element refs |
| `click`, `type`, `scroll`, `key`, `hover` | coordinates or `ref`, `tabId?` |
| `form_input` | `ref`, `value` |
| `run_js` | `code`, `tabId?` (in-page, the `browserjs` runtime) |
| `console`, `network` | `tabId?`, filters |
| `show` | `tabId` (the only focus-changing call) |

Permissions: reuse the sidepanel's domain permission store. When a bridge session
navigates to a domain without a grant, the extension emits a `permission_request`
event; the MCP server turns it into an MCP elicitation where the client supports it,
otherwise returns an error telling the user to approve in the sidepanel, where the
pending request is shown with allow-once / allow-domain / deny. The same `follow a
plan` shortcut Claude has (pre-approve a domain list) can come later.

Visibility for the user: the sidepanel session list shows bridge sessions ("omp",
"claude") with their tab group, read-only transcript of tool calls, and a stop button.
That is the collaboration story sitegeist already sells, extended to external agents.

### 4.4 Dynamic model discovery

Replace "the generated table is the universe" with "the provider is the universe,
the table is metadata".

`src/models/discovery.ts`: `discoverModels(provider, credential): Promise<Model[]>` with
one adapter per provider. Verified list endpoints:

| Provider | Endpoint | What it returns |
| --- | --- | --- |
| anthropic | `GET /v1/models` (paginate `after_id`, limit 1000) | id, display_name, `max_input_tokens`, `max_tokens`, capabilities (thinking, effort levels, image_input) |
| openai | `GET /v1/models` | ids only |
| openai-codex (OAuth) | `GET https://chatgpt.com/backend-api/codex/models?client_version=<ver>` with the ChatGPT bearer (confirmed in `codex-rs/codex-api/src/endpoint/models.rs`); ETag supported | slug, display_name, reasoning levels, visibility |
| google | `GET /v1beta/models?key=` | name, `inputTokenLimit`, `outputTokenLimit`, `supportedGenerationMethods` |
| github-copilot | `GET https://api.individual.githubcopilot.com/models` with Copilot token | ids, capabilities and limits |
| openrouter | `GET https://openrouter.ai/api/v1/models` (no key) | full metadata incl. pricing, context, modalities |
| groq, xai, cerebras, mistral, huggingface | `GET <baseUrl>/models` | ids (Mistral adds capabilities) |
| ollama, llama.cpp, vLLM, LM Studio | already in `pi-web-ui/src/utils/model-discovery.ts` | reuse |
| google-gemini-cli, google-antigravity, amazon-bedrock, google-vertex, opencode, zai, minimax, kimi | no simple list endpoint (Bedrock needs SigV4 `ListFoundationModels`) | static table only |

Merge rule per provider: if discovery succeeds, the discovered ID list is authoritative.
Metadata for each ID comes from, in order: the provider's own response, the generated
table entry with the same ID, `https://models.dev/api.json` (cached 24 h in IndexedDB;
this is what `generate-models.ts` uses at build time), then conservative defaults
(128k context, 8k output, cost unknown and shown as such). `api` is fixed per provider
except Copilot, which keeps pi's rule (claude-4 → anthropic-messages, gpt-5/oswe →
openai-responses, else completions). Filter obvious non-chat IDs (embedding, tts,
whisper, dall-e, realtime, moderation; Gemini by `supportedGenerationMethods`).

Trigger: when a key or OAuth login is saved (doubles as "test connection"), when the
model selector opens and the cache is older than an hour, and manually. 5 s timeout,
never on the send path. Store in a new `discoveredModels` IndexedDB store keyed by
provider. `DEFAULT_MODELS` in `sidepanel.ts` stays as a preference list, falling back
to the first discovered model.

CORS is not a problem: chat requests to these hosts already work from the extension
through `host_permissions` and the DNR rules; the list calls hit the same origins.

### 4.5 Data flow and state when a harness drives sitegeist

Which model: the harness's. Over the bridge sitegeist is a tool provider, not an
agent. The harness's model decides, sitegeist executes primitives and returns what it
saw. The configured sitegeist model, keys and OAuth are not used and spend nothing.
An optional later mode exposes sitegeist's own agent as a single `run_task` tool so a
harness can delegate a whole browsing job to sitegeist's configured model and receive a
summary. Not in v1.

Data path, all JSON:

1. Harness <-> `sitegeist mcp`: stdio MCP. Results are MCP content blocks: text for
   page text, accessibility snapshots, element refs, console and network output;
   `image` blocks (base64 PNG, downscaled with the existing `maxWidth` logic) for
   screenshots.
2. `sitegeist mcp` <-> host: unix socket, 4-byte length-prefixed JSON, one request per
   call matched by id.
3. Host <-> extension: native messaging stdio, same framing. The host adds `clientId`
   and copies frames; it never inspects them.
4. Extension: `clientId` -> `BrowserSession` -> primitive on that session's tab.

Reverse direction: `permission_request` (new domain) becomes an MCP elicitation;
progress and "tab closed by user" arrive as events. The 1 MiB host->extension cap
only affects uploads into the browser.

State, two different things:

- The conversation lives in the harness (Claude Code `~/.claude/projects`, Codex
  `~/.codex/sessions`, omp `~/.omp/agent/agent.db`, pi `~/.pi/agent/sessions`).
  Sitegeist never sees prompts or model output, only tool calls.
- The browser session (group id, owned tab ids, current tab, debugger attachments) is
  service-worker state mirrored to `chrome.storage.session` (survives worker sleep,
  wiped on browser restart). The tab group is a real Chrome group and outlives all of
  it. Domain grants go in the existing permission store so they persist like sidepanel
  grants.

Reconnection: a restarted harness gets a new socket connection. To avoid a fresh tab
group every time, `sitegeist mcp` sends a stable session name on connect (harness name
plus the harness's own session id, which omp, Claude Code and Codex expose through env
or args); the extension re-adopts the group with that title. Optionally the sidepanel
records bridge tool calls as a read-only "bridge" record in the IndexedDB sessions
store, for visibility only.

## 5. Order of work

1. `src/browser/` and the tab-session migration (4.1, 4.2). Manifest: `tabGroups`,
   `alarms`, fixed `key`. This alone delivers goal 1 and is the foundation for goal 3.
2. Model discovery (4.4). Independent of 1, can run in parallel.
3. Bridge (4.3): `src/bridge/` in the extension, `cli/` package with `host`, `mcp`,
   `install`, `pi-extension` subcommands. Delete `relay/` and `src/relay/` (the
   uncommitted WIP; nothing depends on it).
4. Sidepanel visibility of bridge sessions and permission prompts.

## 6. Open points

- Native port keepalive: whether Brave keeps the MV3 worker alive while the native port
  is open was not measured. The 30 s alarm makes it moot but adds wakeups.
- Copilot `/models` needs the same headers the chat path uses; verify with a real
  token before relying on it.
- Anthropic `/v1/models` with an OAuth bearer (subscription login) versus `x-api-key`
  was not tested. If it refuses, fall back to the static table for OAuth sessions.
- Whether Claude Code currently uses its sealed "local pairing" channel or cleartext
  on this machine could not be determined; the design here matches the cleartext
  design, hardened by socket ownership checks. Peer code-signature checks like Codex's
  are possible later but need a native component.

## Appendix: evidence

Claude Code 2.1.273, extension 1.0.93 in Brave Profile 5. Native manifest
`~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.anthropic.claude_code_browser_extension.json`
→ `~/.claude/chrome/chrome-native-host`, a 4-line wrapper for `claude --chrome-native-host`.
Live socket `/tmp/claude-mcp-browser-bridge-sero/76400.sock` (0600 in 0700 dir). MCP
server registered as `{type:"stdio", command: process.execPath, args:["--claude-in-chrome-mcp"]}`.
Screenshot call in the extension: `Page.captureScreenshot {format, quality, captureBeyondViewport:false, fromSurface:true}`.
Tab groups: `SESSION_GROUP_COLORS=[BLUE,CYAN,GREEN,ORANGE,RED,PINK,PURPLE,GREY]`,
first tab created in `chrome.windows.getLastFocused({windowTypes:["normal"]})`.

Codex 0.154.0, extension 1.26.901.11451 in Brave Profile 5. Native manifest
`com.openai.codexextension.json` → the Rust host "ChatGPT for Chrome" under
`~/.codex/plugins/cache/openai-bundled/chrome/latest/extension-host/macos/arm64/`.
Live socket `/tmp/codex-browser-use/<uuid>.sock` (0600). Host verifies peers with
`SecCodeCopyGuestWithAttributes` and OpenAI's team ID. Extension:
`chrome.tabs.create({active:false, url:"about:blank", windowId})`, fallback
`chrome.windows.create({focused:false, type:"normal"})`, screenshot
`Page.captureScreenshot {format, fromSurface:true, optimizeForSpeed:true, quality:80}`.
Origin policy and approvals live in `~/.codex/browser/config.toml` and per-thread
`~/.codex/browser/sessions/<thread>.toml`. Docs: learn.chatgpt.com/docs/chrome-extension.

omp 18.2.1 (`@oh-my-pi/pi-coding-agent` 17.4.0). Extension at
`~/.omp/browser-relay/extension/` (permissions `debugger, tabs, tabGroups, storage, alarms`),
dials `ws://127.0.0.1:9224/ext`. Relay source under
`pi-coding-agent/src/tools/browser/relay/` (`server.ts`, `bridge.ts`, `daemon.ts`,
`protocol.ts`). Group title "omp", color cyan. Screenshot path in `tab-worker.ts`
activates the page first unless the supervisor adopted the visible tab.

Background-tab experiment scripts: scratchpad `bgtab-test.mjs`, `bgtab-raf.mjs`
(puppeteer-core 25.3, Chrome for Testing 150.0.7871.24).

Chrome docs consulted: native messaging (framing, 1 MiB / 64 MiB limits, `allowed_origins`,
`connectNative` keeps the host alive until the port closes), `tabGroups` (Chrome 89+),
`tabs.captureVisibleTab` ("captures the visible area of the currently active tab"),
`tabs.create` (`active` defaults to true, does not change window focus), `debugger`
(`onDetach` reasons `target_closed`, `canceled_by_user`).

## Implementation notes (what the live tests changed)

- Permission answers (`permission.respond`) and the maintenance calls (`permission.allow`,
  `bridge.reload`, `bridge.debug`, `bridge.bench`) are handled outside the per-client
  request queue. The first live run deadlocked because the answer was queued behind the
  navigation that was waiting for it.
- In-page scripts fall back from `userScripts` to `chrome.scripting` (isolated world) to
  the debugger's `Runtime.evaluate`, because the "Allow user scripts" toggle resets when
  the extension id changes and headless harnesses cannot click it.
- One `BrowserSession` instance per id per context. Two clients sharing a session name
  (an agent plus a recorder) used to hold separate in-memory copies and overwrite each
  other's tab list in `chrome.storage.session`.
- Every handler runs under a timeout (15 s to open a session, 90 s per call) so a slow
  browser cannot wedge a client's queue. Under heavy machine load (15-minute load average
  above 150 during testing) individual Chrome API calls took seconds to tens of seconds;
  with the machine idle the same calls take 1 to 3 ms (`sitegeist debug` shows both).
- Headless MCP clients without elicitation (`claude -p`) get an immediate denial with
  instructions instead of a 120 s stall; `sitegeist allow <host>` and
  `SITEGEIST_AUTO_ALLOW=1` cover unattended runs.
- `sitegeist reload` makes iteration possible without the extensions page.

