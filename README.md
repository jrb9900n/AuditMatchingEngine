# AuditMatchingEngine

Financial reconciliation engine that pulls invoice, payment, and accounting data from Service Autopilot and matches it against QuickBooks Online.

## Status: 🟢 Active Development

### Confirmed SA Endpoints (discovered 2026-04-12)
- `POST /AccountingBFF/InvoiceList/V2InvoiceList_Query` — **Invoice list with date/filter/pagination**
- `POST /AccountingBFF/InvoiceList/v2QueryTotals` — Invoice totals summary
- `POST /WebServices/BatchExportWs.asmx/GetBatchExport` — Batch export
- `POST /WebServices/AlertsWs.asmx/GetUserAlertCount` — Auth check / alerts
- Payments endpoint: **TBD** (next discovery session)

### Data Confirmed
- **8,355 invoices** found in date range 1/1/2023 - 4/12/2026
- Each invoice contains: ID, InvoiceNumber, Status, Date, Client, CustomerID, InvoiceBalance, InvoiceTotal, AccountBalance, QBStatus, QboID, and 20+ more fields

## Architecture
- `sync/sa-invoice-sync.js` — Playwright-based batch invoice downloader (ready to run)
- `sync/sa-accounting-sync.js` — General accounting endpoint discovery script
- `supabase/schema.sql` — Database schema for SA invoices, payments, QB invoices, audit matches
- `matching/` — Fuzzy matching engine (coming next)
- `api/` — Express.js API layer (coming next)
- `dashboard/` — React reconciliation dashboard (coming next)

## Setup

```bash
npm install
cp .env.example .env
# Fill in SA_EMAIL, SA_PASSWORD, SUPABASE_URL, SUPABASE_SERVICE_KEY
npx playwright install chromium
node sync/sa-invoice-sync.js
```

## SA Authentication
SA uses ASP.NET Forms Authentication + Incapsula WAF.
Must use real Chromium browser via Playwright — direct HTTP calls are blocked.
