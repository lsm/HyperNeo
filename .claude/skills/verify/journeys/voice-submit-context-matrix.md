# One Send includes pending speech and its context

Follow SKILL.md for the pinned Bun, resource check, fresh synthetic HOME/data/DB
and headless Chromium setup. Build the current web checkout first.

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/voice-submit-matrix.ts before
```

The before case starts with a quoted Neo message and typed words. Chromium uses
real getUserMedia/AudioWorklet capture from a synthetic WAV input. The local ASR
holds its final transcript until the browser explicitly releases it. One Send
during recording must wait for that result and deliver one durable message with
the quote, typed prefix and spoken words, leaving an empty composer. The baseline
fails this assertion with no send and all words left in the draft.

Run the same command with after to exercise plain, quote, image, file, quote plus
image, quote plus file, and quote plus image plus file. Each runs with direct Send
during recording, Send during held final ASR, immediate Stop then Send, and Enter
on the focused Send control while ASR is pending. Stop alone keeps a draft.

matrix.json records case/action, ASR/audio evidence, sends, durable messages and
remaining draft. receipts.json contains actual operation receipts and stored
conversation inputs. The fixture observes the original operation unchanged.
Screenshots retain the composer and conversation outcomes. All ports are random,
8399/8499 are refused, and finally closes browser, ASR and isolated daemon. The
wrapper saves evidence and removes temporary data. Require its exitCode 0.
