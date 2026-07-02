# Plan: Complete @hyperneo/ui -- Missing Components + Full 364-Example Demo

## Goal Summary

Port all 364 Tailwind Application UI v4 reference examples as live demo sections in `packages/ui/demo/`, add missing headless component wrappers, and integrate an icon library. The result is a comprehensive visual reference ("kitchen sink") showcasing every @hyperneo/ui component with real-world layout patterns.

## High-Level Approach

1. **Foundation** -- Fix package.json exports gap, add `lucide-preact` icon library, refactor demo App.tsx to support a categorized sidebar (49 sections across 11 categories).
2. **Pure HTML demos** -- Port 162 reference files that have zero external dependencies first (no headlessui, no heroicons). These are pure Tailwind markup and are the fastest to port.
3. **Icon-only demos** -- Port 94 reference files that use heroicons but not headlessui. Depends on lucide-preact being available and icon name mapping being established.
4. **Headless-only demos** -- Port the 2 reference files that use headlessui but not heroicons. These map directly to existing @hyperneo/ui component APIs. (Very small batch; only notification variants.)
5. **Combined headless+icon demos** -- Port 106 reference files that use both headlessui and heroicons. 100 are covered by M5 tasks; the remaining 6 page-examples are in M6. The most complex batch requiring both component API knowledge and icon mapping.
6. **Page-example compositions** -- Port the 6 full-page reference examples (detail-screens, home-screens, settings-screens) that combine multiple categories into cohesive layouts.
7. **Integration and QA** -- Visual QA pass, sidebar navigation polish, dark/light theme verification, ensure all 364 examples render correctly.

## Data Attribute Syntax Decision

Reference files use `data-closed:` (unbracketed Tailwind v4 syntax). Existing @hyperneo/ui demos use `data-[closed]:` (bracketed). Both work because the render utility sets `data-closed=""`. **Decision: keep the bracketed form (`data-[closed]:`)** for consistency with existing demos. All ported examples must convert unbracketed to bracketed data attribute variants.

## Reference Location

All 364 reference JSX files are at: `/Users/lsm/focus/tmp/tailwind/application-ui-v4/react/`
- 11 categories, 49 subcategories
- Each subcategory has 2-21 JSX files

## Demo Output Location

All new demo files go to: `packages/ui/demo/sections/`
- One file per subcategory (49 new demo files)
- Each file exports a single Preact function component

## Component Source Location

@hyperneo/ui component source: `packages/ui/src/components/`
Package barrel export: `packages/ui/src/mod.ts`

## Cross-Milestone Dependencies

```
M1 (Foundation) -- no dependencies
M2 (Pure HTML demos) -- depends on M1 (App.tsx categorized sidebar)
M3 (Icon-only demos) -- depends on M1 (lucide-preact setup, icon name mapping)
M4 (Headless-only demos) -- depends on M1 (App.tsx sidebar)
M5 (Headless+icon demos) -- depends on M3 (icon mapping), M4 (headless patterns)
M6 (Page compositions) -- depends on M2-M5 (reuses patterns)
M7 (Integration & QA) -- depends on M2-M6 (all demos complete)
```

M2, M3, M4 can run in parallel after M1 completes.
M5 depends on M3 completing (for icon mapping). M4 is so small (2 files) it can be folded into M5 or done in parallel.
M6 can start once enough of M2-M5 are done (it reuses patterns from all prior milestones).

## Icon Library: lucide-preact

- **Package**: `lucide-preact` (v0.577.0, official Preact support, tree-shakable)
- **Install as**: devDependency in `packages/ui/package.json`
- **Heroicons-to-lucide mapping**: A lookup table mapping 66 unique heroicon names (plus any aliases) to their lucide equivalents will be created in M1. Most heroicons have direct lucide counterparts; a few may need `ChevronDown` -> `ChevronDown`, `XMarkIcon` -> `X`, etc.
- **Usage pattern**: `import { Search, Folder } from 'lucide-preact'` then `<Search class="w-5 h-5" />`

## Total Estimated Task Count

**7 milestones, 16 tasks total**

| Milestone | Tasks | Reference Files |
|-----------|-------|-----------------|
| M1: Foundation | 2 | 0 (infrastructure) |
| M2: Pure HTML demos | 3 | 162 |
| M3: Icon-only demos | 2 | 94 |
| M4: Headless-only demos | 1 | 2 |
| M5: Headless+icon demos | 3 | 100 |
| M6: Page compositions | 1 | 6 |
| M7: Integration & QA | 2 | 0 (verification) |
| **Total** | **16** | **364** |

## Dependency Breakdown by Reference File

| Dependency type | File count | Subcategories (with per-subcategory counts) |
|----------------|------------|---------------|
| Pure HTML (no deps) | 162 | avatars (11), badges (16), buttons (5), button-groups (1), card-headings (4), page-headings (3), section-headings (6), cards (10), containers (5), dividers (4), list-containers (7), media-objects (8), tables (17), stacked-lists (6), stats (3), toggles (5), checkboxes (4), radio-groups (11), input-groups (14), sign-in-forms (4), textareas (1), action-panels (8), empty-states (1), pagination (1), progress-bars (3), vertical-navigation (2) |
| Icon-only (heroicons) | 94 | alerts (6), empty-states (5), description-lists (6), calendars (1), stats (2), form-layouts (4), input-groups (7), radio-groups (1), select-menus (1), dividers (4), feeds (2), grid-lists (4), stacked-lists (7), tables (2), breadcrumbs (4), pagination (2), progress-bars (5), sidebar-navigation (3), tabs (9), vertical-navigation (4), button-groups (3), buttons (3), card-headings (1), page-headings (3), section-headings (3), multi-column (2) |
| Headless-only (headlessui) | 2 | notifications (2) |
| Both (headlessui + heroicons) | 106 | command-palettes (8), navbars (11), drawers (12), modal-dialogs (6), notifications (4), comboboxes (4), select-menus (6), textareas (4), dropdowns (5), button-groups (1), multi-column (4), sidebar (8), stacked (9), calendars (7), stacked-lists (2), feeds (1), grid-lists (1), card-headings (1), page-headings (3), section-headings (1), sidebar-navigation (2), page-examples (6) — of these, 100 are in M5, 6 page-examples are in M6 |

## Milestone File Index

| File | Milestone |
|------|-----------|
| `01-foundation.md` | Foundation: exports, icon library, App.tsx refactor |
| `02-pure-html-demos.md` | Pure HTML demos: layout, headings, forms (no deps) |
| `03-icon-only-demos.md` | Icon-only demos: elements, feedback, navigation (heroicons only) |
| `04-headless-only-demos.md` | Headless-only demos: notification overlays (headlessui only, 2 files) |
| `05-headless-icon-demos.md` | Combined headless+icon demos: forms, navigation, overlays |
| `06-page-compositions.md` | Page compositions: full-screen layouts combining patterns |
| `07-integration-qa.md` | Integration, visual QA, sidebar polish, final verification |
