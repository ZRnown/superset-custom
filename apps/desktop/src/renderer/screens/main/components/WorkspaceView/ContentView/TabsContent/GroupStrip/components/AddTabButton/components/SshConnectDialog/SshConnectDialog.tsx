import { Badge } from "@superset/ui/badge";
import { Button } from "@superset/ui/button";
import { Dialog, DialogContent } from "@superset/ui/dialog";
import { Input } from "@superset/ui/input";
import { toast } from "@superset/ui/sonner";
import { useEffect, useMemo, useState } from "react";
import {
	LuCornerDownRight,
	LuFolderOpen,
	LuHardDrive,
	LuInfo,
	LuKeyRound,
	LuPlug,
	LuSearch,
	LuServer,
	LuShieldCheck,
	LuWaypoints,
} from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";

type AuthMode = "agent" | "key" | "password";

interface SshConnectDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onConnectHost: (alias: string) => void;
}

interface SshHostItem {
	alias: string;
	hostName: string | null;
	user: string | null;
	port: number | null;
	identityFile: string | null;
	proxyJump: string | null;
	sourcePath: string;
	line: number;
	tags: string[];
	resolvedTarget: string;
	commandPreview: string;
	credential: {
		authMode: AuthMode;
		user: string | null;
		port: number | null;
		identityFile: string | null;
		hasPassword: boolean;
		updatedAt: number | null;
	};
}

interface SshMountInfo {
	alias: string;
	mountPath: string;
	isMounted: boolean;
	lastMountedAt: number | null;
	lastUnmountedAt: number | null;
	lastError: string | null;
}

interface SshRuntimeInfo {
	alias: string;
	os: string;
	hostname: string;
	uptime: string;
	diskRoot: string;
	remoteUser: string;
	fetchedAt: number;
}

interface CredentialDraft {
	authMode: AuthMode;
	user: string;
	port: string;
	identityFile: string;
	password: string;
	clearPassword: boolean;
}

function containsNeedle(
	value: string | null | undefined,
	needle: string,
): boolean {
	if (!value) return false;
	return value.toLowerCase().includes(needle);
}

function formatUpdatedAt(updatedAt: number | null): string {
	if (!updatedAt) return "Never";
	const date = new Date(updatedAt);
	if (Number.isNaN(date.getTime())) return "Unknown";
	return date.toLocaleString();
}

function createDraft(host: SshHostItem): CredentialDraft {
	return {
		authMode: host.credential.authMode,
		user: host.credential.user ?? "",
		port: host.credential.port ? String(host.credential.port) : "",
		identityFile: host.credential.identityFile ?? "",
		password: "",
		clearPassword: false,
	};
}

