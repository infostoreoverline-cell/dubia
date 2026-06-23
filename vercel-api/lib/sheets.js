// lib/sheets.js — Google Sheets client riusabile
// ─────────────────────────────────────────────────────────────────────────────
// Questo modulo è il SINGOLO punto di accesso a Google Sheets.
// Tutte le API route importano da qui — nessuna logica di autenticazione
// duplicata, zero accoppiamento diretto con googleapis nelle route.
//
// FOGLI ATTESI (creati automaticamente al primo uso):
//   1. sensor_readings   — dati T/H in arrivo dagli ESP
//   2. sensor_registry   — configurazione sonde (nomi, terrari, soglie)
//   3. terrarium_config  — anagrafica terrari (dinamica)
// ─────────────────────────────────────────────────────────────────────────────

import { google } from 'googleapis';

// ── Nomi e intestazioni fogli ─────────────────────────────────────────────────
export const SHEETS = {
  READINGS: {
    name: 'sensor_readings',
    headers: ['timestamp_received', 'device_id', 'temp_c', 'humidity_pct', 'seq_index', 'batch_id'],
  },
  REGISTRY: {
    name: 'sensor_registry',
    headers: ['device_id', 'display_name', 'terrario_id', 'terrario_name',
              'temp_min', 'temp_max', 'hum_min', 'hum_max',
              'active', 'group_tag', 'last_seen', 'notes'],
  },
  TERRARIA: {
    name: 'terrarium_config',
    headers: ['terrario_id', 'terrario_name', 'group_tag', 'species', 'created_at'],
  },
};

// ── Singleton autenticazione ─────────────────────────────────────────────────
let _sheetsClient = null;

/**
 * Restituisce un client Google Sheets autenticato.
 * Usa le credenziali dalla env var GOOGLE_CREDENTIALS (JSON stringificato).
 */
async function getSheetsClient() {
  if (_sheetsClient) return _sheetsClient;

  const raw = process.env.GOOGLE_CREDENTIALS;
  if (!raw) throw new Error('GOOGLE_CREDENTIALS env var non impostata');

  let creds;
  try {
    creds = JSON.parse(raw);
  } catch {
    throw new Error('GOOGLE_CREDENTIALS non è un JSON valido');
  }

  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  _sheetsClient = google.sheets({ version: 'v4', auth });
  return _sheetsClient;
}

// ── Helper: ottieni lo spreadsheetId dalla env ────────────────────────────────
export function getSpreadsheetId() {
  const id = process.env.SHEET_ID;
  if (!id) throw new Error('SHEET_ID env var non impostata');
  return id;
}

// ── Leggi tutte le righe di un foglio ────────────────────────────────────────
/**
 * @param {string} sheetName — nome del foglio (es. 'sensor_readings')
 * @param {string} range     — range A1 notation opzionale (default: tutto il foglio)
 * @returns {string[][]}     — array di righe (la prima è l'header)
 */
export async function readSheet(sheetName, range = null) {
  const sheets = await getSheetsClient();
  const spreadsheetId = getSpreadsheetId();
  const fullRange = range ? `${sheetName}!${range}` : sheetName;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: fullRange,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });

  return res.data.values || [];
}

// ── Leggi il foglio come array di oggetti ─────────────────────────────────────
/**
 * Legge un foglio e restituisce righe come oggetti JS {chiave: valore}.
 * La prima riga del foglio deve essere l'header.
 */
export async function readSheetAsObjects(sheetName) {
  const rows = await readSheet(sheetName);
  if (rows.length < 1) return [];

  const [headers, ...dataRows] = rows;
  return dataRows.map((row) =>
    Object.fromEntries(headers.map((h, i) => [h, row[i] ?? '']))
  );
}

// ── Appendi righe in fondo a un foglio ────────────────────────────────────────
/**
 * @param {string}   sheetName — nome del foglio
 * @param {string[][]} rows    — array di righe da aggiungere
 */
export async function appendRows(sheetName, rows) {
  if (!rows || rows.length === 0) return;

  const sheets = await getSheetsClient();
  const spreadsheetId = getSpreadsheetId();

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetName}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
}

