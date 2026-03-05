import { existsSync } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

const CODEX_SESSIONS_ROOT = join(homedir(), ".codex", "sessions");
const FIRST_LINE_MAX_BYTES = 2 * 1024 * 1024;
const FIRST_LINE_READ_CHUNK = 64 * 1024;
const PREVIEW_MAX_BYTES = FIRST_LINE_MAX_BYTES + 256 * 1024;
const PREVIEW_MAX_LINES = 240;
const PREVIEW_TEXT_LIMIT = 240;
const MIN_SCAN_FILES = 300;
const MAX_SCAN_FILES = 4000;
const SCAN_MULTIPLIER = 40;

interface SessionMetaPayload {
	id?: string;
	timestamp?: string;
	cwd?: string;
	source?: {
		subagent?: unknown;
	} | null;
}

interface SessionMetaLine {
	type?: string;
	payload?: SessionMetaPayload;
}

interface SessionEventPayload {
	type?: string;
	message?: unknown;
}

interface SessionEventLine {
	type?: string;
	payload?: SessionEventPayload;
}

interface SessionResponseItemContent {
	type?: string;
	text?: unknown;
}

interface SessionResponseItemPayload {
	type?: string;
	role?: string;
	content?: SessionResponseItemContent[];
}

interface SessionResponseItemLine {
	type?: string;
	payload?: SessionResponseItemPayload;
}

interface SessionPreviewData {
	firstUserMessage: string | null;
	lastUserMessage: string | null;
	firstAssistantMessage: string | null;
	lastAssistantMessage: string | null;
}

export interface CodexSessionSummary {
	id: string;
	timestamp: number;
	timestampIso: string;
	cwd: string;
	isSubagent: boolean;
	firstUserMessage: string | null;
	lastUserMessage: string | null;
	firstAssistantMessage: string | null;
	lastAssistantMessage: string | null;
}

function normalizePath(input: string): string {
	return resolve(input).replace(/[\\/]+$/, "");
}

