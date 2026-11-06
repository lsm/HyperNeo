export interface JsonRpcRequest<T = unknown> {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: T;
}

interface JsonRpcResponseBase {
  jsonrpc: '2.0';
  id: number | string | null;
}

export type JsonRpcResponse<T = unknown> =
  | ({ result: T } & JsonRpcResponseBase)
  | ({ error: JsonRpcError } & JsonRpcResponseBase);

export interface JsonRpcNotification<T = unknown> {
  jsonrpc: '2.0';
  method: string;
  params?: T;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}
