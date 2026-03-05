/**
 * UI state schemas (persisted from renderer zustand stores)
 */
import { createDefaultHotkeysState, type HotkeysState } from "shared/hotkeys";
import type { BaseTabsState } from "shared/tabs-types";
import type { Theme } from "shared/themes";

// Re-export for convenience
export type { BaseTabsState as TabsState, Pane } from "shared/tabs-types";

export interface ThemeState {
	activeThemeId: string;
	customThemes: Theme[];
}

export type SshAuthMode = "agent" | "key" | "password";

export interface SshCredentialEntry {
	authMode: SshAuthMode;
	user: string | null;
	port: number | null;
	identityFile: string | null;
	passwordCiphertext: string | null;
	updatedAt: number;
}

export interface SshMountStateEntry {
	mountPath: string;
	lastMountedAt: number | null;
	lastUnmountedAt: number | null;
	lastError: string | null;
}

export interface SshState {
	credentialsByAlias: Record<string, SshCredentialEntry>;
	mountsByAlias: Record<string, SshMountStateEntry>;
}

export interface AppState {
	tabsState: BaseTabsState;
	themeState: ThemeState;
	hotkeysState: HotkeysState;
	sshState: SshState;
}

export const defaultAppState: AppState = {
	tabsState: {
		tabs: [],
		panes: {},
		activeTabIds: {},
		focusedPaneIds: {},
		tabHistoryStacks: {},
	},
	themeState: {
		activeThemeId: "dark",
		customThemes: [],
	},
	hotkeysState: createDefaultHotkeysState(),
	sshState: {
		credentialsByAlias: {},
		mountsByAlias: {},
	},
};
