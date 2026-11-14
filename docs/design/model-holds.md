# Model holds

When a session's model cannot run because the human has to act (sign in again) or because time has to pass (usage limit, overload, no network), the session holds its work, the human sees why in the message area on every client, and the session continues by itself once the cause is gone.

## Problem

- **A rejected login counts as a failure.** A 401 from the Claude login goes through the ordinary retry route (`claude_auth_retry` in `query-runner.ts`), which restarts the query with the same token and never asks for a refresh. The thrown error is charged to the query failure episode before routing; the third charged failure latches the episode and clears the queue (`messageQueue.clear`). The latch blocks admission until its `retryAt`, and the stopped notice says "Send a message to recover".
- **Overload is charged the same way.** A 529 or 503 is routed to `provider_backoff`, which retries a bounded number of times, but each attempt was already charged, so repeated overload can also latch "stopped".
- **Signing in again wakes nothing.** A successful login or refresh reloads the provider's models (`recoverDormantProvider`). No code resumes the sessions that stopped.
- **The refresh outcome is lost.** `refreshClaudeSubscriptionToken` already tells a definitive refusal from a transient failure, but `refreshToken()` returns a boolean and `OAuthRefreshScheduler.refreshNow` returns `void`, also for skips. The scheduler stops automatic attempts after three failures of the same credential (a forced refresh bypasses the cap), logs nothing, and only marks the provider unhealthy on the settings page.
- **The human cannot see it.** The session page can show a banner at the bottom, depending on its suppression rules; the stopped-error card only folds errors that carry a matching result. The Neo page and the phone know only "no network" and "waiting for the model". Neo cannot report a login failure itself because Neo runs on the same login.

## Existing pieces

- `NetworkOutagePause` holds the turn in `rate_limit_cooldown` with `reason: 'network'`, keeps the prompt (serialized as `heldPrompt`), probes, and resumes when the provider answers. After a restart, `armPersistedRateLimitCooldown` restarts it from the persisted state, and the startup pending-message replay is skipped while it is active.
- `RateLimitWatchdog` holds the turn until a usage limit's `retryAt` and resumes it. After repeated startup failures it keeps the pause with a manual Retry.
- `provider_backoff` in `query-runner.ts` retries provider errors with a bounded delay.
- Session notices on the Neo session already reach the phone as alerts.

## Design

1. **A typed refresh outcome.** `Provider.refreshToken()` returns `'refreshed' | 'transient' | 'definitive'`. The Claude provider maps the existing `definitive` flag; a thrown error is `transient`. `refreshNow` returns the same values plus `'skipped'` (no refresh token, not OAuth, or no provider). The scheduler and the session use only this outcome; no caller parses HTTP statuses.
2. **One hold state with a reason.** `rate_limit_cooldown.reason` becomes `'network' | 'login' | 'limit' | 'overloaded'`. A hold keeps the held prompt and the queue and is never charged to the failure episode, so it cannot latch "stopped". `decideQueryRetry` in `query-retry-routing.ts` classifies the error: its decision gains `hold: 'login' | 'limit' | 'overloaded' | 'network' | 'none'`. It runs before charging, and any hold other than `none` is not charged, as network errors already are not.
3. **The login path is one superpipe pipeline.** `runLoginRecovery` in `login-recovery.ts`, shaped like `human-send-recovery.ts`: read facts, decide with pure functions, effects at the edge.
   - Facts: the provider's health and failure kind, the scheduler's refresh state for it (`nextRefreshAt`, `attempt`, last outcome), and whether this turn already retried after a refresh.
   - `afterRefresh(outcome, retried)`: `refreshed` and not yet retried → retry the turn once; `transient` → mark the provider `unhealthy`, then hold, refresh pending; `definitive`, `skipped`, a second 401 after a refresh, or any 401 from an API key → hold for sign-in and mark the provider `needs_login` (failure kind `credential`).
   - Effects: `refreshNow`, retry, or enter the hold.
