/**
 * Server-side integrity tests (synthetic data only, in-memory SQLite).
 * Run with: npx tsx tests/ingest.test.ts
 */
import assert from 'node:assert/strict';
import { openDatabase, insertAccountRow, upsertDeal } from '../server/db.ts';
import {
  generateIngestToken,
  hashIngestToken,
  processIngest,
  rebuildAccountTimestamps,
  verifyIngestToken,
  type IngestAccountRow,
} from '../server/ingest.ts';
import { buildClosedTrades, parseMT5CsvDeals } from '../src/shared/mt5Engine.ts';
import { MT5_EET_US_DST_ZONE, serverWallClockToUtcIso } from '../src/shared/timeUtils.ts';
import { DEFAULT_SETTINGS, type MT5Account } from '../src/shared/types.ts';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// ---- time conversion ---------------------------------------------------------------------------
test('server wall-clock → UTC honours DST (US-schedule EET broker)', () => {
  // Winter: GMT+2
  assert.equal(serverWallClockToUtcIso('2026.01.15 10:00:00', MT5_EET_US_DST_ZONE), '2026-01-15T08:00:00.000Z');
  // Summer: GMT+3
  assert.equal(serverWallClockToUtcIso('2026.07.15 10:00:00', MT5_EET_US_DST_ZONE), '2026-07-15T07:00:00.000Z');
  // Late March: EU still on winter time but US already on DST → broker is already GMT+3
  assert.equal(serverWallClockToUtcIso('2026.03.20 10:00:00', MT5_EET_US_DST_ZONE), '2026-03-20T07:00:00.000Z');
});

test('Europe/Athens follows EU DST; fixed label is the fallback', () => {
  assert.equal(serverWallClockToUtcIso('2026.03.20 10:00:00', 'Europe/Athens'), '2026-03-20T08:00:00.000Z');
  assert.equal(serverWallClockToUtcIso('2026.07.15 10:00:00', 'Europe/Athens'), '2026-07-15T07:00:00.000Z');
  assert.equal(serverWallClockToUtcIso('2026.07.15 10:00:00', null, 'GMT+2'), '2026-07-15T08:00:00.000Z');
});

test('invalid time returns null instead of "now"', () => {
  assert.equal(serverWallClockToUtcIso('garbage', 'UTC'), null);
  assert.equal(serverWallClockToUtcIso('', 'UTC'), null);
});

// ---- CSV parser --------------------------------------------------------------------------------
test('CSV: quoted comma comment does not shift columns; bad rows warn instead of inventing data', () => {
  const csv = [
    'DEAL_TICKET,DEAL_ORDER,DEAL_POSITION_ID,DEAL_TIME,DEAL_SYMBOL,DEAL_TYPE,DEAL_ENTRY,DEAL_VOLUME,DEAL_PRICE,DEAL_PROFIT,DEAL_COMMISSION,DEAL_SWAP,SL,TP,DEAL_COMMENT',
    '1,10,100,2026.01.15 10:00:00,EURUSD,DEAL_TYPE_BUY,DEAL_ENTRY_IN,0.10,1.10000,0,-0.7,0,1.09,1.12,"breakout, retest"',
    ',11,101,2026.01.15 10:00:00,EURUSD,DEAL_TYPE_BUY,DEAL_ENTRY_IN,0.10,1.10000,0,0,0,,,missing ticket',
    '3,12,102,not-a-time,EURUSD,DEAL_TYPE_BUY,DEAL_ENTRY_IN,0.10,1.1,0,0,0,,,bad time',
    '4,13,103,2026.01.15 10:00:00,EURUSD,DEAL_TYPE_BUY_CANCELED,DEAL_ENTRY_IN,0.10,1.1,0,0,0,,,cancelled',
  ].join('\n');
  const parsed = parseMT5CsvDeals(csv, 'acc', 'GMT+2', MT5_EET_US_DST_ZONE);
  assert.equal(parsed.deals.length, 1);
  assert.equal(parsed.deals[0].comment, 'breakout, retest');
  assert.equal(parsed.deals[0].sl, 1.09);
  assert.equal(parsed.warnings.length, 3);
});

