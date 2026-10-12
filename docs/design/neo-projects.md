# Neo: work is grouped by project

Status: proposal. Tracks: epic #6002. Builds on #6579, #6604, #6631, #6642, #6643.

## Why

Neo is for people with more sessions than they can drive by hand. Someone with a few sessions just uses Codex or Claude Code directly. So the first thing Neo has to get right is **what the work is for**: the target.

Today the unit is a "topic" (in code, a "concern"). The two words are used interchangeably, and neither says what the unit is.

- The router opens a new topic named after the first line of a message (`neoNewTopic`). That's how "iOS the message sending spinner on top of the user" and "Neo tool-audit fixes" became topics, while HyperNeo and neo-ios, the actual projects, are not.
- The local `neokai` folder, `~/tmp/HyperNeo`, their worktrees and the iMac checkout are all one repository. Nothing says so.
- `places.ts` merges Claude Code, Codex and HyperNeo sessions only when they share a folder on the same machine.

## Two layers

The design keeps two things apart:

1. **Avatars: Neo's context holders, organized by project.** An avatar holds the asks, decisions and memory for one project. Avatars form a tree under Neo: Travel can be top level or under Neo, with Japan and Spain under Travel. This is the layer the human talks to.
2. **Workspaces: where the project actually is.** These are a HyperNeo project (the `neokai` folder on the laptop daemon), a Claude Code folder, a Codex project, a cloud agent's environment, or a design file. Each is worked by its own agent software, on any machine or in the cloud.

An avatar **mirrors** a project. When a workspace exists in any tool (a HyperNeo project, a Claude Code folder, a Codex project called "travel"), an avatar for it exists too. One avatar spans all of that project's workspaces, whatever tool or machine they're on. A cloud agent working on HyperNeo still reports to the same HyperNeo avatar. An avatar can also exist with no workspace at all ("Japan trip" before anything is booked).

Some examples:

| Avatar | Its workspaces |
|---|---|
| HyperNeo | `neokai` (HyperNeo project, laptop), `~/tmp/HyperNeo` and its worktrees (Claude Code), the iMac checkout (Codex), a cloud session |
| neo-ios | the `neo-ios` folder (Claude Code), its worktrees |
| Travel → Japan trip | none yet, or a Codex project holding the itinerary and bookings |
| Taxes 2026, Mom's school forms | documents, people, dates |

One word for the avatar's subject everywhere: **project**, in the UI, in Neo's prompt and in the code. "Topic" and "concern" retire. One-off questions that belong to no project ("what's the weather") stay in the Inbox.

## Identity

Two workspaces belong to the same project when they share outcome and materials. The daemon decides this from facts where it can, and Neo decides the rest.

- **Code:** identity is the content, not the name. A repository is known by its history (its root commit), and its remotes (`github.com/lsm/HyperNeo`) and folder names are links to it. Every folder whose history matches is a workspace of that project, on any machine, in any tool, under any folder name. When a repo moves or is renamed, the old remote stays a link for as long as it can still be found.
- **Tool projects:** a HyperNeo, Codex or Claude Code project's own name and folders link it to an avatar. A Codex project with several folders maps to one avatar with all of them. HyperNeo projects support several folders too, the same way, so the mirror is one to one.
- **Everything else:** Neo judges from the request, its people, dates and documents. When it can't tell, it asks once with `neo.ask.question` ("Spain trip: under Travel next to Japan, or on its own?"). The answer is saved as a rule, so the same question isn't asked twice.

Neo picks a workspace and a driver per card. For HyperNeo that might be a Claude Code session on the laptop, a Codex thread on the iMac, a new HyperNeo session in a worktree, or a cloud agent, whichever is idle and fits.

## Parents and sections

Avatars form a tree: each avatar has at most one parent, with no fixed depth. Today's avatars are one level under root Neo, and most real cases fit two levels, but the product shows why a fixed depth breaks: the HyperNeo product holds the HyperNeo repo and the neo-ios repo, and the HyperNeo repo has a Neo section. That is already three levels.

- **A level is added only when it's needed:** when a project's asks split into parts that each have their own outcome, or the human groups projects. Neo never creates a level up front.
- **Routing walks the tree one level at a time,** so depth costs nothing per decision.
- **The UI shows the path** (HyperNeo › Neo) and lets the human move an avatar to another parent.

- **A parent groups projects that share context.** Travel holds Japan and Spain when they share a passport, loyalty accounts or companions. Business travel is a different parent: the budget, the approvals and who pays all differ. Family holds Mom's school forms once more family errands come.
- **A section splits a large project.** For code, sections follow epics: HyperNeo → Neo (#6002), daemon, web. A section is an avatar with a parent; it shares the parent's workspaces.

## Routing and reorganize

- The router picks the project first, then the section. For a code project it uses facts before words: a PR or issue named in the message, the repo of a linked session, the folder of a card. Then the text.
- A new project is named after its target ("HyperNeo", "Japan trip"), never after a message's first line.
- `neo.topics.reorganize` becomes project reorganize, and runs nightly as today:
  - merge projects whose code identity matches;
  - move asks into their project and section;
  - attach workspaces found since the last run, in any tool;
  - ask the human once about a merge it can't decide from facts.
  - The first run turns today's topics into projects: the redesign, the network fixes and the Neo tool fixes go to HyperNeo → Neo, and the iOS spinner topic goes to neo-ios.

## Slices

| # | Slice | Depends on |
|---|---|---|
| 1 | Workspaces: code identity from the git remote; tool projects (HyperNeo, Codex, Claude Code, cloud) linked to one project across machines | none |
| 1b | HyperNeo projects hold several folders, like Codex projects | none |
| 2 | Avatars mirror projects (one per project, created when a workspace appears); rename topic/concern to project in UI, prompt and code, with a migration | 1 |
| 3 | Router picks project then section; new projects are named after their target | 1 |
| 4 | Parents and sections; sections from epics for code projects | 1, 3 |
| 5 | Reorganize merges by identity, moves asks into projects and sections, asks once when unsure, saves the answer as a rule | 1, 3, 4 |
