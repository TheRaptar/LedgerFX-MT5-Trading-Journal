import type {
  BalanceOperation,
  ClosedTrade,
  MT5Account,
  MT5Deal,
  MT5DealEntry,
  MT5DealType,
  MT5OpenPosition,
  TradeJournalEntry,
  UserSettings,
} from './types.ts';
import { classifyTradingSession, serverWallClockToUtcIso } from './timeUtils.ts';

const TRADE_DEAL_TYPES = new Set<MT5DealType>(['DEAL_TYPE_BUY', 'DEAL_TYPE_SELL']);
const BALANCE_DEAL_TYPES = new Set<MT5DealType>([
  'DEAL_TYPE_BALANCE',
  'DEAL_TYPE_CREDIT',
  'DEAL_TYPE_CHARGE',
  'DEAL_TYPE_CORRECTION',
]);

export function roundTo(num: number, decimals = 2): number {
  const factor = Math.pow(10, decimals);
  return Math.round((num + Number.EPSILON) * factor) / factor;
}

/**
 * Currency value of a 1.0 price move for 1 lot, implied by the trade's own realised result.
 * This is exact for any symbol/account currency (it already embeds contract size and FX conversion),
 * unlike a fixed pip-value guess. Returns null when it cannot be derived (breakeven, mixed signs).
 */
