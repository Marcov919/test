const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const { db } = require('../database');

router.post('/', async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message) return res.status(400).json({ error: 'Messaggio mancante' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === 'your_api_key_here') {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY non configurata nel file .env del backend' });
  }

  try {
    const patients = db.prepare('SELECT * FROM patients ORDER BY last_name, first_name').all();
    const appointments = db.prepare(`
      SELECT a.*, p.first_name, p.last_name
      FROM appointments a
      JOIN patients p ON a.patient_id = p.id
      ORDER BY a.start_time
    `).all();
    const financials = db.prepare(`
      SELECT f.*, p.first_name, p.last_name
      FROM financial_records f
      JOIN patients p ON f.patient_id = p.id
      ORDER BY f.date
    `).all();

    const today = new Date().toISOString();

    const systemPrompt = `Sei l'assistente AI di DentalManager, il gestionale per uno studio dentistico.
Hai accesso completo e aggiornato a tutti i dati dello studio: pazienti, appuntamenti e contabilità.
Data e ora attuale: ${today}
Rispondi sempre in italiano, in modo preciso, conciso e utile.

Puoi rispondere a domande come:
- Prossimo/i appuntamento/i di un paziente
- Chi deve ancora pagare e quanto
- Quante e quali cure sono state eseguite in un periodo
- Statistiche generali (totale incassato, pazienti attivi, ecc.)
- Qualsiasi altra informazione presente nei dati

Quando citi importi usa il simbolo €. Quando citi date usa il formato italiano (gg/mm/aaaa).
Nei dati, "charge" = addebito (prestazione), "payment" = pagamento ricevuto.
Il saldo ("balance") di un paziente = totale addebitato - totale pagato. Se positivo, il paziente deve ancora pagare.

=== PAZIENTI ===
${JSON.stringify(patients, null, 2)}

=== APPUNTAMENTI ===
${JSON.stringify(appointments, null, 2)}

=== REGISTRAZIONI FINANZIARIE ===
${JSON.stringify(financials, null, 2)}`;

    const client = new Anthropic({ apiKey });

    const messages = [
      ...history.map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: message },
    ];

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    });

    res.json({ reply: response.content[0].text });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: err.message || 'Errore interno del chatbot' });
  }
});

module.exports = router;
