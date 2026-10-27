import { useEffect, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '../../contexts/AuthContext';
import {
  fetchRail,
  hubConfigured,
  hubSignedIn,
  railOrder,
  saveRail,
  sendHubLink,
  type RailApp,
  type RailPlace,
} from '../../lib/hub';

// The ECD app rail (Zak, 2026-10-27), copied from Revenue Desk
// (src/components/AppRail.tsx): every ECD app the person can open, as icons in a
// column left of this app's own menu, and as a row behind the Apps button in the
// menu on phones. Each person drags the icons into their own order and picks what
// sits on the rail, under More, or nowhere. Apps open in this tab. This app's own
// tile is "you are here" and does nothing when clicked.
//
// The rail signs in to ECD Hub on its own (src/lib/hub.ts). Until it has, it shows
// one "Your apps" tile that emails a Hub sign-in link back to this page.

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

const BRAND_SOLID = 'bg-brand-primary text-white';
const BRAND_TEXT = 'text-brand-primary';
const BRAND_TINT = 'bg-brand-primary/10';
const TILE_HOVER = 'group-hover:bg-gray-100';

export function AppRail({ variant = 'column' }: { variant?: 'column' | 'row' }) {
  const [version, setVersion] = useState(0);
  // What is on screen: the saved rail, or the change just made while it saves.
  const [apps, setApps] = useState<RailApp[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [moreTop, setMoreTop] = useState(0);
  const [drag, setDrag] = useState<{ id: string; over: string | null } | null>(null);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const railRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let alive = true;
    if (!hubConfigured()) {
      setFailed(true);
      return;
    }
    hubSignedIn()
      .then(async (inHub) => {
        if (!alive) return;
        setSignedOut(!inHub);
        if (!inHub) return;
        const data = await fetchRail();
        if (!alive) return;
        setApps(data);
        setFailed(false);
      })
      // A Hub sign-in that no longer works (expired, revoked) asks for a new one.
      .catch(() => alive && setSignedOut(true));
    return () => {
      alive = false;
    };
  }, [version]);

  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!railRef.current?.contains(e.target as Node)) setMoreOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMoreOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [moreOpen]);

  // Saves go one after another, in the order made. A refused save reloads what Hub has.
  function commit(next: RailApp[]) {
    setApps(next);
    setErr(null);
    chain.current = chain.current
      .then(() => saveRail(next))
      .catch((e: unknown) => {
        setErr(e instanceof Error ? e.message : 'Could not save your apps');
        setVersion((v) => v + 1);
      });
  }
  function reset() {
    setErr(null);
    chain.current = chain.current
      .then(() => saveRail([]))
      .then(() => setVersion((v) => v + 1))
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Could not reset your apps'));
  }

  const row = variant === 'row';
  if (signedOut) return <HubSignIn row={row} />;
  // If Hub cannot be read, the app works without the rail.
  if (!apps) {
    if (failed || row) return null;
    return <div aria-hidden className="h-full w-full" />;
  }

  const ordered = railOrder(apps);
  const onRail = ordered.filter((a) => a.place === 'rail');
  const more = ordered.filter((a) => a.place === 'more');

  function dropOn(targetId: string) {
    if (!drag || drag.id === targetId) return setDrag(null);
    const moved = ordered.find((a) => a.id === drag.id);
    if (!moved) return setDrag(null);
    const from = ordered.indexOf(moved);
    const rest = ordered.filter((a) => a.id !== drag.id);
    const at = rest.findIndex((a) => a.id === targetId);
    rest.splice(from < ordered.findIndex((a) => a.id === targetId) ? at + 1 : at, 0, moved);
    setDrag(null);
    commit(rest);
  }
  const dnd = (a: RailApp) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', a.id);
      setDrag({ id: a.id, over: null });
    },
    onDragOver: (e: DragEvent) => {
      if (!drag) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (drag.over !== a.id) setDrag({ ...drag, over: a.id });
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      dropOn(a.id);
    },
    onDragEnd: () => setDrag(null),
  });

  return (
    <div
      ref={railRef}
      aria-label="ECD apps"
      className={cx('relative', row ? 'flex flex-wrap items-start gap-1' : 'flex h-full flex-col items-center gap-1 py-3')}
    >
      {/* On phones the tiles and Arrange wrap onto more lines. */}
      <div className={row ? 'contents' : 'flex w-full flex-col items-center gap-1.5'}>
        {onRail.map((a) => (
          <Tile key={a.id} app={a} dragging={drag?.id === a.id} over={drag?.over === a.id && drag.id !== a.id} {...dnd(a)} />
        ))}
        {more.length ? (
          <button
            ref={moreRef}
            type="button"
            aria-expanded={moreOpen}
            onClick={() => {
              setMoreTop(moreRef.current?.offsetTop ?? 0);
              setMoreOpen((o) => !o);
            }}
            className={tileCls(false, false)}
            title="More apps"
          >
            <span
              className={cx(
                'grid h-9 w-9 place-items-center rounded-[10px] transition-colors',
                moreOpen ? BRAND_SOLID : cx(BRAND_TEXT, TILE_HOVER)
              )}
            >
              <GridIcon />
            </span>
            <span className="leading-tight text-gray-600" style={{ fontSize: 9.5 }}>
              More
            </span>
          </button>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => setEditing(true)}
        className={cx(
          tileCls(false, false),
          'text-gray-400 hover:text-brand-primary',
          !row && 'mt-2'
        )}
        title={err ?? 'Choose and arrange your apps'}
      >
        <span className="relative grid h-9 w-9 place-items-center rounded-[10px] border border-dashed border-gray-300">
          <SlidersIcon />
          {err ? <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-red-500" /> : null}
        </span>
        <span className="leading-tight" style={{ fontSize: 9.5 }}>
          Arrange
        </span>
      </button>
      {moreOpen ? (
        <div
          className={cx(
            'z-10 flex flex-col gap-0.5 rounded-[10px] border border-gray-200 bg-white p-1.5 shadow-lg',
            row ? 'absolute left-0 right-0 top-full mt-1' : 'absolute left-full ml-2 w-[250px]'
          )}
          style={row ? undefined : { top: moreTop }}
          role="menu"
          aria-label="More apps"
        >
          <p className="px-2 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
            More apps
          </p>
          {more.map((a) => (
            <a
              key={a.id}
              role="menuitem"
              href={a.url}
              onClick={() => setMoreOpen(false)}
              className="flex items-center gap-2.5 rounded-[7px] px-2 py-1.5 text-gray-700 transition-colors hover:bg-brand-primary/10 hover:text-gray-900"
              style={{ fontSize: 13 }}
            >
              <span className={cx('grid h-7 w-7 flex-none place-items-center rounded-[8px]', BRAND_TINT, BRAND_TEXT)}>
                <RailIcon icon={a.icon} size={15} />
              </span>
              <span className="min-w-0 flex-1 truncate">{a.name}</span>
            </a>
          ))}
        </div>
      ) : null}
      {/* On the body, above the header and every panel. */}
      {editing
        ? createPortal(
            <RailEditor apps={ordered} err={err} onChange={commit} onReset={reset} onClose={() => setEditing(false)} />,
            document.body
          )
        : null}
    </div>
  );
}

// ---------------------------------------------------------------- signing in to ECD Hub

// One "Your apps" tile until the rail has its own Hub sign-in: an email box that sends
// a Hub link back to this page. Hub only signs in people it already knows.
function HubSignIn({ row }: { row: boolean }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(row);
  const [email, setEmail] = useState(user?.email ?? '');
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || row) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, row]);

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setState('sending');
    setError(null);
    try {
      await sendHubLink(email);
      setState('sent');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the link');
      setState('idle');
    }
  }

  const form = (
    <div className="flex flex-col gap-2">
      {row ? null : <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Your apps</p>}
      {state === 'sent' ? (
        <p className="text-gray-600" style={{ fontSize: 12.5 }}>
          Check your email for a sign-in link from ECD Hub. It brings you back here with your apps.
        </p>
      ) : (
        <form onSubmit={send} className="flex flex-col gap-2">
          <p className="text-gray-600" style={{ fontSize: 12.5 }}>
            Sign in to ECD Hub once to see your ECD apps here.
          </p>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@ecdigitalstrategy.com"
            aria-label="Your ECD email"
            className="w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm text-gray-900 outline-none focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/20"
          />
          {error ? (
            <p role="alert" className="text-red-600" style={{ fontSize: 12 }}>
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={state === 'sending'}
            className="rounded-lg bg-brand-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-primary-dark disabled:opacity-60 transition-colors"
          >
            {state === 'sending' ? 'Sending…' : 'Email me a sign-in link'}
          </button>
        </form>
      )}
    </div>
  );

  if (row) return <div aria-label="ECD apps">{form}</div>;
  return (
    <div ref={wrapRef} aria-label="ECD apps" className="relative flex h-full flex-col items-center py-3">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className={tileCls(false, false)} title="Your ECD apps">
        <span className={cx('grid h-9 w-9 place-items-center rounded-[10px] transition-colors', open ? BRAND_SOLID : cx(BRAND_TEXT, TILE_HOVER))}>
          <GridIcon />
        </span>
        <span className="leading-tight text-gray-600" style={{ fontSize: 9.5 }}>
          Your apps
        </span>
      </button>
      {open ? (
        <div className="absolute left-full top-3 z-10 ml-2 w-[260px] rounded-[10px] border border-gray-200 bg-white p-3 shadow-lg">
          {form}
        </div>
      ) : null}
    </div>
  );
}

const tileCls = (dragging: boolean, over: boolean) =>
  cx(
    'group flex w-[56px] flex-none flex-col items-center gap-1 rounded-[10px] py-1',
    dragging && 'opacity-40',
    over && 'bg-gray-100 ring-2 ring-inset ring-brand-primary'
  );

type TileProps = {
  app: RailApp;
  dragging: boolean;
  over: boolean;
  draggable?: boolean;
  onDragStart?: (e: DragEvent) => void;
  onDragOver?: (e: DragEvent) => void;
  onDrop?: (e: DragEvent) => void;
  onDragEnd?: () => void;
};

function Tile({ app, dragging, over, ...dnd }: TileProps) {
  const body = (
    <>
      <span
        className={cx(
          'grid h-9 w-9 place-items-center rounded-[10px] transition-colors',
          app.this_app ? BRAND_SOLID : cx(BRAND_TEXT, TILE_HOVER)
        )}
      >
        <RailIcon icon={app.icon} />
      </span>
      <span
        className={cx(
          'max-w-[56px] truncate leading-tight',
          app.this_app ? 'font-semibold text-gray-900' : 'text-gray-600'
        )}
        style={{ fontSize: 9.5 }}
      >
        {app.label}
      </span>
    </>
  );
  const cls = tileCls(dragging, over);
  // You are here: nothing happens on a click.
  return app.this_app ? (
    <span className={cx(cls, 'cursor-default')} title={app.name} aria-current="page" {...dnd}>
      {body}
    </span>
  ) : (
    // Same tab, replacing this screen; Back returns here.
    <a href={app.url} className={cls} title={app.name} {...dnd}>
      {body}
    </a>
  );
}

// ---------------------------------------------------------------- arranging your rail

const PLACES: { key: RailPlace; label: string }[] = [
  { key: 'rail', label: 'Rail' },
  { key: 'more', label: 'More' },
  { key: 'hidden', label: 'Hidden' },
];
const GROUPS: { key: RailPlace; title: string; note: string }[] = [
  { key: 'rail', title: 'On your rail', note: 'Top to bottom, as on the rail. You can also drag the icons on the rail.' },
  { key: 'more', title: 'Under More', note: 'One click away behind the More icon.' },
  { key: 'hidden', title: 'Hidden', note: 'Not shown anywhere. Bring one back any time.' },
];

function RailEditor(props: {
  apps: RailApp[];
  err: string | null;
  onChange: (next: RailApp[]) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const { apps, onClose } = props;
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Swap with the next app above or below in the same group.
  function move(id: string, dir: -1 | 1) {
    const i = apps.findIndex((a) => a.id === id);
    let j = i + dir;
    while (j >= 0 && j < apps.length && apps[j].place !== apps[i].place) j += dir;
    if (j < 0 || j >= apps.length) return;
    const next = [...apps];
    [next[i], next[j]] = [next[j], next[i]];
    props.onChange(next);
  }
  // A moved app goes to the end of its new group.
  function place(id: string, to: RailPlace) {
    const app = apps.find((a) => a.id === id);
    if (!app || app.place === to) return;
    props.onChange(railOrder([...apps.filter((a) => a.id !== id), { ...app, place: to }]));
  }

  const arrow =
    'grid h-6 w-6 place-items-center rounded-md text-gray-400 hover:bg-brand-primary/10 hover:text-brand-primary disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-gray-400';
  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Arrange your apps"
        className="flex max-h-[90vh] w-full max-w-[460px] flex-col rounded-xl border border-gray-200 bg-white shadow-xl outline-none"
      >
        <div className="flex items-center justify-between gap-2 border-b border-gray-100 px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Your apps</p>
          <span className="text-xs text-gray-400">Only your rail changes</span>
        </div>
        <div className="flex flex-col gap-4 overflow-y-auto px-4 py-3">
          {props.err ? (
            <p role="alert" className="rounded-md bg-red-50 px-2.5 py-1.5 text-red-600" style={{ fontSize: 12.5 }}>
              {props.err}
            </p>
          ) : null}
          {GROUPS.map((g) => {
            const list = apps.filter((a) => a.place === g.key);
            return (
              <section key={g.key} className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="font-semibold text-gray-900" style={{ fontSize: 13 }}>
                    {g.title}
                  </h3>
                  <span className="text-xs tabular-nums text-gray-400">{list.length}</span>
                </div>
                <p className="text-gray-400" style={{ fontSize: 11.5 }}>
                  {g.note}
                </p>
                {list.length === 0 ? (
                  <p className="py-1 italic text-gray-400" style={{ fontSize: 12 }}>
                    Nothing here.
                  </p>
                ) : (
                  list.map((a, i) => (
                    <div key={a.id} className="flex items-center gap-2 border-t border-gray-100 py-1 first:border-t-0">
                      <div className="flex flex-col">
                        <button type="button" className={arrow} disabled={i === 0} aria-label={`Move ${a.name} up`} onClick={() => move(a.id, -1)}>
                          ↑
                        </button>
                        <button
                          type="button"
                          className={arrow}
                          disabled={i === list.length - 1}
                          aria-label={`Move ${a.name} down`}
                          onClick={() => move(a.id, 1)}
                        >
                          ↓
                        </button>
                      </div>
                      <span className={cx('grid h-8 w-8 flex-none place-items-center rounded-[9px]', BRAND_TINT, BRAND_TEXT)}>
                        <RailIcon icon={a.icon} size={16} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-gray-900" style={{ fontSize: 13.5 }}>
                          {a.name}
                        </p>
                        {a.this_app ? <p className="text-xs text-gray-400">The app you're in. Always on the rail.</p> : null}
                      </div>
                      {a.this_app ? null : <PlaceSwitch name={a.name} value={a.place} onChange={(p) => place(a.id, p)} />}
                    </div>
                  ))
                )}
              </section>
            );
          })}
          <p className="text-gray-400" style={{ fontSize: 11.5 }}>
            Zak decides which apps you can add. Ask him if one is missing.
          </p>
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-gray-100 px-4 py-3">
          <button
            type="button"
            onClick={props.onReset}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 transition-colors"
          >
            Back to the default
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-brand-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-primary-dark transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function PlaceSwitch({ name, value, onChange }: { name: string; value: RailPlace; onChange: (p: RailPlace) => void }) {
  return (
    <div
      role="radiogroup"
      aria-label={`Where ${name} goes`}
      className="flex flex-none gap-0.5 rounded-full border border-gray-200 p-0.5"
    >
      {PLACES.map((p) => {
        const on = value === p.key;
        return (
          <button
            key={p.key}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(p.key)}
            className={cx(
              'rounded-full px-2.5 py-0.5',
              on
                ? p.key === 'rail'
                  ? cx(BRAND_SOLID, 'font-semibold')
                  : p.key === 'more'
                    ? cx(BRAND_TINT, BRAND_TEXT, 'font-semibold')
                    : 'bg-gray-100 font-semibold text-gray-900'
                : 'text-gray-400 hover:text-gray-900'
            )}
            style={{ fontSize: 11.5 }}
          >
            {p.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- icons

// The drawn icons Hub's Settings > Apps offers; anything else shows as one or two letters.
const ICONS: Record<string, ReactNode> = {
  desk: <path d="M4 5h16l-6 7.5V18l-4 2v-7.5z" />,
  finance: <path d="M5 19v-7M10 19V6M15 19v-5M20 19V9M3 19.5h18" />,
  clients: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 19c0-3 2.6-5 5.5-5s5.5 2 5.5 5" />
      <path d="M16 5.6a3 3 0 0 1 0 5.3M17.5 14.2c1.9.6 3 2.3 3 4.8" />
    </>
  ),
  calendar: (
    <>
      <rect x="4" y="5" width="16" height="15" rx="2" />
      <path d="M4 10h16M9 3v4M15 3v4" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4" />
      <path d="M12 12h.01" />
    </>
  ),
  proposal: (
    <>
      <path d="M7 3h7l4 4v14H7z" />
      <path d="M14 3v4h4M10 12h5M10 16h5" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="3.6" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" />
    </>
  ),
  percent: (
    <>
      <path d="M19 5 5 19" />
      <circle cx="7" cy="7" r="2.5" />
      <circle cx="17" cy="17" r="2.5" />
    </>
  ),
  payouts: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.6" />
      <path d="M6.5 9.5v5M17.5 9.5v5" />
    </>
  ),
};

function RailIcon({ icon, size = 18 }: { icon: string; size?: number }) {
  const d = ICONS[icon];
  if (d) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {d}
      </svg>
    );
  }
  return (
    <span className="font-semibold leading-none" style={{ fontSize: Math.round(size * 0.66), letterSpacing: '-.01em' }} aria-hidden="true">
      {icon.slice(0, 2)}
    </span>
  );
}

function GridIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true">
      <rect x="4.5" y="4.5" width="6" height="6" rx="1.5" />
      <rect x="13.5" y="4.5" width="6" height="6" rx="1.5" />
      <rect x="4.5" y="13.5" width="6" height="6" rx="1.5" />
      <rect x="13.5" y="13.5" width="6" height="6" rx="1.5" />
    </svg>
  );
}

function SlidersIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </svg>
  );
}
