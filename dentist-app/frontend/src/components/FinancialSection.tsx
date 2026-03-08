import { useEffect, useState } from 'react';
import { FinancialRecord, FinancialSummary } from '../types';
import { addFinancialRecord, deleteFinancialRecord, getFinancials } from '../api';

interface Props {
  patientId: string;
}

export default function FinancialSection({ patientId }: Props) {
  const [summary, setSummary] = useState<FinancialSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ description: '', amount: '', type: 'charge' as 'charge' | 'payment', date: new Date().toISOString().split('T')[0] });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = () => {
    setLoading(true);
    getFinancials(patientId)
      .then(setSummary)
      .catch(() => setError('Errore nel caricamento dei dati finanziari'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [patientId]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await addFinancialRecord(patientId, { ...form, amount: parseFloat(form.amount) });
      setForm({ description: '', amount: '', type: 'charge', date: new Date().toISOString().split('T')[0] });
      setShowForm(false);
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Errore');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(record: FinancialRecord) {
    if (!confirm(`Eliminare la voce "${record.description}"?`)) return;
    try {
      await deleteFinancialRecord(patientId, record.id);
      load();
    } catch { setError('Errore durante la eliminazione'); }
  }

  function getFrequencyInfo(records: FinancialRecord[]) {
    const payments = records.filter(r => r.type === 'payment').sort((a, b) => a.date.localeCompare(b.date));
    if (payments.length < 2) return null;
    const intervals: number[] = [];
    for (let i = 1; i < payments.length; i++) {
      const a = new Date(payments[i - 1].date).getTime();
      const b = new Date(payments[i].date).getTime();
      intervals.push((b - a) / (1000 * 60 * 60 * 24));
    }
    const avg = Math.round(intervals.reduce((s, n) => s + n, 0) / intervals.length);
    if (avg <= 7) return 'Settimanale';
    if (avg <= 35) return 'Mensile';
    if (avg <= 100) return 'Trimestrale';
    return `Ogni ~${avg} giorni`;
  }

  if (loading) return <div className="text-center py-8 text-gray-400">Caricamento...</div>;

  const freq = summary ? getFrequencyInfo(summary.records) : null;

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      {summary && (
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-red-50 border border-red-100 rounded-xl p-3 text-center">
            <div className="text-xs text-red-500 font-medium uppercase tracking-wide mb-1">Da pagare</div>
            <div className="text-xl font-bold text-red-600">€{summary.balance.toFixed(2)}</div>
          </div>
          <div className="bg-green-50 border border-green-100 rounded-xl p-3 text-center">
            <div className="text-xs text-green-600 font-medium uppercase tracking-wide mb-1">Pagato</div>
            <div className="text-xl font-bold text-green-700">€{summary.totalPaid.toFixed(2)}</div>
          </div>
          <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 text-center">
            <div className="text-xs text-blue-600 font-medium uppercase tracking-wide mb-1">Totale addebitato</div>
            <div className="text-xl font-bold text-blue-700">€{summary.totalCharged.toFixed(2)}</div>
          </div>
        </div>
      )}

      {freq && (
        <div className="flex items-center gap-2 px-3 py-2 bg-amber-50 border border-amber-100 rounded-lg text-sm">
          <span className="text-amber-600">🔄</span>
          <span className="text-amber-700">Frequenza pagamenti: <strong>{freq}</strong></span>
        </div>
      )}

      {/* Add record */}
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-gray-600 uppercase tracking-wide">Movimenti</h4>
        <button onClick={() => setShowForm(s => !s)}
          className="text-xs bg-blue-600 text-white px-3 py-1.5 rounded-lg hover:bg-blue-700 transition-colors">
          {showForm ? 'Annulla' : '+ Aggiungi'}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleAdd} className="bg-gray-50 rounded-xl p-4 space-y-3 border border-gray-200">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Tipo</label>
              <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value as 'charge' | 'payment' }))}
                className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400">
                <option value="charge">Addebito</option>
                <option value="payment">Pagamento</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Importo (€)</label>
              <input type="number" step="0.01" min="0" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
                required placeholder="0.00"
                className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Descrizione</label>
            <input type="text" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              required placeholder="es. Otturazione, Prima rata..."
              className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Data</label>
            <input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
              required className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
          </div>
          {error && <div className="text-red-600 text-xs">{error}</div>}
          <button type="submit" disabled={saving}
            className="w-full py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
            {saving ? 'Salvataggio...' : 'Salva movimento'}
          </button>
        </form>
      )}

      {/* Records list */}
      {summary && summary.records.length === 0 ? (
        <div className="text-center py-6 text-gray-400 text-sm">Nessun movimento registrato</div>
      ) : (
        <div className="space-y-2">
          {summary?.records.map(record => (
            <div key={record.id} className={`flex items-start gap-3 p-3 rounded-xl border ${record.type === 'charge' ? 'bg-red-50 border-red-100' : 'bg-green-50 border-green-100'}`}>
              <div className={`mt-0.5 text-lg ${record.type === 'charge' ? 'text-red-500' : 'text-green-600'}`}>
                {record.type === 'charge' ? '↑' : '↓'}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-gray-800">{record.description}</div>
                {record.appointment_title && (
                  <div className="text-xs text-gray-500">Visita: {record.appointment_title}</div>
                )}
                <div className="text-xs text-gray-400">{new Date(record.date).toLocaleDateString('it-IT')}</div>
              </div>
              <div className="flex items-center gap-2">
                <span className={`font-bold text-sm ${record.type === 'charge' ? 'text-red-600' : 'text-green-700'}`}>
                  {record.type === 'charge' ? '-' : '+'}€{record.amount.toFixed(2)}
                </span>
                <button onClick={() => handleDelete(record)}
                  className="text-gray-300 hover:text-red-500 text-lg leading-none transition-colors">&times;</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
