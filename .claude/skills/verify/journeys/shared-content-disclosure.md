# Shared content disclosure verification

Use SKILL.md's resources, isolation and cleanup. Current publication copy
coverage lives in neo-whole-message-copy.md, which verifies complete Markdown
source and block-copy scope. The separate-row footer migration belongs to
#9086 item 8; use its journey after that change has landed. Do not interpret
historical inline-position expectations as proof of a newer footer.

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
