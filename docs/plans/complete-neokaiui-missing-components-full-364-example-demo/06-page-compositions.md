# Milestone 6: Page Compositions

## Goal

Port the 6 full-page reference examples from `page-examples/`. These are complete page layouts that combine patterns from multiple categories (application shells, navigation, headings, lists, forms) into cohesive compositions.

## Scope

- 3 subcategories: detail-screens, home-screens, settings-screens
- 6 reference JSX files (2 per subcategory)
- Each combines application shell layout + navigation + content sections

## Porting Notes

- These are the most complex reference files. Each one renders a full page layout including sidebar navigation, header, breadcrumbs, and content area.
- All 6 files use both headlessui AND heroicons (Disclosure, Popover, Menu for navigation menus; various icons for UI elements).
- The sidebar/header patterns may duplicate patterns from the application-shells demos. That is acceptable -- these are full-page compositions meant to showcase how components work together.
- Consider whether these should render as standalone full-viewport sections or as contained "page preview" cards. Given the existing demo layout (scrollable single-page), rendering them as contained sections with a fixed-height scrollable preview area is likely best.

## Tasks

### Task 6.1: Page composition demos (6 files)

**Description**: Port all 6 page-example reference files as full-page composition demos.

**Subtasks**:

1. **Create `page-examples/detail-screens/DetailScreensDemo.tsx`** (2 files):
   - `01-sidebar.jsx`: Detail screen with sidebar navigation layout. Uses Disclosure for sidebar sections, Popover for menus. Icons: various.
   - `02-stacked.jsx`: Detail screen with stacked navigation layout. Uses Popover, Menu. Icons: various.

2. **Create `page-examples/home-screens/HomeScreensDemo.tsx`** (2 files):
   - `01-sidebar.jsx`: Home/dashboard screen with sidebar. Uses Disclosure, Popover, Menu. Icons: `HomeIcon`, `UsersIcon`, `FolderIcon`, `CalendarDaysIcon`, `DocumentDuplicateIcon`, `Cog6ToothIcon`.
   - `02-stacked.jsx`: Home/dashboard screen with stacked layout. Uses Popover, Menu.

3. **Create `page-examples/settings-screens/SettingsScreensDemo.tsx`** (2 files):
   - `01-sidebar.jsx`: Settings screen with sidebar navigation. Uses Disclosure for sidebar sections. Icons: `UserCircleIcon`, `BellIcon`, `GlobeAmericasIcon`, `CommandLineIcon`, `LifebuoyIcon`.
   - `02-stacked.jsx`: Settings screen with stacked navigation. Uses Menu, Popover.

4. **Update `packages/ui/demo/App.tsx`** to register the 3 new page-example demo sections under "Application UI > Page Examples".

5. **Add CSS for page preview containers** in `demo/styles.css` if needed:
   - Consider adding a `.page-preview` class that constrains the height and adds overflow scrolling
   - These full-page layouts may need a fixed-height container to avoid making the demo page extremely long

**Acceptance criteria**:
- 3 new demo section files created
- All 6 page composition examples render correctly
- Sidebar navigation sections expand/collapse
- Popover menus open/close
- All heroicon imports replaced with lucide-preact
- All headlessui imports replaced with @hyperneo/ui
- Page compositions are visually contained (not infinitely tall)
- `bun run dev` starts without errors

**Depends on**: Task 5.1 (overlay patterns), Task 5.2 (navigation patterns), Task 5.3 (application shell patterns)

**Agent type**: coder

**Note**: Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
