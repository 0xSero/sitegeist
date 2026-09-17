import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeClient, listSockets } from "./client.ts";
import { runNativeHost } from "./host.ts";
import { install, isInstalled } from "./install.ts";
import { runMcpServer } from "./mcp.ts";
import { writePiExtension } from "./pi-extension.ts";
import { VERSION } from "./version.ts";

const HELP = `sitegeist ${VERSION} - browser bridge for coding harnesses

Usage:
  sitegeist mcp             Run the MCP server on stdio (installs the native host on first run)
  sitegeist install         Write the native messaging manifest for every Chromium browser found
  sitegeist status          Show whether the extension is reachable
  sitegeist reload          Reload the extension (picks up a rebuilt dist-chrome)
  sitegeist allow <host>    Allow agents to open a site (subdomains included)
  sitegeist debug           Print the extension's bridge state and recent timing log
  sitegeist pi-extension    Write a pi extension to ~/.pi/agent/extensions/sitegeist.ts
  sitegeist host            (internal) native messaging host, spawned by the browser

Harness setup:
  claude mcp add sitegeist -- sitegeist mcp
  codex:  [mcp_servers.sitegeist]  command = "sitegeist"  args = ["mcp"]
  omp:    add an MCP server entry running "sitegeist mcp"
  pi:     sitegeist pi-extension
`;

async function status(): Promise<void> {
	const sockets = listSockets();
	console.log(`native host manifest: ${isInstalled() ? "installed" : "missing (run: sitegeist install)"}`);
	if (sockets.length === 0) {
		console.log("bridge sockets: none. Is the sitegeist extension loaded in a running Chromium browser?");
		process.exitCode = 1;
		return;
	}
	for (const path of sockets) {
		const client = new BridgeClient({ name: "status" });
		try {
			await client.connect(path);
			console.log(`${path}: host ok, extension ${client.extensionConnected ? "connected" : "not connected"}`);
			if (client.extensionConnected) {
				const ctx = (await client.call("tabs.context", {}, 5000)) as { tabs: unknown[] };
				console.log(`  session tabs: ${ctx.tabs.length}`);
			}
		} catch (err) {
			console.log(`${path}: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			client.close();
		}
	}
}

async function main(): Promise<void> {
	const [command] = process.argv.slice(2);
	switch (command) {
		case "host":
			runNativeHost();
			return;
		case "mcp":
			await runMcpServer();
			return;
		case "install": {
			const result = install({ force: process.argv.includes("--force") });
			console.log(`launcher: ${result.launcher}`);
			for (const f of result.written) console.log(`wrote   ${f}`);
			for (const f of result.skipped) console.log(`current ${f}`);
			if (result.written.length + result.skipped.length === 0) console.log("no Chromium browser profile directories found");
			console.log("Reload the sitegeist extension once if it was loaded before this install.");
			return;
		}
		case "status":
			await status();
			return;
		case "allow": {
			const host = process.argv[3];
			if (!host) throw new Error("usage: sitegeist allow <host>");
			const client = new BridgeClient({ name: "allow" });
			await client.connect();
			console.log(JSON.stringify(await client.call("permission.allow", { host }, 5000)));
			client.close();
			return;
		}
		case "debug": {
			const client = new BridgeClient({ name: "debug" });
			await client.connect();
			const info = (await client.call("bridge.debug", {}, 5000)) as Record<string, unknown>;
			const bench = (await client.call("bridge.bench", {}, 30000)) as Record<string, unknown>;
			console.log(JSON.stringify({ ...info, bench }, null, 2));
			client.close();
			return;
		}
		case "reload": {
			// Refuse to reload onto a broken bundle: a half-written dist-chrome unloads the extension.
			const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist-chrome");
			const required = ["manifest.json", "background.js", "sidepanel.js", "sidepanel.html", "app.css"];
			const missing = required.filter((f) => !existsSync(join(dist, f)));
			if (existsSync(dist) && missing.length > 0) {
				throw new Error(`dist-chrome is incomplete (missing ${missing.join(", ")}); run \`npm run build\` first`);
			}
			const client = new BridgeClient({ name: "reload" });
			await client.connect();
			console.log(JSON.stringify(await client.call("bridge.reload", {}, 5000)));
			client.close();
			return;
		}
		case "pi-extension":
			console.log(`wrote ${writePiExtension(process.argv[3])}`);
			return;
		case "--version":
		case "-v":
			console.log(VERSION);
			return;
		default:
			process.stdout.write(HELP);
			if (command && command !== "--help" && command !== "-h") process.exitCode = 1;
	}
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
