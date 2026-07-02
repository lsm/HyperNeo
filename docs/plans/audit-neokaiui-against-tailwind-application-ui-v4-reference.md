# Audit: @hyperneo/ui vs Tailwind Application UI v4 Reference

## Executive Summary

This audit compares the `@hyperneo/ui` headless component library (v0.8.0) against the Tailwind Application UI v4 React examples (364 files across 11 categories) and the Tailwind Catalyst UI Kit (27 styled components). The goal is to identify specific improvements and additions for `packages/ui` itself.

**Key finding:** `@hyperneo/ui` is a well-built headless library with 64 named exports (20 export statements) across 19 component families and 27 test files. The Tailwind v4 reference demonstrates 6 new headless primitives that should be added (Alert, Avatar, AvatarGroup, Badge, Progress, Stepper), 5 existing components that need API improvements (Toast, Field, Input, Menu, Button), and 3 composable patterns (Command Palette, Drawer, Notification variants) that can be built from existing primitives.

**Secondary finding:** The reference also demonstrates Catalyst-style CSS custom property theming (`--btn-bg`, `--btn-border`) and a TouchTarget accessibility pattern that @hyperneo/ui should adopt.

---

## 1. @hyperneo/ui Current State

### 1.1 Component Inventory

The library exports **64 named symbols** (20 export statements) from **19 component families** (verified from `packages/ui/src/mod.ts`):

| Component Family | Exports | Category |
|---|---|---|
| Button | Button, CloseButton, DataInteractive | Interactive |
| Checkbox | Checkbox | Form |
| Combobox | Combobox, ComboboxInput, ComboboxButton, ComboboxOption, ComboboxOptions | Selection |
| Dialog | Dialog, DialogPanel, DialogTitle, DialogDescription, DialogBackdrop | Overlay |
| Disclosure | Disclosure, DisclosureButton, DisclosurePanel | Interactive |
| Field | Field, Fieldset, Label, Description, Legend | Form |
| Input | Input, Textarea, Select | Form |
| Listbox | Listbox, ListboxButton, ListboxOption, ListboxOptions, ListboxSelectedOption | Selection |
| Menu | Menu, MenuButton, MenuItems, MenuItem, MenuSection, MenuHeading, MenuSeparator | Overlay |
| Popover | Popover, PopoverButton, PopoverPanel, PopoverBackdrop, PopoverGroup | Overlay |
| Tooltip | Tooltip, TooltipPanel, TooltipTrigger | Overlay |
| RadioGroup | RadioGroup, Radio | Form |
| Switch | Switch | Form |
| Tabs | TabGroup, TabList, Tab, TabPanels, TabPanel | Navigation |
| Transition | Transition | Animation |
| Toast | Toast, ToastTitle, ToastDescription, ToastAction, Toaster, useToast | Feedback |
| IconButton | IconButton | Interactive |
| Skeleton | Skeleton | Feedback |
| Spinner | Spinner | Feedback |

Plus one hook: `useClose`.

### 1.2 Architecture Strengths

- **Headless/unstyled pattern**: All components use a `render()` utility from `internal/render.ts` that merges accessibility props with user-provided styling. Interaction states are exposed via `data-*` attributes (`data-hover`, `data-focus`, `data-active`, `data-open`, `data-closed`, `data-enter`, `data-leave`, `data-transition`, `data-selected`, `data-disabled`).
- **Compound component pattern**: Context-based composition with parent-child validation (e.g., `DialogTitle` must be within `Dialog`).
- **Polymorphic `as` prop**: Every component accepts `as` to render as any HTML element.
- **Stack machine**: Dialog, Menu, and Popover share a `stackMachines` singleton for proper z-ordering of nested overlays.
- **Floating UI integration**: Menu and Popover use `@floating-ui/dom` v1.7.6 for robust positioned panels with collision detection.
- **Transition system**: RAF-based `data-enter` / `data-leave` / `data-closed` attributes enable pure CSS transitions. Uses `CSSTransition` via `getAnimations()` API.
- **Full WAI-ARIA support**: Focus trapping, scroll locking, inert tree handling, `aria-labelledby`, `aria-describedby`, `aria-expanded`, `aria-selected`.
- **Comprehensive tests**: 27 test files (18 component test files + 9 internal utility test files) covering all component families plus internal utilities.

