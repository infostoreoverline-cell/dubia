/**
 * ============================================================================
 *  D.U.B.I.A. — /api/ingest (Vercel Serverless Function)
 *
 *  Bridge ESP8266 firmware → Google Apps Script backend.
 *
 *  Il firmware (termoigrometro_v2) invia un POST CSV ogni ~1h con le
 *  letture accumulate del sensore SHT40:
 *    - Body:   testo CSV, righe "t10,h10\n"
 *    - Header: Content-Type: text/csv
 *    - Header: X-Device-ID: <MAC address ESP8266>
 *
 *  Questo endpoint:
 *    1. Legge il body CSV e lo parsea in coppie {t10, h10}
 *    2. Valida device_id dall'header X-Device-ID
 *    3. Invia un POST JSON al GAS con event_type='termoigrometro_data'
 *    4. Risponde 200 OK al firmware (o codice di errore)
 * ============================================================================
 */

// URL Google Apps Script — aggiornare dopo ogni re-deploy GAS.
const GAS_ENDPOINT = 'https://script.google.com/macros/s/AKfycbzgWLeWQRhkFFVo3mLi2pyQQOhWIZsGx7x8a3yjxI6pOhyhMt-YlDbiTjc1ruwk3bzr3A/exec';

const MAX_RETRIES       = 3;
const RETRY_BASE_DELAY  = 1000; // ms

async function postToGAS(payload) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(GAS_ENDPOINT, {
        method: 'POST',
        redirect: 'follow',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error(HTTP  );
      const json = await res.json();
      if (json.status === 'error') throw new Error('GAS error: ' + json.message);
      return { ok: true, data: json };
    } catch (err) {
      if (attempt === MAX_RETRIES) return { ok: false, error: err.message };
      await new Promise(r => setTimeout(r, RETRY_BASE_DELAY * Math.pow(2, attempt)));
    }
  }
}

export default async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Device-ID');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'Method Not Allowed. Use POST.' });
  }

  const deviceId = (req.headers['x-device-id'] || '').trim() || 'unknown';

  // Leggi body raw (il firmware invia text/csv come stream)
  let rawBody = '';
  try {
    if (typeof req.body === 'string') {
      rawBody = req.body;
    } else if (Buffer.isBuffer(req.body)) {
      rawBody = req.body.toString('utf8');
    } else {
      rawBody = await new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => { data += chunk.toString('utf8'); });
        req.on('end', () => resolve(data));
        req.on('error', reject);
      });
    }
  } catch (err) {
    return res.status(400).json({ status: 'error', message: 'Impossibile leggere il body: ' + err.message });
  }

  if (!rawBody || !rawBody.trim()) {
    return res.status(400).json({ status: 'error', message: 'Body vuoto.' });
  }

  // Parsa CSV: ogni riga = "t10,h10"
  const lines = rawBody.trim().split(/\r?\n/);
  const readings = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(',');
    if (parts.length < 2) { console.warn('[ingest] Riga non valida:', trimmed); continue; }
    const t10 = parseInt(parts[0], 10);
    const h10 = parseInt(parts[1], 10);
    if (isNaN(t10) || isNaN(h10)) { console.warn('[ingest] Valori NaN:', parts[0], parts[1]); continue; }
    const tempC  = t10 / 10.0;
    const humPct = h10 / 10.0;
    if (tempC < -40 || tempC > 125 || humPct < 0 || humPct > 100) { console.warn('[ingest] Fuori range: T=' + tempC + ' H=' + humPct); continue; }
    readings.push({ t10, h10 });
  }

  if (readings.length === 0) {
    return res.status(400).json({ status: 'error', message: 'Nessuna lettura valida nel CSV (' + lines.length + ' righe totali).' });
  }

  console.log('[ingest] Device=' + deviceId + ' | Letture valide: ' + readings.length + '/' + lines.length);

  const payload = {
    event_type: 'termoigrometro_data',
    device_id:  deviceId,
    readings:   readings
  };

  const result = await postToGAS(payload);

  if (!result.ok) {
    console.error('[ingest] Errore GAS:', result.error);
    return res.status(502).json({ status: 'error', message: 'Errore forwarding GAS: ' + result.error });
  }

  console.log('[ingest] GAS OK:', result.data && result.data.message);
  return res.status(200).json({
    status:    'success',
    message:   readings.length + ' letture inoltrate al database.',
    device_id: deviceId,
    written:   (result.data && result.data.written) || readings.length
  });
}
