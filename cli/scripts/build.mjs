import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "dist");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
	absWorkingDir: root,
	entryPoints: { index: join(root, "src/index.ts") },
	bundle: true,
	platform: "node",
	target: ["node20"],
	format: "esm",
	outdir: outDir,
	banner: { js: "#!/usr/bin/env node" },
	// Keep the MCP SDK external so its own dependency tree resolves normally.
	external: ["@modelcontextprotocol/sdk", "zod"],
	sourcemap: true,
	logLevel: "info",
});
chmodSync(join(outDir, "index.js"), 0o755);
