import { describe, expect, it, mock } from "bun:test";
import { autoImportWorktreesForProjects } from "./auto-import-worktrees";

describe("autoImportWorktreesForProjects", () => {
	it("deduplicates project ids and aggregates imported count", async () => {
		const importAllWorktrees = mock(
			async ({ projectId }: { projectId: string }) =>
				projectId === "p1" ? { imported: 2 } : { imported: 1 },
		);

		const totalImported = await autoImportWorktreesForProjects({
			projectIds: ["p1", "p2", "p1"],
			importAllWorktrees,
		});

		expect(totalImported).toBe(3);
		expect(importAllWorktrees).toHaveBeenCalledTimes(2);
		expect(importAllWorktrees).toHaveBeenNthCalledWith(1, { projectId: "p1" });
		expect(importAllWorktrees).toHaveBeenNthCalledWith(2, { projectId: "p2" });
	});

	it("skips empty ids and continues when an import fails", async () => {
		const importAllWorktrees = mock(
			async ({ projectId }: { projectId: string }) => {
				if (projectId === "p2") {
					throw new Error("boom");
				}
				return { imported: 4 };
			},
		);
		const onError = mock(() => {});

		const totalImported = await autoImportWorktreesForProjects({
			projectIds: ["", "p1", "p2"],
			importAllWorktrees,
			onError,
		});

		expect(totalImported).toBe(4);
		expect(importAllWorktrees).toHaveBeenCalledTimes(2);
		expect(onError).toHaveBeenCalledTimes(1);
	});
});
