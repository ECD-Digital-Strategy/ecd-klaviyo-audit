import { lazy, Suspense, useCallback, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import AppPreloader from '../components/ui/AppPreloader';
import { SkeletonAuditWorkspace } from '../components/ui/Skeleton';
import { ReportEditProvider } from '../components/report/edit/ReportEditContext';
import { useAuditReportData } from '../hooks/useAuditReportData';
import { lazyAuditReportView, preloadAuditReportView } from '../lib/preload-audit-report-view';
import type { Audit, AuditSection } from '../lib/types';

const AuditReportView = lazy(lazyAuditReportView);
const WebAuditReportView = lazy(() => import('../components/report/WebAuditReportView'));

export default function PublicReport() {
  const { token } = useParams();
  const { loading, loadError, data, setData } = useAuditReportData(token);

  useEffect(() => {
    void preloadAuditReportView();
  }, []);

  const onAuditChange = useCallback(
    (audit: Audit) => {
      setData(prev => (prev ? { ...prev, audit } : prev));
    },
    [setData],
  );

  const onSectionsChange = useCallback(
    (sections: AuditSection[]) => {
      setData(prev => (prev ? { ...prev, sections } : prev));
    },
    [setData],
  );

  if (loading) {
    return <AppPreloader message="Loading report…" />;
  }

  if (loadError) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="text-center max-w-md">
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Couldn&apos;t load report</h1>
          <p className="text-gray-500">{loadError}</p>
          {/* A failed load is usually a momentary slowdown, not a dead link. */}
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-5 rounded-lg gradient-bg px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Report Not Found</h1>
          <p className="text-gray-500">This report link is invalid or has expired.</p>
        </div>
      </div>
    );
  }

  if (data.audit.audit_type === 'web') {
    return (
      <Suspense fallback={<SkeletonAuditWorkspace />}>
        <WebAuditReportView
          data={{
            audit: data.audit,
            client: data.client,
            sections: data.sections,
            pageSnapshots: data.webPageSnapshots ?? [],
            shopifySnapshots: data.shopifySnapshots ?? [],
            teaser: data.teaser ?? null,
          }}
        />
      </Suspense>
    );
  }

  return (
    <ReportEditProvider
      editMode={false}
      investmentToggleMode
      audit={data.audit}
      sections={data.sections}
      onAuditChange={onAuditChange}
      onSectionsChange={onSectionsChange}
    >
      <Suspense fallback={<SkeletonAuditWorkspace />}>
        <AuditReportView data={data} />
      </Suspense>
    </ReportEditProvider>
  );
}
