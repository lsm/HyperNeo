# HyperNeo UI/UX 1.0.0 Upgrade — Overview

## Goal Summary

Systematically redesign HyperNeo's frontend UI/UX grounded in Japanese design philosophy (Ma, Kanso, Shibui) and Apple UX principles (progressive disclosure, spatial consistency, purposeful motion). The upgrade addresses four core problems identified in the codebase:

1. **Scattered task confirmation UX** — The `QuestionPrompt` component and tool confirmation flows appear inline in the message stream with inconsistent styling and context loss. The `WorktreeChoiceInline` component suffers from similar ad-hoc placement.
2. **Unclear information architecture** — The three-column layout (NavRail → ContextPanel → MainContent) works but the Home/Rooms/Chats nav section mapping is non-obvious, and the Room tab structure (Overview/Context/Agents/Missions/Settings) is flat and un-hierarchical.
3. **Visual noise** — Competing border colors across 20+ semantic token categories, inconsistent background depth levels (`dark-950` / `dark-900` / `dark-850` / `dark-800`), emoji usage in nav icons, and multiple "active" indicators (border colors, bg changes, text colors) with no single visual language.
4. **No unified component library** — UI primitives (`Button`, `Modal`, `Dropdown`, `Tooltip`, `IconButton`, `NavIconButton`, `Spinner`, `Skeleton`) were built independently and use different styling conventions; several components duplicate logic.

## Approach

The upgrade is structured as six milestones progressing from foundations to features. Each milestone produces shippable, testable improvements. Design changes are made in the `packages/web/` package only (frontend-only work). No backend API changes are required.

The plan deliberately avoids full rewrites in favor of targeted, incremental improvements that can each be reviewed and merged separately, keeping the branch history clean and CI passing at every milestone.

## Milestones

| # | Slug | Description |
|---|------|-------------|
| 01 | design-system-tokens | Consolidate and extend design tokens: color scale, spacing scale, typography scale, motion tokens |
| 02 | component-library | Refactor and unify UI primitives: Button, Modal, Dropdown, Tooltip, IconButton, Spinner, Skeleton |
| 03 | layout-and-navigation | Refine the three-column layout and global navigation: NavRail, ContextPanel sidebar, mobile hamburger |
| 04 | confirmation-and-interaction | Unified task/tool confirmation UX: QuestionPrompt redesign, tool action bar, interrupt/stop UX |
| 05 | chat-and-message-ux | Chat stream improvements: message bubble polish, tool card hierarchy, thinking block, status bar |
| 06 | room-and-lobby | Room dashboard redesign, Lobby homepage, Room tab navigation, GoalsEditor visual polish |

## Cross-Milestone Dependencies

```
01-design-system-tokens
    └── 02-component-library (consumes new tokens)
            ├── 03-layout-and-navigation (uses new primitives)
            ├── 04-confirmation-and-interaction (uses new primitives)
            └── 05-chat-and-message-ux (uses new primitives)
                    └── 06-room-and-lobby (uses all above)
```

Milestones 03, 04, and 05 can proceed in parallel after milestone 02 is merged. Milestone 06 requires 03–05 to be complete.

## Total Estimated Tasks

26 tasks across 6 milestones.

## Key Design Decisions

### Color System
Keep the existing `dark-{950,900,850,800,700,600}` scale but reduce active use to three depth levels: `dark-950` (app background), `dark-900` (panel/surface), `dark-800` (card/interactive). Introduce a single accent color: indigo (`#6366F1`) to replace the current blue-500 accent (better contrast on dark, more sophisticated).

### Spacing & Typography
Adopt an 8px base grid with a 4-step typographic scale: `xs/sm/base/lg`. Remove ad-hoc spacing values; use only Tailwind's 4pt scale (multiples of 4px).

### Motion
Define three motion presets: `instant` (0ms, state toggles), `quick` (150ms ease-out, hover/focus), `smooth` (250ms ease-out, panels and overlays). Remove or replace the current `animate-slideInRight` which lacks an entrance easing curve appropriate for the design philosophy.

### Confirmation UX
Move task confirmation (QuestionPrompt) out of the inline message stream into a persistent "action tray" that docks above the message input. This keeps context visible (the conversation continues to be readable above) while the action prompt appears at the point of user attention (near the input field). This resolves the primary UX complaint about context loss.

### Navigation
Replace the emoji robot logo in NavRail with a text mark `NK`. Convert NavRail icon buttons to use a single active indicator: left border accent + subtle background fill (no border color variance). The ContextPanel sidebar title should track the active section without requiring a separate "header" region.
