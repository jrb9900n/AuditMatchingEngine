/**
 * sa-invoice-sync.js
 * Service Autopilot Invoice Batch Downloader
 *
 * CONFIRMED ENDPOINT: POST /AccountingBFF/InvoiceList/V2InvoiceList_Query
 * TOTAL RECORDS (1/1/2023-4/12/2026): 8,355
 *
 * NOTE: InvoiceNumber can be "32310" or "31745 (Contract)" format.
 *       Stored as TEXT in invoice_number.
 *       Numeric portion parsed into invoice_number_int for matching.
 */

const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const SA_BASE = 'https://my.serviceautopilot.com';
const BATCH_SIZE = 100;
const DELAY_MS = 300;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const delay = ms => new Promise(r => setTimeout(r, ms));

// Parse "32310" or "31745 (Contract)" -> { text: "31745 (Contract)", int: 31745 }
function parseInvoiceNumber(val) {
  if (!val && val !== 0) return { text: null, int: null };
  const str = String(val).trim();
  const match = str.match(/^(\d+)/);
  return { text: str, int: match ? parseInt(match[1], 10) : null };
}

function parseAmount(val) {
  if (typeof val === 'number') return val;
  return parseFloat(String(val).replace(/[$,]/g, '')) || 0;
}

function parseDate(val) {
  if (!val) return null;
  const m = String(val).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return val;
}

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
  const rows = invoices.map(inv => {
    const invNum = parseInvoiceNumber(inv.InvoiceNumber);
    return {
      sa_id:              inv.ID,
      invoice_number:     invNum.text,
      invoice_number_int: invNum.int,
      status:             inv.Status,
      date:               parseDate(inv.Date),
      due_date:           parseDate(inv.InvoiceDueDate),
      client:             inv.Client,
      customer_id:        inv.CustomerID,
      address:            inv.Address,
      frequency:          inv.Frequency,
      payment_type:       inv.PaymentType,
      prepayment_balance: parseAmount(inv.PrepaymentBalance),
      credit_balance:     parseAmount(inv.CreditBalance),
      invoice_balance:    parseAmount(inv.InvoiceBalance),
      invoice_total:      parseAmount(inv.InvoiceTotal),
      account_balance:    parseAmount(inv.AccountBalance),
      days_past_due:      inv.DaysPastDue || 0,
      is_past_due:        inv.IsPastDue || false,
      is_contract:        inv.IsContract || false,
      qb_status:          inv.QBStatus,
      qbo_id:             inv.QboID || null,
      contract_id:        inv.ContractID || null,
      deleted:            inv.Deleted || false,
      raw_data:           inv,
      synced_at:          new Date().toISOString()
    };
  });

  const { error } = await supabase
    .from('sa_invoices')
    .upsert(rows, { onConflict: 'sa_id' });

  if (error) console.error('[SUPABASE ERROR]', error.message);
  else console.log(`[SUPABASE] Saved ${rows.length} invoices`);
}

async function run() {
  // END_DATE is always today so each run picks up new invoices.
  const now = new Date();
  const END_DATE = { month: now.getMonth() + 1, day: now.getDate(), year: now.getFullYear() };

  // Incremental mode: if the table already has recent data (last invoice within 7 days),
  // scan only the past 90 days to keep weekly runs fast (~15 min vs 1-2 hrs full).
  let startFrom = new Date('2023-01-01');
  try {
    const { data } = await supabase.from('sa_invoices').select('date').order('date', { ascending: false }).limit(1);
    if (data?.[0]?.date) {
      const daysSince = (now - new Date(data[0].date)) / 86400000;
      if (daysSince < 7) {
        startFrom = new Date(now - 90 * 86400000);
        console.log(`[SA-SYNC] Incremental mode: ${startFrom.toISOString().slice(0, 10)} to today`);
      } else {
        console.log(`[SA-SYNC] Full mode: last invoice ${data[0].date} is ${Math.round(daysSince)}d old`);
      }
    }
  } catch (e) {
    console.warn(`[SA-SYNC] Could not check last sync date, using full mode: ${e.message}`);
  }
  const START_DATE = { month: startFrom.getMonth() + 1, day: startFrom.getDate(), year: startFrom.getFullYear() };

  if (!process.env.SA_EMAIL || !process.env.SA_PASSWORD) {
    console.error('[ERROR] SA_EMAIL and SA_PASSWORD required in .env'); process.exit(1);
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('[ERROR] SUPABASE_URL and SUPABASE_SERVICE_KEY required in .env'); process.exit(1);
  }

  console.log('[SA-SYNC] Launching browser...');
  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  console.log('[SA-SYNC] Logging in...');
  await page.goto(SA_BASE, { waitUntil: 'networkidle' });
  await page.fill('#txtLogin', process.env.SA_EMAIL);
  await page.fill('#txtPassword', process.env.SA_PASSWORD);
  await page.click('button:has-text("Log In")');
  await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 });
  console.log('[SA-SYNC] Logged in. Navigating to invoices...');
  await page.goto(`${SA_BASE}/InvoiceList.aspx`, { waitUntil: 'networkidle' });
  await delay(2000);

  let startRow = 0;
  let totalFetched = 0;
  let emptyCount = 0;

  while (emptyCount < 3) {
    console.log(`[SA-SYNC] Fetching rows ${startRow}-${startRow + BATCH_SIZE}...`);
    const batch = await fetchInvoiceBatch(page, startRow, START_DATE, END_DATE);
    if (!batch.length) {
      emptyCount++;
      console.log(`[SA-SYNC] Empty batch (${emptyCount}/3)`);
    } else {
      emptyCount = 0;
      await saveToSupabase(batch);
      totalFetched += batch.length;
      console.log(`[SA-SYNC] Progress: ${totalFetched} invoices synced`);
      startRow += BATCH_SIZE;
      await delay(DELAY_MS);
    }
  }

  console.log(`[SA-SYNC] Complete. Total: ${totalFetched} invoices`);
  await browser.close();
}

run().catch(console.error);
