import type { ReactNode } from 'react';
import type { FlowPerformance, KlaviyoFlowSnapshot } from '../../lib/types';
import { isNonRevenueFlow } from '../../lib/revenue-calculator';
import type { FlowsHealthBenchmarks } from '../../lib/report-config/types';
import {
  classifyRate,
  buildFlowsHealthBenchmarks,
  DEFAULT_FLOWS_HEALTH_BENCHMARKS,
  formatHealthyBenchmarkRange,
  formatPctDecimal,
} from '../../lib/benchmarks';
import { formatStatusBadgeLabel } from '../../lib/benchmark-ui';
import { usePlatformSettings } from '../../contexts/PlatformSettingsContext';

interface Props {
  snapshots: KlaviyoFlowSnapshot[];
  performance: FlowPerformance[];
  segmentCount?: number;
  title?: ReactNode;
  subtitle?: ReactNode;
  benchmarks?: FlowsHealthBenchmarks;
}

interface Category {
  name: string;
  /** null: not enough data to score; left out of the total. */
  score: number | null;
  maxScore: number;
  assessment: string;
}

const ESSENTIAL_FLOW_PATTERNS = [
  { label: 'Welcome', patterns: ['welcome', 'onboard'] },
  // Cart or checkout abandonment only; "Browse Abandonment" must not count here.
  { label: 'Abandoned Cart', patterns: ['\\bcart', 'checkout'] },
  { label: 'Browse Abandonment', patterns: ['browse'] },
  { label: 'Post-Purchase', patterns: ['post.?purchase', 'thank', 'order.?confirm', 'post.?buy'] },
  { label: 'Winback', patterns: ['winback', 'win.?back', 're.?engage', 'sunset', 'lapsed'] },
];

const NOT_ENOUGH_DATA = 'Not enough data';

function flowNameMatchesAny(name: string, patterns: string[]): boolean {
  const lower = name.toLowerCase();
  return patterns.some(p => new RegExp(p, 'i').test(lower));
}

const DEFAULT_BENCHMARKS: Required<FlowsHealthBenchmarks> = {
  ...DEFAULT_FLOWS_HEALTH_BENCHMARKS,
  revenueTiers: [...DEFAULT_FLOWS_HEALTH_BENCHMARKS.revenueTiers],
};

function resolveBenchmarks(overrides?: FlowsHealthBenchmarks): Required<FlowsHealthBenchmarks> {
  return {
    openRateLow: overrides?.openRateLow ?? DEFAULT_BENCHMARKS.openRateLow,
    openRateHigh: overrides?.openRateHigh ?? DEFAULT_BENCHMARKS.openRateHigh,
    clickRateLow: overrides?.clickRateLow ?? DEFAULT_BENCHMARKS.clickRateLow,
    clickRateHigh: overrides?.clickRateHigh ?? DEFAULT_BENCHMARKS.clickRateHigh,
    revenueTiers: overrides?.revenueTiers?.length ? overrides.revenueTiers : DEFAULT_BENCHMARKS.revenueTiers,
  };
}

