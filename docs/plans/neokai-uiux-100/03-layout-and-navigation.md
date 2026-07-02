# Milestone 03 — Layout and Navigation

## Milestone Goal

Refine the three-column layout and global navigation to create a clear, calm spatial structure aligned with the Japanese Ma (negative space) and Apple spatial consistency principles. The primary work is in `NavRail.tsx`, `ContextPanel.tsx`, and the global `App.tsx` layout shell.

## Milestone Scope

- NavRail visual refresh and logo replacement
- ContextPanel header and action button improvements
- Mobile panel slide behavior and backdrop
- Overall layout depth and background consistency
- Connection status indicator placement

---

## Task 3.1 — NavRail Redesign

**Agent type:** coder

**Description:**
The current `NavRail.tsx` uses a robot emoji as the logo and icon-only buttons with tooltip labels. The active indicator is managed by `NavIconButton` which currently uses `bg-dark-800 text-gray-100` for active. After the Task 2.1 changes, this will be a left-border accent pattern. This task finalizes the NavRail visual design including the logo, spacing, and the daemon status indicator placement.

**Subtasks (in order):**
1. Read `packages/web/src/islands/NavRail.tsx` and `packages/web/src/lib/nav-config.tsx`.
2. Replace the `🤖` emoji logo with an SVG text mark "NK" in `text-indigo-400 font-bold text-lg tracking-tight`. Use a `<span>` with `aria-label="HyperNeo"`.
3. Update the NavRail wrapper to `w-14` (56px) from `w-16` (64px) to be tighter — the left-border accent on NavIconButton already uses 2px, so the effective clickable area is still 54px which is touch-target compliant.
4. Add `gap-2` between nav items (currently `gap-1`) to give each item more breathing room (Ma principle).
5. Move the `DaemonStatusIndicator` to be inlined below the settings button with a `mt-1` separator line (`<div class="w-8 h-px bg-dark-700 mx-auto" />`) above it — this groups the system controls visually.
6. Ensure the NavRail has `z-10` so it stacks correctly above any adjacent content.
7. Run `bun run typecheck` and `bun run lint`.

**Acceptance criteria:**
- `bun run typecheck` and `bun run lint` pass
- NavRail shows "NK" text mark instead of emoji
- NavRail is 56px wide (w-14)
- Active nav item has visible left indigo accent bar
- DaemonStatusIndicator is below settings with a separator

**Depends on:** Milestone 02 complete

**Branch/PR:** Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 3.2 — ContextPanel Sidebar Improvements

**Agent type:** coder

**Description:**
The `ContextPanel.tsx` is the left sidebar that shows session lists, room lists, or settings navigation depending on the active nav section. Key issues: the header padding is heavy (`p-4`) relative to the nav items below; the "Create" button sits prominently at the top but should be in the header without consuming its own row; the mobile backdrop uses `z-35` which is a non-standard Tailwind z-index value; and the settings navigation items use `py-3` which is too tall.

**Subtasks (in order):**
1. Read `packages/web/src/islands/ContextPanel.tsx` in full.
2. Update the panel header: change `p-4` to `px-3 py-3` and reduce the title from `text-lg font-semibold` to `text-sm font-semibold text-gray-400 uppercase tracking-wider` — this is a section label, not a page title. This gives the list items below more visual prominence.
3. Move the action button (Create Room / New Session) out of its own div and into a small `+` icon button positioned to the right of the header title. Use `IconButton` from the component library. Keep the full text for screen readers via `aria-label`.
4. Fix the mobile backdrop z-index: change `z-35` to `z-30` (Tailwind supports `z-30`). Update the panel itself to `z-40` (already correct).
5. In the settings navigation section, change `py-3` to `py-2` for each settings item to reduce vertical density.
6. Add subtle `hover:bg-dark-800/40` to room list items and session list items for a consistent hover state (check `SessionList.tsx` and `RoomList.tsx` for the list item components and update them if needed).
7. Ensure the ContextPanel width is `w-64` (256px) rather than the current `w-70` (280px — a non-standard Tailwind value). Update `w-70` to `w-64` in the panel class.
8. Run `bun run lint` and `bun run typecheck`.

**Acceptance criteria:**
- `bun run lint` and `bun run typecheck` pass
- ContextPanel is 256px wide (standard `w-64`)
- Header shows section label in small caps style
- Action button is a small `+` icon in the header, not a full-width button row
- Mobile z-index is `z-30` for backdrop, `z-40` for panel
- Settings nav items use `py-2`

