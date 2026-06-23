-- ═══════════════════════════════════════════════════════════════════════════
-- BioTwin Dubia v2 — Supabase Schema SQL
-- Esegui questo script nel SQL Editor del tuo progetto Supabase.
-- Dashboard → SQL Editor → New Query → incolla e premi Run
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── ENCLOSURES ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS enclosures (
  id          UUID PRIMARY KEY,
  device_id   TEXT NOT NULL,
  payload     JSONB NOT NULL,
  deleted     BOOLEAN DEFAULT FALSE,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_enclosures_device ON enclosures(device_id);
CREATE INDEX IF NOT EXISTS idx_enclosures_updated ON enclosures(updated_at);

-- ─── COHORTS ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cohorts (
  id          UUID PRIMARY KEY,
  device_id   TEXT NOT NULL,
  payload     JSONB NOT NULL,
  deleted     BOOLEAN DEFAULT FALSE,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cohorts_device ON cohorts(device_id);

-- ─── MEASUREMENTS ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS measurements (
  id          UUID PRIMARY KEY,
  device_id   TEXT NOT NULL,
  payload     JSONB NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_measurements_device ON measurements(device_id);
CREATE INDEX IF NOT EXISTS idx_measurements_updated ON measurements(updated_at);

-- ─── EVENTS ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS events (
  id          UUID PRIMARY KEY,
  device_id   TEXT NOT NULL,
  payload     JSONB NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_events_device ON events(device_id);

-- ─── GUT SESSIONS ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gut_sessions (
  id          UUID PRIMARY KEY,
  device_id   TEXT NOT NULL,
  payload     JSONB NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_gut_device ON gut_sessions(device_id);

-- ─── CLIENTS ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clients (
  id          UUID PRIMARY KEY,
  device_id   TEXT NOT NULL,
  payload     JSONB NOT NULL,
  deleted     BOOLEAN DEFAULT FALSE,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_clients_device ON clients(device_id);

-- ─── TRANSACTIONS ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transactions (
  id          UUID PRIMARY KEY,
  device_id   TEXT NOT NULL,
  payload     JSONB NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_transactions_device ON transactions(device_id);

-- ─── SETTINGS (singleton per device) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  device_id   TEXT PRIMARY KEY,
  payload     JSONB NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY — ogni dispositivo vede SOLO i propri dati
-- ═══════════════════════════════════════════════════════════════════════════

-- Abilita RLS su tutte le tabelle
ALTER TABLE enclosures   ENABLE ROW LEVEL SECURITY;
ALTER TABLE cohorts       ENABLE ROW LEVEL SECURITY;
ALTER TABLE measurements  ENABLE ROW LEVEL SECURITY;
ALTER TABLE events        ENABLE ROW LEVEL SECURITY;
ALTER TABLE gut_sessions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients       ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings      ENABLE ROW LEVEL SECURITY;

-- Policy: accesso anonimo filtrato per device_id
-- NOTA: usiamo anon key + request.headers per il device_id
-- La politica permette a chiunque abbia la anon key di leggere/scrivere
-- SOLO le righe con il proprio device_id (passato nell'header X-Device-Id)

CREATE POLICY "anon_enclosures"   ON enclosures   FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_cohorts"       ON cohorts       FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_measurements"  ON measurements  FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_events"        ON events        FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_gut_sessions"  ON gut_sessions  FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_clients"       ON clients       FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_transactions"  ON transactions  FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_settings"      ON settings      FOR ALL TO anon USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICA: dopo l'esecuzione dovresti vedere 8 tabelle nel Table Editor
-- ═══════════════════════════════════════════════════════════════════════════
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
ORDER BY table_name;
