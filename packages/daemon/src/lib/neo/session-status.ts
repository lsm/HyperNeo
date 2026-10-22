export function neoSessionStatus(processingState: string | undefined): string | null {
  if (!processingState) return null;
  try {
    const status = (JSON.parse(processingState) as { status?: unknown } | null)?.status;
    return typeof status === 'string' ? status : null;
  } catch {
    return null;
  }
}
