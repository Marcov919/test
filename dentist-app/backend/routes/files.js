const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../database');

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|pdf|dcm|doc|docx|txt/;
    const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
    if (allowed.test(ext)) cb(null, true);
    else cb(new Error('Tipo file non supportato'));
  },
});

// POST upload file for patient
router.post('/patients/:patientId/files', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nessun file caricato' });

  const patient = db.prepare('SELECT id FROM patients WHERE id = ?').get(req.params.patientId);
  if (!patient) {
    fs.unlinkSync(req.file.path);
    return res.status(404).json({ error: 'Paziente non trovato' });
  }

  const id = uuidv4();
  db.prepare(`
    INSERT INTO patient_files (id, patient_id, filename, original_name, file_type, file_size, description)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    req.params.patientId,
    req.file.filename,
    req.file.originalname,
    req.file.mimetype,
    req.file.size,
    req.body.description || ''
  );

  const fileRecord = db.prepare('SELECT * FROM patient_files WHERE id = ?').get(id);
  res.status(201).json(fileRecord);
});

// GET download/view file
router.get('/files/:fileId', (req, res) => {
  const fileRecord = db.prepare('SELECT * FROM patient_files WHERE id = ?').get(req.params.fileId);
  if (!fileRecord) return res.status(404).json({ error: 'File non trovato' });

  const filePath = path.join(UPLOADS_DIR, fileRecord.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File non trovato su disco' });

  res.setHeader('Content-Disposition', `inline; filename="${fileRecord.original_name}"`);
  res.setHeader('Content-Type', fileRecord.file_type);
  res.sendFile(filePath);
});

// DELETE file
router.delete('/files/:fileId', (req, res) => {
  const fileRecord = db.prepare('SELECT * FROM patient_files WHERE id = ?').get(req.params.fileId);
  if (!fileRecord) return res.status(404).json({ error: 'File non trovato' });

  const filePath = path.join(UPLOADS_DIR, fileRecord.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  db.prepare('DELETE FROM patient_files WHERE id = ?').run(req.params.fileId);
  res.json({ success: true });
});

module.exports = router;
