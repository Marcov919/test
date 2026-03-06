# Decision Maker Scraper

Trova automaticamente CEO, CTO, CFO e altri executive nelle **100 aziende piu' fighe del momento** (AI, Fintech, Biotech, Spazio, Robotics, ecc.).

## Come funziona

### Fase 1 — Trova i decision maker (3 strategie in cascata)

1. **Leadership page** — visita `/about`, `/team`, `/leadership` del sito aziendale e analizza le person card con BeautifulSoup
2. **DuckDuckGo search** — cerca `"Azienda" CEO OR CTO site:linkedin.com/in` e parsa i risultati pubblici
3. **Crunchbase** — scraping della pagina `/organization/<slug>/people`

Se una strategia trova >=3 persone, le successive vengono saltate per velocizzare.

### Fase 2 — Trova le email (3 strategie in cascata)

1. **Hunter.io API** (opzionale, piano gratuito: 25 ricerche/mese) — email verificate
2. **Scraping diretto** — cerca email esplicite nelle pagine `/contact`, `/press`, `/about`
3. **Pattern generation** — inferisce il formato email dal dominio (es. `nome.cognome@azienda.com`) e genera il candidato piu' probabile. Le email generate sono marcate con `[pattern]` per distinguerle da quelle verificate.

## Setup

```bash
# Dipendenze Python
pip install -r requirements.txt
```

### (Opzionale) Hunter.io per email verificate

Hunter.io ha un **piano gratuito con 25 ricerche/mese**. Per attivarlo:

1. Registrati su hunter.io (gratis)
2. Copia la tua API Key dalla dashboard
3. Crea un file `.env` nella cartella del progetto:

```
HUNTER_API_KEY=la_tua_chiave_qui
```

Senza Hunter.io il tool funziona lo stesso, ma le email sono generate da pattern (meno affidabili).

## Uso

```bash
# Scrapa tutte le 100 aziende, stampa a schermo
python main.py

# Solo le prime 5 aziende (ottimo per testare)
python main.py --limit 5

# Solo settore AI
python main.py --sector AI

# Cerca una specifica azienda
python main.py --company Stripe

# Salva in CSV (apribile con Excel / Google Sheets)
python main.py --out results.csv

# Salva in JSON
python main.py --out results.json

# Solo leadership page (no DuckDuckGo, no Crunchbase)
python main.py --no-ddg --no-cb

# Senza Hunter.io (usa solo scraping + pattern email)
python main.py --no-hunter

# Log dettagliato
python main.py --verbose

# Lista settori disponibili
python main.py --list-sectors

# Lista delle 100 aziende
python main.py --list-companies
```

## Output

Ogni decision maker trovato include:

| Campo | Descrizione |
|-------|-------------|
| `name` | Nome completo |
| `title` | Titolo (CEO, CTO, VP Engineering, ...) |
| `company` | Nome azienda |
| `domain` | Dominio aziendale |
| `sector` | Settore (AI, Fintech, ...) |
| `email` | Email (verificata o generata da pattern — le pattern hanno `[pattern]` in fondo) |
| `linkedin_url` | URL profilo LinkedIn (se trovato) |
| `source_url` | URL sorgente dello scraping |
| `source` | Strategia usata (`leadership_page`, `duckduckgo_search`, `crunchbase`) |

## Settori coperti

| Settore | # Aziende |
|---------|-----------|
| AI | 22 |
| DevTools | 10 |
| Fintech | 10 |
| Biotech / HealthTech | 10 |
| CleanTech / EV | 10 |
| Robotics | 5 |
| Security | 5 |
| Space | 5 |
| Consumer / Social / Media | 8 |
| Crypto | 5 |
| Productivity | 10 |

## Note legali

Questo tool scrapa solo dati **pubblicamente accessibili**. Rispetta sempre:
- `robots.txt` dei siti target
- Rate limiting (delay random tra 1.5–3.5s tra ogni richiesta)
- I Termini di Servizio di LinkedIn e Crunchbase per uso commerciale
