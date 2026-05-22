/**
 * Dev runner — mounts `PlaneEventTransport` on a real Fastify server and
 * prints every emitted PlaneAgentEvent to stdout. Used to validate the
 * end-to-end webhook → HMAC → translate → emit chain against a real
 * Plane CE instance.
 *
 * Required environment:
 *   PLANE_BASE_URL          e.g. https://plane.pulp.lan
 *   PLANE_WORKSPACE_SLUG    e.g. panfleet
 *   PLANE_BOT_USER_ID       UUID of the bot user that triggers assignments
 *   PLANE_BOT_TOKEN         API token of that bot (not used by transport yet,
 *                            kept for parity with the tracker service)
 *   PLANE_WEBHOOK_SECRET    The "secret" string Plane shows in the webhook UI
 *                            (e.g. plane_wh_xxxxxxxxxxxxx)
 *
 * Optional:
 *   LISTEN_HOST             default 0.0.0.0
 *   LISTEN_PORT             default 3000
 *
 * Run with:
 *   pnpm --filter cyrus-plane-event-transport dev:server
 *
 * (or directly: pnpm exec tsx scripts/dev-runner.ts)
 */
import Fastify, { type FastifyRequest } from "fastify";
import { PlaneEventTransport } from "../src/PlaneEventTransport.js";
import type { PlaneAgentEvent } from "../src/types.js";

function requireEnv(name: string): string {
	const v = process.env[name];
	if (!v || v.length === 0) {
		console.error(`✗ missing env var ${name}`);
		process.exit(1);
	}
	return v;
}

const host = process.env.LISTEN_HOST ?? "0.0.0.0";
const port = Number.parseInt(process.env.LISTEN_PORT ?? "3000", 10);

async function main() {
	const server = Fastify({ logger: false, trustProxy: true });

	// Preserve the raw body so HMAC verification can hash the exact bytes Plane sent.
	server.addContentTypeParser(
		"application/json",
		{ parseAs: "string" },
		(
			req: FastifyRequest,
			body: string,
			done: (err: Error | null, result?: unknown) => void,
		) => {
			(req as FastifyRequest & { rawBody: string }).rawBody = body;
			try {
				done(null, JSON.parse(body));
			} catch (err) {
				done(err as Error);
			}
		},
	);

	server.get("/healthz", async () => ({ ok: true }));

	const transport = new PlaneEventTransport({
		fastifyServer: server,
		secret: requireEnv("PLANE_WEBHOOK_SECRET"),
		verificationMode: "direct",
		workspaceSlug: requireEnv("PLANE_WORKSPACE_SLUG"),
		baseUrl: requireEnv("PLANE_BASE_URL"),
		apiToken: requireEnv("PLANE_BOT_TOKEN"),
		botUserId: requireEnv("PLANE_BOT_USER_ID"),
	});

	transport.on("event", (e: PlaneAgentEvent) => {
		const stamp = new Date().toISOString();
		console.log(`\n[${stamp}] event=${e.type}`);
		if (e.type === "issue.assigned_to_bot") {
			console.log(
				`  project=${e.projectId}  workspace=${e.workspaceSlug}\n` +
					`  issue.id=${e.issue.id}  sequence_id=${e.issue.sequence_id}\n` +
					`  issue.name="${e.issue.name}"\n` +
					`  state=${e.issue.state.group}/${e.issue.state.name}\n` +
					`  actor=${e.actor.email} (${e.actor.display_name})`,
			);
		}
	});

	transport.on("error", (err) => {
		console.error("✗ transport error:", err);
	});

	transport.register();

	await server.listen({ host, port });

	console.log(`✓ plane-event-transport listening on http://${host}:${port}`);
	console.log(`  webhook endpoint: POST /plane-webhook`);
	console.log(`  healthcheck:      GET  /healthz`);
	console.log();
}

main().catch((err) => {
	console.error("fatal:", err);
	process.exit(1);
});
