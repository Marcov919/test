import { Calendar, dateFnsLocalizer, Event } from 'react-big-calendar';
import { format, parse, startOfWeek, getDay } from 'date-fns';
import { it } from 'date-fns/locale/it';
import 'react-big-calendar/lib/css/react-big-calendar.css';
import { Appointment } from '../types';
import { useCallback } from 'react';

const locales = { 'it': it };
const localizer = dateFnsLocalizer({ format, parse, startOfWeek: () => startOfWeek(new Date(), { weekStartsOn: 1 }), getDay, locales });

interface CalendarEvent extends Event {
  resource: Appointment;
}

const STATUS_COLORS: Record<string, { bg: string; border: string }> = {
  scheduled: { bg: '#3b82f6', border: '#2563eb' },
  completed: { bg: '#10b981', border: '#059669' },
  cancelled: { bg: '#9ca3af', border: '#6b7280' },
  'no-show': { bg: '#ef4444', border: '#dc2626' },
};

const messages = {
  allDay: 'Tutto il giorno',
  previous: '←',
  next: '→',
  today: 'Oggi',
  month: 'Mese',
  week: 'Settimana',
  day: 'Giorno',
  agenda: 'Agenda',
  date: 'Data',
  time: 'Ora',
  event: 'Evento',
  noEventsInRange: 'Nessun appuntamento in questo periodo',
  showMore: (total: number) => `+${total} altri`,
};

interface Props {
  appointments: Appointment[];
  onSelectSlot: (start: Date, end: Date) => void;
  onSelectAppointment: (appointment: Appointment) => void;
}

export default function CalendarView({ appointments, onSelectSlot, onSelectAppointment }: Props) {
  const events: CalendarEvent[] = appointments.map(a => ({
    title: `${a.first_name} ${a.last_name} — ${a.title}`,
    start: new Date(a.start_time),
    end: new Date(a.end_time),
    resource: a,
  }));

  const eventStyleGetter = useCallback((event: CalendarEvent) => {
    const colors = STATUS_COLORS[event.resource.status] || STATUS_COLORS.scheduled;
    return {
      style: {
        backgroundColor: colors.bg,
        borderColor: colors.border,
        borderRadius: '6px',
        color: 'white',
        fontSize: '12px',
        padding: '2px 6px',
        border: `1px solid ${colors.border}`,
      }
    };
  }, []);

  const handleSelectSlot = useCallback(({ start, end }: { start: Date; end: Date }) => {
    onSelectSlot(start, end);
  }, [onSelectSlot]);

  const handleSelectEvent = useCallback((event: CalendarEvent) => {
    onSelectAppointment(event.resource);
  }, [onSelectAppointment]);

  return (
    <div className="h-full">
      <style>{`
        .rbc-calendar { font-family: inherit; }
        .rbc-header { background: #f8fafc; border-color: #e2e8f0 !important; padding: 10px 4px !important; font-weight: 600; color: #475569; font-size: 13px; }
        .rbc-today { background: #eff6ff !important; }
        .rbc-off-range-bg { background: #f8fafc; }
        .rbc-toolbar { margin-bottom: 16px; }
        .rbc-toolbar button { border-radius: 8px; font-size: 14px; padding: 6px 14px; border-color: #e2e8f0; color: #475569; }
        .rbc-toolbar button.rbc-active, .rbc-toolbar button:hover { background: #3b82f6; color: white; border-color: #3b82f6; }
        .rbc-toolbar-label { font-size: 18px; font-weight: 700; color: #1e293b; }
        .rbc-event { cursor: pointer; }
        .rbc-slot-selection { background: rgba(59,130,246,0.15); border: 1px solid #3b82f6; }
        .rbc-day-slot .rbc-time-slot { border-color: #f1f5f9; }
        .rbc-time-view, .rbc-month-view { border-color: #e2e8f0 !important; border-radius: 12px; overflow: hidden; }
        .rbc-agenda-view table { border-color: #e2e8f0; }
      `}</style>
      <Calendar
        localizer={localizer}
        events={events}
        culture="it"
        messages={messages}
        startAccessor="start"
        endAccessor="end"
        style={{ height: '100%' }}
        eventPropGetter={eventStyleGetter}
        onSelectSlot={handleSelectSlot}
        onSelectEvent={handleSelectEvent}
        selectable
        defaultView="week"
        views={['month', 'week', 'day', 'agenda']}
        step={30}
        timeslots={2}
        min={new Date(0, 0, 0, 8, 0)}
        max={new Date(0, 0, 0, 20, 0)}
        formats={{
          dayHeaderFormat: (date: Date) => format(date, 'EEE d MMM', { locale: it }),
          dayRangeHeaderFormat: ({ start, end }: { start: Date; end: Date }) =>
            `${format(start, 'd MMM', { locale: it })} – ${format(end, 'd MMM yyyy', { locale: it })}`,
        }}
      />
    </div>
  );
}