### 1.3 Dependencies

- `@floating-ui/dom` v1.7.6 (latest)
- `preact` v10.29.0 (latest in 10.x)
- Dev: `tailwindcss` v4.2.2, `vitest` v4.1.2

---

## 2. Tailwind Application UI v4 Reference Overview

The reference contains **364 JSX example files** across **11 categories**:

| Category | Subcategories | Files |
|---|---|---|
| application-shells | multi-column, sidebar, stacked | 23 |
| data-display | calendars, description-lists, stats | 19 |
| elements | avatars, badges, button-groups, buttons, dropdowns | 45 |
| feedback | alerts, empty-states | 12 |
| forms | action-panels, checkboxes, comboboxes, form-layouts, input-groups, radio-groups, select-menus, sign-in-forms, textareas, toggles | 74 |
| headings | card-headings, page-headings, section-headings | 25 |
| layout | cards, containers, dividers, list-containers, media-objects | 38 |
| lists | feeds, grid-lists, stacked-lists, tables | 44 |
| navigation | breadcrumbs, command-palettes, navbars, pagination, progress-bars, sidebar-navigation, tabs, vertical-navigation | 54 |
| overlays | drawers, modal-dialogs, notifications | 24 |
| page-examples | detail-screens, home-screens, settings-screens | 6 |

The reference uses `@headlessui/react` for interactive patterns -- the React equivalent of @hyperneo/ui's headless approach. The `data-*` attribute patterns match exactly: `data-enter`, `data-leave`, `data-closed`, `data-focus`, `data-hover`, `data-selected`.

---

## 3. Gap Analysis: New Components to Add

### 3.1 Alert (6 reference examples, 1 new component family)

**Reference files:** `feedback/alerts/01-with-description` through `06-with-dismiss-button`

**Why a headless primitive:** Alerts need `role="alert"`, dismissible state management, and an icon slot -- these go beyond plain HTML.

**Headless approach:** Alert is a state-management + ARIA primitive. Props like `variant` and `style` are **semantic configuration**, not styling — they control which ARIA semantics and data attributes are emitted. The component does not apply any Tailwind classes. Consumers use `data-variant="success"` and `data-style="outline"` to style via Tailwind selectors.

**Props API:**

```typescript
// <Alert>
interface AlertProps {
  variant?: 'info' | 'success' | 'warning' | 'error'  // default: 'info'
  style?: 'soft' | 'outline'                           // default: 'soft'
  dismissible?: boolean                                // renders CloseButton
  open?: boolean                                       // controlled
  defaultOpen?: boolean                                // uncontrolled (default: true)
  onClose?: () => void
  icon?: ComponentChildren                              // custom icon element
  as?: ElementType
  children?: ComponentChildren
}

// Sub-components: AlertTitle, AlertDescription, AlertActions
// Dismiss uses existing CloseButton from dialog module
```

**ARIA requirements:**
- Root: `role="alert"` (implicit `aria-live="assertive"`)
- Icon: `aria-hidden="true"`
- Dismiss button: sr-only "Dismiss" label

**Data attributes:** `data-variant`, `data-style`, `data-dismissible`, `data-open`/`data-closed`

**Preact implementation notes:**
- Use existing `useOpenClosed()` internal hook (same pattern as Dialog/Menu)
- Compose with existing `CloseButton` for dismiss functionality
- Render-prop children for maximum flexibility

---

### 3.2 Avatar (11 reference examples, 1 new component family)

**Reference files:** `elements/avatars/01-circular` through `11-with-text`

**Why a headless primitive:** Avatars need image load/error state tracking, fallback chain (image → initials → placeholder icon), and status indicators -- these require state management.

