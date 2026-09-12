# Promote NeoKai Through Public Community Channels

## Goal

Use NeoKai itself to grow NeoKai awareness through public developer communities while keeping all public posting human-approved, useful, and non-spammy.

## Current operating mode

Draft-only. No public posts, comments, direct messages, or community submissions happen until:

1. Target channel norms are checked immediately before posting.
2. A human approves exact copy and destination.
3. A follow-up owner is assigned to answer questions and mine product feedback.

## Positioning

NeoKai is a browser UI for Claude Agent SDK users who want multi-session agent work, model/provider switching, file/git operations, MCP server management, rewind/checkpoints, and Space/Mission workflows for multi-agent development.

### Primary angles

- **Dogfood story**: NeoKai uses its own Space/Mission workflows to plan, implement, review, QA, and promote NeoKai.
- **Agent workbench**: browser-first interface for running Claude Agent SDK sessions with project context, tools, MCP servers, checkpoints, and model switching.
- **Multi-agent workflows**: Spaces and Missions coordinate coder/reviewer/QA loops with gates, artifacts, and human approval.
- **Transparent development**: share implementation lessons, rough edges, and concrete workflows rather than hype claims.

### Claims to avoid until validated

- "Autonomous software company" or similar broad claims.
- Productivity multipliers without measured evidence.
- Comparisons that imply other tools cannot do similar work.
- Any promise of safe unsupervised public posting.

## Channel research checklist

Always re-check rules before posting. Community norms change, and individual moderators override general guidance.

| Channel | Best fit | Draft-only first move | Norms to verify before posting | Anti-spam guardrail |
| --- | --- | --- | --- | --- |
| Hacker News | Technical demo, Show HN, launch post | Show HN draft with architecture + repo/demo link | Show HN title style, self-promotion tolerance, no marketing copy, answer comments promptly | One launch post only after demo is stable; no vote solicitation |
| Reddit r/ClaudeAI | Claude-specific workflow discussion | Short workflow demo post asking for feedback | Subreddit self-promo policy, flair, frequency, whether tool demos allowed | Prefer "what workflow should we test?" over launch pitch |
| Reddit r/LocalLLaMA | Model/provider workflow angle | Draft around provider switching and local/remote agent work | Whether Claude-focused tool is on-topic, self-promo limits, benchmark requirements | Only post if local/open-provider angle is substantial |
| Reddit r/programming | Engineering write-up | Technical post about multi-agent workflow engine lessons | Self-promo rules, text-post expectations, blog/link policy | Avoid product announcement unless write-up stands alone |
| Reddit r/webdev | Browser UI/productivity workflow | UI/workflow feedback request | Showcase/self-promo days, flair, no low-effort demo links | Ask for UX critique; disclose author |
| Reddit r/SideProject | Early product feedback | "Built a browser UI for Claude Agent SDK" draft | Launch/showcase format, feedback request norms | One post, explicit feedback ask, no cross-post blast |
| X/Twitter | Short demos, build-in-public updates | Thread: problem → demo → lessons → feedback ask | None formal, but avoid spam tags and repeated mentions | Max 1 launch thread + 2 follow-up clips/week |
| Discord communities | High-signal small discussions | Ask moderators before posting demo link | Server-specific promo channels, mod approval, slash-command rules | Do not cold-DM; use promo/showcase channel only |
| GitHub/readme audience | Durable source of truth | Linkable demo issue or discussion | Repo contribution guidelines | Keep changelog factual; no growth hacking |

## First content calendar

### Week 1 — prepare assets

- Record 60-90 second demo: create Space → spawn coding workflow → reviewer gate → artifact/PR handoff.
- Write short architecture post: MessageHub + Space runtime + agent workflow gates.
- Prepare screenshots for: session list, model switcher, MCP config, Space/Mission canvas, review gate.
- Create one feedback form or GitHub discussion target for public responses.

### Week 2 — human-approved soft launch

- Publish one X/Twitter build-in-public thread.
- Submit one feedback-oriented post to r/SideProject or r/ClaudeAI, not both same day.
- Ask 1-2 Discord moderators whether a demo post fits their showcase channel.
- Capture all replies into Forge evidence/product feedback artifacts.

### Week 3 — technical follow-up

- Publish engineering write-up for Hacker News or r/programming if demo and docs are ready.
- Post Show HN only if there is a stable public demo/repo/docs link and someone can respond for 24 hours.
- Mine comments for product gaps, confusion, objections, and setup friction.

## Draft posts

### X/Twitter launch thread draft