function impliedValuePerPriceUnitPerLot(
  direction: 'BUY' | 'SELL',
  weightedEntry: number,
  weightedExit: number,
  closedVolume: number,
  grossProfit: number,
): number | null {
  if (!(closedVolume > 0)) return null;
  const signedMove = direction === 'BUY' ? weightedExit - weightedEntry : weightedEntry - weightedExit;
  if (Math.abs(signedMove) < 1e-9) return null;
  if (grossProfit * signedMove <= 0) return null; // price moved one way but P/L says otherwise
  const value = grossProfit / (closedVolume * signedMove);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Reconstructs closed round-trip trades from raw MT5 deals grouped strictly by (accountId, positionId).
 * Preserves all partial entry and partial exit fills under one trade entry and computes
 * volume-weighted average entry and exit prices alongside net P/L (gross + swap + commission).
 */
export function buildClosedTrades(
  deals: MT5Deal[],
  accounts: MT5Account[],
  journals: TradeJournalEntry[],
  openPositions: MT5OpenPosition[],
  settings: UserSettings,
): { closedTrades: ClosedTrade[]; unsupportedDealNotices: string[] } {
  const accountMap = new Map(accounts.map((a) => [a.id, a]));
  const journalMap = new Map(journals.map((j) => [`${j.accountId}:${j.positionId}`, j]));
  const openPosKeys = new Set(openPositions.map((p) => `${p.accountId}:${p.ticket}`));
  const unsupportedDealNotices: string[] = [];

  const grouped = new Map<string, MT5Deal[]>();

  for (const deal of deals) {
    if (BALANCE_DEAL_TYPES.has(deal.dealType)) continue;
    if (!TRADE_DEAL_TYPES.has(deal.dealType)) {
      unsupportedDealNotices.push(
        `Skipped non-trade deal #${deal.ticket} (${deal.dealType}) on ${deal.symbol || 'account'}.`,
      );
      continue;
    }
    if (!deal.positionId) continue;
    const key = `${deal.accountId}:${deal.positionId}`;
    const list = grouped.get(key) ?? [];
    list.push(deal);
    grouped.set(key, list);
  }

  const closedTrades: ClosedTrade[] = [];

  for (const [key, posDeals] of grouped.entries()) {
    // Skip positions that are still open in MT5 so open trades never pollute realised stats
    if (openPosKeys.has(key)) continue;

    const sorted = [...posDeals].sort((a, b) => {
      const tDiff = new Date(a.utcTime).getTime() - new Date(b.utcTime).getTime();
      return tDiff !== 0 ? tDiff : a.ticket - b.ticket;
    });

    const entryDeals = sorted.filter(
      (d) => d.dealEntry === 'DEAL_ENTRY_IN' || d.dealEntry === 'DEAL_ENTRY_INOUT',
    );
    const exitDeals = sorted.filter(
      (d) =>
        d.dealEntry === 'DEAL_ENTRY_OUT' ||
        d.dealEntry === 'DEAL_ENTRY_OUT_BY' ||
        d.dealEntry === 'DEAL_ENTRY_INOUT',
    );

    // Must have at least one exit deal to be a closed trade
    if (exitDeals.length === 0 || entryDeals.length === 0) continue;

    const firstEntry = entryDeals[0];
    const lastExit = exitDeals[exitDeals.length - 1];
    const account = accountMap.get(firstEntry.accountId);
    const journal = journalMap.get(key) ?? null;

    const totalEntryVol = entryDeals.reduce((sum, d) => sum + d.volume, 0);
    const totalExitVol = exitDeals.reduce((sum, d) => sum + d.volume, 0);

    const weightedEntryPrice =
      totalEntryVol > 0
        ? entryDeals.reduce((sum, d) => sum + d.price * d.volume, 0) / totalEntryVol
        : firstEntry.price;

    const weightedExitPrice =
      totalExitVol > 0
        ? exitDeals.reduce((sum, d) => sum + d.price * d.volume, 0) / totalExitVol
        : lastExit.price;

    const grossProfit = roundTo(sorted.reduce((sum, d) => sum + d.profit, 0), 2);
    const commission = roundTo(sorted.reduce((sum, d) => sum + d.commission, 0), 2);
    const swap = roundTo(sorted.reduce((sum, d) => sum + d.swap, 0), 2);
    // In MT5, commissions and negative swaps are already signed (negative for costs)
    const netProfit = roundTo(grossProfit + commission + swap, 2);

    const slFromDeals = sorted.find((d) => d.sl !== null && d.sl > 0)?.sl ?? null;
    const tpFromDeals = sorted.find((d) => d.tp !== null && d.tp > 0)?.tp ?? null;
    const effectiveSl = journal?.manualSlOverride ?? slFromDeals;
    const effectiveEntry = journal?.manualEntryOverride ?? weightedEntryPrice;

    const durationMs = Math.max(
      0,
      new Date(lastExit.utcTime).getTime() - new Date(firstEntry.utcTime).getTime(),
    );
    const durationMinutes = Math.round(durationMs / 60000);

    const direction: 'BUY' | 'SELL' = firstEntry.dealType === 'DEAL_TYPE_BUY' ? 'BUY' : 'SELL';

    // Initial risk: user-entered > implied from the trade's own P/L and SL distance > pip-value heuristic
    let initialRiskCurrency = journal?.initialRiskCurrency ?? null;
    let riskSource: ClosedTrade['riskSource'] = initialRiskCurrency !== null ? 'manual' : null;
    if (initialRiskCurrency === null && effectiveSl !== null && effectiveEntry > 0) {
      const slDistance = Math.abs(effectiveEntry - effectiveSl);
      const valuePerUnit = impliedValuePerPriceUnitPerLot(
        direction,
        weightedEntryPrice,
        weightedExitPrice,
        Math.min(totalEntryVol, totalExitVol),
        grossProfit,
      );
      if (valuePerUnit !== null) {
        const implied = roundTo(slDistance * valuePerUnit * totalEntryVol, 2);
        if (implied > 0) {
          initialRiskCurrency = implied;
          riskSource = 'implied';
        }
      } else {
        const symbolUpper = firstEntry.symbol.toUpperCase();
        const pipFactor = symbolUpper.includes('JPY') ? 100 : symbolUpper.includes('XAU') ? 10 : 10000;
        const approxPipValuePerLot = symbolUpper.includes('XAU') ? 10 : 8.2;
        const estimated = roundTo(slDistance * pipFactor * totalEntryVol * approxPipValuePerLot, 2);
        if (estimated > 0) {
          initialRiskCurrency = estimated;
          riskSource = 'heuristic';
        }
      }
    }

    const rMultiple =
      initialRiskCurrency && initialRiskCurrency > 0
        ? roundTo(netProfit / initialRiskCurrency, 2)
        : null;

    let outcome: 'win' | 'loss' | 'breakeven' =
      netProfit > 0.01 ? 'win' : netProfit < -0.01 ? 'loss' : 'breakeven';
    if (journal?.outcomeOverride && journal.outcomeOverride !== 'auto') {
      outcome = journal.outcomeOverride;
    }

    const autoSession = classifyTradingSession(firstEntry.utcTime, settings.sessionWindows);
    const session = (journal?.sessionOverride as ClosedTrade['session']) || autoSession;

    closedTrades.push({
      key,
      accountId: firstEntry.accountId,
      accountName: account?.friendlyName ?? firstEntry.accountId,
      accountCurrency: account?.currency ?? settings.baseCurrency,
      positionId: firstEntry.positionId,
      symbol: firstEntry.symbol,
      direction,
      totalVolume: roundTo(Math.max(totalEntryVol, totalExitVol), 2),
      weightedEntryPrice: roundTo(effectiveEntry, firstEntry.symbol.includes('JPY') ? 3 : 5),
      weightedExitPrice: roundTo(weightedExitPrice, firstEntry.symbol.includes('JPY') ? 3 : 5),
      openTimeUtc: firstEntry.utcTime,
      closeTimeUtc: lastExit.utcTime,
      openServerTimeRaw: firstEntry.serverTimeRaw,
      openServerTzLabel: firstEntry.serverTzLabel,
      closeServerTimeRaw: lastExit.serverTimeRaw,
      closeServerTzLabel: lastExit.serverTzLabel,
      durationMinutes,
      grossProfit,
      commission,
      swap,
      netProfit,
      sl: effectiveSl,
      tp: tpFromDeals,
      isPartial: entryDeals.length > 1 || exitDeals.length > 1,
      entryFillsCount: entryDeals.length,
      exitFillsCount: exitDeals.length,
      deals: sorted,
      session,
      journal,
      initialRiskCurrency,
      riskSource,
      rMultiple,
      outcome,
    });
  }

  closedTrades.sort(
    (a, b) => new Date(b.closeTimeUtc).getTime() - new Date(a.closeTimeUtc).getTime(),
  );

  return { closedTrades, unsupportedDealNotices };
}

// ---------------------------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------------------------

/** RFC-4180 style record splitter: handles quoted fields, escaped quotes and embedded delimiters/newlines. */
export function parseCsvRecords(text: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  const src = text.replace(/^﻿/, '');

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((c) => c.trim().length > 0)) records.push(row.map((c) => c.trim()));
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((c) => c.trim().length > 0)) records.push(row.map((c) => c.trim()));
  return records;
}

