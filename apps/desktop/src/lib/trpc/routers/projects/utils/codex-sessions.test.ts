import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listCodexSessionsForProjectPaths } from "./codex-sessions";

async function writeSessionFile({
	root,
	fileName,
	sessionId,
	timestampIso,
	cwd,
	extraLines = [],
}: {
	root: string;
	fileName: string;
	sessionId: string;
	timestampIso: string;
	cwd: string;
	extraLines?: string[];
}) {
	const dayDir = join(root, "2026", "03", "04");
	await mkdir(dayDir, { recursive: true });

	const firstLine = JSON.stringify({
		type: "session_meta",
		payload: {
			id: sessionId,
			timestamp: timestampIso,
			cwd,
		},
	});

	const body = [firstLine, ...extraLines].join("\n");
	await writeFile(join(dayDir, fileName), `${body}\n`, "utf8");
}

describe("listCodexSessionsForProjectPaths", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		await Promise.all(
			tempDirs.map(async (dir) => {
				await rm(dir, { recursive: true, force: true });
			}),
		);
		tempDirs.length = 0;
	});

	it("filters by project/worktree paths and sorts by timestamp desc", async () => {
		const sessionsRoot = await mkdtemp(join(tmpdir(), "codex-sessions-test-"));
		tempDirs.push(sessionsRoot);

		const projectRoot = "/Users/test/work/superset";
		const worktreeRoot = "/Users/test/work/superset-fix-1";

		await writeSessionFile({
			root: sessionsRoot,
			fileName: "rollout-2026-03-04T10-00-00-a.jsonl",
			sessionId: "session-project-old",
			timestampIso: "2026-03-04T10:00:00.000Z",
			cwd: `${projectRoot}/apps/desktop`,
		});
		await writeSessionFile({
			root: sessionsRoot,
			fileName: "rollout-2026-03-04T12-00-00-b.jsonl",
			sessionId: "session-worktree-new",
			timestampIso: "2026-03-04T12:00:00.000Z",
			cwd: `${worktreeRoot}/packages/shared`,
		});
		await writeSessionFile({
			root: sessionsRoot,
			fileName: "rollout-2026-03-04T11-00-00-c.jsonl",
			sessionId: "session-other-project",
			timestampIso: "2026-03-04T11:00:00.000Z",
			cwd: "/Users/test/work/another-repo",
		});

		const sessions = await listCodexSessionsForProjectPaths({
			projectPaths: [projectRoot, worktreeRoot],
			limit: 10,
			sessionsRoot,
		});

		expect(sessions.map((session) => session.id)).toEqual([
			"session-worktree-new",
			"session-project-old",
		]);
	});

	it("deduplicates session ids and applies limit", async () => {
		const sessionsRoot = await mkdtemp(join(tmpdir(), "codex-sessions-test-"));
		tempDirs.push(sessionsRoot);

		const projectRoot = "/Users/test/work/superset";

		await writeSessionFile({
			root: sessionsRoot,
			fileName: "rollout-2026-03-04T09-00-00-a.jsonl",
			sessionId: "session-dup",
			timestampIso: "2026-03-04T09:00:00.000Z",
			cwd: projectRoot,
		});
		await writeSessionFile({
			root: sessionsRoot,
			fileName: "rollout-2026-03-04T10-00-00-b.jsonl",
			sessionId: "session-dup",
			timestampIso: "2026-03-04T10:00:00.000Z",
			cwd: `${projectRoot}/apps/web`,
		});
		await writeSessionFile({
			root: sessionsRoot,
			fileName: "rollout-2026-03-04T11-00-00-c.jsonl",
			sessionId: "session-unique",
			timestampIso: "2026-03-04T11:00:00.000Z",
			cwd: `${projectRoot}/apps/desktop`,
		});

		const sessions = await listCodexSessionsForProjectPaths({
			projectPaths: [projectRoot],
			limit: 1,
			sessionsRoot,
		});

		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.id).toBe("session-unique");
	});

	it("extracts user and assistant previews from session events", async () => {
		const sessionsRoot = await mkdtemp(join(tmpdir(), "codex-sessions-test-"));
		tempDirs.push(sessionsRoot);

		const projectRoot = "/Users/test/work/superset";
		await writeSessionFile({
			root: sessionsRoot,
			fileName: "rollout-2026-03-04T14-00-00-preview.jsonl",
			sessionId: "session-preview",
			timestampIso: "2026-03-04T14:00:00.000Z",
			cwd: `${projectRoot}/apps/desktop`,
			extraLines: [
				JSON.stringify({
					type: "event_msg",
					payload: {
						type: "user_message",
						message: "请帮我优化窗口切换和启动速度。",
					},
				}),
				JSON.stringify({
					type: "event_msg",
					payload: {
						type: "agent_message",
						message: "已定位到工作区切换时的重渲染热点，正在修复。",
					},
				}),
			],
		});

		const sessions = await listCodexSessionsForProjectPaths({
			projectPaths: [projectRoot],
			limit: 5,
			sessionsRoot,
		});

		expect(sessions[0]?.firstUserMessage).toContain("优化窗口切换");
		expect(sessions[0]?.lastAssistantMessage).toContain("重渲染热点");
	});
});
