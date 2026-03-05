import { describe, expect, it } from "bun:test";
import {
	buildAgentPromptCommand,
	buildCodexResumeCommand,
} from "./agent-command";

describe("buildAgentPromptCommand", () => {
	it("adds `--` before codex prompt payload", () => {
		const command = buildAgentPromptCommand({
			prompt: "- Only modified file: runtime.ts",
			randomId: "1234-5678",
			agent: "codex",
		});

		expect(command).toContain(
			"--dangerously-bypass-approvals-and-sandbox -- \"$(cat <<'SUPERSET_PROMPT_12345678'",
		);
		expect(command).toContain("- Only modified file: runtime.ts");
	});

	it("does not change non-codex commands", () => {
		const command = buildAgentPromptCommand({
			prompt: "hello",
			randomId: "abcd-efgh",
			agent: "claude",
		});

		expect(command).toStartWith(
			"claude --dangerously-skip-permissions \"$(cat <<'SUPERSET_PROMPT_abcdefgh'",
		);
	});
});

describe("buildCodexResumeCommand", () => {
	it("builds picker resume command without prompt", () => {
		const command = buildCodexResumeCommand({
			mode: "picker",
		});

		expect(command).toBe("codex resume");
	});

	it("builds --last resume command without prompt", () => {
		const command = buildCodexResumeCommand({
			mode: "last",
		});

		expect(command).toBe("codex resume --last");
	});

	it("builds resume command for an explicit session id", () => {
		const command = buildCodexResumeCommand({
			mode: "session",
			sessionId: "019cb6e1-ecbc-7b60-ae61-c39be70a5533",
		});

		expect(command).toBe("codex resume 019cb6e1-ecbc-7b60-ae61-c39be70a5533");
	});

	it("adds prompt payload when provided", () => {
		const command = buildCodexResumeCommand({
			mode: "last",
			prompt: "继续这个任务\n只改这一个文件",
			randomId: "abcd-1234",
		});

		expect(command).toContain(
			"codex resume --last \"$(cat <<'SUPERSET_PROMPT_abcd1234'",
		);
		expect(command).toContain("继续这个任务");
		expect(command).toContain("只改这一个文件");
	});
});
