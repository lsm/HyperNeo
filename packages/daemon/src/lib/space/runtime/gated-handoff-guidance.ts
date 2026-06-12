export interface GateDataShapeField {
  name: string;
  type: string;
  check?: {
    op: string;
    value?: unknown;
    match?: unknown;
    min?: number;
  };
}

export function getSendMessageTargets(
  target: string | string[],
  broadcastTargets: readonly string[] = []
): string[] {
  const targets = Array.isArray(target) ? target : [target];
  return [...new Set(targets.flatMap((item) => (item === '*' ? broadcastTargets : [item])))];
}

export function formatGatedHandoffCall(
  target: string,
  fields: readonly GateDataShapeField[]
): string {
  return `send_message(target=${JSON.stringify(target)}, message="<short summary>", data: ${formatGateDataShape(fields)})`;
}

function formatGateDataShape(fields: readonly GateDataShapeField[]): string {
  const entries = fields.map(
    (field) => `${JSON.stringify(field.name)}: ${formatGateDataPlaceholder(field)}`
  );
  return `{ ${entries.join(', ')} }`;
}

function formatGateDataPlaceholder(field: GateDataShapeField): string {
  if (field.check?.op === '==') return formatLiteral(field.check.value);

  switch (field.type) {
    case 'string':
      return JSON.stringify(`<${field.name}>`);
    case 'number':
      return field.check?.op === '!=' && field.check.value === 0 ? '1' : '0';
    case 'boolean':
      return field.check?.op === '!=' && field.check.value === true ? 'false' : 'true';
    case 'map':
      return formatMapPlaceholder(field);
    default:
      return 'null';
  }
}

function formatMapPlaceholder(field: GateDataShapeField): string {
  if (field.check?.op !== 'count') return '{ "<key>": "<value>" }';

  const matchValue = formatLiteral(field.check.match);
  const count = Math.max(1, field.check.min ?? 1);
  const entries = Array.from(
    { length: count },
    (_, index) => `${JSON.stringify(`<key${index + 1}>`)}: ${matchValue}`
  );
  return `{ ${entries.join(', ')} }`;
}

function formatLiteral(value: unknown): string {
  const literal = JSON.stringify(value);
  return literal === undefined ? 'null' : literal;
}