function computeCategories(
  snapshots: KlaviyoFlowSnapshot[],
  performance: FlowPerformance[],
  segmentCount: number,
  benchmarks: Required<FlowsHealthBenchmarks>,
  accountConvLow: number,
  accountConvHigh: number,
): Category[] {
  const revenueFlows = performance.filter(f => !isNonRevenueFlow(f.flow_name));
  const totalRecipients = performance.reduce((s, f) => s + f.recipients_per_month, 0);
  const totalRevenue = revenueFlows.reduce((s, f) => s + f.monthly_revenue_current, 0);
  const annualRevenue = totalRevenue * 12;

  // No recipients means no measured rates: those pillars show "not enough data".
  const hasRateData = totalRecipients > 0;
  const weightedOpen = hasRateData
    ? performance.reduce((s, f) => s + (f.actual_open_rate ?? 0) * f.recipients_per_month, 0) / totalRecipients : 0;
  const weightedClick = hasRateData
    ? performance.reduce((s, f) => s + (f.actual_click_rate ?? 0) * f.recipients_per_month, 0) / totalRecipients : 0;
  const revFlowRecipients = revenueFlows.reduce((s, f) => s + f.recipients_per_month, 0);
  const hasConvData = revFlowRecipients > 0;
  const weightedConv = hasConvData
    ? revenueFlows.reduce((s, f) => s + (f.actual_conv_rate ?? 0) * f.recipients_per_month, 0) / revFlowRecipients : 0;

  const allNames = snapshots.map(f => f.name);
  // Coverage counts live flows only; drafts and paused flows send nothing.
  const liveNames = snapshots.filter(f => f.status?.toLowerCase() === 'live').map(f => f.name);
  const essentialPresent = ESSENTIAL_FLOW_PATTERNS.filter(e =>
    liveNames.some(n => flowNameMatchesAny(n, e.patterns))
  );

  const total = snapshots.length;
  const inactive = snapshots.filter(f => ['draft', 'paused'].includes(f.status?.toLowerCase())).length;
  const inactiveRatio = total > 0 ? inactive / total : 0;

  const postPurchasePatterns = ['post.?purchase', 'thank', 'order.?confirm', 'post.?buy', 'replenish'];
  const hasLivePostPurchase = liveNames.some(n => flowNameMatchesAny(n, postPurchasePatterns));
  const hasInactivePostPurchase = !hasLivePostPurchase && allNames.some(n => flowNameMatchesAny(n, postPurchasePatterns));

  const categories: Category[] = [];

  const tiersSorted = [...benchmarks.revenueTiers].sort((a, b) => b.min - a.min);
  const tierIndex = tiersSorted.findIndex(t => annualRevenue >= t.min);
  const matchedTier = tierIndex >= 0 ? tiersSorted[tierIndex] : null;
  const revScore = matchedTier
    ? Math.max(1, Math.round(((tiersSorted.length - tierIndex) / tiersSorted.length) * 10))
    : 1;
  const moderateThreshold = tiersSorted[Math.min(2, tiersSorted.length - 1)]?.min ?? 200_000;
  const weakThreshold = tiersSorted[Math.min(3, tiersSorted.length - 1)]?.min ?? 100_000;
  categories.push({
    name: 'Revenue Generation',
    score: hasRateData ? revScore : null, maxScore: 10,
    assessment: !hasRateData
      ? NOT_ENOUGH_DATA
      : matchedTier?.label
      ? `${matchedTier.label} flow revenue`
      : `${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(annualRevenue)} is ${annualRevenue < weakThreshold ? '20-35%' : '50-70%'} of expected`,
  });
  void moderateThreshold;

  // Flow Coverage (0-10)
  const coverageScore = Math.min(10, Math.round((essentialPresent.length / ESSENTIAL_FLOW_PATTERNS.length) * 10));
  const missing = ESSENTIAL_FLOW_PATTERNS.filter(e => !liveNames.some(n => flowNameMatchesAny(n, e.patterns))).map(e => e.label.toLowerCase());
  categories.push({
    name: 'Flow Coverage',
    score: coverageScore, maxScore: 10,
    assessment: missing.length === 0 ? 'All essential flows live' : `Missing or not live: ${missing.join(', ')}`,
  });

  // Conversion Rates (0-10)
  let convScore = 0;
  if (weightedConv >= accountConvHigh * 1.5) convScore = 10;
  else if (weightedConv >= accountConvHigh) convScore = 7;
  else if (weightedConv >= accountConvLow) convScore = 5;
  else if (weightedConv >= accountConvLow * 0.7) convScore = 3;
  else convScore = 1;
  const convStatus = classifyRate(weightedConv, accountConvLow, accountConvHigh);
  categories.push({
    name: 'Conversion Rates',
    score: hasConvData ? convScore : null, maxScore: 10,
    assessment: !hasConvData ? NOT_ENOUGH_DATA : `${formatPctDecimal(weightedConv)} overall · ${formatHealthyBenchmarkRange(accountConvLow, accountConvHigh)} · ${formatStatusBadgeLabel(convStatus, 'higher')}`,
  });

  const clickLow = benchmarks.clickRateLow;
  const clickHigh = benchmarks.clickRateHigh;
  let clickScore = 0;
  if (weightedClick >= clickHigh) clickScore = 10;
  else if (weightedClick >= (clickLow + clickHigh) / 2) clickScore = 7;
  else if (weightedClick >= clickLow) clickScore = 5;
  else if (weightedClick >= clickLow / 2) clickScore = 3;
  else clickScore = 1;
  const clickStatus = classifyRate(weightedClick, clickLow, clickHigh);
  categories.push({
    name: 'Click-Through Rates',
    score: hasRateData ? clickScore : null, maxScore: 10,
    assessment: !hasRateData ? NOT_ENOUGH_DATA : `${formatPctDecimal(weightedClick)} avg · ${formatHealthyBenchmarkRange(clickLow, clickHigh)} · ${formatStatusBadgeLabel(clickStatus, 'higher')}`,
  });

  const openLow = benchmarks.openRateLow;
  const openHigh = benchmarks.openRateHigh;
  let openScore = 0;
  if (weightedOpen >= openHigh + 0.05) openScore = 10;
  else if (weightedOpen >= openHigh) openScore = 8;
  else if (weightedOpen >= openLow) openScore = 6;
  else if (weightedOpen >= openLow - 0.10) openScore = 4;
  else openScore = 2;
  const openStatus = classifyRate(weightedOpen, openLow, openHigh);
  categories.push({
    name: 'Open Rates',
    score: hasRateData ? openScore : null, maxScore: 10,
    assessment: !hasRateData
      ? NOT_ENOUGH_DATA
      : weightedOpen >= openHigh
      ? `${formatPctDecimal(weightedOpen)} avg · ${formatHealthyBenchmarkRange(openLow, openHigh)} — likely inflated by Apple MPP`
      : `${formatPctDecimal(weightedOpen)} avg · ${formatHealthyBenchmarkRange(openLow, openHigh)} · ${formatStatusBadgeLabel(openStatus, 'higher')}`,
  });

  // Flow Hygiene (0-10)
  // No flows at all is not clean hygiene.
  let hygieneScore = 10;
  if (total === 0) hygieneScore = 0;
  else if (inactiveRatio > 0.6) hygieneScore = 1;
  else if (inactiveRatio > 0.4) hygieneScore = 2;
  else if (inactiveRatio > 0.3) hygieneScore = 4;
  else if (inactiveRatio > 0.2) hygieneScore = 6;
  else if (inactiveRatio > 0.1) hygieneScore = 8;
  categories.push({
    name: 'Flow Hygiene',
    score: hygieneScore, maxScore: 10,
    assessment: total === 0
      ? 'No flows found'
      : inactiveRatio > 0.3 ? `${Math.round(inactiveRatio * 100)}% inactive, dead flows hurting deliverability` : `${Math.round(inactiveRatio * 100)}% inactive, acceptable`,
  });

  // Post-Purchase (0-10)
  categories.push({
    name: 'Post-Purchase',
    score: hasLivePostPurchase ? 10 : hasInactivePostPurchase ? 3 : 0, maxScore: 10,
    assessment: hasLivePostPurchase
      ? 'Live post-purchase flow in place'
      : hasInactivePostPurchase
        ? 'Flow exists but is not live'
        : 'No active flow at all',
  });

  // Segmentation (0-10)
  let segScore = 0;
  if (segmentCount >= 20) segScore = 10;
  else if (segmentCount >= 10) segScore = 6;
  else if (segmentCount >= 5) segScore = 4;
  else if (segmentCount >= 1) segScore = 2;
  categories.push({
    name: 'Segmentation',
    score: segScore, maxScore: 10,
    assessment: segmentCount >= 10 ? 'Complex system exists, execution needs work' : `${segmentCount} segments, needs expansion`,
  });

  return categories;
}

