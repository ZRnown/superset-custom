import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TRPCError } from "@trpc/server";
import fg from "fast-glob";
import { appState } from "main/lib/app-state";
import type {
	SshAuthMode,
	SshCredentialEntry,
} from "main/lib/app-state/schemas";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import { decrypt, encrypt } from "../auth/utils/crypto-storage";

interface ParsedSshHost {
	alias: string;
	hostName: string | null;
	user: string | null;
	port: number | null;
	identityFile: string | null;
	proxyJump: string | null;
	sourcePath: string;
	line: number;
	tags: string[];
}

interface SshCredentialPublic {
	authMode: SshAuthMode;
	user: string | null;
	port: number | null;
	identityFile: string | null;
	hasPassword: boolean;
	updatedAt: number | null;
}

interface SshHostEntry extends ParsedSshHost {
	resolvedTarget: string;
	commandPreview: string;
	credential: SshCredentialPublic;
}

interface SshMountStateEntry {
	mountPath: string;
	lastMountedAt: number | null;
	lastUnmountedAt: number | null;
	lastError: string | null;
}

interface SshMountEntry {
	alias: string;
	mountPath: string;
	isMounted: boolean;
	lastMountedAt: number | null;
	lastUnmountedAt: number | null;
	lastError: string | null;
}

interface ParseState {
	visitedFiles: Set<string>;
	hostsByAlias: Map<string, ParsedSshHost>;
}

interface RunCommandOptions {
	timeoutMs?: number;
	stdin?: string;
	allowNonZero?: boolean;
	env?: NodeJS.ProcessEnv;
}

interface RunCommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

const INFERRED_TAGS = [
	"prod",
	"production",
	"staging",
	"stage",
	"dev",
	"test",
	"qa",
	"k8s",
	"db",
	"api",
	"web",
	"jump",
] as const;

const SSHFS_MOUNT_ROOT = path.join(os.homedir(), ".superset", "sshfs");
const DEFAULT_TIMEOUT_MS = 15_000;
const INSPECT_TIMEOUT_MS = 12_000;
const MOUNT_TIMEOUT_MS = 30_000;
const MOUNT_SEPARATOR = "__SUPERSET_SSH_INFO_SEP__";

const upsertCredentialInputSchema = z.object({
	alias: z.string().trim().min(1),
	authMode: z.enum(["agent", "key", "password"]),
	user: z.string().trim().optional().nullable(),
	port: z.number().int().positive().optional().nullable(),
	identityFile: z.string().trim().optional().nullable(),
	password: z.string().optional().nullable(),
	clearPassword: z.boolean().optional(),
});

const aliasInputSchema = z.object({
	alias: z.string().trim().min(1),
});

const mountHostInputSchema = z.object({
	alias: z.string().trim().min(1),
	mountPath: z.string().trim().optional().nullable(),
});

function expandHome(inputPath: string): string {
	if (inputPath === "~") {
		return os.homedir();
	}
	if (inputPath.startsWith("~/")) {
		return path.join(os.homedir(), inputPath.slice(2));
	}
	return inputPath;
}

function normalizeDisplayPath(inputPath: string): string {
	const home = os.homedir();
	if (inputPath === home) {
		return "~";
	}
	if (inputPath.startsWith(`${home}${path.sep}`)) {
		return `~${inputPath.slice(home.length)}`;
	}
	return inputPath;
}