// ---- implied-risk R multiple -------------------------------------------------------------------
test('R-multiple risk is implied from the trade’s own P/L (not a hard-coded pip value)', () => {
  const csv = [
    'DEAL_TICKET,DEAL_ORDER,DEAL_POSITION_ID,DEAL_TIME,DEAL_SYMBOL,DEAL_TYPE,DEAL_ENTRY,DEAL_VOLUME,DEAL_PRICE,DEAL_PROFIT,DEAL_COMMISSION,DEAL_SWAP,SL,TP,DEAL_COMMENT',
    // 1 lot EURUSD: +100 pips = +1000 account-currency → 10 per pip; SL 50 pips → risk 500 → net 1000 → 2R
    '1,10,100,2026.01.15 10:00:00,EURUSD,DEAL_TYPE_BUY,DEAL_ENTRY_IN,1.00,1.10000,0,0,0,1.09500,1.12,x',
    '2,11,100,2026.01.15 12:00:00,EURUSD,DEAL_TYPE_SELL,DEAL_ENTRY_OUT,1.00,1.11000,1000,0,0,1.09500,1.12,x',
  ].join('\n');
  const parsed = parseMT5CsvDeals(csv, 'acc', 'GMT+2', 'UTC');
  const acc = { id: 'acc', friendlyName: 'T', currency: 'USD' } as MT5Account;
  const { closedTrades } = buildClosedTrades(parsed.deals, [acc], [], [], DEFAULT_SETTINGS);
  assert.equal(closedTrades.length, 1);
  assert.equal(closedTrades[0].riskSource, 'implied');
  assert.equal(closedTrades[0].initialRiskCurrency, 500);
  assert.equal(closedTrades[0].rMultiple, 2);
});

// ---- ingest ------------------------------------------------------------------------------------
function makeAccount(db: ReturnType<typeof openDatabase>): IngestAccountRow {
  const acc: MT5Account = {
    id: 'acc_test',
    friendlyName: 'Brother live',
    accountLogin: '5550001',
    brokerName: 'Test Broker',
    brokerServer: 'TestBroker-Live',
    environment: 'live',
    accountMode: 'hedging',
    currency: 'USD',
    leverage: 100,
    serverTimeZone: MT5_EET_US_DST_ZONE,
    serverUtcOffsetLabel: 'GMT+2',
    connectionType: 'collector',
    hasCredentials: false,
    initialBalance: 0,
    balance: 0,
    equity: 0,
    lastSyncUtc: null,
    highestDealTicket: 0,
    earliestAvailableUtc: null,
    expectedStartUtc: null,
    syncNotice: null,
    integrityWarnings: [],
    createdAtUtc: new Date().toISOString(),
  };
  insertAccountRow(db, acc, null);
  return {
    id: acc.id,
    account_login: acc.accountLogin,
    broker_server: acc.brokerServer,
    server_time_zone: acc.serverTimeZone,
    server_utc_offset_label: acc.serverUtcOffsetLabel,
  };
}

const batch = () => ({
  accountInfo: { login: '5550001', server: 'TestBroker-Live', tradeAllowed: false, balance: 10097.1, equity: 10097.1 },
  balanceOperations: [
    { ticket: 1, dealType: 'DEAL_TYPE_BALANCE', profit: 10000, serverTime: '2026.07.01 08:00:00', comment: 'Deposit' },
  ],
  deals: [
    { ticket: 2, orderId: 20, positionId: 200, symbol: 'EURUSD', dealType: 'DEAL_TYPE_BUY', dealEntry: 'DEAL_ENTRY_IN', volume: 0.5, price: 1.1, profit: 0, commission: -1.5, swap: 0, sl: 1.095, tp: 1.12, serverTime: '2026.07.02 10:00:00', comment: '' },
    { ticket: 3, orderId: 21, positionId: 200, symbol: 'EURUSD', dealType: 'DEAL_TYPE_SELL', dealEntry: 'DEAL_ENTRY_OUT', volume: 0.5, price: 1.104, profit: 100, commission: -1.5, swap: 0.1, sl: 1.095, tp: 1.12, serverTime: '2026.07.02 15:00:00', comment: '' },
  ],
  openPositions: [],
});

