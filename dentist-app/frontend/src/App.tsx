import { useCallback, useEffect, useState } from 'react';
import { Appointment } from './types';
import { deleteAppointment, getAppointments } from './api';
import CalendarView from './components/CalendarView';
import AppointmentModal from './components/AppointmentModal';
import PatientProfile from './components/PatientProfile';
import PatientsView from './components/PatientsView';
import PatientModal from './components/PatientModal';
import Chatbot from './components/Chatbot';

type View = 'calendar' | 'patients';
type Modal = 'appointment' | 'newAppointment' | 'patient' | 'newPatient' | null;

interface AppointmentDetailProps {
  appointment: Appointment;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onOpenPatient: () => void;
}

function AppointmentDetail({ appointment: a, onClose, onEdit, onDelete, onOpenPatient }: AppointmentDetailProps) {
  const start = new Date(a.start_time);
  const end = new Date(a.end_time);
  const duration = Math.round((end.getTime() - start.getTime()) / 60000);

  const statusColors: Record<string, string> = {
    scheduled: 'bg-blue-100 text-blue-700 border-blue-200',
    completed: 'bg-green-100 text-green-700 border-green-200',
    cancelled: 'bg-gray-100 text-gray-600 border-gray-200',
    'no-show': 'bg-red-100 text-red-700 border-red-200',
  };
  const statusLabels: Record<string, string> = {
    scheduled: 'Programmato',
    completed: 'Completato',
    cancelled: 'Annullato',
    'no-show': 'Non presentato',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
        <div className="bg-gradient-to-r from-blue-600 to-blue-700 p-5 text-white">
          <div className="flex items-start justify-between">
            <div>
              <div className="text-xs text-blue-200 uppercase tracking-wide mb-1">Appuntamento</div>
              <h3 className="text-lg font-bold">{a.title}</h3>
            </div>
            <button onClick={onClose} className="text-white/70 hover:text-white text-2xl leading-none">&times;</button>
          </div>
          <span className={`inline-block mt-2 text-xs px-2 py-0.5 rounded-full font-medium border ${statusColors[a.status] || ''} bg-white/20 text-white border-white/30`}>
            {statusLabels[a.status] || a.status}
          </span>
        </div>

        <div className="p-5 space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-blue-100 rounded-lg flex items-center justify-center text-sm">👤</div>
            <div>
              <div className="font-semibold text-gray-800">{a.first_name} {a.last_name}</div>
              {a.phone && <div className="text-xs text-gray-500">{a.phone}</div>}
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-blue-100 rounded-lg flex items-center justify-center text-sm">📅</div>
            <div>
              <div className="font-medium text-gray-800 text-sm">
                {start.toLocaleDateString('it-IT', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
              </div>
              <div className="text-xs text-gray-500">
                {start.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })} – {end.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })} ({duration} min)
              </div>
            </div>
          </div>

          {a.description && (
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 bg-blue-100 rounded-lg flex items-center justify-center text-sm mt-0.5">📝</div>
              <div className="text-sm text-gray-600">{a.description}</div>
            </div>
          )}

          <div className="flex gap-2 pt-2">
            <button onClick={onOpenPatient}
              className="flex-1 py-2 border border-blue-200 text-blue-700 rounded-xl text-sm font-medium hover:bg-blue-50 transition-colors">
              👤 Profilo
            </button>
            <button onClick={onEdit}
              className="flex-1 py-2 bg-blue-600 text-white rounded-xl text-sm font-medium hover:bg-blue-700 transition-colors">
              ✏️ Modifica
            </button>
            <button onClick={onDelete}
              className="px-3 py-2 text-red-500 border border-red-200 rounded-xl hover:bg-red-50 transition-colors text-sm">
              🗑️
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [view, setView] = useState<View>('calendar');
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [modal, setModal] = useState<Modal>(null);
  const [selectedAppointment, setSelectedAppointment] = useState<Appointment | null>(null);
  const [selectedPatientId, setSelectedPatientId] = useState<string | null>(null);
  const [defaultStart, setDefaultStart] = useState<Date | undefined>();
  const [editingAppointment, setEditingAppointment] = useState<Appointment | null>(null);
  const [newAppointmentPatientId, setNewAppointmentPatientId] = useState<string | null>(null);

  const loadAppointments = useCallback(async () => {
    try {
      const data = await getAppointments();
      setAppointments(data);
    } catch (e) {
      console.error('Failed to load appointments', e);
    }
  }, []);

  useEffect(() => { loadAppointments(); }, [loadAppointments]);

  function handleSelectSlot(start: Date, end: Date) {
    setDefaultStart(start);
    setEditingAppointment(null);
    setNewAppointmentPatientId(null);
    setModal('newAppointment');
  }

  function handleSelectAppointment(appointment: Appointment) {
    setSelectedAppointment(appointment);
    setModal('appointment');
  }

  function handleEditAppointment() {
    setEditingAppointment(selectedAppointment);
    setSelectedAppointment(null);
    setModal('newAppointment');
  }

  async function handleDeleteAppointment() {
    if (!selectedAppointment) return;
    if (!confirm('Eliminare questo appuntamento?')) return;
    await deleteAppointment(selectedAppointment.id);
    setSelectedAppointment(null);
    setModal(null);
    loadAppointments();
  }

  function handleOpenPatientFromAppointment() {
    if (!selectedAppointment) return;
    setSelectedPatientId(selectedAppointment.patient_id);
    setSelectedAppointment(null);
    setModal('patient');
  }

  function handleOpenPatient(id: string) {
    setSelectedPatientId(id);
    setModal('patient');
  }

  function handleNewAppointmentForPatient(patientId: string) {
    setNewAppointmentPatientId(patientId);
    setEditingAppointment(null);
    setDefaultStart(undefined);
    setSelectedPatientId(null);
    setModal('newAppointment');
  }

  function closeAll() {
    setModal(null);
    setSelectedAppointment(null);
    setSelectedPatientId(null);
    setEditingAppointment(null);
    setNewAppointmentPatientId(null);
    setDefaultStart(undefined);
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Top Navigation */}
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="text-2xl">🦷</div>
          <div>
            <h1 className="text-lg font-bold text-gray-900 leading-tight">DentalManager</h1>
            <p className="text-xs text-gray-400">Gestionale Studio Dentistico</p>
          </div>
        </div>

        <nav className="flex items-center gap-1 bg-gray-100 rounded-xl p-1">
          <button onClick={() => setView('calendar')}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${view === 'calendar' ? 'bg-white text-blue-700 shadow-sm' : 'text-gray-600 hover:text-gray-800'}`}>
            📅 Calendario
          </button>
          <button onClick={() => setView('patients')}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${view === 'patients' ? 'bg-white text-blue-700 shadow-sm' : 'text-gray-600 hover:text-gray-800'}`}>
            👥 Pazienti
          </button>
        </nav>

        <button
          onClick={() => { setEditingAppointment(null); setDefaultStart(undefined); setNewAppointmentPatientId(null); setModal('newAppointment'); }}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-xl text-sm font-medium transition-colors shadow-sm">
          <span className="text-base leading-none">+</span>
          Nuovo Appuntamento
        </button>
      </header>

      {/* Main content */}
      <main className="flex-1 p-6 overflow-hidden">
        {view === 'calendar' ? (
          <div className="h-full bg-white rounded-2xl shadow-sm border border-gray-200 p-4" style={{ height: 'calc(100vh - 140px)' }}>
            <CalendarView
              appointments={appointments}
              onSelectSlot={handleSelectSlot}
              onSelectAppointment={handleSelectAppointment}
            />
          </div>
        ) : (
          <div style={{ height: 'calc(100vh - 140px)' }}>
            <PatientsView
              onOpenPatient={handleOpenPatient}
              onNewPatient={() => setModal('newPatient')}
            />
          </div>
        )}
      </main>

      {/* Legend (calendar view only) */}
      {view === 'calendar' && (
        <div className="flex items-center gap-4 px-6 pb-4 text-xs text-gray-500">
          {[
            { color: '#3b82f6', label: 'Programmato' },
            { color: '#10b981', label: 'Completato' },
            { color: '#9ca3af', label: 'Annullato' },
            { color: '#ef4444', label: 'Non presentato' },
          ].map(({ color, label }) => (
            <div key={label} className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-full" style={{ backgroundColor: color }} />
              <span>{label}</span>
            </div>
          ))}
          <span className="ml-auto text-gray-400">Clicca su uno slot vuoto per creare un appuntamento</span>
        </div>
      )}

      {/* Modals */}
      {modal === 'appointment' && selectedAppointment && (
        <AppointmentDetail
          appointment={selectedAppointment}
          onClose={closeAll}
          onEdit={handleEditAppointment}
          onDelete={handleDeleteAppointment}
          onOpenPatient={handleOpenPatientFromAppointment}
        />
      )}

      {modal === 'newAppointment' && (
        <AppointmentModal
          appointment={editingAppointment}
          defaultStart={defaultStart}
          initialPatientId={newAppointmentPatientId}
          onClose={closeAll}
          onSaved={async () => { closeAll(); await loadAppointments(); }}
          onOpenPatient={id => { closeAll(); handleOpenPatient(id); }}
        />
      )}

      {modal === 'patient' && selectedPatientId && (
        <PatientProfile
          patientId={selectedPatientId}
          onClose={closeAll}
          onNewAppointment={handleNewAppointmentForPatient}
        />
      )}

      {modal === 'newPatient' && (
        <PatientModal
          onClose={closeAll}
          onSaved={() => { closeAll(); }}
        />
      )}

      <Chatbot />

    </div>
  );
}
