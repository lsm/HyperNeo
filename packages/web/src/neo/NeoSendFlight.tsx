import { useLayoutEffect, useRef } from 'preact/hooks';
import { NeoFileChip } from './NeoAttachments.tsx';
import { NeoQuoteBar } from './NeoQuoteBar.tsx';
import { neoQuoteExcerpt, type NeoQuote } from './neo-intake.ts';
import { neoFlightBox, type NeoFlightOrigin } from './neo-send-flight.ts';

export type NeoSendFlightRequest = {
  id: string;
  from: NeoFlightOrigin;
  words: string;
  quote?: NeoQuote;
};

export function NeoSendFlight({
  flight,
  onDone,
}: {
  flight: NeoSendFlightRequest;
  onDone: () => void;
}) {
  const ghost = useRef<HTMLDivElement>(null);
  const mediaGhosts = useRef<(HTMLDivElement | null)[]>([]);
  const media = flight.from.media ?? [];
  const selector = `[data-pending-ask="${CSS.escape(flight.id)}"], [data-message-ref="${CSS.escape(flight.id)}"]`;
  const hiddenRule = `${selector} { visibility: hidden !important; }`;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  useLayoutEffect(() => {
    if (reduced) {
      onDone();
      return;
    }
    const created = performance.now();
    let started: number | undefined;
    let frame = 0;
    let held: HTMLElement | null = null;
    let original = { height: '', visibility: '', overflow: '' };
    const release = () => {
      if (held) Object.assign(held.style, original);
      held = null;
    };
    const finish = () => {
      release();
      onDone();
    };
    const step = (now: number) => {
      if (now - created >= 2000) {
        finish();
        return;
      }
      const row = document.querySelector<HTMLElement>(selector);
      if (row !== held) {
        release();
        held = row;
        if (held)
          original = {
            height: held.style.height,
            visibility: held.style.visibility,
            overflow: held.style.overflow,
          };
      }
      const bubble = row?.querySelector<HTMLElement>('.neo-message-bubble');
      const targets = media.map((item) =>
        row?.querySelector<HTMLElement>(`[data-flight="${item.target}"]`)?.getBoundingClientRect()
      );
      if (row && (bubble || targets.some(Boolean))) {
        started ??= now;
        const progress = Math.min(1, (now - started) / 550);
        const box = neoFlightBox(
          flight.from,
          bubble?.getBoundingClientRect() ?? flight.from,
          progress
        );
        row.style.visibility = 'hidden';
        row.style.height = `${row.scrollHeight * box.chrome}px`;
        row.style.overflow = 'hidden';
        if (bubble && ghost.current)
          Object.assign(ghost.current.style, {
            visibility: 'visible',
            left: `${box.x}px`,
            top: `${box.y}px`,
            width: `${box.width}px`,
            height: `${box.height}px`,
            padding: `${12 * box.chrome}px ${16 * box.chrome}px`,
            borderWidth: `${box.chrome}px`,
            lineHeight: String(1.625 + 0.075 * box.chrome),
            borderTopRightRadius: `${16 - 14 * box.chrome}px`,
          });
        ghost.current?.style.setProperty('--neo-flight-chrome', String(box.chrome));
        media.forEach((item, index) => {
          const node = mediaGhosts.current[index];
          const target = targets[index];
          if (!node || !target) return;
          const mediaBox = neoFlightBox(item.from, target, progress);
          Object.assign(node.style, {
            visibility: 'visible',
            left: `${mediaBox.x}px`,
            top: `${mediaBox.y}px`,
            width: `${mediaBox.width}px`,
            height: `${mediaBox.height}px`,
            borderRadius: `${item.file.kind === 'image' ? 8 + 4 * mediaBox.chrome : 12}px`,
          });
        });
        if (progress === 1) {
          finish();
          return;
        }
      } else if (started !== undefined && now - started >= 550) {
        finish();
        return;
      }
      frame = requestAnimationFrame(step);
    };
    step(created);
    return () => {
      cancelAnimationFrame(frame);
      release();
    };
  }, [flight]);
  if (reduced) return null;
  return (
    <div data-send-flight={flight.id} aria-hidden="true" class="contents">
      <style>{hiddenRule}</style>
      {(flight.words || flight.quote) && (
        <div
          ref={ghost}
          data-flight-words
          class="neo-send-flight neo-message-user"
          style={{ visibility: 'hidden' }}
        >
          {flight.quote && (
            <NeoQuoteBar
              author={flight.quote.author}
              excerpt={neoQuoteExcerpt(flight.quote.text)}
            />
          )}
          <p class="whitespace-pre-wrap text-base leading-[inherit]">{flight.words}</p>
        </div>
      )}
      {media.map((item, index) => (
        <div
          key={item.target}
          ref={(node) => {
            mediaGhosts.current[index] = node;
          }}
          data-flight-ghost={item.target}
          class={`fixed z-[60] pointer-events-none overflow-hidden ${item.file.kind === 'text' ? 'flex items-center gap-2 border border-line bg-surface px-2 py-2 text-left' : ''}`}
          style={{ visibility: 'hidden' }}
        >
          {item.file.kind === 'image' ? (
            <img
              src={`data:${item.file.image.media_type};base64,${item.file.image.data}`}
              alt=""
              class="h-full w-full object-cover"
            />
          ) : (
            <NeoFileChip
              name={item.file.name}
              size={new TextEncoder().encode(item.file.text).length}
            />
          )}
        </div>
      ))}
    </div>
  );
}
