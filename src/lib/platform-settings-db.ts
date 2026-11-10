// The platform settings read lives on its own so the app's entry chunk (the
// provider wraps every page, public ones too) does not pull in all of db.ts.
import { supabase } from './supabase';
import type { AnnotationSize } from './types';
import { normalizeEntityHighlightStyle, type EntityHighlightStyle } from './entity-highlight-styles';
import { DEFAULT_BENCHMARK_CONFIG, resolveBenchmarkConfig, type BenchmarkConfig } from './benchmarks';
import { mergeCoreFlowRecommendations, type CoreFlowRecommendations } from './core-flow-recommendations';

export type PlatformSettings = {
  annotation_size: AnnotationSize;
  annotations_expanded: boolean;
  entity_highlight_style: EntityHighlightStyle;
  benchmarks: BenchmarkConfig;
  core_flow_recommendations: CoreFlowRecommendations;
};

// Only the columns read below.
const PLATFORM_SETTINGS_COLUMNS =
  'annotation_size,annotations_expanded,entity_highlight_style,benchmarks,core_flow_recommendations';

export async function getPlatformSettings(): Promise<PlatformSettings> {
  const { data, error } = await supabase
    .from('platform_settings')
    .select(PLATFORM_SETTINGS_COLUMNS)
    .eq('id', 'default')
    .single();

  const defaults: PlatformSettings = {
    annotation_size: 'md',
    annotations_expanded: false,
    entity_highlight_style: 'purple',
    benchmarks: { ...DEFAULT_BENCHMARK_CONFIG },
    core_flow_recommendations: mergeCoreFlowRecommendations(),
  };

  if (error || !data) return defaults;
  const row = data as Record<string, unknown>;

  return {
    annotation_size: (row.annotation_size || defaults.annotation_size) as AnnotationSize,
    annotations_expanded: (row.annotations_expanded as boolean | null) ?? defaults.annotations_expanded,
    entity_highlight_style: normalizeEntityHighlightStyle(row.entity_highlight_style ?? defaults.entity_highlight_style),
    benchmarks: resolveBenchmarkConfig(row.benchmarks as Partial<BenchmarkConfig> | null),
    core_flow_recommendations: mergeCoreFlowRecommendations(
      row.core_flow_recommendations as Partial<CoreFlowRecommendations> | null,
    ),
  };
}
