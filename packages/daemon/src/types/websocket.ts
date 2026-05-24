/**
 * WebSocket Type Definitions for Bun Native WebSocket
 *
 * These types provide proper typing for WebSocket handlers with custom data storage.
 * Uses Bun's native ServerWebSocket<T> with typed data property.
 */

/**
 * WebSocket data stored on each connection via ws.data
 * This replaces the old pattern of mutating ws.__clientId
 */
export interface WebSocketData {
  /** Initial connection session (always 'global') */
  connectionSessionId: string;
  /** Client ID assigned by the transport for routing and cleanup */
  clientId?: string;
}
