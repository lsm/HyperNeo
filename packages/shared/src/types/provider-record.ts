export type ProviderKind = 'built_in' | 'custom_endpoint';
export type ProviderAuthType = 'api_key' | 'oauth' | 'none';
export type ProviderHealthStatus = 'unknown' | 'healthy' | 'unhealthy';

export interface ProviderRecord {
  id: string;
  providerId: string;
  displayName: string;
  kind: ProviderKind;
  authType: ProviderAuthType;
  isEnabled: boolean;
  isDefault: boolean;
  sortOrder: number;
  baseUrl?: string;
  configJson?: string;
  customEndpointConfigJson?: string;
  healthStatus: ProviderHealthStatus;
  lastHealthCheckAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateProviderParams {
  providerId: string;
  displayName: string;
  kind: ProviderKind;
  authType: ProviderAuthType;
  isEnabled?: boolean;
  isDefault?: boolean;
  sortOrder: number;
  baseUrl?: string;
  configJson?: string;
  customEndpointConfigJson?: string;
  healthStatus?: ProviderHealthStatus;
  lastHealthCheckAt?: number;
}

export interface UpdateProviderParams {
  providerId?: string;
  displayName?: string;
  kind?: ProviderKind;
  authType?: ProviderAuthType;
  isEnabled?: boolean;
  isDefault?: boolean;
  sortOrder?: number;
  baseUrl?: string;
  configJson?: string;
  customEndpointConfigJson?: string;
  healthStatus?: ProviderHealthStatus;
  lastHealthCheckAt?: number;
}
