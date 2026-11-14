# Model holds

When a session's model cannot run because the human has to act (sign in again) or because time has to pass (usage limit, overload, no network), the session holds its work, the human sees why in the message area on every client, and the session continues by itself once the cause is gone.

## Problem

- **A rejected login counts as a failure.** A 401 from the Claude login goes through the ordinary retry route (`claude_auth_retry` in `query-runner.ts`), which restarts the query with the same token and never asks for a refresh. After three failures the session latches "stopped", clears its queue (`messageQueue.clear`) and waits for a new human message ("Send a message to recover").
- **Signing in again wakes nothing.** A successful login or refresh reloads the provider's models (`recoverDormantProvider`) and re-evaluates context budgets. No code resumes the sessions that stopped. The human has to send another message.
- **The refresh scheduler gives up silently.** `OAuthRefreshScheduler` stops after three failed refreshes of the same credential until the daemon restarts. It does not tell a network error from a revoked token (the HTTP status from `refreshClaudeSubscriptionToken` is dropped), logs nothing, and only marks the provider unhealthy on the settings page.
- **The human cannot see it.** The session page shows a banner at the bottom. The stopped-error card only folds errors whose text is a result JSON, so a login failure still shows the banner. The Neo page and the phone know only "no network" and "waiting for the model". Login needed, usage limit and overload are invisible there, and Neo cannot report it itself because Neo runs on the same failing login.

## Existing pieces

- `NetworkOutagePause` holds the turn in `rate_limit_cooldown` with `reason: 'network'`, keeps the prompt, probes, and resumes the prompt when the provider answers.
- `RateLimitWatchdog` holds the turn until a usage limit's `retryAt` and resumes it.
- `oauthRefreshScheduler.refreshNow(providerId)` forces one refresh.
- Session notices on the Neo session already reach the phone as alerts.

## Design

1. **One hold state with a reason.** `rate_limit_cooldown.reason` becomes `'network' | 'login' | 'limit' | 'overloaded'`. Every hold keeps the held prompt and the queue. A hold never counts toward the query failure episode, so it can never latch "stopped". A login hold has no `retryAt`.
2. **Refresh first, then hold.** On a 401 from an OAuth provider the session calls `refreshNow` once. If the refresh succeeds it retries the turn. If it fails, the session enters a login hold and the provider is marked `needs_login` (provider failure kind `credential`). A rejected API key goes straight to the login hold.
3. **Resume on new credentials.** Storing new credentials for a provider (login, key update, successful refresh) publishes `provider.credentials.changed`. Every session in a login hold on that provider resumes its held prompt and its queue. The Neo front's unanswered inputs are delivered again through the existing catch-up, so nothing the human sent is lost.
4. **Usage limit and overload are labelled, not changed.** The watchdog sets `reason: 'limit'` when the provider reports a usage limit (with its reset time) and `'overloaded'` for 529 or 503. Their timing stays as it is.
5. **The refresh scheduler keeps trying.** After a transient failure (network error, 5xx, 408, 429) it retries with backoff from 5 minutes up to 1 hour, without a cap. It stops only on a definitive refusal (another 4xx) and then marks the provider `needs_login`. Every failure is logged with the HTTP status and the OAuth error code, never the token.
6. **One line for the human, from the daemon.**
   - The Neo snapshot gets `modelHold?: { provider, reason, since, resetAt? }`, taken from the Neo session and the front session. When both are held, login is shown first.
   - The web Neo page, the phone and the session page show it as one line in the message area above the composer, not as a banner. For example: "Claude needs you to sign in again · Sign in", "Claude usage limit · resets 11:30", "Can't reach Claude · retrying", "Claude is overloaded · retrying". "Sign in" opens the provider's login.
   - A login hold, and a limit hold longer than 30 minutes, adds a `needs_you` notice on the Neo session once per hold, so the phone gets one alert. The notice clears when the hold ends.
7. **The session page uses the same line.** The bottom banner is no longer shown for any of these reasons. The stopped-error card is kept for real failures.

## Not changed

- The query failure episode for errors that are not holds.
- Network probing and the usage-limit timing.
- Single and dual Neo delivery.

## Out of scope

A busy local machine slows turns but does not stop the model, so it is not a hold. It can be added to the same line later as a separate status.

## Change

Five PRs, each standing alone:

1. Daemon: hold reasons, refresh-first on 401, login hold, resume on `provider.credentials.changed`. Tests: a 401 with a working refresh retries once and answers; a 401 with a failing refresh holds without latching "stopped" and keeps the queue; a login resumes every session held on that provider and the front re-delivers its pending input.
2. Refresh scheduler: backoff without a cap for transient failures, `needs_login` on a definitive refusal, failure logs. Tests for each status class.
3. Neo snapshot `modelHold`, and the line on the web Neo page and the session page. Verify with a mock provider that returns 401 and then accepts a new key.
4. The phone: the same line from `modelHold`.
5. The `needs_you` notice for login and long limit holds, and its clearing.
