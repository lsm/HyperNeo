export interface GateDataShapeField {
  name: string;
  type: string;
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
  switch (field.type) {
    case 'string':
      return `"<${field.name}>"`;
    case 'number':
      return '<number>';
    case 'boolean':
      return '<boolean>';
    case 'map':
      return '{ "<key>": "<value>" }';
    default:
      return '<value>';
  }
}
