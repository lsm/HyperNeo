/**
 * Global Spotlight-style palette.
 *
 * Cmd+K opens command mode. Cmd+P opens quick-open mode for chats, messages,
 * tasks, and spaces. Both modes intentionally share one shell so search feels
 * global instead of page-local.
 */

import type { Session, SpaceTask } from '@neokai/shared';
import { Dialog, DialogBackdrop, DialogPanel } from '@neokai/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { connectionManager } from '../lib/connection-manager.ts';
import {
	commandRegistry,
	categoryLabel,
	formatShortcutDisplay,
	fuzzyScore,
	type CommandCategory,
	type CommandDescriptor,
	type RankedCommand,
} from '../lib/command-registry.ts';
import { navigateToSession, navigateToSpace, navigateToSpaceTask } from '../lib/router.ts';
import { searchHighlightMessageIdSignal } from '../lib/signals.ts';
import {
	commandPaletteModeSignal,
	commandPaletteOpenSignal,
	currentSessionIdSignal,
	type CommandPaletteMode,
} from '../lib/signals.ts';
import { spaceStore, type SpaceWithTasks } from '../lib/space-store.ts';
import { sessions } from '../lib/state.ts';
import { toast } from '../lib/toast.ts';
import { cn } from '../lib/utils.ts';

export interface MessageSearchResult {
	kind: 'message' | 'task';
	sourceId: string;
	messageId?: string;
	sessionId?: string;
	taskId?: string;
	spaceId?: string;
	taskNumber?: number;
	messageType?: string;
	title: string;
	snippet: string;
	timestamp: number;
	loadTarget?: MessageSearchLoadTarget;
	rank: number;
}

interface MessageSearchLoadTarget {
	sessionId: string;
	before?: number;
}

interface MessageSearchResponse {
	results: MessageSearchResult[];
	limit: number;
	offset: number;
}

type PaletteItem =
	| {
			type: 'command';
			id: string;
			group: CommandCategory;
			title: string;
			subtitle?: string;
			shortcut?: string;
			command: CommandDescriptor;
	  }
	| {
			type: 'session';
			id: string;
			group: 'recent' | 'chats';
			title: string;
			subtitle: string;
			session: Session;
	  }
	| {
			type: 'space';
			id: string;
			group: 'recent' | 'spaces';
			title: string;
			subtitle: string;
			spaceId: string;
	  }
	| {
			type: 'space-task';
			id: string;
			group: 'recent' | 'tasks';
			title: string;
			subtitle: string;
			spaceId: string;
			taskId: string;
	  }
	| {
			type: 'message';
			id: string;
			group: 'messages' | 'tasks';
			title: string;
			subtitle: string;
			snippet: string;
			result: MessageSearchResult;
	  };

function groupLabel(group: PaletteItem['group']): string {
	if (group === 'recent') return 'Recent';
	if (group === 'chats') return 'Chats';
	if (group === 'messages') return 'Messages';
	if (group === 'spaces') return 'Spaces';
	if (group === 'tasks') return 'Tasks';
	return categoryLabel(group);
}

function iconFor(type: PaletteItem['type']) {
	if (type === 'command') {
		return (
			<svg class="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor">
				<path d="M7 5h6M7 10h6M7 15h6" stroke-width="1.6" stroke-linecap="round" />
			</svg>
		);
	}
	if (type === 'session' || type === 'message') {
		return (
			<svg class="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor">
				<path
					d="M4.5 5.5A3 3 0 0 1 7.5 2.5h5A3 3 0 0 1 15.5 5.5v4A3 3 0 0 1 12.5 12.5H9l-4 3v-3.4A3 3 0 0 1 4.5 9.5z"
					stroke-width="1.5"
					stroke-linejoin="round"
				/>
			</svg>
		);
	}
	if (type === 'space') {
		return (
			<svg class="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor">
				<path
					d="M5 6.5 10 4l5 2.5-5 2.5zM5 10l5 2.5 5-2.5M5 13.5l5 2.5 5-2.5"
					stroke-width="1.5"
					stroke-linejoin="round"
					stroke-linecap="round"
				/>
			</svg>
		);
	}
	return (
		<svg class="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor">
			<path
				d="M6.5 3.5h7l1 2v11h-9v-11zM7 8h6M7 11h6"
				stroke-width="1.5"
				stroke-linecap="round"
				stroke-linejoin="round"
			/>
		</svg>
	);
}

