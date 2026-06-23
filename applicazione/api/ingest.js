const GAS_URL = "https://script.google.com/macros/s/AKfycbzmrROPiLBIWt9qDsno9BKb_fWvPcmmH2xtp5UAHg4anQGOdd03U5IP6QjDnpsiB04NNA/exec";

// Helper per estrarre il body grezzo
async function getRawBody(req) {
  if (typeof req.body === 'string') {
    return req.body;
  }
  if (Buffer.isBuffer(req.body)) {
    return req.body.toString('utf8');
  }
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
    });
    req.on('end', () => {
      resolve(data);
    });
    req.on('error', err => {
      reject(err);
    });
  });
}

module.exports = async (req, res) => {
  // Gestione CORS e metodi preflight
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Device-ID');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'Method not allowed. Use POST.' });
  }

  try {
    // 1. Estrai Device ID (MAC Address)
    const sensorId = req.headers['x-device-id'] || req.headers['X-Device-ID'];
    if (!sensorId) {
      return res.status(400).json({ status: 'error', message: 'Missing X-Device-ID header' });
    }

    // 2. Leggi il body in formato CSV
    const csvContent = await getRawBody(req);
    if (!csvContent || csvContent.trim() === '') {
      return res.status(400).json({ status: 'error', message: 'Empty body' });
    }

    // 3. Parsa il CSV (formato: temp10,hum10 per riga)
    const lines = csvContent.split('\n');
    const parsedReadings = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue; // Salta righe vuote

      const parts = line.split(',');
      if (parts.length < 2) {
        console.warn(`[Ingest] Riga non valida saltata: "${line}"`);
        continue;
      }

      const tempVal = parseInt(parts[0], 10);
      const humVal = parseInt(parts[1], 10);

      if (isNaN(tempVal) || isNaN(humVal)) {
        console.warn(`[Ingest] Valori numerici non validi nella riga: "${line}"`);
        continue;
      }

      // Conversione diretta da moltiplicato per 10 a decimale
      const temperature = tempVal / 10.0;
      const humidity = humVal / 10.0;

      parsedReadings.push({
        temp: temperature,
        hum: humidity
      });
    }

    if (parsedReadings.length === 0) {
      return res.status(400).json({ status: 'error', message: 'No valid data parsed from CSV' });
    }

    // 4. Ricostruisci i timestamp a ritroso di 1 minuto per riga a partire da ora (Date.now())
    const receiptTime = Date.now();
    const totalReadings = parsedReadings.length;

    const readingsWithTimestamp = parsedReadings.map((reading, index) => {
      // Se abbiamo N letture a intervalli di 1 minuto, l'ultima (index = N-1) è a receiptTime,
      // la penultima (index = N-2) è a receiptTime - 1m, ecc.
      const timestampMs = receiptTime - (totalReadings - 1 - index) * 60 * 1000;
      return {
        timestamp: new Date(timestampMs).toISOString(),
        temp: reading.temp,
        hum: reading.hum
      };
    });

    // 5. Prepara il payload per Google Apps Script
    const gasPayload = {
      event_type: 'sensor_batch',
      sensor_id: sensorId,
      readings: readingsWithTimestamp
    };

    // 6. Invia il payload a Google Apps Script
    console.log(`[Ingest] Invio batch di ${totalReadings} letture per sensore ${sensorId} a Google Apps Script...`);
    const gasResponse = await fetch(GAS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(gasPayload)
    });

    if (!gasResponse.ok) {
      throw new Error(`Google Apps Script HTTP Error: ${gasResponse.status}`);
    }

    const gasJson = await gasResponse.json();
    if (gasJson.status === 'error') {
      throw new Error(`Google Apps Script Error: ${gasJson.message}`);
    }

    // 7. Rispondi con successo all'ESP8266 (predisposto per futuri comandi bidirezionali)
    return res.status(200).json({
      status: 'success',
      message: `Successfully uploaded ${totalReadings} readings`,
      commands: [] // L'array commands è pronto per ospitare comandi inviati all'ESP
    });

  } catch (err) {
    console.error('[Ingest] Error during processing:', err);
    return res.status(500).json({
      status: 'error',
      message: err.message || 'Internal server error'
    });
  }
};
