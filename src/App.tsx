import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { getZoneRedirectOrigin } from './lib/route-zones';
import { canAccessArea } from './lib/access';
import AppShell from './components/layout/AppShell';
import Login from './pages/Login';
import Modal from './components/ui/Modal';
import AppPreloader from './components/ui/AppPreloader';
import { ToastProvider } from './components/ui/Toast';
import { PlatformSettingsProvider } from './contexts/PlatformSettingsContext';
import { canUseOutreach } from './lib/outreach-access';
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Clients = lazy(() => import('./pages/Clients'));
const ClientDetail = lazy(() => import('./pages/ClientDetail'));
const NewClient = lazy(() => import('./pages/NewClient'));
const Audits = lazy(() => import('./pages/Audits'));
const NewAudit = lazy(() => import('./pages/NewAudit'));
const AuditWorkspace = lazy(() => import('./pages/AuditWorkspace'));
const PublicReport = lazy(() => import('./pages/PublicReport'));
const PublicProposal = lazy(() => import('./pages/PublicProposal'));
const AdminArea = lazy(() => import('./pages/AdminArea'));
const Outreach = lazy(() => import('./pages/Outreach'));
const Proposals = lazy(() => import('./pages/Proposals'));
const NewProposal = lazy(() => import('./pages/NewProposal'));
const ProposalDetail = lazy(() => import('./pages/ProposalDetail'));
const ProposalEditor = lazy(() => import('./pages/ProposalEditor'));
const TemplateEditor = lazy(() => import('./pages/TemplateEditor'));
const Documents = lazy(() => import('./pages/Documents'));
const NewDocument = lazy(() => import('./pages/NewDocument'));
const DocumentDetail = lazy(() => import('./pages/DocumentDetail'));
const DocumentTemplateEditor = lazy(() => import('./pages/DocumentTemplateEditor'));
const PublicDocument = lazy(() => import('./pages/PublicDocument'));

