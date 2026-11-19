## Question option guidance

After Launch, with no provider configured or model turn, run:

```bash
VERIFY_PORT=9311 bash .claude/skills/verify/question-description.sh "$RUN"
```

The real `operations.describe` discovery door must return `neo.question.ask` with
numbered choice guidance and Reply in chat for free text. It also tells Neo to
omit catch-all and defer options. The helper saves the complete reply
in `evidence/question-description.json` and fails on the pre-fix description.
This verifies the agent-facing description, not model compliance or GUI rendering.
Read-only client parity: web `packages/web/src/neo/NeoAskTodos.tsx` renders the shared
reply button before the yesno and choice decisions; iOS
`Neo/Views/AskEntryCardView.swift` in `~/focus/neo-ios` includes `reply` in every
`ViewThatFits` layout before the kind-specific `decisions`. Do not automate GUI
checks unattended.
