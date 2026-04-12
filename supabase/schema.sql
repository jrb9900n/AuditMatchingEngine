-- AuditMatchingEngine Supabase Schema
-- Run in Supabase SQL editor

CREATE TABLE IF NOT EXISTS sa_invoices (
  id                  BIGSERIAL PRIMARY KEY,
  sa_id               INTEGER UNIQUE NOT NULL,
  invoice_number      INTEGER,
  status              TEXT,
  date                TEXT,
  due_date            TEXT,
  client              TEXT,
  customer_id         INTEGER,
  address             TEXT,
  frequency           TEXT,
  payment_type        TEXT,
  prepayment_balance  NUMERIC,
  credit_balance      NUMERIC,
  invoice_balance     NUMERIC,
  invoice_total       NUMERIC,
  account_balance     NUMERIC,
  days_past_due       INTEGER,
  is_past_due         BOOLEAN,
  qb_status           TEXT,
  qbo_id              TEXT,
  contract_id         INTEGER,
  deleted             BOOLEAN,
  raw_data            JSONB,
  synced_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sa_payments (
  id            BIGSERIAL PRIMARY KEY,
  sa_id         INTEGER UNIQUE NOT NULL,
  amount        NUMERIC,
  date          TEXT,
  client        TEXT,
  customer_id   INTEGER,
  invoice_id    INTEGER,
  payment_type  TEXT,
  reference     TEXT,
  qb_status     TEXT,
  qbo_id        TEXT,
  raw_data      JSONB,
  synced_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS qb_invoices (
  id              BIGSERIAL PRIMARY KEY,
  qb_id           TEXT UNIQUE NOT NULL,
  invoice_number  TEXT,
  customer_name   TEXT,
  amount          NUMERIC,
  balance         NUMERIC,
  date            TEXT,
  due_date        TEXT,
  status          TEXT,
  raw_data        JSONB,
  synced_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS qb_payments (
  id              BIGSERIAL PRIMARY KEY,
  qb_id           TEXT UNIQUE NOT NULL,
  customer_name   TEXT,
  amount          NUMERIC,
  date            TEXT,
  payment_method  TEXT,
  raw_data        JSONB,
  synced_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_matches (
  id                BIGSERIAL PRIMARY KEY,
  sa_invoice_id     INTEGER REFERENCES sa_invoices(sa_id),
  qb_invoice_id     TEXT,
  match_score       NUMERIC,
  match_status      TEXT,
  sa_amount         NUMERIC,
  qb_amount         NUMERIC,
  amount_diff       NUMERIC,
  notes             TEXT,
  reviewed_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sa_invoices_customer  ON sa_invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_sa_invoices_date      ON sa_invoices(date);
CREATE INDEX IF NOT EXISTS idx_sa_invoices_qbo_id    ON sa_invoices(qbo_id);
CREATE INDEX IF NOT EXISTS idx_audit_matches_status  ON audit_matches(match_status);