function ViewerLanding() {
  const { user, signOut } = useAuth();
  return (
    <div className="min-h-screen bg-[#f9f9f9] flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-sm border border-gray-100 p-8 text-center">
        <img
          src="/cropped-favicon-192x192.webp"
          alt="ECD Digital Strategy"
          className="h-14 w-14 rounded-xl object-cover shadow-md ring-1 ring-black/5 mx-auto mb-5"
          width={56}
          height={56}
        />
        <h1 className="text-xl font-bold text-gray-900 mb-2">Welcome to ECD Audit</h1>
        <p className="text-sm text-gray-500 mb-1">Signed in as <span className="font-medium text-gray-700">{user?.email}</span></p>
        <p className="text-sm text-gray-500 mt-4 leading-relaxed">
          Your custom audit report is ready for you. Please open it using the link that was shared with you by the ECD team.
        </p>
        <div className="mt-6 pt-5 border-t border-gray-100">
          <button
            onClick={signOut}
            className="text-sm text-gray-400 hover:text-gray-600 transition-colors"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

function AppRoutes() {
  const { user, isLoading, isRestoring, hasRole } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const state = location.state as any;
  const backgroundLocation = state?.backgroundLocation as ReturnType<typeof useLocation> | undefined;
  const isPublicReportRoute =
    location.pathname.startsWith('/report/') || location.pathname.startsWith('/proposal/');
  // Set when an unauthenticated visit got bounced to /login (see the `!user` branch
  // below). If auth resolves while still sitting on /login or another unmatched route
  // (e.g. the session-hydration race where isLoading clears before `user` does), send
  // them back to the page they actually clicked instead of defaulting to "/".
  const deepLinkFrom = typeof state?.from === 'string' ? state.from : null;

  // Back from Shopify's install page, which is a full page load: the new-audit
  // wizard would render as a bare page because the popup only exists while a
  // background location is in router state. Put the Audits list behind it and
  // reopen the wizard as the popup, so closing it lands on Audits, not Shopify.
  const resumingWizard =
    location.pathname === '/audits/new' && !backgroundLocation && new URLSearchParams(location.search).has('resume_web');
  useEffect(() => {
    if (!resumingWizard) return;
    const search = location.search;
    navigate('/audits', { replace: true });
    navigate(`/audits/new${search}`, {
      state: { backgroundLocation: { pathname: '/audits', search: '', hash: '', state: null, key: 'shopify-resume' } },
    });
  }, [resumingWizard, location.search, navigate]);

  // Proposals live on proposal.ecdigitalstrategy.com; everything else (dashboard,
  // audits, clients, admin) lives on audit.ecdigitalstrategy.com. Checked against
  // whatever's actually being rendered (the modal system swaps in a background
  // location while a "New X" modal is open, so a proposals modal opened from an
  // audit-zone page shouldn't itself trigger a cross-domain redirect). Runs before
  // the auth gate below since the session cookie is shared across both domains
  // anyway, so whichever domain we land on already knows the login state.
  const zonedPathname = (backgroundLocation ?? location).pathname;
  const zoneRedirectOrigin = getZoneRedirectOrigin(zonedPathname);
  if (zoneRedirectOrigin) {
    window.location.replace(`${zoneRedirectOrigin}${location.pathname}${location.search}`);
    return null;
  }

  if (isLoading && !isPublicReportRoute) {
    return <AppPreloader message={isRestoring ? 'Signing you in…' : undefined} />;
  }

  // Viewer means the read-only role, explicitly. This used to be "anyone who is
  // not an admin", which was harmless while every staff account was an admin
  // and would have dumped every newly-demoted member onto the viewer landing
  // page the moment per-user roles shipped.
  const isViewer = user && user.role === 'viewer';

  const closeAuditWizardModal = () => navigate(-1);

  // Swapping the bare page for the popup (see above): show nothing in between.
  if (resumingWizard) return <AppPreloader />;

  return (
    <>
    <Suspense fallback={<AppPreloader />}>
      <Routes location={backgroundLocation || location}>
        <Route path="/report/:token" element={<PublicReport />} />
        <Route path="/proposal/:token" element={<PublicProposal />} />
        <Route path="/document/:token" element={<PublicDocument />} />

        {!user ? (
          <>
            <Route path="/login" element={<Login />} />
            <Route
              path="*"
              element={
                <Navigate
                  to="/login"
                  replace
                  state={{ from: location.pathname + location.search }}
                />
              }
            />
          </>
        ) : isViewer ? (
          <>
            <Route path="/" element={<ViewerLanding />} />
            <Route path="*" element={<Navigate to={deepLinkFrom || '/'} replace />} />
          </>
        ) : (
          <Route element={<AppShell />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/clients" element={<Clients />} />
            <Route path="/clients/new" element={<NewClient />} />
            <Route path="/clients/:id" element={<ClientDetail />} />
            {/* Area routes exist only for users with access, so a pasted URL to
                a blocked area falls through to the catch-all and lands on the
                dashboard, the same as a route that does not exist. */}
            {canAccessArea(user, 'audits') && (
              <>
                <Route path="/audits" element={<Audits />} />
                <Route path="/audits/new" element={<NewAudit />} />
                <Route path="/audits/:id" element={<AuditWorkspace />} />
              </>
            )}
            {canAccessArea(user, 'proposals') && (
              <>
                <Route path="/proposals" element={<Proposals />} />
                <Route path="/proposals/new" element={<NewProposal />} />
                <Route path="/proposals/:id" element={<ProposalDetail />} />
                <Route path="/proposals/:id/edit" element={<ProposalEditor />} />
                <Route path="/proposals/templates/:templateId/edit" element={<TemplateEditor />} />
              </>
            )}
            {canAccessArea(user, 'documents') && (
              <>
                <Route path="/documents" element={<Documents />} />
                <Route path="/documents/new" element={<NewDocument />} />
                <Route path="/documents/:id" element={<DocumentDetail />} />
                {/* Legacy edit URL now resolves to the unified workspace. */}
                <Route path="/documents/:id/edit" element={<DocumentDetail />} />
                <Route path="/documents/templates/:templateId/edit" element={<DocumentTemplateEditor />} />
              </>
            )}
            <Route path="/admin" element={<AdminArea />} />
            {/* Cold outreach with free web audits (Emil, 2026-11-01): Emil only, for now. */}
            {canUseOutreach(user?.email) && <Route path="/outreach" element={<Outreach />} />}
            <Route path="*" element={<Navigate to={deepLinkFrom || '/'} replace />} />
          </Route>
        )}
      </Routes>
    </Suspense>

    {/* The "New X" modal overlays follow the same access rules as their full
        pages: clients for all staff, audits and proposals per area access. This
        was admin-only, which was invisible while everyone was an admin and
        would have broken creating things for every member. */}
    {backgroundLocation && user && hasRole(['admin', 'auditor']) && (
      <Suspense fallback={null}>
        <Routes>
          <Route
            path="/clients/new"
            element={
              <Modal open title="Add Client" onClose={() => navigate(-1)}>
                <NewClient asModal />
              </Modal>
            }
          />
          {canAccessArea(user, 'audits') && (
            <Route
              path="/audits/new"
              element={
                <Modal
                  open
                  title="New Audit"
                  onClose={closeAuditWizardModal}
                  className="max-w-7xl"
                >
                  <NewAudit asModal />
                </Modal>
              }
            />
          )}
          {canAccessArea(user, 'proposals') && (
            <Route
              path="/proposals/new"
              element={
                <Modal open title="New Proposal" onClose={() => navigate(-1)} className="max-w-2xl">
                  <NewProposal asModal />
                </Modal>
              }
            />
          )}
        </Routes>
      </Suspense>
    )}
    </>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <PlatformSettingsProvider>
            <AppRoutes />
          </PlatformSettingsProvider>
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