function commandItems(results: readonly RankedCommand[]): PaletteItem[] {
	return results.map(({ command }) => ({
		type: 'command' as const,
		id: `command:${command.id}`,
		group: command.category,
		title: command.label,
		subtitle: command.description,
		shortcut: command.shortcut ? formatShortcutDisplay(command.shortcut) : undefined,
		command,
	}));
}

function workspaceLabel(path: string | null): string {
	if (!path) return 'No folder';
	return path.split('/').filter(Boolean).at(-1) ?? path;
}

function sessionItems(allSessions: Session[], query: string, limit: number): PaletteItem[] {
	const trimmed = query.trim();
	const ranked = allSessions
		.filter((session) => session.status !== 'archived')
		.map((session) => {
			const score = trimmed
				? Math.max(
						fuzzyScore(session.title, trimmed),
						fuzzyScore(session.workspacePath ?? '', trimmed),
						fuzzyScore(session.gitBranch ?? '', trimmed)
					)
				: 1;
			return { session, score };
		})
		.filter(({ score }) => score > 0)
		.sort((a, b) => {
			if (trimmed && b.score !== a.score) return b.score - a.score;
			return (
				new Date(b.session.lastActiveAt).getTime() - new Date(a.session.lastActiveAt).getTime()
			);
		})
		.slice(0, limit);

	return ranked.map(({ session }) => ({
		type: 'session' as const,
		id: `session:${session.id}`,
		group: trimmed ? 'chats' : 'recent',
		title: session.title || 'Untitled chat',
		subtitle: workspaceLabel(session.workspacePath),
		session,
	}));
}

function spaceItems(spaces: SpaceWithTasks[], query: string, limit: number): PaletteItem[] {
	const trimmed = query.trim();
	const ranked = spaces
		.map((space) => {
			const score = trimmed
				? Math.max(
						fuzzyScore(space.name, trimmed),
						fuzzyScore(space.description, trimmed),
						fuzzyScore(space.workspacePath, trimmed)
					)
				: 1;
			return { space, score };
		})
		.filter(({ space, score }) => space.status !== 'archived' && score > 0)
		.sort((a, b) => {
			if (trimmed && b.score !== a.score) return b.score - a.score;
			return b.space.updatedAt - a.space.updatedAt;
		})
		.slice(0, limit);

	return ranked.map(({ space }) => ({
		type: 'space' as const,
		id: `space:${space.id}`,
		group: trimmed ? 'spaces' : 'recent',
		title: space.name,
		subtitle: workspaceLabel(space.workspacePath),
		spaceId: space.id,
	}));
}

function taskItemsFromSpaces(
	spaces: SpaceWithTasks[],
	query: string,
	limit: number
): PaletteItem[] {
	const trimmed = query.trim();
	const ranked: Array<{ task: SpaceTask; spaceName: string; score: number }> = [];
	for (const space of spaces) {
		for (const task of space.tasks) {
			const score = trimmed
				? Math.max(fuzzyScore(task.title, trimmed), fuzzyScore(task.description, trimmed))
				: 1;
			if (score <= 0) continue;
			ranked.push({ task, spaceName: space.name, score });
		}
	}
	ranked.sort((a, b) => {
		if (trimmed && b.score !== a.score) return b.score - a.score;
		return b.task.updatedAt - a.task.updatedAt;
	});
	return ranked.slice(0, limit).map(({ task, spaceName }) => ({
		type: 'space-task' as const,
		id: `space-task:${task.id}`,
		group: trimmed ? 'tasks' : 'recent',
		title: task.title,
		subtitle: `${spaceName} · Task #${task.taskNumber}`,
		spaceId: task.spaceId,
		taskId: task.id,
	}));
}

