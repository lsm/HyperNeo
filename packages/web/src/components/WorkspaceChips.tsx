import { useState } from 'preact/hooks';
import type { GitBranchesResponse } from '@hyperneo/shared';
import { Dropdown, type DropdownMenuItem } from './ui/Dropdown.tsx';
import { GitBranchIcon } from './icons/GitBranchIcon.tsx';
import { projectName } from '../lib/projects.ts';

const MAX_BRANCH_RESULTS = 100;

interface WorkspaceChipsProps {
  projects: string[];
  selectedProject: string | null;
  gitInfo: GitBranchesResponse | null;
  gitLoading: boolean;
  mode: 'worktree' | 'direct';
  baseBranch: string | null;
  onSelectProject: (path: string | null) => void;
  onBrowse: () => void;
  onEnterPath: () => void;
  nativeFolderPickerAvailable: boolean;
  onSelectMode: (mode: 'worktree' | 'direct') => void;
  onSelectBranch: (branch: string) => void;
}

const CHIP_CLASS =
  'flex items-center gap-1.5 px-2 py-1 rounded-md text-xs text-gray-400 hover:text-gray-200 hover:bg-white/5 transition-colors';

function Chevron() {
  return (
    <svg
      class="w-3 h-3 flex-shrink-0 text-gray-600"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg class="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width={1.75}
        d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z"
      />
    </svg>
  );
}

function orderBranches(info: GitBranchesResponse): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const branch of [info.defaultBranch, info.currentBranch, ...info.branches]) {
    if (branch && !seen.has(branch)) {
      seen.add(branch);
      ordered.push(branch);
    }
  }
  return ordered;
}

export function WorkspaceChips({
  projects,
  selectedProject,
  gitInfo,
  gitLoading,
  mode,
  baseBranch,
  onSelectProject,
  onBrowse,
  onEnterPath,
  nativeFolderPickerAvailable,
  onSelectMode,
  onSelectBranch,
}: WorkspaceChipsProps) {
  const [branchOpen, setBranchOpen] = useState(false);
  const [branchQuery, setBranchQuery] = useState('');

  const projectItems: DropdownMenuItem[] = [
    { label: 'No folder', onClick: () => onSelectProject(null) },
    ...projects.map((path) => ({
      label: projectName(path),
      title: path,
      onClick: () => onSelectProject(path),
    })),
    { type: 'divider' as const },
    ...(nativeFolderPickerAvailable
      ? [{ label: 'Browse on this computer…', onClick: onBrowse }]
      : []),
    { label: 'Enter project path…', onClick: onEnterPath },
  ];

  const isGit = !!selectedProject && !!gitInfo?.isGitRepo;
  const noBranches = (gitInfo?.branches.length ?? 0) === 0;

  const modeItems: DropdownMenuItem[] = [
    {
      label: 'Worktree — isolated branch',
      onClick: () => onSelectMode('worktree'),
      disabled: noBranches,
      title: noBranches
        ? 'Repository has no commits yet — worktree mode is unavailable'
        : 'Run in a separate git worktree, safely isolated from your checkout',
    },
    {
      label: 'Direct — edit folder in place',
      onClick: () => onSelectMode('direct'),
      title: 'Work directly in the folder on its current branch',
    },
  ];

  const ordered = gitInfo ? orderBranches(gitInfo) : [];
  const filteredBranches = branchQuery.trim()
    ? ordered.filter((b) => b.toLowerCase().includes(branchQuery.trim().toLowerCase()))
    : ordered;
  const shownBranches = filteredBranches.slice(0, MAX_BRANCH_RESULTS);

  return (
    <div class="flex items-center gap-1 flex-wrap">
      <Dropdown
        position="left"
        items={projectItems}
        trigger={
          <button type="button" class={CHIP_CLASS} title={selectedProject ?? 'No folder'}>
            <FolderIcon />
            <span class="max-w-[180px] truncate">
              {selectedProject ? projectName(selectedProject) : 'No folder'}
            </span>
            <Chevron />
          </button>
        }
      />

      {selectedProject && gitLoading && <span class="px-2 py-1 text-xs text-gray-600">…</span>}

      {isGit && !gitLoading && (
        <Dropdown
          position="left"
          items={modeItems}
          trigger={
            <button type="button" class={CHIP_CLASS}>
              <GitBranchIcon className="w-3.5 h-3.5 flex-shrink-0" />
              <span>{mode === 'worktree' ? 'Worktree' : 'Direct'}</span>
              <Chevron />
            </button>
          }
        />
      )}

      {isGit && !gitLoading && mode === 'worktree' && (
        <Dropdown
          position="left"
          items={[]}
          isOpen={branchOpen}
          onOpenChange={(open) => {
            setBranchOpen(open);
            if (!open) setBranchQuery('');
          }}
          trigger={
            <button type="button" class={CHIP_CLASS} title="Base branch for the new worktree">
              <GitBranchIcon className="w-3.5 h-3.5 flex-shrink-0" />
              <span class="max-w-[160px] truncate">{baseBranch ?? 'Select branch'}</span>
              <Chevron />
            </button>
          }
          customContent={
            <div class="w-64 bg-dark-850 border border-dark-700 rounded-lg p-2">
              <input
                type="text"
                value={branchQuery}
                onInput={(e) => setBranchQuery((e.currentTarget as HTMLInputElement).value)}
                placeholder="Search branches…"
                autoFocus
                class="w-full bg-dark-900 border border-dark-700 rounded-md px-2 py-1.5 text-xs text-gray-100 placeholder-gray-500 focus:outline-none focus:border-dark-600"
              />
              <div class="mt-2 max-h-56 overflow-y-auto flex flex-col gap-0.5">
                {shownBranches.length === 0 ? (
                  <div class="px-2 py-3 text-xs text-gray-600 text-center">
                    No matching branches
                  </div>
                ) : (
                  shownBranches.map((branch) => (
                    <button
                      key={branch}
                      type="button"
                      onClick={() => {
                        onSelectBranch(branch);
                        setBranchOpen(false);
                        setBranchQuery('');
                      }}
                      class="flex items-center justify-between gap-2 px-2 py-1.5 rounded text-xs text-left text-gray-300 hover:bg-white/5 hover:text-gray-100 transition-colors"
                    >
                      <span class="truncate">{branch}</span>
                      {branch === baseBranch && (
                        <svg
                          class="w-3.5 h-3.5 flex-shrink-0 text-blue-400"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width={2}
                            d="M5 13l4 4L19 7"
                          />
                        </svg>
                      )}
                    </button>
                  ))
                )}
                {filteredBranches.length > shownBranches.length && (
                  <div class="px-2 py-1.5 text-[11px] text-gray-600">
                    +{filteredBranches.length - shownBranches.length} more — refine search
                  </div>
                )}
              </div>
            </div>
          }
        />
      )}

      {isGit && !gitLoading && mode === 'direct' && gitInfo?.currentBranch && (
        <span
          class="flex items-center gap-1.5 px-2 py-1 text-xs text-gray-500"
          title="Direct mode works on the folder's current branch"
        >
          <GitBranchIcon className="w-3.5 h-3.5 flex-shrink-0" />
          <span class="max-w-[160px] truncate">{gitInfo.currentBranch}</span>
        </span>
      )}
    </div>
  );
}
