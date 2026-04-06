import { useState } from 'react';
import { Patient } from '../types';
import { createPatient } from '../api';

interface Props {
  onClose: () => void;
  onSaved: (p: Patient) => void;
}

export default function PatientModal({ onClose, onSaved }: Props) {
  const [form, setForm] = useState({
    first_name: '', last_name: '', email: '', phone: '',
    date_of_birth: '', address: '', notes: '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const patient = await createPatient(form);
      onSaved(patient);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Errore');
    } finally {
      setLoading(false);
    }
  }

  const field = (label: string, key: keyof typeof form, type = 'text', placeholder = '') => (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <input type={type} value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
        placeholder={placeholder}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-6 border-b border-gray-100">
          <h2 className="text-xl font-semibold text-gray-800">Nuovo Paziente</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">&times;</button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            {field('Nome *', 'first_name', 'text', 'Mario')}
            {field('Cognome *', 'last_name', 'text', 'Rossi')}
          </div>
          {field('Email', 'email', 'email', 'mario@example.com')}
          {field('Telefono', 'phone', 'tel', '333-1234567')}
          {field('Data di nascita', 'date_of_birth', 'date')}
          {field('Indirizzo', 'address', 'text', 'Via Roma 1, Milano')}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Note iniziali</label>
            <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              rows={3} placeholder="Allergie, anamnesi, note particolari..."
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
          </div>

          {error && <div className="bg-red-50 text-red-700 text-sm px-3 py-2 rounded-lg border border-red-200">{error}</div>}

          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose}
              className="flex-1 py-2.5 border border-gray-300 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50 transition-colors">
              Annulla
            </button>
            <button type="submit" disabled={loading || !form.first_name || !form.last_name}
              className="flex-1 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors">
              {loading ? 'Creazione...' : 'Crea Paziente'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
