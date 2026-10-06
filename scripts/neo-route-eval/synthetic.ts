import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CaseKind, EvalCase, EvalTopic, EvalTurn } from './types.ts';

const HERE = dirname(new URL(import.meta.url).pathname);
const NOW = '2026-10-06T10:00:00.000Z';

const WORLD: Record<string, Omit<EvalTopic, 'id' | 'latest' | 'waiting'>> = {
  'pr-812': {
    title: 'PR #812: retry budget for webhook delivery',
    summary:
      'Coder agent opened PR #812 adding a per-endpoint retry budget. CI was red on lint; review bot asked for a backoff test.',
  },
  'gpu-box': {
    title: 'Local model box: RTX 5060 build',
    summary:
      'Choosing parts for a small Linux box to run 4–8B models locally. Shortlist: RTX 5060 16 GB vs used 3090; budget about $1,200.',
  },
  'kyoto-trip': {
    title: 'Kyoto trip, 12–19 November',
    summary:
      'Two adults. Comparing a Gion ryokan and a Kyoto Station hotel; JR pass not worth it; day trip to Nara planned.',
  },
  'tax-2026': {
    title: '2026 tax filing prep',
    summary:
      'Collecting 1099-B and 1099-INT forms, estimating Q4 payment, deciding whether to use the same accountant.',
  },
  'ci-blog': {
    title: 'Blog post: moving CI to self-hosted runners',
    summary:
      'Draft 2 of a post on cost and flakiness after moving CI to self-hosted runners; needs numbers for the cost chart.',
  },
};

function hoursAgo(hours: number): string {
  return new Date(Date.parse(NOW) - hours * 3_600_000).toISOString();
}

function turn(topic: string, ask: string, answer: string, hours: number): EvalTurn {
  return { topic, ask, answer, at: hoursAgo(hours) };
}

const BACKGROUND: EvalTurn[] = [
  turn(
    'tax-2026',
    'did the brokerage 1099-B show up yet?',
    'Not yet; they post it mid-February.',
    60
  ),
  turn('ci-blog', 'tighten the intro of the CI post', 'Done — intro cut from 180 to 90 words.', 54),
  turn(
    'gpu-box',
    'is 16 GB enough for an 8B model at q8?',
    'Yes, with room for an 8k context.',
    48
  ),
  turn(
    'kyoto-trip',
    'which area is quieter at night, Gion or the station?',
    'Gion side streets are quieter after 10 pm.',
    44
  ),
];

interface Spec {
  kind: CaseKind;
  message: string;
  expected: string[];
  followUp: boolean;
  turns?: EvalTurn[];
  waiting?: Record<string, string>;
}

function buildCase(spec: Spec, index: number): EvalCase {
  const turns = [...BACKGROUND, ...(spec.turns ?? [])].sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at)
  );
  const topics: EvalTopic[] = Object.entries(WORLD).map(([id, topic]) => {
    const last = [...turns].reverse().find((entry) => entry.topic === id);
    return {
      id,
      ...topic,
      ...(last ? { latest: { ask: last.ask, answer: last.answer } } : {}),
      ...(spec.waiting?.[id] ? { waiting: spec.waiting[id] } : {}),
    };
  });
  return {
    id: `syn-${spec.kind}-${String(index).padStart(2, '0')}`,
    source: 'synthetic',
    kind: spec.kind,
    now: NOW,
    topics,
    turns,
    message: spec.message,
    expected: spec.expected,
    followUp: spec.followUp,
  };
}

const prTurn = turn(
  'pr-812',
  'is PR 812 merged yet?',
  'Not yet — CI is red on lint and the bot wants a backoff test.',
  1
);
const gpuTurn = turn(
  'gpu-box',
  'what does the 5060 16 GB cost right now?',
  'About $429 at two shops; the used 3090s are $650–700.',
  1
);
const tripTurn = turn(
  'kyoto-trip',
  'did the Gion ryokan reply about the 14th?',
  'Yes — they have a room for 14–19 Nov at ¥42,000 a night.',
  2
);
const mainTurn = turn(
  'main',
  'what weather API do we use in the home dashboard?',
  'Open-Meteo, no key needed, polled every 30 minutes.',
  1
);

