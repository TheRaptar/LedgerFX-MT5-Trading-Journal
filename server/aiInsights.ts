import { GoogleGenAI, Type } from '@google/genai';
import type {
  AIInsightItem,
  AIInsightsResponse,
  ClosedTrade,
  DailyJournalEntry,
  UserSettings,
} from '../src/shared/types.ts';
import type { ComputedMetrics } from '../src/shared/metricsEngine.ts';
import { formatCurrency } from '../src/shared/timeUtils.ts';

const DISCLAIMER_TEXT =
  'AI analysis is based strictly on historical patterns in your personal trading journal and is for retrospective self-review only — it is not financial advice or a trading signal. Past performance does not guarantee future results, and statistical observations may be affected by small sample sizes, outliers, or market regime changes.';

export async function generateGeminiTradingInsights(
  trades: ClosedTrade[],
  dailyJournals: DailyJournalEntry[],
  metrics: ComputedMetrics,
  settings: UserSettings,
  focusArea?: string,
): Promise<AIInsightsResponse> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error(
      'GEMINI_API_KEY is not configured. Please add your Gemini API key in Settings > Secrets to run AI-driven retrospective analysis.',
    );
  }

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  const compactTrades = trades.slice(0, 60).map((t) => ({
    positionId: t.positionId,
    symbol: t.symbol,
    direction: t.direction,
    volume: t.totalVolume,
    netProfit: t.netProfit,
    commission: t.commission,
    swap: t.swap,
    rMultiple: t.rMultiple,
    durationMinutes: t.durationMinutes,
    session: t.session,
    isPartial: t.isPartial,
    closeDate: t.closeTimeUtc.slice(0, 10),
    strategy: t.journal?.strategy || 'Untagged',
    emotions: t.journal?.emotions || '',
    mistakes: t.journal?.mistakes || '',
  }));

  const compactDaily = dailyJournals.slice(0, 20).map((d) => ({
    date: d.date,
    mood: d.mood,
    discipline: d.discipline,
    stress: d.stress,
    confidence: d.confidence,
    lessons: d.lessons,
  }));

  const summaryContext = {
    currency: settings.baseCurrency,
    totalTrades: metrics.totalTrades,
    winRate: metrics.winRate.formatted,
    profitFactor: metrics.profitFactor.formatted,
    expectancy: metrics.expectancy.formatted,
    averageR: metrics.averageR.formatted,
    maxDrawdown: metrics.maxDrawdown.formatted,
    totalCosts: formatCurrency(metrics.totalCosts, settings),
    symbolBreakdown: metrics.symbolBreakdown,
    strategyBreakdown: metrics.strategyBreakdown,
    sessionBreakdown: metrics.sessionBreakdown,
    trades: compactTrades,
    dailyPsychology: compactDaily,
  };

  const prompt = [
    'Analyse the following personal Forex MT5 trading journal data in British English.',
    focusArea ? `Special focus requested by trader: ${focusArea}` : '',
    'Produce 4 to 6 concrete, evidence-backed retrospective observations covering strengths, leaks, risk/payoff asymmetry, trading costs, or behavioural/psychology correlations.',
    'Every single insight MUST cite exact numeric positionId values from the provided trades array in evidenceTradeIds and state concrete numbers from the dataset.',
    'Do NOT give forward-looking buy/sell signals or financial advice; frame everything as retrospective self-review.',
    JSON.stringify(summaryContext),
  ]
    .filter(Boolean)
    .join('\n\n');

  const response = await ai.models.generateContent({
    model: 'gemini-4-hydrogen',
    contents: prompt,
    config: {
      systemInstruction:
        'You are a quantitative trading performance reviewer helping a single trader audit their own historical MetaTrader 5 journal. Use British English (optimise, favour, analyse, realised). Never invent trade IDs or numbers not present in the input.',
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          overallObservation: {
            type: Type.STRING,
            description: '2-3 sentence executive summary of historical trading performance.',
          },
          insights: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING },
                category: {
                  type: Type.STRING,
                  description:
                    'One of: Performance Pattern, Risk & Drawdown, Behaviour & Psychology, Execution & Costs',
                },
                severity: {
                  type: Type.STRING,
                  description: 'One of: positive, caution, critical, neutral',
                },
                summary: { type: Type.STRING },
                evidenceTradeIds: {
                  type: Type.ARRAY,
                  items: { type: Type.INTEGER },
                },
                supportingMetric: { type: Type.STRING },
                actionableReflection: { type: Type.STRING },
              },
              required: [
                'title',
                'category',
                'severity',
                'summary',
                'evidenceTradeIds',
                'supportingMetric',
                'actionableReflection',
              ],
            },
          },
        },
        required: ['overallObservation', 'insights'],
      },
    },
  });

  const rawText = (response.text ?? '{}').trim();
  const parsed = JSON.parse(rawText) as {
    overallObservation: string;
    insights: AIInsightItem[];
  };

  const validPosIds = new Set(trades.map((t) => t.positionId));
  const sanitisedInsights = (parsed.insights ?? []).map((item) => ({
    ...item,
    evidenceTradeIds: (item.evidenceTradeIds ?? []).filter((id) => validPosIds.has(id)),
  }));

  return {
    generatedAtUtc: new Date().toISOString(),
    model: 'gemini-4-hydrogen',
    disclaimer: DISCLAIMER_TEXT,
    sampleSize: trades.length,
    overallObservation: parsed.overallObservation || 'Retrospective journal audit completed.',
    insights: sanitisedInsights,
  };
}
