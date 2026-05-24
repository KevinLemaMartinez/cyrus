import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlaneEventTransport } from "../src/PlaneEventTransport.js";
import type {
	PlaneAgentEvent,
	PlaneEventTransportConfig,
} from "../src/types.js";

const SECRET = "test-secret-xxx";
const BOT = "3322520e-b959-4cbd-8b7c-929b05e445da"; // matches fixture
const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): string {
	return readFileSync(resolve(__dirname, "fixtures", name), "utf8");
}

function sign(body: string): string {
	return createHmac("sha256", SECRET).update(body).digest("hex");
}

function buildServer() {
	const server = Fastify();
	// Preserve raw body so HMAC verification can run on the bytes Plane sent.
	server.addContentTypeParser(
		"application/json",
		{ parseAs: "string" },
		(req, body, done) => {
			(req as { rawBody?: string }).rawBody = body as string;
			try {
				done(null, JSON.parse(body as string));
			} catch (err) {
				done(err as Error, undefined);
			}
		},
	);
	return server;
}

function buildConfig(
	server: ReturnType<typeof buildServer>,
): PlaneEventTransportConfig {
	return {
		fastifyServer: server,
		secret: SECRET,
		verificationMode: "direct",
		workspaceSlug: "panfleet",
		baseUrl: "https://plane.pulp.lan",
		apiToken: "plane_api_test",
		botUserIds: [BOT],
	};
}

describe("PlaneEventTransport", () => {
	let server: ReturnType<typeof buildServer>;

	beforeEach(() => {
		server = buildServer();
	});

	afterEach(async () => {
		await server.close();
	});

	it("emits an agent event on a verified assignment payload", async () => {
		const transport = new PlaneEventTransport(buildConfig(server));
		transport.register();

		const events: PlaneAgentEvent[] = [];
		transport.on("event", (e) => events.push(e));

		const body = loadFixture("issue-updated-assigned-to-bot.json");
		const res = await server.inject({
			method: "POST",
			url: "/plane-webhook",
			headers: {
				"content-type": "application/json",
				"x-plane-signature": sign(body),
				"x-plane-delivery": "11111111-1111-1111-1111-111111111111",
			},
			payload: body,
		});

		expect(res.statusCode).toBe(200);
		expect(events).toHaveLength(1);
		expect(events[0]!.type).toBe("issue.assigned_to_bot");
	});

	it("rejects an invalid signature with 401", async () => {
		const transport = new PlaneEventTransport(buildConfig(server));
		transport.register();

		const body = loadFixture("issue-updated-assigned-to-bot.json");
		const res = await server.inject({
			method: "POST",
			url: "/plane-webhook",
			headers: {
				"content-type": "application/json",
				"x-plane-signature": "deadbeef",
				"x-plane-delivery": "22222222-2222-2222-2222-222222222222",
			},
			payload: body,
		});

		expect(res.statusCode).toBe(401);
	});

	it("emits an event when x-plane-delivery is absent (no dedupe possible)", async () => {
		const transport = new PlaneEventTransport(buildConfig(server));
		transport.register();

		const events: PlaneAgentEvent[] = [];
		transport.on("event", (e) => events.push(e));

		const body = loadFixture("issue-updated-assigned-to-bot.json");
		const res = await server.inject({
			method: "POST",
			url: "/plane-webhook",
			headers: {
				"content-type": "application/json",
				"x-plane-signature": sign(body),
				// Intentionally omit x-plane-delivery.
			},
			payload: body,
		});

		expect(res.statusCode).toBe(200);
		expect(events).toHaveLength(1);
	});

	it("dedupes deliveries by x-plane-delivery UUID", async () => {
		const transport = new PlaneEventTransport(buildConfig(server));
		transport.register();

		const events: PlaneAgentEvent[] = [];
		transport.on("event", (e) => events.push(e));

		const body = loadFixture("issue-updated-assigned-to-bot.json");
		const headers = {
			"content-type": "application/json",
			"x-plane-signature": sign(body),
			"x-plane-delivery": "33333333-3333-3333-3333-333333333333",
		};

		const r1 = await server.inject({
			method: "POST",
			url: "/plane-webhook",
			headers,
			payload: body,
		});
		const r2 = await server.inject({
			method: "POST",
			url: "/plane-webhook",
			headers,
			payload: body,
		});

		expect(r1.statusCode).toBe(200);
		expect(r2.statusCode).toBe(200);
		expect(JSON.parse(r2.body)).toMatchObject({ dedup: true });
		expect(events).toHaveLength(1);
	});
});