function messageItems(results: readonly MessageSearchResult[]): PaletteItem[] {
	return results.slice(0, 14).map((result) => ({
		type: 'message' as const,
		id: `${result.kind}:${result.sourceId}`,
		group: result.kind === 'task' ? 'tasks' : 'messages',
		title: result.title,
		subtitle:
			result.kind === 'task'
				? `Task #${result.taskNumber ?? ''}`
				: `${result.messageType ?? 'message'} result`,
		snippet: stripSnippetMarks(result.snippet),
		result,
	}));
}

function stripSnippetMarks(snippet: string): string {
	return snippet.replaceAll('<mark>', '').replaceAll('</mark>', '');
}

function shouldSearchMessages(query: string, mode: CommandPaletteMode): boolean {
	const trimmed = query.trim();
	return mode === 'quick-open' && trimmed.length >= 3 && !trimmed.startsWith('>');
}

export function CommandPalette() {
	const open = commandPaletteOpenSignal.value;
	const mode = commandPaletteModeSignal.value;
	const [query, setQuery] = useState('');
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [messageResults, setMessageResults] = useState<MessageSearchResult[]>([]);
	const [loadingMessages, setLoadingMessages] = useState(false);
	const [registryVersion, setRegistryVersion] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const requestIdRef = useRef(0);

	useEffect(() => {
		if (!open) return;
		setQuery('');
		setSelectedIndex(0);
		setMessageResults([]);
		setRegistryVersion((v) => v + 1);
		spaceStore.initGlobalList().catch(() => {});
		setTimeout(() => inputRef.current?.focus(), 0);
	}, [open, mode]);

	useEffect(() => {
		if (!open) return;
		setSelectedIndex(0);
	}, [query, mode, open]);

	useEffect(() => {
		if (!open || !shouldSearchMessages(query, mode)) {
			requestIdRef.current += 1;
			setMessageResults([]);
			setLoadingMessages(false);
			return;
		}

		const requestId = ++requestIdRef.current;
		const timeout = setTimeout(async () => {
			const hub = connectionManager.getHubIfConnected();
			if (!hub) {
				if (requestId === requestIdRef.current) {
					setLoadingMessages(false);
					setMessageResults([]);
				}
				return;
			}
			try {
				setLoadingMessages(true);
				const response = await hub.request<MessageSearchResponse>('message.search', {
					query: query.trim(),
					limit: 16,
				});
				if (requestId === requestIdRef.current) {
					setMessageResults(response.results);
				}
			} catch {
				if (requestId === requestIdRef.current) {
					setMessageResults([]);
				}
			} finally {
				if (requestId === requestIdRef.current) {
					setLoadingMessages(false);
				}
			}
		}, 300);

		return () => clearTimeout(timeout);
	}, [open, query, mode]);

	const allSessions = sessions.value;
	const spacesWithTasks = spaceStore.spacesWithTasks.value;

	const items = useMemo(() => {
		const forcedCommand = query.trimStart().startsWith('>');
		const commandQuery = forcedCommand ? query.trimStart().slice(1).trimStart() : query;
		const commands = commandItems(commandRegistry.search(commandQuery));
		const quickItems = [
			...sessionItems(allSessions, query, query.trim() ? 8 : 5),
			...spaceItems(spacesWithTasks, query, query.trim() ? 5 : 3),
			...taskItemsFromSpaces(spacesWithTasks, query, query.trim() ? 5 : 3),
			...messageItems(messageResults),
		];

		if (forcedCommand) return commands;
		if (mode === 'commands') {
			return query.trim() ? [...commands.slice(0, 8), ...quickItems.slice(0, 8)] : commands;
		}
		return query.trim() ? [...quickItems, ...commands.slice(0, 5)] : quickItems;
	}, [query, mode, messageResults, allSessions, spacesWithTasks, registryVersion]);

	const groupedItems = useMemo(() => {
		const groups: Array<{ key: PaletteItem['group']; items: PaletteItem[] }> = [];
		for (const item of items) {
			const last = groups.at(-1);
			if (last?.key === item.group) {
				last.items.push(item);
			} else {
				groups.push({ key: item.group, items: [item] });
			}
		}
		return groups;
	}, [items]);

	useEffect(() => {
		setSelectedIndex((index) => Math.min(index, Math.max(items.length - 1, 0)));
	}, [items.length]);

	const close = useCallback(() => {
		commandPaletteOpenSignal.value = false;
		setQuery('');
		setMessageResults([]);
	}, []);

	const runCommand = useCallback(
		(command: CommandDescriptor) => {
			close();
			void (async () => {
				try {
					await command.run();
				} catch (err) {
					toast.error(err instanceof Error ? err.message : `Command "${command.label}" failed`);
				}
			})();
		},
		[close]
	);

	const selectItem = useCallback(
		(item: PaletteItem | undefined) => {
			if (!item) return;
			if (item.type === 'command') {
				runCommand(item.command);
				return;
			}
			close();
			if (item.type === 'session') {
				navigateToSession(item.session.id);
				return;
			}
			if (item.type === 'space') {
				navigateToSpace(item.spaceId);
				return;
			}
			if (item.type === 'space-task') {
				navigateToSpaceTask(item.spaceId, item.taskId, 'thread');
				return;
			}
			const result = item.result;
			if (result.kind === 'task' && result.spaceId && result.taskId) {
				navigateToSpaceTask(result.spaceId, result.taskId, 'thread');
				return;
			}
			if (!result.sessionId || !result.messageId) return;
			searchHighlightMessageIdSignal.value = {
				sessionId: result.sessionId,
				messageId: result.messageId,
				loadTarget: result.loadTarget,
			};
			if (result.sessionId !== currentSessionIdSignal.value) {
				navigateToSession(result.sessionId);
			}
		},
		[close, runCommand]
	);

	function handleKeyDown(event: KeyboardEvent) {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			setSelectedIndex((index) => Math.min(index + 1, Math.max(items.length - 1, 0)));
			return;
		}
		if (event.key === 'ArrowUp') {
			event.preventDefault();
			setSelectedIndex((index) => Math.max(index - 1, 0));
			return;
		}
		if (event.key === 'Enter') {
			event.preventDefault();
			selectItem(items[Math.min(selectedIndex, Math.max(items.length - 1, 0))]);
		}
	}

	const placeholder =
		mode === 'commands' ? 'Search commands, chats, messages…' : 'Search chats, messages, tasks…';
	const title = mode === 'commands' ? 'Commands' : 'Quick Open';

	return (
		<Dialog open={open} onClose={close} class="relative z-50">
			<DialogBackdrop class="fixed inset-0 bg-black/35 backdrop-blur-xl transition-opacity data-[closed]:opacity-0 data-[enter]:duration-200 data-[enter]:ease-out data-[leave]:duration-150 data-[leave]:ease-in" />

			<div class="fixed inset-0 z-10 overflow-y-auto px-3 pt-[12vh] sm:px-6">
				<DialogPanel class="mx-auto w-full max-w-2xl transform overflow-hidden rounded-[28px] border border-white/10 bg-[#252527]/80 shadow-[0_28px_90px_rgba(0,0,0,0.55)] ring-1 ring-white/5 backdrop-blur-2xl transition-all data-[closed]:scale-[0.98] data-[closed]:opacity-0 data-[enter]:duration-200 data-[enter]:ease-out data-[leave]:duration-150 data-[leave]:ease-in">
					<div class="border-b border-white/10 px-4 pt-3">
						<div class="mb-2 flex items-center justify-between">
							<div class="text-xs font-medium text-gray-400">{title}</div>
							<div class="flex rounded-full bg-black/25 p-0.5 text-xs text-gray-400">
								<PaletteModeButton mode="quick-open" activeMode={mode}>
									Open
								</PaletteModeButton>
								<PaletteModeButton mode="commands" activeMode={mode}>
									Commands
								</PaletteModeButton>
							</div>
						</div>
						<div class="grid grid-cols-1">
							<input
								ref={inputRef}
								type="text"
								value={query}
								onInput={(event) => setQuery((event.target as HTMLInputElement).value)}
								onKeyDown={handleKeyDown}
								placeholder={placeholder}
								class="col-start-1 row-start-1 h-12 w-full bg-transparent pl-10 pr-4 text-[17px] text-gray-100 outline-none placeholder:text-gray-500"
								data-testid="command-palette-input"
							/>
							<span
								class="pointer-events-none col-start-1 row-start-1 ml-1 self-center text-gray-500"
								aria-hidden="true"
							>
								<svg class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
									<path
										fill-rule="evenodd"
										d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z"
										clip-rule="evenodd"
									/>
								</svg>
							</span>
						</div>
					</div>

					<div class="max-h-[58vh] overflow-y-auto p-2">
						{items.length === 0 ? (
							<div class="px-6 py-14 text-center" data-testid="command-palette-empty">
								<p class="text-sm text-gray-400">
									{loadingMessages ? 'Searching…' : `No results match "${query}"`}
								</p>
							</div>
						) : (
							<PaletteResults
								groups={groupedItems}
								selectedIndex={selectedIndex}
								onHover={setSelectedIndex}
								onSelect={selectItem}
							/>
						)}
					</div>

					<div class="flex items-center justify-between border-t border-white/10 px-4 py-3 text-xs text-gray-500">
						<div class="flex items-center gap-4">
							<span>↑↓ Navigate</span>
							<span>↵ Open</span>
							<span>Esc Close</span>
						</div>
						<span class="hidden sm:inline">Use &gt; for commands</span>
					</div>
				</DialogPanel>
			</div>
		</Dialog>
	);
}

