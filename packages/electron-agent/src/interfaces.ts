import type { JsonRpcRequest } from "@sitegeist/shared";

export interface RelayTransport {
	send(payload: unknown): void;
}

export interface RelayRpcHandler {
	onRequest(request: JsonRpcRequest): Promise<unknown>;
}
