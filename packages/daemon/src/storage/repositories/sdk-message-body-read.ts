export function joinedSdkMessageBody(body: string, original: string): string {
  return `COALESCE(${body}.sdk_message, ${original}.sdk_message)`;
}

export function hydrateSdkMessageBodies(selection: string, orderBy = ''): string {
  return `WITH body_selection AS MATERIALIZED (${selection})
    SELECT body_selection.*, ${joinedSdkMessageBody('body', 'original')} AS sdk_message
    FROM body_selection
    JOIN sdk_messages original ON original.rowid = body_selection.body_seq
    LEFT JOIN sdk_message_bodies body ON body.seq = body_selection.body_seq
    ${orderBy ? `ORDER BY ${orderBy}` : ''}`;
}

export function sdkMessageBodyAt(rowid: string): string {
  return `(SELECT ${joinedSdkMessageBody('split_body', 'split_legacy')}
    FROM sdk_messages split_legacy LEFT JOIN sdk_message_bodies split_body ON split_body.seq=split_legacy.rowid
    WHERE split_legacy.rowid=${rowid})`;
}
