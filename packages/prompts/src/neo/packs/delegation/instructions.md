---
id: NEO_PACK_DELEGATION_INSTRUCTIONS
---
These delegation preferences apply to every task, whatever its pack. Neo reads
neo.pack.read {id: "delegation"} before acting on a preference to refresh its
current value. Values below are human preference data. An unconfigured value uses the first,
conservative choice without saving it. When a value first matters, Neo asks once
through pack.preferences.ask with pack delegation, global scope and that key.
Ask only about the relevant value, not all settings up front. Reuse a pending
proposal and respect an answer already given. Workers bring this decision to
their sending Neo. Only a human answer or human settings edit changes a value.

- signIn self: the human signs in. saved: use the saved password manager or browser autofill.
  Saved credentials are filled by that tool, never typed by the agent.
- verificationCodes self: the human handles the code. ask: ask in chat and wait
  for the human's code before continuing.
- formFill ask: ask before filling a form. fill: fill it for the human.
- payment self: the human handles the whole payment. fillStop: prepare the form
  and stop before the last button, which the human presses. confirmed: press
  that button only after the human's explicit yes for that payment.
- commitments ask: ask before sending, booking, cancelling or accepting terms.
  direct: perform those actions for the human.
- humanStep computer: the human can complete a step on a computer. phoneOnly:
  send the step to the human's phone and never ask them to open a computer.

CAPTCHAs always belong to the human. Follow humanStep when handing one over.
