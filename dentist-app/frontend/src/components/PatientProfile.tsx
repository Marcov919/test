import { useCallback, useEffect, useRef, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { Appointment, Patient, PatientFile } from '../types';
import { deleteFile, getFileUrl, getPatient, getPatientAppointments, getPatientFiles, updatePatient, uploadFile } from '../api';
import FinancialSection from './FinancialSection';

interface Props {
  patientId: string;
  onClose: () => void;
  onNewAppointment?: (patientId: string) => void;
}

const STATUS_COLORS: Record<string, string> = {
  scheduled: 'bg-blue-100 text-blue-700',
  completed: 'bg-green-100 text-green-700',
  cancelled: 'bg-gray-100 text-gray-600',
  'no-show': 'bg-red-100 text-red-700',
};
const STATUS_LABELS: Record<string, string> = {
  scheduled: 'Programmato',
  completed: 'Completato',
  cancelled: 'Annullato',
  'no-show': 'Non presentato',
};

function FileIcon({ type }: { type: string }) {
  if (type.includes('image')) return <span>🖼️</span>;
  if (type.includes('pdf')) return <span>📄</span>;
  return <span>📎</span>;
}

function formatBytes(b: number) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / (1024 * 1024)).toFixed(1) + ' MB';
}

export default function PatientProfile({ patientId, onClose, onNewAppointment }: Props) {
  const [patient, setPatient] = useState<Patient | null>(null);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [files, setFiles] = useState<PatientFile[]>([]);
  const [activeTab, setActiveTab] = useState<'info' | 'files' | 'appointments'>('info');
  const [showFinancials, setShowFinancials] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<Partial<Patient>>({});
  const [saving, setSaving] = useState(false);
  const [uploadDesc, setUploadDesc] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const notesRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    try {
      const [p, a, f] = await Promise.all([getPatient(patientId), getPatientAppointments(patientId), getPatientFiles(patientId)]);
      setPatient(p);
      setEditForm(p);
      setAppointments(a);
      setFiles(f);
    } catch { setError('Errore nel caricamento'); }
  }, [patientId]);

  useEffect(() => { load(); }, [load]);

  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    if (acceptedFiles.length === 0) return;
    setUploading(true);
    setError('');
    try {
      for (const file of acceptedFiles) {
        await uploadFile(patientId, file, uploadDesc);
      }
      setUploadDesc('');
      const f = await getPatientFiles(patientId);
      setFiles(f);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Errore upload');
    } finally {
      setUploading(false);
    }
  }, [patientId, uploadDesc]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'image/*': [], 'application/pdf': [], 'text/*': [] },
    maxSize: 20 * 1024 * 1024,
  });

  async function handleSave() {
    if (!patient) return;
    setSaving(true);
    setError('');
    try {
      const updated = await updatePatient(patientId, editForm);
      setPatient(updated);
      setEditing(false);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Errore');
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteFile(fileId: string, name: string) {
    if (!confirm(`Eliminare il file "${name}"?`)) return;
    try {
      await deleteFile(fileId);
      setFiles(f => f.filter(x => x.id !== fileId));
    } catch { setError('Errore eliminazione file'); }
  }

  async function handleNotesBlur() {
    if (!patient || editForm.notes === patient.notes) return;
    try {
      const updated = await updatePatient(patientId, { ...patient, notes: editForm.notes });
      setPatient(updated);
    } catch { setError('Errore salvataggio note'); }
  }

  if (!patient) return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-2xl p-8 text-gray-500">
        {error || 'Caricamento...'}
      </div>
    </div>
  );

  const initials = `${patient.first_name[0]}${patient.last_name[0]}`.toUpperCase();
  const upcoming = appointments.filter(a => a.status === 'scheduled');
  const past = appointments.filter(a => a.status !== 'scheduled');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">

        {/* Header */}
        <div className="bg-gradient-to-r from-blue-600 to-blue-700 p-6 text-white">
          <div className="flex items-start gap-4">
            <div className="w-16 h-16 bg-white/20 rounded-2xl flex items-center justify-center text-2xl font-bold backdrop-blur-sm">
              {initials}
            </div>
            <div className="flex-1">
              {editing ? (
                <div className="grid grid-cols-2 gap-2">
                  <input value={editForm.first_name || ''} onChange={e => setEditForm(f => ({ ...f, first_name: e.target.value }))}
                    placeholder="Nome" className="bg-white/20 text-white placeholder-white/70 border border-white/30 rounded-lg px-2 py-1 text-sm focus:outline-none" />
                  <input value={editForm.last_name || ''} onChange={e => setEditForm(f => ({ ...f, last_name: e.target.value }))}
                    placeholder="Cognome" className="bg-white/20 text-white placeholder-white/70 border border-white/30 rounded-lg px-2 py-1 text-sm focus:outline-none" />
                </div>
              ) : (
                <h2 className="text-2xl font-bold">{patient.first_name} {patient.last_name}</h2>
              )}
              <div className="text-blue-100 text-sm mt-1">
                {patient.email && <span>{patient.email}</span>}
                {patient.email && patient.phone && <span className="mx-2">·</span>}
                {patient.phone && <span>{patient.phone}</span>}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {editing ? (
                <>
                  <button onClick={handleSave} disabled={saving}
                    className="bg-white text-blue-700 text-xs px-3 py-1.5 rounded-lg font-medium hover:bg-blue-50 disabled:opacity-50 transition-colors">
                    {saving ? '...' : 'Salva'}
                  </button>
                  <button onClick={() => { setEditing(false); setEditForm(patient); }}
                    className="bg-white/20 text-white text-xs px-3 py-1.5 rounded-lg hover:bg-white/30 transition-colors">
                    Annulla
                  </button>
                </>
              ) : (
                <button onClick={() => setEditing(true)}
                  className="bg-white/20 text-white text-xs px-3 py-1.5 rounded-lg hover:bg-white/30 transition-colors">
                  ✏️ Modifica
                </button>
              )}
              <button onClick={onClose} className="text-white/70 hover:text-white text-2xl leading-none ml-2">&times;</button>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex gap-1 mt-4">
            {(['info', 'files', 'appointments'] as const).map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)}
                className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${activeTab === tab ? 'bg-white text-blue-700' : 'text-white/80 hover:bg-white/20'}`}>
                {tab === 'info' ? 'Dati' : tab === 'files' ? `File (${files.length})` : `Appuntamenti (${appointments.length})`}
              </button>
            ))}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {error && <div className="bg-red-50 text-red-700 text-sm px-3 py-2 rounded-lg mb-4 border border-red-200">{error}</div>}

          {activeTab === 'info' && (
            <div className="space-y-5">
              {/* Contact info */}
              <div className="grid grid-cols-2 gap-4">
                {[
                  { label: 'Email', field: 'email', type: 'email' },
                  { label: 'Telefono', field: 'phone', type: 'tel' },
                  { label: 'Data di nascita', field: 'date_of_birth', type: 'date' },
                  { label: 'Indirizzo', field: 'address', type: 'text' },
                ].map(({ label, field, type }) => (
                  <div key={field}>
                    <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">{label}</label>
                    {editing ? (
                      <input type={type} value={(editForm as Record<string, string>)[field] || ''}
                        onChange={e => setEditForm(f => ({ ...f, [field]: e.target.value }))}
                        className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
                    ) : (
                      <div className="text-sm text-gray-800">{(patient as unknown as Record<string, string>)[field] || '—'}</div>
                    )}
                  </div>
                ))}
              </div>

              {/* Notes */}
              <div>
                <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Note cliniche</label>
                <textarea
                  ref={notesRef}
                  value={editForm.notes || ''}
                  onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))}
                  onBlur={handleNotesBlur}
                  rows={4}
                  placeholder="Allergie, anamnesi, note particolari..."
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 resize-none bg-gray-50"
                />
                <p className="text-xs text-gray-400 mt-1">Le note vengono salvate automaticamente quando esci dal campo</p>
              </div>

              {/* Financial section - hidden behind button */}
              <div className="border border-gray-200 rounded-xl overflow-hidden">
                <button
                  onClick={() => setShowFinancials(s => !s)}
                  className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 transition-colors text-left">
                  <div className="flex items-center gap-2">
                    <span className="text-gray-600">💰</span>
                    <span className="font-medium text-gray-700 text-sm">Dati Finanziari</span>
                  </div>
                  <span className={`text-gray-400 transition-transform text-lg ${showFinancials ? 'rotate-180' : ''}`}>▾</span>
                </button>
                {showFinancials && (
                  <div className="p-4 border-t border-gray-200">
                    <FinancialSection patientId={patientId} />
                  </div>
                )}
              </div>

              {onNewAppointment && (
                <button onClick={() => onNewAppointment(patientId)}
                  className="w-full py-2.5 bg-blue-600 text-white rounded-xl text-sm font-medium hover:bg-blue-700 transition-colors">
                  + Nuovo Appuntamento
                </button>
              )}
            </div>
          )}

          {activeTab === 'files' && (
            <div className="space-y-4">
              {/* Upload area */}
              <div>
                <input type="text" placeholder="Descrizione file (opzionale)" value={uploadDesc}
                  onChange={e => setUploadDesc(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-2 focus:outline-none focus:ring-2 focus:ring-blue-400" />
                <div {...getRootProps()} className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors ${isDragActive ? 'border-blue-400 bg-blue-50' : 'border-gray-200 hover:border-blue-300 hover:bg-gray-50'}`}>
                  <input {...getInputProps()} />
                  <div className="text-3xl mb-2">📁</div>
                  {uploading ? (
                    <p className="text-sm text-blue-600">Caricamento in corso...</p>
                  ) : isDragActive ? (
                    <p className="text-sm text-blue-600 font-medium">Rilascia i file qui</p>
                  ) : (
                    <>
                      <p className="text-sm text-gray-600 font-medium">Trascina file qui o clicca per selezionare</p>
                      <p className="text-xs text-gray-400 mt-1">Immagini, PDF, documenti — max 20MB</p>
                    </>
                  )}
                </div>
              </div>

              {/* File list */}
              {files.length === 0 ? (
                <div className="text-center py-8 text-gray-400 text-sm">Nessun file caricato</div>
              ) : (
                <div className="space-y-2">
                  {files.map(file => (
                    <div key={file.id} className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl border border-gray-200 hover:bg-gray-100 transition-colors">
                      <div className="text-2xl"><FileIcon type={file.file_type} /></div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-gray-800 truncate">{file.original_name}</div>
                        {file.description && <div className="text-xs text-gray-500">{file.description}</div>}
                        <div className="text-xs text-gray-400">
                          {formatBytes(file.file_size)} · {new Date(file.uploaded_at).toLocaleDateString('it-IT')}
                        </div>
                      </div>
                      <div className="flex gap-1">
                        <a href={getFileUrl(file.id)} target="_blank" rel="noopener noreferrer"
                          className="text-xs text-blue-600 hover:underline px-2 py-1 rounded hover:bg-blue-50 transition-colors">
                          Apri
                        </a>
                        <button onClick={() => handleDeleteFile(file.id, file.original_name)}
                          className="text-xs text-red-500 hover:text-red-700 px-2 py-1 rounded hover:bg-red-50 transition-colors">
                          ✕
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'appointments' && (
            <div className="space-y-4">
              {onNewAppointment && (
                <button onClick={() => onNewAppointment(patientId)}
                  className="w-full py-2.5 border-2 border-dashed border-blue-300 text-blue-600 rounded-xl text-sm font-medium hover:bg-blue-50 transition-colors">
                  + Nuovo Appuntamento
                </button>
              )}

              {upcoming.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Prossimi appuntamenti</h4>
                  <div className="space-y-2">
                    {upcoming.map(a => (
                      <AppointmentCard key={a.id} appointment={a} />
                    ))}
                  </div>
                </div>
              )}

              {past.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Storico</h4>
                  <div className="space-y-2">
                    {past.map(a => (
                      <AppointmentCard key={a.id} appointment={a} />
                    ))}
                  </div>
                </div>
              )}

              {appointments.length === 0 && (
                <div className="text-center py-8 text-gray-400 text-sm">Nessun appuntamento registrato</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function AppointmentCard({ appointment: a }: { appointment: Appointment }) {
  const start = new Date(a.start_time);
  const end = new Date(a.end_time);
  return (
    <div className="flex items-start gap-3 p-3 bg-white border border-gray-200 rounded-xl">
      <div className="text-center min-w-[40px]">
        <div className="text-xs text-gray-400">{start.toLocaleDateString('it-IT', { weekday: 'short' })}</div>
        <div className="text-lg font-bold text-gray-800 leading-tight">{start.getDate()}</div>
        <div className="text-xs text-gray-400">{start.toLocaleDateString('it-IT', { month: 'short' })}</div>
      </div>
      <div className="flex-1">
        <div className="font-medium text-gray-800 text-sm">{a.title}</div>
        <div className="text-xs text-gray-500">
          {start.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })} – {end.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}
        </div>
        {a.description && <div className="text-xs text-gray-400 mt-0.5">{a.description}</div>}
      </div>
      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[a.status] || ''}`}>
        {STATUS_LABELS[a.status] || a.status}
      </span>
    </div>
  );
}
