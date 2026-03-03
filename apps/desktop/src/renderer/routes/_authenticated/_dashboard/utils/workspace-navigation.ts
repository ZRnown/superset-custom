import type {
	NavigateOptions,
	UseNavigateResult,
} from "@tanstack/react-router";

export interface WorkspaceSearchParams {
	tabId?: string;
	paneId?: string;
}

/**
 * Navigate to a workspace and update localStorage to remember it as the last viewed workspace.
 * This ensures the workspace will be restored when the app is reopened.
 *
 * @param workspaceId - The ID of the workspace to navigate to
 * @param navigate - The navigate function from useNavigate()
 * @param options - Optional navigation options (replace, resetScroll, etc.)
 */
export function navigateToWorkspace(
	workspaceId: string,
	navigate: UseNavigateResult<string>,
	options?: Omit<NavigateOptions, "to" | "params"> & {
		search?: WorkspaceSearchParams;
	},
): Promise<void> {
	const { search, ...rest } = options ?? {};
	if (localStorage.getItem("lastViewedWorkspaceId") !== workspaceId) {
		localStorage.setItem("lastViewedWorkspaceId", workspaceId);
	}

	// Avoid a no-op route transition when already on this workspace.
	// This removes unnecessary remount/recompute during repeated project switching.
	if (typeof window !== "undefined") {
		const hasSearch = !!search && Object.keys(search).length > 0;
		const workspacePath = `/workspace/${workspaceId}`;
		const rawCurrentPath = window.location.hash.startsWith("#")
			? window.location.hash.slice(1)
			: window.location.pathname;
		const currentPath = rawCurrentPath.split("?")[0];
		const onWorkspaceRoute =
			currentPath === workspacePath || currentPath.startsWith(`${workspacePath}/`);
		if (!hasSearch && onWorkspaceRoute) {
			return Promise.resolve();
		}
	}

	return navigate({
		to: "/workspace/$workspaceId",
		params: { workspaceId },
		search: search ?? {},
		...rest,
	});
}
