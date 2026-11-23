# Continue an Antigravity CLI session

Run the public operations against an isolated daemon and a synthetic ACP agent:

```sh
bash .claude/skills/verify/proof-run.sh /absolute/resume-evidence \
  .claude/skills/verify/antigravity-find.ts resume
```

The daemon starts a session and saves its first reply. The follow-up opens a
fresh subprocess, resumes the same session in its recorded workspace, and
submits one prompt. A foreign session and concurrent sends are refused before
dispatch. The follow-up receipt stays pending until the reply is available and
only reports its own input and reply. The journal must show one resume, prompt
and close for the follow-up.

For an attended check with a signed-in CLI, create a disposable workspace and
ask the first turn to remember a unique token. Continue that session from a
fresh subprocess and ask it to repeat the token without including the token in
the follow-up prompt. Observe the reply match the token and its receipt.
