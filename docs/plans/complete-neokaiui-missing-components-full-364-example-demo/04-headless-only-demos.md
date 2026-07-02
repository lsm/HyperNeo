# Milestone 4: Headless-Only Demos

## Goal

Port the 2 reference files that use headlessui but NOT heroicons. These are notification overlay variants that use the Toast/Toaster API.

## Scope

- 1 subcategory (overlays/notifications)
- 2 reference JSX files
- Very small batch; can be combined with M5 or done independently

## Porting Checklist (per file)

Everything from M2 checklist PLUS:
1. Convert headlessui imports to @hyperneo/ui equivalents:
   - Reference uses headlessui Dialog, DialogPanel, DialogBackdrop, DialogTitle, Transition, TransitionChild, etc.
   - Map to @hyperneo/ui component imports from `../../src/mod.ts` (or relative path from demo sections)
2. Convert headlessui component APIs:
   - `open` / `onClose` props map directly
   - Data attribute variants (`data-closed:`, `data-open:`, etc.) convert to bracketed form
   - `Transition` and `TransitionChild` usage is identical between headlessui and @hyperneo/ui
3. Handle any headlessui-specific patterns (e.g., `Transition.Child` -> `TransitionChild` in @hyperneo/ui)

## Tasks

### Task 4.1: Headless-only notification demos (2 files)

**Description**: Port the 2 headless-only notification reference files into the existing NotificationDemo.

**Subtasks**:

1. **Update `packages/ui/demo/sections/NotificationDemo.tsx`** to add 2 new notification variants:
   - `overlays/notifications/04-with-avatar.jsx`: Notification toast with avatar. Uses Dialog/Transition from headlessui.
   - `overlays/notifications/05-with-split-buttons.jsx`: Notification toast with split action buttons. Uses Dialog/Transition from headlessui.

2. Convert headlessui imports to @hyperneo/ui imports. The existing NotificationDemo already imports from `../../src/mod.ts`, so follow the same pattern.

3. Verify the new notification examples integrate well with the existing toast system (Toaster + useToast).

**Acceptance criteria**:
- 2 new notification variants render correctly in the NotificationDemo section
- All headlessui imports replaced with @hyperneo/ui imports
- No `@headlessui` imports remain
- Toast system still works for all notification variants
- `bun run dev` starts without errors

**Depends on**: Task 1.2 (categorized sidebar)

**Agent type**: coder

**Note**: Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
