import type { ChatMessage } from '@hyperneo/shared';
import { useState } from 'preact/hooks';
import { resolvedTheme } from '../lib/theme.ts';
import { NeoMessage } from './NeoMessage.tsx';
import './neo.css';

export const markdownExamples = [
  {
    type: 'user',
    text: [
      '## A relaxed Sunday book club',
      'Help me plan for **8 people**, with *no paid venue*. Keep the invitation warm, not formal.',
      '> A good afternoon is one where everyone gets a word in.',
      '- [x] Sunday afternoon\n- [x] A free living room\n- [ ] Pick the first book',
      '| Constraint | Preference |\n| --- | --- |\n| Time | 3–4:15 PM |\n| Food | Tea + something simple |',
      'Use `maxGuests = 8`. Here is the little plan I started:',
      '```json\n{ "guests": 8, "budget": 0, "day": "Sunday" }\n```',
      '1. Suggest a loose agenda.\n2. Give us three discussion prompts.',
      '~~Book a restaurant~~ — let’s stay home. See [Project Gutenberg](https://www.gutenberg.org/) for free reading.',
    ].join('\n\n'),
  },
  {
    type: 'assistant',
    text: [
      '## Keep it simple, and leave room to talk',
      '**My suggestion:** a 75-minute first meeting. No bookings, purchases, or invitations have been sent.',
      '### A plan you can change',
      '| When | What happens |\n| --- | --- |\n| 3:00 | Tea and introductions |\n| 3:15 | Choose a book together |\n| 3:35 | Try the three prompts below |\n| 4:05 | Pick the next date |',
      '1. What makes a book worth discussing?\n2. Would you rather **vote**, rotate picks, or follow a theme?\n3. How much reading feels *realistic*, not aspirational?',
      '> The only decision needed now: one host each time, or rotate?',
      '- [x] Eight people and a free venue\n- [ ] Your choice of host\n- [ ] A book everyone can access',
      '### If you want a reusable little reminder',
      '```js\nconst meetup = { guests: 8, minutes: 75 };\nconst reminder = `Bring one book idea for ${meetup.guests} readers.`;\n```',
      'Keep `budget` at **0**. Browse [free books](https://www.gutenberg.org/) when you’re ready.',
      '---\nNothing to organize yet. Just tell me which hosting option you prefer.',
    ].join('\n\n'),
  },
] as const;

export function NeoExamples() {
  const [theme, setTheme] = useState(resolvedTheme.value);
  return (
    <div data-theme={theme} class="neo-shell h-dvh overflow-y-auto text-fg">
      <main class="mx-auto max-w-3xl space-y-8 px-5 py-8">
        <header>
          <a href="/neo" class="text-sm text-accent">
            ← Back to Neo
          </a>
          <h1 class="mt-4 text-2xl font-medium">Message examples</h1>
          <div role="group" aria-label="Preview theme" class="mt-3 flex gap-2">
            {(['dark', 'light'] as const).map((value) => (
              <button
                type="button"
                aria-pressed={theme === value}
                onClick={() => setTheme(value)}
                class={`rounded-lg border px-3 py-1.5 text-xs ${theme === value ? 'border-accent text-accent' : 'border-line text-fg-muted'}`}
              >
                {value === 'dark' ? 'Dark' : 'Light'}
              </button>
            ))}
          </div>
          <p class="mt-2 text-sm text-fg-muted">
            Sample content only. These messages are not saved or sent.
          </p>
        </header>
        {markdownExamples.map((example) => (
          <NeoMessage
            key={example.type}
            message={
              {
                type: example.type,
                timestamp: new Date(2026, 8, 25, 15, 30).getTime(),
              } as unknown as ChatMessage
            }
            text={example.text}
          />
        ))}
      </main>
    </div>
  );
}
