import {
	STARTABLE_AGENT_LABELS,
	type StartableAgentType,
} from "@superset/shared/agent-launch";
import { Button } from "@superset/ui/button";
import { Input } from "@superset/ui/input";
import { Kbd, KbdGroup } from "@superset/ui/kbd";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@superset/ui/select";
import { Textarea } from "@superset/ui/textarea";
import type { ReactNode, RefObject } from "react";
import { useMemo, useState } from "react";
import { GoGitBranch } from "react-icons/go";
import {
	getPresetIcon,
	useIsDarkTheme,
} from "renderer/assets/app-icons/preset-icons";
import { useHotkeysStore } from "renderer/stores/hotkeys";

export type WorkspaceCreateAgent = StartableAgentType | "none";
export type CodexLaunchMode = "new" | "resume-picker" | "resume-last";
export type WorkspaceCreateMode = "agent" | "worktree";
export interface CodexSessionOption {
	id: string;
	timestampLabel: string;
	relativePath: string;
	cwd: string;
	firstUserMessage: string | null;
	lastUserMessage: string | null;
	firstAssistantMessage: string | null;
	lastAssistantMessage: string | null;
}

interface NewWorkspaceCreateFlowProps {
	projectSelector: ReactNode;
	workspaceCreateMode: WorkspaceCreateMode;
	onWorkspaceCreateModeChange: (mode: WorkspaceCreateMode) => void;
	selectedAgent: WorkspaceCreateAgent;
	agentOptions: readonly StartableAgentType[];
	onSelectedAgentChange: (agent: WorkspaceCreateAgent) => void;
	showCodexLaunchMode: boolean;
	codexLaunchMode: CodexLaunchMode;
	onCodexLaunchModeChange: (mode: CodexLaunchMode) => void;
	showCodexSessionPicker: boolean;
	codexSessions: CodexSessionOption[];
	selectedCodexSessionId: string;
	onSelectedCodexSessionIdChange: (sessionId: string) => void;
	isCodexSessionsLoading: boolean;
	title: string;
	onTitleChange: (value: string) => void;
	titleInputRef: RefObject<HTMLTextAreaElement | null>;
	showPromptInput: boolean;
	showBranchPreview: boolean;
	branchPreview: string;
	effectiveBaseBranch: string | null;
	createButtonLabel?: string;
	onCreateWorkspace: () => void;
	isCreateDisabled: boolean;
	advancedOptions: ReactNode;
}

