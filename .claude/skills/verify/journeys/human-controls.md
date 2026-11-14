**The human runs Done, Cancel, Hold, Pause and priority from the step list, and sets the two running limits.**

Use the shared isolated setup in ../SKILL.md: NODE_ENV=test, a fresh run directory,
its own data dir and DB, no provider key. Build packages/web first, then:

```sh
VERIFY_BROWSER=<installed-chromium> NODE_PATH=<playwright-node_modules> VERIFY_MOCK_PORT=<free-port> \
  bash .claude/skills/verify/human-controls.sh "$RUN" <free-port-not-8399>
```

The seed opens one synthetic ask with five steps: one running, four waiting, one marked
High and one Low. A paired headless browser drives the real /neo list at 1280 px:

- each step has a Step actions menu: Mark done, Hold (Pause once started), four
  priority levels with the current one ticked, and Cancel this step;
- Priority: Urgent replaces the Low badge with Urgent; Mark done and Cancel take the
  step out of the open list;
- Pause on the running step and Hold on a waiting one each open one card with the
  reason, Resume or Start, and Remove; Start answers the hold card;
- Settings > Neo shows Running limits 6 and 3 when unset; 4 and 2 survive a reload.

At 390 px the list, menu and limits fit with no horizontal scroll. The readback reads
the run's DB: done, removed, urgent, the pause card open, the hold card answered
with its action applied, and `neo.maxRunningTodos` 4, `maxRunningTodosPerProject` 2.

Evidence: `evidence/*.png`, `human-controls-web.json`, `readback.json`. Resume's
delivery to a worker is not driven here (the seed has no worker); unit tests cover
its planned `neo.todo.continue`.
