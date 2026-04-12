/**
 * sa-invoice-sync.js
 * Service Autopilot Invoice Batch Downloader
 * 
 * Pulls all invoices from SA via browser session and saves to Supabase.
 * 
 * CONFIRMED ENDPOINTS (reverse-engineered 2026-04-12):
 *   POST /AccountingBFF/InvoiceList/V2InvoiceList_Query  -- invoice list
 *   POST /AccountingBFF/InvoiceList/v2QueryTotals        -- totals
 *   POST /WebServices/BatchExportWs.asmx/GetBatchExport  -- batch export
 *   POST /WebServices/AlertsWs.asmx/GetUserAlertCount    -- alerts (auth check)
 *
 * INVOICE DATA FIELDS (per record):
 *   ID, Status, Action, Date, InvoiceDueDate, InvoiceNumber,
 *   Client, CustomerID, Address, Frequency, PaymentType,
 *   PrepaymentBalance, CreditBalance, InvoiceBalance, InvoiceTotal,
 *   AccountBalance, FlagInvoice, DaysPastDue, IsContract, IsPastDue,
 *   Processing, NeedToPrint, NeedToEmail, HasCashDiscount,
 *   QBStatus, QboID, ContractID, Deleted, Unrestorable
 *
 * DATE FILTER PAYLOAD STRUCTURE:
 *   ScreenViewFilterType: 76  (date range filter)
 *   Items[0].Value: "6"       (filter mode)
 *   Items[1].Value: JSON date object {Month, Day, Year} -- start date
 *   Items[2].Value: JSON date object {Month, Day, Year} -- end date
 *
 * PAGINATION:
 *   StartRow: 0-based row offset
 *   Max: batch size (use 100 for efficiency)
 *   Total records in date range 1/1/2023-4/12/2026: 8,355
 */

const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const SA_BASE = 'https://my.serviceautopilot.com';
const BATCH_SIZE = 100;
const DELAY_MS = 300; // polite delay between requests

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const delay = ms => new Promise(r => setTimeout(r, ms));

function buildPayload(startRow, batchSize, startDate, endDate) {
  return {
    QueryInput: {
      StartRow: startRow,
      Max: startRow + batchSize,
      ActiveTab: 'Results',
      ScreenViewFilterTypes: [{
        ScreenViewFilterType: 76,
        ScreenViewFilterTypeItems: [
          { Value: '6' },
          { Value: JSON.stringify({ Month: startDate.month, Day: startDate.day, Year: startDate.year }) },
          { Value: JSON.stringify({ Month: endDate.month, Day: endDate.day, Year: endDate.year }) }
        ],
        ScreenViewFilterObjects: []
      }],
      SortedColumns: [
        { FieldName: 'Date', Direction: 1, ColumnEnum: 3 },
        { FieldName: 'Client', Direction: 0, ColumnEnum: 6 }
      ]
    }
  };
}

async function fetchInvoiceBatch(page, startRow, startDate, endDate) {
  const payload = buildPayload(startRow, BATCH_SIZE, startDate, endDate);
  const result = await page.evaluate(async (payload) => {
    const res = await fetch('/AccountingBFF/InvoiceList/V2InvoiceList_Query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return res.json();
  }, payload);
  return result?.Invoices || [];
}

async function saveToSupabase(invoices) {
  if (!invoices.length) return;
  const rows = invoices.map(inv => ({
    sa_id: inv.ID,
    invoice_number: inv.InvoiceNumber,
    status: inv.Status,
    date: inv.Date,
    due_date: inv.InvoiceDueDate,
    client: inv.Client,
    customer_id: inv.CustomerID,
    address: inv.Address,
    frequency: inv.Frequency,
    payment_type: inv.PaymentType,
    prepayment_balance: inv.PrepaymentBalance,
    credit_balance: inv.CreditBalance,
    invoice_balance: inv.InvoiceBalance,
    invoice_total: inv.InvoiceTotal,
    account_balance: inv.AccountBalance,
    days_past_due: inv.DaysPastDue,
    is_past_due: inv.IsPastDue,
    qb_status: inv.QBStatus,
    qbo_id: inv.QboID,
    contract_id: inv.ContractID,
    deleted: inv.Deleted,
    raw_data: inv,
    synced_at: new Date().toISOString()
  }));

  const { error } = await supabase
    .from('sa_invoices')
    .upsert(rows, { onConflict: 'sa_id' });

  if (error) console.error('[SUPABASE ERROR]', error.message);
  else console.log(`[SUPABASE] Saved ${rows.length} invoices`);
}

async function run() {
  const START_DATE = { month: 1, day: 1, year: 2023 };
  const END_DATE   = { month: 4, day: 12, year: 2026 };

  if (!process.env.SA_EMAIL || !process.env.SA_PASSWORD) {
    console.error('[ERROR] SA_EMAIL and SA_PASSWORD required in .env');
    process.exit(1);
  }

  console.log('[SA-SYNC] Launching browser...');
  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  // LOGIN
  console.log('[SA-SYNC] Logging in...');
  await page.goto(SA_BASE, { waitUntil: 'networkidle' });
  await page.fill('#txtLogin', process.env.SA_EMAIL);
  await page.fill('#txtPassword', process.env.SA_PASSWORD);
  await page.click('button:has-text("Log In")');
  await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 });
  console.log('[SA-SYNC] Logged in. URL:', page.url());

  // Navigate to InvoiceList to establish session context
  await page.goto(`${SA_BASE}/InvoiceList.aspx`, { waitUntil: 'networkidle' });
  await delay(2000);

  // GET TOTAL COUNT first
  const firstBatch = await fetchInvoiceBatch(page, 0, START_DATE, END_DATE);
  console.log(`[SA-SYNC] First batch returned ${firstBatch.length} invoices`);

  // We know total is ~8,355 — fetch in batches
  let startRow = 0;
  let totalFetched = 0;
  let consecutiveEmpty = 0;

  while (consecutiveEmpty < 3) {
    console.log(`[SA-SYNC] Fetching rows ${startRow} - ${startRow + BATCH_SIZE}...`);
    const batch = await fetchInvoiceBatch(page, startRow, START_DATE, END_DATE);

    if (!batch.length) {
      consecutiveEmpty++;
      console.log(`[SA-SYNC] Empty batch (${consecutiveEmpty}/3). Done.`);
      break;
    }

    consecutiveEmpty = 0;
    await saveToSupabase(batch);
    totalFetched += batch.length;
    console.log(`[SA-SYNC] Progress: ${totalFetched} invoices synced`);

    startRow += BATCH_SIZE;
    await delay(DELAY_MS);
  }

  console.log(`[SA-SYNC] Complete. Total invoices synced: ${totalFetched}`);
  await browser.close();
}

run().catch(console.error);
