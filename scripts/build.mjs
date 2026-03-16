import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, context } from "esbuild";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, "..");
const isWatch = process.argv.includes("--watch");
const staticDir = join(packageRoot, "static");

// Chrome only
const targetBrowser = "chrome";
const extensionOutDir = join(packageRoot, "dist-chrome");
const cliOutDir = join(packageRoot, "dist-cli");
const relayOutDir = join(packageRoot, "dist-relay");
const electronAgentOutDir = join(packageRoot, "dist-electron-agent");

const entryPoints = {
	sidepanel: join(packageRoot, "src/sidepanel.ts"),
	debug: join(packageRoot, "src/debug.ts"),
	icons: join(packageRoot, "src/icons.ts"),
	background: join(packageRoot, "src/background.ts"),
	offscreen: join(packageRoot, "src/offscreen.ts"),
	"content-recording": join(packageRoot, "src/content-recording.ts"),
};

rmSync(extensionOutDir, { recursive: true, force: true });
mkdirSync(extensionOutDir, { recursive: true });
mkdirSync(cliOutDir, { recursive: true });
mkdirSync(relayOutDir, { recursive: true });
mkdirSync(electronAgentOutDir, { recursive: true });

const buildOptions = {
	absWorkingDir: packageRoot,
	entryPoints,
	bundle: true,
	outdir: extensionOutDir,
	format: "esm",
	target: ["chrome120"],
	platform: "browser",
	sourcemap: isWatch ? "inline" : true,
	entryNames: "[name]",
	loader: {
		".ts": "ts",
		".tsx": "tsx",
	},
	define: {
		"process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? (isWatch ? "development" : "production")),
		"process.env.TARGET_BROWSER": JSON.stringify(targetBrowser),
		global: "globalThis",
	},
	inject: [join(packageRoot, "scripts/process-shim.js")],
	// Force all mini-lit and lit imports to resolve to sitegeist's node_modules
	alias: {
		process: join(packageRoot, "scripts/process-shim.js"),
		"@sitegeist/shared": join(packageRoot, "packages/shared/src/index.ts"),
		"@mariozechner/mini-lit": join(packageRoot, "node_modules/@mariozechner/mini-lit"),
		lit: join(packageRoot, "node_modules/lit"),
		"lit/decorators.js": join(packageRoot, "node_modules/lit/decorators.js"),
		"lit/directives/class-map.js": join(packageRoot, "node_modules/lit/directives/class-map.js"),
		"lit/directives/unsafe-html.js": join(packageRoot, "node_modules/lit/directives/unsafe-html.js"),
	},
};

// Get all files from static directory
const getStaticFiles = () => {
	return readdirSync(staticDir).map((file) => join("static", file));
};

const copyStatic = () => {
	// Use browser-specific manifest
	const manifestSource = join(packageRoot, `static/manifest.${targetBrowser}.json`);
	const manifestDest = join(extensionOutDir, "manifest.json");
	copyFileSync(manifestSource, manifestDest);

	// Copy all files from static/ directory (except manifest files)
	const staticFiles = getStaticFiles();
	for (const relative of staticFiles) {
		const filename = relative.replace("static/", "");
		// Skip manifest files - we already copied the correct one above
		if (filename.startsWith("manifest.")) continue;

		const source = join(packageRoot, relative);
		const destination = join(extensionOutDir, filename);
		copyFileSync(source, destination);
	}

	// Copy PDF.js worker from node_modules (check both local and monorepo root)
	let pdfWorkerSource = join(packageRoot, "node_modules/pdfjs-dist/build/pdf.worker.min.mjs");
	if (!existsSync(pdfWorkerSource)) {
		pdfWorkerSource = join(packageRoot, "../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs");
	}
	const pdfWorkerDestDir = join(extensionOutDir, "pdfjs-dist/build");
	mkdirSync(pdfWorkerDestDir, { recursive: true });
	const pdfWorkerDest = join(pdfWorkerDestDir, "pdf.worker.min.mjs");
	copyFileSync(pdfWorkerSource, pdfWorkerDest);

	console.log(`Built for ${targetBrowser} in ${extensionOutDir}`);
};

const run = async () => {
	if (isWatch) {
		const ctx = await context(buildOptions);
		await ctx.watch();
		copyStatic();
		await buildNodeTargets();

		// Watch the entire static directory
		watch(staticDir, { recursive: true }, (eventType) => {
			if (eventType === "change") {
				console.log(`\nStatic files changed, copying...`);
				copyStatic();
			}
		});

		// Watch the manifest file for the target browser
		const manifestSource = join(packageRoot, `static/manifest.${targetBrowser}.json`);
		watch(manifestSource, (eventType) => {
			if (eventType === "change") {
				console.log(`\nManifest changed, copying...`);
				copyStatic();
			}
		});

		process.stdout.write("Watching for changes...\n");
	} else {
		await build(buildOptions);
		copyStatic();
		await buildNodeTargets();
	}
};

const nodeBaseOptions = {
	absWorkingDir: packageRoot,
	bundle: true,
	format: "esm",
	platform: "node",
	target: ["node20"],
	sourcemap: isWatch ? "inline" : true,
	define: {
		"process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? (isWatch ? "development" : "production")),
	},
};

async function buildNodeTargets() {
	await build({
		...nodeBaseOptions,
		entryPoints: { sitegeist: join(packageRoot, "packages/cli/src/main.ts") },
		outdir: cliOutDir,
	});

	await build({
		...nodeBaseOptions,
		entryPoints: {
			relay: join(packageRoot, "packages/cli/src/main.ts"),
			"relay-daemon": join(packageRoot, "packages/cli/src/daemon.ts"),
		},
		outdir: relayOutDir,
	});

	await build({
		...nodeBaseOptions,
		entryPoints: {
			"electron-agent": join(packageRoot, "packages/electron-agent/src/main.ts"),
		},
		outdir: electronAgentOutDir,
	});
}

run().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
