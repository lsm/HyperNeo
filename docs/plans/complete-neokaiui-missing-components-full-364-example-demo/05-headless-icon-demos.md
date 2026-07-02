# Milestone 5: Combined Headless+Icon Demos

## Goal

Port all 106 reference files that use BOTH headlessui AND heroicons. This is the most complex batch requiring component API mapping AND icon library usage.

## Scope

- ~25 subcategories across 9 top-level categories
- 100 reference JSX files covered by M5 tasks (22 + 21 + 57)
- The remaining 6 "both" files are page-examples covered by M6 (detail-screens, home-screens, settings-screens)
- Largest and most complex milestone

## Porting Checklist (per file)

Everything from M2 + M3 checklists PLUS:
1. Convert headlessui imports to @hyperneo/ui equivalents (see mapping table below)
2. Convert headlessui component names and APIs:
   - `Dialog` -> `Dialog`, `DialogBackdrop` -> `DialogBackdrop`, `DialogPanel` -> `DialogPanel`, `DialogTitle` -> `DialogTitle`, `DialogDescription` -> `DialogDescription`
   - `Transition` -> `Transition`, `Transition.Child` -> `TransitionChild`
   - `Combobox`, `ComboboxInput`, `ComboboxOptions`, `ComboboxOption`, `ComboboxButton` -> same names from @hyperneo/ui
   - `Listbox`, `ListboxButton`, `ListboxOptions`, `ListboxOption` -> same names
   - `Menu`, `MenuButton`, `MenuItems`, `MenuItem` -> same names (note: reference uses `MenuItems`, @hyperneo/ui uses same)
   - `Popover`, `PopoverButton`, `PopoverPanel`, `PopoverGroup` -> same names
   - `Disclosure`, `DisclosureButton`, `DisclosurePanel` -> same names
   - `Tab`, `TabGroup`, `TabList`, `TabPanel`, `TabPanels` -> same names
   - `CloseButton` -> `CloseButton` (from @hyperneo/ui Dialog)
   - `Label`, `Field`, `Description`, `FieldError` -> from @hyperneo/ui
3. Convert heroicon imports to lucide-preact using `icon-map.ts`
4. Handle any headlessui-specific patterns not present in @hyperneo/ui:
   - If a component is missing, note it and use a workaround (HTML element with appropriate data attributes)
   - `Description` in headlessui maps to `DialogDescription` or `Description` from @hyperneo/ui (verify which is correct for the context)

## headlessui-to-neokai Import Mapping

| headlessui import | @hyperneo/ui import |
|-------------------|-------------------|
| `@headlessui/react` Dialog components | `../../src/mod.ts` or `@hyperneo/ui` |
| `@headlessui/react` Transition | Same pattern |
| `@headlessui/react` Combobox* | Same pattern |
| `@headlessui/react` Listbox* | Same pattern |
| `@headlessui/react` Menu* | Same pattern |
| `@headlessui/react` Popover* | Same pattern |
| `@headlessui/react` Disclosure* | Same pattern |
| `@headlessui/react` Tab* | Same pattern |

## Tasks

### Task 5.1: Headless+icon demos -- Overlays (drawers, modal-dialogs, notifications) (22 files)

**Description**: Port all combined headless+icon reference files from the overlays category. This includes drawers, modal dialogs, and notifications.

**Subtasks**:

1. **Create `overlays/drawers/DrawersDemo.tsx`** (12 files): Empty, empty wide, with background overlay, with close button on outside, with branded header, with sticky footer, create project form, wide create project form, user profile, wide user profile, contact list, file details. Uses Dialog + TransitionChild pattern (same as existing DrawerDemo). Icons: `XMarkIcon`, `PlusIcon`, `PhotoIcon`, `PaperClipIcon`, `FolderIcon`, etc.

2. **Create `overlays/modal-dialogs/ModalDialogsDemo.tsx`** (6 files): Centered with single action, centered with wide buttons, simple alert, simple with dismiss button, simple with gray footer, simple with left-aligned buttons. Uses Dialog + Transition. Icons: `ExclamationTriangleIcon`, `XMarkIcon`.

3. **Update `overlays/notifications/NotificationsDemo.tsx`** -- add 4 headless+icon notification variants: simple, condensed, with actions below, with buttons below. These use Dialog/Transition with icons. **Note**: This extends the same file that M4.1 (Task 4.1) creates. M4.1 must complete first so the base notification demos exist before adding icon variants.

4. **Update `packages/ui/demo/App.tsx`** to register new demo sections.

**Acceptance criteria**:
- 2 new demo section files created (DrawersDemo, ModalDialogsDemo)
- Existing NotificationDemo extended with 4 more variants (M4.1 must be merged first)
- All 22 overlay reference examples render correctly
- All headlessui imports replaced with @hyperneo/ui
- All heroicon imports replaced with lucide-preact
- Drawer panels open/close with transition animations
- Modal dialogs open/close with backdrop
- `bun run dev` starts without errors

**Depends on**: Task 1.2 (icon-map.ts, sidebar), Task 3.1 (lucide patterns established), Task 4.1 (base NotificationDemo.tsx must exist before extending with icon variants)

**Agent type**: coder

**Note**: Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 5.2: Headless+icon demos -- Navigation (command-palettes, navbars, sidebar-navigation) (21 files)

**Description**: Port all combined headless+icon reference files from the navigation category.

**Subtasks**:

1. **Create `navigation/command-palettes/CommandPalettesDemo.tsx`** (8 files): Simple, simple with padding, with preview, with images and descriptions, with icons, semi-transparent with icons, with groups, with footer. Uses Dialog + Combobox composition. Icons: `MagnifyingGlassIcon`, `FaceFrownIcon`, `CodeBracketIcon`, `CommandLineIcon`, etc.

