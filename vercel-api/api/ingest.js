// api/ingest.js — Ricezione dati da ESP8266
// ─────────────────────────────────────────────────────────────────────────────
// Metodo: POST
// Content-Type: text/csv
// Header Richiesto: X-Device-ID (es. ESP-A3F2)
//
// Flusso:
// 1. Legge il CSV raw dal body
// 2. Parsea le righe (t10,h10) e converte in float
// 3. Genera un batch_id e timestamp
// 4. Salva in `sensor_readings`
// 5. Aggiorna il `last_seen` nel `sensor_registry`
// ─────────────────────────────────────────────────────────────────────────────

import { ensureSheetsInitialized, appendRows, updateRowByKey, upsertRow, SHEETS } from '../lib/sheets.js';

export default async function handler(req, res) {
  // CORS (anche se gestito dal vercel.json, per sicurezza)
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Metodo non consentito. Usa POST.' });
  }

  try {
    // 1. Estrai l'header Device ID
    const deviceId = req.headers['x-device-id'] || req.headers['x-device'];
    if (!deviceId) {
      return res.status(400).json({ error: 'Manca l\'header X-Device-ID' });
    }

    // 2. Leggi il body raw (Vercel lo passa come Buffer/String se non è JSON)
    const rawBody = req.body;
    if (!rawBody) {
      return res.status(400).json({ error: 'Body vuoto' });
    }

    const csvData = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    
    // Assicurati che i fogli esistano e abbiano gli header
    await ensureSheetsInitialized();

    const timestamp = new Date().toISOString();
    const batchId = `${deviceId}_${timestamp.replace(/[:.-]/g, '')}`;
    
    // 3. Parsea il CSV e prepara le righe per Google Sheets
    const lines = csvData.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const rowsToAppend = [];
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const parts = line.split(',');
      if (parts.length >= 2) {
        const t10 = parseInt(parts[0], 10);
        const h10 = parseInt(parts[1], 10);
        
        if (!isNaN(t10) && !isNaN(h10)) {
          // Converte da x10 a float
          const tempC = t10 / 10.0;
          const humPct = h10 / 10.0;
          
          // Header: ['timestamp_received', 'device_id', 'temp_c', 'humidity_pct', 'seq_index', 'batch_id']
          rowsToAppend.push([
            timestamp,
            deviceId,
            tempC,
            humPct,
            i + 1,
            batchId
          ]);
        }
      }
    }

    if (rowsToAppend.length === 0) {
      return res.status(400).json({ error: 'Nessun dato valido trovato nel CSV' });
    }

    // 4. Salva in sensor_readings
    await appendRows(SHEETS.READINGS.name, rowsToAppend);

    // 5. Aggiorna o crea il sensore nel registro
    // Usiamo updateRowByKey, se fallisce (sensore nuovo), facciamo un upsert base
    const updated = await updateRowByKey(
      SHEETS.REGISTRY.name,
      deviceId,
      { last_seen: timestamp },
      SHEETS.REGISTRY.headers
    );

    if (!updated) {
      // Nuovo sensore mai visto prima, lo registriamo con dati di default
      // Header: ['device_id', 'display_name', 'terrario_id', 'terrario_name', 'temp_min', 'temp_max', 'hum_min', 'hum_max', 'active', 'group_tag', 'last_seen', 'notes']
      const newSensorRow = [
        deviceId,
        `Nuovo Sensore (${deviceId})`, // display_name
        '', // terrario_id
        '', // terrario_name
        '', '', '', '', // soglie min/max vuote
        true, // active
        '', // group_tag
        timestamp, // last_seen
        'Aggiunto automaticamente alla prima connessione' // notes
      ];
      await upsertRow(SHEETS.REGISTRY.name, newSensorRow, deviceId);
    }

    return res.status(200).json({
      success: true,
      message: `Ricevute e salvate ${rowsToAppend.length} letture.`,
      batch_id: batchId
    });

  } catch (error) {
    console.error('[Ingest API] Errore:', error);
    return res.status(500).json({ error: 'Errore interno del server', details: error.message });
  }
}
