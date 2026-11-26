import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import {
  DEFAULT_SETTINGS,
  type BalanceOperation,
  type CalendarEventMarker,
  type DailyJournalEntry,
  type MT5Account,
  type MT5Deal,
  type PeriodicReview,
  type TradeJournalEntry,
  type UserSettings,
} from './src/shared/types.ts';
import { buildClosedTrades, parseMT5CsvDeals } from './src/shared/mt5Engine.ts';
import { computePerformanceMetrics } from './src/shared/metricsEngine.ts';
import {
  generateSessionToken,
  hashPassword,
  hashSessionToken,
  timingSafeStringEqual,
  validateSafeBridgeUrl,
  verifyPassword,
} from './server/crypto.ts';
import {
  appendAuditLog,
  createSessionRecord,
  deleteSessionRecord,
  getDb,
  getUserSettings,
  insertAccountRow,
  loadBootstrapPayload,
  recalculateAccountBalances,
  saveUserSettings,
  upsertBalanceOp,
  upsertCalendarEvent,
  upsertDailyJournal,
  upsertDeal,
  upsertOpenPosition,
  upsertPeriodicReview,
  upsertTradeJournal,
  verifyAndTouchSession,
} from './server/db.ts';
import { createInitialSeedBundle, generateIncrementalSyncBatch } from './server/mt5Fixtures.ts';
import { generateGeminiTradingInsights } from './server/aiInsights.ts';
import {
  generateIngestToken,
  hashIngestToken,
  processIngest,
  rebuildAccountTimestamps,
  verifyIngestToken,
  type IngestAccountRow,
} from './server/ingest.ts';
import { MT5_EET_US_DST_ZONE } from './src/shared/timeUtils.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT) || 3000;

const syncingAccounts = new Set<string>();
const incrementalSyncCounter = new Map<string, number>();

// ---- Brute-force throttling (per client IP) for vault login and collector ingest tokens ----
const MAX_FREE_FAILURES = 5;
const MAX_LOCK_MS = 15 * 60 * 1000;
const failedAttempts = new Map<string, { count: number; lockedUntil: number }>();

function lockRemainingMs(key: string): number {
  const entry = failedAttempts.get(key);
  return entry ? Math.max(0, entry.lockedUntil - Date.now()) : 0;
}

function registerFailure(key: string): void {
  const entry = failedAttempts.get(key) ?? { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= MAX_FREE_FAILURES) {
    const lockMs = Math.min(MAX_LOCK_MS, 30_000 * 2 ** (entry.count - MAX_FREE_FAILURES));
    entry.lockedUntil = Date.now() + lockMs;
  }
  failedAttempts.set(key, entry);
}

function clearFailures(key: string): void {
  failedAttempts.delete(key);
}

function isValidServerZone(zone: string): boolean {
  if (zone === MT5_EET_US_DST_ZONE) return true;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
}

function getEnvPasscode(): string | null {
  const val = process.env.OWNER_PASSCODE?.trim();
  return val && val.length > 0 ? val : null;
}

function getStoredOwnerHash(): string | null {
  const db = getDb();
  const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get('owner_password_hash') as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return authHeader.slice(7).trim() || null;
}

function isTokenValid(token: string | null): boolean {
  if (!token) return false;
  const db = getDb();
  const settings = getUserSettings(db);
  const timeoutMs = Math.max(5, settings.sessionTimeoutMinutes || 60) * 60 * 1000;
  return verifyAndTouchSession(db, hashSessionToken(token), timeoutMs);
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractBearerToken(req);
  if (!isTokenValid(token)) {
    res.status(401).json({ error: 'Authentication required. Please unlock your trading journal.' });
    return;
  }
  next();
}

