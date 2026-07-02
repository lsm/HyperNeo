# Milestone 7: UI -- Mission Creation, Dashboard, and Status

## Milestone Goal

Update all user-facing "Goal" text to "Mission" in the frontend. Add type-specific mission creation form fields (KPI targets for measurable, cron schedule for recurring, autonomy level selector). Update the mission detail view with type-specific displays (metric progress, recurrence indicators, execution history). Update `roomStore` to call the new RPCs.

## Tasks

### Task 7.1: UI Copy Rename -- Goal to Mission Terminology

**Agent**: coder
**Description**: Replace all user-visible "Goal" text with "Mission" in the frontend. No new UI features -- just terminology. Backend event subscriptions and RPC names remain `goal.*`.

**Subtasks** (ordered implementation steps):

1. In `packages/web/src/components/room/GoalsEditor.tsx`:
   - Replace all user-visible text strings: `"Goals"` -> `"Missions"`, `"Create Goal"` -> `"Create Mission"`, `"Delete Goal"` -> `"Delete Mission"`, `"No goals yet"` -> `"No missions yet"`, `"Create your first goal"` -> `"Create your first mission"`, heading `"Goals"` -> `"Missions"`, etc.
   - Keep the component file name and internal signal/function names as-is (rename is UI copy only)
   - Import the `Mission` type alias from `@hyperneo/shared` and use it in place of `RoomGoal` for the public props type where it makes the intent clearer (optional cosmetic improvement)

2. In `packages/web/src/islands/Room.tsx`:
   - Tab label `'goals'` stays as the tab key (internal); the displayed tab label text changes from `"Goals"` to `"Missions"` in the tab bar render

3. In `packages/web/src/components/room/index.ts` (or wherever room components are re-exported):
   - No changes needed (file names stay the same)

4. Search for any remaining "Goal" or "goal" strings in user-visible JSX/text across all web component files and replace appropriately. Use Grep to be thorough. Examples to check: `RoomDashboard.tsx`, `RoomContext.tsx`, `CreateRoomModal.tsx`, `MessageInfoDropdown.tsx`.

5. Write an E2E test update or new test in `packages/e2e/tests/` that verifies the "Missions" label is visible in the room tab bar and the "Create Mission" button text is correct.

**Acceptance Criteria**:
- All user-visible "Goal" text replaced with "Mission" across the web frontend
- Backend event subscriptions still use `goal.*` (no backend changes in this task)
- Existing UI functionality unchanged
- E2E smoke test confirms "Missions" tab and "Create Mission" button are visible
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Depends on**: Milestone 1 (Mission type alias must exist in shared types)

---

### Task 7.2: Mission Creation Form -- Type-Specific Fields

**Agent**: coder
**Description**: Extend the mission creation form (`GoalsEditor.tsx`) with a mission type selector and conditional fields for measurable (KPI targets) and recurring (cron schedule) missions. Add autonomy level selector.

**Subtasks** (ordered implementation steps):

1. Extend `GoalFormProps` in `packages/web/src/components/room/GoalsEditor.tsx` to include `missionType` and `autonomyLevel` initial values in the form.

2. Add a "Mission Type" radio-button or select control to the `GoalForm` component with three options: "One-Shot", "Measurable", "Recurring". Default: "One-Shot".

3. Add conditional field set for **Measurable** missions (shown when type = 'measurable'):
   - A repeating group of metric rows, each with: metric name (text input), target value (number input), unit (text input, optional), direction selector ("increase" / "decrease"), baseline value (number input, required when direction = "decrease")
   - "Add Metric" button to add a new row; "Remove" button per row
   - Client-side validation: non-empty name, positive target for "increase", baseline present and > target for "decrease"

4. Add conditional field set for **Recurring** missions (shown when type = 'recurring'):
   - Schedule preset dropdown: Daily (`@daily`), Weekly (`@weekly`), Hourly (`@hourly`), Custom
   - When "Custom" is selected, show a text input for the cron expression (e.g., `0 9 * * 1-5`)
   - Timezone selector (a `<select>` with a reasonable set of common IANA timezones)
   - Show a human-readable "Next run: ..." preview (calculated client-side if possible, or just display the expression)

5. Add an "Autonomy Level" select control: "Supervised (default)" and "Semi-Autonomous". Include a short description of each option near the control.

6. Update the `onSubmit` call signature to pass `missionType`, `autonomyLevel`, `structuredMetrics` (if measurable), and `schedule` + `schedulePaused` (if recurring) to the parent `onCreateGoal` handler.

7. Update the `CreateGoalParams` local interface in `packages/web/src/lib/room-store.ts` to include the new fields.