4. **One refresh clock per provider, as plain state.** The scheduler keeps `nextRefreshAt` and `attempt` per provider. `refreshNow` refreshes only when `now >= nextRefreshAt`; otherwise it returns the last outcome. Concurrent 401s therefore read the same state and hold, and only the scheduler refreshes. After `transient` it sets `nextRefreshAt` from `refreshDelayMs(attempt)`, 5 minutes doubling up to 1 hour, in the style of `networkProbeDelayMs`.
5. **Resume when the provider is usable again.** `mayResume(provider)` is true when the provider is healthy and has no `credential` failure. A transient refresh leaves the provider `unhealthy` (see 3), so a hold cannot wake on its own outcome. A successful refresh already marks the provider healthy. `storeOAuthTokens` and `storeApiKey` already mark it healthy when they commit; they now also clear its failure record (`clearProviderFailure`), so a sign-in or key write lifts a `credential` failure. `ProviderCredentialManager` then publishes the existing `providers.changed` (some writers, such as credential discovery, do not publish it today). A login hold checks `mayResume` on `providers.changed` and once on entry, then resumes its held prompt and its queue. The Neo front's unanswered inputs are delivered again by its existing catch-up. There is no restore branch for login holds: after a restart, pending messages replay as they do today. If `mayResume` is false the session holds before calling the model; otherwise a 401 goes through the pipeline again, costing at most one request.
6. **Overload has one owner.** `provider_backoff` owns 529 and 503. Its attempts are not charged. When its retries run out it enters an `'overloaded'` hold through the watchdog with `retryAt` 5 minutes ahead, and the watchdog's existing re-arm and manual-retry fallback apply. This is a behavior change and has its own PR. A usage limit is labelled `'limit'`; its timing is unchanged.
7. **The refresh scheduler keeps trying.** Its background refresh uses the same `nextRefreshAt` and `refreshDelayMs` after a `transient` outcome, without a cap, so held sessions and the background refresh share one clock per provider. After `definitive` it stops and marks the provider `needs_login`. Every failure is logged with the outcome and the OAuth error code, never a token.
8. **One line for the human, from the daemon.**
   - `NeoWorkingSession` gets `modelHold?: { provider, reason, since, resetAt? }`, next to its `rate_limit_cooldown` status, and `role?: 'neo' | 'front'`. The Neo session and the front session appear in `working` while they are held, with their role. A client shows the hold from the entries that have a role; when both are held, login comes first, then the Neo session's.
   - `modelHoldLine(modelHold)` derives the text. The web Neo page, the phone and the session page show it as one line in the message area above the composer. For example: "Claude needs you to sign in again · Sign in", "Claude usage limit · resets 11:30", "Can't reach Claude · retrying", "Claude is overloaded · retrying". "Sign in" opens the provider's login.
   - A login hold, and a limit hold longer than 30 minutes, adds a `needs_you` notice on the Neo session once per hold, so the phone gets one alert. The notice clears when the hold ends.
   - The session page no longer shows the bottom banner for these reasons. The stopped-error card stays for real failures.

## Not changed

- The query failure episode for errors that are not holds.
- Network probing and the usage-limit timing.
- Single and dual Neo delivery.

## Out of scope

A busy local machine slows turns but does not stop the model, so it is not a hold. It can be added to the same line later as a separate status.

## Change

Seven PRs, each standing alone. PR 1 comes before PR 2. Each pure decision has its own unit test.

1. Refresh outcome: `refreshToken()` and `refreshNow` return the typed outcome; current callers keep their behavior. Tests: each status class, a thrown error, and a skip.
2. Login hold: `decideQueryRetry` hold classification, the `runLoginRecovery` pipeline with `afterRefresh` and `mayResume`, the scheduler's `nextRefreshAt`/`attempt` with `refreshDelayMs`, and `clearProviderFailure` and `providers.changed` from `ProviderCredentialManager`. Tests: one per pure function; a 401 with a working refresh retries once and answers; a healthy provider that returns 401 and then a transient refresh stays held, without latching and with its queue, until a later refresh succeeds; a credential write over a recorded `credential` failure clears it and wakes the hold; two sessions on one provider cause one refresh; a credential write wakes a held session while a health-only change with a `credential` failure leaves it held; after a restart with the provider `needs_login` the session holds before calling the model; the front re-delivers its pending input.
3. Overload: `provider_backoff` attempts are not charged, and exhaustion enters the `'overloaded'` hold. Tests: repeated 529 never latches "stopped"; exhaustion holds and resumes.
4. Refresh scheduler: background refresh uses the PR 2 `nextRefreshAt` and `refreshDelayMs` (uncapped for `transient`), `needs_login` on `definitive`, failure logs. Tests for each outcome.
5. `NeoWorkingSession.modelHold`, `modelHoldLine` with its unit test, and the line on the web Neo page and the session page. Verify with a mock provider that returns 401 and then accepts a new key.
6. The phone: the same line from `modelHold`.
7. The `needs_you` notice for login and long limit holds, and its clearing.
