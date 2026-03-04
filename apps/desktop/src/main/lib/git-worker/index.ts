/**
 * Git Worker Runtime
 *
 * Singleton worker pool for offloading heavy git reads from the main thread.
 * Used by tRPC routers via the convenience functions exported here.
 *
 * Feature flag: set SUPERSET_GIT_WORKER=0 to disable and fall back to
 * main-thread execution (default: enabled).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { GitWorkerPool } from "./pool";
import type { GitTaskPayloads, GitTaskResults } from "./types";

// ---------------------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------------------

function resolveWorkerScriptPath(): string | null {
	const directPath = join(__dirname, "git-worker-thread.js");
	if (existsSync(directPath)) {
		return directPath;
	}

	const cwdDistPath = join(
		process.cwd(),
		"dist",
		"main",
		"git-worker-thread.js",
	);
	if (existsSync(cwdDistPath)) {
		return cwdDistPath;
	}

	return null;
}

const GIT_WORKER_DEBUG = process.env.SUPERSET_GIT_WORKER_DEBUG === "1";
const GIT_WORKER_REQUESTED = process.env.SUPERSET_GIT_WORKER !== "0";
const WORKER_SCRIPT_PATH = resolveWorkerScriptPath();
const GIT_WORKER_ENABLED = GIT_WORKER_REQUESTED && WORKER_SCRIPT_PATH !== null;

if (GIT_WORKER_REQUESTED && !WORKER_SCRIPT_PATH) {
	console.warn(
		"[git-worker] Worker script not found, falling back to main-thread git execution.",
	);
}

// ---------------------------------------------------------------------------
// Singleton pool
// ---------------------------------------------------------------------------

let pool: GitWorkerPool | null = null;

/**
 * Resolve the built worker script path.
 * In electron-vite builds, all main-process entry points are emitted
 * to the same output directory alongside the main index.js.
 */
function getWorkerScriptPath(): string {
	if (WORKER_SCRIPT_PATH) {
		return WORKER_SCRIPT_PATH;
	}
	throw new Error("git-worker-thread.js not found");
}

function getPool(): GitWorkerPool {
	if (!pool) {
		pool = new GitWorkerPool(getWorkerScriptPath(), {
			maxWorkers: 2,
			maxQueueSize: 50,
			defaultTimeoutMs: 30_000,
			debug: GIT_WORKER_DEBUG,
		});
	}
	return pool;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function isGitWorkerEnabled(): boolean {
	return GIT_WORKER_ENABLED;
}

/**
 * Submit a getStatus task to the worker pool.
 */
export function submitGetStatus(
	payload: GitTaskPayloads["getStatus"],
): Promise<GitTaskResults["getStatus"]> {
	return getPool().submit("getStatus", payload, {
		dedupeKey: `${payload.worktreePath}:${payload.defaultBranch}`,
		timeoutMs: 30_000,
	});
}

/**
 * Submit a getCommitFiles task to the worker pool.
 */
export function submitGetCommitFiles(
	payload: GitTaskPayloads["getCommitFiles"],
): Promise<GitTaskResults["getCommitFiles"]> {
	return getPool().submit("getCommitFiles", payload, {
		dedupeKey: `commitFiles:${payload.worktreePath}:${payload.commitHash}`,
		timeoutMs: 30_000,
	});
}

/**
 * Cancel pending git tasks for a given worktree path.
 * Call this on workspace switch or section collapse.
 */
export function cancelGitTasksForWorktree(worktreePath: string): void {
	if (!pool) return;
	pool.cancelByPrefix(worktreePath);
}

/**
 * Get current worker pool metrics for observability.
 */
export function getGitWorkerMetrics() {
	if (!pool) return null;
	return pool.getMetrics();
}

/**
 * Shut down the worker pool. Call on app quit.
 */
export async function destroyGitWorkerPool(): Promise<void> {
	if (pool) {
		await pool.destroy();
		pool = null;
	}
}
