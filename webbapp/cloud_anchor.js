// cloud_anchor.js — BioTwin Autonomy Protocol (BAP)
// Supabase Cloud Anchor: silent sync, offline queue, self-healing.
//
// ⚠️  SETUP: Crea un progetto su https://supabase.com,
//            copia Project URL e anon key qui sotto.
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL      = 'https://YOUR_PROJECT.supabase.co';   // ← sostituisci
const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY';                      // ← sostituisci

// Flag: se false, Cloud Anchor opera in modalità "solo locale" (no errori)
const CLOUD_ENABLED = SUPABASE_URL !== 'https://YOUR_PROJECT.supabase.co';

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const DEVICE_KEY   = 'biot_device_id';
const QUEUE_KEY    = 'biot_sync_queue';
const LAST_PULL_KEY= 'biot_last_pull';

const SYNC_TABLES = ['enclosures','cohorts','measurements','events','gut_sessions','clients','transactions','settings'];

// ─────────────────────────────────────────────────────────────────────────────
// CloudAnchor — Singleton
// ─────────────────────────────────────────────────────────────────────────────
const CloudAnchor = {
  _client:    null,
  _deviceId:  null,
  _online:    navigator.onLine,
  _syncing:   false,
  _queue:     [],          // { table, record, op } pending records
  status:     'idle',      // 'idle' | 'syncing' | 'online' | 'offline' | 'error' | 'disabled'

  // ── INIT ──────────────────────────────────────────────────────────────
  async init() {
    this._deviceId = this._getOrCreateDeviceId();
    this._queue    = this._loadQueue();

    if (!CLOUD_ENABLED) {
      this._setStatus('disabled');
      console.info('[CloudAnchor] Running in local-only mode. Configure Supabase to enable sync.');
      return;
    }

    // Load Supabase JS SDK dynamically
    try {
      await this._loadSDK();
      this._client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      // Set device_id header for RLS
      this._client.rpc = this._client.rpc;
    } catch (e) {
      console.warn('[CloudAnchor] SDK load failed:', e);
      this._setStatus('error');
      return;
    }

    // Connectivity listeners
    window.addEventListener('online',  () => { this._online = true;  this._setStatus('online');  this._drainQueue(); });
    window.addEventListener('offline', () => { this._online = false; this._setStatus('offline'); });

    this._setStatus(this._online ? 'online' : 'offline');
    console.info('[CloudAnchor] Initialized. Device:', this._deviceId.slice(0,8) + '…');
  },

  // ── SDK Loader ────────────────────────────────────────────────────────
  _loadSDK() {
    return new Promise((resolve, reject) => {
      if (window.supabase) return resolve();
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js';
      s.onload  = resolve;
      s.onerror = () => reject(new Error('Supabase SDK failed to load'));
      document.head.appendChild(s);
    });
  },

  // ── DEVICE ID ─────────────────────────────────────────────────────────
  _getOrCreateDeviceId() {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random()*16|0; return (c==='x'?r:(r&0x3|0x8)).toString(16);
          });
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  },

  // ── PUSH — write one record to Supabase ──────────────────────────────
  /**
   * Called after every local write (create / update / delete).
   * Silently pushes to Supabase. If offline, queues the record.
   */
  async push(table, record) {
    if (!CLOUD_ENABLED) return;
    const payload = {
      id:        record.id,
      device_id: this._deviceId,
      payload:   record,
      deleted:   record.deleted || false,
      updated_at: new Date().toISOString(),
    };
    // Settings is a singleton keyed by device_id, no id column
    const isSettings = table === 'settings';
    const pushPayload = isSettings
      ? { device_id: this._deviceId, payload: record, updated_at: payload.updated_at }
      : payload;

    if (!this._online || !this._client) {
      this._enqueue(table, pushPayload);
      return;
    }

    try {
      this._setStatus('syncing');
      const { error } = await this._client
        .from(table)
        .upsert(pushPayload, { onConflict: isSettings ? 'device_id' : 'id' });
      if (error) throw error;
      this._setStatus('online');
    } catch (e) {
      console.warn(`[CloudAnchor] push(${table}) failed, queuing.`, e.message);
      this._enqueue(table, pushPayload);
      this._setStatus('offline');
    }
  },

  // ── PULL — download all records from Supabase ─────────────────────────
  /**
   * Downloads all records for this device_id from Supabase
   * and writes them into IndexedDB. Called by Self-Healing boot
   * and on first sync.
   */
  async pull() {
    if (!CLOUD_ENABLED || !this._client) return false;
    try {
      this._setStatus('syncing');
      await DB._ready;

      for (const table of SYNC_TABLES) {
        const { data, error } = await this._client
          .from(table)
          .select('*')
          .eq('device_id', this._deviceId);

        if (error) { console.warn(`[CloudAnchor] pull(${table}) error:`, error.message); continue; }
        if (!data || !data.length) continue;

        // Write each record into IndexedDB
        const storeName = table; // store names match table names in our IndexedDB schema
        await DB._wait();
        await new Promise((resolve, reject) => {
          const tx    = DB._db.transaction(storeName, 'readwrite');
          const store = tx.objectStore(storeName);
          tx.oncomplete = resolve;
          tx.onerror    = (e) => reject(e.target.error);
          data.forEach(row => {
            const record = row.payload || row;
            if (record && record.id) store.put(record);
          });
        });
      }

      localStorage.setItem(LAST_PULL_KEY, new Date().toISOString());
      await DB.load();    // refresh in-memory cache
      this._setStatus('online');
      console.info('[CloudAnchor] Pull complete.');
      return true;
    } catch (e) {
      console.error('[CloudAnchor] pull() failed:', e);
      this._setStatus('error');
      return false;
    }
  },

  // ── SYNC QUEUE ────────────────────────────────────────────────────────
  _loadQueue() {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); }
    catch { return []; }
  },

  _saveQueue() {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(this._queue));
  },

  _enqueue(table, payload) {
    this._queue.push({ table, payload, ts: Date.now() });
    this._saveQueue();
    this._emitQueueSize();
  },

  get queueSize() { return this._queue.length; },

  async _drainQueue() {
    if (!this._online || !this._client || this._syncing) return;
    if (!this._queue.length) return;
    this._syncing = true;
    this._setStatus('syncing');

    const failed = [];
    for (const item of this._queue) {
      try {
        const isSettings = item.table === 'settings';
        const { error } = await this._client
          .from(item.table)
          .upsert(item.payload, { onConflict: isSettings ? 'device_id' : 'id' });
        if (error) throw error;
      } catch (e) {
        failed.push(item);
      }
    }

    this._queue = failed;
    this._saveQueue();
    this._syncing = false;
    this._setStatus(failed.length ? 'error' : 'online');
    this._emitQueueSize();
    if (!failed.length) console.info('[CloudAnchor] Queue drained.');
  },

  // ── STATUS & EVENTS ───────────────────────────────────────────────────
  _setStatus(s) {
    this.status = s;
    document.dispatchEvent(new CustomEvent('sync-status', { detail: { status: s, queue: this._queue.length } }));
  },

  _emitQueueSize() {
    document.dispatchEvent(new CustomEvent('sync-status', { detail: { status: this.status, queue: this._queue.length } }));
  },

  // ── LAST PULL INFO ────────────────────────────────────────────────────
  lastPullAgo() {
    const t = localStorage.getItem(LAST_PULL_KEY);
    if (!t) return null;
    const m = Math.round((Date.now() - new Date(t)) / 60000);
    return m < 1 ? 'ora' : m < 60 ? `${m} min fa` : `${Math.round(m/60)}h fa`;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// DB EXTENSIONS — Self-Healing boot + integrity check
// Appended here to avoid modifying dubia_db.js's core logic.
// ─────────────────────────────────────────────────────────────────────────────

/** Returns { ok, reason } */
async function DB_checkIntegrity() {
  try {
    await DB._ready;
    const encs = await DB._getAll('enclosures');
    const ms   = await DB._getAll('measurements');

    // Check 1: stores are accessible
    const stores = ['enclosures','cohorts','measurements','events','settings'];
    for (const s of stores) {
      if (!DB._db.objectStoreNames.contains(s))
        return { ok: false, reason: `Missing store: ${s}` };
    }

    // Check 2: data looks plausible
    const hasData = encs.length > 0 || ms.length > 0;

    // Check 3: did we ever pull from cloud?
    const lastPull = localStorage.getItem(LAST_PULL_KEY);

    // If we have no data AND we've synced before → corrupted/reset
    if (!hasData && lastPull) return { ok: false, reason: 'Local data missing after previous sync' };

    return { ok: true };
  } catch(e) {
    return { ok: false, reason: e.message };
  }
}

/** Full boot sequence with Self-Healing */
async function DB_boot(onStatus) {
  const status = (msg, type='info') => {
    onStatus && onStatus(msg, type);
    console.info('[DB_boot]', msg);
  };

  status('Apertura database…');
  await DB._ready;
  status('Verifica integrità…');

  const { ok, reason } = await DB_checkIntegrity();

  if (!ok) {
    status(`⚠️ Integrità DB: ${reason}`, 'warn');
    if (CLOUD_ENABLED) {
      status('🔄 Self-Healing: ripristino da Cloud Anchor…', 'heal');
      await CloudAnchor.init();
      const pulled = await CloudAnchor.pull();
      if (pulled) {
        status('✅ Ripristino completato.', 'ok');
      } else {
        status('☁️ Nessun dato cloud trovato. Avvio pulito.', 'info');
        await DB.load();
      }
    } else {
      status('Avvio in modalità locale.', 'info');
      await DB.load();
    }
  } else {
    status('✅ Database OK.');
    await DB.load();
    // Init cloud after local load
    if (CLOUD_ENABLED) CloudAnchor.init().then(() => CloudAnchor._drainQueue());
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SAFETY GATE — two-phase destructive action confirmation
// ─────────────────────────────────────────────────────────────────────────────
const SafetyGate = {
  _resolve: null,

  /**
   * opts: { title, message, impact, word (optional — must type to confirm), onConfirm }
   * If opts.word is set, user must type the word exactly before confirming.
   */
  confirm(opts) {
    const overlay = document.getElementById('safetyModal');
    if (!overlay) { console.warn('Safety Gate modal not in DOM'); return; }

    document.getElementById('sgTitle').textContent   = opts.title || 'Conferma';
    document.getElementById('sgMsg').textContent     = opts.message || '';
    document.getElementById('sgImpact').textContent  = opts.impact ? `Impatto: ${opts.impact}` : '';

    const wordRow = document.getElementById('sgWordRow');
    const wordIn  = document.getElementById('sgWordInput');
    const wordHint= document.getElementById('sgWordHint');
    const btnYes  = document.getElementById('sgBtnYes');

    if (opts.word) {
      wordRow.style.display = 'block';
      wordIn.value = '';
      wordHint.textContent = `Digita "${opts.word}" per confermare`;
      btnYes.disabled = true;
      wordIn.oninput = () => {
        btnYes.disabled = wordIn.value.trim() !== opts.word.trim();
      };
    } else {
      wordRow.style.display = 'none';
      btnYes.disabled = false;
    }

    overlay.classList.add('open');

    document.getElementById('sgBtnNo').onclick = () => {
      overlay.classList.remove('open');
    };
    btnYes.onclick = () => {
      overlay.classList.remove('open');
      if (opts.onConfirm) opts.onConfirm();
    };
  },
};
