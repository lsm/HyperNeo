export function joinedSdkMessageBody(body: string, _original: string): string {
  return `${body}.sdk_message`;
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
  return `(SELECT split_body.sdk_message FROM sdk_message_bodies split_body
    WHERE split_body.seq=${rowid})`;
}
