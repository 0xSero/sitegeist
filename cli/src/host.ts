/**
 * Native messaging host. The browser spawns this process when the extension
 * connects; it owns the unix socket harness clients dial and relays frames both
 * ways, adding `clientId` on the way in and stripping it on the way out.
 * No browser logic lives here.
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import type { ClientToHost, ExtToHost, HostToClient, HostToExt } from "../../src/bridge/protocol.ts";
import { MAX_FRAME_FROM_EXTENSION, MAX_FRAME_TO_EXTENSION } from "../../src/bridge/protocol.ts";
import { encodeFrame, FrameParser } from "./framing.ts";
import { socketDir, socketPath } from "./paths.ts";
import { VERSION } from "./version.ts";

interface Client {
	id: string;
	socket: Socket;
	hello?: ClientToHost & { type: "hello" };
}

const clients = new Map<string, Client>();
let extensionReady = false;
let seq = 0;

function toExtension(message: HostToExt): void {
	const frame = encodeFrame(message);
	if (frame.length > MAX_FRAME_TO_EXTENSION) {
		// Never let one oversized frame kill the native port.
		const failing = message as { clientId?: string; id?: number };
		if (failing.clientId && failing.id !== undefined) {
			toClient(failing.clientId, {
				type: "response",
				id: failing.id,
				error: { code: "bad_params", message: `Request exceeds ${MAX_FRAME_TO_EXTENSION} bytes` },
			});
		}
		return;
	}
	process.stdout.write(frame);
}

function toClient(clientId: string, message: HostToClient): void {
	const client = clients.get(clientId);
	if (!client || client.socket.destroyed) return;
	client.socket.write(encodeFrame(message));
}

function onExtensionMessage(message: ExtToHost): void {
	switch (message.type) {
		case "hello":
			extensionReady = true;
			for (const id of clients.keys()) toClient(id, { type: "extension_status", connected: true });
			// The extension restarted; re-announce every live client so it recreates sessions.
			for (const client of clients.values()) {
				if (client.hello) toExtension({ type: "client_connected", clientId: client.id, client: client.hello.client });
			}
			return;
		case "response":
			toClient(message.clientId, { type: "response", id: message.id, result: message.result, error: message.error });
			return;
		case "event":
			if (message.clientId) toClient(message.clientId, { type: "event", event: message.event, data: message.data });
			else for (const id of clients.keys()) toClient(id, { type: "event", event: message.event, data: message.data });
			return;
		case "pong":
			return;
	}
}

function onClientMessage(client: Client, message: ClientToHost): void {
	if (message.type === "hello") {
		client.hello = message;
		toClient(client.id, { type: "welcome", clientId: client.id, hostVersion: VERSION, extensionConnected: extensionReady });
		toExtension({ type: "client_connected", clientId: client.id, client: message.client });
		return;
	}
	if (message.type === "request") {
		if (!client.hello) {
			toClient(client.id, { type: "response", id: message.id, error: { code: "bad_params", message: "Send hello first" } });
			return;
		}
		toExtension({ type: "request", clientId: client.id, id: message.id, method: message.method, params: message.params });
	}
}

function sweepStaleSockets(dir: string): void {
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".sock")) continue;
		const pid = Number.parseInt(name, 10);
		if (!Number.isInteger(pid)) continue;
		try {
			process.kill(pid, 0);
		} catch {
			rmSync(join(dir, name), { force: true });
		}
	}
}

export function runNativeHost(): void {
	const dir = socketDir();
	if (process.platform !== "win32") {
		if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
		chmodSync(dir, 0o700);
		const st = statSync(dir);
		if (st.uid !== process.getuid?.()) {
			process.stderr.write(`[sitegeist-host] ${dir} is owned by another user; refusing to start\n`);
			process.exit(1);
		}
		sweepStaleSockets(dir);
	}
	const path = socketPath(process.pid);
	rmSync(path, { force: true });

	const server = createServer((socket) => {
		const id = `c${++seq}-${process.pid}`;
		const client: Client = { id, socket };
		clients.set(id, client);
		const parser = new FrameParser(MAX_FRAME_TO_EXTENSION);
		socket.on("data", (chunk) => {
			let messages: unknown[];
			try {
				messages = parser.push(chunk);
			} catch (err) {
				process.stderr.write(`[sitegeist-host] bad frame from ${id}: ${String(err)}\n`);
				socket.destroy();
				return;
			}
			for (const m of messages) onClientMessage(client, m as ClientToHost);
		});
		const drop = () => {
			if (!clients.delete(id)) return;
			toExtension({ type: "client_disconnected", clientId: id });
		};
		socket.on("close", drop);
		socket.on("error", drop);
	});
	server.listen(path, () => {
		if (process.platform !== "win32") chmodSync(path, 0o600);
	});

	// stdin: frames from the extension
	const parser = new FrameParser(MAX_FRAME_FROM_EXTENSION);
	process.stdin.on("data", (chunk: Buffer) => {
		let messages: unknown[];
		try {
			messages = parser.push(chunk);
		} catch (err) {
			process.stderr.write(`[sitegeist-host] bad frame from extension: ${String(err)}\n`);
			return;
		}
		for (const m of messages) onExtensionMessage(m as ExtToHost);
	});

	const shutdown = () => {
		for (const client of clients.values()) client.socket.destroy();
		server.close();
		rmSync(path, { force: true });
		process.exit(0);
	};
	process.stdin.on("end", shutdown);
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	const ping = setInterval(() => toExtension({ type: "ping" }), 20000);
	ping.unref();
}
