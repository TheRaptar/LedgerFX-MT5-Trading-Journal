import type {
  AIInsightsResponse,
  BootstrapPayload,
  CalendarEventMarker,
  DailyJournalEntry,
  PeriodicReview,
  TradeJournalEntry,
  UserSettings,
} from '../shared/types.ts';

// Session token is held strictly in JS memory (never localStorage or sessionStorage)
let inMemoryToken: string | null = null;
let onUnauthorizedHandler: (() => void) | null = null;

export function setAuthToken(token: string | null): void {
  inMemoryToken = token;
}

export function getAuthToken(): string | null {
  return inMemoryToken;
}

export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorizedHandler = fn;
}

async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers ?? {});
  if (init?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (inMemoryToken) {
    headers.set('Authorization', `Bearer ${inMemoryToken}`);
  }

  const res = await fetch(url, { ...init, headers });
  const data = await res.json().catch(() => ({}));

  if (res.status === 401 && url !== '/api/auth/login' && url !== '/api/auth/status') {
    inMemoryToken = null;
    if (onUnauthorizedHandler) onUnauthorizedHandler();
  }

  if (!res.ok) {
    const errMsg = typeof data?.error === 'string' ? data.error : `Request failed (${res.status})`;
    const error = new Error(errMsg) as Error & { payload?: BootstrapPayload; status?: number };
    error.status = res.status;
    if (data?.payload) error.payload = data.payload;
    throw error;
  }

  return data as T;
}

export interface AuthStatusResponse {
  initialized: boolean;
  envProtected: boolean;
  authenticated: boolean;
  sessionTimeoutMinutes: number;
}

export const api = {
  getAuthStatus: () => apiRequest<AuthStatusResponse>('/api/auth/status'),
  setupVault: (password: string) =>
    apiRequest<{ token: string }>('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  login: (password: string) =>
    apiRequest<{ token: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  logout: () => apiRequest<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

  bootstrap: () => apiRequest<BootstrapPayload>('/api/bootstrap'),

  linkAccount: (body: {
    friendlyName: string;
    accountLogin: string;
    brokerName: string;
    brokerServer: string;
    environment: 'live' | 'demo';
    accountMode: 'hedging' | 'netting';
    currency: string;
    leverage: number;
    serverTimeZone: string;
    serverUtcOffsetLabel: string;
    connectionType: 'collector' | 'bridge_https' | 'mt5_sandbox' | 'csv_import';
    bridgeUrl?: string;
    emptyHistory?: boolean;
  }) =>
    apiRequest<BootstrapPayload>('/api/accounts', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  createIngestToken: (id: string) =>
    apiRequest<{ token: string; ingestUrl: string; payload: BootstrapPayload }>(
      `/api/accounts/${encodeURIComponent(id)}/ingest-token`,
      { method: 'POST' },
    ),

  updateAccount: (
    id: string,
    body: {
      friendlyName?: string;
      leverage?: number;
      bridgeUrl?: string;
      serverTimeZone?: string;
      serverUtcOffsetLabel?: string;
    },
  ) =>
    apiRequest<BootstrapPayload>(`/api/accounts/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  unlinkAccount: (id: string) =>
    apiRequest<BootstrapPayload>(`/api/accounts/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  syncAccount: (
    id: string,
    options?: { mode?: 'incremental' | 'reimport'; simulatePartialFailure?: boolean },
  ) =>
    apiRequest<{ importedDealsCount: number; message: string; payload: BootstrapPayload }>(
      `/api/accounts/${encodeURIComponent(id)}/sync`,
      {
        method: 'POST',
        body: JSON.stringify(options ?? {}),
      },
    ),

  importCsv: (id: string, csvText: string) =>
    apiRequest<{
      newDeals: number;
      newOps: number;
      warnings: string[];
      payload: BootstrapPayload;
    }>(`/api/accounts/${encodeURIComponent(id)}/import-csv`, {
      method: 'POST',
      body: JSON.stringify({ csvText }),
    }),

  saveTradeJournal: (
    accountId: string,
    positionId: number,
    entry: Omit<TradeJournalEntry, 'accountId' | 'positionId' | 'updatedAtUtc'>,
  ) =>
    apiRequest<BootstrapPayload>(
      `/api/trades/${encodeURIComponent(accountId)}/${encodeURIComponent(String(positionId))}/journal`,
      {
        method: 'PUT',
        body: JSON.stringify(entry),
      },
    ),

  saveDailyJournal: (date: string, entry: Omit<DailyJournalEntry, 'date' | 'updatedAtUtc'>) =>
    apiRequest<BootstrapPayload>(`/api/daily-journal/${encodeURIComponent(date)}`, {
      method: 'PUT',
      body: JSON.stringify(entry),
    }),

  savePeriodicReview: (id: string, review: Omit<PeriodicReview, 'id' | 'updatedAtUtc'>) =>
    apiRequest<BootstrapPayload>(`/api/reviews/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(review),
    }),

  addCalendarEvent: (event: Omit<CalendarEventMarker, 'id'>) =>
    apiRequest<BootstrapPayload>('/api/calendar-events', {
      method: 'POST',
      body: JSON.stringify(event),
    }),

  deleteCalendarEvent: (id: string) =>
    apiRequest<BootstrapPayload>(`/api/calendar-events/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  saveSettings: (settings: Partial<UserSettings>) =>
    apiRequest<BootstrapPayload>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),

  generateAiInsights: (accountId: string, focusArea?: string) =>
    apiRequest<AIInsightsResponse>('/api/ai/insights', {
      method: 'POST',
      body: JSON.stringify({ accountId, focusArea }),
    }),

  exportBackup: () =>
    apiRequest<{ exportedAtUtc: string; schemaVersion: number; note: string; data: BootstrapPayload }>(
      '/api/backup/export',
    ),

  restoreBackup: (backupEnvelope: { data: BootstrapPayload }) =>
    apiRequest<BootstrapPayload>('/api/backup/restore', {
      method: 'POST',
      body: JSON.stringify(backupEnvelope),
    }),

  eraseAllData: () =>
    apiRequest<BootstrapPayload>('/api/data/erase-all', {
      method: 'DELETE',
    }),
};
