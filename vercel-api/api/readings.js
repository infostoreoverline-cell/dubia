// api/readings.js — API per leggere i dati grezzi dei sensori
// ─────────────────────────────────────────────────────────────────────────────
// Metodi:
// - GET: Ritorna le letture. Supporta query params:
//   - device_id: Filtra per sensore
//   - limit: Numero massimo di record (default 1000)
// ─────────────────────────────────────────────────────────────────────────────

import { ensureSheetsInitialized, readSheetAsObjects, SHEETS } from '../lib/sheets.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Metodo non consentito. Usa GET.' });
  }

  try {
    await ensureSheetsInitialized();

    const limit = parseInt(req.query.limit, 10) || 1000;
    const deviceId = req.query.device_id;

    let readings = await readSheetAsObjects(SHEETS.READINGS.name);

    // Filtra per device se richiesto
    if (deviceId) {
      readings = readings.filter(r => r.device_id === deviceId);
    }

    // I dati in Google Sheets sono appesi in fondo (i più recenti sono alla fine).
    // Ne prendiamo gli ultimi 'limit' invertendo l'ordine (i più recenti per primi).
    readings = readings.slice(-limit).reverse();

    // Cast dei tipi
    const formattedReadings = readings.map(r => ({
      ...r,
      temp_c: parseFloat(r.temp_c),
      humidity_pct: parseFloat(r.humidity_pct),
      seq_index: parseInt(r.seq_index, 10)
    }));

    return res.status(200).json(formattedReadings);

  } catch (error) {
    console.error('[Readings API] Errore:', error);
    return res.status(500).json({ error: 'Errore interno', details: error.message });
  }
}
