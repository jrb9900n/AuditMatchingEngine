-- AuditMatchingEngine Supabase Schema
-- Run in Supabase SQL editor

-- Service Autopilot Invoices (8,355 records, 1/1/2023-4/12/2026)
CREATE TABLE IF NOT EXISTS sa_invoices (
  id                  BIGSERIAL PRIMARY KEY,
  sa_id               TEXT UNIQUE NOT NULL,        -- Invoice GUID
  invoice_number      INTEGER,                     -- Human-readable invoice #, key for QB matching
  status              TEXT,                        -- Open, Paid, Past Due
  date                TEXT,
  due_date            TEXT,
  client              TEXT,
  customer_id         TEXT,                        -- Customer GUID
  address             TEXT,
  frequency           TEXT,
  payment_type        TEXT,
  prepayment_balance  NUMERIC,
  credit_balance      NUMERIC,
  invoice_balance     NUMERIC,                     -- Amount still owed
  invoice_total       NUMERIC,                     -- Original total
  account_balance     NUMERIC,
  days_past_due       INTEGER,
  is_past_due         BOOLEAN,
  is_contract         BOOLEAN,
  qb_status           TEXT,
  qbo_id              TEXT,                        -- Direct QB link (key for matching)
  contract_id         TEXT,
  deleted             BOOLEAN,
  raw_data            JSONB,
  synced_at           TIMESTAMPTZ DEFAULT NOW()
);

-- Service Autopilot Payments (6,090 records, 1/1/2023-4/12/2026)
CREATE TABLE IF NOT EXISTS sa_payments (
  id               BIGSERIAL PRIMARY KEY,
  sa_id            TEXT UNIQUE NOT NULL,           -- Payment GUID
  customer_id      TEXT,
  client           TEXT,
  address          TEXT,
  payment_date     TEXT,
  payment_amount   NUMERIC,
  unused_amount    NUMERIC,
  refunded_amount  NUMERIC,
  reference        TEXT,
  notes            TEXT,
  payment_type     TEXT,                           -- Visa, Check, ACH, etc
  qbo_id           TEXT,                           -- QB payment link
  txn_id           TEXT,
  deleted          BOOLEAN,
  raw_data         JSONB,
  synced_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Payment-to-Invoice Applications
-- Which invoices each payment was applied to (from GetAppliedInvoices)
CREATE TABLE IF NOT EXISTS sa_payment_applications (
  id               BIGSERIAL PRIMARY KEY,
  payment_sa_id    TEXT NOT NULL,                  -- FK to sa_payments.sa_id
  invoice_number   INTEGER,                        -- FK to sa_invoices.invoice_number
  invoice_sa_id    TEXT,                           -- Invoice GUID if available
  amount_applied   NUMERIC,                        -- How much of payment applied to this invoice
  invoice_total    NUMERIC,
  balance_after    NUMERIC,                        -- Invoice balance after this payment
  invoice_date     TEXT,
  customer_name    TEXT,
  raw_data         JSONB,
  synced_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(payment_sa_id, invoice_number)
);

-- QuickBooks Invoices
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

-- QuickBooks Payments
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

-- Audit Match Results
CREATE TABLE IF NOT EXISTS audit_matches (
  id                    BIGSERIAL PRIMARY KEY,
  sa_invoice_sa_id      TEXT REFERENCES sa_invoices(sa_id),
  qb_invoice_id         TEXT,
  match_type            TEXT,   -- 'direct_qbo_id', 'invoice_number', 'fuzzy_name_amount', 'unmatched'
  match_score           NUMERIC,
  match_status          TEXT,   -- 'matched', 'discrepancy', 'unmatched_sa', 'unmatched_qb'
  sa_amount             NUMERIC,
  qb_amount             NUMERIC,
  amount_diff           NUMERIC,
  sa_customer           TEXT,
  qb_customer           TEXT,
  notes                 TEXT,
  reviewed_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_sa_invoices_customer    ON sa_invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_sa_invoices_date        ON sa_invoices(date);
CREATE INDEX IF NOT EXISTS idx_sa_invoices_qbo_id      ON sa_invoices(qbo_id);
CREATE INDEX IF NOT EXISTS idx_sa_invoices_number      ON sa_invoices(invoice_number);
CREATE INDEX IF NOT EXISTS idx_sa_payments_customer    ON sa_payments(customer_id);
CREATE INDEX IF NOT EXISTS idx_sa_payments_date        ON sa_payments(payment_date);
CREATE INDEX IF NOT EXISTS idx_sa_payments_qbo_id      ON sa_payments(qbo_id);
CREATE INDEX IF NOT EXISTS idx_pay_apps_payment        ON sa_payment_applications(payment_sa_id);
CREATE INDEX IF NOT EXISTS idx_pay_apps_invoice_num    ON sa_payment_applications(invoice_number);
CREATE INDEX IF NOT EXISTS idx_audit_status            ON audit_matches(match_status);
CREATE INDEX IF NOT EXISTS idx_audit_match_type        ON audit_matches(match_type);