**Headless approach:** Avatar is a state-management primitive for image loading and fallback rendering. Props like `size`, `shape`, and `status` are **semantic configuration** — they control which data attributes are emitted and which fallback is rendered. The component does not apply any Tailwind classes. Consumers use `data-size="md"`, `data-shape="circle"`, `data-status="online"` to style via Tailwind selectors.

**Props API:**

```typescript
// <Avatar>
interface AvatarProps {
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl'  // default: 'md'
  shape?: 'circle' | 'rounded'                        // default: 'circle'
  src?: string
  alt?: string                                          // default: ''
  initials?: string                                     // e.g. "TW"
  fallbackIcon?: ComponentChildren
  status?: 'online' | 'offline' | 'busy' | 'away'
  statusPosition?: 'top-right' | 'bottom-right'        // default: 'top-right'
  onError?: () => void
  as?: ElementType
  children?: ComponentChildren
}

// Size mapping: xs=24px, sm=32px, md=40px, lg=48px, xl=56px, 2xl=64px
```

**ARIA requirements:**
- `<img>`: consumer-provided `alt` text
- Status indicator dot: `aria-hidden="true"`
- Placeholder icon: `aria-hidden="true"`

**Data attributes:** `data-size`, `data-shape`, `data-loaded`, `data-errored`, `data-status`, `data-status-position`

**Preact implementation notes:**
- Track `loaded`/`errored` state via `useState` with `onLoad`/`onError` on `<img>`
- Fallback chain: `src` → `initials` → `fallbackIcon` → default user silhouette
- Status indicator is a positioned `<span>` with a ring/outline visual treatment (styled via `data-status` attribute)

---

### 3.3 AvatarGroup (2 reference examples, part of Avatar family)

**Props API:**

```typescript
// <AvatarGroup>
interface AvatarGroupProps {
  max?: number                                        // overflow threshold
  stack?: 'bottom-to-top' | 'top-to-bottom'          // default: 'bottom-to-top'
  spacing?: 'tight' | 'normal'                        // default: 'normal'
  'aria-label'?: string                               // e.g. "Team members: 5 people"
  as?: ElementType
  children?: ComponentChildren
}

// <AvatarGroupOverflow> — renders "+N" indicator
interface AvatarGroupOverflowProps {
  count: number
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl'
  shape?: 'circle' | 'rounded'
}
```

**Data attributes:** `data-stack`, `data-spacing`, `data-overflow`

**Preact implementation notes:**
- Top-to-bottom stacking uses `isolate` on container + descending `z-N` values
- Bottom-to-top uses negative `-space-x-N` with DOM order determining paint order
- Count `Avatar` children vs `max`, render `AvatarGroupOverflow` for remainder

---

### 3.4 Badge (16 reference examples, 1 new component family)

**Why a headless primitive:** Badges need removable state, dot indicators, and multiple variant axes -- these benefit from a structured API.

**Headless approach:** Badge is a state-management primitive for the remove action and dot indicator rendering. Props like `color`, `shape`, `fill`, and `size` are **semantic configuration** — they control which data attributes are emitted. The component does not apply any Tailwind classes. Consumers use `data-color="red"`, `data-shape="pill"`, `data-fill="flat"`, `data-size="small"` to style via Tailwind selectors.

**Props API:**

```typescript
interface BadgeProps {
  color?: 'gray' | 'red' | 'yellow' | 'green' | 'blue' | 'indigo' | 'purple' | 'pink'
  shape?: 'rounded' | 'pill'                         // default: 'rounded'
  fill?: 'filled' | 'flat'                            // default: 'filled'
  size?: 'default' | 'small'                          // default: 'default'
  dot?: boolean                                       // colored dot indicator
  dotColor?: string                                   // independent dot color (for flat variant)
  removable?: boolean
  onRemove?: () => void
  as?: ElementType                                     // default: 'span'
  children?: ComponentChildren
}
```

**ARIA requirements:**
- Dot SVG: `aria-hidden="true"`
- Remove button: sr-only "Remove" text via `<span class="sr-only">`

