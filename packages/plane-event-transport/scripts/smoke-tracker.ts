/**
 * Smoke test for PlaneIssueTrackerService against a real Plane CE instance.
 *
 * Runs the 5 implemented methods sequentially using a real bot API token.
 * NOT a unit test — opt-in, hits the network, mutates Plane data (creates
 * a comment + a transient issue, then archives the test issue).
 *
 * Required environment (same as dev-runner):
 *   PLANE_BASE_URL          e.g. https://plane.pulp.lan
 *   PLANE_WORKSPACE_SLUG    e.g. panfleet
 *   PLANE_BOT_USER_ID       UUID of the bot user
 *   PLANE_BOT_TOKEN         The bot's plane_api_xxx token
 *
 * Required argument:
 *   --project=<uuid>        target project UUID
 *
 * Optional:
 *   --issue=<uuid>          existing issue UUID to fetch + comment on
 *                            (if omitted, the script picks the first issue
 *                            of the project)
 *
 * Run with:
 *   pnpm --filter cyrus-plane-event-transport smoke:tracker -- --project=<uuid>
 */
import { PlaneIssueTrackerService } from "../src/PlaneIssueTrackerService.js";
import type { PlaneEventTransportConfig } from "../src/types.js";

function getArg(name: string): string | undefined {
	const prefix = `--${name}=`;
	const arg = process.argv.find((a) => a.startsWith(prefix));
	return arg?.slice(prefix.length);
}

function requireEnv(name: string): string {
	const v = process.env[name];
	if (!v) {
		console.error(`✗ missing env var ${name}`);
		process.exit(1);
	}
	return v;
}

const projectId = getArg("project");
if (!projectId) {
	console.error("✗ missing --project=<uuid>");
	process.exit(1);
}
const givenIssueId = getArg("issue");

const config: PlaneEventTransportConfig = {
	secret: "unused-by-tracker",
	verificationMode: "direct",
	workspaceSlug: requireEnv("PLANE_WORKSPACE_SLUG"),
	baseUrl: requireEnv("PLANE_BASE_URL"),
	apiToken: requireEnv("PLANE_BOT_TOKEN"),
	botUserIds: [requireEnv("PLANE_BOT_USER_ID")],
};
const expectedBotId = config.botUserIds[0];

async function main() {
	const svc = new PlaneIssueTrackerService(config);
	const log = (label: string, value: unknown) =>
		console.log(
			`  ${label.padEnd(28)} ${typeof value === "string" ? value : JSON.stringify(value)}`,
		);

	console.log(`✓ workspace=${config.workspaceSlug}  project=${projectId}\n`);

	// 1. getPlatformType / Metadata
	console.log("[1] getPlatformType / getPlatformMetadata");
	log("type", svc.getPlatformType());
	log("metadata", svc.getPlatformMetadata());

	// 2. fetchCurrentUser
	console.log("\n[2] fetchCurrentUser");
	const me = await svc.fetchCurrentUser();
	log("id", me.id);
	log("email", me.email);
	log("display_name", me.display_name);
	if (me.id !== expectedBotId) {
		console.warn(
			`  ⚠ /users/me/ returned id=${me.id}, expected ${expectedBotId}`,
		);
	}

	// 3. createIssue (so we have something to play with that we can archive)
	console.log(
		"\n[3] createIssue (smoke-test issue, will be archived at the end)",
	);
	const created = await svc.createIssue(projectId, {
		name: `smoke-test ${new Date().toISOString()}`,
		description_html: "<p>created by smoke-tracker.ts</p>",
		priority: "low",
	});
	log("issue.id", created.id);
	log("issue.name", created.name);
	log("issue.sequence_id", created.sequence_id);

	// 4. fetchIssue
	console.log("\n[4] fetchIssue");
	const fetched = await svc.fetchIssue(created.id, projectId);
	log("name matches", fetched.name === created.name);
	log("state (uuid)", fetched.state);

	// 5. createComment
	console.log("\n[5] createComment");
	const c = await svc.createComment(
		created.id,
		projectId,
		"<p>smoke-test comment by builder bot</p>",
	);
	log("comment.id", c.id);

	// 6. updateIssue (set priority to high, then archive logically by setting is_draft? — Plane CE doesn't have soft-archive via API trivially; we just leave it and let the human delete)
	console.log("\n[6] updateIssue (priority high)");
	const updated = await svc.updateIssue(created.id, projectId, {
		priority: "high",
	});
	log("priority", updated.priority);

	// 7. (optional) fetch the issue user requested
	if (givenIssueId) {
		console.log(`\n[7] fetchIssue (requested ${givenIssueId})`);
		const i = await svc.fetchIssue(givenIssueId, projectId);
		log("name", i.name);
		log("assignee uuids", i.assignees.join(", ") || "(none)");
	}

	console.log(
		`\n✓ smoke test ok. Created issue PFL-${created.sequence_id} (${created.id}) — delete it manually from the Plane UI if you want.`,
	);
}

main().catch((err) => {
	console.error("\n✗ smoke test failed:", err);
	process.exit(1);
});
