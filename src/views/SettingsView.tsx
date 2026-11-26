import React, { useState } from 'react';
import { Save, Shield, Trash2 } from 'lucide-react';
import type { AuditLogEntry, UserSettings } from '../shared/types.ts';
import { AVAILABLE_TIMEZONES } from '../shared/timeUtils.ts';
import { api } from '../lib/api.ts';

interface SettingsViewProps {
  settings: UserSettings;
  auditLogs: AuditLogEntry[];
  onSaveSettings: (next: Partial<UserSettings>) => Promise<void>;
  onRefreshBootstrap: (payload?: unknown) => void;
}

export function SettingsView({
  settings,
  auditLogs,
  onSaveSettings,
  onRefreshBootstrap,
}: SettingsViewProps) {
  const [draft, setDraft] = useState<UserSettings>(settings);
  const [saving, setSaving] = useState(false);
  const [erasing, setErasing] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showPrivacyPolicy, setShowPrivacyPolicy] = useState(false);
  const [confirmErase, setConfirmErase] = useState(false);

  const update = <K extends keyof UserSettings>(key: K, value: UserSettings[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSavedMsg(null);
    setErrorMsg(null);
    try {
      await onSaveSettings(draft);
      setSavedMsg('Preferences saved and applied immediately.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to save preferences.');
    } finally {
      setSaving(false);
    }
  }

  async function handleEraseAll() {
    setErasing(true);
    setSavedMsg(null);
    setErrorMsg(null);
    try {
      const payload = await api.eraseAllData();
      onRefreshBootstrap(payload);
      setConfirmErase(false);
      setSavedMsg('All MT5 accounts, deals, and journal records have been permanently erased.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to erase trading data.');
    } finally {
      setErasing(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="pb-4 border-b border-slate-200 dark:border-slate-800">
        <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-slate-100">
          Settings, Privacy & Audit Log
        </h1>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
          Configure time zones, British English date/currency formats, trading sessions, risk defaults, accessibility, and GDPR controls
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Time Zone, Locale & Currency */}
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-6 space-y-4">
          <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
            Time Zone, Date & Currency Display
          </h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Display Time Zone (DST-Aware)
              </label>
              <select
                value={draft.displayTimeZone}
                onChange={(e) => update('displayTimeZone', e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              >
                {AVAILABLE_TIMEZONES.map((tz) => (
                  <option key={tz.value} value={tz.value}>
                    {tz.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Date Format
              </label>
              <select
                value={draft.dateFormat}
                onChange={(e) => update('dateFormat', e.target.value as 'DD/MM/YYYY' | 'MM/DD/YYYY')}
                className="w-full px-3 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              >
                <option value="DD/MM/YYYY">DD/MM/YYYY (British English)</option>
                <option value="MM/DD/YYYY">MM/DD/YYYY (US)</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Clock Format
              </label>
              <select
                value={draft.timeFormat}
                onChange={(e) => update('timeFormat', e.target.value as '24h' | '12h')}
                className="w-full px-3 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              >
                <option value="24h">24-hour (14:30)</option>
                <option value="12h">12-hour (02:30 pm)</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Base Display Currency
              </label>
              <select
                value={draft.baseCurrency}
                onChange={(e) => {
                  const curr = e.target.value;
                  const sym = curr === 'USD' ? '$' : curr === 'EUR' ? '€' : '£';
                  setDraft((prev) => ({ ...prev, baseCurrency: curr, currencySymbol: sym }));
                }}
                className="w-full px-3 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              >
                <option value="GBP">GBP (£)</option>
                <option value="USD">USD ($)</option>
                <option value="EUR">EUR (€)</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Symbol Position & Decimals
              </label>
              <div className="flex gap-2">
                <select
                  aria-label="Currency symbol position"
                  value={draft.currencyPosition}
                  onChange={(e) => update('currencyPosition', e.target.value as 'prefix' | 'suffix')}
                  className="w-1/2 px-2.5 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                >
                  <option value="prefix">Prefix (£100.00)</option>
                  <option value="suffix">Suffix (100.00 £)</option>
                </select>
                <select
                  aria-label="Decimal places"
                  value={draft.decimalPlaces}
                  onChange={(e) => update('decimalPlaces', Number(e.target.value))}
                  className="w-1/2 px-2.5 py-2 text-xs font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                >
                  <option value={2}>2 decimals</option>
                  <option value={3}>3 decimals</option>
                  <option value={4}>4 decimals</option>
                </select>
              </div>
            </div>

            <div className="flex items-end">
              <label className="inline-flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer pb-2">
                <input
                  type="checkbox"
                  checked={draft.showDualTimeZones}
                  onChange={(e) => update('showDualTimeZones', e.target.checked)}
                  className="rounded border-slate-300 dark:border-slate-700"
                />
                Show dual local & MT5 server timestamps
              </label>
            </div>
          </div>
        </section>

        {/* Risk, Calculation Conventions & Sessions */}
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-6 space-y-4">
          <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
            Risk Calculations, Trading Sessions & Benchmark
          </h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Break-Even Win Rate Convention
              </label>
              <select
                value={draft.breakEvenHandling}
                onChange={(e) =>
                  update('breakEvenHandling', e.target.value as 'exclude' | 'count_total')
                }
                className="w-full px-3 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              >
                <option value="count_total">Include in total trade denominator</option>
                <option value="exclude">Exclude break-even trades from Win Rate</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Default Initial Risk ({draft.currencySymbol})
              </label>
              <input
                type="number"
                min={1}
                value={draft.defaultRiskCurrency}
                onChange={(e) => update('defaultRiskCurrency', Number(e.target.value))}
                className="w-full px-3 py-2 text-xs font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Benchmark Reference (% Return)
              </label>
              <div className="flex gap-2">
                <input
                  value={draft.benchmarkName}
                  onChange={(e) => update('benchmarkName', e.target.value)}
                  className="w-2/3 px-2.5 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                />
                <input
                  type="number"
                  step="0.1"
                  value={draft.benchmarkReturnPct}
                  onChange={(e) => update('benchmarkReturnPct', Number(e.target.value))}
                  className="w-1/3 px-2.5 py-2 text-xs font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                London Session Window (UTC hours)
              </label>
              <div className="flex items-center gap-2 text-xs">
                <input
                  type="number"
                  min={0}
                  max={23}
                  value={draft.sessionWindows.londonStartUtc}
                  onChange={(e) =>
                    update('sessionWindows', {
                      ...draft.sessionWindows,
                      londonStartUtc: Number(e.target.value),
                    })
                  }
                  className="w-1/2 px-2.5 py-2 font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                />
                <span>to</span>
                <input
                  type="number"
                  min={0}
                  max={24}
                  value={draft.sessionWindows.londonEndUtc}
                  onChange={(e) =>
                    update('sessionWindows', {
                      ...draft.sessionWindows,
                      londonEndUtc: Number(e.target.value),
                    })
                  }
                  className="w-1/2 px-2.5 py-2 font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                New York Session Window (UTC hours)
              </label>
              <div className="flex items-center gap-2 text-xs">
                <input
                  type="number"
                  min={0}
                  max={23}
                  value={draft.sessionWindows.newYorkStartUtc}
                  onChange={(e) =>
                    update('sessionWindows', {
                      ...draft.sessionWindows,
                      newYorkStartUtc: Number(e.target.value),
                    })
                  }
                  className="w-1/2 px-2.5 py-2 font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                />
                <span>to</span>
                <input
                  type="number"
                  min={0}
                  max={24}
                  value={draft.sessionWindows.newYorkEndUtc}
                  onChange={(e) =>
                    update('sessionWindows', {
                      ...draft.sessionWindows,
                      newYorkEndUtc: Number(e.target.value),
                    })
                  }
                  className="w-1/2 px-2.5 py-2 font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                />
              </div>
            </div>

            <div className="flex items-end">
              <label className="inline-flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer pb-2">
                <input
                  type="checkbox"
                  checked={draft.includeUnrealisedInDrawdown}
                  onChange={(e) => update('includeUnrealisedInDrawdown', e.target.checked)}
                  className="rounded border-slate-300 dark:border-slate-700"
                />
                Include open unrealised P/L in Max Drawdown
              </label>
            </div>
          </div>
        </section>

        {/* Theme, Accessibility & Notifications */}
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-6 space-y-4">
          <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
            Appearance, Accessibility & Session Controls
          </h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Colour Theme
              </label>
              <select
                value={draft.theme}
                onChange={(e) => update('theme', e.target.value as 'light' | 'dark')}
                className="w-full px-3 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              >
                <option value="light">Light Mode</option>
                <option value="dark">Dark Mode</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Text Size (Accessibility)
              </label>
              <select
                value={draft.fontSize}
                onChange={(e) => update('fontSize', e.target.value as 'sm' | 'md' | 'lg')}
                className="w-full px-3 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              >
                <option value="sm">Compact (14px)</option>
                <option value="md">Standard (15px)</option>
                <option value="lg">Large High-Legibility (17px)</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Vault Idle Timeout (minutes)
              </label>
              <input
                type="number"
                min={5}
                max={480}
                value={draft.sessionTimeoutMinutes}
                onChange={(e) => update('sessionTimeoutMinutes', Number(e.target.value))}
                className="w-full px-3 py-2 text-xs font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Drawdown Alert Threshold (%)
              </label>
              <input
                type="number"
                min={1}
                max={50}
                value={draft.drawdownAlertThresholdPct}
                onChange={(e) => update('drawdownAlertThresholdPct', Number(e.target.value))}
                className="w-full px-3 py-2 text-xs font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-6 text-xs text-slate-700 dark:text-slate-300 pt-1">
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={draft.notifyNewTrade}
                onChange={(e) => update('notifyNewTrade', e.target.checked)}
                className="rounded border-slate-300 dark:border-slate-700"
              />
              Alert when new MT5 deals are synchronised
            </label>
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={draft.notifyDrawdownAlert}
                onChange={(e) => update('notifyDrawdownAlert', e.target.checked)}
                className="rounded border-slate-300 dark:border-slate-700"
              />
              Warn when drawdown exceeds threshold
            </label>
          </div>

          <div className="flex items-center justify-between pt-4 border-t border-slate-200 dark:border-slate-800">
            <div>
              {savedMsg && (
                <p role="status" className="text-xs text-emerald-700 dark:text-emerald-400 font-medium">
                  {savedMsg}
                </p>
              )}
              {errorMsg && (
                <p role="alert" className="text-xs text-red-700 dark:text-red-400 font-medium">
                  {errorMsg}
                </p>
              )}
            </div>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-md bg-slate-900 dark:bg-blue-600 text-white hover:bg-slate-800 dark:hover:bg-blue-500 disabled:opacity-60 whitespace-nowrap"
            >
              <Save className="w-3.5 h-3.5" aria-hidden="true" />
              {saving ? 'Saving...' : 'Save Preferences'}
            </button>
          </div>
        </section>
      </form>

      {/* Privacy Policy & GDPR Data Rights */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-slate-600 dark:text-slate-400" aria-hidden="true" />
            <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
              Privacy Policy & GDPR Data Controls
            </h2>
          </div>
          <button
            type="button"
            onClick={() => setShowPrivacyPolicy((v) => !v)}
            className="text-xs text-blue-700 dark:text-blue-400 hover:underline"
          >
            {showPrivacyPolicy ? 'Hide Privacy Notice' : 'Read Privacy Policy'}
          </button>
        </div>

        <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
          All trading records, journal entries, and daily reflections are stored locally in your
          personal SQLite database and never shared with third-party trackers. MT5 read-only
          credentials are encrypted at rest with AES-256-GCM and never exposed to client logs.
        </p>

        {showPrivacyPolicy && (
          <div className="p-4 rounded-md bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-xs text-slate-600 dark:text-slate-300 space-y-2 leading-relaxed">
            <p>
              <strong>Data Ownership & Local Storage:</strong> LedgerFX is designed as a single-user
              personal trading journal. Your account numbers, deal histories, and notes remain inside
              your own environment.
            </p>
            <p>
              <strong>Read-Only Security:</strong> The portal never submits market or pending orders to
              MetaTrader 5. Investor credentials are encrypted server-side using AES-256-GCM.
            </p>
            <p>
              <strong>AI Analysis Transparency:</strong> Invoking AI Insights sends only anonymised
              aggregate metrics and trade performance figures from your selected scope to the Gemini
              API on demand; credentials and passwords are never transmitted.
            </p>
            <p>
              <strong>UK GDPR / EU GDPR Rights:</strong> You may export a complete machine-readable
              copy of your data at any time from the Reports tab, or permanently erase all stored data
              below.
            </p>
          </div>
        )}

        <div className="pt-2 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs text-slate-600 dark:text-slate-400">
            GDPR Right to Erasure: permanently delete all linked MT5 accounts, deals, and journals.
          </span>
          {!confirmErase ? (
            <button
              type="button"
              onClick={() => setConfirmErase(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-md border border-red-200 dark:border-red-900 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 whitespace-nowrap"
            >
              <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
              Erase All Trading Data
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={erasing}
                onClick={() => setConfirmErase(false)}
                className="px-3 py-1.5 text-xs rounded-md border border-slate-300 dark:border-slate-700"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={erasing}
                onClick={handleEraseAll}
                className="px-3.5 py-1.5 text-xs font-medium rounded-md bg-red-600 hover:bg-red-700 text-white disabled:opacity-60"
              >
                {erasing ? 'Erasing...' : 'Confirm Permanent Erasure'}
              </button>
            </div>
          )}
        </div>
        {errorMsg && (
          <p role="alert" className="text-xs text-red-700 dark:text-red-400 font-medium">
            {errorMsg}
          </p>
        )}
      </section>

      {/* Private Audit Trail */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800">
          <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
            Private Security & Activity Audit Trail ({auditLogs.length})
          </h2>
        </div>
        <div className="overflow-x-auto max-h-72 overflow-y-auto">
          <table className="w-full text-xs text-left">
            <thead className="bg-slate-50 dark:bg-slate-950 text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800">
              <tr>
                <th className="py-2 px-4 font-medium">UTC Time</th>
                <th className="py-2 px-3 font-medium">Action</th>
                <th className="py-2 px-3 font-medium">Entity</th>
                <th className="py-2 px-4 font-medium">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-slate-700 dark:text-slate-300">
              {auditLogs.map((log) => (
                <tr key={log.id}>
                  <td className="py-2 px-4 font-mono tabular-nums text-[11px] whitespace-nowrap text-slate-500 dark:text-slate-400">
                    {log.utcTime.slice(0, 19).replace('T', ' ')}
                  </td>
                  <td className="py-2 px-3 font-mono text-[11px] font-medium">{log.action}</td>
                  <td className="py-2 px-3 whitespace-nowrap">{log.entity}</td>
                  <td className="py-2 px-4">{log.details}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
