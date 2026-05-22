/**
 * HTML escape utility shared by Plane-side modules in the edge-worker.
 *
 * Plane stores comments as HTML and accepts them via `comment_html`.
 * Any string interpolated into a comment must be escaped to avoid
 * accidental markup injection.
 */
export function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}