**Data attributes:** `data-color`, `data-shape`, `data-fill`, `data-size`, `data-dot`, `data-removable`

**Preact implementation notes:**
- Remove button uses existing `DataInteractive` pattern for hover/focus tracking
- Hit area expansion via nested `<span class="absolute -inset-1" />`
- Four independent variant axes (color × shape × fill × size) + optional dot/removable

---

### 3.5 Progress (1 reference example + 7 stepper examples, 1 new component family)

The reference has two distinct patterns under "progress-bars":

#### 3.5a. ProgressBar (1 example — determinate bar)

**Props API:**

```typescript
interface ProgressBarProps {
  value: number           // 0-100
  min?: number            // default: 0
  max?: number            // default: 100
  label?: string          // accessible label
  as?: ElementType        // default: 'div'
  children?: ComponentChildren
}
```

**ARIA requirements:** `role="progressbar"`, `aria-valuenow`, `aria-valuemin`, `aria-valuemax`, `aria-label`

**Data attributes:** `data-progress`

**Preact implementation notes:**
- Simple value-clamping wrapper around a track/indicator slot pattern
- No animation needed — the reference uses static `style={{ width: '37.5%' }}`
- The `label` prop sets `aria-label` (and optionally renders an `sr-only` heading)

#### 3.5b. Stepper (7 examples — multi-step indicator)

**Controlled approach:** Stepper uses a controlled `currentStep` prop rather than internal state management. This follows the same pattern as `TabGroup` (which uses `selectedIndex`), keeping the state owner outside the component. The component derives each step's status from the `currentStep` index comparison and renders accordingly. This is simpler than a compound component with internal state and makes it easy to wire to external routing or form state.

**Props API:**

```typescript
interface Step {
  id?: string
  name: string
  href?: string
  description?: string
}

// <Stepper>
interface StepperProps {
  steps: Step[]
  currentStep: number           // zero-based index
  orientation?: 'horizontal' | 'vertical'
  as?: ElementType              // default: 'nav'
  children?: ComponentChildren
}

// <StepperStep> — per-step renderer
interface StepperStepProps {
  step: Step
  index: number
  isCurrent: boolean
  isComplete: boolean
  as?: ElementType
  children?: ComponentChildren
}
```

**ARIA requirements:**
- Root: `<nav aria-label="Progress">`
- List: `<ol role="list">`
- Current step: `aria-current="step"`
- Decorative elements: `aria-hidden="true"`

**Data attributes:** `data-step-status="complete|current|upcoming"`, `data-step-orientation`

**Preact implementation notes:**
- Derive each step's status from `currentStep` index comparison
- Connector elements are purely visual (CSS borders/lines between steps)
- Responsive layouts: horizontal on `md:`, vertical on mobile (per reference pattern)

---

## 4. Gap Analysis: Existing Components to Improve

### 4.1 Toast — Add Variant Types (HIGH)

**Current API:** `ToastOptions { id?, title?, description?, duration? }` — no variant support.

**What the reference does (6 notification examples):**
- Typed variants: `success` (green + checkmark), `error` (red + X), `warning` (yellow + triangle), `info` (blue + info circle)
- Icon slot before title
- Progress bar showing remaining duration

**Changes needed:**

| Change | Details | Backward-Compatible? |
|---|---|---|
| Add `variant` to `ToastOptions` | `'info' \| 'success' \| 'warning' \| 'error'`, default `'info'` | Yes |
| Add `icon` to `ToastOptions` | `ComponentChildren` — consumer provides variant-appropriate icon | Yes |
| Add `ToastProgress` component | Renders CSS-animated bar using remaining duration | Yes (new component) |
| Update `Toaster` auto-render | Conditionally render icon when provided in options | Yes |

**Data attributes to add:** `data-variant="info|success|warning|error"` on `Toast`

---

### 4.2 Field — Add Input Group Support (MEDIUM)

