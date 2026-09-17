# sitegeist (CLI)

Bridge between coding harnesses and the Sitegeist browser extension. Any MCP client
(Claude Code, Codex, omp) and pi can drive a Chromium browser through it. Each harness
gets its own tab group and works in the background while you keep using your tabs.

```
harness ── stdio MCP ── sitegeist mcp ── unix socket ── native host ── native messaging ── extension
```

Nothing listens on the network. The browser spawns the native host; the host owns a
socket in `/tmp/sitegeist-bridge-<user>/` (0700 directory, 0600 socket) that only your
user can reach. The client refuses sockets and directories it does not own.

## Install

```bash
npm install -g sitegeist        # or: npm link from this directory
sitegeist install               # writes the native-messaging manifest for every Chromium browser found
```

`sitegeist mcp` runs the installer itself on first use, so a harness configured to start
it needs no extra step. Reload the extension once after the first install.

## Commands

| Command | Purpose |
| --- | --- |
| `sitegeist mcp` | stdio MCP server exposing the browser tools |
| `sitegeist install [--force]` | write the native host manifest (Chrome, Chromium, Brave, Edge, Arc, Vivaldi, Opera; Linux and Windows too) |
| `sitegeist status` | is a browser reachable, is the extension connected |
| `sitegeist allow <host>` | let agents open a site without a prompt (subdomains included) |
| `sitegeist reload` | reload the extension (after rebuilding `dist-chrome`) |
| `sitegeist debug` | bridge state, recent request timings, Chrome API benchmark |
| `sitegeist pi-extension` | write `~/.pi/agent/extensions/sitegeist.ts` for pi |

## Harness setup

```bash
claude mcp add sitegeist -- sitegeist mcp
sitegeist pi-extension
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.sitegeist]
command = "sitegeist"
args = ["mcp"]
```

omp: add an MCP server entry that runs `sitegeist mcp`.

## Permissions

By default the extension asks before an agent opens a new site. MCP clients that support
elicitation (Claude Code, Codex) show the prompt inline; otherwise answer it in the
Sitegeist side panel under Settings > Bridge, run `sitegeist allow <host>`, or switch the
mode to "allow any site" there. pi: set `SITEGEIST_AUTO_ALLOW=1` to auto-approve.

`SITEGEIST_SESSION=<name>` makes a harness re-adopt the same tab group across restarts.
`SITEGEIST_CLIENT_NAME` overrides the tab group label.

## MCP tools

`tabs_context`, `tabs_create`, `tabs_close`, `tabs_select`, `tabs_show`, `navigate`,
`screenshot`, `read_page`, `get_page_text`, `get_page_html`, `find`, `click`, `hover`,
`type`, `press`, `fill`, `scroll`, `drag`, `run_js`, `wait`, `read_console`,
`read_network`. `tabs_show` is the only tool that changes what the user sees.
