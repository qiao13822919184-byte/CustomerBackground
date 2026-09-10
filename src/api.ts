export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init, credentials: 'include',
    headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('session-expired'));
    throw new ApiError(typeof payload.error === 'string' ? payload.error : `请求失败（${response.status}）`, response.status, typeof payload.code === 'string' ? payload.code : undefined);
  }
  return payload as T;
}
export const post = <T,>(path: string, value: unknown = {}) => api<T>(path, { method: 'POST', body: JSON.stringify(value) });
export const patch = <T,>(path: string, value: unknown) => api<T>(path, { method: 'PATCH', body: JSON.stringify(value) });
export const put = <T,>(path: string, value: unknown) => api<T>(path, { method: 'PUT', body: JSON.stringify(value) });
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试。';
export const time = (value?: string | null) => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
export function downloadText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function safeUrl(value: string): string | undefined {
  try { const url = new URL(value.match(/^https?:\/\//i) ? value : `https://${value}`); return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
}