function isPathUnderParent(parentPath: string, targetPath: string): boolean {
	const rel = relative(parentPath, targetPath);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function parseTimestampFromFileName(filePath: string): number {
	const fileName = basename(filePath);
	const match = fileName.match(
		/rollout-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/,
	);

	if (!match) {
		return Date.now();
	}

	const iso = `${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`;
	const parsed = Date.parse(iso);
	return Number.isFinite(parsed) ? parsed : Date.now();
}

async function readFirstLine(filePath: string): Promise<string | null> {
	const handle = await open(filePath, "r");
	try {
		let position = 0;
		let text = "";
		const buffer = Buffer.alloc(FIRST_LINE_READ_CHUNK);

		while (position < FIRST_LINE_MAX_BYTES) {
			const remaining = FIRST_LINE_MAX_BYTES - position;
			const length = Math.min(FIRST_LINE_READ_CHUNK, remaining);
			const { bytesRead } = await handle.read(buffer, 0, length, position);
			if (bytesRead <= 0) {
				break;
			}

			text += buffer.toString("utf8", 0, bytesRead);
			const newlineIndex = text.indexOf("\n");
			if (newlineIndex >= 0) {
				return text.slice(0, newlineIndex);
			}

			position += bytesRead;
		}

		return text.length > 0 ? text : null;
	} finally {
		await handle.close();
	}
}

async function readHeadText(
	filePath: string,
	maxBytes: number,
): Promise<string | null> {
	const handle = await open(filePath, "r");
	try {
		let position = 0;
		let text = "";
		const buffer = Buffer.alloc(FIRST_LINE_READ_CHUNK);

		while (position < maxBytes) {
			const remaining = maxBytes - position;
			const length = Math.min(FIRST_LINE_READ_CHUNK, remaining);
			const { bytesRead } = await handle.read(buffer, 0, length, position);
			if (bytesRead <= 0) {
				break;
			}

			text += buffer.toString("utf8", 0, bytesRead);
			position += bytesRead;
		}

		return text.length > 0 ? text : null;
	} finally {
		await handle.close();
	}
}

function normalizePreviewText(text: string): string {
	const singleLine = text.replace(/\s+/g, " ").trim();
	if (singleLine.length <= PREVIEW_TEXT_LIMIT) {
		return singleLine;
	}
	return `${singleLine.slice(0, PREVIEW_TEXT_LIMIT - 1)}…`;
}

function readMessageFromEventLine(line: unknown): {
	role: "user" | "assistant";
	message: string;
} | null {
	if (
		typeof line !== "object" ||
		!line ||
		!("type" in line) ||
		(line as { type?: string }).type !== "event_msg"
	) {
		return null;
	}

	const payload = (line as SessionEventLine).payload;
	if (!payload) return null;

	if (payload.type === "user_message" && typeof payload.message === "string") {
		const message = normalizePreviewText(payload.message);
		if (!message) return null;
		return { role: "user", message };
	}

	if (payload.type === "agent_message" && typeof payload.message === "string") {
		const message = normalizePreviewText(payload.message);
		if (!message) return null;
		return { role: "assistant", message };
	}

	return null;
}

function readMessageFromResponseItemLine(line: unknown): {
	role: "user" | "assistant";
	message: string;
} | null {
	if (
		typeof line !== "object" ||
		!line ||
		!("type" in line) ||
		(line as { type?: string }).type !== "response_item"
	) {
		return null;
	}

	const payload = (line as SessionResponseItemLine).payload;
	if (!payload || payload.type !== "message") {
		return null;
	}

	if (payload.role !== "user" && payload.role !== "assistant") {
		return null;
	}

	const content = payload.content ?? [];
	const text = content
		.map((item) =>
			typeof item.text === "string" &&
			(item.type === "input_text" || item.type === "output_text")
				? item.text
				: "",
		)
		.filter((part) => part.length > 0)
		.join("\n");
	if (!text) {
		return null;
	}

	return {
		role: payload.role,
		message: normalizePreviewText(text),
	};
}

async function parseSessionPreview(
	filePath: string,
): Promise<SessionPreviewData> {
	const emptyPreview: SessionPreviewData = {
		firstUserMessage: null,
		lastUserMessage: null,
		firstAssistantMessage: null,
		lastAssistantMessage: null,
	};

	try {
		const text = await readHeadText(filePath, PREVIEW_MAX_BYTES);
		if (!text) {
			return emptyPreview;
		}

		let firstUserMessage: string | null = null;
		let lastUserMessage: string | null = null;
		let firstAssistantMessage: string | null = null;
		let lastAssistantMessage: string | null = null;

		const lines = text.split("\n");
		const maxLines = Math.min(lines.length, PREVIEW_MAX_LINES);
		for (let index = 1; index < maxLines; index += 1) {
			const rawLine = lines[index]?.trim();
			if (!rawLine) continue;

			let parsed: unknown;
			try {
				parsed = JSON.parse(rawLine);
			} catch {
				continue;
			}

			const messageEntry =
				readMessageFromEventLine(parsed) ??
				readMessageFromResponseItemLine(parsed);
			if (!messageEntry) {
				continue;
			}

			if (messageEntry.role === "user") {
				if (!firstUserMessage) {
					firstUserMessage = messageEntry.message;
				}
				lastUserMessage = messageEntry.message;
				continue;
			}

			if (!firstAssistantMessage) {
				firstAssistantMessage = messageEntry.message;
			}
			lastAssistantMessage = messageEntry.message;
		}

		return {
			firstUserMessage,
			lastUserMessage,
			firstAssistantMessage,
			lastAssistantMessage,
		};
	} catch {
		return emptyPreview;
	}
}

async function parseSessionMeta(
	filePath: string,
): Promise<CodexSessionSummary | null> {
	try {
		const firstLine = await readFirstLine(filePath);
		if (!firstLine) return null;

		const parsed = JSON.parse(firstLine) as SessionMetaLine;
		if (parsed.type !== "session_meta" || !parsed.payload) {
			return null;
		}

		const id = parsed.payload.id?.trim();
		const cwd = parsed.payload.cwd?.trim();

		if (!id || !cwd) {
			return null;
		}

		const normalizedCwd = normalizePath(cwd);
		const parsedTimestamp = parsed.payload.timestamp
			? Date.parse(parsed.payload.timestamp)
			: Number.NaN;
		const timestamp = Number.isFinite(parsedTimestamp)
			? parsedTimestamp
			: parseTimestampFromFileName(filePath);

		return {
			id,
			cwd: normalizedCwd,
			timestamp,
			timestampIso: new Date(timestamp).toISOString(),
			isSubagent: Boolean(parsed.payload.source?.subagent),
			firstUserMessage: null,
			lastUserMessage: null,
			firstAssistantMessage: null,
			lastAssistantMessage: null,
		};
	} catch {
		return null;
	}
}

async function listNumericSubdirectories(
	parentPath: string,
): Promise<string[]> {
	try {
		const entries = await readdir(parentPath, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
			.map((entry) => entry.name)
			.sort((a, b) => Number.parseInt(b, 10) - Number.parseInt(a, 10));
	} catch {
		return [];
	}
}

async function listSessionFilesByRecency(rootPath: string): Promise<string[]> {
	const result: string[] = [];

	const years = await listNumericSubdirectories(rootPath);
	for (const year of years) {
		const yearPath = join(rootPath, year);
		const months = await listNumericSubdirectories(yearPath);
		for (const month of months) {
			const monthPath = join(yearPath, month);
			const days = await listNumericSubdirectories(monthPath);
			for (const day of days) {
				const dayPath = join(monthPath, day);
				const dayEntries = await readdir(dayPath, {
					withFileTypes: true,
				}).catch(() => []);

				const files = dayEntries
					.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
					.map((entry) => join(dayPath, entry.name))
					.sort((a, b) => basename(b).localeCompare(basename(a)));

				result.push(...files);
			}
		}
	}

	return result;
}

export async function listCodexSessionsForProjectPaths({
	projectPaths,
	limit,
	sessionsRoot = CODEX_SESSIONS_ROOT,
}: {
	projectPaths: string[];
	limit: number;
	sessionsRoot?: string;
}): Promise<CodexSessionSummary[]> {
	if (!existsSync(sessionsRoot) || limit <= 0) {
		return [];
	}

	const normalizedRoots = [...new Set(projectPaths.map(normalizePath))].filter(
		(path) => path.length > 0,
	);
	if (normalizedRoots.length === 0) {
		return [];
	}

	const sessionFiles = await listSessionFilesByRecency(sessionsRoot);
	const scanBudget = Math.min(
		MAX_SCAN_FILES,
		Math.max(MIN_SCAN_FILES, limit * SCAN_MULTIPLIER),
	);

	const seenSessionIds = new Set<string>();
	const matched: CodexSessionSummary[] = [];
	let scannedCount = 0;

	for (const filePath of sessionFiles) {
		if (matched.length >= limit || scannedCount >= scanBudget) {
			break;
		}

		scannedCount += 1;

		const sessionMeta = await parseSessionMeta(filePath);
		if (!sessionMeta) {
			continue;
		}

		if (seenSessionIds.has(sessionMeta.id)) {
			continue;
		}

		const isProjectSession = normalizedRoots.some((rootPath) =>
			isPathUnderParent(rootPath, sessionMeta.cwd),
		);
		if (!isProjectSession) {
			continue;
		}

		const preview = await parseSessionPreview(filePath);

		seenSessionIds.add(sessionMeta.id);
		matched.push({
			...sessionMeta,
			firstUserMessage: preview.firstUserMessage,
			lastUserMessage: preview.lastUserMessage,
			firstAssistantMessage: preview.firstAssistantMessage,
			lastAssistantMessage: preview.lastAssistantMessage,
		});
	}

	matched.sort((a, b) => b.timestamp - a.timestamp);
	return matched.slice(0, limit);
}
