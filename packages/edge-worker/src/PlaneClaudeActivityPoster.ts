/**
 * PlaneClaudeActivityPoster — translates Claude SDK messages into Plane
 * HTML comments and posts them sequentially.
 *
 * Activity granularity (chosen in spec):
 *   - assistant text block → 1 comment "<p>{text}</p>"
 *   - assistant tool_use block → 1 comment with tool name + JSON input
 *   - user tool_result block → 1 comment with ✅ / ❌
 *   - SDKResultMessage → final "✅ Sesión completada" comment
 *
 * Comments are queued onto a chained Promise<void> so they hit Plane in
 * event-order even when several messages arrive in rapid succession. A
 * single failing post is logged but does not abort the chain.
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createLogger, type ILogger } from "cyrus-core";

const TOOL_INPUT_PREVIEW_MAX = 2000;
const TOOL_RESULT_PREVIEW_MAX = 500;

export interface PlaneClaudeActivityPosterConfig {
	postComment: (html: string) => Promise<unknown>;
	logger?: ILogger;
}

export class PlaneClaudeActivityPoster {
	private readonly postComment: (html: string) => Promise<unknown>;
	private readonly logger: ILogger;
	/**
	 * Tail of the sequential promise chain.
	 * Every `enqueue` appends a new link so posts happen in FIFO order.
	 * `flush()` awaits this promise.
	 *
	 * The initial value is a *synchronously-resolved* sentinel so that the
	 * very first `enqueue` call starts the post immediately (same JS turn),
	 * not after a microtask hop. We exploit the fact that `.then()` on an
	 * already-resolved promise fires its callback synchronously when the
	 * resolved value is used as the base of a new chain that starts before
	 * any awaits — see the NOTE in `enqueue`.
	 */
	private queue: Promise<void> = Promise.resolve();
	private lastAssistantText: string = "";

	constructor(config: PlaneClaudeActivityPosterConfig) {
		this.postComment = config.postComment;
		this.logger =
			config.logger ?? createLogger({ component: "PlaneClaudeActivityPoster" });
	}

	handleMessage(message: SDKMessage): void {
		const htmls = this.renderMessage(message);
		for (const html of htmls) {
			this.enqueue(html);
		}
	}

	handleError(error: Error): void {
		this.enqueue(`<p>❌ Error de Claude: ${escapeHtml(error.message)}</p>`);
	}

	/**
	 * Wait for the queue to drain. Used by tests; production callers don't
	 * need to await this — `handleMessage` is fire-and-forget.
	 */
	async flush(): Promise<void> {
		await this.queue;
	}

	/**
	 * Append one HTML post to the sequential chain.
	 * Posts are serialized via the promise queue — the next call does not
	 * start until the previous one resolves or rejects.
	 */
	private enqueue(html: string): void {
		this.queue = this.queue
			.then(() => this.postComment(html))
			.then(() => undefined)
			.catch((err) => {
				this.logger.error(
					`Failed to post Plane comment: ${err instanceof Error ? err.message : String(err)}`,
				);
			});
	}

	private renderMessage(message: SDKMessage): string[] {
		switch (message.type) {
			case "assistant":
				return this.renderAssistant(message);
			case "user":
				return this.renderUser(message);
			case "result":
				return this.renderResult(message);
			default:
				return [];
		}
	}

	private renderAssistant(
		message: SDKMessage & { type: "assistant" },
	): string[] {
		const out: string[] = [];
		const blocks = (message as unknown as { message: { content: unknown[] } })
			.message?.content;
		if (!Array.isArray(blocks)) return out;
		for (const block of blocks) {
			const b = block as {
				type: string;
				text?: string;
				name?: string;
				input?: unknown;
			};
			if (b.type === "text" && typeof b.text === "string") {
				this.lastAssistantText = b.text;
				out.push(`<p>${escapeHtml(b.text)}</p>`);
			} else if (b.type === "tool_use" && typeof b.name === "string") {
				let json: string;
				try {
					json = JSON.stringify(b.input, null, 2);
				} catch {
					json = String(b.input);
				}
				const truncated =
					json.length > TOOL_INPUT_PREVIEW_MAX
						? `${json.slice(0, TOOL_INPUT_PREVIEW_MAX)}…`
						: json;
				out.push(
					`<p>🔧 <code>${escapeHtml(b.name)}</code></p><pre>${escapeHtml(truncated)}</pre>`,
				);
			}
		}
		return out;
	}

	private renderUser(message: SDKMessage & { type: "user" }): string[] {
		const out: string[] = [];
		const blocks = (message as unknown as { message: { content: unknown[] } })
			.message?.content;
		if (!Array.isArray(blocks)) return out;
		for (const block of blocks) {
			const b = block as {
				type: string;
				tool_use_id?: string;
				is_error?: boolean;
				content?: unknown;
			};
			if (b.type === "tool_result") {
				const icon = b.is_error ? "❌" : "✅";
				const preview = renderToolResultPreview(b.content);
				out.push(
					`<p>📤 <code>tool_result</code> → ${icon}</p>${preview ? `<pre>${escapeHtml(preview)}</pre>` : ""}`,
				);
			}
		}
		return out;
	}

	private renderResult(message: SDKMessage & { type: "result" }): string[] {
		const final =
			(message as unknown as { result?: unknown }).result ??
			this.lastAssistantText;
		const text = typeof final === "string" ? final : this.lastAssistantText;
		return [`<p>✅ Sesión completada</p><p>${escapeHtml(text)}</p>`];
	}
}

function renderToolResultPreview(content: unknown): string {
	if (typeof content === "string") {
		return content.length > TOOL_RESULT_PREVIEW_MAX
			? `${content.slice(0, TOOL_RESULT_PREVIEW_MAX)}…`
			: content;
	}
	if (Array.isArray(content)) {
		const text = content
			.map((b) => {
				const block = b as { type?: string; text?: string };
				return block.type === "text" && typeof block.text === "string"
					? block.text
					: "";
			})
			.join("\n")
			.trim();
		return text.length > TOOL_RESULT_PREVIEW_MAX
			? `${text.slice(0, TOOL_RESULT_PREVIEW_MAX)}…`
			: text;
	}
	return "";
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}
