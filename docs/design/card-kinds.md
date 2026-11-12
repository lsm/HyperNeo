# Cards: confirm, choose or reply

Every Neo card already has Reply in chat, and a card nobody answers stays open. Yet a yes/no card must carry a no button, so Neo fills it with "not now" wording that only closes the card. This design leaves three shapes, by what the human can do: confirm one action, choose among real actions, or reply in their own words.

## Problem

- `neo.question.ask` requires both labels on a yes/no card (`question-operations.ts`, `AskKinds`: `noLabel: Text`), and its description tells Neo the no side means "keep things as they are" (`neo.question.ask.md`). When a question has one real action, Neo has to invent a second button.
- In practice close to half of all yes/no cards carry a no label meaning "later" ("not now", "hold", "leave it", "let me think"), and only a few percent of answered ones are answered no, several of those "later" too. Clicking such a button closes the card as `no`; Neo is told one line and nothing brings the question back, while leaving the card open would have kept it.
- The rest of the no answers were real second actions ("leave it running", "keep the current scope", "use the other model"), which are a choice between two actions.
- A choice card needs at least two options (`options: z.array(Text).min(2)`), so the same filler shows up there as a "later" option.

## Design

1. **Three shapes.** A card is one of:
   - **Confirm:** one action. Not answering means not decided; anything else goes to Reply in chat.
   - **Choose:** two or more real actions, single or multiple.
   - **Reply:** no buttons, answered in chat.

   Confirm is a `choice` card with one option, so no new kind, column or migration is needed. Choose is a `choice` card with several options. Reply is unchanged.
2. **The tool offers only these.** `neo.question.ask` drops `yesno` from Neo's kinds and lets `choice` take 1 to 6 options. The description says that each option is an action the human can take, that a card left open is undecided so no option may mean later or not now, and that one option is a confirmation. This replaces the yes/no paragraph; it is the same reasoning the description already uses to forbid an "other" option.
3. **Home proposals confirm.** A home proposal (`confirm: {path, sha256}`) becomes a one-option choice. Its save check (`home/confirmation.ts`) also accepts a human answer equal to that option; the `kind yesno` with answer `yes` branch stays, so a proposal opened before the upgrade still saves. Every text that tells Neo to open a yes/no card names the new shapes instead: `root.md`, `goal-cycle.md` (the mandate flow), `blocker.md`, `neo.todo.edit.md`, and the notes in `turn-report.ts` and `todo-runner.ts`.
4. **The daemon's own two-action cards become choices.** Rule changes (Apply or Keep current rules), pack settings (Apply or Keep current settings) and the coding pack's home repository (Create private repo or Keep local) are fixed two-option choices. Their readers (`neo-rule-answer.ts`, `pack-preference-answer.ts`, `packs/coding/home/github.ts`), the apply step that runs when such a card is answered (`neo-ask-todo-repository.ts`, `answer === 'yes'`) and the rule-save citation (`operations.ts`, `neo.rule.save`) also match the apply option. Each keeps its human `yes` branch on `yesno` cards, so a card opened before the upgrade still applies when answered after it. The tool descriptions that promise a human yes (`neo.rule.ask.md`, `neo.rule.applyAnswer.md`, `neo.rule.save.md`, `pack.preferences.ask.md`, `pack.preferences.applyAnswer.md`, `neo.home.github.md`) name the apply option instead, as do the coding pack's provenance instruction (`packs/coding/SKILL.md`: a no answer saves nothing, apply `provenance false` only after a yes) and the rule-save sentence in `root.md` (it cites a consumed human yes). After this no new card is a yes/no card.
5. **Chat answers.** A chat reply picks an option the way it does on every choice card: by its letter or its exact text (`neoChoiceByLetter`). So the human approves a rule, setting or home proposal in chat with "A" or the option's words. A bare "yes" no longer applies one; today only that exact English word does (`neo-rule-answer.ts`), and any other wording is already recorded as plain words that apply nothing. Neo is told the words either way and can ask again.

## Not changed

- **Clients.** The iOS app and the web page already draw a single-choice card of any length as tappable rows, so a one-option card needs no client release.
- **Existing yes/no cards.** Open ones keep applying on `yes` until PR 3; answered ones stay readable as history after it.
- **Start cards.** Their "Not now" goes away when they become multi-select choices (todo design, slice 5).
- **The chat side.** Apart from point 5, chat answers to a card are recorded as today. Offering a card's options in the main chat, for people who never open cards, is separate work.

## Change

- PR 1: points 1 to 3 (`question-operations.ts`, `home/confirmation.ts`, `turn-report.ts`, `todo-runner.ts`, and the prompts `neo.question.ask.md`, `root.md`, `goal-cycle.md`, `blocker.md`, `neo.todo.edit.md`, `neo.home.save.md`). Tests: a one-option choice opens and is answered by its option; a yes/no from Neo is refused; a home save passes on the confirmed option, by button or by its letter in chat, and fails on any other answer or on another card; a home proposal opened as yes/no before the upgrade still saves on `yes`.
- PR 2: points 4 and 5 (`rule-questions.ts`, `preference-questions.ts`, `preference-proposal.ts`, `packs/coding/home/github.ts`, the two answer readers, the apply step in `neo-ask-todo-repository.ts`, `neo.rule.save` in `operations.ts`, the six tool descriptions in point 4, `packs/coding/SKILL.md`, and the rule-save sentence in `root.md`; its home-proposal sentence is in PR 1). Tests: each card applies on its apply option, by button or by letter in chat, and changes nothing on its keep option or on other words; `neo.rule.save` accepts a cited chat answer that picked the apply option; an open yes/no rule, setting or home-repository card made before the upgrade still applies on `yes`, by button, by automatic application and by rule-save citation.
- PR 3, once no yes/no card is open: remove the `yes` branches from the home save check, the three readers, the apply step and `neo.rule.save`. Tests: a home, rule, setting or repository save on a `yesno` card is refused.
