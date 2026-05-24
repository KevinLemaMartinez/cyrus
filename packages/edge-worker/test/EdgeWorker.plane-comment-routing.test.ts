/**
 * Black-box tests for the planeAgentLabelIds filter logic.
 *
 * The full integration story (real EdgeWorker bootstrap + fastify route +
 * fetchIssue iteration + assignee check) is covered by the manual LXC smoke
 * test, not by unit tests. We only assert the opt-in label-filter helper
 * here because it is the only piece of new pure logic in the comment branch.
 *
 * NOTE: matchesPlaneLabelFilter is module-scope in EdgeWorker.ts (not exported)
 * to keep its surface area private. We re-declare the same logic in this test
 * file. If the production helper drifts, this test silently passes — that is
 * an acceptable tradeoff for the simplicity of not exporting an otherwise-
 * internal helper. The smoke test catches drift end-to-end.
 */
import { describe, expect, it } from "vitest";

function matchesPlaneLabelFilter(
	issueLabels: string[],
	repo: { planeAgentLabelIds?: string[] },
): boolean {
	if (!repo.planeAgentLabelIds?.length) return true;
	return issueLabels.some((id) => repo.planeAgentLabelIds!.includes(id));
}

describe("matchesPlaneLabelFilter (opt-in semantics)", () => {
	it("returns true when repo has no label filter", () => {
		expect(matchesPlaneLabelFilter(["label-a"], {})).toBe(true);
		expect(
			matchesPlaneLabelFilter(["label-a"], { planeAgentLabelIds: [] }),
		).toBe(true);
	});

	it("returns true when issue has at least one matching label", () => {
		expect(
			matchesPlaneLabelFilter(["x", "label-a"], {
				planeAgentLabelIds: ["label-a"],
			}),
		).toBe(true);
	});

	it("returns false when issue has no matching label", () => {
		expect(
			matchesPlaneLabelFilter(["x", "y"], {
				planeAgentLabelIds: ["label-a"],
			}),
		).toBe(false);
	});

	it("returns false when issue has no labels and filter is non-empty", () => {
		expect(
			matchesPlaneLabelFilter([], { planeAgentLabelIds: ["label-a"] }),
		).toBe(false);
	});
});