function detectDelimiter(headerLine: string): string {
  const counts: Record<string, number> = { '\t': 0, ';': 0, ',': 0 };
  let inQuotes = false;
  for (const ch of headerLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch]++;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

/** Parses a decimal that may contain spaces / non-breaking spaces as thousands separators. Returns NaN if invalid. */
function parseDecimal(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const cleaned = raw.replace(/[\s ]/g, '');
  if (cleaned === '' || cleaned === '-') return 0;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Parses an MT5 Deal History CSV / TSV file into normalized MT5Deal and BalanceOperation records.
 * Supports official MT5 field names (DEAL_TICKET, DEAL_POSITION_ID, etc.) and MT5 Terminal export headers.
 *
 * Data-integrity rules: rows with a missing/invalid ticket, unparseable time, unknown deal type or
 * non-numeric money fields are SKIPPED WITH A WARNING — values are never invented.
 * `serverTimeZone` (IANA or the MT5/EET-US-DST pseudo-zone) enables daylight-saving-correct conversion;
 * when omitted the fixed offset in `serverTzLabel` is used.
 */
export function parseMT5CsvDeals(
  csvText: string,
  accountId: string,
  serverTzLabel = 'GMT+2',
  serverTimeZone?: string | null,
): { deals: MT5Deal[]; balanceOps: BalanceOperation[]; warnings: string[] } {
  const firstLine = csvText.replace(/^﻿/, '').split(/\r?\n/, 1)[0] ?? '';
  const delimiter = detectDelimiter(firstLine);
  const records = parseCsvRecords(csvText, delimiter);
  if (records.length < 2) {
    return { deals: [], balanceOps: [], warnings: ['CSV file contains no data rows.'] };
  }

  const headers = records[0].map((h) => h.toUpperCase());
  const colIndex = (candidates: string[]) => {
    for (const c of candidates) {
      const idx = headers.indexOf(c);
      if (idx !== -1) return idx;
    }
    return -1;
  };

  const iTicket = colIndex(['DEAL_TICKET', 'DEAL', 'TICKET']);
  const iOrder = colIndex(['DEAL_ORDER', 'ORDER']);
  const iPos = colIndex(['DEAL_POSITION_ID', 'POSITION', 'POSITION_ID', 'POSITION ID']);
  const iTime = colIndex(['DEAL_TIME', 'TIME', 'DATE']);
  const iSymbol = colIndex(['DEAL_SYMBOL', 'SYMBOL']);
  const iType = colIndex(['DEAL_TYPE', 'TYPE']);
  const iEntry = colIndex(['DEAL_ENTRY', 'DIRECTION', 'ENTRY']);
  const iVol = colIndex(['DEAL_VOLUME', 'VOLUME', 'LOTS']);
  const iPrice = colIndex(['DEAL_PRICE', 'PRICE']);
  const iProfit = colIndex(['DEAL_PROFIT', 'PROFIT']);
  const iComm = colIndex(['DEAL_COMMISSION', 'COMMISSION']);
  const iFee = colIndex(['DEAL_FEE', 'FEE']);
  const iSwap = colIndex(['DEAL_SWAP', 'SWAP']);
  const iSl = colIndex(['SL', 'STOP LOSS', 'S/L']);
  const iTp = colIndex(['TP', 'TAKE PROFIT', 'T/P']);
  const iComment = colIndex(['DEAL_COMMENT', 'COMMENT']);

  const deals: MT5Deal[] = [];
  const balanceOps: BalanceOperation[] = [];
  const warnings: string[] = [];

  const missing: string[] = [];
  if (iTicket === -1) missing.push('ticket');
  if (iTime === -1) missing.push('time');
  if (iType === -1) missing.push('type');
  if (missing.length > 0) {
    return {
      deals: [],
      balanceOps: [],
      warnings: [`CSV header is missing required column(s): ${missing.join(', ')}. Nothing was imported.`],
    };
  }
  if (iPos === -1) {
    warnings.push(
      'No position-id column found: each deal would be treated as its own position, so trades cannot be paired. Export with DEAL_POSITION_ID (use the LedgerFX collector).',
    );
  }

  const cell = (cols: string[], idx: number): string | undefined => (idx === -1 ? undefined : cols[idx]);

  for (let r = 1; r < records.length; r++) {
    const cols = records[r];
    const rowNo = r + 1;

    const ticket = Number(cell(cols, iTicket));
    if (!Number.isInteger(ticket) || ticket <= 0) {
      warnings.push(`Row ${rowNo} skipped: missing or invalid deal ticket.`);
      continue;
    }

    const rawTime = cell(cols, iTime) ?? '';
    const normalizedIso = serverWallClockToUtcIso(rawTime, serverTimeZone, serverTzLabel);
    if (!normalizedIso) {
      warnings.push(`Row ${rowNo} (ticket ${ticket}) skipped: unrecognised time "${rawTime}".`);
      continue;
    }

    const rawType = (cell(cols, iType) ?? '').toUpperCase();
    const rawEntry = (cell(cols, iEntry) ?? '').toUpperCase();

    if (rawType.includes('CANCEL')) {
      warnings.push(`Row ${rowNo} (ticket ${ticket}) skipped: cancelled deal (${rawType}).`);
      continue;
    }

    let dealType: MT5DealType | null = null;
    if (rawType.includes('BALANCE') || rawType.includes('INTEREST')) dealType = 'DEAL_TYPE_BALANCE';
    else if (rawType.includes('CREDIT') || rawType.includes('BONUS')) dealType = 'DEAL_TYPE_CREDIT';
    else if (rawType.includes('CHARGE') || rawType.includes('WITHDRAW') || rawType.includes('COMMISSION'))
      dealType = 'DEAL_TYPE_CHARGE';
    else if (rawType.includes('CORRECTION')) dealType = 'DEAL_TYPE_CORRECTION';
    else if (rawType.includes('DIVIDEND')) dealType = 'DEAL_TYPE_DIVIDEND';
    else if (rawType.includes('TAX')) dealType = 'DEAL_TYPE_TAX';
    else if (rawType.includes('SELL') || rawType === '1') dealType = 'DEAL_TYPE_SELL';
    else if (rawType.includes('BUY') || rawType === '0') dealType = 'DEAL_TYPE_BUY';

    if (dealType === null) {
      warnings.push(`Row ${rowNo} (ticket ${ticket}) skipped: unknown deal type "${rawType}".`);
      continue;
    }

    const profit = parseDecimal(cell(cols, iProfit));
    const commissionRaw = parseDecimal(cell(cols, iComm));
    const fee = parseDecimal(cell(cols, iFee));
    const swap = parseDecimal(cell(cols, iSwap));
    const volume = parseDecimal(cell(cols, iVol));
    const price = parseDecimal(cell(cols, iPrice));
    if ([profit, commissionRaw, fee, swap, volume, price].some((n) => Number.isNaN(n))) {
      warnings.push(`Row ${rowNo} (ticket ${ticket}) skipped: a numeric field could not be read.`);
      continue;
    }
    const commission = commissionRaw + fee;

    if (BALANCE_DEAL_TYPES.has(dealType)) {
      balanceOps.push({
        ticket,
        accountId,
        dealType: dealType as BalanceOperation['dealType'],
        amount: profit,
        utcTime: normalizedIso,
        serverTimeRaw: rawTime,
        serverTzLabel,
        comment: cell(cols, iComment) || 'Imported balance operation',
      });
      continue;
    }

    let dealEntry: MT5DealEntry = 'DEAL_ENTRY_IN';
    if (rawEntry.includes('IN/OUT') || rawEntry.includes('INOUT')) dealEntry = 'DEAL_ENTRY_INOUT';
    else if (rawEntry.includes('OUT_BY') || rawEntry.includes('OUT BY')) dealEntry = 'DEAL_ENTRY_OUT_BY';
    else if (rawEntry.includes('OUT') || rawEntry === '1') dealEntry = 'DEAL_ENTRY_OUT';
    else if (rawEntry === '2') dealEntry = 'DEAL_ENTRY_INOUT';
    else if (rawEntry === '3') dealEntry = 'DEAL_ENTRY_OUT_BY';
    else dealEntry = 'DEAL_ENTRY_IN';

    const rawPos = Number(cell(cols, iPos));
    const positionId = Number.isInteger(rawPos) && rawPos > 0 ? rawPos : ticket;
    const rawOrder = Number(cell(cols, iOrder));
    const orderId = Number.isInteger(rawOrder) && rawOrder > 0 ? rawOrder : ticket;
    const slRaw = cell(cols, iSl);
    const tpRaw = cell(cols, iTp);
    const slNum = slRaw ? parseDecimal(slRaw) : 0;
    const tpNum = tpRaw ? parseDecimal(tpRaw) : 0;
    const sl = Number.isFinite(slNum) && slNum > 0 ? slNum : null;
    const tp = Number.isFinite(tpNum) && tpNum > 0 ? tpNum : null;
    const symbol = (cell(cols, iSymbol) ?? '').toUpperCase();

    if (!symbol) {
      warnings.push(`Row ${rowNo} (ticket ${ticket}) skipped: missing symbol.`);
      continue;
    }

    deals.push({
      ticket,
      accountId,
      orderId,
      positionId,
      symbol,
      dealType,
      dealEntry,
      volume,
      price,
      profit,
      commission,
      swap,
      sl,
      tp,
      utcTime: normalizedIso,
      serverTimeRaw: rawTime,
      serverTzLabel,
      magicNumber: 0,
      comment: cell(cols, iComment) ?? '',
    });
  }

  return { deals, balanceOps, warnings };
}