test('ingest is idempotent: re-sending the same batch creates zero duplicates', () => {
  const db = openDatabase(':memory:');
  const account = makeAccount(db);
  const first = processIngest(db, account, batch());
  assert.ok(first.ok);
  if (first.ok) {
    assert.equal(first.result.deals.inserted, 2);
    assert.equal(first.result.balanceOperations.inserted, 1);
    assert.equal(first.result.reconciliation?.difference, 0);
  }
  const second = processIngest(db, account, batch());
  assert.ok(second.ok);
  if (second.ok) {
    assert.equal(second.result.deals.inserted, 0);
    assert.equal(second.result.deals.unchanged, 2);
  }
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM mt5_deals').get() as { c: number }).c, 2);
});

test('ingest corrects an amended deal instead of ignoring it', () => {
  const db = openDatabase(':memory:');
  const account = makeAccount(db);
  processIngest(db, account, batch());
  const amended = batch();
  amended.deals[1].commission = -2.25; // broker posted the final commission later
  const res = processIngest(db, account, amended);
  assert.ok(res.ok);
  if (res.ok) assert.equal(res.result.deals.updated, 1);
  const row = db.prepare('SELECT commission FROM mt5_deals WHERE ticket = 3').get() as { commission: number };
  assert.equal(row.commission, -2.25);
});

test('ingest stores DST-correct UTC times', () => {
  const db = openDatabase(':memory:');
  const account = makeAccount(db);
  processIngest(db, account, batch());
  const row = db.prepare('SELECT utc_time, server_tz_label FROM mt5_deals WHERE ticket = 2').get() as {
    utc_time: string;
    server_tz_label: string;
  };
  assert.equal(row.utc_time, '2026-07-02T07:00:00.000Z'); // 10:00 server = GMT+3 in July
  assert.equal(row.server_tz_label, 'GMT+3');
});

test('ingest rejects data from a different MT5 login (no cross-account contamination)', () => {
  const db = openDatabase(':memory:');
  const account = makeAccount(db);
  const bad = batch();
  bad.accountInfo.login = '9999999';
  const res = processIngest(db, account, bad);
  assert.ok(!res.ok);
  if (!res.ok) assert.equal(res.status, 409);
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM mt5_deals').get() as { c: number }).c, 0);
});

test('ingest rejects a trade-enabled (master password) session', () => {
  const db = openDatabase(':memory:');
  const account = makeAccount(db);
  const bad = batch();
  bad.accountInfo.tradeAllowed = true;
  const res = processIngest(db, account, bad);
  assert.ok(!res.ok);
  if (!res.ok) assert.equal(res.status, 403);
});

test('ingest flags a balance mismatch when history is incomplete', () => {
  const db = openDatabase(':memory:');
  const account = makeAccount(db);
  const partial = batch();
  partial.accountInfo.balance = 12500; // broker says more than the imported history explains
  const res = processIngest(db, account, partial);
  assert.ok(res.ok);
  const w = (db.prepare('SELECT integrity_warnings_json AS j FROM mt5_accounts WHERE id = ?').get('acc_test') as { j: string }).j;
  assert.ok(w.includes('Balance mismatch'));
});

test('invalid rows are rejected individually and never fabricated', () => {
  const db = openDatabase(':memory:');
  const account = makeAccount(db);
  const mixed = batch();
  mixed.deals.push({ ticket: 4, positionId: 0, symbol: 'EURUSD', dealType: 'DEAL_TYPE_BUY', dealEntry: 'DEAL_ENTRY_IN', serverTime: 'nonsense' } as never);
  const res = processIngest(db, account, mixed);
  assert.ok(res.ok);
  if (res.ok) {
    assert.equal(res.result.deals.rejected, 1);
    assert.equal(res.result.deals.inserted, 2);
  }
});

