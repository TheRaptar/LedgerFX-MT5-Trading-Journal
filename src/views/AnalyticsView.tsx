import React, { useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type {
  ClosedTrade,
  FilterState,
  MT5Account,
  UserSettings,
} from '../shared/types.ts';
import type { ComputedMetrics } from '../shared/metricsEngine.ts';
import { formatCurrency, formatDuration, getIsoDayInZone } from '../shared/timeUtils.ts';
import { FilterBar } from '../components/FilterBar.tsx';
import { MetricTooltip } from '../components/MetricTooltip.tsx';

interface AnalyticsViewProps {
  closedTrades: ClosedTrade[];
  metrics: ComputedMetrics;
  accounts: MT5Account[];
  symbols: string[];
  strategies: string[];
  filters: FilterState;
  onFiltersChange: (next: FilterState) => void;
  settings: UserSettings;
}

export function AnalyticsView({
  closedTrades,
  metrics,
  accounts,
  symbols,
  strategies,
  filters,
  onFiltersChange,
  settings,
}: AnalyticsViewProps) {
  const isDark = settings.theme === 'dark';
  const gridStroke = isDark ? '#1e293b' : '#e2e8f0';
  const axisTick = isDark ? '#94a3b8' : '#64748b';

  const [compareSymA, setCompareSymA] = useState<string>(symbols[0] ?? 'EURUSD');
  const [compareSymB, setCompareSymB] = useState<string>(symbols[1] ?? 'GBPUSD');

  // Build cumulative P/L comparison series for Symbol A vs Symbol B
  const comparisonSeries = useMemo(() => {
    const relevant = [...closedTrades]
      .filter((t) => t.symbol === compareSymA || t.symbol === compareSymB)
      .sort((a, b) => new Date(a.closeTimeUtc).getTime() - new Date(b.closeTimeUtc).getTime());

    let cumA = 0;
    let cumB = 0;
    return relevant.map((t) => {
      if (t.symbol === compareSymA) cumA = Number((cumA + t.netProfit).toFixed(2));
      if (t.symbol === compareSymB) cumB = Number((cumB + t.netProfit).toFixed(2));
      return {
        date: getIsoDayInZone(t.closeTimeUtc, settings.displayTimeZone),
        [compareSymA]: cumA,
        [compareSymB]: cumB,
      };
    });
  }, [closedTrades, compareSymA, compareSymB, settings.displayTimeZone]);

  // Calculate simple portfolio return % vs user benchmark
  const firstEquity = metrics.equityCurve[0]?.equity ?? 10000;
  const portfolioReturnPct =
    firstEquity > 0 ? Number(((metrics.totalNetProfit.value / firstEquity) * 100).toFixed(2)) : 0;

  return (
    <div className="space-y-6">
      <div className="pb-4 border-b border-slate-200 dark:border-slate-800">
        <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-slate-100">
          Performance Analytics
        </h1>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
          Transparent post-cost calculations, drawdown underwater analysis, cost attribution, and subset comparisons
        </p>
      </div>

      <FilterBar
        filters={filters}
        onChange={onFiltersChange}
        accounts={accounts}
        symbols={symbols}
        strategies={strategies}
        showSearch={false}
      />

      {closedTrades.length === 0 ? (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-10 text-center text-xs text-slate-500 dark:text-slate-400">
          No closed trades match your active analytics filters.
        </div>
      ) : (
        <>
          {/* Transparent Calculations & Trade Quality Summary */}
          <section
            aria-label="Metric definitions and live calculations"
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden"
          >
            <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                Metric Audit & Exact Calculations
              </h2>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                Sample: {metrics.totalTrades} closed positions · Benchmark ({settings.benchmarkName}):{' '}
                <span className="font-mono font-medium text-slate-800 dark:text-slate-200">
                  {portfolioReturnPct >= 0 ? '+' : ''}
                  {portfolioReturnPct}% vs {settings.benchmarkReturnPct}%
                </span>
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-50 dark:bg-slate-950 text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800">
                  <tr>
                    <th className="py-2.5 px-4 font-medium">Metric</th>
                    <th className="py-2.5 px-4 font-medium text-right">Computed Value</th>
                    <th className="py-2.5 px-4 font-medium">Exact Live Calculation</th>
                    <th className="py-2.5 px-4 font-medium text-right">Formula</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-slate-800 dark:text-slate-200">
                  {[
                    metrics.totalNetProfit,
                    metrics.winRate,
                    metrics.profitFactor,
                    metrics.expectancy,
                    metrics.averageR,
                    metrics.totalR,
                    metrics.maxDrawdown,
                  ].map((m) => (
                    <tr key={m.label}>
                      <td className="py-2.5 px-4 font-medium flex items-center gap-1">
                        {m.label}
                        <MetricTooltip metric={m} />
                      </td>
                      <td className="py-2.5 px-4 font-mono tabular-nums text-right font-semibold">
                        {m.formatted}
                      </td>
                      <td className="py-2.5 px-4 font-mono tabular-nums text-[11px] text-slate-600 dark:text-slate-400">
                        {m.exactCalculation}
                      </td>
                      <td className="py-2.5 px-4 text-right text-slate-500 dark:text-slate-400">
                        {m.formulaLabel}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Drawdown Underwater Chart + Cost Attribution */}
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
            <section
              aria-label="Underwater drawdown analysis"
              className="xl:col-span-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
                <div>
                  <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                    Drawdown Underwater Curve
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Peak-to-trough decline (%) adjusted for deposits and withdrawals
                    {metrics.maxDrawdownPeriod
                      ? ` · Worst period: ${metrics.maxDrawdownPeriod.peakDate} to ${metrics.maxDrawdownPeriod.troughDate}`
                      : ''}
                  </p>
                </div>
                <span className="font-mono text-xs font-semibold text-red-700 dark:text-red-400">
                  Max DD: {metrics.maxDrawdown.formatted}
                </span>
              </div>
              <div className="h-64 w-full" role="img" aria-label="Equity drawdown percentage over time">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={metrics.equityCurve} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
                    <XAxis
                      dataKey="dateLabel"
                      tick={{ fontSize: 11, fill: axisTick }}
                      tickLine={false}
                      minTickGap={28}
                    />
                    <YAxis
                      tick={{ fontSize: 11, fill: axisTick }}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v) => `${Number(v).toFixed(1)}%`}
                      width={54}
                    />
                    <ReferenceLine y={0} stroke={gridStroke} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: isDark ? '#0f172a' : '#ffffff',
                        borderColor: isDark ? '#334155' : '#e2e8f0',
                        borderRadius: '8px',
                        fontSize: '12px',
                      }}
                      formatter={(val: unknown) => [`${Number(val).toFixed(2)}%`, 'Drawdown']}
                    />
                    <Area
                      type="monotone"
                      dataKey="drawdownPct"
                      stroke="#dc2626"
                      fill="#dc2626"
                      fillOpacity={0.14}
                      strokeWidth={2}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </section>

            {/* Cost Attribution & Trade Quality Stats */}
            <section
              aria-label="Cost attribution and trade quality statistics"
              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 flex flex-col justify-between space-y-4"
            >
              <div>
                <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                  Cost Attribution & Trade Quality
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  Impact of broker commissions and overnight swaps on realised profit
                </p>
              </div>

              <dl className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                <div className="py-2 flex justify-between">
                  <dt className="text-slate-500 dark:text-slate-400">Gross Realised P/L</dt>
                  <dd className="font-mono tabular-nums font-medium text-slate-900 dark:text-slate-100">
                    {formatCurrency(metrics.totalNetProfit.value - metrics.totalCosts, settings, { signed: true })}
                  </dd>
                </div>
                <div className="py-2 flex justify-between">
                  <dt className="text-slate-500 dark:text-slate-400">Total Commissions</dt>
                  <dd className="font-mono tabular-nums text-red-700 dark:text-red-400">
                    {formatCurrency(metrics.totalCommissions, settings, { signed: true })}
                  </dd>
                </div>
                <div className="py-2 flex justify-between">
                  <dt className="text-slate-500 dark:text-slate-400">Total Swaps / Rollover</dt>
                  <dd
                    className={`font-mono tabular-nums ${
                      metrics.totalSwaps >= 0
                        ? 'text-emerald-700 dark:text-emerald-400'
                        : 'text-red-700 dark:text-red-400'
                    }`}
                  >
                    {formatCurrency(metrics.totalSwaps, settings, { signed: true })}
                  </dd>
                </div>
                <div className="py-2 flex justify-between">
                  <dt className="text-slate-500 dark:text-slate-400">Largest Win / Largest Loss</dt>
                  <dd className="font-mono tabular-nums text-slate-900 dark:text-slate-100">
                    {formatCurrency(metrics.largestWin, settings, { signed: true })} /{' '}
                    {formatCurrency(metrics.largestLoss, settings, { signed: true })}
                  </dd>
                </div>
                <div className="py-2 flex justify-between">
                  <dt className="text-slate-500 dark:text-slate-400">Largest Win / Loss (R)</dt>
                  <dd className="font-mono tabular-nums text-slate-900 dark:text-slate-100">
                    {metrics.largestWinR !== null ? `+${metrics.largestWinR.toFixed(2)}R` : '—'} /{' '}
                    {metrics.largestLossR !== null ? `${metrics.largestLossR.toFixed(2)}R` : '—'}
                  </dd>
                </div>
                <div className="py-2 flex justify-between">
                  <dt className="text-slate-500 dark:text-slate-400">Average Hold Duration</dt>
                  <dd className="font-mono tabular-nums text-slate-900 dark:text-slate-100">
                    {formatDuration(metrics.avgDurationMinutes)}
                  </dd>
                </div>
              </dl>
            </section>
          </div>

          {/* Symbol Breakdown Bar + Subset Comparison Chart (Symbol A vs Symbol B) */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5">
              <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100 mb-1">
                Net P/L by Symbol
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
                Post-cost cumulative profit per currency pair
              </p>
              <div className="h-64 w-full" role="img" aria-label="Net profit by currency pair bar chart">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={metrics.symbolBreakdown} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
                    <XAxis dataKey="symbol" tick={{ fontSize: 11, fill: axisTick }} tickLine={false} />
                    <YAxis
                      tick={{ fontSize: 11, fill: axisTick }}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v) => formatCurrency(Number(v), settings)}
                      width={72}
                    />
                    <ReferenceLine y={0} stroke={gridStroke} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: isDark ? '#0f172a' : '#ffffff',
                        borderColor: isDark ? '#334155' : '#e2e8f0',
                        borderRadius: '8px',
                        fontSize: '12px',
                      }}
                      formatter={(v: unknown) => [formatCurrency(Number(v), settings, { signed: true }), 'Net P/L']}
                    />
                    <Bar dataKey="netProfit" radius={[4, 4, 0, 0]}>
                      {metrics.symbolBreakdown.map((s) => (
                        <Cell key={s.symbol} fill={s.netProfit >= 0 ? '#16a34a' : '#dc2626'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </section>

            {/* Subset Comparison Chart */}
            <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
                <div>
                  <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                    Subset Comparison (Cumulative P/L)
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Compare equity trajectories between two instruments
                  </p>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <select
                    aria-label="Comparison symbol A"
                    value={compareSymA}
                    onChange={(e) => setCompareSymA(e.target.value)}
                    className="px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                  >
                    {symbols.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                  <span className="text-slate-400">vs</span>
                  <select
                    aria-label="Comparison symbol B"
                    value={compareSymB}
                    onChange={(e) => setCompareSymB(e.target.value)}
                    className="px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                  >
                    {symbols.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="h-64 w-full" role="img" aria-label={`Cumulative profit comparison of ${compareSymA} versus ${compareSymB}`}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={comparisonSeries} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 11, fill: axisTick }} tickLine={false} minTickGap={24} />
                    <YAxis
                      tick={{ fontSize: 11, fill: axisTick }}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v) => formatCurrency(Number(v), settings)}
                      width={72}
                    />
                    <ReferenceLine y={0} stroke={gridStroke} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: isDark ? '#0f172a' : '#ffffff',
                        borderColor: isDark ? '#334155' : '#e2e8f0',
                        borderRadius: '8px',
                        fontSize: '12px',
                      }}
                      formatter={(v: unknown, name: unknown) => [
                        formatCurrency(Number(v), settings, { signed: true }),
                        String(name),
                      ]}
                    />
                    <Legend wrapperStyle={{ fontSize: '12px' }} />
                    <Line type="monotone" dataKey={compareSymA} stroke="#2563eb" strokeWidth={2} dot={{ r: 3 }} />
                    <Line type="monotone" dataKey={compareSymB} stroke="#d97706" strokeWidth={2} dot={{ r: 3 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </section>
          </div>

          {/* Outcome Distribution + Strategy & Session Tables */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5">
              <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100 mb-1">
                Trade Outcome Distribution
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
                Frequency of closed trades by net P/L bracket ({settings.currencySymbol})
              </p>
              <div className="h-56 w-full" role="img" aria-label="Trade outcome distribution histogram">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={metrics.pnlHistogram} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
                    <XAxis dataKey="bucket" tick={{ fontSize: 10, fill: axisTick }} tickLine={false} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: axisTick }} tickLine={false} axisLine={false} width={32} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: isDark ? '#0f172a' : '#ffffff',
                        borderColor: isDark ? '#334155' : '#e2e8f0',
                        borderRadius: '8px',
                        fontSize: '12px',
                      }}
                    />
                    <Bar dataKey="count" name="Trades" radius={[4, 4, 0, 0]}>
                      {metrics.pnlHistogram.map((b) => (
                        <Cell key={b.bucket} fill={b.isPositive ? '#16a34a' : '#dc2626'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </section>

            <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800">
                <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                  Strategy & Session Breakdown
                </h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left">
                  <thead className="bg-slate-50 dark:bg-slate-950 text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800">
                    <tr>
                      <th className="py-2 px-4 font-medium">Strategy</th>
                      <th className="py-2 px-3 font-medium text-right">Trades</th>
                      <th className="py-2 px-3 font-medium text-right">Win Rate</th>
                      <th className="py-2 px-3 font-medium text-right">Avg R</th>
                      <th className="py-2 px-4 font-medium text-right">Net P/L</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-slate-800 dark:text-slate-200">
                    {metrics.strategyBreakdown.map((st) => (
                      <tr key={st.strategy}>
                        <td className="py-2 px-4 font-medium">{st.strategy}</td>
                        <td className="py-2 px-3 font-mono tabular-nums text-right">{st.tradesCount}</td>
                        <td className="py-2 px-3 font-mono tabular-nums text-right">
                          {st.winRatePct.toFixed(1)}%
                        </td>
                        <td className="py-2 px-3 font-mono tabular-nums text-right">
                          {st.avgR !== null ? `${st.avgR >= 0 ? '+' : ''}${st.avgR.toFixed(2)}R` : '—'}
                        </td>
                        <td
                          className={`py-2 px-4 font-mono tabular-nums text-right font-semibold ${
                            st.netProfit >= 0
                              ? 'text-emerald-700 dark:text-emerald-400'
                              : 'text-red-700 dark:text-red-400'
                          }`}
                        >
                          {formatCurrency(st.netProfit, settings, { signed: true })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="px-5 py-3 bg-slate-50 dark:bg-slate-950 border-t border-slate-200 dark:border-slate-800 text-xs text-slate-600 dark:text-slate-400 flex flex-wrap gap-x-4 gap-y-1">
                {metrics.sessionBreakdown.map((sb) => (
                  <span key={sb.session}>
                    <strong className="text-slate-800 dark:text-slate-200">{sb.session}:</strong>{' '}
                    <span className="font-mono tabular-nums">
                      {formatCurrency(sb.netProfit, settings, { signed: true })} ({sb.tradesCount}t)
                    </span>
                  </span>
                ))}
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
