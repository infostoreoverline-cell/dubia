
# BioTwin Dubia v2

> Gestione intelligente delle colonie di *Blaptica dubia* — gemello digitale locale con Cloud Anchor.

## Stack

| Layer | Tecnologia |
|---|---|
| Frontend | HTML + CSS + Vanilla JS |
| Database locale | IndexedDB (transazionale, 500MB+) |
| Cloud Anchor | Supabase (PostgreSQL) |
| Hosting | Vercel (statico, gratuito) |
| Offline | Service Worker (cache-first) |

## Setup Supabase (obbligatorio per il Cloud Anchor)

1. Crea un account su [supabase.com](https://supabase.com)
2. **New Project** → scegli nome e password
3. Vai su **SQL Editor** → **New Query**
4. Incolla il contenuto di [`supabase_schema.sql`](./supabase_schema.sql) e premi **Run**
5. Vai su **Project Settings → API**
6. Copia:
   - **Project URL** → incolla in `cloud_anchor.js` riga 7
   - **anon public key** → incolla in `cloud_anchor.js` riga 8

```js
// cloud_anchor.js — righe 7-8
const SUPABASE_URL      = 'https://XXXXXXXXXXXX.supabase.co';  // ← qui
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIs...';           // ← qui
```

## Deploy su Vercel

```bash
# 1. Inizializza repo Git nella cartella del progetto
git init
git add .
git commit -m "BioTwin Dubia v2 — initial release"

# 2. Pusha su GitHub
git remote add origin https://github.com/TUO_USERNAME/biotwin-dubia.git
git push -u origin main

# 3. Vai su vercel.com → Import Project → seleziona il repo
# Framework Preset: Other (static site)
# Build Command: (vuoto)
# Output Directory: ./ (root)
# → Deploy
```

## Funzionalità

### 🟢🟡🔴 Semaforo Colonie
Ogni colonia mostra lo stato visivo:
- **Verde** — crescita in linea con la curva Auburn
- **Giallo** — scostamento rilevato / pesata scaduta
- **Arancio** — sex ratio sbilanciato / sovraffollamento
- **Rosso** — SOS: calo peso >10% in 5 giorni

### 🧠 Apprendimento Adattivo
- **Fase Calibrazione** (prime 8 pesate): usa i dati teorici Auburn come baseline
- **Fase Adattiva**: calcola un fattore correttivo basato sulla storia reale del tuo allevamento

### ☁️ Cloud Anchor (BAP)
- Ogni write viene sincronizzato silenziosamente su Supabase
- Funziona offline: la coda viene svuotata automaticamente al ritorno della connessione
- **Self-Healing**: se il database locale è vuoto (reset browser, nuovo dispositivo), i dati vengono ripristinati automaticamente da Supabase

### 🛡️ Safety Gate
Le azioni distruttive richiedono conferma esplicita — alcune richiedono di digitare una parola chiave.

### ⚗️ Gut-Loading Timer
Protocollo in 2 fasi (fonte: Auburn University):
1. Digiuno 24h
2. Ca-Loading 7 giorni (Ca:P da 0.26:1 a 2.0:1)

## Struttura File

```
├── index.html           # Shell SPA
├── style.css            # Design system Mac-dark
├── dubia_db.js          # IndexedDB ORM (transazionale)
├── dubia_core.js        # Motore biologico (Brooks-Dyar, Przibram, Kalman)
├── dubia_app.js         # Controller UI
├── cloud_anchor.js      # Supabase sync + Self-Healing
├── manifest.json        # PWA manifest
├── sw.js                # Service Worker
└── supabase_schema.sql  # Schema da eseguire su Supabase
```

## Modello Biologico

| Algoritmo | Fonte | Uso |
|---|---|---|
| Brooks-Dyar | Auburn Univ. | Crescita dimensionale per instar |
| Regola di Przibram | Przibram 1931 | Massa × 2 per instar |
| Degree-Day | Entomologia termica | Previsione data muta |
| Q10 scaling | Fisiologia | Correzione temperatura |
| Adaptive learning | Bayesiano semplificato | Calibrazione su dati reali |

## Licenza

MIT — uso libero per allevatori professionali e hobbisti.
