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
2. **One hold state with a reason.** `rate_limit_cooldown.reason` becomes `'network' | 'login' | 'limit' | 'overloaded'`. A hold keeps the held prompt and the queue and is never charged to the failure episode, so it cannot latch "stopped". The error is classified before charging, as `isNetworkUnreachableError` already is.
3. **Login: refresh first, then hold.** On a 401 the session records the provider's credential generation (see 5) and calls `refreshNow` at most once for that generation in this turn:
   - `refreshed`: retry the turn once. A second 401 on the new generation is definitive.
   - `transient`: enter a login hold that keeps recovering by itself. The hold calls `refreshNow` again with backoff from 5 minutes up to 1 hour. A forced refresh bypasses the scheduler cap, so this does not depend on the scheduler change.
   - `definitive` or `skipped`, or any 401 from an API key: enter a login hold without a timer and mark the provider `needs_login` (failure kind `credential`).
4. **The login hold is owned and restored like the network pause.** A `LoginHold` next to `NetworkOutagePause` owns the state and stores `{ reason: 'login', providerId, heldPrompt }` with no `retryAt`. `armPersistedRateLimitCooldown` gets a `'login'` branch that restarts the hold with the persisted prompt and provider, instead of restoring as idle. While it is active, the startup replay and the queue do not run. Only the hold's wake and the manual Retry consume the held prompt.
5. **Wake on committed credentials.** `storeApiKey` and `storeOAuthTokens` bump a per-provider generation after the store write commits, then publish the existing `providers.changed`, which every credential store and the scheduler already publish. A login hold handles `providers.changed` by reading its provider's generation and resumes its held prompt, then its queue, when the generation moved. On entry the hold compares the generation it recorded with the current one and resumes at once if it moved, so a login that commits during hold entry is not missed. The Neo front's unanswered inputs are delivered again by its existing catch-up once the session leaves the hold. The hold does not replay them.
6. **Overload has one owner.** `provider_backoff` owns 529 and 503. Its attempts are not charged. When its retries run out it enters an `'overloaded'` hold through the watchdog with `retryAt` 5 minutes ahead, and the watchdog's existing re-arm and manual-retry fallback apply. This is a behavior change and has its own PR. A usage limit is labelled `'limit'`; its timing is unchanged.
7. **The refresh scheduler keeps trying.** After a `transient` outcome it retries with backoff from 5 minutes up to 1 hour, without a cap. After `definitive` it stops and marks the provider `needs_login`. Every failure is logged with the outcome and the OAuth error code, never a token.
8. **One line for the human, from the daemon.**
   - `NeoWorkingSession` gets `modelHold?: { provider, reason, since, resetAt? }`, next to its `rate_limit_cooldown` status. The Neo session and the front session appear in `working` while they are held, with the same field. When both are held, the Neo page shows login first.
   - The web Neo page, the phone and the session page show it as one line in the message area above the composer. For example: "Claude needs you to sign in again · Sign in", "Claude usage limit · resets 11:30", "Can't reach Claude · retrying", "Claude is overloaded · retrying". "Sign in" opens the provider's login.
   - A login hold, and a limit hold longer than 30 minutes, adds a `needs_you` notice on the Neo session once per hold, so the phone gets one alert. The notice clears when the hold ends.
   - The session page no longer shows the bottom banner for these reasons. The stopped-error card stays for real failures.

## Not changed

- The query failure episode for errors that are not holds.
- Network probing and the usage-limit timing.
- Single and dual Neo delivery.

## Out of scope

A busy local machine slows turns but does not stop the model, so it is not a hold. It can be added to the same line later as a separate status.

## Change

Seven PRs, each standing alone. PR 1 comes before PR 2.

1. Refresh outcome: `refreshToken()` and `refreshNow` return the typed outcome; current callers keep their behavior. Tests: each status class, a thrown error, and a skip.
2. Login hold: classification before charging, refresh-first on 401, `LoginHold` with restore, credential generation checked on `providers.changed`. Tests: a 401 with a working refresh retries once and answers; a 401 again after the refresh holds; a transient refresh holds and recovers on the next attempt; a definitive refusal holds without latching and keeps the queue; a restart during a login hold restores it and resumes on login; a credential write racing hold entry resumes; the front re-delivers its pending input.
3. Overload: `provider_backoff` attempts are not charged, and exhaustion enters the `'overloaded'` hold. Tests: repeated 529 never latches "stopped"; exhaustion holds and resumes.
4. Refresh scheduler: uncapped backoff for `transient`, `needs_login` on `definitive`, failure logs. Tests for each outcome.
5. `NeoWorkingSession.modelHold`, and the line on the web Neo page and the session page. Verify with a mock provider that returns 401 and then accepts a new key.
6. The phone: the same line from `modelHold`.
7. The `needs_you` notice for login and long limit holds, and its clearing.
