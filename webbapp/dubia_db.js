// dubia_db.js — IndexedDB Data Layer
// Transactional, indexed, conflict-free, schema-versioned.

const DB_NAME    = 'BioTwinDubia';
const DB_VERSION = 1;

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA DEFINITION
// ─────────────────────────────────────────────────────────────────────────────
const SCHEMA = {
  enclosures: {
    keyPath: 'id',
    indexes: [
      { name: 'by_deleted',    key: 'deleted' },
      { name: 'by_updated',    key: 'updatedAt' },
    ]
  },
  cohorts: {
    keyPath: 'id',
    indexes: [
      { name: 'by_enclosure',  key: 'enclosureId' },
      { name: 'by_deleted',    key: 'deleted' },
    ]
  },
  measurements: {
    keyPath: 'id',
    indexes: [
      { name: 'by_enclosure',        key: 'enclosureId' },
      { name: 'by_date',             key: 'date' },
      { name: 'by_enclosure_date',   key: ['enclosureId', 'date'], multiEntry: false },
    ]
  },
  events: {
    keyPath: 'id',
    indexes: [
      { name: 'by_enclosure',  key: 'enclosureId' },
      { name: 'by_type',       key: 'type' },
    ]
  },
  gut_sessions: {
    keyPath: 'id',
    indexes: [
      { name: 'by_enclosure',  key: 'enclosureId' },
      { name: 'by_phase',      key: 'phase' },
    ]
  },
  clients: {
    keyPath: 'id',
    indexes: [
      { name: 'by_deleted',    key: 'deleted' },
    ]
  },
  transactions: {
    keyPath: 'id',
    indexes: [
      { name: 'by_client',     key: 'clientId' },
      { name: 'by_date',       key: 'date' },
    ]
  },
  settings: {
    keyPath: 'id',   // singleton: always id = 'main'
    indexes: []
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATION RULES — every write is validated before touching the DB
// ─────────────────────────────────────────────────────────────────────────────
const VALIDATORS = {
  enclosures: (d) => {
    if (!d.name || typeof d.name !== 'string' || d.name.trim().length === 0)
      throw new Error('enclosure.name is required');
    if (d.avgTemperature !== undefined && (d.avgTemperature < 15 || d.avgTemperature > 45))
      throw new Error('avgTemperature must be between 15 and 45°C');
    if (d.eggFlatsCount !== undefined && d.eggFlatsCount < 0)
      throw new Error('eggFlatsCount must be >= 0');
  },
  cohorts: (d) => {
    if (!d.enclosureId) throw new Error('cohort.enclosureId is required');
    if (!d.quantity || d.quantity < 0) throw new Error('cohort.quantity must be > 0');
    if (d.status === 'nymph' && (d.instarStage < 1 || d.instarStage > 7))
      throw new Error('nymph instarStage must be 1–7');
    if (d.maleCount !== undefined && d.maleCount < 0) throw new Error('maleCount must be >= 0');
    if (d.femaleCount !== undefined && d.femaleCount < 0) throw new Error('femaleCount must be >= 0');
  },
  measurements: (d) => {
    if (!d.enclosureId) throw new Error('measurement.enclosureId is required');
    if (typeof d.weight !== 'number' || d.weight <= 0 || d.weight > 1_000_000)
      throw new Error('measurement.weight must be a positive number (grams)');
    if (d.foodAdded !== undefined && d.foodAdded < 0)
      throw new Error('foodAdded must be >= 0');
    if (!d.date) throw new Error('measurement.date is required');
  },
  events: (d) => {
    if (!d.enclosureId) throw new Error('event.enclosureId is required');
    if (!d.type) throw new Error('event.type is required');
  },
  gut_sessions: (d) => {
    if (!d.enclosureId) throw new Error('gutSession.enclosureId is required');
  },
  clients: (d) => {
    if (!d.name || d.name.trim().length === 0) throw new Error('client.name is required');
  },
  transactions: (d) => {
    if (!d.clientId) throw new Error('transaction.clientId is required');
    if (typeof d.qty !== 'number' || d.qty <= 0) throw new Error('transaction.qty must be > 0');
    if (typeof d.price !== 'number' || d.price < 0) throw new Error('transaction.price must be >= 0');
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// UUID GENERATOR — RFC 4122 compliant, cryptographically random
// ─────────────────────────────────────────────────────────────────────────────
function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// DubiaDB — Async wrapper around IndexedDB
// All public methods return Promises.
// The singleton `DB` is created at the bottom and exposed globally.
// ─────────────────────────────────────────────────────────────────────────────
class DubiaDB {
  constructor() {
    this._db = null;          // IDBDatabase instance
    this._ready = null;       // Promise<void> that resolves once DB is open
    this._cache = {};         // in-memory read cache, invalidated on write
    this._ready = this._open();
  }

  // ── OPEN / MIGRATE ─────────────────────────────────────────────────────
  _open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        Object.entries(SCHEMA).forEach(([storeName, def]) => {
          if (db.objectStoreNames.contains(storeName)) return;   // already exists
          const store = db.createObjectStore(storeName, { keyPath: def.keyPath });
          def.indexes.forEach(idx => {
            store.createIndex(idx.name, idx.key, { unique: false, multiEntry: idx.multiEntry || false });
          });
        });
      };

      req.onsuccess = (e) => { this._db = e.target.result; resolve(); };
      req.onerror   = (e) => reject(new Error('IndexedDB open failed: ' + e.target.error));
      req.onblocked = ()  => reject(new Error('IndexedDB blocked — close other tabs'));
    });
  }

  /** Wait until the DB is open before any operation */
  async _wait() {
    await this._ready;
    if (!this._db) throw new Error('DB not initialized');
  }

  // ── LOW-LEVEL TRANSACTION WRAPPER ──────────────────────────────────────
  /**
   * Executes `fn(store)` inside a read-write transaction on `storeName`.
   * Automatically commits on success, rolls back on any error.
   * Guarantees atomicity: either all changes are saved or none.
   */
  _tx(storeName, mode, fn) {
    return new Promise(async (resolve, reject) => {
      await this._wait();
      const tx    = this._db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      let result;
      try {
        result = fn(store, tx);
      } catch (err) {
        tx.abort();
        return reject(err);
      }
      tx.oncomplete = () => resolve(result instanceof IDBRequest ? undefined : result);
      tx.onerror    = (e) => reject(new Error(`Transaction error on [${storeName}]: ${e.target.error}`));
      tx.onabort    = (e) => reject(new Error(`Transaction aborted on [${storeName}]: ${e.target.error}`));

      // If fn returned an IDBRequest, resolve with its result
      if (result instanceof IDBRequest) {
        result.onsuccess = () => { resolve(result.result); };
        result.onerror   = (e) => reject(new Error(e.target.error));
      }
    });
  }

  /** Wraps an IDBRequest in a Promise */
  _req(idbRequest) {
    return new Promise((resolve, reject) => {
      idbRequest.onsuccess = (e) => resolve(e.target.result);
      idbRequest.onerror   = (e) => reject(new Error(e.target.error));
    });
  }

  /** getAll from a store via cursor or getAll */
  async _getAll(storeName, indexName = null, query = null) {
    await this._wait();
    return new Promise((resolve, reject) => {
      const tx    = this._db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const source= indexName ? store.index(indexName) : store;
      const req   = source.getAll(query);
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror   = (e) => reject(new Error(e.target.error));
    });
  }

  // ── GENERIC CRUD ────────────────────────────────────────────────────────
  async _create(storeName, data, defaults = {}) {
    const validator = VALIDATORS[storeName];
    const record = {
      ...defaults,
      ...data,
      id:        data.id || uuid(),
      createdAt: data.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (validator) validator(record);     // throws on invalid data
    await this._tx(storeName, 'readwrite', store => store.add(record));
    this._invalidate(storeName);
    return record;
  }

  async _update(storeName, id, updates) {
    await this._wait();
    return new Promise(async (resolve, reject) => {
      const tx    = this._db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);

      const getReq = store.get(id);
      getReq.onsuccess = (e) => {
        const existing = e.target.result;
        if (!existing) { tx.abort(); return reject(new Error(`${storeName}:${id} not found`)); }

        const updated = { ...existing, ...updates, updatedAt: new Date().toISOString() };
        const validator = VALIDATORS[storeName];
        try { if (validator) validator(updated); }
        catch (err) { tx.abort(); return reject(err); }

        const putReq = store.put(updated);
        putReq.onsuccess = () => resolve(updated);
        putReq.onerror   = (e) => reject(new Error(e.target.error));
      };
      getReq.onerror = (e) => reject(new Error(e.target.error));
      tx.onerror = (e) => reject(new Error(e.target.error));
    });
  }

  _invalidate(storeName) {
    delete this._cache[storeName];
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PUBLIC API
  // ─────────────────────────────────────────────────────────────────────────

  // ── ENCLOSURES ──────────────────────────────────────────────────────────
  async getEnclosures() {
    const all = await this._getAll('enclosures');
    return all.filter(e => !e.deleted).sort((a, b) => a.name.localeCompare(b.name));
  }

  async getEnclosure(id) {
    await this._wait();
    return this._req(this._db.transaction('enclosures','readonly').objectStore('enclosures').get(id));
  }

  async createEnclosure(data) {
    return this._create('enclosures', data, {
      volumeLiters:    50,
      eggFlatsCount:   8,
      baseAreaM2:      0.25,
      avgTemperature:  30,
      species:         'Blaptica dubia',
      notes:           '',
      calibrationFactor: 1.0,
      calibrationPhase:  'calibration',
      deleted:         false,
    });
  }

  async updateEnclosure(id, updates) {
    const enc = await this._update('enclosures', id, updates);
    return enc;
  }

  async deleteEnclosure(id) {
    // Soft delete: mark as deleted, do NOT physically remove
    await this._update('enclosures', id, { deleted: true });
  }

  // ── COHORTS ─────────────────────────────────────────────────────────────
  async getCohorts(enclosureId = null) {
    const all = enclosureId
      ? await this._getAll('cohorts', 'by_enclosure', enclosureId)
      : await this._getAll('cohorts');
    return all.filter(c => !c.deleted);
  }

  async createCohort(data) {
    return this._create('cohorts', data, {
      status:        'nymph',
      instarStage:   1,
      quantity:      0,
      maleCount:     0,
      femaleCount:   0,
      accumulatedDD: 0,
      birthDate:     null,
      lastMoultDate: null,
      notes:         '',
      deleted:       false,
    });
  }

  async updateCohort(id, updates) {
    return this._update('cohorts', id, updates);
  }

  // ── MEASUREMENTS ────────────────────────────────────────────────────────
  async getMeasurements(enclosureId = null) {
    const all = enclosureId
      ? await this._getAll('measurements', 'by_enclosure', enclosureId)
      : await this._getAll('measurements');
    return all.sort((a, b) => new Date(b.date) - new Date(a.date));
  }

  async getLatestMeasurement(enclosureId) {
    const all = await this.getMeasurements(enclosureId);
    return all[0] || null;
  }

  async createMeasurement(data) {
    // Measurements are IMMUTABLE once created — no update method.
    // To "correct" a measurement, delete it and create a new one.
    return this._create('measurements', data, {
      foodAdded: 0,
      notes:     '',
      date:      new Date().toISOString(),
    });
  }

  async deleteMeasurement(id) {
    // Physical delete is OK here — measurements are append-only logs
    await this._tx('measurements', 'readwrite', store => store.delete(id));
  }

  // ── EVENTS ──────────────────────────────────────────────────────────────
  async getEvents(enclosureId = null) {
    const all = enclosureId
      ? await this._getAll('events', 'by_enclosure', enclosureId)
      : await this._getAll('events');
    return all.sort((a, b) => new Date(b.date) - new Date(a.date));
  }

  async createEvent(data) {
    return this._create('events', data, { notes: '', data: {}, date: new Date().toISOString() });
  }

  // ── GUT SESSIONS ────────────────────────────────────────────────────────
  async getGutSessions() {
    return this._getAll('gut_sessions');
  }

  async getActiveGutSession() {
    const all = await this.getGutSessions();
    return all.find(s => s.phase !== 'complete') || null;
  }

  async createGutSession(data) {
    return this._create('gut_sessions', data, {
      phase:        'fasting',
      targetWeight: 0,
      notes:        '',
      startTime:    new Date().toISOString(),
      completedAt:  null,
    });
  }

  async updateGutSession(id, updates) {
    return this._update('gut_sessions', id, updates);
  }

  // ── SETTINGS ────────────────────────────────────────────────────────────
  async getSettings() {
    await this._wait();
    const record = await this._req(
      this._db.transaction('settings','readonly').objectStore('settings').get('main')
    );
    return record || { id:'main', defaultTemp:30, currency:'EUR', alertsEnabled:true };
  }

  async updateSettings(updates) {
    await this._wait();
    const current = await this.getSettings();
    const merged  = { ...current, ...updates, id: 'main', updatedAt: new Date().toISOString() };
    await this._tx('settings', 'readwrite', store => store.put(merged));
    return merged;
  }

  // ── CLIENTS ─────────────────────────────────────────────────────────────
  async getClients() {
    const all = await this._getAll('clients');
    return all.filter(c => !c.deleted).sort((a,b)=>a.name.localeCompare(b.name));
  }

  async createClient(data) {
    return this._create('clients', data, {
      email: '', phone: '', city: '', animal: '', notes: '', deleted: false,
    });
  }

  async deleteClient(id) {
    await this._update('clients', id, { deleted: true });
  }

  // ── TRANSACTIONS ────────────────────────────────────────────────────────
  async getTransactions(clientId = null) {
    const all = clientId
      ? await this._getAll('transactions', 'by_client', clientId)
      : await this._getAll('transactions');
    return all.sort((a,b)=>new Date(b.date)-new Date(a.date));
  }

  async createTransaction(data) {
    return this._create('transactions', data, {
      total: (data.qty||0) * (data.price||0),
      notes: '',
      date:  new Date().toISOString(),
    });
  }

  // ── EXPORT / IMPORT ─────────────────────────────────────────────────────
  async exportJSON() {
    const [encs, cohorts, measurements, events, gutSessions, clients, transactions, settings] =
      await Promise.all([
        this._getAll('enclosures'),
        this._getAll('cohorts'),
        this._getAll('measurements'),
        this._getAll('events'),
        this._getAll('gut_sessions'),
        this._getAll('clients'),
        this._getAll('transactions'),
        this.getSettings(),
      ]);
    return JSON.stringify({
      exportedAt: new Date().toISOString(),
      schema_version: DB_VERSION,
      enclosures, cohorts, measurements, events,
      gut_sessions: gutSessions, clients, transactions, settings,
    }, null, 2);
  }

  async importJSON(jsonString) {
    let data;
    try { data = JSON.parse(jsonString); }
    catch { throw new Error('File JSON non valido'); }

    const stores = ['enclosures','cohorts','measurements','events','gut_sessions','clients','transactions','settings'];
    await this._wait();

    return new Promise((resolve, reject) => {
      const tx = this._db.transaction(stores, 'readwrite');
      tx.oncomplete = () => resolve(true);
      tx.onerror    = (e) => reject(new Error('Import failed: ' + e.target.error));
      tx.onabort    = () => reject(new Error('Import aborted'));

      stores.forEach(name => {
        const store = tx.objectStore(name);
        const key   = name === 'gut_sessions' ? 'gut_sessions' : name;
        const rows  = data[key] || (name === 'settings' ? [data.settings].filter(Boolean) : []);
        rows.forEach(row => { if (row && row.id) store.put(row); });
      });
    });
  }

  async resetAll() {
    const stores = Object.keys(SCHEMA);
    await this._wait();
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction(stores, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror    = (e) => reject(new Error(e.target.error));
      stores.forEach(name => tx.objectStore(name).clear());
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SINGLETON — expose globally
// ─────────────────────────────────────────────────────────────────────────────
const DB = new DubiaDB();

// ─────────────────────────────────────────────────────────────────────────────
// COMPATIBILITY SHIM — makes the app work with async IndexedDB
// dubia_app.js calls these synchronous-looking wrappers at boot time.
// ─────────────────────────────────────────────────────────────────────────────
const DBSync = {
  _cache: {
    enclosures:   null,
    cohorts:      null,
    measurements: {},
    settings:     null,
    gutSessions:  null,
    clients:      null,
    transactions: null,
  },
  _loaded: false,

  /** Call once at app start. Fills cache from IndexedDB. */
  async load() {
    const [encs, cohorts, all_ms, settings, gutSessions, clients, transactions] = await Promise.all([
      DB.getEnclosures(),
      DB._getAll('cohorts'),
      DB._getAll('measurements'),
      DB.getSettings(),
      DB.getGutSessions(),
      DB._getAll('clients'),
      DB._getAll('transactions'),
    ]);

    this._cache.enclosures   = encs;
    this._cache.cohorts      = cohorts.filter(c=>!c.deleted);
    this._cache.settings     = settings;
    this._cache.gutSessions  = gutSessions;
    this._cache.clients      = clients.filter(c=>!c.deleted);
    this._cache.transactions = transactions;

    // Group measurements by enclosureId for O(1) lookup
    this._cache.measurements = {};
    all_ms.forEach(m => {
      if (!this._cache.measurements[m.enclosureId]) this._cache.measurements[m.enclosureId] = [];
      this._cache.measurements[m.enclosureId].push(m);
    });
    // Sort each group newest-first
    Object.values(this._cache.measurements).forEach(arr =>
      arr.sort((a,b)=>new Date(b.date)-new Date(a.date))
    );
    this._loaded = true;
  },

  /** Reload cache after any write. */
  async reload() { await this.load(); },

  // ── Synchronous reads (from cache) ──────────────────────────────────────
  getEnclosures()          { return this._cache.enclosures || []; },
  getEnclosure(id)         { return (this._cache.enclosures||[]).find(e=>e.id===id); },
  getCohorts(encId=null)   {
    const all = this._cache.cohorts||[];
    return encId ? all.filter(c=>c.enclosureId===encId) : all;
  },
  getMeasurements(encId=null) {
    if (encId) return this._cache.measurements[encId] || [];
    return Object.values(this._cache.measurements).flat().sort((a,b)=>new Date(b.date)-new Date(a.date));
  },
  getLatestMeasurement(encId) { return (this._cache.measurements[encId]||[])[0]||null; },
  getSettings()            { return this._cache.settings||{defaultTemp:30,currency:'EUR'}; },
  getGutSessions()         { return this._cache.gutSessions||[]; },
  getClients()             { return this._cache.clients||[]; },
  getTransactions(cId=null){
    const all = this._cache.transactions||[];
    return cId ? all.filter(t=>t.clientId===cId) : all;
  },

  // ── Async writes (write to IndexedDB, then reload cache) ────────────────
  async createEnclosure(d)      { const r=await DB.createEnclosure(d);      await this.reload(); return r; },
  async updateEnclosure(id,u)   { const r=await DB.updateEnclosure(id,u);   await this.reload(); return r; },
  async deleteEnclosure(id)     { await DB.deleteEnclosure(id);              await this.reload(); },
  async createCohort(d)         { const r=await DB.createCohort(d);         await this.reload(); return r; },
  async updateCohort(id,u)      { const r=await DB.updateCohort(id,u);      await this.reload(); return r; },
  async createMeasurement(d)    { const r=await DB.createMeasurement(d);    await this.reload(); return r; },
  async deleteMeasurement(id)   { await DB.deleteMeasurement(id);            await this.reload(); },
  async createEvent(d)          { const r=await DB.createEvent(d);          await this.reload(); return r; },
  async createGutSession(d)     { const r=await DB.createGutSession(d);     await this.reload(); return r; },
  async updateGutSession(id,u)  { const r=await DB.updateGutSession(id,u);  await this.reload(); return r; },
  async updateSettings(u)       { const r=await DB.updateSettings(u);       await this.reload(); return r; },
  async createClient(d)         { const r=await DB.createClient(d);         await this.reload(); return r; },
  async deleteClient(id)        { await DB.deleteClient(id);                 await this.reload(); },
  async createTransaction(d)    { const r=await DB.createTransaction(d);    await this.reload(); return r; },

  async exportJSON()            { return DB.exportJSON(); },
  async importJSON(str)         { await DB.importJSON(str); await this.reload(); },
  async resetAll()              { await DB.resetAll(); await this.reload(); },
};

// Expose as global "DB" — replaces the old localStorage DB object
// dubia_app.js uses DBSync methods synchronously after the initial boot load.
Object.assign(DB, DBSync);
