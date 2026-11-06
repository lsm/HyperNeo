import { useLayoutEffect, useRef } from 'preact/hooks';
import { NeoQuoteBar } from './NeoQuoteBar.tsx';
import { neoQuoteExcerpt, type NeoQuote } from './neo-intake.ts';
import { neoFlightBox, type NeoFlightRect } from './neo-send-flight.ts';

export type NeoSendFlightRequest = {
  id: string;
  from: NeoFlightRect;
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
  const selector = `[data-pending-ask="${CSS.escape(flight.id)}"], [data-message-ref="${CSS.escape(flight.id)}"]`;
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
      if (row && bubble && ghost.current) {
        started ??= now;
        const progress = Math.min(1, (now - started) / 550);
        const box = neoFlightBox(flight.from, bubble.getBoundingClientRect(), progress);
        row.style.visibility = 'hidden';
        row.style.height = `${row.scrollHeight * box.chrome}px`;
        row.style.overflow = 'hidden';
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
        ghost.current.style.setProperty('--neo-flight-chrome', String(box.chrome));
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
    <div
      ref={ghost}
      data-send-flight={flight.id}
      aria-hidden="true"
      class="neo-send-flight neo-message-user"
      style={{ visibility: 'hidden' }}
    >
      <style>{`${selector} { visibility: hidden !important; }`}</style>
      {flight.quote && (
        <NeoQuoteBar author={flight.quote.author} excerpt={neoQuoteExcerpt(flight.quote.text)} />
      )}
      <p class="whitespace-pre-wrap text-base leading-[inherit]">{flight.words}</p>
    </div>
  );
}