function PaletteModeButton({
	mode,
	activeMode,
	children,
}: {
	mode: CommandPaletteMode;
	activeMode: CommandPaletteMode;
	children: preact.ComponentChildren;
}) {
	return (
		<button
			type="button"
			onClick={() => {
				commandPaletteModeSignal.value = mode;
			}}
			class={cn(
				'rounded-full px-2.5 py-1 transition-colors',
				activeMode === mode ? 'bg-white/10 text-gray-100 shadow-sm' : 'hover:bg-white/10'
			)}
		>
			{children}
		</button>
	);
}

function PaletteResults({
	groups,
	selectedIndex,
	onHover,
	onSelect,
}: {
	groups: Array<{ key: PaletteItem['group']; items: PaletteItem[] }>;
	selectedIndex: number;
	onHover: (index: number) => void;
	onSelect: (item: PaletteItem) => void;
}) {
	let index = 0;
	return (
		<ul>
			{groups.map((group, groupIndex) => (
				<li key={`${group.key}:${groupIndex}`} class="py-1">
					<div class="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-500">
						{groupLabel(group.key)}
					</div>
					<ul>
						{group.items.map((item) => {
							const itemIndex = index++;
							return (
								<PaletteRow
									key={item.id}
									item={item}
									active={itemIndex === selectedIndex}
									onHover={() => onHover(itemIndex)}
									onSelect={() => onSelect(item)}
								/>
							);
						})}
					</ul>
				</li>
			))}
		</ul>
	);
}

