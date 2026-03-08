const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../database');

// GET all patients
router.get('/', (req, res) => {
  const { search } = req.query;
  let query = 'SELECT * FROM patients ORDER BY last_name, first_name';
  let params = [];

  if (search) {
    query = `SELECT * FROM patients WHERE
      lower(first_name) LIKE lower(?) OR
      lower(last_name) LIKE lower(?) OR
      lower(email) LIKE lower(?) OR
      phone LIKE ?
      ORDER BY last_name, first_name`;
    const term = `%${search}%`;
    params = [term, term, term, term];
  }

  const patients = db.prepare(query).all(...params);
  res.json(patients);
});

// GET single patient
router.get('/:id', (req, res) => {
  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(req.params.id);
  if (!patient) return res.status(404).json({ error: 'Paziente non trovato' });
  res.json(patient);
});

// POST create patient
router.post('/', (req, res) => {
  const { first_name, last_name, email, phone, date_of_birth, address, notes } = req.body;
  if (!first_name || !last_name) {
    return res.status(400).json({ error: 'Nome e cognome sono obbligatori' });
  }

  const id = uuidv4();
  db.prepare(`
    INSERT INTO patients (id, first_name, last_name, email, phone, date_of_birth, address, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, first_name, last_name, email || null, phone || null, date_of_birth || null, address || null, notes || '');

  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(id);
  res.status(201).json(patient);
});

// PUT update patient
router.put('/:id', (req, res) => {
  const { first_name, last_name, email, phone, date_of_birth, address, notes } = req.body;
  const patient = db.prepare('SELECT id FROM patients WHERE id = ?').get(req.params.id);
  if (!patient) return res.status(404).json({ error: 'Paziente non trovato' });

  db.prepare(`
    UPDATE patients SET
      first_name = ?, last_name = ?, email = ?, phone = ?,
      date_of_birth = ?, address = ?, notes = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(first_name, last_name, email || null, phone || null, date_of_birth || null, address || null, notes || '', req.params.id);

  const updated = db.prepare('SELECT * FROM patients WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// DELETE patient
router.delete('/:id', (req, res) => {
  const patient = db.prepare('SELECT id FROM patients WHERE id = ?').get(req.params.id);
  if (!patient) return res.status(404).json({ error: 'Paziente non trovato' });
  db.prepare('DELETE FROM patients WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// GET patient appointments
router.get('/:id/appointments', (req, res) => {
  const appointments = db.prepare(`
    SELECT a.*, p.first_name, p.last_name
    FROM appointments a
    JOIN patients p ON a.patient_id = p.id
    WHERE a.patient_id = ?
    ORDER BY a.start_time DESC
  `).all(req.params.id);
  res.json(appointments);
});

// GET patient files
router.get('/:id/files', (req, res) => {
  const files = db.prepare('SELECT * FROM patient_files WHERE patient_id = ? ORDER BY uploaded_at DESC').all(req.params.id);
  res.json(files);
});

// GET patient financial summary
router.get('/:id/financials', (req, res) => {
  const records = db.prepare(`
    SELECT f.*, a.title as appointment_title
    FROM financial_records f
    LEFT JOIN appointments a ON f.appointment_id = a.id
    WHERE f.patient_id = ?
    ORDER BY f.date DESC
  `).all(req.params.id);

  const totalCharged = records.filter(r => r.type === 'charge').reduce((s, r) => s + r.amount, 0);
  const totalPaid = records.filter(r => r.type === 'payment').reduce((s, r) => s + r.amount, 0);
  const balance = totalCharged - totalPaid;

  res.json({ records, totalCharged, totalPaid, balance });
});

// POST add financial record
router.post('/:id/financials', (req, res) => {
  const { description, amount, type, date, appointment_id } = req.body;
  if (!description || !amount || !type || !date) {
    return res.status(400).json({ error: 'Campi obbligatori mancanti' });
  }

  const id = uuidv4();
  db.prepare(`
    INSERT INTO financial_records (id, patient_id, appointment_id, description, amount, type, date)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.params.id, appointment_id || null, description, parseFloat(amount), type, date);

  const record = db.prepare('SELECT * FROM financial_records WHERE id = ?').get(id);
  res.status(201).json(record);
});

// DELETE financial record
router.delete('/:patientId/financials/:recordId', (req, res) => {
  db.prepare('DELETE FROM financial_records WHERE id = ? AND patient_id = ?').run(req.params.recordId, req.params.patientId);
  res.json({ success: true });
});

module.exports = router;
