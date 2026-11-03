export class TransientSpawnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientSpawnError';
  }
}
