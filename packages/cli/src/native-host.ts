/**
 * Chrome Native Messaging Host protocol handler.
 *
 * Chrome launches this binary with stdin/stdout piped using a length-prefixed
 * JSON protocol: each message is a 4-byte little-endian uint32 length prefix
 * followed by that many bytes of UTF-8 JSON.
 *
 * On launch we:
 *  1. Read the incoming message from the extension
 *  2. Read ~/.sitegeist/auth.json
 *  3. Ensure the daemon is running (spawn if not)
 *  4. Respond with { type: "auth_config", url, token }
 */

import { spawn } from "node:child_process";
import { isDaemonRunning, readAuth } from "./auth.js";

function writeNativeMessage(obj: unknown): void {
	const payload = Buffer.from(JSON.stringify(obj), "utf8");
	const header = Buffer.alloc(4);
	header.writeUInt32LE(payload.length, 0);
	process.stdout.write(header);
	process.stdout.write(payload);
}

function readNativeMessage(): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const headerBuf: Buffer[] = [];
		let headerLen = 0;

		const onReadable = () => {
			// Phase 1: read 4-byte header
			while (headerLen < 4) {
				const chunk = process.stdin.read(4 - headerLen);
				if (!chunk) return; // wait for more data
				headerBuf.push(chunk);
				headerLen += chunk.length;
			}

			const header = Buffer.concat(headerBuf);
			const msgLen = header.readUInt32LE(0);
			if (msgLen === 0 || msgLen > 1024 * 1024) {
				cleanup();
				resolve(null);
				return;
			}

			// Phase 2: read message body
			const bodyBuf: Buffer[] = [];
			let bodyLen = 0;
			const readBody = () => {
				while (bodyLen < msgLen) {
					const chunk = process.stdin.read(msgLen - bodyLen);
					if (!chunk) return; // wait for more data
					bodyBuf.push(chunk);
					bodyLen += chunk.length;
				}
				cleanup();
				try {
					const body = Buffer.concat(bodyBuf).toString("utf8");
					resolve(JSON.parse(body));
				} catch {
					resolve(null);
				}
			};

			// Remove this listener, add body reader
			process.stdin.removeListener("readable", onReadable);
			process.stdin.on("readable", readBody);
			readBody();
		};

		const cleanup = () => {
			process.stdin.removeAllListeners("readable");
			process.stdin.removeListener("error", reject);
			process.stdin.removeListener("end", onEnd);
		};

		const onEnd = () => {
			cleanup();
			resolve(null);
		};

		process.stdin.on("readable", onReadable);
		process.stdin.on("error", reject);
		process.stdin.on("end", onEnd);
	});
}

function ensureDaemonRunning(): void {
	if (isDaemonRunning()) return;
	// Spawn daemon detached so it outlives us
	const binPath = process.argv[1];
	const child = spawn(process.execPath, [binPath, "daemon"], {
		detached: true,
		stdio: "ignore",
	});
	child.unref();
}

export async function handleNativeMessaging(): Promise<void> {
	// Read incoming message from extension (we don't actually need its content,
	// but must consume the message per protocol)
	await readNativeMessage();

	const auth = readAuth();
	if (!auth) {
		writeNativeMessage({ type: "error", message: "No auth config. Run `sitegeist init`." });
		process.exit(0);
	}

	ensureDaemonRunning();

	writeNativeMessage({
		type: "auth_config",
		url: `ws://127.0.0.1:${auth.port}`,
		token: auth.token,
	});

	process.exit(0);
}
