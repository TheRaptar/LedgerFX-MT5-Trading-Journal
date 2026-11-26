import React, { useEffect, useState } from 'react';
import { X, Save, Lock } from 'lucide-react';
import type { ClosedTrade, TradeJournalEntry, UserSettings } from '../shared/types.ts';
import {
  formatCurrency,
  formatDuration,
  formatTimestampWithServer,
} from '../shared/timeUtils.ts';

interface TradeDetailDrawerProps {
  trade: ClosedTrade | null;
  settings: UserSettings;
  onClose: () => void;
  onSaveJournal: (
    accountId: string,
    positionId: number,
    entry: Omit<TradeJournalEntry, 'accountId' | 'positionId' | 'updatedAtUtc'>,
  ) => Promise<void>;
}

const SUGGESTED_STRATEGIES = [
  'London Breakout',
  'Retracement',
  'Trend Continuation',
  'Range Fade',
  'News Trade',
  'NY Overlap Reversal',
];

export function TradeDetailDrawer({
  trade,
  settings,
  onClose,
  onSaveJournal,
}: TradeDetailDrawerProps) {
  const [strategy, setStrategy] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [initialRisk, setInitialRisk] = useState('');
  const [manualSl, setManualSl] = useState('');
  const [manualEntry, setManualEntry] = useState('');
  const [outcomeOverride, setOutcomeOverride] = useState<'auto' | 'win' | 'loss' | 'breakeven'>('auto');
  const [sessionOverride, setSessionOverride] = useState('');
  const [rationale, setRationale] = useState('');
  const [emotions, setEmotions] = useState('');
  const [mistakes, setMistakes] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedBanner, setSavedBanner] = useState(false);

  useEffect(() => {
    if (!trade) return;
    const j = trade.journal;
    setStrategy(j?.strategy ?? '');
    setTagsInput((j?.tags ?? []).join(', '));
    setInitialRisk(
      j?.initialRiskCurrency !== null && j?.initialRiskCurrency !== undefined
        ? String(j.initialRiskCurrency)
        : trade.initialRiskCurrency !== null
          ? String(trade.initialRiskCurrency)
          : '',
    );
    setManualSl(j?.manualSlOverride !== null && j?.manualSlOverride !== undefined ? String(j.manualSlOverride) : '');
    setManualEntry(
      j?.manualEntryOverride !== null && j?.manualEntryOverride !== undefined ? String(j.manualEntryOverride) : '',
    );
    setOutcomeOverride(j?.outcomeOverride ?? 'auto');
    setSessionOverride(j?.sessionOverride ?? '');
    setRationale(j?.rationale ?? '');
    setEmotions(j?.emotions ?? '');
    setMistakes(j?.mistakes ?? '');
    setNotes(j?.notes ?? '');
    setSavedBanner(false);
  }, [trade]);

  useEffect(() => {
    if (!trade) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [trade, onClose]);

  if (!trade) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!trade) return;
    setSaving(true);
    setSavedBanner(false);
    try {
      await onSaveJournal(trade.accountId, trade.positionId, {
        strategy: strategy.trim(),
        tags: tagsInput
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        initialRiskCurrency: initialRisk.trim() ? Number(initialRisk) : null,
        manualSlOverride: manualSl.trim() ? Number(manualSl) : null,
        manualEntryOverride: manualEntry.trim() ? Number(manualEntry) : null,
        outcomeOverride,
        sessionOverride,
        rationale,
        emotions,
        mistakes,
        notes,
      });
      setSavedBanner(true);
    } catch {
      // Handled by parent App banner / auth redirect
    } finally {
      setSaving(false);
    }
  }

  const pnlClass =
    trade.netProfit > 0
      ? 'text-emerald-700 dark:text-emerald-400'
      : trade.netProfit < 0
        ? 'text-red-700 dark:text-red-400'
        : 'text-slate-700 dark:text-slate-300';

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-slate-950/40"
      role="dialog"
      aria-modal="true"
      aria-labelledby="trade-drawer-title"
    >
      <div className="fixed inset-0" onClick={onClose} aria-hidden="true" />
      <div className="relative z-10 w-full max-w-2xl bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 h-full overflow-y-auto flex flex-col">
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between px-6 py-4 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800">
          <div>
            <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
              <span className="font-mono">Position #{trade.positionId}</span>
              <span aria-hidden="true">·</span>
              <span>{trade.accountName}</span>
              <span aria-hidden="true">·</span>
              <span>{trade.session}</span>
            </div>
            <h2
              id="trade-drawer-title"
              className="font-display text-lg font-bold text-slate-900 dark:text-slate-100 mt-0.5 flex items-center gap-3"
            >
              <span>
                {trade.symbol} {trade.direction}
              </span>
              <span className={`font-mono tabular-nums ${pnlClass}`}>
                {formatCurrency(trade.netProfit, settings, { signed: true })}
              </span>
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close trade detail panel"
            className="p-2 rounded-lg text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-6 flex-1">
          {/* Locked MT5 Execution Summary */}
          <section aria-label="Locked MT5 execution record">
            <div className="flex items-center justify-between mb-2.5">
              <h3 className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                Imported MT5 Record (Core Fields Locked)
              </h3>
              <span className="inline-flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
                <Lock className="w-3 h-3" aria-hidden="true" />
                Verified from {trade.deals.length} {trade.deals.length === 1 ? 'deal' : 'deals'}
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-3 p-4 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-xs">
              <div>
                <p className="text-slate-500 dark:text-slate-400">Total Volume</p>
                <p className="font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-100 mt-0.5">
                  {trade.totalVolume.toFixed(2)} lots
                </p>
              </div>
              <div>
                <p className="text-slate-500 dark:text-slate-400">Weighted Entry</p>
                <p className="font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-100 mt-0.5">
                  {trade.weightedEntryPrice}
                </p>
              </div>
              <div>
                <p className="text-slate-500 dark:text-slate-400">Weighted Exit</p>
                <p className="font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-100 mt-0.5">
                  {trade.weightedExitPrice}
                </p>
              </div>
              <div>
                <p className="text-slate-500 dark:text-slate-400">Gross P/L</p>
                <p className="font-mono tabular-nums text-slate-900 dark:text-slate-100 mt-0.5">
                  {formatCurrency(trade.grossProfit, settings, { signed: true })}
                </p>
              </div>
              <div>
                <p className="text-slate-500 dark:text-slate-400">Commission / Swap</p>
                <p className="font-mono tabular-nums text-slate-900 dark:text-slate-100 mt-0.5">
                  {formatCurrency(trade.commission, settings, { signed: true })} /{' '}
                  {formatCurrency(trade.swap, settings, { signed: true })}
                </p>
              </div>
              <div>
                <p className="text-slate-500 dark:text-slate-400">R-Multiple · Duration</p>
                <p className="font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-100 mt-0.5">
                  {trade.rMultiple !== null
                    ? `${trade.rMultiple >= 0 ? '+' : ''}${trade.rMultiple.toFixed(2)}R`
                    : '—'}{' '}
                  · {formatDuration(trade.durationMinutes)}
                </p>
              </div>
              <div className="col-span-2 sm:col-span-3 pt-2 border-t border-slate-200 dark:border-slate-800 grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <p className="text-slate-500 dark:text-slate-400">Entry Time</p>
                  <p className="font-mono tabular-nums text-slate-800 dark:text-slate-200 mt-0.5">
                    {formatTimestampWithServer(
                      trade.openTimeUtc,
                      trade.openServerTimeRaw,
                      trade.openServerTzLabel,
                      settings,
                    )}
                  </p>
                </div>
                <div>
                  <p className="text-slate-500 dark:text-slate-400">Exit Time</p>
                  <p className="font-mono tabular-nums text-slate-800 dark:text-slate-200 mt-0.5">
                    {formatTimestampWithServer(
                      trade.closeTimeUtc,
                      trade.closeServerTimeRaw,
                      trade.closeServerTzLabel,
                      settings,
                    )}
                  </p>
                </div>
              </div>
            </div>
          </section>

          {/* Underlying MT5 Deals (Partial Entries / Exits) */}
          <section aria-label="Underlying MT5 execution deals">
            <h3 className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-2">
              Deal-Level Execution Log ({trade.entryFillsCount} entry · {trade.exitFillsCount} exit)
            </h3>
            <div className="overflow-x-auto border border-slate-200 dark:border-slate-800 rounded-lg">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-50 dark:bg-slate-950 text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800">
                  <tr>
                    <th className="py-2 px-3 font-medium">Deal Ticket</th>
                    <th className="py-2 px-3 font-medium">Event</th>
                    <th className="py-2 px-3 font-medium">Time</th>
                    <th className="py-2 px-3 font-medium text-right">Volume</th>
                    <th className="py-2 px-3 font-medium text-right">Price</th>
                    <th className="py-2 px-3 font-medium text-right">Profit</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {trade.deals.map((d) => (
                    <tr key={d.ticket} className="text-slate-800 dark:text-slate-200">
                      <td className="py-2 px-3 font-mono tabular-nums">#{d.ticket}</td>
                      <td className="py-2 px-3">
                        {d.dealEntry.replace('DEAL_ENTRY_', '')} · {d.dealType.replace('DEAL_TYPE_', '')}
                      </td>
                      <td className="py-2 px-3 font-mono tabular-nums text-[11px] text-slate-600 dark:text-slate-400">
                        {formatTimestampWithServer(d.utcTime, d.serverTimeRaw, d.serverTzLabel, settings)}
                      </td>
                      <td className="py-2 px-3 font-mono tabular-nums text-right">{d.volume.toFixed(2)}</td>
                      <td className="py-2 px-3 font-mono tabular-nums text-right">{d.price}</td>
                      <td className="py-2 px-3 font-mono tabular-nums text-right">
                        {formatCurrency(d.profit + d.commission + d.swap, settings, { signed: true })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Editable Journal & Strategy Form */}
          <form onSubmit={handleSubmit} className="space-y-4 pt-2 border-t border-slate-200 dark:border-slate-800">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Trade Journal & Risk Attribution
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Strategy / Setup Label
                </label>
                <input
                  list="strategy-suggestions"
                  value={strategy}
                  onChange={(e) => setStrategy(e.target.value)}
                  placeholder="e.g. London Breakout"
                  className="w-full px-3 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                />
                <datalist id="strategy-suggestions">
                  {SUGGESTED_STRATEGIES.map((s) => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Tags (comma-separated)
                </label>
                <input
                  value={tagsInput}
                  onChange={(e) => setTagsInput(e.target.value)}
                  placeholder="A+ Setup, Partial Exit, News"
                  className="w-full px-3 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Initial Risk ({settings.currencySymbol} for R-Multiple)
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={initialRisk}
                  onChange={(e) => setInitialRisk(e.target.value)}
                  placeholder="e.g. 150.00"
                  className="w-full px-3 py-2 text-xs font-mono tabular-nums rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Manual Stop-Loss Override (optional)
                </label>
                <input
                  type="number"
                  step="0.00001"
                  value={manualSl}
                  onChange={(e) => setManualSl(e.target.value)}
                  placeholder={trade.sl ? String(trade.sl) : 'Not captured by broker'}
                  className="w-full px-3 py-2 text-xs font-mono tabular-nums rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Outcome Classification
                </label>
                <select
                  value={outcomeOverride}
                  onChange={(e) => setOutcomeOverride(e.target.value as 'auto' | 'win' | 'loss' | 'breakeven')}
                  className="w-full px-3 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                >
                  <option value="auto">Automatic (from Net P/L)</option>
                  <option value="win">Win</option>
                  <option value="loss">Loss</option>
                  <option value="breakeven">Break-Even</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Market Session Override
                </label>
                <select
                  value={sessionOverride}
                  onChange={(e) => setSessionOverride(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                >
                  <option value="">Automatic ({trade.session})</option>
                  <option value="Asia">Asia</option>
                  <option value="London">London</option>
                  <option value="London/NY Overlap">London/NY Overlap</option>
                  <option value="New York">New York</option>
                  <option value="Off-Hours">Off-Hours</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Trade Rationale
              </label>
              <textarea
                rows={2}
                value={rationale}
                onChange={(e) => setRationale(e.target.value)}
                placeholder="Why did you enter this setup? Structure, confluence, catalyst..."
                className="w-full px-3 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Emotional State
                </label>
                <input
                  value={emotions}
                  onChange={(e) => setEmotions(e.target.value)}
                  placeholder="Calm, FOMO, impatient, confident..."
                  className="w-full px-3 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Mistakes / Rule Deviations
                </label>
                <input
                  value={mistakes}
                  onChange={(e) => setMistakes(e.target.value)}
                  placeholder="Moved stop early, oversized, none..."
                  className="w-full px-3 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Post-Trade Notes & Lessons
              </label>
              <textarea
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Key takeaway to review before taking this setup again..."
                className="w-full px-3 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              />
            </div>

            {savedBanner && (
              <p role="status" className="text-xs text-emerald-700 dark:text-emerald-400 font-medium">
                Journal entry saved and persisted to local encrypted database.
              </p>
            )}

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-xs font-medium rounded-md border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
              >
                Close
              </button>
              <button
                type="submit"
                disabled={saving}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-md bg-slate-900 hover:bg-slate-800 dark:bg-blue-600 dark:hover:bg-blue-500 text-white disabled:opacity-60 whitespace-nowrap"
              >
                <Save className="w-3.5 h-3.5" aria-hidden="true" />
                {saving ? 'Saving...' : 'Save Journal Entry'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
