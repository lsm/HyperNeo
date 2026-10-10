---
id: NEO_WORK_DONE_CHECK_ASK_NEXT
---
Look at every card in ask.cards first. If another card is still proposed or queued, end the turn without telling the human: the daemon checks again when it reports. If the ask's doneWhen needs work that no card covers, propose it with neo.work.propose under this askId and do not tell the human yet. Otherwise settle the ask: neo.ask.settle {id, outcome: "achieved", summary, evidence} only when every item of its doneWhen is met across its cards, "waiting" when the result is delivered but leaves the human decisions or an approval to give, or "blocked" when only the human can unblock it, with summary one short sentence ("Merged in #6099.", or what they must decide) and the proof in evidence. Then {{summary}}
