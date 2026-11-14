import superpipe, { type PipelineAPI } from 'superpipe';
import { isAdvertisedToProfile } from '../tools/session-tool-profiles.ts';
import { z } from 'zod';
import { compactNeoDiscovery, CompactDiscoverySchema } from './neo-discovery.ts';
import { isOperationAdmitted } from './invoke.ts';
import {
  enabledOperationPacks,
  defineOperation,
  type OperationCaller,
  type OperationDefinition,
  type OperationRegistry,
} from './registry.ts';

const SummarySchema = z.object({ name: z.string(), description: z.string() });
const ListInputSchema = z
  .object({
    all: z.boolean().optional(),
    query: z.string().optional(),
    prefix: z
      .string()
      .regex(/^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)*\.?$/)
      .describe('Neo MCP only. Other callers ignore paging and keep the legacy array response.')
      .optional(),
    cursor: z
      .string()
      .min(1)
      .describe(
        'Neo MCP only. Without prefix, Neo returns namespace counts and ignores cursor. Other callers ignore paging and keep the legacy array response.'
      )
      .optional(),
  })
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
  if (!isAdvertisedToProfile(operation.name, caller.profile)) return false;
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
  const enabled = caller.role === 'neo' ? enabledOperationPacks(registry) : [];
  return registry.entries
    .filter(
      (entry) =>
        isOperationAdmitted(entry, caller, enabled) &&
        (caller.source !== 'mcp' || isAdvertisedToProfile(entry.name, caller.profile)) &&
        (all || isOperationListed(entry, caller)) &&
        matchesOperationQuery(entry, query)
    )
    .map(({ name, description }) => ({ name, description }));
}

type ListInput = z.infer<typeof ListInputSchema>;
function isNeoDiscovery(caller: OperationCaller): boolean {
  return caller.source === 'mcp' && caller.role === 'neo';
}
function discoverySummaries(
  registry: OperationRegistry,
  caller: OperationCaller,
  input: ListInput
) {
  return listOperationSummaries(registry, caller, isNeoDiscovery(caller) || input.all, input.query);
}
function renderDiscovery(
  summaries: ReturnType<typeof listOperationSummaries>,
  caller: OperationCaller,
  input: ListInput
) {
  return isNeoDiscovery(caller)
    ? compactNeoDiscovery(summaries, input.prefix, input.cursor)
    : summaries;
}
const listOperations = (superpipe({})('list-operations') as PipelineAPI)
  .input(['registry', 'caller', 'input'])
  .pipe(discoverySummaries, ['registry', 'caller', 'input'], 'summaries')
  .pipe(renderDiscovery, ['summaries', 'caller', 'input'], 'listing')
  .end('listing') as (
  registry: OperationRegistry,
  caller: OperationCaller,
  input: ListInput
) => ReturnType<typeof renderDiscovery>;

export function findDescribedOperation(
  registry: OperationRegistry,
  name: string,
  caller?: OperationCaller
): { value: OperationDefinition } | { reason: Extract<Description, { found: false }> } {
  const operation = registry.get(name);
  const enabled = caller?.role === 'neo' ? enabledOperationPacks(registry) : [];
  return operation &&
    (!caller || caller.role !== 'neo' || isOperationAdmitted(operation, caller, enabled))
    ? { value: operation }
    : { reason: { found: false, name } };
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

function signatureType(node: JsonSchemaNode, compact = false): string {
  if (node.enum) return node.enum.map((value) => JSON.stringify(value)).join('|');
  if (node.const !== undefined) return JSON.stringify(node.const);
  const variants = node.anyOf ?? node.oneOf;
  if (variants) {
    if (compact && variants.every((variant) => variant.properties)) {
      const first = variants[0];
      const common = Object.fromEntries(
        Object.entries(first.properties ?? {}).filter(([field, child]) =>
          variants.every(
            (variant) =>
              JSON.stringify(variant.properties?.[field]) === JSON.stringify(child) &&
              (variant.required ?? []).includes(field) === (first.required ?? []).includes(field)
          )
        )
      );
      if (Object.keys(common).length) {
        const rest = variants.map((variant) => ({
          ...variant,
          properties: Object.fromEntries(
            Object.entries(variant.properties ?? {}).filter(([field]) => !(field in common))
          ),
        }));
        return `${signatureType({ ...first, properties: common }, true)}&(${rest.map((variant) => signatureType(variant, true)).join('|')})`;
      }
    }
    return [...new Set(variants.map((variant) => signatureType(variant, compact)))].join('|');
  }
  if (node.type === 'array') {
    const item = signatureType(node.items ?? {}, compact);
    return `${item.includes('|') ? `(${item})` : item}[]`;
  }
  if (node.type === 'object' && node.properties) return `{${signatureFields(node, compact)}}`;
  return Array.isArray(node.type) ? node.type.join('|') : (node.type ?? 'any');
}

function signatureFields(node: JsonSchemaNode, compact = false): string {
  const required = new Set(node.required ?? []);
  return Object.entries(node.properties ?? {})
    .map(
      ([field, child]) =>
        `${field}${required.has(field) ? '' : '?'}${compact && child.type === 'string' && !child.enum && child.const === undefined ? '' : `${compact ? ':' : ': '}${signatureType(child, compact)}`}`
    )
    .join(compact ? ',' : ', ');
}

export function operationSignature(
  operation: Pick<OperationDefinition, 'name' | 'inputSchema'>,
  compact = false
): string {
  const schema = z.toJSONSchema(operation.inputSchema, { io: 'input' }) as JsonSchemaNode;
  return `${operation.name} ${signatureType(schema, compact)}`;
}

export function describeOperationDefinition(
  operation: OperationDefinition,
  caller?: OperationCaller
): Description {
  return {
    found: true,
    name: operation.name,
    description:
      operation.name === 'operations.list' && caller && isNeoDiscovery(caller)
        ? 'List admitted rare operations as namespace counts. Pass { prefix, cursor? } for pages of at most 20 names. all: true stays compact. Pass { query } to filter by keywords. Use operations.describe { name } for one operation schema. Caller and pack restrictions always apply.'
        : operation.description,
    inputSchema: z.toJSONSchema(operation.inputSchema, { io: 'input' }),
    resultSchema: z.toJSONSchema(operation.resultSchema, { io: 'output' }),
  };
}

const describeOperation = (superpipe({})('describe-operation') as PipelineAPI)
  .input(['registry', 'name', 'caller'])
  .pipe(findDescribedOperation, ['registry', 'name', 'caller'], 'result:description')
  .pipe(describeOperationDefinition, ['description', 'caller'], 'description')
  .end('description') as (
  registry: OperationRegistry,
  name: string,
  caller: OperationCaller
) => Description;

export function createDiscoveryOperations(
  getRegistry: () => OperationRegistry
): OperationDefinition[] {
  return [
    defineOperation({
      name: 'operations.list',
      description:
        'List operations available to this caller and advertised by the session tool profile. Pass { all: true } to include eligible operations omitted from the default list. Pass { query } with keywords to keep only operations whose name or description contains every word. Caller and pack restrictions apply even with all: true.',
      inputSchema: ListInputSchema,
      resultSchema: z.union([z.array(SummarySchema), CompactDiscoverySchema]),
      execute: async (input, caller) => listOperations(getRegistry(), caller, input),
    }),
    defineOperation({
      name: 'operations.describe',
      description: 'Describe an operation and its input and result schemas.',
      inputSchema: z.object({ name: z.string().min(1) }),
      resultSchema: DescriptionSchema,
      execute: async ({ name }, caller) => describeOperation(getRegistry(), name, caller),
    }),
  ];
}
