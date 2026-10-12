import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { isOperationAdmitted } from './invoke.ts';
import {
  defineOperation,
  type OperationCaller,
  type OperationDefinition,
  type OperationRegistry,
} from './registry.ts';

const SummarySchema = z.object({ name: z.string(), description: z.string() });
const ListInputSchema = z
  .object({ all: z.boolean().optional(), query: z.string().optional() })
  .default({});
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

export function isOperationListed(
  operation: OperationDefinition,
  caller: OperationCaller
): boolean {
  if (caller.source !== 'mcp') return true;
  const policy = operation.policy;
  if (!policy) return true;
  if (policy.safetyClass === 'human_only') return false;
  return !policy.roles || (caller.role !== undefined && policy.roles.includes(caller.role));
}

function matchesOperationQuery(
  operation: Pick<OperationDefinition, 'name' | 'description'>,
  query = ''
): boolean {
  const text = `${operation.name} ${operation.description}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => text.includes(word));
}

export function listOperationSummaries(
  registry: OperationRegistry,
  caller: OperationCaller,
  all = false,
  query?: string
) {
  return registry.entries
    .filter(
      (entry) =>
        isOperationAdmitted(entry, caller) &&
        (all || isOperationListed(entry, caller)) &&
        matchesOperationQuery(entry, query)
    )
    .map(({ name, description }) => ({ name, description }));
}

export function findDescribedOperation(
  registry: OperationRegistry,
  name: string
): { value: OperationDefinition } | { reason: Extract<Description, { found: false }> } {
  const operation = registry.get(name);
  return operation ? { value: operation } : { reason: { found: false, name } };
}

type JsonSchemaNode = {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  items?: JsonSchemaNode;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
};

function signatureType(node: JsonSchemaNode): string {
  if (node.enum) return node.enum.map((value) => JSON.stringify(value)).join('|');
  if (node.const !== undefined) return JSON.stringify(node.const);
  const variants = node.anyOf ?? node.oneOf;
  if (variants) return [...new Set(variants.map(signatureType))].join('|');
  if (node.type === 'array') return `${signatureType(node.items ?? {})}[]`;
  if (node.type === 'object' && node.properties)
    return `{${Object.keys(node.properties).join(', ')}}`;
  return Array.isArray(node.type) ? node.type.join('|') : (node.type ?? 'any');
}

export function operationSignature(
  operation: Pick<OperationDefinition, 'name' | 'inputSchema'>
): string {
  const schema = z.toJSONSchema(operation.inputSchema, { io: 'input' }) as JsonSchemaNode;
  const required = new Set(schema.required ?? []);
  const fields = Object.entries(schema.properties ?? {}).map(
    ([field, node]) => `${field}${required.has(field) ? '' : '?'}: ${signatureType(node)}`
  );
  return `${operation.name} {${fields.join(', ')}}`;
}

export function describeOperationSignatures(
  registry: OperationRegistry,
  names: readonly string[]
): string {
  return names
    .flatMap((name) => {
      const operation = registry.get(name);
      return operation ? [operationSignature(operation)] : [];
    })
    .join('\n');
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
      description:
        'List the operations meant for this session. Pass { all: true } for the full catalog and { query } with keywords to keep only operations whose name or description contains every word; an unlisted operation can still be described and invoked by name.',
      inputSchema: ListInputSchema,
      resultSchema: z.array(SummarySchema),
      execute: async ({ all, query }, caller) =>
        listOperationSummaries(getRegistry(), caller, all, query),
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
