export interface Patient {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  date_of_birth: string | null;
  address: string | null;
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface Appointment {
  id: string;
  patient_id: string;
  title: string;
  start_time: string;
  end_time: string;
  description: string;
  status: 'scheduled' | 'completed' | 'cancelled' | 'no-show';
  first_name: string;
  last_name: string;
  phone: string | null;
  email: string | null;
  created_at: string;
  updated_at: string;
}

export interface PatientFile {
  id: string;
  patient_id: string;
  filename: string;
  original_name: string;
  file_type: string;
  file_size: number;
  description: string;
  uploaded_at: string;
}

export interface FinancialRecord {
  id: string;
  patient_id: string;
  appointment_id: string | null;
  appointment_title: string | null;
  description: string;
  amount: number;
  type: 'charge' | 'payment';
  date: string;
  created_at: string;
}

export interface FinancialSummary {
  records: FinancialRecord[];
  totalCharged: number;
  totalPaid: number;
  balance: number;
}

export type AppView = 'calendar' | 'patients';
