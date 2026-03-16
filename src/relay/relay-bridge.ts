import type { JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "@sitegeist/shared";

type RelayStatus = { connected: boolean; lastError?: string | null };

export class RelayBridge {
	private ws: WebSocket | null = null;
	private enabled = false;
	private url = "";
	private token = "";
	private reconnectTimerId: ReturnType<typeof setTimeout> | null = null;
	private reconnectAttempt = 0;

	constructor(
		private readonly getHelloPayload: () => Promise<Record<string, unknown>>,
		private readonly onRequest: (req: JsonRpcRequest) => Promise<unknown>,
		private readonly onStatus: (status: RelayStatus) => void = () => {},
	) {}

	isConnected() {
		return this.ws?.readyState === WebSocket.OPEN;
	}

	configure({ enabled, url, token }: { enabled: boolean; url: string; token: string }) {
		this.enabled = enabled;
		this.url = url;
		this.token = token;
		if (!enabled || !url || !token) {
			this.disconnect();
			this.onStatus({ connected: false, lastError: null });
			return;
		}
		if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
		this.connect();
	}

	disconnect() {
		if (this.reconnectTimerId) {
			clearTimeout(this.reconnectTimerId);
			this.reconnectTimerId = null;
		}
		this.reconnectAttempt = 0;
		if (this.ws) {
			try {
				this.ws.close();
			} catch {}
		}
		this.ws = null;
	}

	notify(method: string, params: unknown) {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
		const msg: JsonRpcNotification = { jsonrpc: "2.0", method, params };
		try {
			this.ws.send(JSON.stringify(msg));
		} catch {}
	}

	private toWsUrl(baseUrl: string, token: string) {
		try {
			const url = new URL(baseUrl);
			url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
			url.pathname = "/v1/extension";
			url.searchParams.set("token", token);
			return url.toString();
		} catch {
			return null;
		}
	}

	private scheduleReconnect() {
		if (!this.enabled || this.reconnectTimerId) return;
		const attempt = Math.min(10, this.reconnectAttempt + 1);
		this.reconnectAttempt = attempt;
		const delay = Math.min(15_000, 250 * 2 ** (attempt - 1));
		this.reconnectTimerId = setTimeout(() => {
			this.reconnectTimerId = null;
			this.connect();
		}, delay);
	}

	private connect() {
		if (!this.enabled || !this.url || !this.token) return;
		const wsUrl = this.toWsUrl(this.url, this.token);
		if (!wsUrl) {
			this.onStatus({ connected: false, lastError: "Invalid relay URL" });
			return;
		}

		let ws: WebSocket;
		try {
			ws = new WebSocket(wsUrl);
		} catch (error) {
			this.onStatus({
				connected: false,
				lastError: error instanceof Error ? error.message : "Failed to create WebSocket",
			});
			this.scheduleReconnect();
			return;
		}

		this.ws = ws;

		ws.onopen = async () => {
			this.reconnectAttempt = 0;
			this.onStatus({ connected: true, lastError: null });
			try {
				const helloParams = await this.getHelloPayload();
				const hello: JsonRpcNotification = { jsonrpc: "2.0", method: "agent.hello", params: helloParams };
				ws.send(JSON.stringify(hello));
			} catch (error) {
				console.warn("[relay] failed to send hello:", error);
			}
		};

		ws.onclose = () => {
			if (this.ws === ws) this.ws = null;
			this.onStatus({ connected: false, lastError: null });
			this.scheduleReconnect();
		};

		ws.onerror = () => {
			this.onStatus({ connected: false, lastError: "WebSocket error" });
		};

		ws.onmessage = (event) => {
			let parsed: unknown;
			try {
				parsed = JSON.parse(String(event.data ?? ""));
			} catch {
				return;
			}

			const record = parsed as { jsonrpc?: string; id?: string | number; method?: string };
			if (record?.jsonrpc !== "2.0" || typeof record.id === "undefined" || typeof record.method !== "string") return;
			void this.handleRequest(ws, parsed as JsonRpcRequest);
		};
	}

	private async handleRequest(ws: WebSocket, req: JsonRpcRequest) {
		try {
			const result = await this.onRequest(req);
			const resp: JsonRpcResponse = { jsonrpc: "2.0", id: req.id, result };
			ws.send(JSON.stringify(resp));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error ?? "error");
			const resp: JsonRpcResponse = { jsonrpc: "2.0", id: req.id, error: { code: -32000, message } };
			try {
				ws.send(JSON.stringify(resp));
			} catch {}
		}
	}
}
