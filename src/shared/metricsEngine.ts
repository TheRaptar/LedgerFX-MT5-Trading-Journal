import type {
  BalanceOperation,
  ClosedTrade,
  MT5Account,
  MT5OpenPosition,
  UserSettings,
} from './types.ts';
import { formatCurrency, getIsoDayInZone } from './timeUtils.ts';
import { roundTo } from './mt5Engine.ts';

export interface MetricWithExplanation {
  value: number;
  formatted: string;
  label: string;
  definition: string;
  formulaLabel: string;
  exactCalculation: string;
}

export interface EquityPoint {
  utcTime: string;
  dateLabel: string;
  balance: number;
  equity: number;
  drawdownCurrency: number;
  drawdownPct: number;
  eventType: 'start' | 'trade' | 'deposit' | 'withdrawal' | 'open_mark';
  eventLabel: string;
  delta: number;
  positionId?: number;
}

export interface MonthlyPerformanceRow {
  monthKey: string; // YYYY-MM
  monthLabel: string;
  tradesCount: number;
  wins: number;
  losses: number;
  winRatePct: number;
  netProfit: number;
  grossProfit: number;
  commissions: number;
  swaps: number;
  avgTrade: number;
  profitFactor: number | null;
}

export interface SymbolPerformanceRow {
  symbol: string;
  tradesCount: number;
  wins: number;
  losses: number;
  winRatePct: number;
  netProfit: number;
  grossProfit: number;
  costs: number;
  avgR: number | null;
  totalVolume: number;
}

export interface StrategyPerformanceRow {
  strategy: string;
  tradesCount: number;
  winRatePct: number;
  netProfit: number;
  avgR: number | null;
  profitFactor: number | null;
}

export interface SessionPerformanceRow {
  session: string;
  tradesCount: number;
  winRatePct: number;
  netProfit: number;
}

export interface ComputedMetrics {
  totalTrades: number;
  wins: number;
  losses: number;
  breakevens: number;
  totalNetProfit: MetricWithExplanation;
  winRate: MetricWithExplanation;
  profitFactor: MetricWithExplanation;
  expectancy: MetricWithExplanation;
  maxDrawdown: MetricWithExplanation;
  averageR: MetricWithExplanation;
  totalR: MetricWithExplanation;
  avgWin: number;
  avgLoss: number;
  largestWin: number;
  largestLoss: number;
  largestWinR: number | null;
  largestLossR: number | null;
  avgDurationMinutes: number;
  grossWinsSum: number;
  grossLossesSum: number;
  totalCommissions: number;
  totalSwaps: number;
  totalCosts: number;
  unrealisedOpenPL: number;
  maxDrawdownPeriod: { peakDate: string; troughDate: string; dropCurrency: number; dropPct: number } | null;
  equityCurve: EquityPoint[];
  monthlyPerformance: MonthlyPerformanceRow[];
  symbolBreakdown: SymbolPerformanceRow[];
  strategyBreakdown: StrategyPerformanceRow[];
  sessionBreakdown: SessionPerformanceRow[];
  pnlHistogram: { bucket: string; count: number; isPositive: boolean }[];
}

