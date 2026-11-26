import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_SETTINGS,
  type AuditLogEntry,
  type BalanceOperation,
  type BootstrapPayload,
  type CalendarEventMarker,
  type DailyJournalEntry,
  type MT5Account,
  type MT5Deal,
  type MT5OpenPosition,
  type PeriodicReview,
  type TradeJournalEntry,
  type UserSettings,
} from '../src/shared/types.ts';
import { encryptCredentialPayload } from './crypto.ts';
import { createInitialSeedBundle } from './mt5Fixtures.ts';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'ledgerfx.sqlite');

let dbInstance: Database.Database | null = null;
let ephemeralEncSecret: string | null = null;

export function getCredentialSecret(): string {
  if (process.env.CREDENTIAL_ENCRYPTION_KEY && process.env.CREDENTIAL_ENCRYPTION_KEY.trim().length >= 16) {
    return process.env.CREDENTIAL_ENCRYPTION_KEY.trim();
  }
  const db = getDb();
  const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get('cred_key_salt') as
    | { value: string }
    | undefined;
  if (row?.value) {
    return row.value;
  }
  if (!ephemeralEncSecret) {
    ephemeralEncSecret = crypto.randomBytes(32).toString('hex');
  }
  db.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)').run(
    'cred_key_salt',
    ephemeralEncSecret,
  );
  return ephemeralEncSecret;
}

/** Opens (and migrates) a database at any path, including ':memory:' — used by tests and getDb(). */
export function openDatabase(filePath: string): Database.Database {
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('cache_size = -20000');
  initSchema(db);
  migrateSchema(db);
  return db;
}

export function getDb(): Database.Database {
  if (dbInstance) return dbInstance;
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const db = openDatabase(DB_PATH);
  dbInstance = db;
  // Demo data is opt-in: fake accounts must never be mixed into a real trading journal.
  if (process.env.SEED_DEMO_DATA === 'true') {
    seedIfEmpty(db);
  }
  return db;
}

