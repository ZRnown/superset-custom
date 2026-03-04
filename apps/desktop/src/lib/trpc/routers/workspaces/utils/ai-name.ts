import {
	getCredentialsFromConfig,
	getCredentialsFromKeychain,
} from "@superset/chat/host";

export async function generateWorkspaceNameFromPrompt(
	prompt: string,
): Promise<string | null> {
	try {
		const credentials =
			getCredentialsFromConfig() ?? getCredentialsFromKeychain();
		if (!credentials) return null;

		const anthropicModuleName = "@ai-sdk/anthropic";
		const mastraAgentModuleName = "@mastra/core/agent";
		const anthropicLib = (await import(anthropicModuleName)) as {
			createAnthropic?: (input: { apiKey: string }) => (model: string) => unknown;
		};
		const mastraAgentLib = (await import(mastraAgentModuleName)) as {
			Agent?: new (input: {
				id: string;
				name: string;
				instructions: string;
				model: unknown;
			}) => {
				generateTitleFromUserMessage: (input: {
					message: string;
					tracingContext: Record<string, never>;
				}) => Promise<string | null | undefined>;
			};
		};

		const createAnthropic = anthropicLib.createAnthropic;
		const Agent = mastraAgentLib.Agent;
		if (!createAnthropic || !Agent) {
			return null;
		}

		const anthropic = createAnthropic({ apiKey: credentials.apiKey });

		const agent = new Agent({
			id: "workspace-namer",
			name: "Workspace Namer",
			instructions: "You generate concise workspace titles.",
			model: anthropic("claude-haiku-4-5-20251001"),
		});

		const title = await agent.generateTitleFromUserMessage({
			message: prompt,
			tracingContext: {},
		});

		return title?.trim() || null;
	} catch {
		return null;
	}
}