test('open positions are replaced as a set (closed positions disappear)', () => {
  const db = openDatabase(':memory:');
  const account = makeAccount(db);
  const withOpen = batch();
  withOpen.openPositions = [
    { ticket: 300, symbol: 'GBPUSD', direction: 'BUY', volume: 0.2, openPrice: 1.25, currentPrice: 1.26, swap: 0, commission: 0, profit: 20, serverTime: '2026.07.03 09:00:00' } as never,
  ];
  processIngest(db, account, withOpen);
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM mt5_open_positions').get() as { c: number }).c, 1);
  processIngest(db, account, batch()); // openPositions: [] → all closed
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM mt5_open_positions').get() as { c: number }).c, 0);
});

test('correcting the broker time zone rebuilds stored UTC timestamps', () => {
  const db = openDatabase(':memory:');
  const account = makeAccount(db);
  processIngest(db, account, batch());
  const rebuilt = rebuildAccountTimestamps(db, account.id, 'UTC', 'GMT+0');
  assert.ok(rebuilt.deals >= 2);
  const row = db.prepare('SELECT utc_time FROM mt5_deals WHERE ticket = 2').get() as { utc_time: string };
  assert.equal(row.utc_time, '2026-07-02T10:00:00.000Z');
});

test('ingest tokens: only the hash is stored, wrong tokens fail', () => {
  const db = openDatabase(':memory:');
  const account = makeAccount(db);
  const token = generateIngestToken();
  db.prepare('UPDATE mt5_accounts SET ingest_token_hash = ? WHERE id = ?').run(hashIngestToken(token), account.id);
  assert.ok(verifyIngestToken(db, account.id, token));
  assert.ok(!verifyIngestToken(db, account.id, generateIngestToken()));
  assert.ok(!verifyIngestToken(db, 'other', token));
  const stored = (db.prepare('SELECT ingest_token_hash AS h FROM mt5_accounts WHERE id = ?').get(account.id) as { h: string }).h;
  assert.ok(!stored.includes(token));
});

test('upsertDeal reports inserted / unchanged / updated', () => {
  const db = openDatabase(':memory:');
  const account = makeAccount(db);
  const deal = {
    ticket: 77, accountId: account.id, orderId: 1, positionId: 5, symbol: 'EURUSD',
    dealType: 'DEAL_TYPE_BUY' as const, dealEntry: 'DEAL_ENTRY_IN' as const, volume: 1, price: 1.1,
    profit: 0, commission: -1, swap: 0, sl: null, tp: null, utcTime: '2026-01-01T00:00:00.000Z',
    serverTimeRaw: '2026.01.01 02:00:00', serverTzLabel: 'GMT+2', magicNumber: 0, comment: '',
  };
  assert.equal(upsertDeal(db, deal), 'inserted');
  assert.equal(upsertDeal(db, deal), 'unchanged');
  assert.equal(upsertDeal(db, { ...deal, commission: -1.5 }), 'updated');
});

test('re-sent deal without SL/TP does not erase the stored SL/TP', () => {
  const db = openDatabase(':memory:');
  const account = makeAccount(db);
  const deal = {
    ticket: 88, accountId: account.id, orderId: 1, positionId: 6, symbol: 'EURUSD',
    dealType: 'DEAL_TYPE_BUY' as const, dealEntry: 'DEAL_ENTRY_IN' as const, volume: 1, price: 1.1,
    profit: 0, commission: -1, swap: 0, sl: 1.09, tp: 1.12, utcTime: '2026-01-01T00:00:00.000Z',
    serverTimeRaw: '2026.01.01 02:00:00', serverTzLabel: 'GMT+2', magicNumber: 0, comment: '',
  };
  upsertDeal(db, deal);
  assert.equal(upsertDeal(db, { ...deal, sl: null, tp: null }), 'unchanged');
  const row = db.prepare('SELECT sl, tp FROM mt5_deals WHERE ticket = 88').get() as { sl: number; tp: number };
  assert.equal(row.sl, 1.09);
  assert.equal(row.tp, 1.12);
});

console.log(`\nPASS: ${passed} server/engine integrity tests`);
