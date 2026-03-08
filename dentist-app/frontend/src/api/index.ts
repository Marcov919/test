import { Appointment, FinancialRecord, FinancialSummary, Patient, PatientFile } from '../types';

const BASE = '/api';

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(BASE + url, options);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Errore di rete');
  }
  return res.json();
}

// Patients
export const getPatients = (search?: string) =>
  request<Patient[]>(`/patients${search ? `?search=${encodeURIComponent(search)}` : ''}`);

export const getPatient = (id: string) => request<Patient>(`/patients/${id}`);

export const createPatient = (data: Partial<Patient>) =>
  request<Patient>('/patients', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

export const updatePatient = (id: string, data: Partial<Patient>) =>
  request<Patient>(`/patients/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

export const deletePatient = (id: string) =>
  request<{ success: boolean }>(`/patients/${id}`, { method: 'DELETE' });

// Appointments
export const getAppointments = (from?: string, to?: string) => {
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const qs = params.toString();
  return request<Appointment[]>(`/appointments${qs ? `?${qs}` : ''}`);
};

export const getPatientAppointments = (patientId: string) =>
  request<Appointment[]>(`/patients/${patientId}/appointments`);

export const createAppointment = (data: Partial<Appointment>) =>
  request<Appointment>('/appointments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

export const updateAppointment = (id: string, data: Partial<Appointment>) =>
  request<Appointment>(`/appointments/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

export const deleteAppointment = (id: string) =>
  request<{ success: boolean }>(`/appointments/${id}`, { method: 'DELETE' });

// Files
export const getPatientFiles = (patientId: string) =>
  request<PatientFile[]>(`/patients/${patientId}/files`);

export const uploadFile = async (patientId: string, file: File, description: string): Promise<PatientFile> => {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('description', description);
  const res = await fetch(`${BASE}/patients/${patientId}/files`, { method: 'POST', body: formData });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Errore upload');
  }
  return res.json();
};

export const deleteFile = (fileId: string) =>
  request<{ success: boolean }>(`/files/${fileId}`, { method: 'DELETE' });

export const getFileUrl = (fileId: string) => `${BASE}/files/${fileId}`;

// Financials
export const getFinancials = (patientId: string) =>
  request<FinancialSummary>(`/patients/${patientId}/financials`);

export const addFinancialRecord = (patientId: string, data: Partial<FinancialRecord>) =>
  request<FinancialRecord>(`/patients/${patientId}/financials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

export const deleteFinancialRecord = (patientId: string, recordId: string) =>
  request<{ success: boolean }>(`/patients/${patientId}/financials/${recordId}`, { method: 'DELETE' });
