import crypto from 'node:crypto';
import type { SyncDb } from './syncDb.ts';
import type {
  BalanceOperation,
  MT5Deal,
  MT5DealEntry,
  MT5DealType,
  MT5OpenPosition,
} from '../src/shared/types.ts';
import { serverOffsetMsAt, serverWallClockToUtcIso } from '../src/shared/timeUtils.ts';
import {
  appendAuditLog,
  recalculateAccountBalances,
  upsertBalanceOp,
  upsertDeal,
  upsertOpenPosition,
  type UpsertResult,
} from './db.ts';

export const INGEST_TOKEN_PREFIX = 'lfx_ing_';
export const MAX_ROWS_PER_INGEST = 5000;
const MAX_REJECTION_NOTES = 20;

// ---------------------------------------------------------------------------------------------
// Ingest tokens (one per account; only the SHA-256 hash is stored)
// ---------------------------------------------------------------------------------------------

export function generateIngestToken(): string {
  return `${INGEST_TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
}

export function hashIngestToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

export function verifyIngestToken(db: SyncDb, accountId: string, token: string): boolean {
  if (!token.startsWith(INGEST_TOKEN_PREFIX)) return false;
  const row = db.prepare('SELECT ingest_token_hash FROM mt5_accounts WHERE id = ?').get(accountId) as
    | { ingest_token_hash: string | null }
    | undefined;
  if (!row?.ingest_token_hash) return false;
  const expected = Buffer.from(row.ingest_token_hash, 'hex');
  const actual = Buffer.from(hashIngestToken(token), 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// ---------------------------------------------------------------------------------------------
// Payload normalisation
// ---------------------------------------------------------------------------------------------

export interface IngestAccountRow {
  id: string;
  account_login: string;
  broker_server: string;
  server_time_zone: string;
  server_utc_offset_label: string;
}

const DEAL_TYPES = new Set<MT5DealType>([
  'DEAL_TYPE_BUY',
  'DEAL_TYPE_SELL',
  'DEAL_TYPE_BALANCE',
  'DEAL_TYPE_CREDIT',
  'DEAL_TYPE_CHARGE',
  'DEAL_TYPE_CORRECTION',
  'DEAL_TYPE_DIVIDEND',
  'DEAL_TYPE_TAX',
]);
const TRADE_TYPES = new Set<MT5DealType>(['DEAL_TYPE_BUY', 'DEAL_TYPE_SELL']);
const BALANCE_TYPES = new Set<MT5DealType>([
  'DEAL_TYPE_BALANCE',
  'DEAL_TYPE_CREDIT',
  'DEAL_TYPE_CHARGE',
  'DEAL_TYPE_CORRECTION',
]);
const DEAL_ENTRIES = new Set<MT5DealEntry>([
  'DEAL_ENTRY_IN',
  'DEAL_ENTRY_OUT',
  'DEAL_ENTRY_INOUT',
  'DEAL_ENTRY_OUT_BY',
]);

type Raw = Record<string, unknown>;

const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);

function num(v: unknown, fallback = 0): number {
  if (v === null || v === undefined || v === '') return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function gmtLabel(offsetMs: number): string {
  const hours = offsetMs / 3600_000;
  const sign = hours >= 0 ? '+' : '-';
  const abs = Math.abs(hours);
  return Number.isInteger(abs) ? `GMT${sign}${abs}` : `GMT${sign}${abs.toFixed(1)}`;
}

function resolveTime(
  raw: unknown,
  account: Pick<IngestAccountRow, 'server_time_zone' | 'server_utc_offset_label'>,
): { iso: string; label: string; rawText: string } | null {
  const rawText = typeof raw === 'string' ? raw.trim() : '';
  const iso = serverWallClockToUtcIso(rawText, account.server_time_zone, account.server_utc_offset_label);
  if (!iso) return null;
  const label = gmtLabel(serverOffsetMsAt(new Date(iso).getTime(), account.server_time_zone, account.server_utc_offset_label));
  return { iso, label, rawText };
}

export type NormalizedDeal =
  | { kind: 'deal'; deal: MT5Deal }
  | { kind: 'balance'; op: BalanceOperation };

export function normalizeIngestDeal(
  raw: unknown,
  account: IngestAccountRow,
): { ok: true; value: NormalizedDeal } | { ok: false; reason: string } {
  if (!isObj(raw)) return { ok: false, reason: 'not an object' };
  const ticket = num(raw.ticket, NaN);
  if (!Number.isInteger(ticket) || ticket <= 0) return { ok: false, reason: 'invalid ticket' };

  const dealType = String(raw.dealType ?? '') as MT5DealType;
  if (!DEAL_TYPES.has(dealType)) return { ok: false, reason: `ticket ${ticket}: unsupported deal type "${raw.dealType}"` };

  const t = resolveTime(raw.serverTime, account);
  if (!t) return { ok: false, reason: `ticket ${ticket}: unreadable time "${String(raw.serverTime)}"` };

  const profit = num(raw.profit);
  const commission = num(raw.commission);
  const swap = num(raw.swap);
  const volume = num(raw.volume);
  const price = num(raw.price);
  if ([profit, commission, swap, volume, price].some(Number.isNaN)) {
    return { ok: false, reason: `ticket ${ticket}: non-numeric money/volume field` };
  }

  if (BALANCE_TYPES.has(dealType)) {
    return {
      ok: true,
      value: {
        kind: 'balance',
        op: {
          ticket,
          accountId: account.id,
          dealType: dealType as BalanceOperation['dealType'],
          // In MT5 the amount of a balance-type deal is carried in profit; any commission/swap is added defensively.
          amount: Math.round((profit + commission + swap) * 100) / 100,
          utcTime: t.iso,
          serverTimeRaw: t.rawText,
          serverTzLabel: t.label,
          comment: String(raw.comment ?? '').slice(0, 200) || 'Balance operation',
        },
      },
    };
  }

  if (!TRADE_TYPES.has(dealType)) {
    // dividends / taxes: not part of trade P/L and not a deposit — surfaced as a rejection note, not silently merged
    return { ok: false, reason: `ticket ${ticket}: ${dealType} is not imported` };
  }

  const symbol = String(raw.symbol ?? '').trim().toUpperCase();
  if (!symbol) return { ok: false, reason: `ticket ${ticket}: trade deal without symbol` };

  const dealEntry = String(raw.dealEntry ?? 'DEAL_ENTRY_IN') as MT5DealEntry;
  if (!DEAL_ENTRIES.has(dealEntry)) return { ok: false, reason: `ticket ${ticket}: unsupported entry "${raw.dealEntry}"` };

  const positionId = num(raw.positionId, NaN);
  if (!Number.isInteger(positionId) || positionId <= 0) {
    return { ok: false, reason: `ticket ${ticket}: missing position id (cannot pair entry/exit)` };
  }
  const orderId = num(raw.orderId, 0);
  const sl = num(raw.sl, 0);
  const tp = num(raw.tp, 0);

  return {
    ok: true,
    value: {
      kind: 'deal',
      deal: {
        ticket,
        accountId: account.id,
        orderId: Number.isInteger(orderId) && orderId > 0 ? orderId : ticket,
        positionId,
        symbol,
        dealType,
        dealEntry,
        volume,
        price,
        profit,
        commission,
        swap,
        sl: sl > 0 ? sl : null,
        tp: tp > 0 ? tp : null,
        utcTime: t.iso,
        serverTimeRaw: t.rawText,
        serverTzLabel: t.label,
        magicNumber: Math.trunc(num(raw.magicNumber, 0)) || 0,
        comment: String(raw.comment ?? '').slice(0, 200),
      },
    },
  };
}

export function normalizeIngestOpenPosition(
  raw: unknown,
  account: IngestAccountRow,
): { ok: true; value: MT5OpenPosition } | { ok: false; reason: string } {
  if (!isObj(raw)) return { ok: false, reason: 'open position is not an object' };
  const ticket = num(raw.ticket, NaN);
  if (!Number.isInteger(ticket) || ticket <= 0) return { ok: false, reason: 'open position: invalid ticket' };
  const t = resolveTime(raw.serverTime, account);
  if (!t) return { ok: false, reason: `open position ${ticket}: unreadable time` };
  const direction = raw.direction === 'BUY' || raw.direction === 'SELL' ? raw.direction : null;
  const symbol = String(raw.symbol ?? '').trim().toUpperCase();
  const nums = {
    volume: num(raw.volume),
    openPrice: num(raw.openPrice),
    currentPrice: num(raw.currentPrice),
    swap: num(raw.swap),
    commission: num(raw.commission),
    unrealisedProfit: num(raw.profit),
    sl: num(raw.sl, 0),
    tp: num(raw.tp, 0),
  };
  if (!direction || !symbol || Object.values(nums).some(Number.isNaN)) {
    return { ok: false, reason: `open position ${ticket}: invalid direction/symbol/number` };
  }
  return {
    ok: true,
    value: {
      ticket,
      accountId: account.id,
      symbol,
      direction,
      volume: nums.volume,
      openPrice: nums.openPrice,
      currentPrice: nums.currentPrice,
      sl: nums.sl > 0 ? nums.sl : null,
      tp: nums.tp > 0 ? nums.tp : null,
      swap: nums.swap,
      commission: nums.commission,
      unrealisedProfit: nums.unrealisedProfit,
      openTimeUtc: t.iso,
      serverTimeRaw: t.rawText,
      serverTzLabel: t.label,
      magicNumber: Math.trunc(num(raw.magicNumber, 0)) || 0,
      comment: String(raw.comment ?? '').slice(0, 200),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------------------------

export interface Tally {
  inserted: number;
  updated: number;
  unchanged: number;
  rejected: number;
}

export interface IngestResult {
  deals: Tally;
  balanceOperations: Tally;
  openPositions: number | null;
  rejections: string[];
  notice: string;
  reconciliation: { reportedBalance: number; computedBalance: number; difference: number } | null;
}

export type IngestOutcome =
  | { ok: true; result: IngestResult }
  | { ok: false; status: number; error: string };

const emptyTally = (): Tally => ({ inserted: 0, updated: 0, unchanged: 0, rejected: 0 });
const bump = (t: Tally, r: UpsertResult) => {
  t[r]++;
};

const norm = (s: string) => s.trim().toLowerCase();

export function processIngest(db: SyncDb, account: IngestAccountRow, body: unknown): IngestOutcome {
  if (!isObj(body)) return { ok: false, status: 400, error: 'Request body must be a JSON object.' };

  const info = isObj(body.accountInfo) ? body.accountInfo : null;
  if (!info || info.login === undefined || info.login === null) {
    return {
      ok: false,
      status: 400,
      error: 'accountInfo.login is required so LedgerFX can verify the data belongs to this linked account.',
    };
  }
  if (String(info.login).trim() !== account.account_login.trim()) {
    return {
      ok: false,
      status: 409,
      error: `Account mismatch: collector is logged into #${String(info.login)} but this LedgerFX account is #${account.account_login}. Nothing was imported.`,
    };
  }
  if (typeof info.server === 'string' && info.server.trim() && norm(info.server) !== norm(account.broker_server)) {
    return {
      ok: false,
      status: 409,
      error: `Server mismatch: collector reports "${info.server}" but this account is linked to "${account.broker_server}". Nothing was imported.`,
    };
  }
  if (info.tradeAllowed === true) {
    return {
      ok: false,
      status: 403,
      error:
        'Rejected: MT5 reports trading is allowed for this session, which means it is NOT an Investor-password (read-only) login. Sign in with the Investor password and retry.',
    };
  }

  const rawDeals = body.deals === undefined ? [] : body.deals;
  const rawOps = body.balanceOperations === undefined ? [] : body.balanceOperations;
  if (!Array.isArray(rawDeals) || !Array.isArray(rawOps)) {
    return { ok: false, status: 400, error: '"deals" and "balanceOperations" must be arrays.' };
  }
  if (rawDeals.length + rawOps.length > MAX_ROWS_PER_INGEST) {
    return {
      ok: false,
      status: 413,
      error: `Too many rows in one request (max ${MAX_ROWS_PER_INGEST}). Send the history in smaller batches.`,
    };
  }
  const rawOpen = body.openPositions;
  if (rawOpen !== undefined && rawOpen !== null && !Array.isArray(rawOpen)) {
    return { ok: false, status: 400, error: '"openPositions" must be an array when provided.' };
  }

  const dealTally = emptyTally();
  const opTally = emptyTally();
  const rejections: string[] = [];
  const reject = (tally: Tally, reason: string) => {
    tally.rejected++;
    if (rejections.length < MAX_REJECTION_NOTES) rejections.push(reason);
  };

  // Validate everything first so a bad batch is rejected row-by-row, never half-applied by accident.
  const dealsToWrite: MT5Deal[] = [];
  const opsToWrite: BalanceOperation[] = [];
  for (const raw of [...rawDeals, ...rawOps]) {
    const n = normalizeIngestDeal(raw, account);
    if (!n.ok) {
      reject(dealTally, n.reason);
    } else if (n.value.kind === 'deal') {
      dealsToWrite.push(n.value.deal);
    } else {
      opsToWrite.push(n.value.op);
    }
  }

  let openToWrite: MT5OpenPosition[] | null = null;
  if (Array.isArray(rawOpen)) {
    openToWrite = [];
    for (const raw of rawOpen) {
      const n = normalizeIngestOpenPosition(raw, account);
      if (n.ok) openToWrite.push(n.value);
      else reject(dealTally, n.reason);
    }
  }

  const reportedBalance = info.balance !== undefined ? num(info.balance, NaN) : NaN;
  const reportedEquity = info.equity !== undefined ? num(info.equity, NaN) : NaN;

  let reconciliation: IngestResult['reconciliation'] = null;

  const tx = db.transaction(() => {
    for (const d of dealsToWrite) bump(dealTally, upsertDeal(db, d));
    for (const op of opsToWrite) bump(opTally, upsertBalanceOp(db, op));

    if (openToWrite !== null) {
      db.prepare('DELETE FROM mt5_open_positions WHERE account_id = ?').run(account.id);
      for (const p of openToWrite) upsertOpenPosition(db, p);
    }

    recalculateAccountBalances(db, account.id);

    const row = db.prepare('SELECT balance, integrity_warnings_json FROM mt5_accounts WHERE id = ?').get(account.id) as {
      balance: number;
      integrity_warnings_json: string;
    };
    let warnings: string[] = [];
    try {
      warnings = JSON.parse(row.integrity_warnings_json) as string[];
    } catch {
      warnings = [];
    }
    warnings = warnings.filter((w) => !w.startsWith('Balance mismatch') && !w.startsWith('Partial sync interrupted'));

    if (Number.isFinite(reportedBalance)) {
      const difference = Math.round((reportedBalance - row.balance) * 100) / 100;
      reconciliation = { reportedBalance, computedBalance: row.balance, difference };
      const tolerance = Math.max(1, Math.abs(reportedBalance) * 0.001);
      if (Math.abs(difference) > tolerance) {
        warnings.unshift(
          `Balance mismatch: broker reports ${reportedBalance.toFixed(2)} but imported history sums to ${row.balance.toFixed(2)} (difference ${difference.toFixed(2)}). History may be incomplete — in MT5 History tab choose "All History", then run the collector in full mode.`,
        );
      }
    }

    db.prepare(
      'UPDATE mt5_accounts SET reported_balance = COALESCE(?, reported_balance), reported_equity = COALESCE(?, reported_equity), integrity_warnings_json = ? WHERE id = ?',
    ).run(
      Number.isFinite(reportedBalance) ? reportedBalance : null,
      Number.isFinite(reportedEquity) ? reportedEquity : null,
      JSON.stringify(warnings.slice(0, 5)),
      account.id,
    );
  });
  tx();

  const newTotal = dealTally.inserted + opTally.inserted;
  const updTotal = dealTally.updated + opTally.updated;
  const notice =
    `Collector sync: ${dealTally.inserted} new deals, ${dealTally.updated} corrected, ${dealTally.unchanged} already present (skipped), ` +
    `${opTally.inserted} new balance operations` +
    (openToWrite !== null ? `, ${openToWrite.length} open positions refreshed` : '') +
    (dealTally.rejected > 0 ? `, ${dealTally.rejected} rows rejected` : '') +
    '.';

  db.prepare('UPDATE mt5_accounts SET last_sync_utc = ?, sync_notice = ? WHERE id = ?').run(
    new Date().toISOString(),
    notice,
    account.id,
  );
  appendAuditLog(
    db,
    'COLLECTOR_INGEST',
    `MT5 #${account.account_login}`,
    `${notice} (${newTotal} inserted, ${updTotal} updated in total)`,
  );

  return {
    ok: true,
    result: {
      deals: dealTally,
      balanceOperations: opTally,
      openPositions: openToWrite ? openToWrite.length : null,
      rejections,
      notice,
      reconciliation,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Timestamp rebuild (used when the broker server time zone setting is corrected)
// ---------------------------------------------------------------------------------------------

export function rebuildAccountTimestamps(
  db: SyncDb,
  accountId: string,
  serverTimeZone: string,
  serverUtcOffsetLabel: string,
): { deals: number; balanceOperations: number; openPositions: number } {
  const acct = { server_time_zone: serverTimeZone, server_utc_offset_label: serverUtcOffsetLabel };
  let deals = 0;
  let ops = 0;
  let open = 0;

  const rebuild = (
    table: 'mt5_deals' | 'balance_operations' | 'mt5_open_positions',
    timeColumn: 'utc_time' | 'open_time_utc',
  ): number => {
    const rows = db
      .prepare(`SELECT ticket, server_time_raw, ${timeColumn} AS current_utc, server_tz_label FROM ${table} WHERE account_id = ?`)
      .all(accountId) as Array<{ ticket: number; server_time_raw: string; current_utc: string; server_tz_label: string }>;
    const update = db.prepare(
      `UPDATE ${table} SET ${timeColumn} = ?, server_tz_label = ? WHERE account_id = ? AND ticket = ?`,
    );
    let changed = 0;
    for (const r of rows) {
      const t = resolveTime(r.server_time_raw, acct);
      if (!t) continue; // keep the stored value rather than guess
      if (t.iso !== r.current_utc || t.label !== r.server_tz_label) {
        update.run(t.iso, t.label, accountId, r.ticket);
        changed++;
      }
    }
    return changed;
  };

  deals = rebuild('mt5_deals', 'utc_time');
  ops = rebuild('balance_operations', 'utc_time');
  open = rebuild('mt5_open_positions', 'open_time_utc');

  const earliest = db
    .prepare(
      "SELECT MIN(utc_time) AS earliest FROM mt5_deals WHERE account_id = ? AND deal_type IN ('DEAL_TYPE_BUY','DEAL_TYPE_SELL')",
    )
    .get(accountId) as { earliest: string | null };
  db.prepare('UPDATE mt5_accounts SET earliest_available_utc = ? WHERE id = ?').run(earliest.earliest, accountId);

  return { deals, balanceOperations: ops, openPositions: open };
}
