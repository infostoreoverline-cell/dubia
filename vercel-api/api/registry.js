// api/registry.js — API per la gestione dei sensori (sensor_registry)
// ─────────────────────────────────────────────────────────────────────────────
// Metodi:
// - GET: Ritorna la lista di tutti i sensori
// - POST: Aggiorna la configurazione di un sensore (o di più sensori)
// ─────────────────────────────────────────────────────────────────────────────

import { ensureSheetsInitialized, readSheetAsObjects, updateRowByKey, SHEETS } from '../lib/sheets.js';

export default async function handler(req, res) {
  try {
    await ensureSheetsInitialized();

    // ── GET: Ritorna tutti i sensori ──────────────────────────────────────────
    if (req.method === 'GET') {
      const sensors = await readSheetAsObjects(SHEETS.REGISTRY.name);
      
      // Converte tipi di dato per il frontend (stringhe di sheets -> bool/float)
      const formattedSensors = sensors.map(s => ({
        ...s,
        temp_min: s.temp_min ? parseFloat(s.temp_min) : null,
        temp_max: s.temp_max ? parseFloat(s.temp_max) : null,
        hum_min: s.hum_min ? parseFloat(s.hum_min) : null,
        hum_max: s.hum_max ? parseFloat(s.hum_max) : null,
        active: s.active === 'TRUE' || s.active === true || s.active === 'true'
      }));

      return res.status(200).json(formattedSensors);
    }

    // ── POST: Aggiorna configurazione sensore ────────────────────────────────
    if (req.method === 'POST') {
      const updates = Array.isArray(req.body) ? req.body : [req.body];
      
      let successCount = 0;
      const errors = [];

      for (const update of updates) {
        if (!update.device_id) {
          errors.push({ update, error: 'device_id mancante' });
          continue;
        }

        // Filtriamo le chiavi da aggiornare ignorando device_id e le convertiamo in stringhe per Sheets
        const fieldsToUpdate = {};
        for (const [key, value] of Object.entries(update)) {
          if (key === 'device_id') continue;
          if (SHEETS.REGISTRY.headers.includes(key)) {
             // Gestione bool per fogli google
             if (typeof value === 'boolean') {
               fieldsToUpdate[key] = value ? 'TRUE' : 'FALSE';
             } else {
               fieldsToUpdate[key] = value === null ? '' : String(value);
             }
          }
        }

        if (Object.keys(fieldsToUpdate).length > 0) {
          const updated = await updateRowByKey(
            SHEETS.REGISTRY.name,
            update.device_id,
            fieldsToUpdate,
            SHEETS.REGISTRY.headers
          );

          if (updated) {
            successCount++;
          } else {
            errors.push({ device_id: update.device_id, error: 'Sensore non trovato nel registro' });
          }
        }
      }

      return res.status(200).json({
        success: successCount > 0,
        updated: successCount,
        errors: errors.length > 0 ? errors : undefined
      });
    }

    // Altri metodi non supportati
    return res.status(405).json({ error: 'Metodo non consentito. Usa GET o POST.' });

  } catch (error) {
    console.error('[Registry API] Errore:', error);
    return res.status(500).json({ error: 'Errore interno', details: error.message });
  }
}