/** Additive, idempotent migrations for databases created by earlier versions. */
function migrateSchema(db: Database.Database): void {
  const cols = (db.prepare('PRAGMA table_info(mt5_accounts)').all() as Array<{ name: string }>).map((c) => c.name);
  if (!cols.includes('ingest_token_hash')) {
    db.exec('ALTER TABLE mt5_accounts ADD COLUMN ingest_token_hash TEXT');
  }
  if (!cols.includes('reported_balance')) {
    db.exec('ALTER TABLE mt5_accounts ADD COLUMN reported_balance REAL');
  }
  if (!cols.includes('reported_equity')) {
    db.exec('ALTER TABLE mt5_accounts ADD COLUMN reported_equity REAL');
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_deals_account_position ON mt5_deals(account_id, position_id);
    CREATE INDEX IF NOT EXISTS idx_deals_utc_time ON mt5_deals(utc_time);
    CREATE INDEX IF NOT EXISTS idx_balance_ops_account_utc ON balance_operations(account_id, utc_time);
    CREATE INDEX IF NOT EXISTS idx_open_positions_account ON mt5_open_positions(account_id);
  `);
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mt5_accounts (
      id TEXT PRIMARY KEY,
      friendly_name TEXT NOT NULL,
      account_login TEXT NOT NULL,
      broker_name TEXT NOT NULL,
      broker_server TEXT NOT NULL,
      environment TEXT NOT NULL,
      account_mode TEXT NOT NULL,
      currency TEXT NOT NULL,
      leverage INTEGER NOT NULL,
      server_time_zone TEXT NOT NULL,
      server_utc_offset_label TEXT NOT NULL,
      connection_type TEXT NOT NULL,
      bridge_url TEXT,
      encrypted_credentials TEXT,
      initial_balance REAL NOT NULL DEFAULT 0,
      balance REAL NOT NULL DEFAULT 0,
      equity REAL NOT NULL DEFAULT 0,
      last_sync_utc TEXT,
      highest_deal_ticket INTEGER NOT NULL DEFAULT 0,
      earliest_available_utc TEXT,
      expected_start_utc TEXT,
      sync_notice TEXT,
      integrity_warnings_json TEXT NOT NULL DEFAULT '[]',
      created_at_utc TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mt5_deals (
      account_id TEXT NOT NULL,
      ticket INTEGER NOT NULL,
      order_id INTEGER NOT NULL,
      position_id INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      deal_type TEXT NOT NULL,
      deal_entry TEXT NOT NULL,
      volume REAL NOT NULL,
      price REAL NOT NULL,
      profit REAL NOT NULL,
      commission REAL NOT NULL,
      swap REAL NOT NULL,
      sl REAL,
      tp REAL,
      utc_time TEXT NOT NULL,
      server_time_raw TEXT NOT NULL,
      server_tz_label TEXT NOT NULL,
      magic_number INTEGER NOT NULL DEFAULT 0,
      comment TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (account_id, ticket),
      FOREIGN KEY (account_id) REFERENCES mt5_accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS mt5_open_positions (
      account_id TEXT NOT NULL,
      ticket INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      direction TEXT NOT NULL,
      volume REAL NOT NULL,
      open_price REAL NOT NULL,
      current_price REAL NOT NULL,
      sl REAL,
      tp REAL,
      swap REAL NOT NULL DEFAULT 0,
      commission REAL NOT NULL DEFAULT 0,
      unrealised_profit REAL NOT NULL DEFAULT 0,
      open_time_utc TEXT NOT NULL,
      server_time_raw TEXT NOT NULL,
      server_tz_label TEXT NOT NULL,
      magic_number INTEGER NOT NULL DEFAULT 0,
      comment TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (account_id, ticket),
      FOREIGN KEY (account_id) REFERENCES mt5_accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS balance_operations (
      account_id TEXT NOT NULL,
      ticket INTEGER NOT NULL,
      deal_type TEXT NOT NULL,
      amount REAL NOT NULL,
      utc_time TEXT NOT NULL,
      server_time_raw TEXT NOT NULL,
      server_tz_label TEXT NOT NULL,
      comment TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (account_id, ticket),
      FOREIGN KEY (account_id) REFERENCES mt5_accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS trade_journals (
      account_id TEXT NOT NULL,
      position_id INTEGER NOT NULL,
      strategy TEXT NOT NULL DEFAULT '',
      tags_json TEXT NOT NULL DEFAULT '[]',
      initial_risk_currency REAL,
      manual_sl_override REAL,
      manual_entry_override REAL,
      outcome_override TEXT NOT NULL DEFAULT 'auto',
      rationale TEXT NOT NULL DEFAULT '',
      emotions TEXT NOT NULL DEFAULT '',
      mistakes TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      session_override TEXT NOT NULL DEFAULT '',
      updated_at_utc TEXT NOT NULL,
      PRIMARY KEY (account_id, position_id),
      FOREIGN KEY (account_id) REFERENCES mt5_accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS daily_journals (
      date TEXT PRIMARY KEY,
      narrative TEXT NOT NULL DEFAULT '',
      mood INTEGER NOT NULL DEFAULT 3,
      discipline INTEGER NOT NULL DEFAULT 3,
      stress INTEGER NOT NULL DEFAULT 3,
      confidence INTEGER NOT NULL DEFAULT 3,
      session_label TEXT NOT NULL DEFAULT '',
      lessons TEXT NOT NULL DEFAULT '',
      updated_at_utc TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS periodic_reviews (
      id TEXT PRIMARY KEY,
      period_type TEXT NOT NULL,
      period_label TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      lessons_learned TEXT NOT NULL DEFAULT '',
      goals_next_period TEXT NOT NULL DEFAULT '',
      psychological_triggers TEXT NOT NULL DEFAULT '',
      rating INTEGER NOT NULL DEFAULT 3,
      updated_at_utc TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS calendar_events (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      impact TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      utc_time TEXT NOT NULL,
      action TEXT NOT NULL,
      entity TEXT NOT NULL,
      details TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      last_activity INTEGER NOT NULL
    );
  `);
}

