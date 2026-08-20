import superpipe, { type PipelineAPI } from 'superpipe';

type Undecided<Ctx> = Omit<Ctx, 'decision'>;

export function decisionRun<Ctx extends { decision: unknown }>(
  name: string,
  gates: ReadonlyArray<(ctx: Ctx) => Ctx>
): (input: Undecided<Ctx>) => Ctx {
  let pipeline = (
    superpipe<{ hasDecided: (ctx: Ctx) => boolean }>({
      hasDecided: (ctx: Ctx): boolean => ctx.decision !== null,
    })(name) as PipelineAPI
  ).input(['ctx']);
  for (const gate of gates) {
    pipeline = pipeline.pipe(gate, 'ctx', 'ctx').pipe('!hasDecided', 'ctx');
  }
  const run = pipeline.end('ctx');
  return (input: Undecided<Ctx>): Ctx => run({ ...input, decision: null }) as Ctx;
}
