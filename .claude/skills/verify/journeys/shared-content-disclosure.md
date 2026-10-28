# Shared content disclosure verification

Use SKILL.md's resources, isolation and cleanup. The current publication footer
has its own journey, neo-reply-fold-row.md: more/less sits on a separate
right-aligned row. Whole-message Markdown copy and block-copy scope remain in
neo-whole-message-copy.md. Use these journeys for the current proof scope and
required screenshots; never treat the former inline placement as a pass.

The shared-disclosure-seed.ts and shared-disclosure-web.mjs helpers preserve the
historical #8092 characterization, including inline final-line placement. They
are baseline evidence tools, not an after-pass for the current publication UI.
Never label that legacy expectation as current browser proof.

For todo-row disclosure use neo-todo-disclosure.md, checking the controls and
labels actually served by the current build. For settled-question previews use
neo-settled-question-preview.md. Each surface requires its real user-visible
state and screenshots; a passing shared component test is insufficient.

For current human-message clamping use neo-user-message-clamp.md: the visible
More/Less controls are replaced by a fading cut and text activation. That
journey covers the word-bearing-line limit, fallback ellipsis, text folding,
links, keyboard access and both viewport sizes. The old shared helper's human
Show more/Show less expectations are historical baseline evidence only.
