interface AutoImportWorktreesOptions {
	projectIds: string[];
	importAllWorktrees: (input: {
		projectId: string;
	}) => Promise<{ imported: number }>;
	onError?: (input: { projectId: string; error: unknown }) => void;
}

export async function autoImportWorktreesForProjects({
	projectIds,
	importAllWorktrees,
	onError,
}: AutoImportWorktreesOptions): Promise<number> {
	const uniqueProjectIds = [
		...new Set(projectIds.map((id) => id.trim())),
	].filter((id) => id.length > 0);

	let totalImported = 0;

	for (const projectId of uniqueProjectIds) {
		try {
			const result = await importAllWorktrees({ projectId });
			totalImported += result.imported;
		} catch (error) {
			onError?.({ projectId, error });
		}
	}

	return totalImported;
}
