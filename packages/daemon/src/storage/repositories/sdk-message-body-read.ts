export function hydrateSdkMessageBodies(selection: string, orderBy = ''): string {
  return `WITH body_selection AS MATERIALIZED (${selection})
    SELECT body_selection.*, COALESCE(body.sdk_message, original.sdk_message) AS sdk_message
    FROM body_selection
    JOIN sdk_messages original ON original.rowid = body_selection.body_seq
    LEFT JOIN sdk_message_bodies body ON body.seq = body_selection.body_seq
    ${orderBy ? `ORDER BY ${orderBy}` : ''}`;
}