function seedIfEmpty(db: Database.Database): void {
  const seeded = db.prepare('SELECT value FROM app_meta WHERE key = ?').get('initial_seeded');
  if (seeded) return;

  const bundle = createInitialSeedBundle();
  const secret = getCredentialSecret();

  const tx = db.transaction(() => {
    for (const acc of bundle.accounts) {
      const encCreds = encryptCredentialPayload(
        JSON.stringify({ login: acc.accountLogin, readOnlyToken: 'investor-readonly-seeded' }),
        secret,
      );
      insertAccountRow(db, acc, encCreds);
    }
    for (const op of bundle.balanceOperations) {
      upsertBalanceOp(db, op);
    }
    for (const deal of bundle.deals) {
      upsertDeal(db, deal);
    }
    for (const pos of bundle.openPositions) {
      upsertOpenPosition(db, pos);
    }
    for (const j of bundle.journals) {
      upsertTradeJournal(db, j);
    }
    for (const dj of bundle.dailyJournals) {
      upsertDailyJournal(db, dj);
    }
    for (const rev of bundle.periodicReviews) {
      upsertPeriodicReview(db, rev);
    }
    for (const ev of bundle.calendarEvents) {
      upsertCalendarEvent(db, ev);
    }
    db.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)').run(
      'user_settings',
      JSON.stringify(DEFAULT_SETTINGS),
    );
    db.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)').run(
      'initial_seeded',
      'true',
    );
    appendAuditLog(
      db,
      'INITIAL_SYNC',
      'Portal',
      'Initialised local encrypted SQLite journal with 2 linked MT5 accounts (21 closed positions, 3 open positions).',
    );
  });
  tx();
}

export function insertAccountRow(
  db: Database.Database,
  acc: MT5Account,
  encryptedCredentials: string | null,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO mt5_accounts (
      id, friendly_name, account_login, broker_name, broker_server, environment,
      account_mode, currency, leverage, server_time_zone, server_utc_offset_label,
      connection_type, bridge_url, encrypted_credentials, initial_balance, balance,
      equity, last_sync_utc, highest_deal_ticket, earliest_available_utc,
      expected_start_utc, sync_notice, integrity_warnings_json, created_at_utc
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    acc.id,
    acc.friendlyName,
    acc.accountLogin,
    acc.brokerName,
    acc.brokerServer,
    acc.environment,
    acc.accountMode,
    acc.currency,
    acc.leverage,
    acc.serverTimeZone,
    acc.serverUtcOffsetLabel,
    acc.connectionType,
    acc.bridgeUrl ?? null,
    encryptedCredentials,
    acc.initialBalance,
    acc.balance,
    acc.equity,
    acc.lastSyncUtc,
    acc.highestDealTicket,
    acc.earliestAvailableUtc,
    acc.expectedStartUtc,
    acc.syncNotice,
    JSON.stringify(acc.integrityWarnings ?? []),
    acc.createdAtUtc,
  );
}

export type UpsertResult = 'inserted' | 'updated' | 'unchanged';

const stmtCache = new WeakMap<Database.Database, Map<string, Database.Statement>>();

/** Prepared-statement cache so bulk imports of thousands of rows don't re-prepare SQL per row. */
function stmt(db: Database.Database, sql: string): Database.Statement {
  let perDb = stmtCache.get(db);
  if (!perDb) {
    perDb = new Map();
    stmtCache.set(db, perDb);
  }
  let s = perDb.get(sql);
  if (!s) {
    s = db.prepare(sql);
    perDb.set(sql, s);
  }
  return s;
}

const numEq = (a: unknown, b: unknown): boolean => {
  if (a === null || a === undefined || b === null || b === undefined) {
    return (a ?? null) === (b ?? null);
  }
  return Math.abs(Number(a) - Number(b)) < 1e-9;
};

/**
 * Duplicate-safe write keyed by (account_id, ticket). New tickets are inserted; an existing ticket is
 * UPDATED when the broker amended it (e.g. late commission/swap) and left alone when identical.
 */