export function computePerformanceMetrics(
  trades: ClosedTrade[],
  balanceOps: BalanceOperation[],
  openPositions: MT5OpenPosition[],
  accounts: MT5Account[],
  settings: UserSettings,
): ComputedMetrics {
  const winsList = trades.filter((t) => t.outcome === 'win');
  const lossesList = trades.filter((t) => t.outcome === 'loss');
  const beList = trades.filter((t) => t.outcome === 'breakeven');

  const wins = winsList.length;
  const losses = lossesList.length;
  const breakevens = beList.length;
  const totalTrades = trades.length;

  const winDenominator =
    settings.breakEvenHandling === 'exclude' ? wins + losses : totalTrades;
  const winRateRatio = winDenominator > 0 ? wins / winDenominator : 0;
  const lossRateRatio = winDenominator > 0 ? losses / winDenominator : 0;
  const winRatePct = roundTo(winRateRatio * 100, 1);

  const netWinsSum = roundTo(winsList.reduce((s, t) => s + t.netProfit, 0), 2);
  const netLossesAbs = roundTo(
    Math.abs(lossesList.reduce((s, t) => s + t.netProfit, 0)),
    2,
  );
  const totalNet = roundTo(trades.reduce((s, t) => s + t.netProfit, 0), 2);
  const totalCommissions = roundTo(trades.reduce((s, t) => s + t.commission, 0), 2);
  const totalSwaps = roundTo(trades.reduce((s, t) => s + t.swap, 0), 2);
  const totalCosts = roundTo(totalCommissions + totalSwaps, 2);

  const avgWin = wins > 0 ? roundTo(netWinsSum / wins, 2) : 0;
  const avgLoss = losses > 0 ? roundTo(netLossesAbs / losses, 2) : 0;
  const largestWin = winsList.length > 0 ? Math.max(...winsList.map((t) => t.netProfit)) : 0;
  const largestLoss = lossesList.length > 0 ? Math.min(...lossesList.map((t) => t.netProfit)) : 0;

  const pfValue = netLossesAbs > 0 ? roundTo(netWinsSum / netLossesAbs, 2) : netWinsSum > 0 ? Infinity : 0;
  const pfFormatted = pfValue === Infinity ? '∞' : pfValue.toFixed(2);

  const expectancyValue = roundTo(winRateRatio * avgWin - lossRateRatio * avgLoss, 2);

  const rTrades = trades.filter((t) => t.rMultiple !== null);
  const sumR = roundTo(rTrades.reduce((s, t) => s + (t.rMultiple ?? 0), 0), 2);
  const avgR = rTrades.length > 0 ? roundTo(sumR / rTrades.length, 2) : 0;
  const largestWinR =
    rTrades.length > 0 ? Math.max(...rTrades.map((t) => t.rMultiple ?? 0)) : null;
  const largestLossR =
    rTrades.length > 0 ? Math.min(...rTrades.map((t) => t.rMultiple ?? 0)) : null;

  const avgDurationMinutes =
    totalTrades > 0
      ? Math.round(trades.reduce((s, t) => s + t.durationMinutes, 0) / totalTrades)
      : 0;

  const unrealisedOpenPL = roundTo(
    openPositions.reduce((s, p) => s + p.unrealisedProfit + p.swap + p.commission, 0),
    2,
  );

  // Build chronological equity curve with trades + deposits/withdrawals + optional open P/L mark
  const timelineEvents: Array<{
    utcTime: string;
    eventType: 'trade' | 'deposit' | 'withdrawal';
    delta: number;
    label: string;
    positionId?: number;
  }> = [];

  for (const op of balanceOps) {
    timelineEvents.push({
      utcTime: op.utcTime,
      eventType: op.amount >= 0 ? 'deposit' : 'withdrawal',
      delta: op.amount,
      label: `${op.amount >= 0 ? 'Deposit' : 'Withdrawal'}: ${formatCurrency(op.amount, settings, { signed: true })} (${op.comment || op.dealType})`,
    });
  }

  for (const t of trades) {
    timelineEvents.push({
      utcTime: t.closeTimeUtc,
      eventType: 'trade',
      delta: t.netProfit,
      label: `#${t.positionId} ${t.symbol} ${t.direction} (${formatCurrency(t.netProfit, settings, { signed: true })})`,
      positionId: t.positionId,
    });
  }

  timelineEvents.sort(
    (a, b) => new Date(a.utcTime).getTime() - new Date(b.utcTime).getTime(),
  );

  const baseInitialBalance =
    balanceOps.length > 0
      ? 0
      : accounts.reduce((sum, a) => sum + a.initialBalance, 0);

  let runningBalance = baseInitialBalance;
  let runningPeak = runningBalance;
  let peakDateLabel = timelineEvents[0]
    ? getIsoDayInZone(timelineEvents[0].utcTime, settings.displayTimeZone)
    : 'Start';

  let maxDdCurrency = 0;
  let maxDdPct = 0;
  let maxDdPeriod: ComputedMetrics['maxDrawdownPeriod'] = null;

  const equityCurve: EquityPoint[] = [];

  if (baseInitialBalance > 0 && timelineEvents.length > 0) {
    const startDate = getIsoDayInZone(timelineEvents[0].utcTime, settings.displayTimeZone);
    equityCurve.push({
      utcTime: timelineEvents[0].utcTime,
      dateLabel: startDate,
      balance: roundTo(runningBalance, 2),
      equity: roundTo(runningBalance, 2),
      drawdownCurrency: 0,
      drawdownPct: 0,
      eventType: 'start',
      eventLabel: `Starting Balance: ${formatCurrency(runningBalance, settings)}`,
      delta: 0,
    });
  }

  for (const ev of timelineEvents) {
    runningBalance = roundTo(runningBalance + ev.delta, 2);
    const dayLabel = getIsoDayInZone(ev.utcTime, settings.displayTimeZone);

    // Adjust peak on deposits/withdrawals so capital injections/withdrawals don't create artificial drawdown
    if (ev.eventType === 'deposit' || ev.eventType === 'withdrawal') {
      runningPeak = Math.max(0, roundTo(runningPeak + ev.delta, 2));
      if (runningBalance > runningPeak) {
        runningPeak = runningBalance;
        peakDateLabel = dayLabel;
      }
    } else if (runningBalance >= runningPeak) {
      runningPeak = runningBalance;
      peakDateLabel = dayLabel;
    }

    const ddCurr = runningPeak > runningBalance ? roundTo(runningPeak - runningBalance, 2) : 0;
    const ddPct = runningPeak > 0 ? roundTo((ddCurr / runningPeak) * 100, 2) : 0;

    if (ddCurr > maxDdCurrency) {
      maxDdCurrency = ddCurr;
      maxDdPct = ddPct;
      maxDdPeriod = {
        peakDate: peakDateLabel,
        troughDate: dayLabel,
        dropCurrency: ddCurr,
        dropPct: ddPct,
      };
    }

    equityCurve.push({
      utcTime: ev.utcTime,
      dateLabel: dayLabel,
      balance: runningBalance,
      equity: runningBalance,
      drawdownCurrency: -ddCurr,
      drawdownPct: -ddPct,
      eventType: ev.eventType,
      eventLabel: ev.label,
      delta: ev.delta,
      positionId: ev.positionId,
    });
  }

  // Append open unrealised P/L mark if open positions exist
  if (openPositions.length > 0 && equityCurve.length > 0) {
    const nowIso = new Date().toISOString();
    const todayLabel = getIsoDayInZone(nowIso, settings.displayTimeZone);
    const markEquity = roundTo(runningBalance + unrealisedOpenPL, 2);
    let ddCurr = 0;
    let ddPct = 0;
    if (settings.includeUnrealisedInDrawdown) {
      const effectivePeak = Math.max(runningPeak, markEquity);
      ddCurr = effectivePeak > markEquity ? roundTo(effectivePeak - markEquity, 2) : 0;
      ddPct = effectivePeak > 0 ? roundTo((ddCurr / effectivePeak) * 100, 2) : 0;
      if (ddCurr > maxDdCurrency) {
        maxDdCurrency = ddCurr;
        maxDdPct = ddPct;
        maxDdPeriod = {
          peakDate: peakDateLabel,
          troughDate: `${todayLabel} (Open)`,
          dropCurrency: ddCurr,
          dropPct: ddPct,
        };
      }
    }
    equityCurve.push({
      utcTime: nowIso,
      dateLabel: `${todayLabel} (Live)`,
      balance: runningBalance,
      equity: markEquity,
      drawdownCurrency: -ddCurr,
      drawdownPct: -ddPct,
      eventType: 'open_mark',
      eventLabel: `Open Positions Mark (${openPositions.length} open): ${formatCurrency(unrealisedOpenPL, settings, { signed: true })}`,
      delta: unrealisedOpenPL,
    });
  }

  // Monthly performance aggregation
  const monthMap = new Map<string, ClosedTrade[]>();
  for (const t of trades) {
    const day = getIsoDayInZone(t.closeTimeUtc, settings.displayTimeZone);
    const monthKey = day.slice(0, 7);
    const arr = monthMap.get(monthKey) ?? [];
    arr.push(t);
    monthMap.set(monthKey, arr);
  }

  const monthlyPerformance: MonthlyPerformanceRow[] = Array.from(monthMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([monthKey, list]) => {
      const mWins = list.filter((t) => t.outcome === 'win');
      const mLosses = list.filter((t) => t.outcome === 'loss');
      const mWinSum = mWins.reduce((s, t) => s + t.netProfit, 0);
      const mLossAbs = Math.abs(mLosses.reduce((s, t) => s + t.netProfit, 0));
      const mNet = roundTo(list.reduce((s, t) => s + t.netProfit, 0), 2);
      const [yr, mo] = monthKey.split('-');
      const monthDate = new Date(Date.UTC(Number(yr), Number(mo) - 1, 1));
      const monthLabel = monthDate.toLocaleDateString('en-GB', {
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      });
      return {
        monthKey,
        monthLabel,
        tradesCount: list.length,
        wins: mWins.length,
        losses: mLosses.length,
        winRatePct: list.length > 0 ? roundTo((mWins.length / list.length) * 100, 1) : 0,
        netProfit: mNet,
        grossProfit: roundTo(list.reduce((s, t) => s + t.grossProfit, 0), 2),
        commissions: roundTo(list.reduce((s, t) => s + t.commission, 0), 2),
        swaps: roundTo(list.reduce((s, t) => s + t.swap, 0), 2),
        avgTrade: list.length > 0 ? roundTo(mNet / list.length, 2) : 0,
        profitFactor: mLossAbs > 0 ? roundTo(mWinSum / mLossAbs, 2) : null,
      };
    });

  // Symbol breakdown
  const symMap = new Map<string, ClosedTrade[]>();
  for (const t of trades) {
    const arr = symMap.get(t.symbol) ?? [];
    arr.push(t);
    symMap.set(t.symbol, arr);
  }
  const symbolBreakdown: SymbolPerformanceRow[] = Array.from(symMap.entries())
    .map(([symbol, list]) => {
      const sWins = list.filter((t) => t.outcome === 'win').length;
      const sLosses = list.filter((t) => t.outcome === 'loss').length;
      const sRs = list.filter((t) => t.rMultiple !== null);
      return {
        symbol,
        tradesCount: list.length,
        wins: sWins,
        losses: sLosses,
        winRatePct: list.length > 0 ? roundTo((sWins / list.length) * 100, 1) : 0,
        netProfit: roundTo(list.reduce((s, t) => s + t.netProfit, 0), 2),
        grossProfit: roundTo(list.reduce((s, t) => s + t.grossProfit, 0), 2),
        costs: roundTo(list.reduce((s, t) => s + t.commission + t.swap, 0), 2),
        avgR:
          sRs.length > 0
            ? roundTo(sRs.reduce((s, t) => s + (t.rMultiple ?? 0), 0) / sRs.length, 2)
            : null,
        totalVolume: roundTo(list.reduce((s, t) => s + t.totalVolume, 0), 2),
      };
    })
    .sort((a, b) => b.netProfit - a.netProfit);

  // Strategy breakdown
  const stratMap = new Map<string, ClosedTrade[]>();
  for (const t of trades) {
    const label = t.journal?.strategy?.trim() || 'Untagged';
    const arr = stratMap.get(label) ?? [];
    arr.push(t);
    stratMap.set(label, arr);
  }
  const strategyBreakdown: StrategyPerformanceRow[] = Array.from(stratMap.entries())
    .map(([strategy, list]) => {
      const sWins = list.filter((t) => t.outcome === 'win');
      const sLosses = list.filter((t) => t.outcome === 'loss');
      const wSum = sWins.reduce((s, t) => s + t.netProfit, 0);
      const lAbs = Math.abs(sLosses.reduce((s, t) => s + t.netProfit, 0));
      const sRs = list.filter((t) => t.rMultiple !== null);
      return {
        strategy,
        tradesCount: list.length,
        winRatePct: list.length > 0 ? roundTo((sWins.length / list.length) * 100, 1) : 0,
        netProfit: roundTo(list.reduce((s, t) => s + t.netProfit, 0), 2),
        avgR:
          sRs.length > 0
            ? roundTo(sRs.reduce((s, t) => s + (t.rMultiple ?? 0), 0) / sRs.length, 2)
            : null,
        profitFactor: lAbs > 0 ? roundTo(wSum / lAbs, 2) : null,
      };
    })
    .sort((a, b) => b.netProfit - a.netProfit);

  // Session breakdown
  const sessMap = new Map<string, ClosedTrade[]>();
  for (const t of trades) {
    const arr = sessMap.get(t.session) ?? [];
    arr.push(t);
    sessMap.set(t.session, arr);
  }
  const sessionBreakdown: SessionPerformanceRow[] = Array.from(sessMap.entries()).map(
    ([session, list]) => {
      const sWins = list.filter((t) => t.outcome === 'win').length;
      return {
        session,
        tradesCount: list.length,
        winRatePct: list.length > 0 ? roundTo((sWins / list.length) * 100, 1) : 0,
        netProfit: roundTo(list.reduce((s, t) => s + t.netProfit, 0), 2),
      };
    },
  );

  // Trade outcome histogram (6 buckets)
  const buckets = [
    { label: '< -300', min: -Infinity, max: -300, isPositive: false },
    { label: '-300 to -100', min: -300, max: -100, isPositive: false },
    { label: '-100 to 0', min: -100, max: 0, isPositive: false },
    { label: '0 to +150', min: 0, max: 150, isPositive: true },
    { label: '+150 to +350', min: 150, max: 350, isPositive: true },
    { label: '> +350', min: 350, max: Infinity, isPositive: true },
  ];
  const pnlHistogram = buckets.map((b) => ({
    bucket: b.label,
    count: trades.filter((t) => t.netProfit >= b.min && t.netProfit < b.max).length,
    isPositive: b.isPositive,
  }));

  return {
    totalTrades,
    wins,
    losses,
    breakevens,
    totalNetProfit: {
      value: totalNet,
      formatted: formatCurrency(totalNet, settings, { signed: true }),
      label: 'Net Realised P/L',
      definition: 'Sum of all closed position deal profits plus swaps and commissions (post-cost).',
      formulaLabel: 'Gross P/L + Swaps + Commissions',
      exactCalculation: `${formatCurrency(roundTo(totalNet - totalCosts, 2), settings, { signed: true })} + (${formatCurrency(totalSwaps, settings, { signed: true })} swap) + (${formatCurrency(totalCommissions, settings, { signed: true })} comm) = ${formatCurrency(totalNet, settings, { signed: true })}`,
    },
    winRate: {
      value: winRatePct,
      formatted: `${winRatePct.toFixed(1)}%`,
      label: 'Win Rate',
      definition:
        settings.breakEvenHandling === 'exclude'
          ? 'Winning trades divided by decisive trades (excluding break-even positions).'
          : 'Winning trades divided by all completed trades.',
      formulaLabel: '(Winning Trades / Completed Trades) × 100',
      exactCalculation: `(${wins} / ${winDenominator}) × 100 = ${winRatePct.toFixed(1)}%`,
    },
    profitFactor: {
      value: pfValue,
      formatted: pfFormatted,
      label: 'Profit Factor (Post-Cost)',
      definition:
        'Sum of net profits on winning trades divided by the absolute sum of net losses on losing trades.',
      formulaLabel: 'Total Net Wins / |Total Net Losses|',
      exactCalculation:
        netLossesAbs > 0
          ? `(${formatCurrency(netWinsSum, settings)}) / (${formatCurrency(netLossesAbs, settings)}) = ${pfFormatted}`
          : `${formatCurrency(netWinsSum, settings)} / ${formatCurrency(0, settings)} = ${pfFormatted} (no losing trades)`,
    },
    expectancy: {
      value: expectancyValue,
      formatted: formatCurrency(expectancyValue, settings, { signed: true }),
      label: 'Expectancy per Trade',
      definition: 'Expected average net return per trade based on win rate and average payoff.',
      formulaLabel: '(WinRate × AvgWin) − (LossRate × AvgLoss)',
      exactCalculation: `(${(winRateRatio * 100).toFixed(1)}% × ${formatCurrency(avgWin, settings)}) − (${(lossRateRatio * 100).toFixed(1)}% × ${formatCurrency(avgLoss, settings)}) = ${formatCurrency(expectancyValue, settings, { signed: true })}`,
    },
    maxDrawdown: {
      value: maxDdCurrency,
      formatted: `${formatCurrency(-maxDdCurrency, settings)} (-${maxDdPct.toFixed(2)}%)`,
      label: 'Max Drawdown',
      definition:
        'Largest peak-to-trough decline in account equity, adjusted for deposits/withdrawals' +
        (settings.includeUnrealisedInDrawdown ? ' and including open unrealised P/L.' : '.'),
      formulaLabel: 'Max(Peak Equity − Trough Equity)',
      exactCalculation: maxDdPeriod
        ? `Peak (${maxDdPeriod.peakDate}) → Trough (${maxDdPeriod.troughDate}): ${formatCurrency(-maxDdCurrency, settings)} (-${maxDdPct.toFixed(2)}%)`
        : 'No drawdown recorded in selected range.',
    },
    averageR: {
      value: avgR,
      formatted: `${avgR >= 0 ? '+' : ''}${avgR.toFixed(2)}R`,
      label: 'Average R-Multiple',
      definition:
        'Average net profit divided by initial risk (currency distance to initial stop-loss).',
      formulaLabel: 'Sum(R-Multiple) / Trades with Risk Defined',
      exactCalculation:
        rTrades.length > 0
          ? `(${sumR >= 0 ? '+' : ''}${sumR.toFixed(2)}R) / ${rTrades.length} trades = ${avgR >= 0 ? '+' : ''}${avgR.toFixed(2)}R`
          : 'Add initial risk or stop-loss to trades to calculate R-multiple.',
    },
    totalR: {
      value: sumR,
      formatted: `${sumR >= 0 ? '+' : ''}${sumR.toFixed(2)}R`,
      label: 'Total R Earned',
      definition: 'Cumulative risk-normalised return across all trades with defined initial risk.',
      formulaLabel: 'Σ (Net P/L ÷ Initial Risk)',
      exactCalculation: `Sum across ${rTrades.length} risk-defined trades = ${sumR >= 0 ? '+' : ''}${sumR.toFixed(2)}R`,
    },
    avgWin,
    avgLoss,
    largestWin,
    largestLoss,
    largestWinR,
    largestLossR,
    avgDurationMinutes,
    grossWinsSum: netWinsSum,
    grossLossesSum: netLossesAbs,
    totalCommissions,
    totalSwaps,
    totalCosts,
    unrealisedOpenPL,
    maxDrawdownPeriod: maxDdPeriod,
    equityCurve,
    monthlyPerformance,
    symbolBreakdown,
    strategyBreakdown,
    sessionBreakdown,
    pnlHistogram,
  };
}
