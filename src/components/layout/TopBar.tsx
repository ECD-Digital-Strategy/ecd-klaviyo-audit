import GlobalSearch from '../ui/GlobalSearch';

interface TopBarProps {
  title: string;
  subtitle?: string;
  leadingIcon?: React.ReactNode;
  actions?: React.ReactNode;
  /** Hide the built-in global search (e.g. when the page places search among its own actions). */
  hideSearch?: boolean;
}

export default function TopBar({ title, subtitle, leadingIcon, actions, hideSearch }: TopBarProps) {
  return (
    <header className="h-16 bg-white border-b border-gray-100 flex items-center justify-between gap-3 px-4 md:px-8 shrink-0">
      <div className="flex items-center gap-3 min-w-0">
        {leadingIcon}
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-gray-900 truncate">{title}</h1>
          {subtitle && <p className="text-sm text-gray-500 -mt-0.5 truncate">{subtitle}</p>}
        </div>
      </div>

      <div className="flex items-center gap-3">
        {actions}

        {/* Phones: no room next to the title; search lives on wider screens. */}
        {!hideSearch && (
          <div className="hidden md:block">
            <GlobalSearch />
          </div>
        )}
      </div>
    </header>
  );
}
