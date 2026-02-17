import Fuse from "fuse.js";
import { useCallback, useRef } from "react";

interface SearchableTask {
	id: string;
	title: string;
	slug: string;
	description: string | null;
	labels: string[] | null;
}

interface SearchResult<T extends SearchableTask> {
	item: T;
	score: number;
	matchType: "exact" | "fuzzy";
}

export function useHybridSearch<T extends SearchableTask>(tasks: T[]) {
	const tasksRef = useRef(tasks);
	tasksRef.current = tasks;

	const exactFuseRef = useRef<Fuse<T> | null>(null);
	const fuzzyFuseRef = useRef<Fuse<T> | null>(null);
	const indexedTasksRef = useRef<T[] | null>(null);

	const ensureIndex = useCallback(() => {
		if (indexedTasksRef.current === tasksRef.current) return;
		exactFuseRef.current = new Fuse(tasksRef.current, {
			keys: [
				{ name: "slug", weight: 2 },
				{ name: "labels", weight: 1 },
			],
			threshold: 0,
			includeScore: true,
			ignoreLocation: true,
			useExtendedSearch: false,
		});
		fuzzyFuseRef.current = new Fuse(tasksRef.current, {
			keys: [
				{ name: "title", weight: 2 },
				{ name: "description", weight: 1 },
			],
			threshold: 0.3,
			includeScore: true,
			ignoreLocation: true,
			useExtendedSearch: false,
		});
		indexedTasksRef.current = tasksRef.current;
	}, []);

	const search = useCallback(
		(query: string): SearchResult<T>[] => {
			if (!query.trim()) {
				return tasksRef.current.map((item) => ({
					item,
					score: 1,
					matchType: "exact" as const,
				}));
			}

			ensureIndex();

			const exactMatches = exactFuseRef.current?.search(query) ?? [];
			const exactIds = new Set(exactMatches.map((m) => m.item.id));

			const fuzzyMatches = (fuzzyFuseRef.current?.search(query) ?? []).filter(
				(m) => !exactIds.has(m.item.id),
			);

			return [
				...exactMatches.map((m) => ({
					item: m.item,
					score: 1 - (m.score ?? 0),
					matchType: "exact" as const,
				})),
				...fuzzyMatches.map((m) => ({
					item: m.item,
					score: 1 - (m.score ?? 0),
					matchType: "fuzzy" as const,
				})),
			];
		},
		[ensureIndex],
	);

	return { search };
}