async function startServer(): Promise<void> {
  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);

  // Ensure DB initialised on boot
  getDb();

  // ---- COLLECTOR INGEST (token-authenticated, read-only data push from the Windows collector) ----
  // Registered before the global JSON parser so it can accept larger history batches.
  app.post('/api/ingest/:accountId', express.json({ limit: '25mb' }), (req: Request, res: Response) => {
    const db = getDb();
    const clientKey = `ingest:${req.ip ?? 'unknown'}`;
    const locked = lockRemainingMs(clientKey);
    if (locked > 0) {
      res.setHeader('Retry-After', String(Math.ceil(locked / 1000)));
      res.status(429).json({ error: 'Too many failed attempts. Try again later.' });
      return;
    }

    const accountId = String(req.params.accountId);
    const token = extractBearerToken(req);
    // Unknown account and bad token return the same response so account IDs cannot be probed.
    if (!token || !verifyIngestToken(db, accountId, token)) {
      registerFailure(clientKey);
      res.status(401).json({ error: 'Invalid ingest token for this account.' });
      return;
    }
    clearFailures(clientKey);

    const account = db
      .prepare(
        'SELECT id, account_login, broker_server, server_time_zone, server_utc_offset_label FROM mt5_accounts WHERE id = ?',
      )
      .get(accountId) as IngestAccountRow | undefined;
    if (!account) {
      res.status(404).json({ error: 'MT5 account not found.' });
      return;
    }
    if (syncingAccounts.has(accountId)) {
      res.status(429).json({ error: 'Another sync is already running for this account.' });
      return;
    }

    syncingAccounts.add(accountId);
    try {
      const outcome = processIngest(db, account, req.body);
      if (!outcome.ok) {
        res.status(outcome.status).json({ error: outcome.error });
        return;
      }
      res.json(outcome.result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Ingest failed.';
      res.status(500).json({ error: `Ingest failed and was rolled back: ${msg}` });
    } finally {
      syncingAccounts.delete(accountId);
    }
  });

  app.use(express.json({ limit: '25mb' }));

  // ---- AUTH ROUTES ----
  app.get('/api/auth/status', (req: Request, res: Response) => {
    const envPasscode = getEnvPasscode();
    const storedHash = getStoredOwnerHash();
    const token = extractBearerToken(req);
    const settings = getUserSettings(getDb());
    res.json({
      initialized: Boolean(envPasscode || storedHash),
      envProtected: Boolean(envPasscode),
      authenticated: isTokenValid(token),
      sessionTimeoutMinutes: settings.sessionTimeoutMinutes,
    });
  });

  app.post('/api/auth/setup', (req: Request, res: Response) => {
    const envPasscode = getEnvPasscode();
    if (envPasscode) {
      res.status(403).json({
        error: 'Portal password is managed via OWNER_PASSCODE environment configuration.',
      });
      return;
    }
    if (getStoredOwnerHash()) {
      res.status(409).json({ error: 'Owner password has already been configured.' });
      return;
    }
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (password.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters long.' });
      return;
    }
    const db = getDb();
    const hashed = hashPassword(password);
    db.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)').run(
      'owner_password_hash',
      hashed,
    );
    appendAuditLog(db, 'VAULT_SETUP', 'Auth', 'Personal vault password created (scrypt salted hash).');
    const token = generateSessionToken();
    createSessionRecord(db, hashSessionToken(token));
    res.status(201).json({ token });
  });

  app.post('/api/auth/login', (req: Request, res: Response) => {
    const clientKey = `login:${req.ip ?? 'unknown'}`;
    const locked = lockRemainingMs(clientKey);
    if (locked > 0) {
      res.setHeader('Retry-After', String(Math.ceil(locked / 1000)));
      res.status(429).json({
        error: `Too many incorrect attempts. Try again in ${Math.ceil(locked / 1000)} seconds.`,
      });
      return;
    }

    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const envPasscode = getEnvPasscode();
    const storedHash = getStoredOwnerHash();

    let ok = false;
    if (envPasscode) {
      ok = timingSafeStringEqual(password, envPasscode);
    } else if (storedHash) {
      ok = verifyPassword(password, storedHash);
    } else {
      res.status(400).json({ error: 'Vault not yet initialised. Create an owner password first.' });
      return;
    }

    if (!ok) {
      registerFailure(clientKey);
      res.status(401).json({ error: 'Incorrect vault password. Please try again.' });
      return;
    }
    clearFailures(clientKey);

    const db = getDb();
    const token = generateSessionToken();
    createSessionRecord(db, hashSessionToken(token));
    appendAuditLog(db, 'OWNER_LOGIN', 'Auth', 'Owner unlocked personal trading journal.');
    res.json({ token });
  });

  app.post('/api/auth/logout', (req: Request, res: Response) => {
    const token = extractBearerToken(req);
    const db = getDb();
    if (token) {
      deleteSessionRecord(db, hashSessionToken(token));
    }
    appendAuditLog(db, 'OWNER_LOGOUT', 'Auth', 'Owner locked session.');
    res.json({ ok: true });
  });

  // ---- PROTECTED JOURNAL API ----
  app.get('/api/bootstrap', requireAuth, (_req: Request, res: Response) => {
    const payload = loadBootstrapPayload(getDb());
    res.json(payload);
  });

  // Link a new MT5 account (read-only investor credentials encrypted at rest)
  app.post('/api/accounts', requireAuth, async (req: Request, res: Response) => {
    const db = getDb();
    const body = req.body ?? {};
    const friendlyName = String(body.friendlyName ?? '').trim();
    const accountLogin = String(body.accountLogin ?? '').trim();
    const brokerName = String(body.brokerName ?? '').trim() || 'MetaTrader 5 Broker';
    const brokerServer = String(body.brokerServer ?? '').trim();
    const environment = body.environment === 'demo' ? 'demo' : 'live';
    const accountMode = body.accountMode === 'netting' ? 'netting' : 'hedging';
    const currency = String(body.currency ?? 'GBP').trim().toUpperCase().slice(0, 6);
    const leverage = Math.max(1, Math.min(2000, Number(body.leverage) || 30));
    const serverTimeZone = String(body.serverTimeZone ?? MT5_EET_US_DST_ZONE).trim();
    const serverUtcOffsetLabel = String(body.serverUtcOffsetLabel ?? 'GMT+2').trim();
    const connectionType =
      body.connectionType === 'bridge_https' ||
      body.connectionType === 'csv_import' ||
      body.connectionType === 'mt5_sandbox'
        ? body.connectionType
        : 'collector';
    const bridgeUrl = typeof body.bridgeUrl === 'string' ? body.bridgeUrl.trim() : '';
    const emptyHistory = Boolean(body.emptyHistory);

    if (!friendlyName || !accountLogin || !brokerServer) {
      res.status(400).json({
        error: 'Connection failed: please enter a friendly name, MT5 account login, and broker server.',
      });
      return;
    }

    if (!isValidServerZone(serverTimeZone)) {
      res.status(400).json({ error: `Unknown broker server time zone "${serverTimeZone}".` });
      return;
    }

    // NOTE: the investor password is deliberately never accepted or stored here. It is only ever typed
    // into the local Windows collector, which logs in to MT5 directly and pushes data using a revocable token.

    if (connectionType === 'bridge_https') {
      const check = validateSafeBridgeUrl(bridgeUrl);
      if (!check.ok) {
        res.status(400).json({ error: check.error });
        return;
      }
    }

    const id = `acc_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const nowIso = new Date().toISOString();
    const encryptedCredentials: string | null = null;

    const usesStarterSandboxHistory = connectionType === 'mt5_sandbox' && !emptyHistory;
    const initialSyncNotice =
      connectionType === 'collector'
        ? 'Account linked. Generate a collector token, then run the Windows read-only collector to push your real MT5 history.'
        : connectionType === 'bridge_https'
          ? 'Linked via HTTPS MT5 Bridge. Click "Sync Now" to pull broker history.'
          : connectionType === 'csv_import'
            ? 'Account profile linked in CSV-only mode. Click "Import CSV" to upload your MetaTrader 5 deal history.'
            : 'SIMULATED demo account: all data is generated sample data, not real MT5 history.';

    const newAccount: MT5Account = {
      id,
      friendlyName,
      accountLogin,
      brokerName,
      brokerServer,
      environment,
      accountMode,
      currency,
      leverage,
      serverTimeZone,
      serverUtcOffsetLabel,
      connectionType,
      bridgeUrl: connectionType === 'bridge_https' ? bridgeUrl : undefined,
      hasCredentials: false,
      hasIngestToken: false,
      initialBalance: usesStarterSandboxHistory ? 5000 : 0,
      balance: usesStarterSandboxHistory ? 5000 : 0,
      equity: usesStarterSandboxHistory ? 5000 : 0,
      lastSyncUtc: usesStarterSandboxHistory ? nowIso : null,
      highestDealTicket: 0,
      earliestAvailableUtc: null,
      expectedStartUtc: null,
      syncNotice: initialSyncNotice,
      integrityWarnings: [],
      createdAtUtc: nowIso,
    };

    const tx = db.transaction(() => {
      insertAccountRow(db, newAccount, encryptedCredentials);

      // If sandbox mode & not explicitly empty, import an initial starter trade batch with a deposit
      if (connectionType === 'mt5_sandbox' && !emptyHistory) {
        const baseTicket = Math.floor(Date.now() / 1000);
        const posId = baseTicket % 900000 + 100000;
        const depOp: BalanceOperation = {
          ticket: baseTicket,
          accountId: id,
          dealType: 'DEAL_TYPE_BALANCE',
          amount: 5000,
          utcTime: '2026-11-01T08:00:00.000Z',
          serverTimeRaw: '2026.11.01 10:00:00',
          serverTzLabel: serverUtcOffsetLabel,
          comment: 'Initial Account Deposit',
        };
        upsertBalanceOp(db, depOp);
        const d1: MT5Deal = {
          ticket: baseTicket + 1,
          accountId: id,
          orderId: baseTicket + 1,
          positionId: posId,
          symbol: 'EURUSD',
          dealType: 'DEAL_TYPE_BUY',
          dealEntry: 'DEAL_ENTRY_IN',
          volume: 0.25,
          price: 1.081,
          profit: 0,
          commission: -1.4,
          swap: 0,
          sl: 1.078,
          tp: 1.087,
          utcTime: '2026-11-05T08:30:00.000Z',
          serverTimeRaw: '2026.11.05 10:30:00',
          serverTzLabel: serverUtcOffsetLabel,
          magicNumber: 0,
          comment: 'Initial history import',
        };
        const d2: MT5Deal = {
          ticket: baseTicket + 2,
          accountId: id,
          orderId: baseTicket + 2,
          positionId: posId,
          symbol: 'EURUSD',
          dealType: 'DEAL_TYPE_SELL',
          dealEntry: 'DEAL_ENTRY_OUT',
          volume: 0.25,
          price: 1.0862,
          profit: 108.5,
          commission: -1.4,
          swap: 0,
          sl: 1.078,
          tp: 1.087,
          utcTime: '2026-11-05T14:15:00.000Z',
          serverTimeRaw: '2026.11.05 16:15:00',
          serverTzLabel: serverUtcOffsetLabel,
          magicNumber: 0,
          comment: 'TP zone exit',
        };
        upsertDeal(db, d1);
        upsertDeal(db, d2);
        recalculateAccountBalances(db, id);
        db.prepare('UPDATE mt5_accounts SET sync_notice = ?, earliest_available_utc = ? WHERE id = ?').run(
          'Imported 1 trade from 05/11/2026 to today. Read-only MT5 connection active.',
          '2026-11-05T08:30:00.000Z',
          id,
        );
      }

      appendAuditLog(
        db,
        'ACCOUNT_LINKED',
        `MT5 #${accountLogin}`,
        `Linked read-only account "${friendlyName}" on ${brokerServer} (${accountMode}, ${connectionType}; no password stored).`,
      );
    });
    tx();

    res.status(201).json(loadBootstrapPayload(db));
  });

  // Update MT5 account friendly name or re-validate encrypted credentials
  app.patch('/api/accounts/:id', requireAuth, (req: Request, res: Response) => {
    const db = getDb();
    const id = req.params.id;
    const existing = db.prepare('SELECT * FROM mt5_accounts WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'MT5 account not found.' });
      return;
    }

    const friendlyName =
      typeof req.body?.friendlyName === 'string' && req.body.friendlyName.trim()
        ? req.body.friendlyName.trim()
        : String(existing.friendly_name);
    const leverage = Number(req.body?.leverage) || Number(existing.leverage);
    const nextServerTz =
      typeof req.body?.serverTimeZone === 'string' && req.body.serverTimeZone.trim()
        ? req.body.serverTimeZone.trim()
        : String(existing.server_time_zone);
    const nextOffsetLabel =
      typeof req.body?.serverUtcOffsetLabel === 'string' && req.body.serverUtcOffsetLabel.trim()
        ? req.body.serverUtcOffsetLabel.trim()
        : String(existing.server_utc_offset_label);
    if (!isValidServerZone(nextServerTz)) {
      res.status(400).json({ error: `Unknown broker server time zone "${nextServerTz}".` });
      return;
    }
    const bridgeUrl =
      typeof req.body?.bridgeUrl === 'string' ? req.body.bridgeUrl.trim() : (existing.bridge_url as string | null);

    if (bridgeUrl && existing.connection_type === 'bridge_https') {
      const check = validateSafeBridgeUrl(bridgeUrl);
      if (!check.ok) {
        res.status(400).json({ error: check.error });
        return;
      }
    }

    const tzChanged =
      nextServerTz !== String(existing.server_time_zone) ||
      nextOffsetLabel !== String(existing.server_utc_offset_label);

    const tx = db.transaction(() => {
      db.prepare(
        'UPDATE mt5_accounts SET friendly_name = ?, leverage = ?, bridge_url = ?, server_time_zone = ?, server_utc_offset_label = ? WHERE id = ?',
      ).run(friendlyName, leverage, bridgeUrl ?? null, nextServerTz, nextOffsetLabel, id);

      if (tzChanged) {
        // Re-derive every UTC timestamp from the original broker wall-clock text under the corrected zone.
        const rebuilt = rebuildAccountTimestamps(db, id, nextServerTz, nextOffsetLabel);
        appendAuditLog(
          db,
          'ACCOUNT_TIMEZONE_CORRECTED',
          `MT5 #${existing.account_login}`,
          `Broker server time zone set to ${nextServerTz}; re-derived ${rebuilt.deals} deal, ${rebuilt.balanceOperations} balance and ${rebuilt.openPositions} open-position timestamps.`,
        );
      } else {
        appendAuditLog(db, 'ACCOUNT_UPDATED', `MT5 #${existing.account_login}`, `Updated settings for "${friendlyName}".`);
      }
    });
    tx();

    res.json(loadBootstrapPayload(db));
  });

  // Generate (or rotate) the read-only collector ingest token. The plaintext is returned exactly once.
  app.post('/api/accounts/:id/ingest-token', requireAuth, (req: Request, res: Response) => {
    const db = getDb();
    const id = String(req.params.id);
    const existing = db.prepare('SELECT account_login FROM mt5_accounts WHERE id = ?').get(id) as
      | { account_login: string }
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'MT5 account not found.' });
      return;
    }
    const token = generateIngestToken();
    db.prepare('UPDATE mt5_accounts SET ingest_token_hash = ? WHERE id = ?').run(hashIngestToken(token), id);
    appendAuditLog(
      db,
      'INGEST_TOKEN_ROTATED',
      `MT5 #${existing.account_login}`,
      'Generated a new collector ingest token (any previous token is now invalid).',
    );
    const baseUrl = (process.env.APP_URL && /^https?:\/\//.test(process.env.APP_URL)
      ? process.env.APP_URL
      : `${req.protocol}://${req.get('host')}`
    ).replace(/\/+$/, '');
    res.status(201).json({
      token,
      ingestUrl: `${baseUrl}/api/ingest/${encodeURIComponent(id)}`,
      payload: loadBootstrapPayload(db),
    });
  });

  // Unlink MT5 account and cascade-delete all associated records (GDPR/privacy)
  app.delete('/api/accounts/:id', requireAuth, (req: Request, res: Response) => {
    const db = getDb();
    const id = req.params.id;
    const existing = db.prepare('SELECT friendly_name, account_login FROM mt5_accounts WHERE id = ?').get(id) as
      | { friendly_name: string; account_login: string }
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Account not found.' });
      return;
    }
    db.prepare('DELETE FROM mt5_accounts WHERE id = ?').run(id);
    appendAuditLog(
      db,
      'ACCOUNT_UNLINKED',
      `MT5 #${existing.account_login}`,
      `Unlinked "${existing.friendly_name}" and permanently erased all linked deals, open positions, and trade journals.`,
    );
    res.json(loadBootstrapPayload(db));
  });

  // Synchronise MT5 account (idempotent incremental sync, full re-import preserving notes, or simulated partial failure recovery)
  app.post('/api/accounts/:id/sync', requireAuth, async (req: Request, res: Response) => {
    const db = getDb();
    const id = req.params.id;
    const mode = req.body?.mode === 'reimport' ? 'reimport' : 'incremental';
    const simulatePartialFailure = Boolean(req.body?.simulatePartialFailure);

    if (syncingAccounts.has(id)) {
      res.status(429).json({ error: 'Synchronisation already in progress for this account.' });
      return;
    }

    const payloadBefore = loadBootstrapPayload(db);
    const account = payloadBefore.accounts.find((a) => a.id === id);
    if (!account) {
      res.status(404).json({ error: 'MT5 account not found.' });
      return;
    }

    syncingAccounts.add(id);
    try {
      // Only the explicit demo sandbox may ever generate simulated deals. Real accounts receive data
      // exclusively from the collector (push) or CSV import, so "Sync" must never touch them.
      if (account.connectionType === 'collector' || account.connectionType === 'csv_import') {
        res.json({
          importedDealsCount: 0,
          message:
            account.connectionType === 'collector'
              ? 'This account is updated by the Windows collector (push). Run the collector to sync new trades.'
              : 'This account is CSV-only. Use "Import CSV" to add new history.',
          payload: payloadBefore,
        });
        return;
      }

      if (simulatePartialFailure) {
        const warning = `Partial sync interrupted at ${new Date().toISOString().slice(11, 19)} UTC (simulated network timeout). Existing data preserved without corruption; retry Sync to complete.`;
        const nextWarnings = Array.from(new Set([warning, ...account.integrityWarnings])).slice(0, 5);
        db.prepare('UPDATE mt5_accounts SET integrity_warnings_json = ? WHERE id = ?').run(
          JSON.stringify(nextWarnings),
          id,
        );
        appendAuditLog(db, 'SYNC_PARTIAL_FAILURE', `MT5 #${account.accountLogin}`, warning);
        res.status(503).json({
          error: warning,
          recoveredCleanly: true,
          payload: loadBootstrapPayload(db),
        });
        return;
      }

      // If configured with a real remote HTTPS MT5 Bridge, attempt TLS pull
      if (account.connectionType === 'bridge_https' && account.bridgeUrl) {
        const check = validateSafeBridgeUrl(account.bridgeUrl);
        if (!check.ok) {
          res.status(400).json({ error: check.error });
          return;
        }
        try {
          const response = await fetch(check.url.toString(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              accountLogin: account.accountLogin,
              brokerServer: account.brokerServer,
              sinceTicket: mode === 'reimport' ? 0 : account.highestDealTicket,
              readOnly: true,
            }),
            signal: AbortSignal.timeout(8000),
          });
          if (!response.ok) {
            throw new Error(`Bridge returned HTTP ${response.status}`);
          }
          const remote = (await response.json()) as {
            deals?: MT5Deal[];
            balanceOperations?: BalanceOperation[];
          };
          const tx = db.transaction(() => {
            if (mode === 'reimport') {
              db.prepare('DELETE FROM mt5_deals WHERE account_id = ?').run(id);
            }
            for (const d of remote.deals ?? []) {
              upsertDeal(db, { ...d, accountId: id });
            }
            for (const op of remote.balanceOperations ?? []) {
              upsertBalanceOp(db, { ...op, accountId: id });
            }
            recalculateAccountBalances(db, id);
            db.prepare('UPDATE mt5_accounts SET last_sync_utc = ?, sync_notice = ? WHERE id = ?').run(
              new Date().toISOString(),
              `Synchronised ${(remote.deals ?? []).length} deals via HTTPS MT5 Bridge.`,
              id,
            );
          });
          tx();
          res.json({
            importedDealsCount: (remote.deals ?? []).length,
            message: `Synchronised ${(remote.deals ?? []).length} deals via HTTPS MT5 Bridge.`,
            payload: loadBootstrapPayload(db),
          });
          return;
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Unable to reach HTTPS MT5 Bridge.';
          res.status(502).json({
            error: `MT5 Bridge unreachable (${msg}). Check your TLS endpoint or import MT5 CSV history instead.`,
          });
          return;
        }
      }

      // Sandbox / Local MT5 Sync with strict idempotency
      const nowIso = new Date().toISOString();
      let insertedCount = 0;

      const tx = db.transaction(() => {
        if (mode === 'reimport') {
          // Clear deals and re-import from seed/history while strictly preserving user trade_journals by position_id!
          const seed = createInitialSeedBundle();
          const matchingDeals = seed.deals.filter((d) => d.accountId === id);
          if (matchingDeals.length > 0) {
            db.prepare('DELETE FROM mt5_deals WHERE account_id = ?').run(id);
            for (const d of matchingDeals) {
              upsertDeal(db, d);
              insertedCount++;
            }
          }
          incrementalSyncCounter.set(id, 0);
        } else {
          const countSoFar = incrementalSyncCounter.get(id) ?? 0;
          const batch = generateIncrementalSyncBatch(account, account.highestDealTicket, countSoFar);
          for (const d of batch.newDeals) {
            const info = db
              .prepare(
                `INSERT OR IGNORE INTO mt5_deals (
                  account_id, ticket, order_id, position_id, symbol, deal_type, deal_entry,
                  volume, price, profit, commission, swap, sl, tp, utc_time,
                  server_time_raw, server_tz_label, magic_number, comment
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                d.accountId,
                d.ticket,
                d.orderId,
                d.positionId,
                d.symbol,
                d.dealType,
                d.dealEntry,
                d.volume,
                d.price,
                d.profit,
                d.commission,
                d.swap,
                d.sl,
                d.tp,
                d.utcTime,
                d.serverTimeRaw,
                d.serverTzLabel,
                d.magicNumber,
                d.comment,
              );
            if (info.changes > 0) insertedCount++;
          }
          incrementalSyncCounter.set(id, countSoFar + 1);
        }

        // Slightly mark-to-market open positions on sync to show live unrealised P/L refresh
        const openRows = db
          .prepare('SELECT ticket, symbol, direction, open_price, volume, current_price FROM mt5_open_positions WHERE account_id = ?')
          .all(id) as Array<{
          ticket: number;
          symbol: string;
          direction: 'BUY' | 'SELL';
          open_price: number;
          volume: number;
          current_price: number;
        }>;
        for (const row of openRows) {
          const pipStep = row.symbol.includes('JPY') ? 0.04 : 0.0004;
          const jitter = ((Math.sin(Date.now() / 10000 + row.ticket) > 0 ? 1 : -1) * pipStep);
          const nextPrice = Number((row.current_price + jitter).toFixed(row.symbol.includes('JPY') ? 3 : 5));
          const diff = row.direction === 'BUY' ? nextPrice - row.open_price : row.open_price - nextPrice;
          const pipFactor = row.symbol.includes('JPY') ? 100 : 10000;
          const nextProfit = Number((diff * pipFactor * row.volume * 7.8).toFixed(2));
          db.prepare(
            'UPDATE mt5_open_positions SET current_price = ?, unrealised_profit = ? WHERE account_id = ? AND ticket = ?',
          ).run(nextPrice, nextProfit, id, row.ticket);
        }

        recalculateAccountBalances(db, id);

        // Count closed positions for user-friendly import summary
        const updatedPayload = loadBootstrapPayload(db);
        const { closedTrades } = buildClosedTrades(
          updatedPayload.deals.filter((d) => d.accountId === id),
          updatedPayload.accounts,
          updatedPayload.journals,
          updatedPayload.openPositions.filter((p) => p.accountId === id),
          updatedPayload.settings,
        );
        const earliestDate = updatedPayload.accounts.find((a) => a.id === id)?.earliestAvailableUtc;
        const startStr = earliestDate ? earliestDate.slice(0, 10) : 'account open';
        const notice =
          closedTrades.length === 0
            ? 'Sync completed. No closed trades available from broker server.'
            : insertedCount > 0
              ? `Imported ${closedTrades.length} trades from ${startStr} to today (${insertedCount} new deal records processed; zero duplicates).`
              : `Up to date — ${closedTrades.length} trades verified from ${startStr} to today (0 new deals; idempotent check passed).`;

        db.prepare(
          'UPDATE mt5_accounts SET last_sync_utc = ?, sync_notice = ?, integrity_warnings_json = ? WHERE id = ?',
        ).run(
          nowIso,
          notice,
          JSON.stringify(
            account.integrityWarnings.filter((w) => !w.startsWith('Partial sync interrupted')),
          ),
          id,
        );

        appendAuditLog(
          db,
          mode === 'reimport' ? 'ACCOUNT_REIMPORT' : 'ACCOUNT_SYNC',
          `MT5 #${account.accountLogin}`,
          notice,
        );
      });
      tx();

      const fresh = loadBootstrapPayload(db);
      const updatedAcc = fresh.accounts.find((a) => a.id === id);
      res.json({
        importedDealsCount: insertedCount,
        message: updatedAcc?.syncNotice ?? 'Synchronisation complete.',
        payload: fresh,
      });
    } finally {
      syncingAccounts.delete(id);
    }
  });

  // Import MT5 CSV / TSV deal history directly into an account
  app.post('/api/accounts/:id/import-csv', requireAuth, (req: Request, res: Response) => {
    const db = getDb();
    const id = req.params.id;
    const csvText = typeof req.body?.csvText === 'string' ? req.body.csvText : '';
    const existing = db.prepare('SELECT * FROM mt5_accounts WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Account not found.' });
      return;
    }
    if (!csvText.trim()) {
      res.status(400).json({ error: 'CSV content is empty.' });
      return;
    }

    const parsed = parseMT5CsvDeals(
      csvText,
      id,
      String(existing.server_utc_offset_label || 'GMT+2'),
      String(existing.server_time_zone || ''),
    );
    let newDeals = 0;
    let newOps = 0;
    let correctedDeals = 0;
    let skippedDeals = 0;

    const tx = db.transaction(() => {
      for (const d of parsed.deals) {
        const r = upsertDeal(db, d);
        if (r === 'inserted') newDeals++;
        else if (r === 'updated') correctedDeals++;
        else skippedDeals++;
      }
      for (const op of parsed.balanceOps) {
        if (upsertBalanceOp(db, op) === 'inserted') newOps++;
      }
      recalculateAccountBalances(db, id);
      const notice =
        `CSV Import complete: ${newDeals} new deals, ${correctedDeals} corrected, ${skippedDeals} duplicates skipped, ` +
        `${newOps} new balance operations` +
        (parsed.warnings.length > 0 ? `, ${parsed.warnings.length} rows skipped with warnings.` : '.');
      db.prepare('UPDATE mt5_accounts SET last_sync_utc = ?, sync_notice = ? WHERE id = ?').run(
        new Date().toISOString(),
        notice,
        id,
      );
      appendAuditLog(db, 'CSV_IMPORT', `MT5 #${existing.account_login}`, notice);
    });
    tx();

    res.json({
      newDeals,
      newOps,
      warnings: parsed.warnings,
      payload: loadBootstrapPayload(db),
    });
  });

  // Save per-trade journal entry (prices/volumes remain immutable in mt5_deals)
  app.put('/api/trades/:accountId/:positionId/journal', requireAuth, (req: Request, res: Response) => {
    const db = getDb();
    const accountId = req.params.accountId;
    const positionId = Number(req.params.positionId);
    if (!Number.isFinite(positionId) || positionId <= 0) {
      res.status(400).json({ error: 'Invalid position ID.' });
      return;
    }

    const body = req.body ?? {};
    const entry: TradeJournalEntry = {
      accountId,
      positionId,
      strategy: String(body.strategy ?? '').trim(),
      tags: Array.isArray(body.tags)
        ? body.tags.map((t: unknown) => String(t).trim()).filter(Boolean)
        : [],
      initialRiskCurrency:
        body.initialRiskCurrency !== null && body.initialRiskCurrency !== '' && Number.isFinite(Number(body.initialRiskCurrency))
          ? Number(body.initialRiskCurrency)
          : null,
      manualSlOverride:
        body.manualSlOverride !== null && body.manualSlOverride !== '' && Number.isFinite(Number(body.manualSlOverride))
          ? Number(body.manualSlOverride)
          : null,
      manualEntryOverride:
        body.manualEntryOverride !== null && body.manualEntryOverride !== '' && Number.isFinite(Number(body.manualEntryOverride))
          ? Number(body.manualEntryOverride)
          : null,
      outcomeOverride:
        body.outcomeOverride === 'win' ||
        body.outcomeOverride === 'loss' ||
        body.outcomeOverride === 'breakeven'
          ? body.outcomeOverride
          : 'auto',
      rationale: String(body.rationale ?? ''),
      emotions: String(body.emotions ?? ''),
      mistakes: String(body.mistakes ?? ''),
      notes: String(body.notes ?? ''),
      sessionOverride: String(body.sessionOverride ?? ''),
      updatedAtUtc: new Date().toISOString(),
    };

    upsertTradeJournal(db, entry);
    appendAuditLog(
      db,
      'TRADE_JOURNAL_SAVED',
      `Position #${positionId}`,
      `Updated journal notes / strategy (${entry.strategy || 'Untagged'}) for position #${positionId}.`,
    );
    res.json(loadBootstrapPayload(db));
  });

  // Save daily journal entry
  app.put('/api/daily-journal/:date', requireAuth, (req: Request, res: Response) => {
    const db = getDb();
    const date = req.params.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: 'Date must follow YYYY-MM-DD format.' });
      return;
    }
    const clamp5 = (v: unknown) => Math.max(1, Math.min(5, Math.round(Number(v) || 3)));
    const entry: DailyJournalEntry = {
      date,
      narrative: String(req.body?.narrative ?? ''),
      mood: clamp5(req.body?.mood),
      discipline: clamp5(req.body?.discipline),
      stress: clamp5(req.body?.stress),
      confidence: clamp5(req.body?.confidence),
      sessionLabel: String(req.body?.sessionLabel ?? ''),
      lessons: String(req.body?.lessons ?? ''),
      updatedAtUtc: new Date().toISOString(),
    };
    upsertDailyJournal(db, entry);
    appendAuditLog(db, 'DAILY_JOURNAL_SAVED', date, `Saved daily psychology & reflection entry for ${date}.`);
    res.json(loadBootstrapPayload(db));
  });

  // Save weekly/monthly periodic review
  app.put('/api/reviews/:id', requireAuth, (req: Request, res: Response) => {
    const db = getDb();
    const id = req.params.id;
    const rev: PeriodicReview = {
      id,
      periodType: req.body?.periodType === 'monthly' ? 'monthly' : 'weekly',
      periodLabel: String(req.body?.periodLabel ?? id).trim(),
      startDate: String(req.body?.startDate ?? ''),
      endDate: String(req.body?.endDate ?? ''),
      lessonsLearned: String(req.body?.lessonsLearned ?? ''),
      goalsNextPeriod: String(req.body?.goalsNextPeriod ?? ''),
      psychologicalTriggers: String(req.body?.psychologicalTriggers ?? ''),
      rating: Math.max(1, Math.min(5, Math.round(Number(req.body?.rating) || 3))),
      updatedAtUtc: new Date().toISOString(),
    };
    upsertPeriodicReview(db, rev);
    appendAuditLog(db, 'PERIODIC_REVIEW_SAVED', rev.periodLabel, `Saved ${rev.periodType} reflection.`);
    res.json(loadBootstrapPayload(db));
  });

  // Calendar event markers
  app.post('/api/calendar-events', requireAuth, (req: Request, res: Response) => {
    const db = getDb();
    const date = String(req.body?.date ?? '').trim();
    const title = String(req.body?.title ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !title) {
      res.status(400).json({ error: 'Valid YYYY-MM-DD date and event title are required.' });
      return;
    }
    const ev: CalendarEventMarker = {
      id: `evt_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      date,
      title,
      category: req.body?.category || 'News Announcement',
      impact: req.body?.impact || 'Medium',
      notes: String(req.body?.notes ?? ''),
    };
    upsertCalendarEvent(db, ev);
    appendAuditLog(db, 'CALENDAR_EVENT_ADDED', date, `Added "${title}" (${ev.category}).`);
    res.status(201).json(loadBootstrapPayload(db));
  });

  app.delete('/api/calendar-events/:id', requireAuth, (req: Request, res: Response) => {
    const db = getDb();
    db.prepare('DELETE FROM calendar_events WHERE id = ?').run(req.params.id);
    res.json(loadBootstrapPayload(db));
  });

  // User settings
  app.put('/api/settings', requireAuth, (req: Request, res: Response) => {
    const db = getDb();
    const next = (req.body ?? {}) as Partial<UserSettings>;
    saveUserSettings(db, next);
    appendAuditLog(db, 'SETTINGS_UPDATED', 'Preferences', 'Updated display, risk, session, or theme preferences.');
    res.json(loadBootstrapPayload(db));
  });

  // Server-side Gemini AI Retrospective Insights
  app.post('/api/ai/insights', requireAuth, async (req: Request, res: Response) => {
    try {
      const db = getDb();
      const payload = loadBootstrapPayload(db);
      const accountId = typeof req.body?.accountId === 'string' ? req.body.accountId : 'all';
      const focusArea = typeof req.body?.focusArea === 'string' ? req.body.focusArea.trim() : undefined;

      const filteredDeals =
        accountId === 'all'
          ? payload.deals
          : payload.deals.filter((d) => d.accountId === accountId);
      const filteredOps =
        accountId === 'all'
          ? payload.balanceOperations
          : payload.balanceOperations.filter((o) => o.accountId === accountId);
      const filteredOpen =
        accountId === 'all'
          ? payload.openPositions
          : payload.openPositions.filter((p) => p.accountId === accountId);

      const { closedTrades } = buildClosedTrades(
        filteredDeals,
        payload.accounts,
        payload.journals,
        filteredOpen,
        payload.settings,
      );

      if (closedTrades.length === 0) {
        res.status(400).json({ error: 'At least 1 closed trade is required to generate AI retrospective insights.' });
        return;
      }

      const metrics = computePerformanceMetrics(
        closedTrades,
        filteredOps,
        filteredOpen,
        payload.accounts,
        payload.settings,
      );

      const insights = await generateGeminiTradingInsights(
        closedTrades,
        payload.dailyJournals,
        metrics,
        payload.settings,
        focusArea,
      );

      appendAuditLog(
        db,
        'AI_INSIGHTS_GENERATED',
        'AI Insights',
        `Generated ${insights.insights.length} retrospective observations across ${closedTrades.length} trades.`,
      );
      res.json(insights);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to generate AI insights.';
      res.status(502).json({ error: msg });
    }
  });

  // Backup Export & Restore
  app.get('/api/backup/export', requireAuth, (_req: Request, res: Response) => {
    const db = getDb();
    const payload = loadBootstrapPayload(db);
    appendAuditLog(db, 'BACKUP_EXPORTED', 'Backup', 'Exported complete local journal backup JSON.');
    res.json({
      exportedAtUtc: new Date().toISOString(),
      schemaVersion: 1,
      note: 'MT5 passwords are intentionally excluded from backups for credential safety.',
      data: payload,
    });
  });

  app.post('/api/backup/restore', requireAuth, (req: Request, res: Response) => {
    const db = getDb();
    const data = req.body?.data;
    if (!data || !Array.isArray(data.accounts)) {
      res.status(400).json({ error: 'Invalid backup archive format.' });
      return;
    }

    const tx = db.transaction(() => {
      db.prepare('DELETE FROM mt5_accounts').run();
      db.prepare('DELETE FROM daily_journals').run();
      db.prepare('DELETE FROM periodic_reviews').run();
      db.prepare('DELETE FROM calendar_events').run();

      for (const acc of data.accounts as MT5Account[]) {
        insertAccountRow(db, acc, null);
      }
      for (const op of (data.balanceOperations ?? []) as BalanceOperation[]) {
        upsertBalanceOp(db, op);
      }
      for (const d of (data.deals ?? []) as MT5Deal[]) {
        upsertDeal(db, d);
      }
      for (const p of data.openPositions ?? []) {
        upsertOpenPosition(db, p);
      }
      for (const j of (data.journals ?? []) as TradeJournalEntry[]) {
        upsertTradeJournal(db, j);
      }
      for (const dj of (data.dailyJournals ?? []) as DailyJournalEntry[]) {
        upsertDailyJournal(db, dj);
      }
      for (const rev of (data.periodicReviews ?? []) as PeriodicReview[]) {
        upsertPeriodicReview(db, rev);
      }
      for (const ev of (data.calendarEvents ?? []) as CalendarEventMarker[]) {
        upsertCalendarEvent(db, ev);
      }
      if (data.settings) {
        saveUserSettings(db, { ...DEFAULT_SETTINGS, ...data.settings });
      }
      appendAuditLog(db, 'BACKUP_RESTORED', 'Backup', `Restored ${(data.accounts ?? []).length} accounts from backup.`);
    });
    tx();

    res.json(loadBootstrapPayload(db));
  });

  // GDPR Complete Data Erasure
  app.delete('/api/data/erase-all', requireAuth, (_req: Request, res: Response) => {
    const db = getDb();
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM mt5_accounts').run();
      db.prepare('DELETE FROM daily_journals').run();
      db.prepare('DELETE FROM periodic_reviews').run();
      db.prepare('DELETE FROM calendar_events').run();
      appendAuditLog(db, 'GDPR_ERASURE', 'All Data', 'Owner executed complete erasure of all MT5 accounts and journals.');
    });
    tx();
    res.json(loadBootstrapPayload(db));
  });

  // ---- VITE DEV MIDDLEWARE OR PRODUCTION STATIC ASSETS ----
  if (process.env.NODE_ENV === 'production') {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`LedgerFX MT5 Journal Portal running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start LedgerFX server:', err);
  process.exit(1);
});