export function SshConnectDialog({
	open,
	onOpenChange,
	onConnectHost,
}: SshConnectDialogProps) {
	const [search, setSearch] = useState("");
	const [editingAlias, setEditingAlias] = useState<string | null>(null);
	const [draftByAlias, setDraftByAlias] = useState<
		Record<string, CredentialDraft>
	>({});
	const [runtimeByAlias, setRuntimeByAlias] = useState<
		Record<string, SshRuntimeInfo>
	>({});

	const sshHostsQuery = electronTrpc.ssh.listHosts.useQuery(undefined, {
		enabled: open,
		staleTime: 30_000,
	});
	const sshCapabilitiesQuery = electronTrpc.ssh.getCapabilities.useQuery(
		undefined,
		{
			enabled: open,
			staleTime: 60_000,
		},
	);
	const sshMountsQuery = electronTrpc.ssh.listMounts.useQuery(undefined, {
		enabled: open,
		staleTime: 2000,
		refetchInterval: open ? 5000 : false,
	});
	const saveCredentialMutation =
		electronTrpc.ssh.upsertCredential.useMutation();
	const clearCredentialMutation =
		electronTrpc.ssh.clearCredential.useMutation();
	const mountHostMutation = electronTrpc.ssh.mountHost.useMutation();
	const unmountHostMutation = electronTrpc.ssh.unmountHost.useMutation();
	const inspectHostMutation = electronTrpc.ssh.inspectHost.useMutation();
	const openInFinderMutation = electronTrpc.external.openInFinder.useMutation();

	useEffect(() => {
		if (!open) {
			setSearch("");
			setEditingAlias(null);
			setDraftByAlias({});
			setRuntimeByAlias({});
		}
	}, [open]);

	const hosts = useMemo(
		() => (sshHostsQuery.data?.hosts ?? []) as SshHostItem[],
		[sshHostsQuery.data?.hosts],
	);

	const mountsByAlias = useMemo(() => {
		const map = new Map<string, SshMountInfo>();
		for (const mount of (sshMountsQuery.data?.mounts ?? []) as SshMountInfo[]) {
			map.set(mount.alias, mount);
		}
		return map;
	}, [sshMountsQuery.data?.mounts]);

	const filteredHosts = useMemo(() => {
		const needle = search.trim().toLowerCase();
		if (!needle) {
			return hosts;
		}
		return hosts.filter((host) => {
			if (containsNeedle(host.alias, needle)) return true;
			if (containsNeedle(host.hostName, needle)) return true;
			if (containsNeedle(host.user, needle)) return true;
			if (containsNeedle(host.proxyJump, needle)) return true;
			if (containsNeedle(host.resolvedTarget, needle)) return true;
			if (host.tags.some((tag) => containsNeedle(tag, needle))) return true;
			return false;
		});
	}, [hosts, search]);

	const ensureDraft = (host: SshHostItem) => {
		setDraftByAlias((previous) => {
			if (previous[host.alias]) {
				return previous;
			}
			return {
				...previous,
				[host.alias]: createDraft(host),
			};
		});
	};

	const setDraftPatch = (alias: string, patch: Partial<CredentialDraft>) => {
		setDraftByAlias((previous) => {
			const fallbackHost = hosts.find((item) => item.alias === alias);
			const current =
				previous[alias] ??
				(fallbackHost
					? createDraft(fallbackHost)
					: {
							authMode: "agent" as AuthMode,
							user: "",
							port: "",
							identityFile: "",
							password: "",
							clearPassword: false,
						});
			return {
				...previous,
				[alias]: {
					...current,
					...patch,
				},
			};
		});
	};

	const saveCredential = async (host: SshHostItem) => {
		const draft = draftByAlias[host.alias] ?? createDraft(host);
		const parsedPort = Number.parseInt(draft.port, 10);
		const nextPort =
			draft.port.trim().length === 0 ||
			Number.isNaN(parsedPort) ||
			parsedPort <= 0
				? null
				: parsedPort;

		await saveCredentialMutation.mutateAsync({
			alias: host.alias,
			authMode: draft.authMode,
			user: draft.user.trim().length > 0 ? draft.user.trim() : null,
			port: nextPort,
			identityFile:
				draft.identityFile.trim().length > 0 ? draft.identityFile.trim() : null,
			password: draft.password.trim().length > 0 ? draft.password.trim() : null,
			clearPassword: draft.clearPassword,
		});

		setDraftPatch(host.alias, {
			password: "",
			clearPassword: false,
		});
		await Promise.all([sshHostsQuery.refetch(), sshMountsQuery.refetch()]);
		toast.success(`Saved SSH auth for ${host.alias}`);
	};

	const clearCredential = async (alias: string) => {
		await clearCredentialMutation.mutateAsync({ alias });
		setDraftByAlias((previous) => {
			const next = { ...previous };
			delete next[alias];
			return next;
		});
		await sshHostsQuery.refetch();
		toast.success(`Cleared saved auth for ${alias}`);
	};

	const toggleMount = async (
		host: SshHostItem,
		mountInfo: SshMountInfo | null,
	) => {
		if (mountInfo?.isMounted) {
			await unmountHostMutation.mutateAsync({ alias: host.alias });
			toast.success(`Unmounted ${host.alias}`);
		} else {
			await mountHostMutation.mutateAsync({
				alias: host.alias,
				mountPath: mountInfo?.mountPath ?? null,
			});
			toast.success(`Mounted ${host.alias}`);
		}
		await sshMountsQuery.refetch();
	};

	const inspectHost = async (alias: string) => {
		const info = await inspectHostMutation.mutateAsync({ alias });
		setRuntimeByAlias((previous) => ({
			...previous,
			[alias]: info as SshRuntimeInfo,
		}));
	};

	const hasSshfs = sshCapabilitiesQuery.data?.hasSshfs ?? false;
	const isBusy =
		saveCredentialMutation.isPending ||
		clearCredentialMutation.isPending ||
		mountHostMutation.isPending ||
		unmountHostMutation.isPending ||
		inspectHostMutation.isPending;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-[920px] overflow-hidden border-border/70 p-0">
				<div className="border-b border-border/60 bg-muted/20 px-5 py-4">
					<div className="flex items-center gap-2">
						<div className="rounded-md border border-border p-1.5 text-muted-foreground">
							<LuServer className="size-4" />
						</div>
						<div>
							<p className="text-sm font-medium text-foreground">SSH Hub</p>
							<p className="text-xs text-muted-foreground">
								Hosts from <code>~/.ssh/config</code>. Save auth, mount remote
								files via SSHFS, and inspect server runtime info.
							</p>
						</div>
					</div>
					<div className="mt-3 relative">
						<LuSearch className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
						<Input
							value={search}
							onChange={(event) => setSearch(event.target.value)}
							placeholder="Search alias, hostname, tags..."
							className="h-8 pl-8 text-xs"
						/>
					</div>
					{!hasSshfs ? (
						<p className="mt-2 text-[11px] text-muted-foreground">
							SSHFS not found. Install it first to enable mount/unmount.
						</p>
					) : null}
				</div>

				<div className="max-h-[68vh] overflow-y-auto px-4 py-3">
					{sshHostsQuery.isLoading ? (
						<div className="rounded-lg border border-dashed border-border/70 p-6 text-center text-xs text-muted-foreground">
							Reading SSH hosts...
						</div>
					) : filteredHosts.length === 0 ? (
						<div className="rounded-lg border border-dashed border-border/70 p-6 text-center text-xs text-muted-foreground">
							{hosts.length === 0
								? "No SSH hosts found. Add Host blocks to ~/.ssh/config."
								: "No hosts match the current search."}
						</div>
					) : (
						<div className="space-y-3">
							{filteredHosts.map((host) => {
								const isEditing = editingAlias === host.alias;
								const mountInfo = mountsByAlias.get(host.alias) ?? null;
								const runtime = runtimeByAlias[host.alias] ?? null;
								const draft = draftByAlias[host.alias] ?? createDraft(host);

								return (
									<div
										key={host.alias}
										className="rounded-lg border border-border/70 bg-background px-3 py-3"
									>
										<div className="flex items-start justify-between gap-3">
											<div className="min-w-0 flex-1">
												<div className="flex flex-wrap items-center gap-2">
													<span className="truncate font-mono text-xs font-semibold text-foreground">
														{host.alias}
													</span>
													{host.tags.slice(0, 3).map((tag) => (
														<Badge
															key={`${host.alias}-${tag}`}
															variant="outline"
															className="h-5 rounded-full border-border/70 px-1.5 text-[10px]"
														>
															{tag}
														</Badge>
													))}
													<Badge
														variant="outline"
														className="h-5 rounded-full border-border/70 px-1.5 text-[10px]"
													>
														<LuShieldCheck className="mr-1 size-3" />
														{host.credential.authMode}
													</Badge>
													<Badge
														variant="outline"
														className="h-5 rounded-full border-border/70 px-1.5 text-[10px]"
													>
														<LuHardDrive className="mr-1 size-3" />
														{mountInfo?.isMounted ? "Mounted" : "Unmounted"}
													</Badge>
												</div>
												<p className="mt-1 truncate text-[11px] text-muted-foreground">
													{host.resolvedTarget}
												</p>
												<div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
													<span className="inline-flex items-center gap-1">
														<LuCornerDownRight className="size-3" />
														{host.sourcePath}:{host.line}
													</span>
													{host.identityFile ? (
														<span className="inline-flex items-center gap-1">
															<LuKeyRound className="size-3" />
															{host.identityFile}
														</span>
													) : null}
													{host.proxyJump ? (
														<span className="inline-flex items-center gap-1">
															<LuWaypoints className="size-3" />
															Jump: {host.proxyJump}
														</span>
													) : null}
													{mountInfo?.mountPath ? (
														<span className="inline-flex items-center gap-1">
															<LuHardDrive className="size-3" />
															{mountInfo.mountPath}
														</span>
													) : null}
												</div>
												<p className="mt-1 truncate font-mono text-[10px] text-muted-foreground/80">
													{host.commandPreview}
												</p>
											</div>
											<div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
												<Button
													type="button"
													size="sm"
													variant="outline"
													className="h-7 px-2 text-xs"
													onClick={() => {
														onConnectHost(host.alias);
														onOpenChange(false);
													}}
												>
													<LuPlug className="mr-1 size-3.5" />
													Connect
												</Button>
												<Button
													type="button"
													size="sm"
													variant="outline"
													className="h-7 px-2 text-xs"
													disabled={!hasSshfs || isBusy}
													onClick={() => {
														void toggleMount(host, mountInfo).catch((error) => {
															console.error(
																"[ssh-hub] Failed to toggle mount",
																error,
															);
															toast.error(
																`Failed to ${mountInfo?.isMounted ? "unmount" : "mount"} ${host.alias}`,
															);
														});
													}}
												>
													{mountInfo?.isMounted ? "Unmount" : "Mount"}
												</Button>
												<Button
													type="button"
													size="sm"
													variant="outline"
													className="h-7 px-2 text-xs"
													disabled={!mountInfo?.mountPath}
													onClick={() => {
														if (!mountInfo?.mountPath) return;
														void openInFinderMutation
															.mutateAsync(mountInfo.mountPath)
															.catch((error) => {
																console.error(
																	"[ssh-hub] Failed to open mount path",
																	error,
																);
																toast.error("Failed to open mount folder");
															});
													}}
												>
													<LuFolderOpen className="mr-1 size-3.5" />
													Folder
												</Button>
												<Button
													type="button"
													size="sm"
													variant="outline"
													className="h-7 px-2 text-xs"
													disabled={isBusy}
													onClick={() => {
														void inspectHost(host.alias).catch((error) => {
															console.error(
																"[ssh-hub] Failed to inspect host",
																error,
															);
															toast.error(`Failed to inspect ${host.alias}`);
														});
													}}
												>
													<LuInfo className="mr-1 size-3.5" />
													Inspect
												</Button>
												<Button
													type="button"
													size="sm"
													variant="ghost"
													className="h-7 px-2 text-xs"
													onClick={() => {
														ensureDraft(host);
														setEditingAlias((previous) =>
															previous === host.alias ? null : host.alias,
														);
													}}
												>
													Auth
												</Button>
											</div>
										</div>

										{runtime ? (
											<div className="mt-2 rounded-md border border-border/70 bg-muted/10 p-2 text-[11px] text-muted-foreground">
												<div className="grid grid-cols-1 gap-1 md:grid-cols-2">
													<span>
														<span className="text-foreground/80">OS:</span>{" "}
														{runtime.os}
													</span>
													<span>
														<span className="text-foreground/80">
															Hostname:
														</span>{" "}
														{runtime.hostname}
													</span>
													<span>
														<span className="text-foreground/80">Uptime:</span>{" "}
														{runtime.uptime}
													</span>
													<span>
														<span className="text-foreground/80">Disk /:</span>{" "}
														{runtime.diskRoot}
													</span>
													<span>
														<span className="text-foreground/80">
															Remote user:
														</span>{" "}
														{runtime.remoteUser}
													</span>
													<span>
														<span className="text-foreground/80">Fetched:</span>{" "}
														{formatUpdatedAt(runtime.fetchedAt)}
													</span>
												</div>
												{mountInfo?.lastError ? (
													<p className="mt-1 text-[10px] text-destructive">
														Last mount error: {mountInfo.lastError}
													</p>
												) : null}
											</div>
										) : null}

										{isEditing ? (
											<div className="mt-3 rounded-md border border-border/70 bg-muted/15 p-3">
												<div className="grid grid-cols-1 gap-2 md:grid-cols-2">
													<div className="space-y-1">
														<span className="text-[11px] text-muted-foreground">
															Auth Mode
														</span>
														<select
															value={draft.authMode}
															onChange={(event) =>
																setDraftPatch(host.alias, {
																	authMode: event.target.value as AuthMode,
																})
															}
															className="h-8 w-full rounded-md border border-border/70 bg-background px-2 text-xs"
														>
															<option value="agent">Agent (default)</option>
															<option value="key">Private Key</option>
															<option value="password">Password</option>
														</select>
													</div>

													<div className="space-y-1">
														<span className="text-[11px] text-muted-foreground">
															User (optional override)
														</span>
														<Input
															value={draft.user}
															onChange={(event) =>
																setDraftPatch(host.alias, {
																	user: event.target.value,
																})
															}
															placeholder="root"
															className="h-8 text-xs"
														/>
													</div>

													<div className="space-y-1">
														<span className="text-[11px] text-muted-foreground">
															Port (optional override)
														</span>
														<Input
															value={draft.port}
															onChange={(event) =>
																setDraftPatch(host.alias, {
																	port: event.target.value,
																})
															}
															placeholder="22"
															className="h-8 text-xs"
															inputMode="numeric"
														/>
													</div>

													{draft.authMode === "key" ? (
														<div className="space-y-1">
															<span className="text-[11px] text-muted-foreground">
																Identity File
															</span>
															<Input
																value={draft.identityFile}
																onChange={(event) =>
																	setDraftPatch(host.alias, {
																		identityFile: event.target.value,
																	})
																}
																placeholder="~/.ssh/id_ed25519"
																className="h-8 text-xs"
															/>
														</div>
													) : null}

													{draft.authMode === "password" ? (
														<div className="space-y-1 md:col-span-2">
															<span className="text-[11px] text-muted-foreground">
																Password (
																{host.credential.hasPassword
																	? "leave blank to keep current"
																	: "required for auto-login"}
																)
															</span>
															<Input
																type="password"
																value={draft.password}
																onChange={(event) =>
																	setDraftPatch(host.alias, {
																		password: event.target.value,
																	})
																}
																placeholder="••••••••"
																className="h-8 text-xs"
															/>
														</div>
													) : null}
												</div>

												<div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
													<span>
														Saved locally on this machine (encrypted). Updated:{" "}
														{formatUpdatedAt(host.credential.updatedAt)}
													</span>
													{host.credential.hasPassword &&
													draft.authMode === "password" ? (
														<Button
															type="button"
															variant="ghost"
															size="sm"
															className="h-6 px-2 text-[10px]"
															onClick={() =>
																setDraftPatch(host.alias, {
																	clearPassword: !draft.clearPassword,
																})
															}
														>
															{draft.clearPassword
																? "Will clear password on save"
																: "Clear saved password"}
														</Button>
													) : null}
												</div>

												<div className="mt-2 flex items-center gap-2">
													<Button
														type="button"
														size="sm"
														className="h-7 text-xs"
														disabled={isBusy}
														onClick={() => {
															void saveCredential(host).catch((error) => {
																console.error(
																	"[ssh-hub] Failed to save credential",
																	error,
																);
																toast.error(
																	`Failed to save auth for ${host.alias}`,
																);
															});
														}}
													>
														Save Auth
													</Button>
													<Button
														type="button"
														size="sm"
														variant="outline"
														className="h-7 text-xs"
														disabled={isBusy}
														onClick={() => {
															void clearCredential(host.alias).catch(
																(error) => {
																	console.error(
																		"[ssh-hub] Failed to clear credential",
																		error,
																	);
																	toast.error(
																		`Failed to clear auth for ${host.alias}`,
																	);
																},
															);
														}}
													>
														Reset
													</Button>
												</div>
											</div>
										) : null}
									</div>
								);
							})}
						</div>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}
