# Milestone 7: Integration and QA

## Goal

Final integration pass: verify all 364 reference examples are ported and rendering correctly, fix any remaining issues, polish the sidebar navigation, and ensure dark/light theme works across all demos.

## Scope

- Visual QA of all demo sections
- Sidebar navigation polish
- Dark/light theme verification
- Fix any rendering issues discovered during QA
- Update demo header/description
- Ensure build works

## Tasks

### Task 7.1: Visual QA and bug fixes

**Description**: Systematically verify all 364 reference examples are ported and rendering correctly. Fix any issues found.

**Subtasks**:

1. **Audit completeness**: Compare the reference file listing against the demo sections. Create a checklist:
   - For each of the 48 subcategories, verify the demo file exists
   - For each of the 364 reference files, verify it has a corresponding rendered example in the demo
   - Count total examples rendered vs. 364 target

2. **Visual QA pass**: Run `bun run dev` and scroll through every section:
   - Verify layout matches the reference screenshots (if available)
   - Check that all interactive elements work (buttons, menus, popovers, drawers, dialogs, comboboxes, etc.)
   - Verify data attribute transitions work (open/close animations)
   - Check for any console errors

3. **Dark/light theme verification**:
   - Toggle between dark and light themes
   - Verify all demos look correct in both modes
   - Check that semantic color tokens are used consistently (no hardcoded colors that break in one theme)

4. **Fix any issues found**:
   - Missing examples: port them
   - Broken layouts: fix CSS class issues
   - Non-functional interactive elements: debug component API mismatches
   - Theme issues: replace hardcoded colors with semantic tokens
   - Import errors: fix component or icon import paths

5. **Lint and type check**:
   - Run `bun run lint` from repo root and fix any issues
   - Run `bun run typecheck` from repo root and fix any issues
   - Run `bun run check` (lint + typecheck + knip) from repo root

**Acceptance criteria**:
- All 364 reference examples have corresponding rendered demos
- No console errors when browsing the demo app
- All interactive elements function correctly
- Dark and light themes both look correct across all sections
- `bun run lint` passes
- `bun run typecheck` passes
- `bun run check` passes (or only pre-existing failures remain)

**Depends on**: Task 2.1, Task 2.2, Task 2.3, Task 3.1, Task 3.2, Task 4.1, Task 5.1, Task 5.2, Task 5.3, Task 6.1

**Agent type**: coder

**Note**: Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 7.2: Sidebar polish, demo header update, and final build verification

**Description**: Polish the demo app's sidebar navigation, update the header/description, and verify the production build works.

**Subtasks**:

1. **Sidebar navigation polish**:
   - Ensure all categories are collapsed by default except "Components" (existing headless demos)
   - Add a "scroll to top" link or button at the bottom of the sidebar
   - Highlight the currently visible section in the sidebar (using Intersection Observer or similar)
   - Consider adding a search/filter for sections (stretch goal -- only if time permits)

2. **Update demo header**:
   - Update the demo title from "@hyperneo/ui -- Kitchen Sink" to something more descriptive like "@hyperneo/ui -- Component Library & Application UI Reference"
   - Update the subtitle to mention the count: "Visual demo of all headless UI components and 364+ Tailwind Application UI examples"
   - Add a link to the GitHub repository or documentation

3. **Update demo/styles.css**:
   - Review and clean up any temporary CSS added during development
   - Ensure the page-preview container styles (from M6) are clean

4. **Production build verification**:
   - Run `bun run build:demo` and verify it completes without errors
   - Verify the built output can be served (e.g., `npx serve packages/ui/demo/dist` or similar)
   - Check that the built demo loads correctly in a browser

5. **Run existing tests**:
   - Run `bun run test` in `packages/ui` to verify no regressions
   - All existing component tests should still pass

**Acceptance criteria**:
- Sidebar highlights currently visible section
- Demo header accurately describes the content
- `bun run build:demo` completes successfully
- Built demo loads correctly in browser
- `bun run test` passes with no regressions
- No dead CSS or unused imports in demo files

**Depends on**: Task 7.1 (all demos complete and verified)

**Agent type**: coder

**Note**: Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