const SPECS: Spec[] = [
  {
    kind: 'follow_up',
    message: 'how about now?',
    expected: ['pr-812'],
    followUp: true,
    turns: [prTurn],
  },
  {
    kind: 'follow_up',
    message: 'how about 812 now?',
    expected: ['pr-812'],
    followUp: true,
    turns: [prTurn],
  },
  {
    kind: 'follow_up',
    message: 'ok, ask the agent to add the test and rerun it',
    expected: ['pr-812'],
    followUp: true,
    turns: [prTurn],
  },
  {
    kind: 'follow_up',
    message: 'what was the lint error again?',
    expected: ['pr-812'],
    followUp: true,
    turns: [
      turn(
        'pr-812',
        'is PR 812 merged yet?',
        'Not yet — CI is red on lint and the bot wants a backoff test.',
        3
      ),
    ],
  },
  {
    kind: 'follow_up',
    message: 'any update?',
    expected: ['pr-812'],
    followUp: true,
    turns: [
      turn(
        'pr-812',
        'push 812 through review',
        'Agent is adding the backoff test now; I’ll report when CI is green.',
        4
      ),
    ],
  },
  {
    kind: 'follow_up',
    message: 'and the 8 GB version?',
    expected: ['gpu-box'],
    followUp: true,
    turns: [gpuTurn],
  },
  {
    kind: 'follow_up',
    message: 'how about 5060 now?',
    expected: ['gpu-box'],
    followUp: true,
    turns: [
      turn(
        'gpu-box',
        'what does the 5060 16 GB cost right now?',
        'About $429 at two shops; it was $399 last week.',
        20
      ),
    ],
  },
  {
    kind: 'follow_up',
    message: 'book it',
    expected: ['kyoto-trip'],
    followUp: true,
    turns: [tripTurn],
  },
  {
    kind: 'follow_up',
    message: 'what about the 13th instead?',
    expected: ['kyoto-trip'],
    followUp: true,
    turns: [tripTurn],
  },
  {
    kind: 'follow_up',
    message: 'is it free for commercial use?',
    expected: ['main'],
    followUp: true,
    turns: [mainTurn],
  },
  {
    kind: 'follow_up',
    message: 'and how often does it update?',
    expected: ['main'],
    followUp: true,
    turns: [mainTurn],
  },
  {
    kind: 'follow_up',
    message: 'ok and the cost chart numbers?',
    expected: ['ci-blog'],
    followUp: true,
    turns: [
      turn(
        'ci-blog',
        'can you redo the flakiness section of the CI post?',
        'Rewritten with the 14% → 3% flake rate from the runner logs.',
        1
      ),
    ],
  },

  {
    kind: 'second_last',
    message: 'back to the ryokan — did they confirm the late check-in?',
    expected: ['kyoto-trip'],
    followUp: true,
    turns: [tripTurn, turn('pr-812', 'is PR 812 merged yet?', 'Not yet — CI is red on lint.', 0.3)],
  },
  {
    kind: 'second_last',
    message: 'also on the card question from before: 16 GB is fine, go with it',
    expected: ['gpu-box'],
    followUp: true,
    turns: [gpuTurn, turn('tax-2026', 'when is the Q4 estimate due?', 'January 15.', 0.2)],
  },
  {
    kind: 'second_last',
    message: 'and for the PR, did the bot approve after the test?',
    expected: ['pr-812'],
    followUp: true,
    turns: [
      prTurn,
      turn(
        'kyoto-trip',
        'how long is the train from Kyoto to Nara?',
        'About 45 minutes on the Kintetsu express.',
        0.5
      ),
    ],
  },
  {
    kind: 'second_last',
    message: 'the hotel one — cancel the station hotel hold',
    expected: ['kyoto-trip'],
    followUp: true,
    turns: [tripTurn, gpuTurn],
  },
  {
    kind: 'second_last',
    message: 'about the blog: use the June numbers for the chart',
    expected: ['ci-blog'],
    followUp: true,
    turns: [
      turn(
        'ci-blog',
        'which month should the cost chart start from?',
        'I’d start at May, the first full month on self-hosted runners.',
        3
      ),
      prTurn,
    ],
  },
  {
    kind: 'second_last',
    message: 'going back to the weather thing, switch it to every 10 minutes',
    expected: ['main'],
    followUp: true,
    turns: [
      turn(
        'main',
        'what weather API do we use in the home dashboard?',
        'Open-Meteo, polled every 30 minutes.',
        2
      ),
      gpuTurn,
    ],
  },
  {
    kind: 'second_last',
    message: '刚才那个 PR 的 lint 修好了吗',
    expected: ['pr-812'],
    followUp: true,
    turns: [prTurn, tripTurn],
  },
  {
    kind: 'second_last',
    message: 'for the 1099 thing, the brokerage just emailed it',
    expected: ['tax-2026'],
    followUp: true,
    turns: [
      turn(
        'tax-2026',
        'did the brokerage 1099-B show up yet?',
        'Not yet; they post it mid-February.',
        5
      ),
      gpuTurn,
    ],
  },

  {
    kind: 'waiting_yes',
    message: 'yes',
    expected: ['kyoto-trip'],
    followUp: true,
    waiting: { 'kyoto-trip': 'Should I book the Gion ryokan for 14–19 Nov at ¥42,000 a night?' },
    turns: [
      turn(
        'kyoto-trip',
        'find a ryokan in Gion for our dates',
        'Found one with a room 14–19 Nov. Should I book it?',
        22
      ),
    ],
  },
  {
    kind: 'waiting_yes',
    message: 'yep, go ahead',
    expected: ['pr-812'],
    followUp: true,
    waiting: { 'pr-812': 'Should I merge PR 812 now that CI is green?' },
    turns: [
      turn('pr-812', 'push 812 through review', 'CI is green and the bot approved. Merge now?', 25),
    ],
  },
  {
    kind: 'waiting_yes',
    message: '好的',
    expected: ['gpu-box'],
    followUp: true,
    waiting: { 'gpu-box': 'Want me to put the 5060 16 GB build in a cart at Micro Center?' },
    turns: [
      turn(
        'gpu-box',
        'finalize the parts list',
        'List is ready, $1,140 total. Want me to put it in a cart?',
        23
      ),
    ],
  },
  {
    kind: 'waiting_yes',
    message: 'no, the later train',
    expected: ['kyoto-trip'],
    followUp: true,
    waiting: { 'kyoto-trip': 'Should I reserve the 9:10 Nozomi from Tokyo on the 12th?' },
    turns: [
      turn(
        'kyoto-trip',
        'check trains on the 12th',
        '9:10 and 11:30 Nozomi both have seats. Reserve the 9:10?',
        26
      ),
    ],
  },
  {
    kind: 'waiting_yes',
    message: 'sure, same accountant',
    expected: ['tax-2026'],
    followUp: true,
    waiting: { 'tax-2026': 'Do you want to use the same accountant as last year?' },
    turns: [
      turn(
        'tax-2026',
        'start the tax prep checklist',
        'Checklist drafted. Same accountant as last year?',
        28
      ),
    ],
  },
  {
    kind: 'waiting_yes',
    message: 'yes please',
    expected: ['ci-blog'],
    followUp: true,
    waiting: { 'ci-blog': 'Should I send draft 2 to the two reviewers?' },
    turns: [
      turn('ci-blog', 'finish draft 2', 'Draft 2 is done. Send it to the two reviewers?', 20),
      gpuTurn,
    ],
  },
  {
    kind: 'waiting_yes',
    message: 'ok do it',
    expected: ['pr-812'],
    followUp: true,
    waiting: { 'pr-812': 'Should I ask the agent to squash the commits before merging?' },
    turns: [
      turn('pr-812', 'is 812 ready?', 'Approved, but it has 14 commits. Squash before merge?', 30),
      tripTurn,
    ],
  },
  {
    kind: 'waiting_yes',
    message: 'yes — 16 GB',
    expected: ['gpu-box'],
    followUp: true,
    waiting: { 'gpu-box': 'Do you want the 8 GB or the 16 GB card?' },
    turns: [turn('gpu-box', 'pick the card', 'Both are in stock. 8 GB or 16 GB?', 24)],
  },

  {
    kind: 'two_waiting',
    message: 'yes',
    expected: ['main'],
    followUp: true,
    waiting: { 'kyoto-trip': 'Should I book the Gion ryokan?', 'pr-812': 'Should I merge PR 812?' },
    turns: [
      turn('kyoto-trip', 'find a ryokan', 'Found one. Book it?', 20),
      turn('pr-812', 'push 812', 'Green and approved. Merge?', 18),
    ],
  },
  {
    kind: 'two_waiting',
    message: 'yes go ahead',
    expected: ['main'],
    followUp: true,
    waiting: { 'gpu-box': 'Put the build in a cart?', 'ci-blog': 'Send draft 2 to reviewers?' },
    turns: [
      turn('gpu-box', 'finalize parts', 'Ready. Cart it?', 22),
      turn('ci-blog', 'finish draft 2', 'Done. Send it?', 21),
    ],
  },
  {
    kind: 'two_waiting',
    message: '好',
    expected: ['main'],
    followUp: true,
    waiting: {
      'tax-2026': 'Same accountant as last year?',
      'kyoto-trip': 'Reserve the 9:10 Nozomi?',
    },
    turns: [
      turn('tax-2026', 'start tax prep', 'Same accountant?', 26),
      turn('kyoto-trip', 'trains on the 12th', 'Reserve the 9:10?', 25),
    ],
  },
  {
    kind: 'two_waiting',
    message: 'no',
    expected: ['main'],
    followUp: true,
    waiting: { 'pr-812': 'Squash before merge?', 'gpu-box': '8 GB or 16 GB?' },
    turns: [
      turn('pr-812', 'is 812 ready?', 'Squash first?', 3),
      turn('gpu-box', 'pick the card', '8 or 16 GB?', 2),
    ],
  },
  {
    kind: 'two_waiting',
    message: 'yes to the ryokan',
    expected: ['kyoto-trip'],
    followUp: true,
    waiting: { 'kyoto-trip': 'Should I book the Gion ryokan?', 'pr-812': 'Should I merge PR 812?' },
    turns: [
      turn('kyoto-trip', 'find a ryokan', 'Found one. Book it?', 20),
      turn('pr-812', 'push 812', 'Green and approved. Merge?', 18),
    ],
  },
  {
    kind: 'two_waiting',
    message: 'merge it',
    expected: ['pr-812'],
    followUp: true,
    waiting: { 'kyoto-trip': 'Should I book the Gion ryokan?', 'pr-812': 'Should I merge PR 812?' },
    turns: [
      turn('kyoto-trip', 'find a ryokan', 'Found one. Book it?', 20),
      turn('pr-812', 'push 812', 'Green and approved. Merge?', 18),
    ],
  },

  {
    kind: 'one_off',
    message: 'what is 15% of 2,340?',
    expected: ['inbox'],
    followUp: false,
    turns: [prTurn],
  },
  { kind: 'one_off', message: 'convert 30 °C to Fahrenheit', expected: ['inbox'], followUp: false },
  {
    kind: 'one_off',
    message: 'what time is it in Tokyo right now?',
    expected: ['inbox'],
    followUp: false,
    turns: [gpuTurn],
  },
  {
    kind: 'one_off',
    message: 'how do you spell accommodate',
    expected: ['inbox'],
    followUp: false,
  },
  {
    kind: 'one_off',
    message: 'what does HTTP 429 mean?',
    expected: ['inbox'],
    followUp: false,
    turns: [prTurn],
  },
  {
    kind: 'one_off',
    message: 'how many days until December 25?',
    expected: ['inbox'],
    followUp: false,
  },
  {
    kind: 'one_off',
    message: 'give me a regex that matches a US zip code',
    expected: ['inbox'],
    followUp: false,
  },
  {
    kind: 'one_off',
    message: 'who wrote The Left Hand of Darkness?',
    expected: ['inbox'],
    followUp: false,
    turns: [tripTurn],
  },

  {
    kind: 'new_subject',
    message: 'I want to learn Rust this quarter — help me plan it out over the next few weeks',
    expected: ['main'],
    followUp: false,
    turns: [prTurn],
  },
  {
    kind: 'new_subject',
    message: 'let’s plan the team offsite for March',
    expected: ['main'],
    followUp: false,
  },
  {
    kind: 'new_subject',
    message: 'we need to migrate the app database to Postgres 18; scope the work with me',
    expected: ['main'],
    followUp: false,
    turns: [gpuTurn],
  },
  {
    kind: 'new_subject',
    message: 'start tracking my running: I want a 10k plan for spring',
    expected: ['main'],
    followUp: false,
  },
  {
    kind: 'new_subject',
    message: 'my mom’s birthday is in three weeks, help me figure out a gift and a dinner plan',
    expected: ['main'],
    followUp: false,
    turns: [tripTurn],
  },
  {
    kind: 'new_subject',
    message: 'set up a weekly review of my open PRs across all repos',
    expected: ['main'],
    followUp: false,
    turns: [prTurn],
  },
  {
    kind: 'new_subject',
    message:
      'I’m thinking of switching our home internet provider, let’s compare options over the next few days',
    expected: ['main'],
    followUp: false,
  },
  {
    kind: 'new_subject',
    message: 'begin a reading list for distributed systems papers and keep it updated',
    expected: ['main'],
    followUp: false,
  },

  {
    kind: 'thanks',
    message: 'thanks!',
    expected: ['pr-812', 'main'],
    followUp: true,
    turns: [prTurn],
  },
  {
    kind: 'thanks',
    message: 'great, thank you',
    expected: ['kyoto-trip', 'main'],
    followUp: true,
    turns: [tripTurn],
  },
  {
    kind: 'thanks',
    message: '谢谢',
    expected: ['gpu-box', 'main'],
    followUp: true,
    turns: [gpuTurn],
  },
  {
    kind: 'thanks',
    message: 'perfect, thanks',
    expected: ['main'],
    followUp: true,
    turns: [mainTurn],
  },
  {
    kind: 'thanks',
    message: 'ty',
    expected: ['tax-2026', 'main'],
    followUp: true,
    turns: [turn('tax-2026', 'when is the Q4 estimate due?', 'January 15.', 0.1)],
  },
  {
    kind: 'thanks',
    message: 'thanks, that helps',
    expected: ['ci-blog', 'main'],
    followUp: true,
    turns: [turn('ci-blog', 'shorten the conclusion', 'Cut to three sentences.', 0.2)],
  },

  {
    kind: 'long_dictated',
    message:
      'Okay so I was walking around Micro Center yesterday and the guy there said the 5060s keep going in and out of stock, and that the 16 gig one is the one people actually want for local models, but then a friend told me a used 3090 is still the better deal if you don’t mind the power draw and the noise, and honestly the box is going to sit under my desk so noise does matter, and I also don’t want to replace the power supply. So given all that, should I just go with the 5060?',
    expected: ['gpu-box'],
    followUp: true,
    turns: [gpuTurn],
  },
  {
    kind: 'long_dictated',
    message:
      'So I talked to my partner last night and we both kind of feel like the ryokan is the experience we want, even though it’s more expensive, and we would rather spend less on shopping, and the station hotel is convenient but it feels like any hotel anywhere, and we’ll only be in Kyoto once this year. We also want one dinner that is really special. So can you check whether the Gion place can do a kaiseki dinner on the 15th?',
    expected: ['kyoto-trip'],
    followUp: true,
    turns: [tripTurn],
  },
  {
    kind: 'long_dictated',
    message:
      'I keep thinking about how we handle on-call. Right now whoever is around picks up the pager, nobody tracks how many pages each person gets, and last month two people got woken up four nights in a row. I don’t want a heavy process but I do want something fair, maybe a rotation in a shared calendar with a handoff note. Can you help me design a lightweight on-call rotation for a five-person team?',
    expected: ['main'],
    followUp: false,
  },
  {
    kind: 'long_dictated',
    message:
      'Right, so the reviewer bot left that comment about backoff, and I read it again this morning, and I think it’s actually right that we never test the case where the budget runs out halfway through a burst, because the code just stops retrying silently, and that’s exactly the bug we had in production in July. So can you tell the agent to add a test for the budget running out mid-burst?',
    expected: ['pr-812'],
    followUp: true,
    turns: [prTurn],
  },
  {
    kind: 'long_dictated',
    message:
      'I was going through my bank statements, and there were a couple of interest payments from the savings account I opened in the spring that I forgot about, and the brokerage also sent a corrected form last week, so I think last year’s numbers in the checklist are out of date. Do I need to wait for the corrected 1099 before giving anything to the accountant?',
    expected: ['tax-2026'],
    followUp: true,
    turns: [
      turn(
        'tax-2026',
        'did the brokerage 1099-B show up yet?',
        'Not yet; they post it mid-February.',
        6
      ),
    ],
  },
  {
    kind: 'long_dictated',
    message:
      'Quick background: my neighbor asked me to help with his small bakery’s website, which is just a static page right now, and he wants people to be able to order cakes for pickup, nothing fancy, no delivery, and payments can be cash on pickup. I don’t want to build something custom. What is the simplest off-the-shelf way to add pickup ordering?',
    expected: ['main', 'inbox'],
    followUp: false,
  },

  {
    kind: 'mixed_language',
    message: '那个 PR 812 现在 merge 了吗?',
    expected: ['pr-812'],
    followUp: true,
    turns: [prTurn],
  },
  {
    kind: 'mixed_language',
    message: '那现在呢?',
    expected: ['pr-812'],
    followUp: true,
    turns: [prTurn],
  },
  {
    kind: 'mixed_language',
    message: '帮我看看 Gion 的 ryokan 15 号能不能加 kaiseki dinner',
    expected: ['kyoto-trip'],
    followUp: true,
    turns: [tripTurn],
  },
  { kind: 'mixed_language', message: '15% of 2340 是多少', expected: ['inbox'], followUp: false },
  {
    kind: 'mixed_language',
    message: '我们开始一个新项目吧, build a habit tracker app for iOS',
    expected: ['main'],
    followUp: false,
  },
  {
    kind: 'mixed_language',
    message: '5060 的 16G 版本现在多少钱?',
    expected: ['gpu-box'],
    followUp: true,
    turns: [gpuTurn],
  },
  {
    kind: 'mixed_language',
    message: 'blog 那篇的 cost chart 用六月的数据吧',
    expected: ['ci-blog'],
    followUp: true,
    turns: [
      turn(
        'ci-blog',
        'which month should the cost chart start from?',
        'May, the first full month on self-hosted runners.',
        2
      ),
    ],
  },
  { kind: 'mixed_language', message: 'HTTP 429 是什么意思', expected: ['inbox'], followUp: false },
];

const counters = new Map<CaseKind, number>();
const cases = SPECS.map((spec) => {
  const index = (counters.get(spec.kind) ?? 0) + 1;
  counters.set(spec.kind, index);
  return buildCase(spec, index);
});
const out = join(HERE, 'cases', 'synthetic.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(cases, null, 2)}\n`);
console.log(`wrote ${cases.length} synthetic cases to ${out}`);
