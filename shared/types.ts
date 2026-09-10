export type Role = 'admin' | 'manager' | 'member' | 'viewer';
export interface User { id: string; username: string; display_name: string; role: Role; active: number; daily_limit: number; must_change_password?: number; }
export interface Workspace { id: string; name: string; created_at: string; }
export interface Advertiser { id: string; workspace_id: string; name: string; profile_md: string; version: number; created_at: string; updated_at: string; }
export interface Lead {
  id: string; workspace_id: string; advertiser_id: string; name: string; company: string;
  email: string; phone: string; website: string; country: string; city: string; product: string;
  business_type: string; customization: string; raw: Record<string, unknown>;
  status: string; owner_id: string | null; notes: string; version: number;
  match_level: number | null; priority: number | null; industry: string; fit: string;
  created_at: string; updated_at: string;
}
export interface Evidence { id: string; url: string; title: string; text: string; fetched_at: string; kind: 'page' | 'search' | 'form' | 'attachment'; status: string; query?: string; }
export interface Job { id: string; workspace_id: string; lead_id: string | null; advertiser_id: string; kind: 'research' | 'profile'; status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'; stage: string; error: string | null; created_at: string; updated_at: string; model: string; }
export interface ResearchReport { id: string; lead_id: string; job_id: string; content_md: string; result_json: Record<string, unknown>; evidence: Evidence[]; model: string; profile_version: number; created_at: string; }
export interface AuditEvent { id: string; workspace_id: string; user_id: string; username?: string; action: string; entity_type: string; entity_id: string; details: string; created_at: string; }
export interface ProviderSettings { api_url: string; model: string; alternate_model: string; key_configured: boolean; search_provider: 'bing' | 'brave'; search_key_configured: boolean; max_steps: number; }
export interface MaterialInput { filename: string; mime_type: string; text?: string; data_url?: string; warnings?: string[]; }