**Current API:** `Field` is a context provider. It already emits `data-disabled` via the `render()` utility's automatic slot-to-data-attribute translation (slot `{ disabled: isDisabled }` → `data-disabled` attribute on DOM).

**What the reference does (21 input-group examples):**
- Inputs with leading/trailing add-ons (`$` prefix, `.00` suffix)
- Icon add-ons (search magnifying glass, envelope)
- Button add-ons (search button appended to input)

**Changes needed:**

| Change | Details | Backward-Compatible? |
|---|---|---|
| Add `InputGroup` component | Wrapper providing group-level focus/hover state propagation | Yes (new component) |
| Add `InputAddon` component | Renders add-on content (text, icon, or button) | Yes (new component) |
| Add `FieldError` component | Error text variant with `role="alert"`, sets `aria-invalid` on input | Yes (new component) |

**Data attributes to add:** `data-focus`/`data-hover` on `InputGroup` (via slot boolean → `data-*` auto-translation)

---

### 4.3 Input — Verify Data Attributes (MEDIUM)

**Current API:** Slot object contains `{ disabled, invalid, hover, focus, autofocus }`. The `render()` utility in `internal/render.ts` automatically generates `data-*` attributes from truthy boolean slot values (lines 25-30: iterates slot, emits `data-{key}` for each truthy boolean). This means `data-hover`, `data-focus`, `data-disabled`, `data-invalid` should already be emitted on the DOM element.

**Changes needed:**

| Change | Details | Backward-Compatible? |
|---|---|---|
| Verify `data-*` emission with a unit test | Confirm `render()` translates Input/Textarea/Select slot booleans to DOM attributes | N/A (verification) |
| Document the behavior | Ensure the data attribute contract is clear for consumers | N/A |

---

### 4.4 Menu — Improve Section Accessibility (MEDIUM)

**Current API:** `MenuSection` renders as bare `<div>` with no ARIA attributes. `MenuHeading` has no `id`.

**Changes needed:**

| Change | Details | Backward-Compatible? |
|---|---|---|
| Add `role="group"` to `MenuSection` | Required by WAI-ARIA menu pattern | Yes |
| Add `aria-labelledby` to `MenuSection` | Must reference `MenuHeading` id | Yes |
| Generate `id` on `MenuHeading` | So `MenuSection` can reference it | Yes |

---

### 4.5 Button — Add ButtonGroup (LOW)

**Current API:** No `ButtonGroup` export. Button groups are a purely visual pattern (12 reference examples) — shared borders, no border-radius on interior sides.

**Changes needed:**

| Change | Details | Backward-Compatible? |
|---|---|---|
| Add `ButtonGroup` component | Renders `<div role="group">` with group-level data attributes | Yes (new component) |

---

### 4.6 Tooltip — No Changes Needed

Tooltip already supports configurable `showDelay` (default 500ms) and `hideDelay` (default 0ms). No gaps found relative to the reference.

---

## 5. Composable Patterns (No New Primitives)

These patterns from the reference can be built entirely from existing @hyperneo/ui primitives. They need **convenience wrappers or demo examples**, not new headless components.

### 5.1 Command Palette (9 reference examples)

**Composition:** `Dialog` + `Combobox`

The reference nests a `Combobox` inside a `DialogPanel` with these key settings:
- `ComboboxOptions` uses `static` prop (Dialog handles mount/unmount)
- `ComboboxInput` uses `autoFocus`
- `Dialog.onClose` resets both open state and query state
- Grouped results via `reduce()` on a `category` field
- Footer with keyboard shortcut hints via `<kbd>` elements
- Empty state when no results match

**@hyperneo/ui readiness:** All required primitives exist. No new code needed in `packages/ui` — this is a consumer-side composition pattern. A demo example in the @hyperneo/ui demo app would be valuable.

### 5.2 Drawer / Slide-over (9 reference examples)

**Composition:** `Dialog` + `DialogPanel` with slide-in transition

The reference uses this exact CSS transition on `DialogPanel`:
```css
transition duration-500 ease-in-out data-closed:translate-x-full sm:duration-700
```