8. Update `RoomStore.createGoal` in `room-store.ts` to pass all new fields to the `goal.create` RPC.

9. Update the edit form flow in `GoalItem` to also show the type-specific fields (so existing missions can have their schedule or metrics updated via `goal.update`).

10. Write unit/component tests in `packages/web/src/components/room/GoalsEditor.test.tsx`:
    - Measurable fields appear when type = "measurable"; hidden otherwise
    - Recurring fields appear when type = "recurring"; hidden otherwise
    - Autonomy level selector renders
    - Metric add/remove works
    - Client-side validation blocks submit with invalid metrics (missing baseline for decrease)

**Acceptance Criteria**:
- Mission type selector with three options is present in the create form
- Measurable: metric row add/remove works, client-side validation rejects missing baseline
- Recurring: preset dropdown and custom cron input work, timezone selector present
- Autonomy level selector present with descriptions
- All new field values are passed to `goal.create` RPC
- Existing "one-shot" creation flow is unchanged
- Unit tests for conditional rendering pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Depends on**: Milestone 6 (RPC must accept new fields), Task 7.1 (Mission terminology already renamed)

---

### Task 7.3: Mission Detail View -- Type-Specific Status Displays

**Agent**: coder
**Description**: Update the mission detail view (expanded `GoalItem` and/or a dedicated detail panel) to show type-specific information: KPI progress for measurable missions, execution history and recurrence indicator for recurring missions, and autonomy level badge for all missions.

**Subtasks** (ordered implementation steps):

1. Add a `MissionTypeBadge` component in `GoalsEditor.tsx`:
   - "One-Shot" badge (gray)
   - "Measurable" badge (blue)
   - "Recurring" badge (purple)
   - Shown in the goal item header row alongside the priority badge

2. Add an `AutonomyBadge` component:
   - "Supervised" badge (gray, small, only shown if user has expanded the goal or in detail view)
   - "Semi-Auto" badge (amber, shown prominently when `autonomyLevel = 'semi_autonomous'`)

3. Extend the `GoalItem` expanded content section for **Measurable** missions:
   - If `structuredMetrics` is present, replace or augment the generic progress bar with a per-metric row showing: metric name, current value, target, unit, a mini progress bar capped at 100%
   - Use `goal.update_kpi` RPC (via a new `RoomStore.updateKpi` method) to allow manual KPI updates from the UI for testing purposes (simple input field + button)

4. Extend the `GoalItem` expanded content section for **Recurring** missions:
   - Show "Next run: <formatted date>" from `goal.nextRunAt` (or "Paused" if `schedulePaused = true`)
   - Show "Schedule: <expression> (<timezone>)" from `goal.schedule`
   - Add "Pause schedule" / "Resume schedule" button that calls `goal.update` with `schedulePaused` toggled
   - Show execution history list: fetch via `goal.list_executions` RPC (defined in Milestone 6, Subtask 5). Add a `RoomStore.listExecutions(goalId)` method that calls this RPC and returns `MissionExecution[]`. Display the last 10 executions with status badge (running/completed/failed), start time, and result summary.

5. Add `RoomStore.updateKpi(goalId, metricName, value)` method that calls `goal.update_kpi` RPC and refreshes goals.

6. Add `RoomStore.triggerReplan(goalId, reason?)` method that calls `goal.trigger_replan` RPC.

7. Expose a "Trigger Replan" button in the expanded goal view for goals in `needs_human` status (or any active goal). This manually enqueues replanning.

8. Subscribe to `goal.task.auto_completed` events in `room-store.ts` (alongside other goal events) and show a toast notification: `"Task '<title>' auto-completed by agent (PR: #<number>)"`.

9. Update `packages/web/src/lib/room-store.ts` `CreateGoalParams` interface to match the form's output from Task 7.2 (if not already done there).

10. Write unit/component tests in `GoalsEditor.test.tsx`:
    - Measurable goal shows per-metric rows with progress bars
    - Recurring goal shows "Next run" and schedule display
    - "Pause/Resume" schedule button triggers correct RPC call
    - `MissionTypeBadge` renders correct label for each type
    - `AutonomyBadge` renders "Semi-Auto" amber badge for `semi_autonomous`

**Acceptance Criteria**:
- `MissionTypeBadge` shown in goal item header for all mission types
- Measurable goals display per-metric KPI progress bars
- Recurring goals display next-run time, schedule expression, and pause/resume control
- `AutonomyBadge` shows correct styling for `semi_autonomous`
- `goal.task.auto_completed` event shows a toast notification
- "Trigger Replan" button available for blocked/active goals
- All component tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Depends on**: Milestone 6 (new RPCs must exist), Task 7.1 (Mission terminology), Task 7.2 (creation form)
