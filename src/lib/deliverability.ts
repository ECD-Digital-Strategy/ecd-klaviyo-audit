import { SPAM_BENCHMARK } from './benchmarks';

export type DeliverabilitySnapshot = {
  timeframe: 'last_30_days';
  open_rate: number | null;
  click_rate: number | null;
  bounce_rate: number | null;
  unsubscribe_rate: number | null;
  spam_complaint_rate: number | null;
  recipients: number;
};

export type DeliverabilityMetricKey =
  | 'open_rate'
  | 'click_rate'
  | 'bounce_rate'
  | 'unsubscribe_rate'
  | 'spam_complaint_rate';

export type DeliverabilityThreshold = {
  key: DeliverabilityMetricKey;
  label: string;
  direction: 'higher' | 'lower';
  recommended: number;
  recommendedLabel: string;
  /** Rate at or beyond which metric scores 0 */
  bad: number;
  weight: number;
};

/** Klaviyo Analytics > Deliverability recommended thresholds */
export const KLAVIYO_DELIVERABILITY_THRESHOLDS: DeliverabilityThreshold[] = [
  {
    key: 'open_rate',
    label: 'Open rate',
    direction: 'higher',
    recommended: 0.33,
    recommendedLabel: 'greater than 33.0%',
    bad: 0.15,
    weight: 0.2,
  },
  {
    key: 'click_rate',
    label: 'Click rate',
    direction: 'higher',
    recommended: 0.012,
    recommendedLabel: 'greater than 1.20%',
    bad: 0.003,
    weight: 0.1,
  },
  {
    key: 'bounce_rate',
    label: 'Bounce rate',
    direction: 'lower',
    recommended: 0.01,
    recommendedLabel: 'less than 1.00%',
    bad: 0.05,
    weight: 0.25,
  },
  {
    key: 'unsubscribe_rate',
    label: 'Unsubscribe rate',
    direction: 'lower',
    recommended: 0.003,
    recommendedLabel: 'less than 0.30%',
    bad: 0.01,
    weight: 0.2,
  },
  {
    key: 'spam_complaint_rate',
    label: 'Spam complaint rate',
    direction: 'lower',
    // Same bands as the platform spam benchmark: 0.1% target, 0.3% Google/Yahoo max.
    recommended: SPAM_BENCHMARK.healthyMax,
    recommendedLabel: 'less than 0.10%',
    bad: SPAM_BENCHMARK.warningMax,
    weight: 0.25,
  },
];

export type DeliverabilityGrade = 'Good' | 'Fair' | 'Needs Work' | 'Poor';

export type DeliverabilityScoreResult = {
  score: number;
  grade: DeliverabilityGrade;
  gradeClassName: string;
  ringClassName: string;
  scoreTextClassName: string;
};

function metricScore(rate: number | null | undefined, threshold: DeliverabilityThreshold): number | null {
  if (rate == null || !Number.isFinite(rate)) return null;
  const { recommended, bad, direction } = threshold;
  if (direction === 'higher') {
    if (rate >= recommended) return 1;
    if (rate <= bad) return 0;
    return (rate - bad) / (recommended - bad);
  }
  if (rate <= recommended) return 1;
  if (rate >= bad) return 0;
  return (bad - rate) / (bad - recommended);
}

export function meetsRecommended(
  rate: number | null | undefined,
  threshold: DeliverabilityThreshold,
): boolean | null {
  if (rate == null || !Number.isFinite(rate)) return null;
  return threshold.direction === 'higher'
    ? rate > threshold.recommended
    : rate < threshold.recommended;
}

export function computeDeliverabilityScore(
  snapshot: DeliverabilitySnapshot,
): DeliverabilityScoreResult {
  let weightedSum = 0;
  let weightTotal = 0;
  for (const t of KLAVIYO_DELIVERABILITY_THRESHOLDS) {
    const s = metricScore(snapshot[t.key], t);
    if (s == null) continue;
    weightedSum += s * t.weight;
    weightTotal += t.weight;
  }
  const raw = weightTotal > 0 ? weightedSum / weightTotal : 0;
  const score = Math.round(raw * 100);

  if (score >= 80) {
    return {
      score,
      grade: 'Good',
      gradeClassName: 'bg-emerald-100 text-emerald-800',
      ringClassName: 'stroke-emerald-500',
      scoreTextClassName: 'text-emerald-600',
    };
  }
  if (score >= 60) {
    return {
      score,
      grade: 'Fair',
      gradeClassName: 'bg-amber-100 text-amber-800',
      ringClassName: 'stroke-amber-400',
      scoreTextClassName: 'text-amber-600',
    };
  }
  if (score >= 40) {
    return {
      score,
      grade: 'Needs Work',
      gradeClassName: 'bg-orange-100 text-orange-800',
      ringClassName: 'stroke-orange-400',
      scoreTextClassName: 'text-orange-600',
    };
  }
  return {
    score,
    grade: 'Poor',
    gradeClassName: 'bg-red-100 text-red-800',
    ringClassName: 'stroke-red-400',
    scoreTextClassName: 'text-red-500',
  };
}

/** Format a rate stored as 0-1 fraction for display (handles tiny spam rates). */
export function formatDeliverabilityRate(rate: number | null | undefined): string {
  if (rate == null || !Number.isFinite(rate)) return '—';
  const pct = rate * 100;
  if (pct > 0 && pct < 0.01) return `${pct.toFixed(3)}%`;
  if (pct < 1) return `${pct.toFixed(2)}%`;
  return `${pct.toFixed(1)}%`;
}