Variants: overlay vs. no overlay, sizes (`max-w-md` through `max-w-2xl`), branded header, sticky footer.

**@hyperneo/ui readiness:** All required primitives exist. The `Transition` system already provides `data-closed` / `data-enter` / `data-leave` attributes. A demo example is all that's needed. However, a thin `DrawerPanel` convenience wrapper could provide the correct default CSS class structure and size presets.

**One gap:** `TransitionChild` (for animating arbitrary children within a transitioning component, e.g., the outside close button in drawer file 03) exists in the source but is **not exported from `mod.ts`**. Exporting it would enable more complex composition patterns.

### 5.3 Notification with Typed Variants (6 reference examples)

**Composition:** `Toast` + `ToastAction` + variant styling

Requires R1 (Toast variant types) first. After that, styled notifications are a consumer-side pattern using `data-variant` for variant-specific styling.

---

## 6. Cross-Cutting Improvements

### 6.1 Export TransitionChild (LOW)

`TransitionChild` exists in `packages/ui/src/components/transition/transition.tsx` (line 849) but is **not re-exported from `mod.ts`**. Only `Transition` is exported. Exporting `TransitionChild` enables:
- Animating arbitrary children within a transitioning parent (e.g., drawer close button)
- More complex composition patterns like the reference's drawer with outside close button

**Change:** Add `export { Transition, TransitionChild }` to `mod.ts` line 60.

### 6.2 Adopt TouchTarget Pattern (LOW)

The Catalyst UI Kit demonstrates a `TouchTarget` component that expands hit areas to 44x44px minimum on touch devices (WCAG 2.2 Success Criterion 2.5.8). This is a single `<span>` with `absolute inset-0` and `pointer-fine:hidden`.

**Implementation:** ~10 lines of code, zero dependencies. Wrap inside `Button` and `IconButton` by default.

---

## 7. Recommendations

> **Note:** Effort estimates use "sessions" = one focused AGI coding session (~2-4 hours of agent work). Actual calendar time may vary.

### HIGH IMPACT

#### R1. Add Toast Variant Types

**Why:** 6 reference notification examples all use typed variants. Current Toast has no variant support.

**Task breakdown:**

| # | Task | Acceptance Criteria |
|---|---|---|
| 1.1 | Add `variant` field to `ToastOptions`: `'info' \| 'success' \| 'warning' \| 'error'` | Type added. Default `'info'`. `data-variant` emitted on Toast DOM. Backward-compatible. |
| 1.2 | Add `icon` field to `ToastOptions` | Optional `ComponentChildren`. Rendered before title when provided. Backward-compatible. |
| 1.3 | Add `ToastProgress` component | CSS-animated bar showing remaining duration. Controlled via `showProgress` in `ToastOptions`. |
| 1.4 | Update `Toaster` auto-render | Conditionally render icon when provided. No visual changes for existing consumers. |
| 1.5 | Add unit tests | Tests cover: variant rendering, icon slot, progress bar, backward compatibility. |

**Estimated effort:** 1 session.

---

#### R2. Add New Headless Components

**Why:** 6 component families in the reference provide interactive patterns that need state management or ARIA behavior beyond plain HTML.

**Task breakdown:**

| # | Task | Acceptance Criteria |
|---|---|---|
| 2.1 | Implement `Alert` + `AlertTitle` + `AlertDescription` + `AlertActions` | Compound component pattern. `role="alert"`, dismissible state, `variant`/`style` props. Data attributes for styling. Unit tests. |
| 2.2 | Implement `Avatar` + `AvatarGroup` + `AvatarGroupOverflow` | Image load/error state, fallback chain, status indicators, group stacking with overflow count. Data attributes. Unit tests. |
| 2.3 | Implement `Badge` | Four variant axes (color × shape × fill × size), dot indicator, removable state. Data attributes. Unit tests. |
| 2.4 | Implement `ProgressBar` | `role="progressbar"`, `value`/`max`/`min`, `aria-valuenow`/`aria-valuemin`/`aria-valuemax`. Data attributes. Unit tests. |
| 2.5 | Implement `Stepper` + `StepperStep` | Multi-step state, `aria-current="step"`, connector rendering, horizontal/vertical orientation. Data attributes. Unit tests. |
| 2.6 | Export all new components from `mod.ts` | Clean barrel exports. Knip reports no dead exports. |

