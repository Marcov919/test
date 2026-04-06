# DentalManager 🦷

Gestionale per studio dentistico con calendario appuntamenti, profili pazienti e sezione finanziaria.

## Funzionalità

- **Calendario interattivo** — Viste per mese, settimana, giorno e agenda. Clicca su uno slot vuoto per creare un appuntamento.
- **Profili pazienti** — Dati anagrafici, note cliniche, gestione file (radiografie, documenti).
- **Upload file** — Trascina e rilascia immagini, PDF e documenti nel profilo paziente.
- **Sezione finanziaria** — Nascosta di default, visibile su clic: totale addebitato, pagato, saldo e frequenza pagamenti.
- **Interfacce collegate** — Dal calendario puoi aprire il profilo del paziente; dal profilo puoi creare nuovi appuntamenti.

## Avvio

### Prerequisiti
- Node.js 18+

### Installazione

```bash
cd dentist-app

# Installa dipendenze backend
npm install --prefix backend

# Installa dipendenze frontend
npm install --prefix frontend
```

### Sviluppo (due terminali)

**Terminale 1 — Backend:**
```bash
cd backend
npm run dev
# oppure: node server.js
# Il server parte su http://localhost:3001
```

**Terminale 2 — Frontend:**
```bash
cd frontend
npm run dev
# L'app parte su http://localhost:3000
```

### Produzione

```bash
# Builda il frontend
npm run build --prefix frontend

# Avvia in modalità produzione (serve anche il frontend)
NODE_ENV=production node backend/server.js
# Apri http://localhost:3001
```

## Struttura

```
dentist-app/
├── backend/
│   ├── server.js           # Entry point Express
│   ├── database.js         # SQLite setup + seed dati demo
│   ├── routes/
│   │   ├── patients.js     # CRUD pazienti + file + finanziari
│   │   ├── appointments.js # CRUD appuntamenti
│   │   └── files.js        # Upload/download file
│   ├── uploads/            # File caricati (creata automaticamente)
│   └── dentist.db          # Database SQLite (creato automaticamente)
└── frontend/
    └── src/
        ├── App.tsx                        # Root + navigazione
        ├── components/
        │   ├── CalendarView.tsx           # Calendario react-big-calendar
        │   ├── AppointmentModal.tsx       # Crea/modifica appuntamento
        │   ├── PatientProfile.tsx         # Profilo paziente (dati, file, storico)
        │   ├── FinancialSection.tsx       # Dati finanziari (nascosta)
        │   ├── PatientsView.tsx           # Lista pazienti con ricerca
        │   └── PatientModal.tsx           # Crea nuovo paziente
        ├── api/index.ts                   # Chiamate REST al backend
        └── types/index.ts                 # Tipi TypeScript
```

## Dati demo

Al primo avvio vengono creati automaticamente 3 pazienti con appuntamenti e dati finanziari di esempio.
