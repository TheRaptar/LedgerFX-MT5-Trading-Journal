import React, { useState } from 'react';
import { Info } from 'lucide-react';
import type { MetricWithExplanation } from '../shared/metricsEngine.ts';

interface MetricTooltipProps {
  metric: MetricWithExplanation;
}

export function MetricTooltip({ metric }: MetricTooltipProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative inline-flex items-center">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        onBlur={() => setTimeout(() => setOpen(false), 180)}
        aria-label={`Calculation details for ${metric.label}`}
        aria-expanded={open}
        className="p-1 text-slate-400 hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-200 rounded focus-visible:outline-2 focus-visible:outline-blue-600 transition-colors"
      >
        <Info className="w-3.5 h-3.5" aria-hidden="true" />
      </button>
      {open && (
        <div
          role="tooltip"
          className="absolute right-0 top-full mt-1.5 z-40 w-72 p-3.5 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-lg text-left"
        >
          <p className="text-xs font-semibold text-slate-900 dark:text-slate-100">{metric.label}</p>
          <p className="text-xs text-slate-600 dark:text-slate-300 mt-1 leading-relaxed">
            {metric.definition}
          </p>
          <div className="mt-2 pt-2 border-t border-slate-100 dark:border-slate-800 space-y-1">
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              Formula: <span className="font-medium text-slate-700 dark:text-slate-200">{metric.formulaLabel}</span>
            </p>
            <p className="text-[11px] font-mono tabular-nums text-slate-700 dark:text-slate-200 break-words">
              {metric.exactCalculation}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
