# Plan: Full First-Class Provider Support for anthropic-copilot and anthropic-to-codex-bridge

## Goal

Make `anthropic-copilot` (GitHub Copilot SDK backend) and `anthropic-codex` (Codex app-server backend) fully first-class providers in HyperNeo. Both providers currently work for basic streaming and single-tool round-trips, but have significant gaps in type safety, UI integration, provider routing, parity, testing, and documentation.

## High-Level Approach

1. Fix the shared `Provider` type to include `anthropic-copilot` and `anthropic-codex`, eliminating unsafe `as any` casts throughout the codebase.
2. Add collision-safe provider routing so model IDs shared between providers (e.g., `claude-opus-4.6` used by both Anthropic and anthropic-copilot) are correctly resolved using explicit `providerId`.
3. Update the Web UI (model picker, session status bar, provider settings) to fully support both providers including provider-grouped model display and provider-aware session creation.
4. Close the most impactful parity gaps: multiple tool results, Anthropic-style JSON error envelopes, token usage wiring, and `tool_choice` pass-through.
5. Add comprehensive test coverage: unit tests, online provider test shards, and E2E tests for provider switching flows.
6. Document setup, known limitations, and produce a final parity report.

## Milestones

1. **Shared Type System Updates** -- Widen the `Provider` type union, add `anthropic-copilot` and `anthropic-codex`, update `PROVIDER_LABELS` in web, remove unsafe casts.
2. **Provider Routing Hardening** -- Make `detectProvider` collision-safe, ensure `session.config.provider` is always set and used, fix model-switch-handler type casts.
3. **Web UI Provider Integration** -- Provider-grouped model picker, provider indicators in session status bar, provider-aware session creation, availability indicators.
4. **Codex Bridge Parity Gaps** -- Multiple tool results, JSON error envelopes, token usage wiring, `tool_choice` pass-through.
5. **Copilot Bridge Parity Gaps** -- Token usage accounting, `tool_choice` pass-through, error mapping improvements.
6. **Auth UX and Health/Recovery** -- First-class auth status indicators in chat UI, health-check polling, graceful degradation on provider unavailability.
7. **Test Coverage** -- Unit tests for type changes and routing, online test shard updates, E2E tests for model switching with both providers.
8. **Documentation and Final Report** -- Setup docs, known limitations, final parity report.

## Cross-Milestone Dependencies

- Milestone 1 (types) must complete first -- all other milestones depend on the widened `Provider` type.
- Milestone 2 (routing) depends on Milestone 1 and must complete before Milestone 3 (UI).
- Milestones 4 and 5 (parity gaps) are independent of each other but depend on Milestone 1.
- Milestone 6 (auth UX) depends on Milestones 1-3.
- Milestone 7 (tests) depends on all functional milestones (1-6).
- Milestone 8 (docs) depends on all other milestones.

## Key Sequencing Decisions

- Type system changes go first to unblock all downstream work and avoid accumulating more `as any` casts.
- Parity gap work (Milestones 4-5) can run in parallel with UI work (Milestone 3) since they modify different parts of the codebase.
- Auth UX depends on both routing and UI to be in place.
- Tests run after all functional changes to avoid re-testing.

## Estimated Total Task Count

24 tasks across 8 milestones.
