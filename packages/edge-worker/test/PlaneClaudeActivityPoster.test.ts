import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlaneClaudeActivityPoster } from "../src/PlaneClaudeActivityPoster.js";

function makePoster(
	postComment: (html: string) => Promise<void>,
): PlaneClaudeActivityPoster {
	return new PlaneClaudeActivityPoster({ postComment });
}

function assistantTextMessage(text: string): SDKMessage {
	return {
		type: "assistant",
		message: {
			id: "msg_x",
			role: "assistant",
			content: [{ type: "text", text }],
		},
	} as unknown as SDKMessage;
}

function assistantToolUseMessage(
	name: string,
	input: Record<string, unknown>,
): SDKMessage {
	return {
		type: "assistant",
		message: {
			id: "msg_x",
			role: "assistant",
			content: [{ type: "tool_use", id: "tu_1", name, input }],
		},
	} as unknown as SDKMessage;
}

function userToolResultMessage(
	toolUseId: string,
	output: string,
	isError = false,
): SDKMessage {
	return {
		type: "user",
		message: {
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: toolUseId,
					content: output,
					is_error: isError,
				},
			],
		},
	} as unknown as SDKMessage;
}

function resultMessage(lastText: string): SDKMessage {
	return {
		type: "result",
		subtype: "success",
		result: lastText,
		duration_ms: 1234,
		duration_api_ms: 1000,
		num_turns: 1,
		total_cost_usd: 0,
	} as unknown as SDKMessage;
}

describe("PlaneClaudeActivityPoster", () => {
	let calls: string[];
	let postComment: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		calls = [];
		postComment = vi.fn(async (html: string) => {
			calls.push(html);
		});
	});

	it("posts an <p> comment for an assistant text message", async () => {
		const poster = makePoster(postComment);
		poster.handleMessage(assistantTextMessage("Hello world"));
		await poster.flush();
		expect(calls).toEqual(["<p>Hello world</p>"]);
	});

	it("posts a tool-use HTML block for an assistant tool_use message", async () => {
		const poster = makePoster(postComment);
		poster.handleMessage(assistantToolUseMessage("Bash", { cmd: "ls" }));
		await poster.flush();
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain("🔧");
		expect(calls[0]).toContain("<code>Bash</code>");
		expect(calls[0]).toContain('"cmd": "ls"');
	});

	it("posts a success tool_result for a user tool_result message", async () => {
		const poster = makePoster(postComment);
		poster.handleMessage(userToolResultMessage("tu_1", "OK"));
		await poster.flush();
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain("📤");
		expect(calls[0]).toContain("✅");
	});

	it("posts a failure tool_result with ❌ when is_error=true", async () => {
		const poster = makePoster(postComment);
		poster.handleMessage(userToolResultMessage("tu_1", "boom", true));
		await poster.flush();
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain("❌");
	});

	it("posts a final ✅ comment when handleComplete is invoked", async () => {
		const poster = makePoster(postComment);
		// Pre-feed an assistant text so the poster has a "last assistant text".
		poster.handleMessage(assistantTextMessage("All done"));
		poster.handleMessage(resultMessage("All done"));
		await poster.flush();
		// 1 for the assistant text + 1 for the result final.
		expect(calls).toHaveLength(2);
		expect(calls[1]).toContain("✅ Sesión completada");
		expect(calls[1]).toContain("All done");
	});

	it("posts comments in event-order even when postComment resolves out of order", async () => {
		// Build a postComment whose promises resolve out of order.
		const resolvers: Array<() => void> = [];
		postComment = vi.fn((html: string) => {
			calls.push(html);
			return new Promise<void>((resolve) => {
				resolvers.push(resolve);
			});
		});
		const poster = makePoster(postComment);

		poster.handleMessage(assistantTextMessage("first"));
		poster.handleMessage(assistantTextMessage("second"));
		poster.handleMessage(assistantTextMessage("third"));

		// We expect only ONE call to be in flight (queue is sequential).
		expect(postComment).toHaveBeenCalledTimes(1);
		resolvers.shift()!(); // resolve first
		await new Promise((r) => setImmediate(r));
		expect(postComment).toHaveBeenCalledTimes(2);
		resolvers.shift()!(); // resolve second
		await new Promise((r) => setImmediate(r));
		expect(postComment).toHaveBeenCalledTimes(3);
		resolvers.shift()!(); // resolve third
		await poster.flush();
		expect(calls).toEqual(["<p>first</p>", "<p>second</p>", "<p>third</p>"]);
	});

	it("continues posting after a single postComment rejects", async () => {
		postComment = vi
			.fn()
			.mockRejectedValueOnce(new Error("plane down"))
			.mockResolvedValue(undefined);
		const poster = makePoster(postComment);
		poster.handleMessage(assistantTextMessage("one"));
		poster.handleMessage(assistantTextMessage("two"));
		await poster.flush();
		expect(postComment).toHaveBeenCalledTimes(2);
	});

	it("posts an error comment when handleError is invoked", async () => {
		const poster = makePoster(postComment);
		poster.handleError(new Error("claude exploded"));
		await poster.flush();
		expect(calls).toEqual(["<p>❌ Error de Claude: claude exploded</p>"]);
	});
});
