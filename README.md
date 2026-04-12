# AuditMatchingEngine

Financial reconciliation engine matching QuickBooks Online invoices and payments against Service Autopilot data.

## Status: 🟢 Ready to Run

## Confirmed SA Endpoints (all reverse-engineered from browser session)

### Invoices
- `POST /AccountingBFF/InvoiceList/V2InvoiceList_Query` — paginated invoice list
- `POST /AccountingBFF/InvoiceList/v2QueryTotals` — invoice totals
- `POST /WebServices/InvoiceOverlay.asmx/GetInvoice` — single invoice detail

### Payments
- `POST /WebServices/PaymentListWs.asmx/Query` — paginated payment list
- `POST /WebServices/PaymentOverlayWs.asmx/GetPaymentData` — full payment detail (includes QboID)
- `POST /WebServices/PaymentOverlayWs.asmx/GetAppliedInvoices` — invoices this payment was applied to ✅
- `POST /WebServices/PaymentOverlayWs.asmx/GetPaymentTransactionStatus` — CC settlement status

### Other
- `POST /WebServices/AlertsWs.asmx/GetUserAlertCount` — auth check / keep-alive
- `POST /WebServices/BatchExportWs.asmx/GetBatchExport` — batch export

## Data Summary
| Dataset | Records | Date Range |
|---|---|---|
| SA Invoices | 8,355 | 1/1/2023 - 4/12/2026 |
| SA Payments | 6,090 | 1/1/2023 - 4/12/2026 |

## Key Fields for QB Matching
- **Invoices:** `QboID` (direct QB link), `InvoiceNumber`, `CustomerID`, `InvoiceTotal`, `InvoiceBalance`
- **Payments:** `QboID` (direct QB link), `CustomerID`, `PaymentAmount`, `PaymentDate`
- **Applications:** `PaymentID → InvoiceNumber`, `AmountApplied`, `BalanceAfter`

## Architecture

```
SA Browser Session (Playwright)
    ↓
sa-invoice-sync.js          → sa_invoices (Supabase)
sa-payment-sync.js          → sa_payments (Supabase)
sa-payment-applications-sync.js → sa_payment_applications (Supabase)
    ↓
matching-engine.js (TODO)
    ↓
audit_matches (Supabase)
    ↓
React Dashboard (TODO)
```

## Sync Order
Run scripts in this order:
```bash
node sync/sa-invoice-sync.js
node sync/sa-payment-sync.js
node sync/sa-payment-applications-sync.js
```

## Setup
```bash
npm install
cp .env.example .env
# Fill in SA_EMAIL, SA_PASSWORD, SUPABASE_URL, SUPABASE_SERVICE_KEY
npx playwright install chromium
# Run schema in Supabase SQL editor first
```

## Authentication
SA uses ASP.NET Forms Authentication + Incapsula WAF.
Must use real Chromium via Playwright — direct HTTP calls return login page HTML.
Login fields: `#txtLogin` (email), `#txtPassword`

## Matching Strategy (planned)
1. **Direct match via QboID** — invoices and payments with QboID link directly to QB records
2. **Invoice number match** — SA InvoiceNumber vs QB InvoiceNumber
3. **Fuzzy match** — customer name + amount + date proximity for unmatched records
4. **Flag discrepancies** — amount differences, missing records, QB sync errors
