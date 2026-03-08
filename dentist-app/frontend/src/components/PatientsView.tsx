import { useEffect, useState } from 'react';
import { Patient } from '../types';
import { deletePatient, getPatients } from '../api';

interface Props {
  onOpenPatient: (id: string) => void;
  onNewPatient: () => void;
}

export default function PatientsView({ onOpenPatient, onNewPatient }: Props) {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  const load = async (q?: string) => {
    setLoading(true);
    try {
      const data = await getPatients(q);
      setPatients(data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  useEffect(() => {
    const t = setTimeout(() => load(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  async function handleDelete(p: Patient) {
    if (!confirm(`Eliminare il paziente ${p.first_name} ${p.last_name}? Tutti i dati associati verranno persi.`)) return;
    await deletePatient(p.id);
    setPatients(ps => ps.filter(x => x.id !== p.id));
  }

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-3 mb-6">
        <div className="relative flex-1">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            placeholder="Cerca per nome, email, telefono..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 border border-gray-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <button onClick={onNewPatient}
          className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2.5 rounded-xl text-sm font-medium hover:bg-blue-700 transition-colors whitespace-nowrap">
          <span className="text-lg leading-none">+</span> Nuovo Paziente
        </button>
      </div>

      {/* List */}
      {loading ? (
        <div className="flex-1 flex items-center justify-center text-gray-400">Caricamento...</div>
      ) : patients.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-gray-400 gap-3">
          <div className="text-5xl">🦷</div>
          <div className="text-lg font-medium">Nessun paziente trovato</div>
          {search && <button onClick={() => setSearch('')} className="text-sm text-blue-600 hover:underline">Cancella ricerca</button>}
          {!search && (
            <button onClick={onNewPatient} className="mt-2 bg-blue-600 text-white px-6 py-2.5 rounded-xl text-sm font-medium hover:bg-blue-700 transition-colors">
              Aggiungi il primo paziente
            </button>
          )}
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {patients.map(p => (
              <PatientCard key={p.id} patient={p} onOpen={onOpenPatient} onDelete={handleDelete} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PatientCard({ patient: p, onOpen, onDelete }: { patient: Patient; onOpen: (id: string) => void; onDelete: (p: Patient) => void }) {
  const initials = `${p.first_name[0]}${p.last_name[0]}`.toUpperCase();
  const colors = [
    'from-blue-500 to-blue-600',
    'from-emerald-500 to-emerald-600',
    'from-violet-500 to-violet-600',
    'from-amber-500 to-amber-600',
    'from-rose-500 to-rose-600',
    'from-cyan-500 to-cyan-600',
  ];
  const color = colors[(p.first_name.charCodeAt(0) + p.last_name.charCodeAt(0)) % colors.length];

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-4 hover:shadow-md hover:border-blue-200 transition-all group">
      <div className="flex items-start gap-3">
        <div className={`w-12 h-12 bg-gradient-to-br ${color} rounded-xl flex items-center justify-center text-white font-bold text-sm flex-shrink-0`}>
          {initials}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-gray-900">{p.first_name} {p.last_name}</div>
          {p.phone && <div className="text-xs text-gray-500 mt-0.5">📞 {p.phone}</div>}
          {p.email && <div className="text-xs text-gray-400 truncate">✉️ {p.email}</div>}
        </div>
      </div>
      {p.notes && (
        <p className="mt-3 text-xs text-gray-500 line-clamp-2 bg-gray-50 rounded-lg px-2 py-1.5">{p.notes}</p>
      )}
      <div className="flex gap-2 mt-3">
        <button onClick={() => onOpen(p.id)}
          className="flex-1 py-1.5 bg-blue-600 text-white text-xs rounded-lg font-medium hover:bg-blue-700 transition-colors">
          Apri Profilo
        </button>
        <button onClick={() => onDelete(p)}
          className="px-3 py-1.5 text-gray-400 hover:text-red-500 text-xs rounded-lg hover:bg-red-50 transition-colors border border-gray-200">
          ✕
        </button>
      </div>
    </div>
  );
}
