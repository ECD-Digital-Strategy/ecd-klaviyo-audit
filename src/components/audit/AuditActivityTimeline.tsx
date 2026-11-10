import { FilePlus2, PenSquare, Globe, GlobeLock, RefreshCcw, type LucideIcon } from 'lucide-react';
import { formatEventTime } from '../../lib/time-format';
import type { AuditEvent, AuditEventType } from '../../lib/types';

const EVENT_META: Record<AuditEventType, { icon: LucideIcon; label: string; tone: string }> = {
  created: { icon: FilePlus2, label: 'Audit created', tone: 'text-gray-400 bg-gray-50' },
  edited: { icon: PenSquare, label: 'Audit edited', tone: 'text-gray-400 bg-gray-50' },
  published: { icon: Globe, label: 'Published', tone: 'text-emerald-600 bg-emerald-50' },
  unpublished: { icon: GlobeLock, label: 'Unpublished', tone: 'text-gray-400 bg-gray-50' },
  status_changed: { icon: RefreshCcw, label: 'Status changed', tone: 'text-blue-600 bg-blue-50' },
};

export default function AuditActivityTimeline({ events }: { events: AuditEvent[] }) {
  if (events.length === 0) {
    return <p className="text-xs text-gray-400">No activity yet.</p>;
  }

  return (
    <ol className="space-y-0">
      {events.map((event, index) => {
        const meta = EVENT_META[event.event_type] ?? EVENT_META.edited;
        const Icon = meta.icon;
        const status = typeof event.metadata?.status === 'string' ? event.metadata.status : null;
        return (
          <li key={event.id} className="relative flex gap-3 pb-4 last:pb-0">
            {index < events.length - 1 && (
              <span className="absolute left-[13px] top-7 h-[calc(100%-1.25rem)] w-px bg-gray-100" aria-hidden />
            )}
            <span className={`relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${meta.tone}`}>
              <Icon className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0 pt-1">
              <p className="text-xs font-medium text-gray-800">
                {meta.label}
                {status ? ` → ${status.replace(/_/g, ' ')}` : ''}
                {event.actor_name ? <span className="font-normal text-gray-400"> · by {event.actor_name}</span> : null}
              </p>
              <p className="text-[11px] text-gray-400">{formatEventTime(event.created_at)}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
