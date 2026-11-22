# Locked Use unlock safety

Locked Use lets a worker operate the owner's apps while the Mac stays locked to people. The Desktop host starts one signed guardian; the guardian covers every display, asks the installed authorization plugin to approve one unlock of the login screen, and locks again on local input, stop, EOF or idle.

The plugin approves whichever submission arrives while the guardian has armed. It cannot tell a submission the guardian caused from one a person caused: both land in the login window's password field, and the guardian's "proof" is a fixed compile-time string it types there. A person at the keyboard during an armed window — typing part of a password, pressing Return — can be granted an unlock without the owner's credentials, and the login window records it as password-authenticated. This design closes that.

## Property

The only credential-less unlock is a submission whose field content equals a random one-time token held in memory by one armed, live guardian. Every other submission falls to the stock login-window mechanism and requires the owner's full password. This holds across overlapping and back-to-back sessions, owner input during a session, crashes and session end.

## Threat cases and how each closes

1. **Owner input during a session.** Owner keystrokes change the password field. A submission whose content is not the live token is denied by the plugin and falls to `use-login-window-ui`, which validates it as a password; a partial password fails and the field clears. The fixed sentinel is gone. The guardian's own attempt sets the whole field value (replacing anything a person typed) to the token, presses Return, and only that content matches.
2. **Grant in flight when the guardian ends.** After the plugin's ask is answered, the guardian holds a *pending grant* state and defers every end path — local input, stop, EOF, idle, session switch — until it observes either the screen unlocked, then relocks and waits for locked before exiting as today, or a short deadline passes with no unlock, meaning the grant was consumed or denied and exiting locked is safe. The guardian never exits between approving and observing the outcome.
3. **Overlapping guardians.** The Desktop Locked Use task already refuses a second guardian while one owns the Mac. The guardian adds its own gate: before binding its socket it connects to the well-known path, and a live answering guardian makes it refuse (`ended already_running`). Each guardian's token is per-process, so even a mis-launched pair cannot approve each other's submissions.
4. **Back-to-back sessions.** A later guardian's submissions follow the same token rule; the owner typing during its start ends it (case 1) and any in-flight grant settles first (case 2).
5. **Guardian crash while unlocked.** The Desktop host owns the relock backstop today: on an unclean guardian exit after covering it requests an immediate lock and retries until the system reports locked. Unchanged; tested by killing the guardian.
6. **Desktop crash during a session.** The guardian's stdin closes, so it relocks, waits for locked, and exits. Unchanged.
7. **Stale installed plugin.** A plugin predating the token protocol still approves any armed ask. The guardian reads the installed bundle's `CFBundleVersion` and refuses to start (`ended plugin_outdated`) until the installer replaces it. Locked Use fails closed on old installs.

A process already running as the console user is outside this design: it can do what the owner's session can do. The plugin still answers only the code-signed guardian.

## Changes

**Guardian** (`packages/desktop/locked-use/guardian.m`):

- Draw a 256-bit token per process with `SecRandomCopyBytes`; keep it in memory only. Before each attempt, set the field to the token, press Return, then discard it and draw a fresh one for the next attempt.
- The socket ask now carries the submitted secret; grant only on exact match with the live token while armed and not ending. Any ask still disarms (one-shot).
- Pending-grant state that defers exit until the unlock is observed or times out.
- `already_running` start gate on the socket path.

**Plugin** (`packages/desktop/locked-use/plugin.c`):

- Read the submitted secret from the mechanism context — the password hint the login window passes to mechanisms — and include it in the ask to the guardian. A mismatch or a missing hint denies. The existing checks (console user, matching euid, code-signed `io.hyperneo.locked-use` guardian answering within one second) are unchanged.

**Authorization rule**: no change in shape. `system.login.screensaver` keeps the same "any one of" policy with the login-window and OpenAI alternatives, as the installer already accepts them (#11527). The right `io.hyperneo.locked-use.unlock` keeps its single privileged mechanism. All safety moves into what the mechanism decides, not what the rule lists.

**Installer** (`install.sh`, `policy.sh`):

- Bump the plugin's `CFBundleVersion`. The "already installed" fast path additionally requires the installed bundle's version to equal the shipped one; an older verified bundle is upgraded in place — replace the bundle, re-verify the signature and tree, leave the rule and its backup untouched because the rule shape is unchanged.
- Uninstall is unchanged.

## Testing on a real signed build, owner present

Headless first, extending the existing checks: `check-plugin.sh` gains no-secret-deny, wrong-secret-deny, matching-secret-allow and hangup-deny; `check-guardian.sh` gains the outdated-plugin refusal, pending-grant deferral and `already_running` gate; `check-policy.sh`/`check-install.sh` gain the upgrade-in-place fixture proving the OpenAI-plus-login-window rule reads back identical.

Then attended, on a Developer-ID signed build, one case at a time, with `log show --predicate 'subsystem == "io.hyperneo.locked-use"'` as evidence:

1. Upgrade-install over the pre-token plugin; the rule array is unchanged and the OpenAI alternative is intact.
2. Start Locked Use, lock the Mac; the cover appears and the Mac unlocks behind it. This proves the mechanism can read the submitted secret — the design's one platform dependency. If macOS does not expose the hint, this design does not ship and the fallback is keeping Locked Use disabled.
3. With a guardian running and the screen locked, type a partial password and press Return: the Mac stays locked and the plugin logs a denial. This is the original failure replayed and gates everything else.
4. Full password with no guardian running: normal unlock works.
5. Touch the keyboard while covered: the Mac locks at once (`ended local_input`) and any grant in flight settles first.
6. `kill -9` the guardian while covered: the Desktop host relocks.
7. End a session by touching input and immediately start another while still typing: the Mac stays locked to the person.
8. Uninstall restores the exact original rule (empty diff).

The implementing PR extends `.claude/skills/verify/journeys/locked-use-plugin.md` with the token cases and this attended sequence.

## Rejected alternative

Tighten the timing instead of the content: shrink the armed window, disarm on the first input event, answer only within milliseconds of the guardian's own press. Rejected because the grant is decided in authorizationd after the press, outside the guardian's control, and the guardian cannot observe who pressed Return — any person submission inside the window, however small, is approved. A race can be narrowed by timing, never closed. Disabling Locked Use outright (the open disable fix, #11523) removes the capability entirely and stays the fallback if the attended gate above fails.
