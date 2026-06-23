# BioTwin Sensor API (Backend Vercel)

Questo è il backend serverless che riceve i dati dai microcontrollori ESP8266 e li salva su Google Sheets, permettendo alla dashboard BioTwin di leggerli.

## 🚀 Setup e Deploy

1. **Prepara Google Sheets**
   - Vai su Google Cloud Console e crea un nuovo progetto (se non l'hai già fatto)
   - Abilita l'API "Google Sheets API"
   - Crea un **Service Account**, genera una chiave in formato JSON e scaricala
   - Crea un nuovo file Google Sheets vuoto
   - Condividi il file Google Sheets con l'indirizzo email del tuo Service Account (es: `mio-account@mio-progetto.iam.gserviceaccount.com`), assegnandogli il ruolo di **Editor**

2. **Configura le variabili d'ambiente**
   - Clona questo repository/cartella
   - Copia il file `.env.example` in `.env.local`
   - Inserisci lo `SHEET_ID` (lo trovi nell'URL del tuo file Google Sheets: `https://docs.google.com/spreadsheets/d/QUESTO_QUI_E_L_ID/edit`)
   - Inserisci le tue `GOOGLE_CREDENTIALS` (vedi istruzioni nel file `.env.example` su come stringificare il JSON su una sola riga)

3. **Deploy su Vercel**
   - Installa la Vercel CLI (se non ce l'hai): `npm i -g vercel`
   - Esegui `vercel` da dentro questa cartella e segui le istruzioni
   - Quando ha finito, apri la dashboard web di Vercel, vai in **Settings > Environment Variables** e aggiungi `SHEET_ID` e `GOOGLE_CREDENTIALS`
   - Infine, fai un nuovo deploy eseguendo `vercel --prod`

## 📡 API Endpoints

### `POST /api/ingest`
- **Scopo:** Endpoint chiamato dall'ESP8266 per inviare i dati.
- **Header:** `Content-Type: text/csv`, `X-Device-ID: <MAC-ADDRESS>`
- **Body:** Dati CSV (`t10,h10\n`)

### `GET /api/registry`
- **Scopo:** Ritorna l'elenco dei sensori registrati, con nomi, assegnazione terrari e soglie.

### `POST /api/registry`
- **Scopo:** Aggiorna la configurazione di uno o più sensori dal frontend (es. rinomina sensore, riassegna a nuovo terrario).

### `GET /api/readings?device_id=MAC&limit=100`
- **Scopo:** Recupera gli ultimi dati raw letti da un sensore per costruire i grafici sulla dashboard.