> We are building NeoKai: a browser UI for the Claude Agent SDK.
>
> It gives agent work a visible workspace: multiple sessions, model switching, MCP servers, file/git tools, checkpoints, and Space/Mission workflows for coder → reviewer → QA loops.
>
> Current dogfood experiment: use NeoKai itself to plan, build, review, QA, and promote NeoKai.
>
> Short demo idea:
> 1. Start a Space mission
> 2. Spawn a coding workflow
> 3. Reviewer gets gated PR handoff
> 4. QA checks result
> 5. Human approves any public action
>
> Looking for feedback from people using Claude Code / Claude Agent SDK: what part of multi-agent workflow UI feels most missing today?

Approval notes:

- Attach demo clip before posting.
- Add repo/docs/demo link only after target page is ready.
- Do not tag unrelated accounts.

### Reddit feedback post draft

Title options:

- `Built a browser UI for Claude Agent SDK workflows — looking for feedback`
- `Dogfooding multi-agent coding workflows in a browser UI for Claude Agent SDK`

Body:

> I am building NeoKai, a browser UI for Claude Agent SDK workflows.
>
> The goal is to make agent work visible and reviewable: multi-session chat, model/provider switching, MCP server configuration, file/git operations, rewind/checkpoints, and Spaces/Missions that coordinate coder/reviewer/QA agents with gates and artifacts.
>
> The current dogfood test is intentionally meta: use NeoKai itself to run promotion work as a mission, draft posts, route them through review, and require human approval before anything public is posted.
>
> I would value feedback from people running Claude Code or SDK-based agents:
>
> - What agent workflow state do you wish were visible in a UI?
> - Where do multi-agent coding loops break down for you?
> - Would gates/artifacts/checkpoints help, or add too much process?
>
> I can share screenshots/demo link if useful.

Approval notes:

- Disclose author relationship clearly.
- Pick one subreddit per draft; adapt title/body to local rules.
- Add flair if required.

### Hacker News / Show HN draft

Title:

`Show HN: NeoKai – browser UI for Claude Agent SDK workflows`

Body:

> NeoKai is a browser UI for working with Claude Agent SDK sessions.
>
> It supports multi-session chat, model/provider switching, MCP servers, file/git operations, rewind/checkpoints, and Spaces/Missions for multi-agent workflows. A typical workflow can route work through coder, reviewer, and QA agents, with gates and artifacts so a human can inspect handoffs before public or irreversible actions.
>
> The project is currently being dogfooded: this launch plan was drafted inside a NeoKai mission, with review/QA gates before posting.
>
> I am interested in feedback from people building with Claude Agent SDK or similar agent tools: which workflow states need UI, and which should stay in terminal/logs?

Approval notes:

- Only post after public repo/demo/docs are ready.
- Be present for comments.
- Avoid polished marketing tone; answer technical questions directly.

### Discord moderator request draft

> Hi, I am building NeoKai, a browser UI for Claude Agent SDK workflows. It covers multi-session agent work, MCP servers, checkpoints, and multi-agent coder/reviewer/QA workflows.
>
> Would a short demo/feedback request be appropriate in this server? If yes, which channel and format should I use? If not, no worries.

Approval notes:

- Send only to moderators or designated ask-a-mod channels.
- Do not DM random members.

## Approval and anti-spam policy

### Required approval packet

Every proposed public post needs:

- Channel and exact destination.
- Current rules/norms summary with link or screenshot if available.
- Exact post text and media.
- Purpose: feedback, demo, launch, engineering write-up, or support reply.
- Risk notes: self-promo risk, off-topic risk, claim risk, privacy risk.
- Follow-up owner and response window.

### Public posting rules

- Human approval required for exact final copy and destination.
- No automated posting to public communities.
- No vote/like solicitation.
- No cross-post blast; stagger posts by channel and adapt to local norms.
- No sockpuppet accounts or undisclosed author relationship.
- No cold DMs except moderator permission requests where allowed.
- No repeated replies that restate product pitch.
- Every public response should answer the person first, mention NeoKai only when relevant.

### Feedback mining

For each public post or discussion, capture:

- Link, date, channel, and approved copy.
- Engagement snapshot after 24h and 7d.
- Top objections/confusions.
- Product feedback items with severity and source.
- Follow-up tasks created in NeoKai.

## Metrics update target

After this draft package exists:

- `channels_researched`: 9
- `post_drafts_created`: 4
- `approved_posts_published`: 0
- `engagement_snapshots_captured`: 0
- `product_feedback_items_mined`: 0

## Next steps

1. Review this package for policy and positioning.
2. Fill in live community rule links/screenshots immediately before first post.
3. Record demo clip and prepare screenshots.
4. Submit one approval packet for X/Twitter or r/SideProject soft launch.
5. After approval and publication, capture engagement + product feedback into Forge evidence.
