export type AppMcpServerSourceType = 'stdio' | 'sse' | 'http';

export type AppMcpServerSource = 'builtin' | 'user' | 'imported';

export interface AppMcpServer {
  id: string;
  name: string;
  description?: string;
  sourceType: AppMcpServerSourceType;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
  source: AppMcpServerSource;
  sourcePath?: string;
  createdAt?: number;
  updatedAt?: number;
}

export type CreateAppMcpServerRequest = Omit<AppMcpServer, 'id' | 'enabled' | 'source'> & {
  enabled?: boolean;
  source?: AppMcpServerSource;
};

export type UpdateAppMcpServerRequest = { id: string } & Partial<Omit<AppMcpServer, 'id'>>;
