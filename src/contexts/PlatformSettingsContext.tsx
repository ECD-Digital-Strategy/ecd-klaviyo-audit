import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { getPlatformSettings } from '../lib/platform-settings-db';
import {
  applyEntityHighlightStyle,
  entityHighlightsEnabled,
  normalizeEntityHighlightStyle,
  type EntityHighlightStyle,
} from '../lib/entity-highlight-styles';
import type { AnnotationSize } from '../lib/types';
import { DEFAULT_BENCHMARK_CONFIG, type BenchmarkConfig } from '../lib/benchmarks';
import {
  mergeCoreFlowRecommendations,
  type CoreFlowRecommendations,
} from '../lib/core-flow-recommendations';

export type PlatformSettingsState = {
  annotation_size: AnnotationSize;
  annotations_expanded: boolean;
  entity_highlight_style: EntityHighlightStyle;
  benchmarks: BenchmarkConfig;
  core_flow_recommendations: CoreFlowRecommendations;
};

const DEFAULT_SETTINGS: PlatformSettingsState = {
  annotation_size: 'md',
  annotations_expanded: false,
  entity_highlight_style: 'purple',
  benchmarks: { ...DEFAULT_BENCHMARK_CONFIG },
  core_flow_recommendations: mergeCoreFlowRecommendations(),
};

type PlatformSettingsContextValue = {
  settings: PlatformSettingsState;
  loaded: boolean;
  benchmarks: BenchmarkConfig;
  entityHighlightStyle: EntityHighlightStyle;
  entityHighlightsEnabled: boolean;
  refreshSettings: () => Promise<void>;
};

const PlatformSettingsContext = createContext<PlatformSettingsContextValue>({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  benchmarks: DEFAULT_BENCHMARK_CONFIG,
  entityHighlightStyle: 'purple',
  entityHighlightsEnabled: true,
  refreshSettings: async () => {},
});

export function PlatformSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<PlatformSettingsState>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  const refreshSettings = useCallback(async () => {
    try {
      const next = await getPlatformSettings();
      setSettings(next);
      applyEntityHighlightStyle(next.entity_highlight_style);
    } catch {
      applyEntityHighlightStyle(DEFAULT_SETTINGS.entity_highlight_style);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    refreshSettings();
  }, [refreshSettings]);

  const value = useMemo(
    () => ({
      settings,
      loaded,
      benchmarks: settings.benchmarks,
      entityHighlightStyle: settings.entity_highlight_style,
      entityHighlightsEnabled: entityHighlightsEnabled(settings.entity_highlight_style),
      refreshSettings,
    }),
    [settings, loaded, refreshSettings],
  );

  return (
    <PlatformSettingsContext.Provider value={value}>
      {children}
    </PlatformSettingsContext.Provider>
  );
}

export function usePlatformSettings() {
  return useContext(PlatformSettingsContext);
}

export { normalizeEntityHighlightStyle };
