/**
 * PlaneEventTransport — receives Plane CE webhooks, verifies them and emits
 * canonical PlaneAgentEvents.
 *
 * Mirrors the shape of LinearEventTransport. Differences:
 *   - Plane CE signs payloads with a static HMAC-SHA256 secret (no rotation).
 *   - Plane CE has no "App Mentions" event; we filter on assignment to a bot user.
 *
 * POC scope: register a /plane-webhook endpoint on a Fastify server, verify
 * the HMAC, translate to a PlaneAgentEvent and emit. The edge-worker wires
 * up listeners.
 */
import { EventEmitter } from "node:events";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
	translatePayload,
	verifyPlaneSignature,
} from "./plane-webhook-utils.js";
import type {
	PlaneEventTransportConfig,
	PlaneEventTransportEvents,
	PlaneWebhookEnvelope,
} from "./types.js";

export declare interface PlaneEventTransport {
	on<K extends keyof PlaneEventTransportEvents>(
		event: K,
		listener: PlaneEventTransportEvents[K],
	): this;
	emit<K extends keyof PlaneEventTransportEvents>(
		event: K,
		...args: Parameters<PlaneEventTransportEvents[K]>
	): boolean;
}

export class PlaneEventTransport extends EventEmitter {
	private config: PlaneEventTransportConfig;

	constructor(config: PlaneEventTransportConfig) {
		super();
		this.config = config;
	}

	/**
	 * Register the /plane-webhook POST endpoint on the Fastify server passed
	 * by the edge-worker. Caller is responsible for `server.listen()`.
	 */
	register(server: {
		post: (
			path: string,
			handler: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
		) => void;
	}): void {
		server.post("/plane-webhook", async (req, reply) => {
			// 1. Capture raw body for HMAC verification. Fastify by default
			// parses JSON, so we need to ensure the upstream Fastify setup
			// preserves the raw body (e.g. via `fastify-raw-body`). For the
			// POC we accept that the edge-worker wires that plugin globally.
			const rawBody = (req as { rawBody?: string }).rawBody ?? "";
			const signature = req.headers["x-plane-signature"];
			const sig =
				typeof signature === "string"
					? signature
					: Array.isArray(signature)
						? signature[0]
						: undefined;

			if (this.config.verificationMode === "direct") {
				if (!verifyPlaneSignature(rawBody, sig, this.config.secret)) {
					reply.code(401);
					return { error: "invalid signature" };
				}
			} else {
				// "proxy" mode: Bearer token (TODO POC+1)
				reply.code(501);
				return { error: "proxy mode not implemented in POC" };
			}

			const envelope = req.body as PlaneWebhookEnvelope;
			const agentEvent = translatePayload(envelope, {
				botUserId: this.config.botUserId,
				workspaceSlug: this.config.workspaceSlug,
			});

			if (agentEvent) {
				this.emit("event", agentEvent);
			}

			reply.code(200);
			return { ok: true };
		});
	}
}
