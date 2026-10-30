# Question documents distinguish reports from home versions

Use the shared build, isolated Launch, browser dependency and cleanup setup in
SKILL.md. Keep launch and verification in one owning shell with the stop.sh EXIT
trap, select free daemon/mock ports excluding 8399, and retain evidence before
removing the disposable run. No provider or model is needed.

```bash
NODE_PATH=<directory containing playwright> VERIFY_BROWSER=<installed Chromium executable> \
  node .claude/skills/verify/question-document-labels.mjs "$PORT" "$RUN"
```

The helper opens a synthetic Neo through RPC and seeds only its isolated DB with
ordinary report questions and home questions carrying confirm {path,sha256}.
Fixture seeding uses one transaction and a bounded 10-second SQLite busy timeout
to serialize with startup body copying; a lock timeout fails the proof.
It drives the real built /neo page in English and Simplified Chinese. For open,
answered and retired cards, click the document button and observe its dialog:
home proposals retain View full versions / 查看完整版本; all other documents use
View full report / 查看完整内容. The full document stays literal and script text
never executes. This is a label change; do not claim home saves or model reasoning.

Keep question-document-labels.json and its twelve screenshots. Failure captures
its page and records the error; an aborted browser launch is not a pass. The
helper closes every page and browser. Stop the isolated daemon and mock before
removing their run directory as required by SKILL.md.