function PaletteRow({
	item,
	active,
	onHover,
	onSelect,
}: {
	item: PaletteItem;
	active: boolean;
	onHover: () => void;
	onSelect: () => void;
}) {
	return (
		<li>
			<button
				type="button"
				onMouseEnter={onHover}
				onClick={onSelect}
				class={cn(
					'group flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors',
					active ? 'bg-white/10 text-white' : 'text-gray-300 hover:bg-white/[0.07]'
				)}
			>
				<span
					class={cn(
						'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl border',
						active
							? 'border-white/20 bg-white/10 text-gray-100'
							: 'border-white/10 bg-white/5 text-gray-400'
					)}
				>
					{iconFor(item.type)}
				</span>
				<span class="min-w-0 flex-1">
					<span class="block truncate text-sm font-medium">{item.title}</span>
					<span class="block truncate text-xs text-gray-500 group-hover:text-gray-400">
						{item.type === 'message' ? item.snippet : item.subtitle}
					</span>
				</span>
				{item.type === 'command' && item.shortcut && (
					<kbd class="ml-3 flex-none rounded-md border border-white/10 bg-black/20 px-1.5 py-0.5 font-mono text-[11px] text-gray-500">
						{item.shortcut}
					</kbd>
				)}
			</button>
		</li>
	);
}
