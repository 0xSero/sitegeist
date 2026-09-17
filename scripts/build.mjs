import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
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
const outDir = join(packageRoot, "dist-chrome");

const entryPoints = {
	sidepanel: join(packageRoot, "src/sidepanel.ts"),
	debug: join(packageRoot, "src/debug.ts"),
	icons: join(packageRoot, "src/icons.ts"),
	background: join(packageRoot, "src/background.ts"),
};

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const buildOptions = {
	absWorkingDir: packageRoot,
	entryPoints,
	bundle: true,
	outdir: outDir,
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
	// Let bare imports inside the bundled pi-mono source resolve against pi-mono's
	// installed dependencies (openai, @anthropic-ai/sdk, typebox, ...).
	nodePaths: [join(packageRoot, "../pi-mono/node_modules")],
	// Force all mini-lit and lit imports to resolve to sitegeist's node_modules
	alias: {
		process: join(packageRoot, "scripts/process-shim.js"),
		"@mariozechner/mini-lit": join(packageRoot, "node_modules/@mariozechner/mini-lit"),
		// Bundle the sibling pi-mono packages straight from TypeScript source. Their
		// published entrypoints are dist/ builds that require the tsgo toolchain; pointing
		// esbuild at src/ lets us build without pre-compiling them.
		"@mariozechner/pi-ai": join(packageRoot, "../pi-mono/packages/ai/src/index.ts"),
		"@mariozechner/pi-agent-core": join(packageRoot, "../pi-mono/packages/agent/src/index.ts"),
		"@mariozechner/pi-web-ui": join(packageRoot, "../pi-mono/packages/web-ui/src/index.ts"),
		lit: join(packageRoot, "node_modules/lit"),
		"lit/decorators.js": join(packageRoot, "node_modules/lit/decorators.js"),
		"lit/directives/class-map.js": join(packageRoot, "node_modules/lit/directives/class-map.js"),
		"lit/directives/unsafe-html.js": join(packageRoot, "node_modules/lit/directives/unsafe-html.js"),
	},
};

// ============================================================================
// VERSIONING
// ============================================================================
// Every production build bumps the version. Each component runs 1..10; when one
// would exceed 10 it rolls over to 1 and the next-higher component increments:
//   1.1.1 -> 1.1.2 -> ... -> 1.1.10 -> 1.2.1 -> ... -> 1.10.10 -> 2.1.1 -> ...
// Major caps at 10 (stays at 10.10.10). Watch/dev rebuilds do NOT bump.
const computeNextVersion = (version) => {
	const parts = String(version)
		.split(".")
		.map((p) => Number.parseInt(p, 10));
	let [major, minor, patch] = parts;
	// If the current version is outside the 1..10 scheme, snap to the baseline.
	const inScheme = [major, minor, patch].every((n) => Number.isInteger(n) && n >= 1 && n <= 10);
	if (!inScheme) return "1.1.1";
	patch += 1;
	if (patch > 10) {
		patch = 1;
		minor += 1;
	}
	if (minor > 10) {
		minor = 1;
		major += 1;
	}
	if (major > 10) {
		return "10.10.10"; // cap
	}
	return `${major}.${minor}.${patch}`;
};

const bumpVersion = () => {
	const manifestPath = join(packageRoot, "static/manifest.chrome.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const current = manifest.version || "1.0.0";
	const next = computeNextVersion(current);
	if (next === current) {
		console.log(`Version: ${current} (capped)`);
		return next;
	}
	manifest.version = next;
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);

	// Keep package.json in sync so the repo version matches the shipped manifest.
	try {
		const pkgPath = join(packageRoot, "package.json");
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
		pkg.version = next;
		writeFileSync(pkgPath, `${JSON.stringify(pkg, null, "\t")}\n`);
	} catch {
		// non-fatal
	}

	console.log(`Version: ${current} -> ${next}`);
	return next;
};

// Get all files from static directory
const getStaticFiles = () => {
	return readdirSync(staticDir).map((file) => join("static", file));
};

const copyStatic = () => {
	// Use browser-specific manifest
	const manifestSource = join(packageRoot, `static/manifest.${targetBrowser}.json`);
	const manifestDest = join(outDir, "manifest.json");
	copyFileSync(manifestSource, manifestDest);

	// Copy all files from static/ directory (except manifest files)
	const staticFiles = getStaticFiles();
	for (const relative of staticFiles) {
		const filename = relative.replace("static/", "");
		// Skip manifest files - we already copied the correct one above
		if (filename.startsWith("manifest.")) continue;

		const source = join(packageRoot, relative);
		const destination = join(outDir, filename);
		copyFileSync(source, destination);
	}

	// Copy PDF.js worker from node_modules (check both local and monorepo root)
	let pdfWorkerSource = join(packageRoot, "node_modules/pdfjs-dist/build/pdf.worker.min.mjs");
	if (!existsSync(pdfWorkerSource)) {
		pdfWorkerSource = join(packageRoot, "../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs");
	}
	const pdfWorkerDestDir = join(outDir, "pdfjs-dist/build");
	mkdirSync(pdfWorkerDestDir, { recursive: true });
	const pdfWorkerDest = join(pdfWorkerDestDir, "pdf.worker.min.mjs");
	copyFileSync(pdfWorkerSource, pdfWorkerDest);

	console.log(`Built for ${targetBrowser} in ${outDir}`);
};

const run = async () => {
	if (isWatch) {
		const ctx = await context(buildOptions);
		await ctx.watch();
		copyStatic();

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
		bumpVersion();
		await build(buildOptions);
		copyStatic();
		// The stylesheet is generated by Tailwind; without it the side panel renders unstyled.
		// `npm run build` also runs this step, but a direct invocation must produce a complete bundle.
		execSync("npx tailwindcss -i ./src/app.css -o ./dist-chrome/app.css --minify", {
			cwd: packageRoot,
			stdio: "inherit",
		});
	}
};

run().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
