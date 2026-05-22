/**
 * PlaneEventTransport — receives Plane CE webhooks, verifies them and emits
 * canonical PlaneAgentEvents.
 *
 * Mirrors the shape of LinearEventTransport: the Fastify server comes in via
 * the constructor's config, and `register()` is called with no arguments.
 *
 * Plane CE signs payloads with a static HMAC-SHA256 secret. We verify against
 * the raw bytes the server received, so the Fastify instance passed in MUST
 * have a content-type parser that preserves `request.rawBody`.
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

const DEDUPE_CAPACITY = 1000;

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
	private seenDeliveries: Set<string> = new Set();
	private deliveryOrder: string[] = [];

	constructor(config: PlaneEventTransportConfig) {
		super();
		this.config = config;
	}

	register(): void {
		const server = this.config.fastifyServer;
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

				if (deliveryId && this.seenDeliveries.has(deliveryId)) {
					reply.code(200);
					return { dedup: true, delivery: deliveryId };
				}
				if (deliveryId) {
					this.rememberDelivery(deliveryId);
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

	private rememberDelivery(deliveryId: string): void {
		this.seenDeliveries.add(deliveryId);
		this.deliveryOrder.push(deliveryId);
		if (this.deliveryOrder.length > DEDUPE_CAPACITY) {
			const evicted = this.deliveryOrder.shift();
			if (evicted) this.seenDeliveries.delete(evicted);
		}
	}
}

function headerValue(h: unknown): string | undefined {
	if (typeof h === "string") return h;
	if (Array.isArray(h)) return h[0];
	return undefined;
}
