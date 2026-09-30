import type { CspIdentity, StatusSnapshot } from './types';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    headers: init?.body && typeof init.body === 'string' && !init.headers ? { 'content-type': 'application/json' } : undefined,
    ...init,
  });
  const contentType = res.headers.get('content-type') ?? '';
  const payload = contentType.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    const message = typeof payload === 'string' ? payload : (payload.error ?? payload.message ?? `HTTP ${res.status}`);
    throw new ApiError(message, res.status);
  }
  return payload as T;
}

export interface Meta {
  backend: 'http' | 'mock';
  target: string;
  panel: string;
}

export interface CommandResult {
  ok: boolean;
  message: string;
}

const query = (params: Record<string, string | boolean | undefined>): string => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
};

export const api = {
  meta: () => request<Meta>('/meta'),
  me: () => request<CspIdentity>('/auth/me'),
  login: (user: string, password: string) =>
    request<CspIdentity>('/auth/login', { method: 'POST', body: JSON.stringify({ user, password }) }),
  logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),

  overview: (profile?: string) => request<StatusSnapshot>(`/overview${query({ profile })}`),
  connectors: (profile?: string) => request<StatusSnapshot>(`/connectors${query({ profile })}`),
  sessions: (profile?: string, hideInactive?: boolean) => request<StatusSnapshot>(`/sessions${query({ profile, hideInactive })}`),
  events: (profile?: string) => request<StatusSnapshot>(`/events${query({ profile })}`),
  channels: (profile?: string, all?: boolean) => request<StatusSnapshot>(`/channels${query({ profile, all })}`),
  seen: () => request<StatusSnapshot>('/seen'),
  failures: () => request<StatusSnapshot>('/failures'),
  commands: () => request<StatusSnapshot>('/commands'),

  runCommand: (name: string, params: Record<string, string>) =>
    request<CommandResult>(`/commands/${encodeURIComponent(name)}`, { method: 'POST', body: JSON.stringify(params) }),

  config: () => request<string>('/config'),
  saveConfig: (xml: string) =>
    request<CommandResult>('/config', { method: 'PUT', headers: { 'content-type': 'application/xml' }, body: xml }),
};
