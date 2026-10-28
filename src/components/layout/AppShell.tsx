import { Suspense } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import { useEffect, useMemo, useState } from 'react';
import AppPreloader from '../ui/AppPreloader';
import WhatsNewModal from './WhatsNewModal';
import { AppRail } from './AppRail';

const AUDIT_WORKSPACE_PATH = /^\/audits\/[^/]+$/;
// The document workspace (a single doc, its editor, or a template editor) wants
// the extra width; the list and "new" pages do not.
function isDocumentWorkspace(pathname: string): boolean {
  return pathname.startsWith('/documents/') && pathname !== '/documents/new';
}

// Phones (below Tailwind's md): the menu is a 68px icon strip and opens OVER the
// page instead of pushing it aside. Pushing it left a phone about 135px for the
// page, so everything spilled past the edge (Emil, 2026-10-28).
const PHONE = '(max-width: 767px)';
const isPhone = () => typeof window !== 'undefined' && window.matchMedia(PHONE).matches;

export default function AppShell() {
  const location = useLocation();
  const wantsCollapse = useMemo(
    () => AUDIT_WORKSPACE_PATH.test(location.pathname) || isDocumentWorkspace(location.pathname),
    [location.pathname],
  );
  const [collapsed, setCollapsed] = useState(() => wantsCollapse || isPhone());

  // On every page change: the page's own preference, and always closed on a phone.
  useEffect(() => {
    setCollapsed(wantsCollapse || isPhone());
  }, [wantsCollapse, location.pathname]);

  return (
    <div className="min-h-screen bg-[#f8f8f8]">
      <WhatsNewModal />
      {/* The ECD app rail (Zak, 2026-10-27): the same column in every ECD app, left of
          this app's own menu, above it so the More list can open over it. Phones get it
          behind the Apps button in the menu. An aside, so printing hides it. */}
      <aside className="hidden md:block fixed left-0 top-0 h-screen w-[68px] z-40 px-1.5 bg-white border-r border-gray-100">
        <AppRail />
      </aside>
      <Sidebar collapsed={collapsed} onCollapsedChange={setCollapsed} />
      <div
        className={`app-shell-offset ${
          collapsed ? 'ml-[68px] md:ml-[136px]' : 'ml-[68px] md:ml-[308px]'
        } flex flex-col min-h-screen transition-[margin] duration-300`}
      >
        <main className="flex flex-1 flex-col min-h-[100dvh]">
          <Suspense fallback={<AppPreloader compact />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
