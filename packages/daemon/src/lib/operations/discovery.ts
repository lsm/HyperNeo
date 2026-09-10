import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { defineOperation, type OperationDefinition, type OperationRegistry } from './registry.ts';

const SummarySchema = z.object({ name: z.string(), description: z.string() });
const DescriptionSchema = z.discriminatedUnion('found', [
  z.object({
    found: z.literal(true),
    name: z.string(),
    description: z.string(),
    inputSchema: z.record(z.string(), z.unknown()),
    resultSchema: z.record(z.string(), z.unknown()),
  }),
  z.object({ found: z.literal(false), name: z.string() }),
]);
type Description = z.infer<typeof DescriptionSchema>;

export function listOperationSummaries(registry: OperationRegistry) {
  return registry.entries.map(({ name, description }) => ({ name, description }));
}

export function findDescribedOperation(
  registry: OperationRegistry,
  name: string
): { value: OperationDefinition } | { reason: Extract<Description, { found: false }> } {
  const operation = registry.get(name);
  return operation ? { value: operation } : { reason: { found: false, name } };
}

export function describeOperationDefinition(operation: OperationDefinition): Description {
  return {
    found: true,
    name: operation.name,
    description: operation.description,
    inputSchema: z.toJSONSchema(operation.inputSchema, { io: 'input' }),
    resultSchema: z.toJSONSchema(operation.resultSchema, { io: 'output' }),
  };
}

const describeOperation = (superpipe({})('describe-operation') as PipelineAPI)
  .input(['registry', 'name'])
  .pipe(findDescribedOperation, ['registry', 'name'], 'result:description')
  .pipe(describeOperationDefinition, 'description', 'description')
  .end('description') as (registry: OperationRegistry, name: string) => Description;

export function createDiscoveryOperations(
  getRegistry: () => OperationRegistry
): OperationDefinition[] {
  return [
    defineOperation({
      name: 'operations.list',
      description: 'List operations available in this catalog.',
      inputSchema: z.object({}),
      resultSchema: z.array(SummarySchema),
      execute: async () => listOperationSummaries(getRegistry()),
    }),
    defineOperation({
      name: 'operations.describe',
      description: 'Describe an operation and its input and result schemas.',
      inputSchema: z.object({ name: z.string().min(1) }),
      resultSchema: DescriptionSchema,
      execute: async ({ name }) => describeOperation(getRegistry(), name),
    }),
  ];
}