export function upsertDeal(db: Database.Database, incoming: MT5Deal): UpsertResult {
  const d = { ...incoming };
  const existing = stmt(
    db,
    `SELECT order_id, position_id, symbol, deal_type, deal_entry, volume, price, profit, commission,
            swap, sl, tp, utc_time, magic_number, comment
     FROM mt5_deals WHERE account_id = ? AND ticket = ?`,
  ).get(d.accountId, d.ticket) as Record<string, unknown> | undefined;

  if (existing) {
    // MT5 deals carry no SL/TP of their own (the collector derives them from order history). A re-sent
    // row that could not be enriched (null) must never erase an SL/TP we already hold.
    if (d.sl === null && existing.sl !== null && existing.sl !== undefined) d.sl = Number(existing.sl);
    if (d.tp === null && existing.tp !== null && existing.tp !== undefined) d.tp = Number(existing.tp);
  }

  if (!existing) {
    stmt(
      db,
      `INSERT INTO mt5_deals (
        account_id, ticket, order_id, position_id, symbol, deal_type, deal_entry,
        volume, price, profit, commission, swap, sl, tp, utc_time,
        server_time_raw, server_tz_label, magic_number, comment
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      d.accountId, d.ticket, d.orderId, d.positionId, d.symbol, d.dealType, d.dealEntry,
      d.volume, d.price, d.profit, d.commission, d.swap, d.sl, d.tp, d.utcTime,
      d.serverTimeRaw, d.serverTzLabel, d.magicNumber, d.comment,
    );
    return 'inserted';
  }

  const same =
    Number(existing.order_id) === d.orderId &&
    Number(existing.position_id) === d.positionId &&
    existing.symbol === d.symbol &&
    existing.deal_type === d.dealType &&
    existing.deal_entry === d.dealEntry &&
    numEq(existing.volume, d.volume) &&
    numEq(existing.price, d.price) &&
    numEq(existing.profit, d.profit) &&
    numEq(existing.commission, d.commission) &&
    numEq(existing.swap, d.swap) &&
    numEq(existing.sl, d.sl) &&
    numEq(existing.tp, d.tp) &&
    existing.utc_time === d.utcTime &&
    Number(existing.magic_number) === d.magicNumber &&
    String(existing.comment ?? '') === d.comment;
  if (same) return 'unchanged';

  stmt(
    db,
    `UPDATE mt5_deals SET order_id = ?, position_id = ?, symbol = ?, deal_type = ?, deal_entry = ?,
       volume = ?, price = ?, profit = ?, commission = ?, swap = ?, sl = ?, tp = ?, utc_time = ?,
       server_time_raw = ?, server_tz_label = ?, magic_number = ?, comment = ?
     WHERE account_id = ? AND ticket = ?`,
  ).run(
    d.orderId, d.positionId, d.symbol, d.dealType, d.dealEntry,
    d.volume, d.price, d.profit, d.commission, d.swap, d.sl, d.tp, d.utcTime,
    d.serverTimeRaw, d.serverTzLabel, d.magicNumber, d.comment,
    d.accountId, d.ticket,
  );
  return 'updated';
}

export function upsertBalanceOp(db: Database.Database, op: BalanceOperation): UpsertResult {
  const existing = stmt(
    db,
    'SELECT deal_type, amount, utc_time, comment FROM balance_operations WHERE account_id = ? AND ticket = ?',
  ).get(op.accountId, op.ticket) as Record<string, unknown> | undefined;

  if (!existing) {
    stmt(
      db,
      `INSERT INTO balance_operations (
        account_id, ticket, deal_type, amount, utc_time, server_time_raw, server_tz_label, comment
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(op.accountId, op.ticket, op.dealType, op.amount, op.utcTime, op.serverTimeRaw, op.serverTzLabel, op.comment);
    return 'inserted';
  }

  if (
    existing.deal_type === op.dealType &&
    numEq(existing.amount, op.amount) &&
    existing.utc_time === op.utcTime &&
    String(existing.comment ?? '') === op.comment
  ) {
    return 'unchanged';
  }

  stmt(
    db,
    `UPDATE balance_operations SET deal_type = ?, amount = ?, utc_time = ?, server_time_raw = ?,
       server_tz_label = ?, comment = ? WHERE account_id = ? AND ticket = ?`,
  ).run(op.dealType, op.amount, op.utcTime, op.serverTimeRaw, op.serverTzLabel, op.comment, op.accountId, op.ticket);
  return 'updated';
}

export function upsertOpenPosition(db: Database.Database, p: MT5OpenPosition): void {
  db.prepare(
    `INSERT OR REPLACE INTO mt5_open_positions (
      account_id, ticket, symbol, direction, volume, open_price, current_price,
      sl, tp, swap, commission, unrealised_profit, open_time_utc,
      server_time_raw, server_tz_label, magic_number, comment
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    p.accountId,
    p.ticket,
    p.symbol,
    p.direction,
    p.volume,
    p.openPrice,
    p.currentPrice,
    p.sl,
    p.tp,
    p.swap,
    p.commission,
    p.unrealisedProfit,
    p.openTimeUtc,
    p.serverTimeRaw,
    p.serverTzLabel,
    p.magicNumber,
    p.comment,
  );
}

export function upsertTradeJournal(db: Database.Database, j: TradeJournalEntry): void {
  db.prepare(
    `INSERT OR REPLACE INTO trade_journals (
      account_id, position_id, strategy, tags_json, initial_risk_currency,
      manual_sl_override, manual_entry_override, outcome_override, rationale,
      emotions, mistakes, notes, session_override, updated_at_utc
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    j.accountId,
    j.positionId,
    j.strategy,
    JSON.stringify(j.tags ?? []),
    j.initialRiskCurrency,
    j.manualSlOverride,
    j.manualEntryOverride,
    j.outcomeOverride,
    j.rationale,
    j.emotions,
    j.mistakes,
    j.notes,
    j.sessionOverride,
    j.updatedAtUtc,
  );
}

export function upsertDailyJournal(db: Database.Database, dj: DailyJournalEntry): void {
  db.prepare(
    `INSERT OR REPLACE INTO daily_journals (
      date, narrative, mood, discipline, stress, confidence, session_label, lessons, updated_at_utc
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    dj.date,
    dj.narrative,
    dj.mood,
    dj.discipline,
    dj.stress,
    dj.confidence,
    dj.sessionLabel,
    dj.lessons,
    dj.updatedAtUtc,
  );
}

export function upsertPeriodicReview(db: Database.Database, rev: PeriodicReview): void {
  db.prepare(
    `INSERT OR REPLACE INTO periodic_reviews (
      id, period_type, period_label, start_date, end_date,
      lessons_learned, goals_next_period, psychological_triggers, rating, updated_at_utc
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    rev.id,
    rev.periodType,
    rev.periodLabel,
    rev.startDate,
    rev.endDate,
    rev.lessonsLearned,
    rev.goalsNextPeriod,
    rev.psychologicalTriggers,
    rev.rating,
    rev.updatedAtUtc,
  );
}

export function upsertCalendarEvent(db: Database.Database, ev: CalendarEventMarker): void {
  db.prepare(
    `INSERT OR REPLACE INTO calendar_events (id, date, title, category, impact, notes)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(ev.id, ev.date, ev.title, ev.category, ev.impact, ev.notes);
}

export function appendAuditLog(
  db: Database.Database,
  action: string,
  entity: string,
  details: string,
): void {
  db.prepare('INSERT INTO audit_logs (utc_time, action, entity, details) VALUES (?, ?, ?, ?)').run(
    new Date().toISOString(),
    action,
    entity,
    details,
  );
}

export function createSessionRecord(db: Database.Database, tokenHash: string): void {
  const now = Date.now();
  db.prepare(
    'INSERT OR REPLACE INTO auth_sessions (token_hash, created_at, last_activity) VALUES (?, ?, ?)',
  ).run(tokenHash, now, now);
}

export function verifyAndTouchSession(
  db: Database.Database,
  tokenHash: string,
  timeoutMs: number,
): boolean {
  const row = db
    .prepare('SELECT last_activity FROM auth_sessions WHERE token_hash = ?')
    .get(tokenHash) as { last_activity: number } | undefined;
  if (!row) return false;
  const now = Date.now();
  if (now - row.last_activity > timeoutMs) {
    db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash);
    return false;
  }
  db.prepare('UPDATE auth_sessions SET last_activity = ? WHERE token_hash = ?').run(now, tokenHash);
  return true;
}

export function deleteSessionRecord(db: Database.Database, tokenHash: string): void {
  db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash);
}

export function getUserSettings(db: Database.Database): UserSettings {
  const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get('user_settings') as
    | { value: string }
    | undefined;
  if (!row) return { ...DEFAULT_SETTINGS };
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(row.value) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveUserSettings(db: Database.Database, next: Partial<UserSettings>): UserSettings {
  const merged: UserSettings = { ...getUserSettings(db), ...next };
  db.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)').run(
    'user_settings',
    JSON.stringify(merged),
  );
  return merged;
}

export function recalculateAccountBalances(db: Database.Database, accountId: string): void {
  const opsSumRow = db
    .prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM balance_operations WHERE account_id = ?')
    .get(accountId) as { total: number };
  const dealsSumRow = db
    .prepare(
      `SELECT COALESCE(SUM(profit + commission + swap), 0) AS total,
              COALESCE(MAX(ticket), 0) AS max_ticket,
              MIN(utc_time) AS earliest
       FROM mt5_deals
       WHERE account_id = ? AND deal_type IN ('DEAL_TYPE_BUY', 'DEAL_TYPE_SELL')`,
    )
    .get(accountId) as { total: number; max_ticket: number; earliest: string | null };
  const openSumRow = db
    .prepare(
      'SELECT COALESCE(SUM(unrealised_profit + swap + commission), 0) AS total FROM mt5_open_positions WHERE account_id = ?',
    )
    .get(accountId) as { total: number };

  const balance = Math.round((opsSumRow.total + dealsSumRow.total) * 100) / 100;
  const equity = Math.round((balance + openSumRow.total) * 100) / 100;

  db.prepare(
    `UPDATE mt5_accounts
     SET balance = ?, equity = ?, highest_deal_ticket = MAX(highest_deal_ticket, ?),
         earliest_available_utc = COALESCE(earliest_available_utc, ?)
     WHERE id = ?`,
  ).run(balance, equity, dealsSumRow.max_ticket, dealsSumRow.earliest, accountId);
}

export function loadBootstrapPayload(db: Database.Database): BootstrapPayload {
  const accountRows = db.prepare('SELECT * FROM mt5_accounts ORDER BY created_at_utc ASC').all() as Array<
    Record<string, unknown>
  >;

  const accounts: MT5Account[] = accountRows.map((r) => ({
    id: String(r.id),
    friendlyName: String(r.friendly_name),
    accountLogin: String(r.account_login),
    brokerName: String(r.broker_name),
    brokerServer: String(r.broker_server),
    environment: r.environment as MT5Account['environment'],
    accountMode: r.account_mode as MT5Account['accountMode'],
    currency: String(r.currency),
    leverage: Number(r.leverage),
    serverTimeZone: String(r.server_time_zone),
    serverUtcOffsetLabel: String(r.server_utc_offset_label),
    connectionType: r.connection_type as MT5Account['connectionType'],
    bridgeUrl: r.bridge_url ? String(r.bridge_url) : undefined,
    hasCredentials: Boolean(r.encrypted_credentials),
    hasIngestToken: Boolean(r.ingest_token_hash),
    reportedBalance: r.reported_balance !== null && r.reported_balance !== undefined ? Number(r.reported_balance) : null,
    reportedEquity: r.reported_equity !== null && r.reported_equity !== undefined ? Number(r.reported_equity) : null,
    initialBalance: Number(r.initial_balance),
    balance: Number(r.balance),
    equity: Number(r.equity),
    lastSyncUtc: r.last_sync_utc ? String(r.last_sync_utc) : null,
    highestDealTicket: Number(r.highest_deal_ticket),
    earliestAvailableUtc: r.earliest_available_utc ? String(r.earliest_available_utc) : null,
    expectedStartUtc: r.expected_start_utc ? String(r.expected_start_utc) : null,
    syncNotice: r.sync_notice ? String(r.sync_notice) : null,
    integrityWarnings: safeJsonParse<string[]>(String(r.integrity_warnings_json ?? '[]'), []),
    createdAtUtc: String(r.created_at_utc),
  }));

  const deals = (
    db.prepare('SELECT * FROM mt5_deals ORDER BY utc_time ASC, ticket ASC').all() as Array<
      Record<string, unknown>
    >
  ).map((r) => ({
    ticket: Number(r.ticket),
    accountId: String(r.account_id),
    orderId: Number(r.order_id),
    positionId: Number(r.position_id),
    symbol: String(r.symbol),
    dealType: r.deal_type as MT5Deal['dealType'],
    dealEntry: r.deal_entry as MT5Deal['dealEntry'],
    volume: Number(r.volume),
    price: Number(r.price),
    profit: Number(r.profit),
    commission: Number(r.commission),
    swap: Number(r.swap),
    sl: r.sl !== null ? Number(r.sl) : null,
    tp: r.tp !== null ? Number(r.tp) : null,
    utcTime: String(r.utc_time),
    serverTimeRaw: String(r.server_time_raw),
    serverTzLabel: String(r.server_tz_label),
    magicNumber: Number(r.magic_number),
    comment: String(r.comment ?? ''),
  }));

  const openPositions = (
    db.prepare('SELECT * FROM mt5_open_positions ORDER BY open_time_utc DESC').all() as Array<
      Record<string, unknown>
    >
  ).map((r) => ({
    ticket: Number(r.ticket),
    accountId: String(r.account_id),
    symbol: String(r.symbol),
    direction: r.direction as 'BUY' | 'SELL',
    volume: Number(r.volume),
    openPrice: Number(r.open_price),
    currentPrice: Number(r.current_price),
    sl: r.sl !== null ? Number(r.sl) : null,
    tp: r.tp !== null ? Number(r.tp) : null,
    swap: Number(r.swap),
    commission: Number(r.commission),
    unrealisedProfit: Number(r.unrealised_profit),
    openTimeUtc: String(r.open_time_utc),
    serverTimeRaw: String(r.server_time_raw),
    serverTzLabel: String(r.server_tz_label),
    magicNumber: Number(r.magic_number),
    comment: String(r.comment ?? ''),
  }));

  const balanceOperations = (
    db.prepare('SELECT * FROM balance_operations ORDER BY utc_time ASC').all() as Array<
      Record<string, unknown>
    >
  ).map((r) => ({
    ticket: Number(r.ticket),
    accountId: String(r.account_id),
    dealType: r.deal_type as BalanceOperation['dealType'],
    amount: Number(r.amount),
    utcTime: String(r.utc_time),
    serverTimeRaw: String(r.server_time_raw),
    serverTzLabel: String(r.server_tz_label),
    comment: String(r.comment ?? ''),
  }));

  const journals = (
    db.prepare('SELECT * FROM trade_journals').all() as Array<Record<string, unknown>>
  ).map((r) => ({
    accountId: String(r.account_id),
    positionId: Number(r.position_id),
    strategy: String(r.strategy ?? ''),
    tags: safeJsonParse<string[]>(String(r.tags_json ?? '[]'), []),
    initialRiskCurrency: r.initial_risk_currency !== null ? Number(r.initial_risk_currency) : null,
    manualSlOverride: r.manual_sl_override !== null ? Number(r.manual_sl_override) : null,
    manualEntryOverride: r.manual_entry_override !== null ? Number(r.manual_entry_override) : null,
    outcomeOverride: (r.outcome_override as TradeJournalEntry['outcomeOverride']) ?? 'auto',
    rationale: String(r.rationale ?? ''),
    emotions: String(r.emotions ?? ''),
    mistakes: String(r.mistakes ?? ''),
    notes: String(r.notes ?? ''),
    sessionOverride: String(r.session_override ?? ''),
    updatedAtUtc: String(r.updated_at_utc),
  }));

  const dailyJournals = (
    db.prepare('SELECT * FROM daily_journals ORDER BY date DESC').all() as Array<
      Record<string, unknown>
    >
  ).map((r) => ({
    date: String(r.date),
    narrative: String(r.narrative ?? ''),
    mood: Number(r.mood),
    discipline: Number(r.discipline),
    stress: Number(r.stress),
    confidence: Number(r.confidence),
    sessionLabel: String(r.session_label ?? ''),
    lessons: String(r.lessons ?? ''),
    updatedAtUtc: String(r.updated_at_utc),
  }));

  const periodicReviews = (
    db.prepare('SELECT * FROM periodic_reviews ORDER BY start_date DESC').all() as Array<
      Record<string, unknown>
    >
  ).map((r) => ({
    id: String(r.id),
    periodType: r.period_type as PeriodicReview['periodType'],
    periodLabel: String(r.period_label),
    startDate: String(r.start_date),
    endDate: String(r.end_date),
    lessonsLearned: String(r.lessons_learned ?? ''),
    goalsNextPeriod: String(r.goals_next_period ?? ''),
    psychologicalTriggers: String(r.psychological_triggers ?? ''),
    rating: Number(r.rating),
    updatedAtUtc: String(r.updated_at_utc),
  }));

  const calendarEvents = (
    db.prepare('SELECT * FROM calendar_events ORDER BY date ASC').all() as Array<
      Record<string, unknown>
    >
  ).map((r) => ({
    id: String(r.id),
    date: String(r.date),
    title: String(r.title),
    category: r.category as CalendarEventMarker['category'],
    impact: r.impact as CalendarEventMarker['impact'],
    notes: String(r.notes ?? ''),
  }));

  const auditLogs: AuditLogEntry[] = (
    db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 100').all() as Array<
      Record<string, unknown>
    >
  ).map((r) => ({
    id: Number(r.id),
    utcTime: String(r.utc_time),
    action: String(r.action),
    entity: String(r.entity),
    details: String(r.details),
  }));

  return {
    accounts,
    deals,
    openPositions,
    balanceOperations,
    journals,
    dailyJournals,
    periodicReviews,
    calendarEvents,
    settings: getUserSettings(db),
    auditLogs,
  };
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
