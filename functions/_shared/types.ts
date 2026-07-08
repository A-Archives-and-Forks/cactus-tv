export interface Env {
  DB?: D1Database;
  PROVIDERS_JSON?: string;
  ADMIN_TOKEN?: string;
  TMDB_BEARER_TOKEN?: string;
  DOUBAN_METADATA_URL?: string;
  SITE_NAME?: string;
}

export interface AppData {
  requestId?: string;
}

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  priority: number;
  proxyEnabled: boolean;
  mediaHosts: string[];
  requestHeaders: Record<string, string>;
  createdAt?: string;
  updatedAt?: string;
}
