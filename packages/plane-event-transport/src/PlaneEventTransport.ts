/**
 * PlaneEventTransport — receives Plane CE webhooks, verifies them and emits
 * canonical PlaneAgentEvents.
 *
 * Mirrors the shape of LinearEventTransport. Differences:
 *   - Plane CE signs payloads with a static HMAC-SHA256 secret (no rotation).
 *   - Plane CE has no "App Mentions" event; we filter on assignment to a bot user.
 *
 * POC scope: registers a POST /plane-webhook endpoint on a Fastify server,
 * verifies the HMAC, translates to a PlaneAgentEvent and emits.
 *
 * The caller (edge-worker or dev-runner) MUST configure Fastify with a
 * content-type parser that stashes the raw body on `request.rawBody`
 * before this transport is registered — HMAC verification needs the
 * exact bytes Plane sent. See `scripts/dev-runner.ts` for the canonical
 * setup.
 */
import { EventEmitter } from "node:events";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
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
	 * Register the POST /plane-webhook endpoint on the given Fastify server.
	 *
	 * Pre-condition: the server has a content-type parser that preserves the
	 * raw body on `request.rawBody`. Without it HMAC verification will fail
	 * because Fastify's default JSON parser discards the original bytes.
	 */
	register(server: FastifyInstance): void {
		server.post(
			"/plane-webhook",
			async (req: FastifyRequest, reply: FastifyReply) => {
				const rawBody =
					(req as FastifyRequest & { rawBody?: string }).rawBody ?? "";
				const sig = headerValue(req.headers["x-plane-signature"]);
				const deliveryId = headerValue(req.headers["x-plane-delivery"]);

				if (this.config.verificationMode === "direct") {
					if (!verifyPlaneSignature(rawBody, sig, this.config.secret)) {
						reply.code(401);
						return { error: "invalid signature" };
					}
				} else {
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
				return { ok: true, delivery: deliveryId, emitted: agentEvent !== null };
			},
		);
	}
}

function headerValue(h: unknown): string | undefined {
	if (typeof h === "string") return h;
	if (Array.isArray(h)) return h[0];
	return undefined;
}