**Estimated effort:** 3-4 sessions.

---

### MEDIUM IMPACT

#### R3. Improve Existing Component APIs

**Why:** Several existing components have accessibility gaps or missing features compared to the reference.

**Task breakdown:**

| # | Task | Acceptance Criteria |
|---|---|---|
| 3.1 | Add `InputGroup` + `InputAddon` to Field family | New components. `InputGroup` propagates focus/hover to wrapper. `InputAddon` renders add-on content. Unit tests. |
| 3.2 | Add `FieldError` component | Error text variant with `role="alert"`. Sets `aria-invalid` on associated input via Field context. Unit tests. |
| 3.3 | Fix `MenuSection` ARIA: add `role="group"` + `aria-labelledby` | `MenuSection` emits `role="group"` and `aria-labelledby` pointing to `MenuHeading` id. `MenuHeading` generates an id. Unit tests verify ARIA attributes. |
| 3.4 | Verify `data-*` emission on Input, Button, MenuItem | Confirm `render()` utility translates slot booleans to `data-hover`, `data-focus`, `data-disabled`, `data-invalid` on DOM. Add a unit test if none exists. |

**Estimated effort:** 2 sessions.

---

#### R4. Add ButtonGroup

**Why:** Button groups are a pervasive visual pattern (12 reference examples). No new headless behavior needed — just a structural wrapper.

**Note:** `CloseButton` already guards against missing context (`if (close) close()` at line 103 of `button.tsx`). No fix needed.

**Task breakdown:**

| # | Task | Acceptance Criteria |
|---|---|---|
| 4.1 | Add `ButtonGroup` component | Renders `<div role="group">`. Group-level data attributes. Unit tests. |

**Estimated effort:** 1 session.

---

### LOW IMPACT

#### R5. Export TransitionChild + Add TouchTarget

**Why:** `TransitionChild` enables complex composition patterns (drawer close button animation). TouchTarget improves accessibility per WCAG 2.2.

**Task breakdown:**

| # | Task | Acceptance Criteria |
|---|---|---|
| 5.1 | Export `TransitionChild` from `mod.ts` | Add to existing `Transition` export statement. Knip confirms export is used. |
| 5.2 | Add `TouchTarget` component | `<span>` with `absolute inset-0` + `pointer-fine:hidden`. Exported from `mod.ts`. Unit test. |

**Estimated effort:** Minimal (< 1 session).

---

#### R6. Create Demo Examples for Composable Patterns

**Why:** Command Palette, Drawer, and typed Notifications demonstrate the power of composing existing @hyperneo/ui primitives.

**Task breakdown:**

| # | Task | Acceptance Criteria |
|---|---|---|
| 6.1 | Create Command Palette demo in @hyperneo/ui demo app | `Dialog` + `Combobox` composition. Search filtering, grouped results, footer. |
| 6.2 | Create Drawer demo in @hyperneo/ui demo app | `Dialog` + `DialogPanel` with `data-closed:translate-x-full` transition. Overlay and inline variants. |
| 6.3 | Create typed Notification demo | `Toast` with variant styling from R1. |

**Estimated effort:** 1 session. Depends on R1 for task 6.3.

---

### Execution Order and Dependencies

```
R1 (Toast variants) ── R6.3 (Notification demo)
                     ── R3 (Improve existing APIs)
                     ── R4 (ButtonGroup)

R2 (New components: Alert, Avatar, Badge, Progress, Stepper)  [independent]

R5 (TransitionChild export + TouchTarget)                     [independent]

R6.1 (Command Palette demo)                                   [independent]
R6.2 (Drawer demo)          ── depends on R5 (TransitionChild)
```

