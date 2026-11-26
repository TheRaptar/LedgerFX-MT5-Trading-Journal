import React from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ArrowUpRight, AlertTriangle } from 'lucide-react';
import type {
  ClosedTrade,
  MT5Account,
  MT5OpenPosition,
  UserSettings,
} from '../shared/types.ts';
import type { ComputedMetrics, EquityPoint } from '../shared/metricsEngine.ts';
import {
  formatCurrency,
  formatDuration,
  formatTimestampWithServer,
} from '../shared/timeUtils.ts';
import { MetricTooltip } from '../components/MetricTooltip.tsx';

interface DashboardViewProps {
  accounts: MT5Account[];
  closedTrades: ClosedTrade[];
  openPositions: MT5OpenPosition[];
  metrics: ComputedMetrics;
  settings: UserSettings;
  onSelectTrade: (trade: ClosedTrade) => void;
  onNavigate: (tab: string) => void;
}

export function DashboardView({
  accounts,
  closedTrades,
  openPositions,
  metrics,
  settings,
  onSelectTrade,
  onNavigate,
}: DashboardViewProps) {
  const isDark = settings.theme === 'dark';
  const gridStroke = isDark ? '#1e293b' : '#e2e8f0';
  const axisTick = isDark ? '#94a3b8' : '#64748b';

  const totalBalance = accounts.reduce((s, a) => s + a.balance, 0);
  const totalEquity = accounts.reduce((s, a) => s + a.equity, 0);
  const activeSyncNotices = accounts.filter((a) => a.syncNotice).map((a) => ({
    name: a.friendlyName,
    notice: a.syncNotice!,
    warnings: a.integrityWarnings,
  }));

  const kpiCards = [
    {
      metric: metrics.totalNetProfit,
      subtext: `${metrics.totalTrades} closed trades · ${formatCurrency(metrics.totalCosts, settings)} fees`,
      tone:
        metrics.totalNetProfit.value > 0
          ? 'text-emerald-700 dark:text-emerald-400'
          : metrics.totalNetProfit.value < 0
            ? 'text-red-700 dark:text-red-400'
            : 'text-slate-900 dark:text-slate-100',
    },
    {
      metric: metrics.winRate,
      subtext: `${metrics.wins}W · ${metrics.losses}L · ${metrics.breakevens}BE`,
      tone: 'text-slate-900 dark:text-slate-100',
    },
    {
      metric: metrics.profitFactor,
      subtext: `Avg Win ${formatCurrency(metrics.avgWin, settings)} / Loss ${formatCurrency(metrics.avgLoss, settings)}`,
      tone:
        metrics.profitFactor.value >= 1.5
          ? 'text-emerald-700 dark:text-emerald-400'
          : metrics.profitFactor.value >= 1
            ? 'text-slate-900 dark:text-slate-100'
            : 'text-red-700 dark:text-red-400',
    },
    {
      metric: metrics.expectancy,
      subtext: `Avg duration ${formatDuration(metrics.avgDurationMinutes)}`,
      tone:
        metrics.expectancy.value > 0
          ? 'text-emerald-700 dark:text-emerald-400'
          : metrics.expectancy.value < 0
            ? 'text-red-700 dark:text-red-400'
            : 'text-slate-900 dark:text-slate-100',
    },
    {
      metric: metrics.averageR,
      subtext: `Total ${metrics.totalR.formatted} earned`,
      tone:
        metrics.averageR.value > 0
          ? 'text-emerald-700 dark:text-emerald-400'
          : metrics.averageR.value < 0
            ? 'text-red-700 dark:text-red-400'
            : 'text-slate-900 dark:text-slate-100',
    },
    {
      metric: metrics.maxDrawdown,
      subtext: metrics.maxDrawdownPeriod
        ? `${metrics.maxDrawdownPeriod.peakDate} → ${metrics.maxDrawdownPeriod.troughDate}`
        : 'Peak-to-trough equity',
      tone: 'text-red-700 dark:text-red-400',
    },
  ];

  // Custom dot renderer for deposits (green) and withdrawals (red) on equity curve
  const renderEquityDot = (props: {
    cx?: number;
    cy?: number;
    payload?: EquityPoint;
    index?: number;
  }) => {
    const { cx, cy, payload, index } = props;
    if (cx === undefined || cy === undefined || !payload) return <g key={index} />;
    if (payload.eventType === 'deposit') {
      return (
        <circle
          key={`dep-${index}`}
          cx={cx}
          cy={cy}
          r={5}
          fill="#16a34a"
          stroke={isDark ? '#0f172a' : '#ffffff'}
          strokeWidth={1.5}
        />
      );
    }
    if (payload.eventType === 'withdrawal') {
      return (
        <circle
          key={`wd-${index}`}
          cx={cx}
          cy={cy}
          r={5}
          fill="#dc2626"
          stroke={isDark ? '#0f172a' : '#ffffff'}
          strokeWidth={1.5}
        />
      );
    }
    if (payload.eventType === 'open_mark') {
      return (
        <circle
          key={`open-${index}`}
          cx={cx}
          cy={cy}
          r={4.5}
          fill="#d97706"
          stroke={isDark ? '#0f172a' : '#ffffff'}
          strokeWidth={1.5}
        />
      );
    }
    return <g key={`empty-${index}`} />;
  };

  return (
    <div className="space-y-6">
      {/* Account Portfolio Summary Strip */}
      <div className="flex flex-wrap items-end justify-between gap-4 pb-4 border-b border-slate-200 dark:border-slate-800">
        <div>
          <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-slate-100 text-balance">
            Performance Overview
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            {accounts.length} linked MT5 {accounts.length === 1 ? 'account' : 'accounts'} · Balance{' '}
            <span className="font-mono tabular-nums font-medium text-slate-800 dark:text-slate-200">
              {formatCurrency(totalBalance, settings)}
            </span>{' '}
            · Equity{' '}
            <span className="font-mono tabular-nums font-medium text-slate-800 dark:text-slate-200">
              {formatCurrency(totalEquity, settings)}
            </span>{' '}
            · Unrealised{' '}
            <span
              className={`font-mono tabular-nums font-medium ${
                metrics.unrealisedOpenPL >= 0
                  ? 'text-emerald-700 dark:text-emerald-400'
                  : 'text-red-700 dark:text-red-400'
              }`}
            >
              {formatCurrency(metrics.unrealisedOpenPL, settings, { signed: true })}
            </span>
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
          <span>Display Zone: {settings.displayTimeZone}</span>
          <span aria-hidden="true">·</span>
          <span>Post-Cost Net Metrics</span>
        </div>
      </div>

      {/* Sync / Historical Limit Notices */}
      {activeSyncNotices.length > 0 && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg px-4 py-3 text-xs text-slate-600 dark:text-slate-300 space-y-1">
          {activeSyncNotices.map((item) => (
            <div key={item.name} className="flex flex-wrap items-center justify-between gap-2">
              <p>
                <span className="font-semibold text-slate-900 dark:text-slate-100">{item.name}:</span>{' '}
                {item.notice}
              </p>
              {item.warnings.length > 0 && (
                <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
                  {item.warnings[0]}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Primary KPI Grid */}
      <section aria-label="Key trading performance metrics">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
          {kpiCards.map((card) => (
            <div
              key={card.metric.label}
              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4 flex flex-col justify-between"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-slate-500 dark:text-slate-400 truncate">
                  {card.metric.label}
                </span>
                <MetricTooltip metric={card.metric} />
              </div>
              <p className={`font-mono tabular-nums text-lg font-semibold mt-2 ${card.tone}`}>
                {card.metric.formatted}
              </p>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1.5 truncate">
                {card.subtext}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Main Charts Row */}
      {closedTrades.length === 0 ? (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-10 text-center">
          <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
            No closed trades found for the current selection
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1.5 max-w-md mx-auto">
            Link an MT5 account, synchronise historical deals, import an MT5 CSV statement, or adjust
            your active filters to view your equity curve and performance analytics.
          </p>
          <button
            type="button"
            onClick={() => onNavigate('accounts:link')}
            className="mt-4 px-4 py-2 text-xs font-medium rounded-md bg-slate-900 dark:bg-blue-600 text-white hover:bg-slate-800 dark:hover:bg-blue-500"
          >
            Link MT5 Account
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          {/* Equity Curve (2 cols) */}
          <section
            aria-label="Account Equity Curve"
            className="xl:col-span-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
              <div>
                <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                  Account Equity Curve
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  Realised P/L, capital operations, and current open mark · Green = Deposit · Red = Withdrawal · Amber = Live Mark
                </p>
              </div>
              <span className="text-xs font-mono tabular-nums text-slate-600 dark:text-slate-300">
                Max DD: {metrics.maxDrawdown.formatted}
              </span>
            </div>

            <div className="h-72 w-full" role="img" aria-label={`Account equity curve across ${metrics.equityCurve.length} events ending at ${formatCurrency(metrics.equityCurve[metrics.equityCurve.length - 1]?.equity ?? 0, settings)}`}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={metrics.equityCurve} margin={{ top: 10, right: 12, left: 4, bottom: 0 }}>
                  <defs>
                    <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#2563eb" stopOpacity={0.2} />
                      <stop offset="95%" stopColor="#2563eb" stopOpacity={0.01} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
                  <XAxis
                    dataKey="dateLabel"
                    tick={{ fontSize: 11, fill: axisTick }}
                    tickLine={false}
                    axisLine={{ stroke: gridStroke }}
                    minTickGap={28}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: axisTick }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => formatCurrency(Number(v), settings)}
                    width={82}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: isDark ? '#0f172a' : '#ffffff',
                      borderColor: isDark ? '#334155' : '#e2e8f0',
                      borderRadius: '8px',
                      fontSize: '12px',
                      color: isDark ? '#f1f5f9' : '#0f172a',
                    }}
                    formatter={(value: unknown) => [formatCurrency(Number(value), settings), 'Equity']}
                    labelFormatter={(_label, items) => {
                      const pt = items?.[0]?.payload as EquityPoint | undefined;
                      return pt ? `${pt.dateLabel} — ${pt.eventLabel}` : '';
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="equity"
                    stroke="#2563eb"
                    strokeWidth={2}
                    fill="url(#equityFill)"
                    dot={renderEquityDot}
                    activeDot={{ r: 5 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </section>

          {/* Monthly Net P/L Chart (1 col) */}
          <section
            aria-label="Monthly Net Performance"
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5"
          >
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                  Monthly Net P/L
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  Realised post-cost profit by calendar month
                </p>
              </div>
              <button
                type="button"
                onClick={() => onNavigate('analytics')}
                className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 dark:text-blue-400 hover:underline whitespace-nowrap"
              >
                Analytics
                <ArrowUpRight className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </div>

            <div className="h-72 w-full" role="img" aria-label={`Monthly net profit bar chart covering ${metrics.monthlyPerformance.length} months`}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={metrics.monthlyPerformance} margin={{ top: 10, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
                  <XAxis
                    dataKey="monthLabel"
                    tick={{ fontSize: 11, fill: axisTick }}
                    tickLine={false}
                    axisLine={{ stroke: gridStroke }}
                  />
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
                      color: isDark ? '#f1f5f9' : '#0f172a',
                    }}
                    formatter={(value: unknown) => [
                      formatCurrency(Number(value), settings, { signed: true }),
                      'Net P/L',
                    ]}
                  />
                  <Bar dataKey="netProfit" radius={[4, 4, 0, 0]}>
                    {metrics.monthlyPerformance.map((row) => (
                      <Cell key={row.monthKey} fill={row.netProfit >= 0 ? '#16a34a' : '#dc2626'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </section>
        </div>
      )}

      {/* Open Positions + Recent Closed Trades */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Open Positions */}
        <section
          aria-label="Currently open MT5 positions"
          className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden"
        >
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-200 dark:border-slate-800">
            <div>
              <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                Open Positions ({openPositions.length})
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Excluded from realised win/loss stats until closed
              </p>
            </div>
            <span
              className={`font-mono tabular-nums text-xs font-semibold ${
                metrics.unrealisedOpenPL >= 0
                  ? 'text-emerald-700 dark:text-emerald-400'
                  : 'text-red-700 dark:text-red-400'
              }`}
            >
              Unrealised: {formatCurrency(metrics.unrealisedOpenPL, settings, { signed: true })}
            </span>
          </div>

          {openPositions.length === 0 ? (
            <p className="p-6 text-xs text-slate-500 dark:text-slate-400">
              No currently open positions on the selected MT5 account(s).
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-50 dark:bg-slate-950 text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800">
                  <tr>
                    <th className="py-2.5 px-4 font-medium">Symbol</th>
                    <th className="py-2.5 px-3 font-medium">Side</th>
                    <th className="py-2.5 px-3 font-medium text-right">Lots</th>
                    <th className="py-2.5 px-3 font-medium text-right">Entry → Mark</th>
                    <th className="py-2.5 px-3 font-medium text-right">SL / TP</th>
                    <th className="py-2.5 px-4 font-medium text-right">Unrealised</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {openPositions.map((pos) => {
                    const netUnrealised = pos.unrealisedProfit + pos.swap + pos.commission;
                    return (
                      <tr key={`${pos.accountId}-${pos.ticket}`} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                        <td className="py-2.5 px-4 font-medium text-slate-900 dark:text-slate-100">
                          <div>{pos.symbol}</div>
                          <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                            #{pos.ticket}
                          </div>
                        </td>
                        <td
                          className={`py-2.5 px-3 font-medium ${
                            pos.direction === 'BUY'
                              ? 'text-emerald-700 dark:text-emerald-400'
                              : 'text-red-700 dark:text-red-400'
                          }`}
                        >
                          {pos.direction}
                        </td>
                        <td className="py-2.5 px-3 font-mono tabular-nums text-right text-slate-800 dark:text-slate-200">
                          {pos.volume.toFixed(2)}
                        </td>
                        <td className="py-2.5 px-3 font-mono tabular-nums text-right text-slate-700 dark:text-slate-300">
                          {pos.openPrice} → {pos.currentPrice}
                        </td>
                        <td className="py-2.5 px-3 font-mono tabular-nums text-right text-slate-500 dark:text-slate-400">
                          {pos.sl ?? '—'} / {pos.tp ?? '—'}
                        </td>
                        <td
                          className={`py-2.5 px-4 font-mono tabular-nums text-right font-semibold ${
                            netUnrealised >= 0
                              ? 'text-emerald-700 dark:text-emerald-400'
                              : 'text-red-700 dark:text-red-400'
                          }`}
                        >
                          {formatCurrency(netUnrealised, settings, { signed: true })}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Recent Closed Trades */}
        <section
          aria-label="Recent closed positions"
          className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden"
        >
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-200 dark:border-slate-800">
            <div>
              <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                Recent Closed Trades
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Click any row to inspect deal fills or edit journal notes
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('history')}
              className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 dark:text-blue-400 hover:underline whitespace-nowrap"
            >
              View All ({closedTrades.length})
              <ArrowUpRight className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead className="bg-slate-50 dark:bg-slate-950 text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800">
                <tr>
                  <th className="py-2.5 px-4 font-medium">Trade</th>
                  <th className="py-2.5 px-3 font-medium">Closed</th>
                  <th className="py-2.5 px-3 font-medium">Strategy</th>
                  <th className="py-2.5 px-3 font-medium text-right">R</th>
                  <th className="py-2.5 px-4 font-medium text-right">Net P/L</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {closedTrades.slice(0, 6).map((t) => (
                  <tr
                    key={t.key}
                    tabIndex={0}
                    onClick={() => onSelectTrade(t)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onSelectTrade(t);
                      }
                    }}
                    className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50 focus-visible:outline-2 focus-visible:outline-blue-600"
                  >
                    <td className="py-2.5 px-4">
                      <div className="font-medium text-slate-900 dark:text-slate-100">
                        {t.symbol} · {t.direction}
                      </div>
                      <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                        #{t.positionId} · {t.totalVolume.toFixed(2)} lots
                        {t.isPartial ? ` · ${t.deals.length} fills` : ''}
                      </div>
                    </td>
                    <td className="py-2.5 px-3 font-mono tabular-nums text-[11px] text-slate-600 dark:text-slate-400">
                      {formatTimestampWithServer(
                        t.closeTimeUtc,
                        t.closeServerTimeRaw,
                        t.closeServerTzLabel,
                        settings,
                      )}
                    </td>
                    <td className="py-2.5 px-3 text-slate-700 dark:text-slate-300">
                      {t.journal?.strategy || 'Untagged'}
                    </td>
                    <td className="py-2.5 px-3 font-mono tabular-nums text-right text-slate-700 dark:text-slate-300">
                      {t.rMultiple !== null
                        ? `${t.rMultiple >= 0 ? '+' : ''}${t.rMultiple.toFixed(2)}R`
                        : '—'}
                    </td>
                    <td
                      className={`py-2.5 px-4 font-mono tabular-nums text-right font-semibold ${
                        t.netProfit > 0
                          ? 'text-emerald-700 dark:text-emerald-400'
                          : t.netProfit < 0
                            ? 'text-red-700 dark:text-red-400'
                            : 'text-slate-600 dark:text-slate-400'
                      }`}
                    >
                      {formatCurrency(t.netProfit, settings, { signed: true })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