**Depends on:** Task 3.1

**Branch/PR:** Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 3.3 — Layout Shell and Background Depth Consistency

**Agent type:** coder

**Description:**
The app layout in `App.tsx` renders three columns: NavRail (dark-950), ContextPanel (dark-950), MainContent (dark-900). The inconsistency is that `Lobby.tsx` and `Room.tsx` use `bg-dark-900` for the main area, while `MainContent.tsx` uses `bg-dark-900` at its wrapper level too. The Settings page inner content uses `bg-dark-900` but ChatContainer uses no explicit background and relies on the parent's `dark-900`. This task ensures a clean three-depth system:
- Depth 0 (app chrome): `bg-dark-950` — NavRail, ContextPanel
- Depth 1 (main surface): `bg-dark-900` — MainContent, all page-level backgrounds
- Depth 2 (cards/inputs): `bg-dark-800` — message bubbles, cards, inputs

**Subtasks (in order):**
1. Read `packages/web/src/App.tsx` and `packages/web/src/islands/MainContent.tsx`.
2. Audit all occurrences of `bg-dark-*` in these two files and in `Lobby.tsx`, `Room.tsx`, `SessionsPage.tsx`.
3. In `MainContent.tsx`, ensure the wrapper `<div>` or the setting section wrapper has `bg-dark-900` consistently.
4. In `Lobby.tsx`, ensure the top-level div uses `bg-dark-900`.
5. In `Room.tsx`, ensure the top-level div uses `bg-dark-900`.
6. Update any instances of `bg-dark-850` in main content areas to `bg-dark-900` (dark-850 should only be used for header bars that need to be slightly distinct from the main surface).
7. Update the `ChatHeader` component: it currently uses `bg-dark-850/50 backdrop-blur-sm`. Change to `bg-dark-900/80 backdrop-blur-sm border-b border-dark-700` for a cleaner layered look.
8. Run `bun run typecheck` and `bun run lint`.

**Acceptance criteria:**
- `bun run typecheck` and `bun run lint` pass
- Consistent three-depth background system is visible in dev
- No page uses `bg-dark-850` except for intentional header bars
- Chat header is `bg-dark-900/80` with backdrop blur

**Depends on:** Task 3.2

**Branch/PR:** Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 3.4 — Mobile Navigation and Responsive Layout Cleanup

**Agent type:** coder

**Description:**
On mobile, the ContextPanel includes a `flex items-center gap-1 px-2 py-2` nav strip at the top that duplicates the desktop NavRail. The `MobileMenuButton` component triggers the panel open. This is functional but the mobile nav strip has too many buttons crammed in one row. This task cleans up the mobile experience and ensures smooth panel animations.

**Subtasks (in order):**
1. Read `packages/web/src/components/ui/MobileMenuButton.tsx` (if it exists) and the mobile nav strip section of `ContextPanel.tsx`.
2. Ensure the mobile nav strip icons have `p-2` minimum touch targets (not `p-1.5`).
3. Change the ContextPanel slide animation from `transition-transform duration-300 ease-in-out` to `transition-transform duration-250 ease-out` (aligns with the `--duration-smooth` token).
4. On mobile, the backdrop fade-in should use `animate-fadeIn` class (defined in styles.css at 150ms) — add the class to the backdrop div.
5. Verify the `MobileMenuButton` opens the `contextPanelOpenSignal` correctly and close any gaps.
6. Ensure that when a room or session is selected on mobile (i.e., the user taps an item in the sidebar), the panel closes automatically — check that `onRoomSelect` and `onSessionSelect` callbacks set `contextPanelOpenSignal.value = false`.
7. Add `overscroll-behavior: contain` to the ContextPanel's scrollable content area to prevent the background page from scrolling when the user reaches the top/bottom of the sidebar list.
8. Run `bun run lint` and `bun run typecheck`.

**Acceptance criteria:**
- `bun run lint` and `bun run typecheck` pass
- Mobile nav strip has proper `p-2` touch targets
- Panel slide animation uses 250ms ease-out
- Backdrop fades in with `animate-fadeIn`
- Selecting an item in the sidebar closes the mobile panel
- Sidebar scroll does not bleed through to the background

**Depends on:** Task 3.3

**Branch/PR:** Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
