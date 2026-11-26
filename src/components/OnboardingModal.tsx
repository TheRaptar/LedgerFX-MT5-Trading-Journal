import React, { useState } from 'react';
import { X, ChevronRight, ChevronLeft } from 'lucide-react';

interface OnboardingModalProps {
  open: boolean;
  onClose: () => void;
}

const STEPS = [
  {
    title: '01. Read-Only MetaTrader 5 Synchronisation',
    body: 'LedgerFX connects strictly in read-only mode — it never places, modifies, or cancels orders. Link your MT5 accounts via an encrypted HTTPS Python Bridge, upload MT5 CSV deal exports, or verify with the built-in sandbox accounts. Credentials are encrypted at rest with AES-256-GCM and never exposed to the browser.',
  },
  {
    title: '02. Position-ID Deal Grouping & Partial Fills',
    body: 'In MetaTrader 5, scaling in or taking partial profits creates multiple deal tickets sharing a single Position ID. LedgerFX automatically aggregates all fills under one trade row with volume-weighted entry and exit prices, net P/L (including commissions and swaps), and expandable fill-level logs. Deposits and withdrawals are plotted on your equity curve without distorting win rate.',
  },
  {
    title: '03. Transparent Metrics, Daily Psychology & AI Audit',
    body: 'Click the info icon next to any metric to inspect its formal definition and exact live calculation. Log daily mood, stress, and discipline alongside your trades, then run retrospective AI Insights to surface evidence-backed patterns citing specific Position IDs.',
  },
];

export function OnboardingModal({ open, onClose }: OnboardingModalProps) {
  const [stepIndex, setStepIndex] = useState(0);

  if (!open) return null;
  const current = STEPS[stepIndex];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
    >
      <div className="w-full max-w-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
              Portal Guide · Step {stepIndex + 1} of {STEPS.length}
            </p>
            <h2
              id="onboarding-title"
              className="font-display text-lg font-bold text-slate-900 dark:text-slate-100 mt-1"
            >
              {current.title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close portal guide"
            className="p-1.5 rounded-md text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-sm text-slate-600 dark:text-slate-300 mt-4 leading-relaxed">
          {current.body}
        </p>

        <div className="flex items-center justify-between mt-6 pt-4 border-t border-slate-200 dark:border-slate-800">
          <button
            type="button"
            disabled={stepIndex === 0}
            onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 disabled:opacity-40 hover:text-slate-900 dark:hover:text-white whitespace-nowrap"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
            Previous
          </button>

          {stepIndex < STEPS.length - 1 ? (
            <button
              type="button"
              onClick={() => setStepIndex((i) => i + 1)}
              className="inline-flex items-center gap-1 px-4 py-2 text-xs font-medium rounded-md bg-slate-900 dark:bg-blue-600 text-white hover:bg-slate-800 dark:hover:bg-blue-500 whitespace-nowrap"
            >
              Next
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium rounded-md bg-slate-900 dark:bg-blue-600 text-white hover:bg-slate-800 dark:hover:bg-blue-500 whitespace-nowrap"
            >
              Start Journalling
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
