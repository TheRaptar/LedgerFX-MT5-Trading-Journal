import React, { useState } from 'react';
import { Lock, ShieldCheck, ArrowRight, Eye, EyeOff } from 'lucide-react';
import { api, setAuthToken, type AuthStatusResponse } from '../lib/api.ts';

interface AuthGateProps {
  status: AuthStatusResponse;
  onAuthenticated: () => void;
}

export function AuthGate({ status, onAuthenticated }: AuthGateProps) {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isSetup = !status.initialized && !status.envProtected;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (isSetup) {
      if (password.length < 8) {
        setError('Please choose a vault password of at least 8 characters.');
        return;
      }
      if (password !== confirmPassword) {
        setError('Passwords do not match.');
        return;
      }
    } else if (!password) {
      setError('Please enter your vault password.');
      return;
    }

    setSubmitting(true);
    try {
      const res = isSetup ? await api.setupVault(password) : await api.login(password);
      setAuthToken(res.token);
      setPassword('');
      setConfirmPassword('');
      onAuthenticated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to unlock journal.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-8">
        <div className="mb-6">
          <div className="flex items-center gap-2.5 text-slate-900 dark:text-slate-100 mb-2">
            <div className="w-9 h-9 rounded-lg bg-slate-900 dark:bg-blue-600 text-white flex items-center justify-center shrink-0">
              <Lock className="w-4 h-4" aria-hidden="true" />
            </div>
            <span className="font-display text-xl font-bold tracking-tight">LedgerFX</span>
          </div>
          <h1 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100 mt-4 text-balance">
            {isSetup ? 'Create Your Personal Vault Password' : 'Unlock Your MT5 Trading Journal'}
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1.5 leading-relaxed">
            {isSetup
              ? 'Set an owner password to protect your private MetaTrader 5 trade history, encrypted credentials, and daily psychology notes.'
              : 'Enter your personal vault password to access your synchronised MT5 accounts and trading analytics.'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="vault-password"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
            >
              {isSetup ? 'New Vault Password (min. 8 characters)' : 'Vault Password'}
            </label>
            <div className="relative">
              <input
                id="vault-password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={isSetup ? 'new-password' : 'current-password'}
                required
                className="w-full px-3.5 py-2.5 pr-10 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                placeholder={isSetup ? 'Enter a strong password' : 'Enter vault password'}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {isSetup && (
            <div>
              <label
                htmlFor="vault-password-confirm"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
              >
                Confirm Vault Password
              </label>
              <input
                id="vault-password-confirm"
                type={showPassword ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
                required
                className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                placeholder="Re-enter vault password"
              />
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="text-xs text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-lg px-3.5 py-2.5"
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium bg-slate-900 hover:bg-slate-800 dark:bg-blue-600 dark:hover:bg-blue-500 text-white transition-colors disabled:opacity-60 whitespace-nowrap"
          >
            <span>{submitting ? 'Verifying...' : isSetup ? 'Create Vault & Enter' : 'Unlock Journal'}</span>
            <ArrowRight className="w-4 h-4" aria-hidden="true" />
          </button>
        </form>

        <div className="mt-6 pt-5 border-t border-slate-200 dark:border-slate-800 space-y-2 text-xs text-slate-500 dark:text-slate-400">
          <div className="flex items-start gap-2">
            <ShieldCheck className="w-4 h-4 text-slate-600 dark:text-slate-400 shrink-0 mt-0.5" aria-hidden="true" />
            <p className="leading-relaxed">
              Personal-use single-owner portal. All trade history and notes are stored locally on your
              server in SQLite, MT5 read-only credentials are encrypted at rest with AES-256-GCM, and
              session tokens remain strictly in memory.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
