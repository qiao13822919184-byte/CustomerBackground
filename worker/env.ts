export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  RESEARCH: Workflow;
  APP_NAME: string;
  APP_ORIGIN?: string;
  DEFAULT_API_URL: string;
  DEFAULT_MODEL: string;
  ALTERNATE_MODEL: string;
  API_KEY?: string;
  ENCRYPTION_KEY: string;
  BOOTSTRAP_TOKEN: string;
  SEARCH_API_KEY?: string;
  PUBLIC_FETCH?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}
