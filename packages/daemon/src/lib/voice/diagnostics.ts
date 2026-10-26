import { emitStructuredLogEvent } from '../logger.ts';

export function voiceDiagnostic(event: string, metadata: Record<string, unknown>): void {
  emitStructuredLogEvent({
    level: 'info',
    source: 'logger',
    module: 'hyperneo:daemon:voice',
    args: [event],
    metadata,
  });
}

export function voiceSocketReason(code: number): string {
  return (
    (
      {
        1000: 'normal_closure',
        1001: 'going_away',
        1006: 'abnormal_closure',
        1008: 'policy_violation',
        1011: 'server_error',
        1012: 'service_restart',
        1013: 'try_again_later',
      } as Record<number, string>
    )[code] ?? 'socket_closed'
  );
}

export function voicePeerReasonBytes(reason: unknown): number {
  if (typeof reason === 'string') return Buffer.byteLength(reason);
  if (reason instanceof Uint8Array) return reason.byteLength;
  return 0;
}

export function voiceSocketErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' &&
    /^(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|EPIPE|ERR_TLS_CERT_ALTNAME_INVALID|CERT_HAS_EXPIRED|DEPTH_ZERO_SELF_SIGNED_CERT)$/.test(
      code
    )
    ? code
    : 'socket_error';
}
