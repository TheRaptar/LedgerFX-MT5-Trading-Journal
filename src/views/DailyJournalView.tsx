import React, { useEffect, useMemo, useState } from 'react';
import { Save, Plus } from 'lucide-react';
import type {
  ClosedTrade,
  DailyJournalEntry,
  PeriodicReview,
  UserSettings,
} from '../shared/types.ts';
import { formatCurrency, getIsoDayInZone } from '../shared/timeUtils.ts';

interface DailyJournalViewProps {
  selectedDate: string;
  onSelectDate: (date: string) => void;
  dailyJournals: DailyJournalEntry[];
  periodicReviews: PeriodicReview[];
  closedTrades: ClosedTrade[];
  settings: UserSettings;
  onSaveDaily: (
    date: string,
    entry: Omit<DailyJournalEntry, 'date' | 'updatedAtUtc'>,
  ) => Promise<void>;
  onSaveReview: (
    id: string,
    review: Omit<PeriodicReview, 'id' | 'updatedAtUtc'>,
  ) => Promise<void>;
  onSelectTrade: (trade: ClosedTrade) => void;
}

export function DailyJournalView({
  selectedDate,
  onSelectDate,
  dailyJournals,
  periodicReviews,
  closedTrades,
  settings,
  onSaveDaily,
  onSaveReview,
  onSelectTrade,
}: DailyJournalViewProps) {
  const [subTab, setSubTab] = useState<'daily' | 'reviews'>('daily');

  const existingDay = useMemo(
    () => dailyJournals.find((d) => d.date === selectedDate) ?? null,
    [dailyJournals, selectedDate],
  );

  const [narrative, setNarrative] = useState('');
  const [mood, setMood] = useState(3);
  const [discipline, setDiscipline] = useState(3);
  const [stress, setStress] = useState(3);
  const [confidence, setConfidence] = useState(3);
  const [sessionLabel, setSessionLabel] = useState('');
  const [lessons, setLessons] = useState('');
  const [savingDay, setSavingDay] = useState(false);
  const [daySavedMsg, setDaySavedMsg] = useState<string | null>(null);

  // Periodic review form state
  const [showNewReview, setShowNewReview] = useState(false);
  const [revType, setRevType] = useState<'weekly' | 'monthly'>('weekly');
  const [revLabel, setRevLabel] = useState('Week 47 (16–22 Nov 2026)');
  const [revStart, setRevStart] = useState('2026-11-16');
  const [revEnd, setRevEnd] = useState('2026-11-22');
  const [revLessons, setRevLessons] = useState('');
  const [revGoals, setRevGoals] = useState('');
  const [revTriggers, setRevTriggers] = useState('');
  const [revRating, setRevRating] = useState(4);

  useEffect(() => {
    setNarrative(existingDay?.narrative ?? '');
    setMood(existingDay?.mood ?? 3);
    setDiscipline(existingDay?.discipline ?? 3);
    setStress(existingDay?.stress ?? 3);
    setConfidence(existingDay?.confidence ?? 3);
    setSessionLabel(existingDay?.sessionLabel ?? '');
    setLessons(existingDay?.lessons ?? '');
    setDaySavedMsg(null);
  }, [existingDay, selectedDate]);

  // Trades automatically linked to selectedDate
  const dayTrades = useMemo(() => {
    return closedTrades.filter(
      (t) => getIsoDayInZone(t.closeTimeUtc, settings.displayTimeZone) === selectedDate,
    );
  }, [closedTrades, selectedDate, settings.displayTimeZone]);

  const dayNetPL = dayTrades.reduce((s, t) => s + t.netProfit, 0);

  // Psychology vs P/L correlation summary across logged days
  const psychologyStats = useMemo(() => {
    const highDisciplineDays = dailyJournals.filter((d) => d.discipline >= 4);
    const lowDisciplineDays = dailyJournals.filter((d) => d.discipline <= 2);
    const highStressDays = dailyJournals.filter((d) => d.stress >= 4);

    const avgPnlForDates = (dates: string[]) => {
      if (dates.length === 0) return null;
      const set = new Set(dates);
      const matching = closedTrades.filter((t) =>
        set.has(getIsoDayInZone(t.closeTimeUtc, settings.displayTimeZone)),
      );
      if (matching.length === 0) return 0;
      return matching.reduce((s, t) => s + t.netProfit, 0) / dates.length;
    };

    return {
      highDisciplineAvg: avgPnlForDates(highDisciplineDays.map((d) => d.date)),
      lowDisciplineAvg: avgPnlForDates(lowDisciplineDays.map((d) => d.date)),
      highStressAvg: avgPnlForDates(highStressDays.map((d) => d.date)),
      loggedDaysCount: dailyJournals.length,
    };
  }, [dailyJournals, closedTrades, settings.displayTimeZone]);

  async function handleSaveDay(e: React.FormEvent) {
    e.preventDefault();
    setSavingDay(true);
    setDaySavedMsg(null);
    try {
      await onSaveDaily(selectedDate, {
        narrative,
        mood,
        discipline,
        stress,
        confidence,
        sessionLabel,
        lessons,
      });
      setDaySavedMsg(`Daily journal saved for ${selectedDate}.`);
    } catch (err) {
      setDaySavedMsg(err instanceof Error ? err.message : 'Unable to save daily journal.');
    } finally {
      setSavingDay(false);
    }
  }

  async function handleSaveReview(e: React.FormEvent) {
    e.preventDefault();
    const id = `rev_${Date.now()}`;
    try {
      await onSaveReview(id, {
        periodType: revType,
        periodLabel: revLabel.trim() || `${revStart} to ${revEnd}`,
        startDate: revStart,
        endDate: revEnd,
        lessonsLearned: revLessons,
        goalsNextPeriod: revGoals,
        psychologicalTriggers: revTriggers,
        rating: revRating,
      });
      setShowNewReview(false);
      setRevLessons('');
      setRevGoals('');
      setRevTriggers('');
    } catch (err) {
      setDaySavedMsg(err instanceof Error ? err.message : 'Unable to save periodic review.');
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4 pb-4 border-b border-slate-200 dark:border-slate-800">
        <div>
          <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-slate-100">
            Daily Journal & Psychology
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Track daily mindset, discipline, stress, and periodic weekly/monthly reflections linked directly to your trades
          </p>
        </div>

        <div
          role="group"
          aria-label="Journal view mode"
          className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg"
        >
          <button
            type="button"
            onClick={() => setSubTab('daily')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              subTab === 'daily'
                ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            Daily Log ({dailyJournals.length})
          </button>
          <button
            type="button"
            onClick={() => setSubTab('reviews')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              subTab === 'reviews'
                ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            Weekly & Monthly Reviews ({periodicReviews.length})
          </button>
        </div>
      </div>

      {/* Psychology Correlation Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4">
          <p className="text-xs text-slate-500 dark:text-slate-400">High Discipline Days (4–5/5)</p>
          <p className="font-mono tabular-nums text-base font-semibold text-emerald-700 dark:text-emerald-400 mt-1">
            {psychologyStats.highDisciplineAvg !== null
              ? `${formatCurrency(psychologyStats.highDisciplineAvg, settings, { signed: true })} avg/day`
              : '—'}
          </p>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4">
          <p className="text-xs text-slate-500 dark:text-slate-400">Low Discipline Days (1–2/5)</p>
          <p className="font-mono tabular-nums text-base font-semibold text-red-700 dark:text-red-400 mt-1">
            {psychologyStats.lowDisciplineAvg !== null
              ? `${formatCurrency(psychologyStats.lowDisciplineAvg, settings, { signed: true })} avg/day`
              : '—'}
          </p>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4">
          <p className="text-xs text-slate-500 dark:text-slate-400">High Stress Days (4–5/5)</p>
          <p className="font-mono tabular-nums text-base font-semibold text-amber-700 dark:text-amber-400 mt-1">
            {psychologyStats.highStressAvg !== null
              ? `${formatCurrency(psychologyStats.highStressAvg, settings, { signed: true })} avg/day`
              : '—'}
          </p>
        </div>
      </div>

      {subTab === 'daily' ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left Column: Date Picker & Past Entries List */}
          <div className="space-y-4">
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4">
              <label
                htmlFor="daily-date-picker"
                className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-2"
              >
                Select Trading Day
              </label>
              <input
                id="daily-date-picker"
                type="date"
                value={selectedDate}
                onChange={(e) => onSelectDate(e.target.value)}
                className="w-full px-3 py-2 text-xs font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              />
            </div>

            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800">
                <h2 className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                  Recorded Daily Entries
                </h2>
              </div>
              <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-96 overflow-y-auto">
                {dailyJournals.length === 0 ? (
                  <p className="p-4 text-xs text-slate-500 dark:text-slate-400">No entries recorded yet.</p>
                ) : (
                  dailyJournals.map((entry) => {
                    const tradesOnDay = closedTrades.filter(
                      (t) => getIsoDayInZone(t.closeTimeUtc, settings.displayTimeZone) === entry.date,
                    );
                    const sum = tradesOnDay.reduce((s, t) => s + t.netProfit, 0);
                    const isSelected = entry.date === selectedDate;
                    return (
                      <button
                        key={entry.date}
                        type="button"
                        onClick={() => onSelectDate(entry.date)}
                        className={`w-full text-left px-4 py-3 transition-colors ${
                          isSelected
                            ? 'bg-slate-100 dark:bg-slate-800'
                            : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'
                        }`}
                      >
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                            {entry.date}
                          </span>
                          <span
                            className={`font-mono tabular-nums font-medium ${
                              sum > 0
                                ? 'text-emerald-700 dark:text-emerald-400'
                                : sum < 0
                                  ? 'text-red-700 dark:text-red-400'
                                  : 'text-slate-500'
                            }`}
                          >
                            {tradesOnDay.length > 0
                              ? formatCurrency(sum, settings, { signed: true })
                              : 'No trades'}
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 line-clamp-1">
                          Discipline {entry.discipline}/5 · Stress {entry.stress}/5 · {entry.sessionLabel || 'General'}
                        </p>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          </div>

          {/* Right 2 Columns: Daily Editor + Automatically Linked Trades */}
          <div className="lg:col-span-2 space-y-5">
            <form
              onSubmit={handleSaveDay}
              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-slate-200 dark:border-slate-800">
                <div>
                  <h2 className="font-display text-base font-bold text-slate-900 dark:text-slate-100">
                    Trading Day: <span className="font-mono">{selectedDate}</span>
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {dayTrades.length} linked {dayTrades.length === 1 ? 'trade' : 'trades'} · Day Net P/L:{' '}
                    <span
                      className={`font-mono font-semibold ${
                        dayNetPL > 0
                          ? 'text-emerald-700 dark:text-emerald-400'
                          : dayNetPL < 0
                            ? 'text-red-700 dark:text-red-400'
                            : 'text-slate-700 dark:text-slate-300'
                      }`}
                    >
                      {formatCurrency(dayNetPL, settings, { signed: true })}
                    </span>
                  </p>
                </div>
                <button
                  type="submit"
                  disabled={savingDay}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-md bg-slate-900 dark:bg-blue-600 text-white hover:bg-slate-800 dark:hover:bg-blue-500 disabled:opacity-60 whitespace-nowrap"
                >
                  <Save className="w-3.5 h-3.5" aria-hidden="true" />
                  {savingDay ? 'Saving...' : 'Save Daily Entry'}
                </button>
              </div>

              {/* 1-5 Psychology Sliders */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                {[
                  { label: 'Mood', val: mood, set: setMood },
                  { label: 'Discipline', val: discipline, set: setDiscipline },
                  { label: 'Stress', val: stress, set: setStress },
                  { label: 'Confidence', val: confidence, set: setConfidence },
                ].map((item) => (
                  <div key={item.label}>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="font-medium text-slate-700 dark:text-slate-300">{item.label}</span>
                      <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                        {item.val}/5
                      </span>
                    </div>
                    <input
                      type="range"
                      min={1}
                      max={5}
                      value={item.val}
                      aria-label={`${item.label} rating 1 to 5`}
                      onChange={(e) => item.set(Number(e.target.value))}
                      className="w-full accent-blue-600"
                    />
                  </div>
                ))}
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Session / Market Context Label
                </label>
                <input
                  value={sessionLabel}
                  onChange={(e) => setSessionLabel(e.target.value)}
                  placeholder="e.g. London Open, News Day — US CPI, Quiet Range"
                  className="w-full px-3 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Daily Narrative & Self-Assessment
                </label>
                <textarea
                  rows={4}
                  value={narrative}
                  onChange={(e) => setNarrative(e.target.value)}
                  placeholder="How did you execute your plan today? Note any anxiety, hesitation, overtrading, or strong discipline..."
                  className="w-full px-3 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Key Lesson for Next Session
                </label>
                <textarea
                  rows={2}
                  value={lessons}
                  onChange={(e) => setLessons(e.target.value)}
                  placeholder="One concrete behavioural adjustment to carry forward..."
                  className="w-full px-3 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                />
              </div>

              {daySavedMsg && (
                <p role="status" className="text-xs text-emerald-700 dark:text-emerald-400 font-medium">
                  {daySavedMsg}
                </p>
              )}
            </form>

            {/* Trades Automatically Linked to This Date */}
            <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800">
                <h3 className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                  Trades Closed on {selectedDate} ({dayTrades.length})
                </h3>
              </div>
              {dayTrades.length === 0 ? (
                <p className="p-5 text-xs text-slate-500 dark:text-slate-400">
                  No closed positions recorded on {selectedDate}.
                </p>
              ) : (
                <div className="divide-y divide-slate-100 dark:divide-slate-800">
                  {dayTrades.map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      onClick={() => onSelectTrade(t)}
                      className="w-full text-left px-5 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/40 flex items-center justify-between gap-4 text-xs"
                    >
                      <div>
                        <span className="font-semibold text-slate-900 dark:text-slate-100">
                          {t.symbol} {t.direction}
                        </span>
                        <span className="text-slate-500 dark:text-slate-400 ml-2 font-mono">
                          #{t.positionId} · {t.totalVolume.toFixed(2)} lots
                        </span>
                        <span className="text-slate-500 dark:text-slate-400 ml-2">
                          · {t.journal?.strategy || 'Untagged'}
                        </span>
                      </div>
                      <span
                        className={`font-mono tabular-nums font-semibold ${
                          t.netProfit >= 0
                            ? 'text-emerald-700 dark:text-emerald-400'
                            : 'text-red-700 dark:text-red-400'
                        }`}
                      >
                        {formatCurrency(t.netProfit, settings, { signed: true })}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          </div>
        </div>
      ) : (
        /* Weekly & Monthly Periodic Reviews */
        <div className="space-y-4">
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => setShowNewReview((v) => !v)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-md bg-slate-900 dark:bg-blue-600 text-white whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5" aria-hidden="true" />
              New Weekly / Monthly Review
            </button>
          </div>

          {showNewReview && (
            <form
              onSubmit={handleSaveReview}
              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-4"
            >
              <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                Add Periodic Reflection
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                <select
                  value={revType}
                  onChange={(e) => setRevType(e.target.value as 'weekly' | 'monthly')}
                  className="px-3 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                >
                  <option value="weekly">Weekly Review</option>
                  <option value="monthly">Monthly Review</option>
                </select>
                <input
                  required
                  value={revLabel}
                  onChange={(e) => setRevLabel(e.target.value)}
                  placeholder="Period label (e.g. November 2026)"
                  className="px-3 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                />
                <input
                  type="date"
                  value={revStart}
                  onChange={(e) => setRevStart(e.target.value)}
                  className="px-3 py-2 text-xs font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                />
                <input
                  type="date"
                  value={revEnd}
                  onChange={(e) => setRevEnd(e.target.value)}
                  className="px-3 py-2 text-xs font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                />
              </div>
              <textarea
                rows={2}
                required
                value={revLessons}
                onChange={(e) => setRevLessons(e.target.value)}
                placeholder="Key lessons learned this period..."
                className="w-full px-3 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              />
              <textarea
                rows={2}
                value={revGoals}
                onChange={(e) => setRevGoals(e.target.value)}
                placeholder="Concrete process goals for next week / month..."
                className="w-full px-3 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <input
                  value={revTriggers}
                  onChange={(e) => setRevTriggers(e.target.value)}
                  placeholder="Psychological triggers noticed..."
                  className="px-3 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                />
                <div className="flex items-center gap-3 text-xs text-slate-700 dark:text-slate-300">
                  <span>Process Rating: {revRating}/5</span>
                  <input
                    type="range"
                    min={1}
                    max={5}
                    value={revRating}
                    onChange={(e) => setRevRating(Number(e.target.value))}
                    className="flex-1 accent-blue-600"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowNewReview(false)}
                  className="px-3 py-1.5 text-xs rounded-md border border-slate-300 dark:border-slate-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 text-xs font-medium rounded-md bg-slate-900 dark:bg-blue-600 text-white"
                >
                  Save Review
                </button>
              </div>
            </form>
          )}

          <div className="space-y-4">
            {periodicReviews.map((rev) => (
              <article
                key={rev.id}
                className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-xs text-slate-500 dark:text-slate-400 capitalize">
                      {rev.periodType} Review · {rev.startDate} to {rev.endDate}
                    </p>
                    <h3 className="font-display text-base font-bold text-slate-900 dark:text-slate-100">
                      {rev.periodLabel}
                    </h3>
                  </div>
                  <span className="font-mono text-xs font-semibold text-slate-700 dark:text-slate-300">
                    Process Rating: {rev.rating}/5
                  </span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs text-slate-600 dark:text-slate-300 pt-2 border-t border-slate-100 dark:border-slate-800">
                  <div>
                    <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Lessons Learned</p>
                    <p className="mt-1 leading-relaxed">{rev.lessonsLearned}</p>
                  </div>
                  <div>
                    <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Goals Next Period</p>
                    <p className="mt-1 leading-relaxed">{rev.goalsNextPeriod}</p>
                  </div>
                  <div>
                    <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                      Psychological Triggers
                    </p>
                    <p className="mt-1 leading-relaxed">{rev.psychologicalTriggers}</p>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
