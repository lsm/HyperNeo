export interface ProviderRecord {
  id: string;
  providerId: string;
  displayName: string;
  kind: 'built_in' | 'custom_endpoint';
  authType: 'api_key' | 'oauth' | 'none';
  isEnabled: boolean;
  isDefault: boolean;
  sortOrder: number;
  baseUrl?: string;
  configJson?: string;
  customEndpointConfigJson?: string;
  healthStatus: 'unknown' | 'healthy' | 'unhealthy';
  lastHealthCheckAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateProviderParams {
  providerId: string;
  displayName: string;
  kind: 'built_in' | 'custom_endpoint';
  authType: 'api_key' | 'oauth' | 'none';
  isEnabled?: boolean;
  isDefault?: boolean;
  sortOrder?: number;
  baseUrl?: string;
  configJson?: string;
  customEndpointConfigJson?: string;
}

export interface UpdateProviderParams {
  displayName?: string;
  authType?: 'api_key' | 'oauth' | 'none';
  isEnabled?: boolean;
  isDefault?: boolean;
  sortOrder?: number;
  baseUrl?: string;
  configJson?: string;
  customEndpointConfigJson?: string;
  healthStatus?: 'unknown' | 'healthy' | 'unhealthy';
  lastHealthCheckAt?: number;
}
