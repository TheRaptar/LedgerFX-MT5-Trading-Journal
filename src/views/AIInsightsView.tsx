import React, { useMemo, useState } from 'react';
import { RefreshCw, AlertCircle, BarChart3 } from 'lucide-react';
import type {
  AIInsightsResponse,
  ClosedTrade,
  MT5Account,
  UserSettings,
} from '../shared/types.ts';
import type { ComputedMetrics } from '../shared/metricsEngine.ts';
import { formatCurrency } from '../shared/timeUtils.ts';
import { api } from '../lib/api.ts';

interface AIInsightsViewProps {
  accounts: MT5Account[];
  closedTrades: ClosedTrade[];
  metrics: ComputedMetrics;
  settings: UserSettings;
  onSelectTrade: (trade: ClosedTrade) => void;
}

export function AIInsightsView({
  accounts,
  closedTrades,
  metrics,
  settings,
  onSelectTrade,
}: AIInsightsViewProps) {
  const [accountId, setAccountId] = useState('all');
  const [focusArea, setFocusArea] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiResult, setAiResult] = useState<AIInsightsResponse | null>(null);

  const tradeByPosId = useMemo(
    () => new Map(closedTrades.map((t) => [t.positionId, t])),
    [closedTrades],
  );

  // Built-in deterministic statistical findings (runs locally with zero external dependencies)
  const statisticalFindings = useMemo(() => {
    const items: Array<{
      title: string;
      summary: string;
      metric: string;
      tradeIds: number[];
    }> = [];

    if (metrics.symbolBreakdown.length > 0) {
      const best = metrics.symbolBreakdown[0];
      const worst = metrics.symbolBreakdown[metrics.symbolBreakdown.length - 1];
      const bestIds = closedTrades
        .filter((t) => t.symbol === best.symbol && t.netProfit > 0)
        .slice(0, 4)
        .map((t) => t.positionId);
      items.push({
        title: `Strongest Instrument: ${best.symbol}`,
        summary: `${best.symbol} generated ${formatCurrency(best.netProfit, settings, { signed: true })} across ${best.tradesCount} trades (${best.winRatePct.toFixed(1)}% win rate).`,
        metric: `Net ${formatCurrency(best.netProfit, settings, { signed: true })} · ${best.tradesCount} trades`,
        tradeIds: bestIds,
      });

      if (worst.netProfit < 0) {
        const worstIds = closedTrades
          .filter((t) => t.symbol === worst.symbol && t.netProfit < 0)
          .slice(0, 4)
          .map((t) => t.positionId);
        items.push({
          title: `Primary Performance Drag: ${worst.symbol}`,
          summary: `${worst.symbol} produced ${formatCurrency(worst.netProfit, settings, { signed: true })} over ${worst.tradesCount} trades (${worst.winRatePct.toFixed(1)}% win rate).`,
          metric: `Net ${formatCurrency(worst.netProfit, settings, { signed: true })}`,
          tradeIds: worstIds,
        });
      }
    }

    const partialTrades = closedTrades.filter((t) => t.isPartial);
    if (partialTrades.length > 0) {
      const partialNet = partialTrades.reduce((s, t) => s + t.netProfit, 0);
      items.push({
        title: 'Multi-Fill / Partial-Exit Execution Impact',
        summary: `Positions scaled in or exited in stages contributed ${formatCurrency(partialNet, settings, { signed: true })} across ${partialTrades.length} multi-fill positions.`,
        metric: `${partialTrades.length} scaled positions`,
        tradeIds: partialTrades.map((t) => t.positionId),
      });
    }

    const feeRatio =
      metrics.grossWinsSum > 0
        ? (Math.abs(metrics.totalCosts) / metrics.grossWinsSum) * 100
        : 0;
    items.push({
      title: 'Broker Cost Drag (Commissions & Swaps)',
      summary: `Total trading costs of ${formatCurrency(metrics.totalCosts, settings)} equalled ${feeRatio.toFixed(1)}% of gross winning profits.`,
      metric: `Comm ${formatCurrency(metrics.totalCommissions, settings)} · Swap ${formatCurrency(metrics.totalSwaps, settings)}`,
      tradeIds: closedTrades
        .slice()
        .sort((a, b) => a.commission + a.swap - (b.commission + b.swap))
        .slice(0, 3)
        .map((t) => t.positionId),
    });

    return items;
  }, [closedTrades, metrics, settings]);

  async function handleRunAiAudit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await api.generateAiInsights(accountId, focusArea.trim() || undefined);
      setAiResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to generate AI retrospective audit.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="pb-4 border-b border-slate-200 dark:border-slate-800">
        <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-slate-100">
          Retrospective AI Insights
        </h1>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
          Evidence-backed pattern audit of your personal historical trades · Click any cited Position ID to inspect the underlying trade
        </p>
      </div>

      {/* Mandatory Non-Advice Disclaimer */}
      <div
        role="note"
        className="bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4 text-xs text-slate-600 dark:text-slate-300 leading-relaxed"
      >
        <strong className="text-slate-900 dark:text-slate-100">Informational Disclaimer:</strong> AI
        analysis is based strictly on historical data patterns in your journal and is{' '}
        <strong>not a trading signal or financial advice</strong>. Past performance is not a guarantee
        of future results. Automated analysis may be limited by sample size, outliers, or market regime
        changes — always exercise independent judgement.
      </div>

      {/* Gemini Retrospective Analysis Runner */}
      <form
        onSubmit={handleRunAiAudit}
        className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-4"
      >
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[200px]">
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
              Account Scope
            </label>
            <select
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
            >
              <option value="all">All Linked MT5 Accounts</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.friendlyName} (#{a.accountLogin})
                </option>
              ))}
            </select>
          </div>

          <div className="flex-1 min-w-[240px]">
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
              Optional Audit Focus
            </label>
            <input
              value={focusArea}
              onChange={(e) => setFocusArea(e.target.value)}
              placeholder="e.g. Compare London vs New York sessions, or review NFP losses..."
              className="w-full px-3 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
            />
          </div>

          <button
            type="submit"
            disabled={loading || closedTrades.length === 0}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-md bg-slate-900 dark:bg-blue-600 text-white hover:bg-slate-800 dark:hover:bg-blue-500 disabled:opacity-60 whitespace-nowrap"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
            {loading ? 'Analysing History...' : 'Run AI Pattern Audit'}
          </button>
        </div>

        {error && (
          <div
            role="alert"
            className="flex items-start gap-2 text-xs text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-md px-3.5 py-2.5"
          >
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}
      </form>

      {/* AI Generated Report */}
      {aiResult && (
        <section
          aria-label="AI generated retrospective observations"
          className="space-y-4"
        >
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400 mb-2">
              <span>AI Retrospective Summary · {aiResult.sampleSize} trades analysed</span>
              <span className="font-mono">{aiResult.generatedAtUtc.slice(0, 19).replace('T', ' ')} UTC</span>
            </div>
            <p className="text-sm text-slate-800 dark:text-slate-200 leading-relaxed">
              {aiResult.overallObservation}
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {aiResult.insights.map((ins, idx) => (
              <article
                key={idx}
                className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 flex flex-col justify-between space-y-3"
              >
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
                    <span>{ins.category}</span>
                    <span
                      className={`font-medium capitalize ${
                        ins.severity === 'positive'
                          ? 'text-emerald-700 dark:text-emerald-400'
                          : ins.severity === 'critical'
                            ? 'text-red-700 dark:text-red-400'
                            : ins.severity === 'caution'
                              ? 'text-amber-700 dark:text-amber-400'
                              : 'text-slate-600 dark:text-slate-400'
                      }`}
                    >
                      {ins.severity}
                    </span>
                  </div>
                  <h3 className="font-display text-sm font-bold text-slate-900 dark:text-slate-100">
                    {ins.title}
                  </h3>
                  <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                    {ins.summary}
                  </p>
                  <p className="text-xs text-slate-700 dark:text-slate-200">
                    <span className="font-medium">Reflection:</span> {ins.actionableReflection}
                  </p>
                </div>

                <div className="pt-3 border-t border-slate-100 dark:border-slate-800 space-y-1.5 text-xs">
                  <p className="font-mono text-[11px] text-slate-600 dark:text-slate-400">
                    Metric: {ins.supportingMetric}
                  </p>
                  {ins.evidenceTradeIds.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[11px] text-slate-500 dark:text-slate-400">Cited trades:</span>
                      {ins.evidenceTradeIds.map((pid) => {
                        const match = tradeByPosId.get(pid);
                        return match ? (
                          <button
                            key={pid}
                            type="button"
                            onClick={() => onSelectTrade(match)}
                            className="font-mono text-[11px] text-blue-700 dark:text-blue-400 hover:underline"
                          >
                            #{pid} ({match.symbol})
                          </button>
                        ) : (
                          <span key={pid} className="font-mono text-[11px] text-slate-500">
                            #{pid}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {/* Built-in Deterministic Statistical Scanner */}
      <section aria-label="Built-in statistical pattern scanner" className="space-y-3">
        <div className="flex items-center gap-2">
          <BarChart3 className="w-4 h-4 text-slate-500" aria-hidden="true" />
          <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
            Built-In Statistical Observations (Deterministic)
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {statisticalFindings.map((item) => (
            <div
              key={item.title}
              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4 space-y-2"
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                  {item.title}
                </h3>
                <span className="font-mono text-[11px] text-slate-600 dark:text-slate-400">
                  {item.metric}
                </span>
              </div>
              <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                {item.summary}
              </p>
              {item.tradeIds.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 pt-1 text-[11px]">
                  <span className="text-slate-500 dark:text-slate-400">Evidence:</span>
                  {item.tradeIds.map((pid) => {
                    const match = tradeByPosId.get(pid);
                    return match ? (
                      <button
                        key={pid}
                        type="button"
                        onClick={() => onSelectTrade(match)}
                        className="font-mono text-blue-700 dark:text-blue-400 hover:underline"
                      >
                        #{pid}
                      </button>
                    ) : null;
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
