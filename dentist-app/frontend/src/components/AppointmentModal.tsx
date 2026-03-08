import { useEffect, useState } from 'react';
import { Appointment, Patient } from '../types';
import { createAppointment, getPatients, updateAppointment } from '../api';

interface Props {
  appointment?: Appointment | null;
  defaultStart?: Date;
  initialPatientId?: string | null;
  onClose: () => void;
  onSaved: (a: Appointment) => void;
  onOpenPatient?: (patientId: string) => void;
}

const STATUS_LABELS: Record<string, string> = {
  scheduled: 'Programmato',
  completed: 'Completato',
  cancelled: 'Annullato',
  'no-show': 'Non presentato',
};

export default function AppointmentModal({ appointment, defaultStart, initialPatientId, onClose, onSaved, onOpenPatient }: Props) {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [patientSearch, setPatientSearch] = useState('');
  const [form, setForm] = useState({
    patient_id: appointment?.patient_id || initialPatientId || '',
    title: appointment?.title || '',
    start_time: appointment ? appointment.start_time.slice(0, 16) : (defaultStart ? formatLocal(defaultStart) : ''),
    end_time: appointment ? appointment.end_time.slice(0, 16) : (defaultStart ? formatLocal(new Date(defaultStart.getTime() + 60 * 60000)) : ''),
    description: appointment?.description || '',
    status: appointment?.status || 'scheduled',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  function formatLocal(d: Date) {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  useEffect(() => {
    getPatients().then(setPatients).catch(() => {});
  }, []);

  const filteredPatients = patients.filter(p =>
    `${p.first_name} ${p.last_name}`.toLowerCase().includes(patientSearch.toLowerCase())
  );

  const selectedPatient = patients.find(p => p.id === form.patient_id);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = {
        ...form,
        start_time: new Date(form.start_time).toISOString(),
        end_time: new Date(form.end_time).toISOString(),
      };
      const saved = appointment
        ? await updateAppointment(appointment.id, data)
        : await createAppointment(data);
      onSaved(saved);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Errore');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-6 border-b border-gray-100">
          <h2 className="text-xl font-semibold text-gray-800">
            {appointment ? 'Modifica Appuntamento' : 'Nuovo Appuntamento'}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">&times;</button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {/* Patient selector */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Paziente *</label>
            {selectedPatient ? (
              <div className="flex items-center gap-2 p-3 bg-blue-50 rounded-lg border border-blue-200">
                <div className="w-8 h-8 bg-blue-500 rounded-full flex items-center justify-center text-white text-sm font-bold">
                  {selectedPatient.first_name[0]}{selectedPatient.last_name[0]}
                </div>
                <div className="flex-1">
                  <div className="font-medium text-gray-800">{selectedPatient.first_name} {selectedPatient.last_name}</div>
                  {selectedPatient.phone && <div className="text-xs text-gray-500">{selectedPatient.phone}</div>}
                </div>
                <div className="flex gap-1">
                  {onOpenPatient && (
                    <button type="button" onClick={() => onOpenPatient(selectedPatient.id)}
                      className="text-xs text-blue-600 hover:underline px-2 py-1">
                      Profilo
                    </button>
                  )}
                  <button type="button" onClick={() => setForm(f => ({ ...f, patient_id: '' }))}
                    className="text-xs text-red-500 hover:underline px-2 py-1">
                    Cambia
                  </button>
                </div>
              </div>
            ) : (
              <div>
                <input
                  type="text"
                  placeholder="Cerca paziente..."
                  value={patientSearch}
                  onChange={e => setPatientSearch(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                {patientSearch && (
                  <div className="border border-gray-200 rounded-lg mt-1 max-h-40 overflow-y-auto shadow-sm">
                    {filteredPatients.length === 0 ? (
                      <div className="p-3 text-sm text-gray-500">Nessun paziente trovato</div>
                    ) : filteredPatients.map(p => (
                      <button key={p.id} type="button"
                        onClick={() => { setForm(f => ({ ...f, patient_id: p.id })); setPatientSearch(''); }}
                        className="w-full text-left px-3 py-2 hover:bg-blue-50 text-sm border-b border-gray-100 last:border-0">
                        {p.first_name} {p.last_name}
                        {p.phone && <span className="text-gray-400 ml-2">{p.phone}</span>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Tipo di visita *</label>
            <input type="text" value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
              placeholder="es. Pulizia dentale, Otturazione..."
              required className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Inizio *</label>
              <input type="datetime-local" value={form.start_time} onChange={e => setForm(f => ({ ...f, start_time: e.target.value }))}
                required className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Fine *</label>
              <input type="datetime-local" value={form.end_time} onChange={e => setForm(f => ({ ...f, end_time: e.target.value }))}
                required className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>

          {appointment && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Stato</label>
              <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value as 'scheduled' | 'completed' | 'cancelled' | 'no-show' }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                {Object.entries(STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Note</label>
            <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              rows={3} placeholder="Dettagli sulla visita..."
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
          </div>

          {error && <div className="bg-red-50 text-red-700 text-sm px-3 py-2 rounded-lg border border-red-200">{error}</div>}

          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose}
              className="flex-1 py-2.5 border border-gray-300 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50 transition-colors">
              Annulla
            </button>
            <button type="submit" disabled={loading || !form.patient_id}
              className="flex-1 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
              {loading ? 'Salvataggio...' : (appointment ? 'Aggiorna' : 'Crea Appuntamento')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