export function NewWorkspaceCreateFlow({
	projectSelector,
	workspaceCreateMode,
	onWorkspaceCreateModeChange,
	selectedAgent,
	agentOptions,
	onSelectedAgentChange,
	showCodexLaunchMode,
	codexLaunchMode,
	onCodexLaunchModeChange,
	showCodexSessionPicker,
	codexSessions,
	selectedCodexSessionId,
	onSelectedCodexSessionIdChange,
	isCodexSessionsLoading,
	title,
	onTitleChange,
	titleInputRef,
	showPromptInput,
	showBranchPreview,
	branchPreview,
	effectiveBaseBranch,
	createButtonLabel = "Create Workspace",
	onCreateWorkspace,
	isCreateDisabled,
	advancedOptions,
}: NewWorkspaceCreateFlowProps) {
	const isDark = useIsDarkTheme();
	const platform = useHotkeysStore((state) => state.platform);
	const modKey = platform === "darwin" || platform === undefined ? "⌘" : "Ctrl";
	const [sessionSearch, setSessionSearch] = useState("");
	const filteredSessions = useMemo(() => {
		const query = sessionSearch.trim().toLowerCase();
		if (!query) {
			return codexSessions;
		}

		return codexSessions.filter((session) => {
			return (
				session.id.toLowerCase().includes(query) ||
				session.timestampLabel.toLowerCase().includes(query) ||
				session.relativePath.toLowerCase().includes(query) ||
				session.cwd.toLowerCase().includes(query) ||
				(session.firstUserMessage?.toLowerCase() ?? "").includes(query) ||
				(session.lastUserMessage?.toLowerCase() ?? "").includes(query) ||
				(session.firstAssistantMessage?.toLowerCase() ?? "").includes(query) ||
				(session.lastAssistantMessage?.toLowerCase() ?? "").includes(query)
			);
		});
	}, [codexSessions, sessionSearch]);

	return (
		<div className="space-y-3 min-w-0">
			<div className="flex items-end gap-3 min-w-0">
				<div className="flex-1 min-w-0">{projectSelector}</div>
				<div className="shrink-0 max-w-[45%]">
					<Select
						value={selectedAgent}
						onValueChange={(value: WorkspaceCreateAgent) =>
							onSelectedAgentChange(value)
						}
					>
						<SelectTrigger className="h-8 text-xs w-auto max-w-full">
							<SelectValue placeholder="No agent" className="truncate" />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="none">No agent</SelectItem>
							{agentOptions.map((agent) => {
								const icon = getPresetIcon(agent, isDark);
								return (
									<SelectItem key={agent} value={agent}>
										<span className="flex items-center gap-2">
											{icon && (
												<img
													src={icon}
													alt=""
													className="size-3.5 object-contain"
												/>
											)}
											{STARTABLE_AGENT_LABELS[agent]}
										</span>
									</SelectItem>
								);
							})}
						</SelectContent>
					</Select>
				</div>
			</div>

			<div className="grid grid-cols-2 gap-2">
				<Button
					type="button"
					variant={workspaceCreateMode === "agent" ? "default" : "outline"}
					className="h-8 text-xs justify-start"
					onClick={() => onWorkspaceCreateModeChange("agent")}
				>
					+ New agent
				</Button>
				<Button
					type="button"
					variant={workspaceCreateMode === "worktree" ? "default" : "outline"}
					className="h-8 text-xs justify-start"
					onClick={() => onWorkspaceCreateModeChange("worktree")}
				>
					New worktree agent
				</Button>
			</div>

			{showPromptInput && (
				<Textarea
					ref={titleInputRef}
					id="title"
					className="min-h-20 min-w-0 w-full max-w-full field-sizing-fixed text-sm resize-y"
					placeholder="What do you want to do?"
					value={title}
					onChange={(e) => onTitleChange(e.target.value)}
				/>
			)}

			{showCodexLaunchMode && (
				<div className="space-y-1">
					<p className="text-[11px] text-muted-foreground">Codex Session</p>
					<Select
						value={codexLaunchMode}
						onValueChange={(value: CodexLaunchMode) =>
							onCodexLaunchModeChange(value)
						}
					>
						<SelectTrigger className="h-8 text-xs">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="new">Start new session</SelectItem>
							<SelectItem value="resume-picker">
								Resume from project history
							</SelectItem>
							<SelectItem value="resume-last">Resume last session</SelectItem>
						</SelectContent>
					</Select>
				</div>
			)}

			{showCodexSessionPicker && (
				<div className="space-y-1">
					<p className="text-[11px] text-muted-foreground">
						Project History Session
					</p>
					{isCodexSessionsLoading ? (
						<div className="h-8 px-3 rounded-md border bg-background text-xs text-muted-foreground flex items-center">
							Loading Codex sessions...
						</div>
					) : codexSessions.length === 0 ? (
						<div className="px-0.5 text-xs text-muted-foreground">
							No Codex sessions found for this project
						</div>
					) : (
						<div className="space-y-2">
							<Input
								value={sessionSearch}
								onChange={(event) => setSessionSearch(event.target.value)}
								placeholder="Search by path, time, or session id"
								className="h-8 text-xs"
							/>
							<div className="max-h-56 overflow-y-auto rounded-md border bg-background divide-y">
								{filteredSessions.length === 0 ? (
									<div className="px-3 py-3 text-xs text-muted-foreground">
										No matching sessions
									</div>
								) : (
									filteredSessions.map((session) => {
										const isSelected = session.id === selectedCodexSessionId;
										return (
											<button
												key={session.id}
												type="button"
												onClick={() =>
													onSelectedCodexSessionIdChange(session.id)
												}
												className={`w-full px-3 py-2 text-left transition-colors ${
													isSelected ? "bg-muted/70" : "hover:bg-muted/40"
												}`}
											>
												<div className="flex items-center gap-2 min-w-0">
													<span className="text-xs font-medium truncate">
														{session.timestampLabel}
													</span>
													<span className="text-[10px] text-muted-foreground font-mono truncate">
														{session.id.slice(0, 8)}
													</span>
												</div>
												<div className="mt-0.5 text-[11px] font-mono break-all">
													{session.relativePath}
												</div>
												{(session.firstUserMessage ||
													session.lastUserMessage) && (
													<div className="mt-1 space-y-0.5 text-[11px] text-muted-foreground">
														<div className="font-medium text-foreground/80">
															User
														</div>
														{session.firstUserMessage && (
															<div>
																<span className="font-medium">First:</span>{" "}
																{session.firstUserMessage}
															</div>
														)}
														{session.lastUserMessage &&
															session.lastUserMessage !==
																session.firstUserMessage && (
																<div>
																	<span className="font-medium">Last:</span>{" "}
																	{session.lastUserMessage}
																</div>
															)}
													</div>
												)}
												{(session.firstAssistantMessage ||
													session.lastAssistantMessage) && (
													<div className="mt-1 space-y-0.5 text-[11px] text-muted-foreground">
														<div className="font-medium text-foreground/80">
															Assistant
														</div>
														{session.firstAssistantMessage && (
															<div>
																<span className="font-medium">First:</span>{" "}
																{session.firstAssistantMessage}
															</div>
														)}
														{session.lastAssistantMessage &&
															session.lastAssistantMessage !==
																session.firstAssistantMessage && (
																<div>
																	<span className="font-medium">Last:</span>{" "}
																	{session.lastAssistantMessage}
																</div>
															)}
													</div>
												)}
											</button>
										);
									})
								)}
							</div>
						</div>
					)}
				</div>
			)}

			{showBranchPreview && (
				<p className="text-xs text-muted-foreground grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1.5 min-w-0">
					<GoGitBranch className="size-3" />
					<span className="font-mono min-w-0 truncate">
						{branchPreview || "branch-name"}
					</span>
					<span className="text-muted-foreground/60 whitespace-nowrap">
						from {effectiveBaseBranch ?? "..."}
					</span>
				</p>
			)}

			<Button
				className="w-full h-8 text-sm"
				onClick={onCreateWorkspace}
				disabled={isCreateDisabled}
			>
				{createButtonLabel}
				<KbdGroup className="ml-1.5 opacity-70">
					<Kbd className="bg-primary-foreground/15 text-primary-foreground h-4 min-w-4 text-[10px]">
						{modKey}
					</Kbd>
					<Kbd className="bg-primary-foreground/15 text-primary-foreground h-4 min-w-4 text-[10px]">
						↵
					</Kbd>
				</KbdGroup>
			</Button>

			{advancedOptions}
		</div>
	);
}
