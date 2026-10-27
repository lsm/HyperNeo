# Shared content disclosure verification

Use SKILL.md's resources, isolation and cleanup. The current publication footer
has its own journey, neo-reply-fold-row.md: more/less sits on a separate
right-aligned row. Use that journey
for the current proof scope and required screenshots. Do not use the former
inline-position expectation as a pass.

The shared-disclosure-seed.ts and shared-disclosure-web.mjs helpers preserve the
historical #8092 characterization, including inline final-line placement. They
are baseline evidence tools, not an after-pass for the current publication UI.
Never label that legacy expectation as current browser proof.

For todo-row disclosure use neo-todo-disclosure.md, checking the controls and
labels actually served by the current build. For settled-question previews use
neo-settled-question-preview.md. Each surface requires its real user-visible
state and screenshots; a passing shared component test is insufficient.

Human-message clamping has separate behavior from publication Details. Until
its migration, the existing explicit Show more/Show less must open and fold the
same message without disrupting links or selection. A change to that behavior
must supply its own current browser journey and replace this paragraph in the
same PR. The historical shared helper is not proof of a later clamp design.