function stripInlineComment(line: string): string {
	let escaped = false;
	let inSingle = false;
	let inDouble = false;

	for (let index = 0; index < line.length; index += 1) {
		const char = line[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (char === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (char === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if (char === "#" && !inSingle && !inDouble) {
			return line.slice(0, index);
		}
	}

	return line;
}

function splitDirective(line: string): { key: string; value: string } | null {
	const match = /^(\S+)\s+(.+)$/.exec(line);
	if (!match) {
		return null;
	}
	return {
		key: match[1],
		value: match[2].trim(),
	};
}

function tokenize(value: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let escaped = false;
	let inSingle = false;
	let inDouble = false;

	const pushCurrent = () => {
		const trimmed = current.trim();
		if (trimmed.length > 0) {
			tokens.push(trimmed);
		}
		current = "";
	};

	for (let index = 0; index < value.length; index += 1) {
		const char = value[index];
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (char === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (char === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if (!inSingle && !inDouble && /\s/.test(char)) {
			pushCurrent();
			continue;
		}
		current += char;
	}

	pushCurrent();
	return tokens;
}

function parsePort(value: string | undefined): number | null {
	if (!value) return null;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return null;
	}
	return parsed;
}

function collectTags(alias: string, hostName: string | null): string[] {
	const words = `${alias} ${hostName ?? ""}`
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
	const result = new Set<string>();
	for (const candidate of INFERRED_TAGS) {
		if (words.includes(candidate)) {
			result.add(candidate);
		}
	}
	return Array.from(result);
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function toNullableString(value: string | null | undefined): string | null {
	if (typeof value !== "string") return null;
	const next = value.trim();
	return next.length > 0 ? next : null;
}

function sanitizeAliasForPath(alias: string): string {
	const normalized = alias
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return normalized || "host";
}

function getDefaultMountPath(alias: string): string {
	return path.join(SSHFS_MOUNT_ROOT, sanitizeAliasForPath(alias));
}

function resolveMountPath(
	alias: string,
	mountPath: string | null | undefined,
): string {
	const input = toNullableString(mountPath);
	if (!input) {
		return getDefaultMountPath(alias);
	}
	return path.resolve(expandHome(input));
}

async function runCommand(
	command: string,
	args: string[],
	options: RunCommandOptions = {},
): Promise<RunCommandResult> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: "pipe",
			env: options.env ? { ...process.env, ...options.env } : process.env,
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 1500).unref();
		}, timeoutMs);

		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (timedOut) {
				reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`));
				return;
			}
			const exitCode = typeof code === "number" ? code : -1;
			if (exitCode !== 0 && !options.allowNonZero) {
				const message = stderr.trim() || `Command exited with code ${exitCode}`;
				reject(new Error(message));
				return;
			}
			resolve({ stdout, stderr, exitCode });
		});

		if (options.stdin !== undefined) {
			child.stdin.write(options.stdin);
		}
		child.stdin.end();
	});
}

async function commandExists(command: string): Promise<boolean> {
	const probe = process.platform === "win32" ? "where" : "which";
	try {
		const result = await runCommand(probe, [command], {
			timeoutMs: 1500,
			allowNonZero: true,
		});
		return result.exitCode === 0;
	} catch {
		return false;
	}
}

function getCredentialMap(): Record<string, SshCredentialEntry> {
	const sshState = appState.data.sshState;
	if (!sshState.credentialsByAlias) {
		sshState.credentialsByAlias = {};
	}
	return sshState.credentialsByAlias;
}

function getMountMap(): Record<string, SshMountStateEntry> {
	const sshState = appState.data.sshState;
	if (!sshState.mountsByAlias) {
		sshState.mountsByAlias = {};
	}
	return sshState.mountsByAlias;
}

function getFallbackAuthMode(host: ParsedSshHost): SshAuthMode {
	if (host.identityFile) {
		return "key";
	}
	return "agent";
}

function toPublicCredential(
	host: ParsedSshHost,
	credential: SshCredentialEntry | null,
): SshCredentialPublic {
	const authMode = credential?.authMode ?? getFallbackAuthMode(host);
	return {
		authMode,
		user: credential?.user ?? null,
		port: credential?.port ?? null,
		identityFile: credential?.identityFile ?? null,
		hasPassword: Boolean(credential?.passwordCiphertext),
		updatedAt: credential?.updatedAt ?? null,
	};
}

function getResolvedTarget(
	host: ParsedSshHost,
	credential: SshCredentialPublic,
): string {
	const address = host.hostName ?? host.alias;
	const user = credential.user ?? host.user;
	const port = credential.port ?? host.port;
	const withUser = user ? `${user}@${address}` : address;
	return port ? `${withUser}:${port}` : withUser;
}

function buildSshOptionArgs(
	host: ParsedSshHost,
	credential: SshCredentialPublic,
	options: { nonInteractive: boolean },
): string[] {
	const args: string[] = [];
	const user = credential.user ?? host.user;
	const port = credential.port ?? host.port;
	const identityFile = credential.identityFile ?? host.identityFile;

	if (credential.authMode === "password") {
		args.push(
			"-o",
			"PreferredAuthentications=password",
			"-o",
			"PubkeyAuthentication=no",
			"-o",
			"NumberOfPasswordPrompts=1",
		);
	} else if (options.nonInteractive) {
		args.push("-o", "BatchMode=yes");
	}

	if (credential.authMode === "key" && identityFile) {
		args.push("-o", "IdentitiesOnly=yes", "-i", expandHome(identityFile));
	}

	if (user) {
		args.push("-l", user);
	}

	if (port) {
		args.push("-p", String(port));
	}

	args.push("-o", "StrictHostKeyChecking=accept-new");
	return args;
}

function buildBaseSshCommand(
	host: ParsedSshHost,
	credential: SshCredentialPublic,
): string {
	const command: string[] = ["ssh"];
	for (const arg of buildSshOptionArgs(host, credential, {
		nonInteractive: false,
	})) {
		command.push(shellQuote(arg));
	}
	command.push(shellQuote(host.alias));
	return command.join(" ");
}

function decryptPassword(ciphertext: string | null): string | null {
	if (!ciphertext) return null;
	try {
		return decrypt(Buffer.from(ciphertext, "base64"));
	} catch {
		return null;
	}
}

function buildLaunchCommand(
	host: ParsedSshHost,
	credential: SshCredentialPublic,
	passwordCiphertext: string | null,
): string {
	const baseCommand = buildBaseSshCommand(host, credential);
	if (credential.authMode !== "password") {
		return baseCommand;
	}

	const password = decryptPassword(passwordCiphertext);
	if (!password) {
		return baseCommand;
	}

	const fallbackMessage =
		"sshpass not found. Install it (brew install hudochenkov/sshpass/sshpass) or use key auth.";

	return `if command -v sshpass >/dev/null 2>&1; then SSHPASS=${shellQuote(password)} sshpass -e ${baseCommand}; else echo ${shellQuote(fallbackMessage)}; ${baseCommand}; fi`;
}

function toHostEntry(
	host: ParsedSshHost,
	credentialRecord: SshCredentialEntry | null,
): SshHostEntry {
	const credential = toPublicCredential(host, credentialRecord);
	return {
		...host,
		resolvedTarget: getResolvedTarget(host, credential),
		commandPreview: buildBaseSshCommand(host, credential),
		credential,
	};
}

async function resolveIncludeTargets(
	baseDir: string,
	rawValue: string,
): Promise<string[]> {
	const includePatterns = tokenize(rawValue);
	if (includePatterns.length === 0) {
		return [];
	}

	const includeTargets = new Set<string>();
	for (const patternToken of includePatterns) {
		const expanded = expandHome(patternToken);
		const absolutePattern = path.isAbsolute(expanded)
			? expanded
			: path.resolve(baseDir, expanded);

		const matches = await fg(absolutePattern.replace(/\\/g, "/"), {
			onlyFiles: true,
			dot: true,
			unique: true,
			followSymbolicLinks: false,
			suppressErrors: true,
		});

		if (matches.length > 0) {
			for (const match of matches) {
				includeTargets.add(path.resolve(match));
			}
			continue;
		}

		try {
			const stat = await fs.stat(absolutePattern);
			if (stat.isFile()) {
				includeTargets.add(path.resolve(absolutePattern));
			}
		} catch {
			// Ignore missing includes.
		}
	}

	return Array.from(includeTargets).sort((a, b) => a.localeCompare(b));
}

function mergeHostBlock(
	state: ParseState,
	input: {
		aliases: string[];
		directives: Map<string, string>;
		sourcePath: string;
		line: number;
	},
): void {
	const hostName = input.directives.get("hostname") ?? null;
	const user = input.directives.get("user") ?? null;
	const port = parsePort(input.directives.get("port"));
	const identityFile = input.directives.get("identityfile") ?? null;
	const proxyJump = input.directives.get("proxyjump") ?? null;

	for (const aliasRaw of input.aliases) {
		const alias = aliasRaw.trim();
		if (!alias || alias === "*" || /[*?!]/.test(alias)) {
			continue;
		}

		const previous = state.hostsByAlias.get(alias);
		const nextHostName = hostName ?? previous?.hostName ?? null;
		state.hostsByAlias.set(alias, {
			alias,
			hostName: nextHostName,
			user: user ?? previous?.user ?? null,
			port: port ?? previous?.port ?? null,
			identityFile: identityFile ?? previous?.identityFile ?? null,
			proxyJump: proxyJump ?? previous?.proxyJump ?? null,
			sourcePath: normalizeDisplayPath(input.sourcePath),
			line: input.line,
			tags: collectTags(alias, nextHostName),
		});
	}
}

async function parseSshConfigFile(filePath: string, state: ParseState) {
	const resolvedPath = path.resolve(filePath);
	if (state.visitedFiles.has(resolvedPath)) {
		return;
	}
	state.visitedFiles.add(resolvedPath);

	let content = "";
	try {
		content = await fs.readFile(resolvedPath, "utf8");
	} catch {
		return;
	}

	const lines = content.split(/\r?\n/);
	const baseDir = path.dirname(resolvedPath);
	let currentAliases: string[] = [];
	let currentDirectives = new Map<string, string>();
	let currentLine = 0;

	const flushCurrentHost = () => {
		if (currentAliases.length === 0) {
			return;
		}
		mergeHostBlock(state, {
			aliases: currentAliases,
			directives: currentDirectives,
			sourcePath: resolvedPath,
			line: currentLine,
		});
		currentAliases = [];
		currentDirectives = new Map<string, string>();
		currentLine = 0;
	};

	for (let index = 0; index < lines.length; index += 1) {
		const withoutComment = stripInlineComment(lines[index]).trim();
		if (!withoutComment) {
			continue;
		}

		const directive = splitDirective(withoutComment);
		if (!directive) {
			continue;
		}

		const key = directive.key.toLowerCase();
		if (key === "include") {
			const includeTargets = await resolveIncludeTargets(
				baseDir,
				directive.value,
			);
			for (const includeTarget of includeTargets) {
				await parseSshConfigFile(includeTarget, state);
			}
			continue;
		}

		if (key === "host") {
			flushCurrentHost();
			currentAliases = tokenize(directive.value);
			currentLine = index + 1;
			continue;
		}

		if (currentAliases.length === 0) {
			continue;
		}
		currentDirectives.set(key, directive.value);
	}

	flushCurrentHost();
}

async function parseSshHosts(): Promise<ParsedSshHost[]> {
	const state: ParseState = {
		visitedFiles: new Set<string>(),
		hostsByAlias: new Map<string, ParsedSshHost>(),
	};

	const primaryConfig = path.join(os.homedir(), ".ssh", "config");
	await parseSshConfigFile(primaryConfig, state);

	return Array.from(state.hostsByAlias.values()).sort((a, b) =>
		a.alias.localeCompare(b.alias),
	);
}

async function getMountedPathSet(): Promise<Set<string>> {
	const result = await runCommand("mount", [], {
		allowNonZero: true,
		timeoutMs: 3000,
	});
	const mountedPaths = new Set<string>();
	if (result.exitCode !== 0) {
		return mountedPaths;
	}
	for (const line of result.stdout.split(/\r?\n/)) {
		const normalizedLine = line.trim();
		if (!normalizedLine) continue;
		const onParen = /\s+on\s+(.+?)\s+\(/.exec(normalizedLine);
		if (onParen?.[1]) {
			mountedPaths.add(path.resolve(onParen[1]));
			continue;
		}
		const onType = /\s+on\s+(.+?)\s+type\s+/.exec(normalizedLine);
		if (onType?.[1]) {
			mountedPaths.add(path.resolve(onType[1]));
		}
	}
	return mountedPaths;
}

function getHostOrThrow(hosts: ParsedSshHost[], alias: string): ParsedSshHost {
	const host = hosts.find((item) => item.alias === alias);
	if (!host) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: `SSH host "${alias}" not found in ~/.ssh/config`,
		});
	}
	return host;
}

async function runSshWithCredential(
	host: ParsedSshHost,
	credential: SshCredentialPublic,
	passwordCiphertext: string | null,
	remoteCommand: string,
): Promise<RunCommandResult> {
	const sshArgs = [
		...buildSshOptionArgs(host, credential, { nonInteractive: true }),
		host.alias,
		remoteCommand,
	];

	if (credential.authMode === "password") {
		const password = decryptPassword(passwordCiphertext);
		if (!password) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Password auth selected but no saved password found.",
			});
		}
		if (!(await commandExists("sshpass"))) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message:
					"Password auth requires sshpass for non-interactive commands. Install it first.",
			});
		}
		return runCommand("sshpass", ["-p", password, "ssh", ...sshArgs], {
			timeoutMs: INSPECT_TIMEOUT_MS,
		});
	}

	return runCommand("ssh", sshArgs, { timeoutMs: INSPECT_TIMEOUT_MS });
}

function buildSshfsArgs(
	host: ParsedSshHost,
	credential: SshCredentialPublic,
	mountPath: string,
): string[] {
	const args = [
		`${host.alias}:/`,
		mountPath,
		"-o",
		"reconnect",
		"-o",
		"ServerAliveInterval=15",
		"-o",
		"ServerAliveCountMax=3",
		"-o",
		"StrictHostKeyChecking=accept-new",
	];

	const user = credential.user ?? host.user;
	const port = credential.port ?? host.port;
	const identityFile = credential.identityFile ?? host.identityFile;

	if (user) {
		args.push("-o", `User=${user}`);
	}
	if (port) {
		args.push("-p", String(port));
	}
	if (credential.authMode === "key" && identityFile) {
		args.push(
			"-o",
			`IdentityFile=${expandHome(identityFile)}`,
			"-o",
			"IdentitiesOnly=yes",
		);
	}
	if (credential.authMode === "password") {
		args.push("-o", "password_stdin");
	}

	return args;
}

async function mountHostViaSshfs(
	host: ParsedSshHost,
	credential: SshCredentialPublic,
	passwordCiphertext: string | null,
	mountPath: string,
): Promise<void> {
	if (!(await commandExists("sshfs"))) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"sshfs is not installed. Install sshfs (and macFUSE on macOS) first.",
		});
	}

	await fs.mkdir(mountPath, { recursive: true });
	const args = buildSshfsArgs(host, credential, mountPath);

	let stdin: string | undefined;
	if (credential.authMode === "password") {
		const password = decryptPassword(passwordCiphertext);
		if (!password) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Password auth selected but no saved password found.",
			});
		}
		stdin = `${password}\n`;
	}

	await runCommand("sshfs", args, {
		timeoutMs: MOUNT_TIMEOUT_MS,
		stdin,
	});
}

async function unmountPath(mountPath: string): Promise<void> {
	const candidates: Array<[string, string[]]> =
		process.platform === "darwin"
			? [
					["umount", [mountPath]],
					["umount", ["-f", mountPath]],
					["diskutil", ["unmount", mountPath]],
				]
			: [
					["fusermount3", ["-u", mountPath]],
					["fusermount", ["-u", mountPath]],
					["umount", [mountPath]],
				];

	let lastError: string | null = null;
	for (const [command, args] of candidates) {
		if (!(await commandExists(command))) {
			continue;
		}
		const result = await runCommand(command, args, {
			allowNonZero: true,
			timeoutMs: 10_000,
		});
		if (result.exitCode === 0) {
			return;
		}
		lastError = result.stderr.trim() || `exit code ${result.exitCode}`;
	}

	throw new Error(lastError ?? "No available unmount command succeeded.");
}

function saveMountState(
	alias: string,
	patch: Partial<SshMountStateEntry>,
): void {
	const mountsByAlias = getMountMap();
	const previous = mountsByAlias[alias];
	mountsByAlias[alias] = {
		mountPath: previous?.mountPath ?? getDefaultMountPath(alias),
		lastMountedAt: previous?.lastMountedAt ?? null,
		lastUnmountedAt: previous?.lastUnmountedAt ?? null,
		lastError: previous?.lastError ?? null,
		...patch,
	};
}

function toMountEntry(
	alias: string,
	mountPath: string,
	isMounted: boolean,
	state: SshMountStateEntry | null,
): SshMountEntry {
	return {
		alias,
		mountPath,
		isMounted,
		lastMountedAt: state?.lastMountedAt ?? null,
		lastUnmountedAt: state?.lastUnmountedAt ?? null,
		lastError: state?.lastError ?? null,
	};
}

export const createSshRouter = () => {
	return router({
		getCapabilities: publicProcedure.query(async () => {
			const [hasSshfs, hasSshpass] = await Promise.all([
				commandExists("sshfs"),
				commandExists("sshpass"),
			]);
			return {
				hasSshfs,
				hasSshpass,
			};
		}),

		listHosts: publicProcedure.query(async () => {
			const hosts = await parseSshHosts();
			const credentialMap = getCredentialMap();
			return {
				hosts: hosts.map((host) =>
					toHostEntry(host, credentialMap[host.alias] ?? null),
				),
			};
		}),

		listMounts: publicProcedure.query(async () => {
			const hosts = await parseSshHosts();
			const hostAliases = new Set(hosts.map((host) => host.alias));
			const mountedPaths = await getMountedPathSet();
			const mountsByAlias = getMountMap();

			const mounts = hosts.map((host) => {
				const state = mountsByAlias[host.alias] ?? null;
				const mountPath = state?.mountPath ?? getDefaultMountPath(host.alias);
				return toMountEntry(
					host.alias,
					mountPath,
					mountedPaths.has(path.resolve(mountPath)),
					state,
				);
			});

			for (const [alias, state] of Object.entries(mountsByAlias)) {
				if (hostAliases.has(alias)) continue;
				const mountPath = state.mountPath || getDefaultMountPath(alias);
				mounts.push(
					toMountEntry(
						alias,
						mountPath,
						mountedPaths.has(path.resolve(mountPath)),
						state,
					),
				);
			}

			mounts.sort((a, b) => a.alias.localeCompare(b.alias));
			return { mounts };
		}),

		getLaunchCommand: publicProcedure
			.input(aliasInputSchema)
			.mutation(async ({ input }) => {
				const hosts = await parseSshHosts();
				const host = getHostOrThrow(hosts, input.alias);
				const credentialRecord = getCredentialMap()[host.alias] ?? null;
				const credential = toPublicCredential(host, credentialRecord);
				const launchCommand = buildLaunchCommand(
					host,
					credential,
					credentialRecord?.passwordCiphertext ?? null,
				);

				return {
					alias: host.alias,
					launchCommand,
					commandPreview: buildBaseSshCommand(host, credential),
				};
			}),

		upsertCredential: publicProcedure
			.input(upsertCredentialInputSchema)
			.mutation(async ({ input }) => {
				const credentialsByAlias = getCredentialMap();
				const previous = credentialsByAlias[input.alias] ?? null;
				const user = toNullableString(input.user);
				const identityFile = toNullableString(input.identityFile);
				const port =
					typeof input.port === "number" && Number.isFinite(input.port)
						? input.port
						: null;

				let passwordCiphertext = previous?.passwordCiphertext ?? null;
				const trimmedPassword = toNullableString(input.password);
				if (input.authMode !== "password" || input.clearPassword === true) {
					passwordCiphertext = null;
				} else if (trimmedPassword) {
					passwordCiphertext = encrypt(trimmedPassword).toString("base64");
				}

				credentialsByAlias[input.alias] = {
					authMode: input.authMode,
					user,
					port,
					identityFile,
					passwordCiphertext,
					updatedAt: Date.now(),
				};
				await appState.write();

				return { success: true };
			}),

		clearCredential: publicProcedure
			.input(aliasInputSchema)
			.mutation(async ({ input }) => {
				const credentialsByAlias = getCredentialMap();
				delete credentialsByAlias[input.alias];
				await appState.write();
				return { success: true };
			}),

		mountHost: publicProcedure
			.input(mountHostInputSchema)
			.mutation(async ({ input }) => {
				const hosts = await parseSshHosts();
				const host = getHostOrThrow(hosts, input.alias);
				const credentialRecord = getCredentialMap()[host.alias] ?? null;
				const credential = toPublicCredential(host, credentialRecord);
				const mountPath = resolveMountPath(host.alias, input.mountPath);

				try {
					const mountedPaths = await getMountedPathSet();
					if (!mountedPaths.has(path.resolve(mountPath))) {
						await mountHostViaSshfs(
							host,
							credential,
							credentialRecord?.passwordCiphertext ?? null,
							mountPath,
						);
					}

					saveMountState(host.alias, {
						mountPath,
						lastMountedAt: Date.now(),
						lastError: null,
					});
					await appState.write();

					return {
						success: true,
						alias: host.alias,
						mountPath,
					};
				} catch (error) {
					saveMountState(host.alias, {
						mountPath,
						lastError: error instanceof Error ? error.message : String(error),
					});
					await appState.write();
					throw new TRPCError({
						code: "BAD_REQUEST",
						message:
							error instanceof Error ? error.message : "Failed to mount host.",
					});
				}
			}),

		unmountHost: publicProcedure
			.input(aliasInputSchema)
			.mutation(async ({ input }) => {
				const alias = input.alias;
				const mountsByAlias = getMountMap();
				const state = mountsByAlias[alias] ?? null;
				const mountPath = state?.mountPath ?? getDefaultMountPath(alias);

				try {
					const mountedPaths = await getMountedPathSet();
					if (mountedPaths.has(path.resolve(mountPath))) {
						await unmountPath(mountPath);
					}

					saveMountState(alias, {
						mountPath,
						lastUnmountedAt: Date.now(),
						lastError: null,
					});
					await appState.write();
					return {
						success: true,
						alias,
						mountPath,
					};
				} catch (error) {
					saveMountState(alias, {
						mountPath,
						lastError: error instanceof Error ? error.message : String(error),
					});
					await appState.write();
					throw new TRPCError({
						code: "BAD_REQUEST",
						message:
							error instanceof Error
								? error.message
								: "Failed to unmount host.",
					});
				}
			}),

		inspectHost: publicProcedure
			.input(aliasInputSchema)
			.mutation(async ({ input }) => {
				const hosts = await parseSshHosts();
				const host = getHostOrThrow(hosts, input.alias);
				const credentialRecord = getCredentialMap()[host.alias] ?? null;
				const credential = toPublicCredential(host, credentialRecord);

				const command = [
					"(uname -srm 2>/dev/null || uname -a 2>/dev/null || echo unknown)",
					`echo ${MOUNT_SEPARATOR}`,
					"(hostname 2>/dev/null || echo unknown)",
					`echo ${MOUNT_SEPARATOR}`,
					"(uptime 2>/dev/null || echo unknown)",
					`echo ${MOUNT_SEPARATOR}`,
					"(df -h / 2>/dev/null | tail -n 1 || echo unknown)",
					`echo ${MOUNT_SEPARATOR}`,
					"(whoami 2>/dev/null || echo unknown)",
				].join("; ");

				const result = await runSshWithCredential(
					host,
					credential,
					credentialRecord?.passwordCiphertext ?? null,
					command,
				);

				const parts = result.stdout
					.split(MOUNT_SEPARATOR)
					.map((part) => part.trim())
					.filter(Boolean);

				return {
					alias: host.alias,
					os: parts[0] ?? "unknown",
					hostname: parts[1] ?? "unknown",
					uptime: parts[2] ?? "unknown",
					diskRoot: parts[3] ?? "unknown",
					remoteUser: parts[4] ?? "unknown",
					fetchedAt: Date.now(),
				};
			}),
	});
};