2. **Create `navigation/navbars/NavbarsDemo.tsx`** (11 files): Simple dark with menu button on left, dark with quick action, simple dark, simple with menu button on left, simple, with quick action, dark with search, with search, dark with centered search, with centered search, with search in column layout. Uses Dialog + Transition for mobile menu, Popover for dropdowns. Icons: `Bars3Icon`, `MagnifyingGlassIcon`, `XMarkIcon`, `BellIcon`, `PlusIcon`.

3. **Update `navigation/sidebar-navigation/SidebarNavigationDemo.tsx`** -- add 2 headless+icon examples: with expandable sections, with secondary navigation. Uses Disclosure for expandable sections.

4. **Update `packages/ui/demo/App.tsx`** to register new demo sections.

**Acceptance criteria**:
- 2 new demo section files created (CommandPalettesDemo, NavbarsDemo)
- Existing SidebarNavigationDemo extended with 2 more variants
- All 21 navigation reference examples render correctly
- Command palettes open/close with search functionality
- Navbar mobile menus toggle correctly
- Sidebar expandable sections work with Disclosure
- `bun run dev` starts without errors

**Depends on**: Task 1.2 (icon-map.ts, sidebar), Task 3.2 (lucide patterns established)

**Agent type**: coder

**Note**: Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 5.3: Headless+icon demos -- Application Shells, Forms, Lists, Data Display, Headings (57 files)

**Description**: Port all remaining combined headless+icon reference files from application-shells, forms, lists, data-display, and headings categories.

**Subtasks**:

1. **Create `application-shells/multi-column/MultiColumnShellsDemo.tsx`** (4 files): Full-width three column, full-width secondary column on right, full-width with narrow sidebar, full-width with narrow sidebar and header. Uses Popover for navigation menus. Icons: various.

2. **Create `application-shells/sidebar/SidebarShellsDemo.tsx`** (8 files): Simple sidebar, simple dark sidebar, sidebar with header, dark sidebar with header, with constrained content area, with off-white background, simple brand sidebar, brand sidebar with header. Uses Popover, Disclosure for mobile menus. Icons: `Bars3Icon`, `XMarkIcon`, `BellIcon`, `PlusIcon`, `MagnifyingGlassIcon`.

3. **Create `application-shells/stacked/StackedShellsDemo.tsx`** (9 files): With bottom border, on subtle background, with lighter page header, branded nav with compact lighter page header, with overlap, brand nav with overlap, brand nav with lighter page header, with compact lighter page header, two-row navigation with overlap. Uses Popover, Disclosure. Icons: various.

4. **Create `forms/comboboxes/ComboboxesDemo.tsx`** (4 files): Simple, with status indicator, with avatar, with secondary text. Uses Combobox from @hyperneo/ui. Icons: `CheckIcon`, `ChevronUpDownIcon`.

5. **Create `forms/select-menus/CustomSelectMenusDemo.tsx`** (6 files): Simple custom, custom with check on left, custom with status indicator, custom with avatar, with secondary text, branded with supporting text. Uses Listbox from @hyperneo/ui. Icons: `CheckIcon`, `ChevronUpDownIcon`.

6. **Update `forms/textareas/TextareasDemo.tsx`** -- add 4 headless+icon examples: with avatar and actions, with underline and actions, with title and pill actions, with preview button. Uses Popover for menus.

7. **Create `elements/dropdowns/DropdownsDemo.tsx`** (5 files): Simple, with dividers, with icons, with minimal menu icon, with simple header. Uses Menu from @hyperneo/ui. Icons: `EllipsisVerticalIcon`, `PencilIcon`, `TrashIcon`, `ArchiveBoxIcon`, etc.

8. **Update `elements/button-groups/ButtonGroupsDemo.tsx`** -- add 1 headless+icon example: with dropdown. Uses Menu.

9. **Create `data-display/calendars/CalendarsHeadlessDemo.tsx`** (7 files): Small with meetings, month view, week view, day view, year view, borderless stacked, borderless side-by-side. Uses Dialog for event popups. Icons: `ChevronLeftIcon`, `ChevronRightIcon`, `PlusIcon`, `XMarkIcon`.

10. **Update `lists/feeds/FeedsDemo.tsx`** -- add 1 headless+icon example: with comments. Uses Menu.

11. **Update `lists/grid-lists/GridListsDemo.tsx`** -- add 1 headless+icon example: logos cards with description list.

12. **Update `lists/stacked-lists/StackedListsDemo.tsx`** -- add 2 headless+icon examples: with inline links and actions menu, with badges button and actions menu. Uses Menu.

13. **Update `headings/card-headings/CardHeadingsDemo.tsx`** -- add 1 headless+icon example: with avatar meta and dropdown. Uses Menu, Popover.

14. **Update `headings/page-headings/PageHeadingsDemo.tsx`** -- add 3 headless+icon examples: with meta and actions, with meta actions and breadcrumbs, with logo meta and actions. Uses Menu, Popover.

15. **Update `headings/section-headings/SectionHeadingsDemo.tsx`** -- add 1 headless+icon example: with badge and dropdown. Uses Menu.

16. **Update `packages/ui/demo/App.tsx`** to register all new demo sections.

**Acceptance criteria**:
- 7 new demo section files created
- Multiple existing demo files extended
- All 57 reference examples render correctly
- All interactive elements (comboboxes, listboxes, menus, popovers, disclosures) function correctly
- `bun run dev` starts without errors

**Depends on**: Task 3.1 (lucide patterns), Task 3.2 (existing demos to extend)

**Agent type**: coder

**Note**: Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
