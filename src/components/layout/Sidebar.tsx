import { Link, NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  Users,
  ClipboardCheck,
  FileSignature,
  FileText,
  Settings,
  LogOut,
  ChevronLeft,
  ChevronRight,
  LayoutGrid,
} from 'lucide-react';
import { createPortal } from 'react-dom';
import { AppRail } from './AppRail';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { canAccessArea } from '../../lib/access';

interface SidebarProps {
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}

const NAV_ITEMS = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/audits', icon: ClipboardCheck, label: 'Audits' },
  { to: '/proposals', icon: FileSignature, label: 'Proposals' },
  { to: '/documents', icon: FileText, label: 'Documents' },
  { to: '/clients', icon: Users, label: 'Clients' },
];

const ADMIN_ITEMS = [
  { to: '/admin', icon: Settings, label: 'Settings', prefetch: () => import('../../pages/AdminArea') },
];

const NAV_PREFETCH: Record<string, () => Promise<unknown>> = {
  '/': () => import('../../pages/Dashboard'),
  '/clients': () => import('../../pages/Clients'),
  '/audits': () => import('../../pages/Audits'),
  '/proposals': () => import('../../pages/Proposals'),
  '/documents': () => import('../../pages/Documents'),
};

export default function Sidebar({ collapsed: collapsedProp, onCollapsedChange }: SidebarProps) {
  const [collapsedState, setCollapsedState] = useState(false);
  const collapsed = collapsedProp ?? collapsedState;
  const setCollapsed = (next: boolean) => {
    onCollapsedChange?.(next);
    if (collapsedProp === undefined) setCollapsedState(next);
  };
  const { user, hasRole, signOut } = useAuth();
  // The three gated areas show only to users with access; Dashboard and
  // Clients always show. Settings shows for everyone too, since the Line Item
  // Catalog and API Connection inside it are open to all staff (the Users tab
  // gates itself to admins on the page).
  const navItems = NAV_ITEMS.filter(item => {
    if (item.to === '/audits') return canAccessArea(user, 'audits');
    if (item.to === '/proposals') return canAccessArea(user, 'proposals');
    if (item.to === '/documents') return canAccessArea(user, 'documents');
    return true;
  });
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [appsOpen, setAppsOpen] = useState(false);
  const profileAreaRef = useRef<HTMLDivElement>(null);
  const initials = (user?.name || user?.email || 'U')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map(p => p[0]?.toUpperCase())
    .join('') || 'U';

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 ${
      isActive
        ? 'bg-brand-primary/10 text-brand-primary'
        : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
    }`;

  useEffect(() => {
    if (!profileMenuOpen) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (profileAreaRef.current && !profileAreaRef.current.contains(e.target as Node)) {
        setProfileMenuOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setProfileMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [profileMenuOpen]);

  return (
    <aside
      className={`fixed left-0 md:left-[68px] top-0 h-screen bg-white border-r border-gray-100 flex flex-col z-30 transition-all duration-300 ${
        collapsed ? 'w-[68px]' : 'w-[240px]'
      }`}
    >
      <Link
        to="/"
        className="flex items-center gap-2.5 px-4 h-16 border-b border-gray-100 shrink-0 hover:bg-gray-50 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand-primary/30 focus-visible:ring-inset"
        aria-label="Go to Dashboard"
      >
        <img
          src="/cropped-favicon-192x192.webp"
          alt=""
          className="h-8 w-8 rounded-lg object-cover shadow-sm ring-1 ring-black/5 shrink-0"
          width={32}
          height={32}
        />
        {!collapsed && (
          <div className="overflow-hidden">
            <span className="font-bold text-sm text-gray-900 whitespace-nowrap">ECD</span>
            <span className="block text-[10px] text-gray-400 -mt-0.5">Digital Strategy</span>
          </div>
        )}
      </Link>

      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {navItems.map(item => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={linkClass}
            onMouseEnter={() => { void NAV_PREFETCH[item.to]?.(); }}
          >
            <item.icon className="w-[18px] h-[18px] shrink-0" />
            {!collapsed && <span>{item.label}</span>}
          </NavLink>
        ))}

        {/* Settings is for every staff account now: the Line Item Catalog and
            API Connection tabs inside it are open to all, and the page itself
            hides the Users tab from non-admins. Viewers keep no sidebar at all
            (they never reach this shell). */}
        {hasRole(['admin', 'auditor']) && (
          <>
            <div className={`pt-4 pb-1 ${collapsed ? 'px-0' : 'px-1'}`}>
              {!collapsed && <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-300">Settings</span>}
            </div>
            {ADMIN_ITEMS.map(item => (
              <NavLink
                key={item.to}
                to={item.to}
                className={linkClass}
                onMouseEnter={() => { void item.prefetch?.(); }}
              >
                <item.icon className="w-[18px] h-[18px] shrink-0" />
                {!collapsed && <span>{item.label}</span>}
              </NavLink>
            ))}
          </>
        )}

        {/* The ECD app rail, phones only: on wider screens it is its own column left of this menu. */}
        <button
          type="button"
          onClick={() => setAppsOpen(o => !o)}
          aria-expanded={appsOpen}
          className={`md:hidden w-full ${linkClass({ isActive: appsOpen })}`}
        >
          <LayoutGrid className="w-[18px] h-[18px] shrink-0" />
          {!collapsed && <span>Apps</span>}
        </button>
      </nav>

      {appsOpen &&
        createPortal(
          <div className="md:hidden fixed inset-0 z-50" onMouseDown={e => e.target === e.currentTarget && setAppsOpen(false)}>
            <div className="absolute left-2 right-2 top-16 rounded-xl border border-gray-200 bg-white p-3 shadow-xl">
              <p className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Apps</p>
              <AppRail variant="row" />
            </div>
          </div>,
          document.body,
        )}

      <div ref={profileAreaRef} className="border-t border-gray-100 p-3 relative">
        {user && (
          <>
            <button
              type="button"
              onClick={() => setProfileMenuOpen(o => !o)}
              className={`flex items-center gap-3 rounded-lg w-full text-left transition-colors ${
                collapsed ? 'justify-center px-1 py-2' : 'px-2 py-2'
              } bg-gray-50 hover:bg-gray-100 ${profileMenuOpen ? 'ring-2 ring-brand-primary/20' : ''}`}
              aria-expanded={profileMenuOpen}
              aria-haspopup="menu"
              aria-label="Account menu"
            >
              <div className="w-9 h-9 rounded-full gradient-bg flex items-center justify-center text-white text-xs font-bold shrink-0">
                {initials}
              </div>
              {!collapsed && (
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-gray-900 truncate">{user.name}</p>
                  <p className="text-xs text-gray-400 truncate">{user.email}</p>
                </div>
              )}
            </button>

            {profileMenuOpen && (
              <div
                className="absolute bottom-full left-3 right-3 mb-1 py-1 bg-white border border-gray-200 rounded-lg shadow-lg z-50"
                role="menu"
              >
                <button
                  type="button"
                  role="menuitem"
                  className="flex items-center gap-2 w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 text-left rounded-md mx-0.5"
                  onClick={() => {
                    setProfileMenuOpen(false);
                    signOut();
                  }}
                >
                  <LogOut className="w-4 h-4 shrink-0 text-gray-400" />
                  <span>Sign out</span>
                </button>
              </div>
            )}
          </>
        )}
      </div>

      <button
        onClick={() => setCollapsed(!collapsed)}
        className="absolute -right-3 top-20 w-6 h-6 bg-white border border-gray-200 rounded-full flex items-center justify-center text-gray-400 hover:text-gray-600 transition-colors shadow-sm"
      >
        {collapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronLeft className="w-3 h-3" />}
      </button>
    </aside>
  );
}