function scoreColor(score: number | null, max: number): string {
  if (score == null) return 'bg-gray-300';
  const pct = score / max;
  if (pct >= 0.7) return 'bg-emerald-500';
  if (pct >= 0.4) return 'bg-amber-400';
  return 'bg-red-400';
}

function overallLabel(score: number): { text: string; color: string } {
  if (score >= 75) return { text: 'Excellent', color: 'text-emerald-600' };
  if (score >= 55) return { text: 'Good', color: 'text-emerald-600' };
  if (score >= 35) return { text: 'Fair', color: 'text-amber-600' };
  return { text: 'Needs Major Work', color: 'text-red-500' };
}

function overallRingColor(score: number): string {
  if (score >= 75) return 'stroke-emerald-500';
  if (score >= 55) return 'stroke-emerald-400';
  if (score >= 35) return 'stroke-amber-400';
  return 'stroke-red-400';
}

export default function ReportFlowHealthScore({
  snapshots,
  performance,
  segmentCount = 0,
  title = 'Overall Flow Health Score',
  subtitle,
  benchmarks,
}: Props) {
  const { benchmarks: platformBenchmarks } = usePlatformSettings();
  const resolvedBenchmarks = resolveBenchmarks({
    ...buildFlowsHealthBenchmarks(platformBenchmarks),
    ...benchmarks,
  });
  const categories = computeCategories(
    snapshots,
    performance,
    segmentCount,
    resolvedBenchmarks,
    platformBenchmarks.accountConvLow,
    platformBenchmarks.accountConvHigh,
  );
  // Pillars without data are left out of both the score and the max.
  const scored = categories.filter(c => c.score != null);
  const totalScore = scored.reduce((s, c) => s + (c.score ?? 0), 0);
  const maxTotal = scored.reduce((s, c) => s + c.maxScore, 0);
  const overall = maxTotal > 0 ? Math.round((totalScore / maxTotal) * 100) : 0;
  const label = overallLabel(overall);

  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (overall / 100) * circumference;

  return (
    <div>
      <h3 className="text-lg font-bold text-gray-900 mb-1">{title ?? 'Overall Flow Health Score'}</h3>
      {subtitle ? <p className="text-sm text-gray-500 mb-4">{subtitle}</p> : null}
      {!subtitle && <div className="mb-5" />}
      <div className="flex flex-col lg:flex-row gap-8 items-start">
        <div className="flex flex-col items-center shrink-0">
          <div className="relative w-36 h-36">
            <svg viewBox="0 0 120 120" className="w-full h-full -rotate-90">
              <circle cx="60" cy="60" r={radius} fill="none" stroke="#f3f4f6" strokeWidth="10" />
              <circle
                cx="60" cy="60" r={radius} fill="none"
                className={overallRingColor(overall)}
                strokeWidth="10"
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={dashOffset}
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className={`text-3xl font-extrabold ${label.color}`}>{overall}</span>
              <span className="text-xs text-gray-400">/ 100</span>
            </div>
          </div>
          <p className={`text-sm font-bold mt-2 ${label.color}`}>{label.text}</p>
        </div>

        <div className="flex-1 w-full">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100">
                <th className="py-2 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider pl-2">Category</th>
                <th className="py-2 text-center text-xs font-semibold text-gray-400 uppercase tracking-wider w-20">Score</th>
                <th className="py-2 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">Assessment</th>
              </tr>
            </thead>
            <tbody>
              {categories.map(c => (
                <tr key={c.name} className="border-b border-gray-50">
                  <td className="py-2.5 pl-2">
                    <div className="flex items-center gap-2">
                      <span className={`w-2.5 h-2.5 rounded-full ${scoreColor(c.score, c.maxScore)} shrink-0`} />
                      <span className="font-medium text-gray-800">{c.name}</span>
                    </div>
                  </td>
                  <td className="py-2.5 text-center font-semibold text-gray-700">{c.score == null ? 'n/a' : `${c.score} / ${c.maxScore}`}</td>
                  <td className="py-2.5 text-gray-500 text-xs">{c.assessment}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
