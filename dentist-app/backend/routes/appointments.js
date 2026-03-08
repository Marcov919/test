const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../database');

// GET all appointments (with patient info)
router.get('/', (req, res) => {
  const { from, to } = req.query;
  let query = `
    SELECT a.*, p.first_name, p.last_name, p.phone, p.email
    FROM appointments a
    JOIN patients p ON a.patient_id = p.id
    WHERE 1=1
  `;
  const params = [];

  if (from) { query += ' AND a.start_time >= ?'; params.push(from); }
  if (to)   { query += ' AND a.end_time <= ?';   params.push(to); }

  query += ' ORDER BY a.start_time ASC';
  const appointments = db.prepare(query).all(...params);
  res.json(appointments);
});

// GET single appointment
router.get('/:id', (req, res) => {
  const appointment = db.prepare(`
    SELECT a.*, p.first_name, p.last_name, p.phone, p.email
    FROM appointments a
    JOIN patients p ON a.patient_id = p.id
    WHERE a.id = ?
  `).get(req.params.id);
  if (!appointment) return res.status(404).json({ error: 'Appuntamento non trovato' });
  res.json(appointment);
});

// POST create appointment
router.post('/', (req, res) => {
  const { patient_id, title, start_time, end_time, description, status } = req.body;
  if (!patient_id || !title || !start_time || !end_time) {
    return res.status(400).json({ error: 'Campi obbligatori mancanti' });
  }

  const patient = db.prepare('SELECT id FROM patients WHERE id = ?').get(patient_id);
  if (!patient) return res.status(404).json({ error: 'Paziente non trovato' });

  const id = uuidv4();
  db.prepare(`
    INSERT INTO appointments (id, patient_id, title, start_time, end_time, description, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, patient_id, title, start_time, end_time, description || '', status || 'scheduled');

  const appointment = db.prepare(`
    SELECT a.*, p.first_name, p.last_name, p.phone, p.email
    FROM appointments a JOIN patients p ON a.patient_id = p.id WHERE a.id = ?
  `).get(id);
  res.status(201).json(appointment);
});

// PUT update appointment
router.put('/:id', (req, res) => {
  const { title, start_time, end_time, description, status, patient_id } = req.body;
  const existing = db.prepare('SELECT id FROM appointments WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Appuntamento non trovato' });

  db.prepare(`
    UPDATE appointments SET
      title = ?, start_time = ?, end_time = ?,
      description = ?, status = ?, patient_id = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(title, start_time, end_time, description || '', status || 'scheduled', patient_id, req.params.id);

  const appointment = db.prepare(`
    SELECT a.*, p.first_name, p.last_name, p.phone, p.email
    FROM appointments a JOIN patients p ON a.patient_id = p.id WHERE a.id = ?
  `).get(req.params.id);
  res.json(appointment);
});

// DELETE appointment
router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM appointments WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Appuntamento non trovato' });
  db.prepare('DELETE FROM appointments WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
