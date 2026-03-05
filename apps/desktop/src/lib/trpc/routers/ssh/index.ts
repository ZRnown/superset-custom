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

interface ParseState {
	visitedFiles: Set<string>;
	hostsByAlias: Map<string, ParsedSshHost>;
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

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function toNullableString(value: string | null | undefined): string | null {
	if (typeof value !== "string") return null;
	const next = value.trim();
	return next.length > 0 ? next : null;
}

function getCredentialMap(): Record<string, SshCredentialEntry> {
	const state = appState.data.sshState;
	if (!state || !state.credentialsByAlias) {
		return {};
	}
	return state.credentialsByAlias;
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

function buildBaseSshCommand(
	host: ParsedSshHost,
	credential: SshCredentialPublic,
): string {
	const command: string[] = ["ssh"];
	const user = credential.user ?? host.user;
	const port = credential.port ?? host.port;
	const identityFile = credential.identityFile ?? host.identityFile;

	if (credential.authMode === "password") {
		command.push(
			"-o",
			"PreferredAuthentications=password",
			"-o",
			"PubkeyAuthentication=no",
			"-o",
			"NumberOfPasswordPrompts=1",
		);
	}

	if (credential.authMode === "key" && identityFile) {
		command.push(
			"-o",
			"IdentitiesOnly=yes",
			"-i",
			shellQuote(expandHome(identityFile)),
		);
	}

	if (user) {
		command.push("-l", shellQuote(user));
	}

	if (port) {
		command.push("-p", String(port));
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

export const createSshRouter = () => {
	return router({
		listHosts: publicProcedure.query(async () => {
			const hosts = await parseSshHosts();
			const credentialMap = getCredentialMap();
			return {
				hosts: hosts.map((host) =>
					toHostEntry(host, credentialMap[host.alias] ?? null),
				),
			};
		}),

		getLaunchCommand: publicProcedure
			.input(aliasInputSchema)
			.mutation(async ({ input }) => {
				const hosts = await parseSshHosts();
				const host = hosts.find((item) => item.alias === input.alias);
				if (!host) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: `SSH host "${input.alias}" not found in ~/.ssh/config`,
					});
				}

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

				appState.data.sshState.credentialsByAlias[input.alias] = {
					authMode: input.authMode,
					user,
					port,
					identityFile,
					passwordCiphertext,
					updatedAt: Date.now(),
				};
				await appState.write();

				return {
					success: true,
					credential: toPublicCredential(
						{
							alias: input.alias,
							hostName: null,
							user: null,
							port: null,
							identityFile: null,
							proxyJump: null,
							sourcePath: "~/.ssh/config",
							line: 0,
							tags: [],
						},
						appState.data.sshState.credentialsByAlias[input.alias],
					),
				};
			}),

		clearCredential: publicProcedure
			.input(aliasInputSchema)
			.mutation(async ({ input }) => {
				delete appState.data.sshState.credentialsByAlias[input.alias];
				await appState.write();
				return { success: true };
			}),
	});
};