// ── Aggiorna una singola cella / riga per chiave ──────────────────────────────
/**
 * Cerca una riga nel foglio dove la colonna A corrisponde a `keyValue`,
 * poi aggiorna le colonne indicate con i nuovi valori.
 *
 * @param {string} sheetName
 * @param {string} keyValue       — valore da cercare in colonna A (es. device_id)
 * @param {Object} updates        — { colonna_header: nuovo_valore, ... }
 * @param {string[]} headers      — array di header del foglio (per trovare indice colonna)
 * @returns {boolean}             — true se riga trovata e aggiornata
 */
export async function updateRowByKey(sheetName, keyValue, updates, headers) {
  const sheets = await getSheetsClient();
  const spreadsheetId = getSpreadsheetId();

  // Leggi tutto il foglio per trovare la riga
  const rows = await readSheet(sheetName);
  if (rows.length < 2) return false;

  // Riga 0 è l'header, le righe iniziano da indice 1 (riga 2 nello sheet = index 1 + offset header)
  const rowIndex = rows.findIndex((r, i) => i > 0 && r[0] === keyValue);
  if (rowIndex === -1) return false;

  // rowIndex in array → numero riga nel foglio (1-based, +1 per header)
  const sheetRow = rowIndex + 1;

  // Aggiorna ogni campo richiesto
  const updateRequests = Object.entries(updates).map(([col, val]) => {
    const colIdx = headers.indexOf(col);
    if (colIdx === -1) return null;
    const colLetter = columnToLetter(colIdx);
    return {
      range: `${sheetName}!${colLetter}${sheetRow}`,
      values: [[val]],
    };
  }).filter(Boolean);

  if (updateRequests.length === 0) return false;

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: updateRequests,
    },
  });

  return true;
}

// ── Scrivi (upsert) una riga intera per chiave ────────────────────────────────
/**
 * Se la riga con keyValue in colonna A esiste → la sovrascrive interamente.
 * Altrimenti → la aggiunge in fondo (append).
 *
 * @param {string}   sheetName
 * @param {string[]} rowData    — array di valori nella stessa ordine degli header
 * @param {string}   keyValue   — valore chiave (di solito rowData[0])
 */
export async function upsertRow(sheetName, rowData, keyValue) {
  const sheets = await getSheetsClient();
  const spreadsheetId = getSpreadsheetId();

  const rows = await readSheet(sheetName);
  const rowIndex = rows.findIndex((r, i) => i > 0 && r[0] === keyValue);

  if (rowIndex === -1) {
    // Non trovata → append
    await appendRows(sheetName, [rowData]);
  } else {
    // Trovata → sovrascrittura
    const sheetRow = rowIndex + 1;
    const endCol = columnToLetter(rowData.length - 1);
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!A${sheetRow}:${endCol}${sheetRow}`,
      valueInputOption: 'RAW',
      requestBody: { values: [rowData] },
    });
  }
}

// ── Utility: numero colonna → lettera (0→A, 25→Z, 26→AA) ───────────────────
function columnToLetter(index) {
  let letter = '';
  index += 1; // 1-based
  while (index > 0) {
    const rem = (index - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    index = Math.floor((index - 1) / 26);
  }
  return letter;
}

// ── Inizializzazione fogli (crea header se il foglio è vuoto) ────────────────
/**
 * Chiama questa funzione una volta per assicurarti che i fogli abbiano gli header.
 * Sicuro da chiamare più volte (idempotente).
 */
export async function ensureSheetsInitialized() {
  const sheets = await getSheetsClient();
  const spreadsheetId = getSpreadsheetId();

  // Ottieni lista fogli esistenti
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existingSheets = meta.data.sheets.map((s) => s.properties.title);

  for (const sheetDef of Object.values(SHEETS)) {
    const sheetExists = existingSheets.includes(sheetDef.name);

    if (!sheetExists) {
      // Crea il foglio
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{ addSheet: { properties: { title: sheetDef.name } } }],
        },
      });
    }

    // Controlla se la prima riga ha già l'header
    const firstRow = await readSheet(sheetDef.name, 'A1:Z1');
    if (!firstRow || firstRow.length === 0 || firstRow[0].length === 0) {
      // Scrivi header
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetDef.name}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: [sheetDef.headers] },
      });
    }
  }
}
