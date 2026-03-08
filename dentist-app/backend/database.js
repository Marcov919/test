const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'dentist.db'));

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS patients (
      id TEXT PRIMARY KEY,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      date_of_birth TEXT,
      address TEXT,
      notes TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS appointments (
      id TEXT PRIMARY KEY,
      patient_id TEXT NOT NULL,
      title TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT DEFAULT 'scheduled',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS patient_files (
      id TEXT PRIMARY KEY,
      patient_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      file_type TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      description TEXT DEFAULT '',
      uploaded_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS financial_records (
      id TEXT PRIMARY KEY,
      patient_id TEXT NOT NULL,
      appointment_id TEXT,
      description TEXT NOT NULL,
      amount REAL NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('charge', 'payment')),
      date TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE,
      FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE SET NULL
    );
  `);

  // Seed demo data if empty
  const patientCount = db.prepare('SELECT COUNT(*) as count FROM patients').get();
  if (patientCount.count === 0) {
    seedDemoData();
  }
}

function seedDemoData() {
  const { v4: uuidv4 } = require('uuid');

  const patients = [
    { id: uuidv4(), first_name: 'Mario', last_name: 'Rossi', email: 'mario.rossi@email.it', phone: '333-1234567', date_of_birth: '1980-05-15', address: 'Via Roma 12, Milano', notes: 'Paziente con sensibilità al freddo. Allergia alla penicillina.' },
    { id: uuidv4(), first_name: 'Giulia', last_name: 'Bianchi', email: 'giulia.bianchi@email.it', phone: '347-9876543', date_of_birth: '1992-08-23', address: 'Via Garibaldi 45, Roma', notes: 'Porta apparecchio ortodontico. Controllo ogni 3 mesi.' },
    { id: uuidv4(), first_name: 'Luca', last_name: 'Verdi', email: 'luca.verdi@email.it', phone: '328-5556666', date_of_birth: '1975-11-30', address: 'Corso Italia 8, Torino', notes: 'Bruxismo notturno. Ha il bite.' },
  ];

  const insertPatient = db.prepare(`
    INSERT INTO patients (id, first_name, last_name, email, phone, date_of_birth, address, notes)
    VALUES (@id, @first_name, @last_name, @email, @phone, @date_of_birth, @address, @notes)
  `);

  patients.forEach(p => insertPatient.run(p));

  const now = new Date();
  const appointments = [
    {
      id: uuidv4(), patient_id: patients[0].id,
      title: 'Pulizia dentale', description: 'Igiene orale professionale',
      start_time: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0).toISOString(),
      end_time: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 10, 0).toISOString(),
      status: 'scheduled'
    },
    {
      id: uuidv4(), patient_id: patients[1].id,
      title: 'Controllo ortodonzia', description: 'Controllo mensile apparecchio',
      start_time: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2, 11, 0).toISOString(),
      end_time: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2, 11, 30).toISOString(),
      status: 'scheduled'
    },
    {
      id: uuidv4(), patient_id: patients[2].id,
      title: 'Devitalizzazione', description: 'Trattamento canalare molare superiore',
      start_time: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 3, 15, 0).toISOString(),
      end_time: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 3, 17, 0).toISOString(),
      status: 'scheduled'
    },
    {
      id: uuidv4(), patient_id: patients[0].id,
      title: 'Otturazione', description: 'Otturazione composita dente 26',
      start_time: new Date(now.getFullYear(), now.getMonth(), now.getDate() - 5, 10, 0).toISOString(),
      end_time: new Date(now.getFullYear(), now.getMonth(), now.getDate() - 5, 11, 0).toISOString(),
      status: 'completed'
    },
  ];

  const insertAppointment = db.prepare(`
    INSERT INTO appointments (id, patient_id, title, description, start_time, end_time, status)
    VALUES (@id, @patient_id, @title, @description, @start_time, @end_time, @status)
  `);
  appointments.forEach(a => insertAppointment.run(a));

  // Financial records
  const financials = [
    { id: uuidv4(), patient_id: patients[0].id, appointment_id: appointments[3].id, description: 'Otturazione composita', amount: 180, type: 'charge', date: new Date(now.getFullYear(), now.getMonth(), now.getDate() - 5).toISOString().split('T')[0] },
    { id: uuidv4(), patient_id: patients[0].id, appointment_id: null, description: 'Pagamento parziale', amount: 100, type: 'payment', date: new Date(now.getFullYear(), now.getMonth(), now.getDate() - 4).toISOString().split('T')[0] },
    { id: uuidv4(), patient_id: patients[1].id, appointment_id: null, description: 'Apparecchio ortodontico', amount: 2500, type: 'charge', date: new Date(now.getFullYear(), now.getMonth() - 3, 10).toISOString().split('T')[0] },
    { id: uuidv4(), patient_id: patients[1].id, appointment_id: null, description: 'Prima rata', amount: 500, type: 'payment', date: new Date(now.getFullYear(), now.getMonth() - 3, 10).toISOString().split('T')[0] },
    { id: uuidv4(), patient_id: patients[1].id, appointment_id: null, description: 'Seconda rata', amount: 500, type: 'payment', date: new Date(now.getFullYear(), now.getMonth() - 2, 10).toISOString().split('T')[0] },
    { id: uuidv4(), patient_id: patients[1].id, appointment_id: null, description: 'Terza rata', amount: 500, type: 'payment', date: new Date(now.getFullYear(), now.getMonth() - 1, 10).toISOString().split('T')[0] },
    { id: uuidv4(), patient_id: patients[2].id, appointment_id: null, description: 'Visita specialistica + radiografia', amount: 150, type: 'charge', date: new Date(now.getFullYear(), now.getMonth(), now.getDate() - 15).toISOString().split('T')[0] },
    { id: uuidv4(), patient_id: patients[2].id, appointment_id: null, description: 'Pagamento visita', amount: 150, type: 'payment', date: new Date(now.getFullYear(), now.getMonth(), now.getDate() - 15).toISOString().split('T')[0] },
  ];

  const insertFinancial = db.prepare(`
    INSERT INTO financial_records (id, patient_id, appointment_id, description, amount, type, date)
    VALUES (@id, @patient_id, @appointment_id, @description, @amount, @type, @date)
  `);
  financials.forEach(f => insertFinancial.run(f));
}

module.exports = { db, initDatabase };
