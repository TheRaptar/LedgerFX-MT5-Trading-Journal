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
import { classifyTradingSession } from './timeUtils.ts';

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

    // Estimate initial currency risk if user hasn't entered explicit risk but SL exists
    let initialRiskCurrency = journal?.initialRiskCurrency ?? null;
    if (initialRiskCurrency === null && effectiveSl !== null && effectiveEntry > 0) {
      const pipFactor = firstEntry.symbol.includes('JPY')
        ? 100
        : firstEntry.symbol.includes('XAU')
          ? 10
          : 10000;
      const slPips = Math.abs(effectiveEntry - effectiveSl) * pipFactor;
      const approxPipValuePerLot = firstEntry.symbol.includes('XAU') ? 10 : 8.2;
      const estimated = roundTo(slPips * totalEntryVol * approxPipValuePerLot, 2);
      if (estimated > 0) {
        initialRiskCurrency = estimated;
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
      rMultiple,
      outcome,
    });
  }

  closedTrades.sort(
    (a, b) => new Date(b.closeTimeUtc).getTime() - new Date(a.closeTimeUtc).getTime(),
  );

  return { closedTrades, unsupportedDealNotices };
}

/**
 * Parses an MT5 Deal History CSV / TSV file into normalized MT5Deal and BalanceOperation records.
 * Supports official MT5 field names (DEAL_TICKET, DEAL_POSITION_ID, etc.) and MT5 Terminal export headers.
 */
export function parseMT5CsvDeals(
  csvText: string,
  accountId: string,
  serverTzLabel = 'GMT+2',
): { deals: MT5Deal[]; balanceOps: BalanceOperation[]; warnings: string[] } {
  const lines = csvText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) {
    return { deals: [], balanceOps: [], warnings: ['CSV file contains no data rows.'] };
  }

  const delimiter = lines[0].includes('\t') ? '\t' : lines[0].includes(';') ? ';' : ',';
  const headers = lines[0].split(delimiter).map((h) => h.replace(/^"|"$/g, '').trim().toUpperCase());

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
  const iSwap = colIndex(['DEAL_SWAP', 'SWAP']);
  const iSl = colIndex(['SL', 'STOP LOSS', 'S/L']);
  const iTp = colIndex(['TP', 'TAKE PROFIT', 'T/P']);
  const iComment = colIndex(['DEAL_COMMENT', 'COMMENT']);

  const deals: MT5Deal[] = [];
  const balanceOps: BalanceOperation[] = [];
  const warnings: string[] = [];

  for (let r = 1; r < lines.length; r++) {
    const rawCols = lines[r].split(delimiter).map((c) => c.replace(/^"|"$/g, '').trim());
    const ticket = Number(rawCols[iTicket] ?? r + 900000);
    if (!Number.isFinite(ticket) || ticket <= 0) continue;

    const rawType = (rawCols[iType] ?? '').toUpperCase();
    const rawEntry = (rawCols[iEntry] ?? '').toUpperCase();
    const rawTime = rawCols[iTime] ?? new Date().toISOString();
    const normalizedIso = normalizeMT5TimeToUtc(rawTime, serverTzLabel);

    let dealType: MT5DealType = 'DEAL_TYPE_BUY';
    if (rawType.includes('BALANCE')) dealType = 'DEAL_TYPE_BALANCE';
    else if (rawType.includes('CREDIT')) dealType = 'DEAL_TYPE_CREDIT';
    else if (rawType.includes('CHARGE') || rawType.includes('WITHDRAW')) dealType = 'DEAL_TYPE_CHARGE';
    else if (rawType.includes('CORRECTION')) dealType = 'DEAL_TYPE_CORRECTION';
    else if (rawType.includes('DIVIDEND')) dealType = 'DEAL_TYPE_DIVIDEND';
    else if (rawType.includes('TAX')) dealType = 'DEAL_TYPE_TAX';
    else if (rawType.includes('SELL') || rawType === '1') dealType = 'DEAL_TYPE_SELL';
    else if (rawType.includes('BUY') || rawType === '0') dealType = 'DEAL_TYPE_BUY';

    const profit = Number((rawCols[iProfit] ?? '0').replace(/\s/g, '')) || 0;

    if (BALANCE_DEAL_TYPES.has(dealType)) {
      balanceOps.push({
        ticket,
        accountId,
        dealType: dealType as BalanceOperation['dealType'],
        amount: profit,
        utcTime: normalizedIso,
        serverTimeRaw: rawTime,
        serverTzLabel,
        comment: rawCols[iComment] ?? 'Imported balance operation',
      });
      continue;
    }

    let dealEntry: MT5DealEntry = 'DEAL_ENTRY_IN';
    if (rawEntry.includes('IN/OUT') || rawEntry.includes('INOUT')) dealEntry = 'DEAL_ENTRY_INOUT';
    else if (rawEntry.includes('OUT_BY')) dealEntry = 'DEAL_ENTRY_OUT_BY';
    else if (rawEntry.includes('OUT') || rawEntry === '1') dealEntry = 'DEAL_ENTRY_OUT';
    else dealEntry = 'DEAL_ENTRY_IN';

    const positionId = Number(rawCols[iPos] ?? ticket) || ticket;
    const orderId = Number(rawCols[iOrder] ?? ticket) || ticket;
    const volume = Number(rawCols[iVol] ?? '0') || 0;
    const price = Number(rawCols[iPrice] ?? '0') || 0;
    const commission = Number(rawCols[iComm] ?? '0') || 0;
    const swap = Number(rawCols[iSwap] ?? '0') || 0;
    const sl = iSl !== -1 && rawCols[iSl] ? Number(rawCols[iSl]) || null : null;
    const tp = iTp !== -1 && rawCols[iTp] ? Number(rawCols[iTp]) || null : null;
    const symbol = (rawCols[iSymbol] ?? '').toUpperCase();

    if (!symbol && TRADE_DEAL_TYPES.has(dealType)) {
      warnings.push(`Row ${r + 1} (ticket ${ticket}) skipped: missing symbol.`);
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
      comment: rawCols[iComment] ?? '',
    });
  }

  return { deals, balanceOps, warnings };
}

function normalizeMT5TimeToUtc(rawTime: string, serverTzLabel: string): string {
  // Handle MT5 format "2026.10.25 14:30:00" or ISO string
  if (rawTime.includes('T') && rawTime.endsWith('Z')) return rawTime;
  const cleaned = rawTime.replace(/\./g, '-').replace(' ', 'T');
  const match = serverTzLabel.match(/GMT([+-]\d+)/i);
  const offsetHours = match ? parseInt(match[1], 10) : 2;
  const sign = offsetHours >= 0 ? '+' : '-';
  const absH = String(Math.abs(offsetHours)).padStart(2, '0');
  const candidate = cleaned.length === 16 ? `${cleaned}:00${sign}${absH}:00` : `${cleaned}${sign}${absH}:00`;
  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}