R1, R2, R4, R5, R6.1 can all run in parallel. R3 should run after R1 (Toast variants establish the pattern for other variant additions). R6.2 depends on R5 (needs `TransitionChild`). R6.3 depends on R1.

---

## 8. Appendix: Component Comparison Matrix

### @hyperneo/ui vs Tailwind v4 Reference vs Catalyst UI Kit

| Pattern | @hyperneo/ui | Tailwind v4 Reference | Catalyst | Action Needed |
|---|---|---|---|---|
| Button | Headless | 12 examples | Styled | Add ButtonGroup (R4) |
| CloseButton | Headless | (part of Dialog) | (part of Dialog) | — |
| Checkbox | Headless | 6 examples | Styled | — |
| Combobox | Headless | 8 examples | Styled | — |
| Dialog | Headless (full-featured) | 15 examples | Styled | — |
| Disclosure | Headless | None | None | — |
| Field/Label | Headless | (part of forms) | Fieldset | Add InputGroup, FieldError (R3) |
| Input/Textarea/Select | Headless (native HTML) | 74 examples total | Styled | Verify data-* emission (R3) |
| Listbox | Headless | None | Styled | — |
| Menu | Headless + @floating-ui | 9 dropdown examples | Dropdown | Fix MenuSection ARIA (R3) |
| Popover | Headless + @floating-ui | None | None | — |
| Tooltip | Headless + @floating-ui | None | None | — |
| RadioGroup | Headless | 5 examples | Styled | — |
| Switch | Headless | 6 examples | Styled | — |
| Tabs | Headless | 4 examples | None | — |
| Transition | Headless (CSSTransition) | (used throughout) | (used throughout) | Export TransitionChild (R5) |
| TransitionChild | Internal only | N/A | N/A | Export from mod.ts (R5) |
| Toast | Headless + Toaster | 6 examples | None | Add variants, icon, progress (R1) |
| IconButton | Headless | None | None | — |
| Skeleton | Headless | None | None | — |
| Spinner | Headless | None | None | — |
| Avatar | **Missing** | 11 examples | Styled | Add (R2) |
| AvatarGroup | **Missing** | 2 examples | None | Add (R2) |
| Badge | **Missing** | 16 examples | Styled | Add (R2) |
| Alert | **Missing** | 6 examples | Styled | Add (R2) |
| Progress | **Missing** | 1 example | None | Add (R2) |
| Stepper | **Missing** | 7 examples | None | Add (R2) |
| Command Palette | **Missing** (composable) | 9 examples | None | Demo example (R6) |
| Drawer | **Missing** (composable) | 9 examples | None | Demo example (R6) |
| ButtonGroup | **Missing** | 12 examples | None | Add (R4) |
| TouchTarget | **Missing** | None | Styled | Add (R5) |
| Table | N/A (HTML) | 19 examples | Styled | — |
| Description List | N/A (HTML) | 8 examples | Styled | — |
| Divider | N/A (HTML) | 8 examples | Styled | — |
| Pagination | N/A (HTML) | 3 examples | Styled | — |
| Breadcrumb | N/A (HTML) | 6 examples | None | — |
| App Shell | N/A (CSS) | 23 examples | SidebarLayout | — |

### Data Attribute Coverage

| Attribute | @hyperneo/ui | Headless UI v2 Reference | Notes |
|---|---|---|---|
| `data-hover` | Yes | Yes | |
| `data-focus` | Yes | Yes | |
| `data-active` | Yes | Yes | |
| `data-open` | Yes | Yes | |
| `data-closed` | Yes | Yes | |
| `data-disabled` | Yes | Yes | |
| `data-selected` | Yes | Yes | |
| `data-enter` | Yes | Yes | |
| `data-leave` | Yes | Yes | |
| `data-transition` | Yes (custom) | Not in current docs | @hyperneo/ui convenience attribute not in Headless UI v2.2.x |
