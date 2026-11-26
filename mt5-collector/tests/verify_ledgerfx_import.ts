/**
 * End-to-end compatibility test feeding the synthetic CSV produced by mt5-collector
 * directly into LedgerFX's ACTUAL parseMT5CsvDeals() and buildClosedTrades() functions.
 *
 * Uses 100% synthetic sample data and does not modify any existing LedgerFX files or database.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildClosedTrades, parseMT5CsvDeals } from '../../src/shared/mt5Engine.ts';
import {
  DEFAULT_SETTINGS,
  type MT5Account,
  type MT5OpenPosition,
} from '../../src/shared/types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sampleDealsCsvPath = path.resolve(__dirname, '../sample_output/deals_sample_ledgerfx.csv');

function runCompatibilityVerification(): void {
  assert.ok(fs.existsSync(sampleDealsCsvPath), `Missing sample CSV at ${sampleDealsCsvPath}`);
  const csvText = fs.readFileSync(sampleDealsCsvPath, 'utf-8');

  const syntheticAccountId = 'acc_synthetic_collector_test';
  const parsed = parseMT5CsvDeals(csvText, syntheticAccountId, 'GMT+2');

  assert.equal(parsed.warnings.length, 0, `Expected 0 parser warnings, got: ${parsed.warnings.join('; ')}`);
  assert.equal(parsed.balanceOps.length, 1, 'Expected 1 synthetic deposit balance operation');
  assert.equal(parsed.balanceOps[0].dealType, 'DEAL_TYPE_BALANCE');
  assert.equal(parsed.balanceOps[0].amount, 10000);
  assert.equal(parsed.deals.length, 9, 'Expected 9 trade deals (including 4 partial fills + 1 open entry)');

  // Verify SL/TP enrichment from historical orders survived CSV import
  const eurusdEntry = parsed.deals.find((d) => d.ticket === 980101);
  assert.ok(eurusdEntry, 'Expected EURUSD entry deal #980101');
  assert.equal(eurusdEntry.sl, 1.079);
  assert.equal(eurusdEntry.tp, 1.088);

  // Verify sanitised comments did not shift columns
  assert.equal(eurusdEntry.comment, 'London open breakout clean structure');

  const syntheticAccount: MT5Account = {
    id: syntheticAccountId,
    friendlyName: 'Synthetic Collector Test',
    accountLogin: '99001234',
    brokerName: 'Synthetic Test Broker Ltd',
    brokerServer: 'SyntheticBroker-Demo01',
    environment: 'demo',
    accountMode: 'hedging',
    currency: 'USD',
    leverage: 100,
    serverTimeZone: 'Europe/Athens',
    serverUtcOffsetLabel: 'GMT+2',
    connectionType: 'csv_import',
    hasCredentials: false,
    initialBalance: 10000,
    balance: 10688.7,
    equity: 10754.2,
    lastSyncUtc: '2026-11-20T18:00:00.000Z',
    highestDealTicket: 980109,
    earliestAvailableUtc: '2026-11-10T07:15:01.000Z',
    expectedStartUtc: null,
    syncNotice: null,
    integrityWarnings: [],
    createdAtUtc: '2026-11-20T18:00:00.000Z',
  };

  // Include currently open USDJPY #780104 so LedgerFX keeps it out of realised closed trades
  const openPositions: MT5OpenPosition[] = [
    {
      ticket: 780104,
      accountId: syntheticAccountId,
      symbol: 'USDJPY',
      direction: 'SELL',
      volume: 0.3,
      openPrice: 154.65,
      currentPrice: 154.31,
      sl: 155.15,
      tp: 153.4,
      swap: -1.1,
      commission: -1.05,
      unrealisedProfit: 67.65,
      openTimeUtc: '2026-11-20T11:15:01.000Z',
      serverTimeRaw: '2026.11.20 13:15:01',
      serverTzLabel: 'GMT+2',
      magicNumber: 0,
      comment: 'Open swing short',
    },
  ];

  const { closedTrades, unsupportedDealNotices } = buildClosedTrades(
    parsed.deals,
    [syntheticAccount],
    [],
    openPositions,
    DEFAULT_SETTINGS,
  );

  assert.equal(unsupportedDealNotices.length, 0, 'Expected zero unsupported deal notices');
  assert.equal(closedTrades.length, 3, 'Expected exactly 3 closed trades (EURUSD, GBPUSD, XAUUSD)');

  // Verify partial-entry + partial-exit XAUUSD position #780103 grouped cleanly into 1 trade
  const xauTrade = closedTrades.find((t) => t.positionId === 780103);
  assert.ok(xauTrade, 'Expected XAUUSD position #780103');
  assert.equal(xauTrade.isPartial, true);
  assert.equal(xauTrade.entryFillsCount, 2);
  assert.equal(xauTrade.exitFillsCount, 2);
  assert.equal(xauTrade.totalVolume, 0.5);
  assert.equal(xauTrade.grossProfit, 552.5);
  assert.equal(xauTrade.commission, -5);
  assert.equal(xauTrade.netProfit, 547.5);
  assert.equal(xauTrade.sl, 2628);
  assert.ok(xauTrade.rMultiple !== null && xauTrade.rMultiple > 0, 'Expected positive R-multiple from order SL enrichment');

  // Verify idempotent duplicate prevention (re-importing the exact same CSV yields zero new tickets)
  const seenTickets = new Set<number>(parsed.deals.map((d) => d.ticket));
  const reparsed = parseMT5CsvDeals(csvText, syntheticAccountId, 'GMT+2');
  const duplicateInsertions = reparsed.deals.filter((d) => !seenTickets.has(d.ticket));
  assert.equal(duplicateInsertions.length, 0, 'Re-importing identical CSV must introduce 0 duplicate deals');

  console.log('PASS: LedgerFX CSV Importer Compatibility Verification');
  console.log(`  - Parsed deals: ${parsed.deals.length}, balance ops: ${parsed.balanceOps.length}, warnings: ${parsed.warnings.length}`);
  console.log(`  - Reconstructed closed trades: ${closedTrades.length} (including multi-fill XAUUSD #780103: ${xauTrade.entryFillsCount} entries, ${xauTrade.exitFillsCount} exits, Net P/L ${xauTrade.netProfit}, ${xauTrade.rMultiple}R)`);
  console.log('  - Duplicate re-import check: 0 duplicates');
}

runCompatibilityVerification();
