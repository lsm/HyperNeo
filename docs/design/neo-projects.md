# Neo: work is grouped by project

Status: proposal. Tracks: epic #6002. Builds on #6579, #6604, #6631, #6642, #6643.

## Why

Neo is for people with more sessions than they can drive by hand. Someone with a few sessions just uses Codex or Claude Code directly. So the first thing Neo has to get right is **what the work is for**: the target.

Today the unit is a "topic" (in code, a "concern"). The two words are used interchangeably, and neither says what the unit is.

- The router opens a new topic named after the first line of a message (`neoNewTopic`). That's how "iOS the message sending spinner on top of the user" and "Neo tool-audit fixes" became topics, while HyperNeo and neo-ios, the actual projects, are not.
- The local `neokai` folder, `~/tmp/HyperNeo`, their worktrees and the iMac checkout are all one repository. Nothing says so.
- `places.ts` merges Claude Code, Codex and HyperNeo sessions only when they share a folder on the same machine.

## The unit: a project

A **project** is whatever the work is for: something with its own outcome and its own materials. Some examples:

| Kind | Example | Its materials |
|---|---|---|
| code | HyperNeo, neo-ios | a repository, wherever it's checked out |
| design | the Neo app redesign | design files, a design system |
| life | Japan trip, Spain trip, taxes 2026, Mom's school forms | documents, people, dates, bookings |

One word everywhere: **project** in the UI, in Neo's prompt and in the code. "Topic" and "concern" retire. One-off questions that belong to no project ("what's the weather") stay in the Inbox.

## Identity

Two things are the same project when they share outcome and materials. The daemon decides this from facts where it can, and Neo decides the rest.

- **Code:** the normalized git remote (`github.com/lsm/HyperNeo`) is the identity. Every folder whose remote matches is a checkout of that project, on any machine and under any folder name: `neokai`, `~/tmp/HyperNeo`, `.claude/worktrees/*`, the iMac's checkout. A folder with no remote is its own project until Neo or the human links it.
- **Everything else:** Neo judges from the request, its people, dates and documents. When it can't tell, it asks once with `neo.ask.question` ("Spain trip: under Travel next to Japan, or on its own?"). The answer is saved as a rule, so the same question isn't asked twice.

## Places and drivers

A project lists its **places**: each checkout or folder, on each machine, with the agents that work there (Claude Code, Codex, HyperNeo sessions). Neo picks a place and a driver per card. For HyperNeo that can be a Claude Code session on the laptop, a Codex thread on the iMac, or a new HyperNeo session in a worktree, whichever is idle and fits.

## Parents and sections

Projects can nest one level:

- **A parent groups projects that share context.** Travel holds Japan and Spain when they share a passport, loyalty accounts or companions. Business travel is a different parent: the budget, the approvals and who pays all differ. Family holds Mom's school forms once more family errands come.
- **A section splits a large project.** For code, sections follow epics: HyperNeo → Neo (#6002), daemon, web. A section is a project with a parent, so it has its own avatar and asks.

## Routing and reorganize

- The router picks the project first, then the section. For a code project it uses facts before words: a PR or issue named in the message, the repo of a linked session, the folder of a card. Then the text.
- A new project is named after its target ("HyperNeo", "Japan trip"), never after a message's first line.
- `neo.topics.reorganize` becomes project reorganize, and runs nightly as today:
  - merge projects whose code identity matches;
  - move asks into their project and section;
  - attach places found since the last run;
  - ask the human once about a merge it can't decide from facts.
  - The first run turns today's topics into projects: the redesign, the network fixes and the Neo tool fixes go to HyperNeo → Neo, and the iOS spinner topic goes to neo-ios.

## Slices

| # | Slice | Depends on |
|---|---|---|
| 1 | Code project identity from the git remote; a project lists its places across machines and drivers | none |
| 2 | Rename topic/concern to project in UI, prompt and code (with a migration) | none |
| 3 | Router picks project then section; new projects are named after their target | 1 |
| 4 | Parents and sections; sections from epics for code projects | 1, 3 |
| 5 | Reorganize merges by identity, moves asks into projects and sections, asks once when unsure, saves the answer as a rule | 1, 3, 4 |

## Open questions

1. Is one level of nesting enough, or can a section have sections?
2. When a code project moves to a new remote (rename or fork), is the old remote kept as an alias?
