/**
 * Socket client: dials the native host's unix socket, checks its ownership, and
 * exposes request/response plus events. One instance per harness process.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import type { ClientToHost, HostToClient, RpcError } from "../../src/bridge/protocol.ts";
import { MAX_FRAME_FROM_EXTENSION } from "../../src/bridge/protocol.ts";
import { encodeFrame, FrameParser } from "./framing.ts";
import { assertSecurePath, socketDir } from "./paths.ts";
import { VERSION } from "./version.ts";

export class BridgeRpcError extends Error {
	constructor(readonly rpc: RpcError) {
		super(rpc.message);
	}
}

export interface ClientOptions {
	name: string;
	session?: string;
	/** Fires for permission prompts and other pushed events. */
	onEvent?: (event: string, data: Record<string, unknown>) => void;
	onExtensionStatus?: (connected: boolean) => void;
	requestTimeoutMs?: number;
}

/** Live sockets, newest host first. */
export function listSockets(): string[] {
	const dir = socketDir();
	if (process.platform === "win32") return [dir];
	if (!existsSync(dir)) return [];
	assertSecurePath(dir, "dir");
	return readdirSync(dir)
		.filter((n) => n.endsWith(".sock"))
		.map((n) => join(dir, n))
		.filter((p) => {
			const pid = Number.parseInt(p.slice(p.lastIndexOf("/") + 1), 10);
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		})
		.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

export class BridgeClient {
	private socket?: Socket;
	private seq = 0;
	private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
	clientId?: string;
	extensionConnected = false;

	constructor(private readonly options: ClientOptions) {}

	get connected(): boolean {
		return this.socket !== undefined && !this.socket.destroyed;
	}

	async connect(path?: string): Promise<void> {
		const target = path ?? listSockets()[0];
		if (!target) {
			throw new Error(
				"No sitegeist browser bridge is running. Make sure the sitegeist extension is loaded in a Chromium browser and that `sitegeist install` has been run.",
			);
		}
		if (process.platform !== "win32") assertSecurePath(target, "socket");
		await new Promise<void>((resolve, reject) => {
			const socket = connect(target);
			const parser = new FrameParser(MAX_FRAME_FROM_EXTENSION);
			let welcomed = false;
			socket.once("error", (err) => {
				if (!welcomed) reject(err);
			});
			socket.on("data", (chunk) => {
				let messages: unknown[];
				try {
					messages = parser.push(chunk);
				} catch (err) {
					socket.destroy(err as Error);
					return;
				}
				for (const m of messages) {
					const msg = m as HostToClient;
					if (msg.type === "welcome") {
						welcomed = true;
						this.clientId = msg.clientId;
						this.extensionConnected = msg.extensionConnected;
						resolve();
					} else this.onMessage(msg);
				}
			});
			socket.on("close", () => {
				for (const p of this.pending.values()) {
					clearTimeout(p.timer);
					p.reject(new Error("Bridge connection closed"));
				}
				this.pending.clear();
				if (this.socket === socket) this.socket = undefined;
			});
			this.socket = socket;
			const hello: ClientToHost = {
				type: "hello",
				client: { name: this.options.name, session: this.options.session, version: VERSION },
			};
			socket.write(encodeFrame(hello));
		});
	}

	private onMessage(msg: HostToClient): void {
		if (msg.type === "response") {
			const p = this.pending.get(msg.id);
			if (!p) return;
			this.pending.delete(msg.id);
			clearTimeout(p.timer);
			if (msg.error) p.reject(new BridgeRpcError(msg.error));
			else p.resolve(msg.result);
		} else if (msg.type === "event") {
			this.options.onEvent?.(msg.event, msg.data);
		} else if (msg.type === "extension_status") {
			this.extensionConnected = msg.connected;
			this.options.onExtensionStatus?.(msg.connected);
		}
	}

	async call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
		if (!this.connected) await this.connect();
		const socket = this.socket;
		if (!socket) throw new Error("Not connected");
		const id = ++this.seq;
		const timeout = timeoutMs ?? this.options.requestTimeoutMs ?? 120000;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method} timed out after ${timeout} ms`));
			}, timeout);
			this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
			const req: ClientToHost = { type: "request", id, method, params };
			socket.write(encodeFrame(req));
		});
	}

	close(): void {
		this.socket?.destroy();
		this.socket = undefined;
	}
}
