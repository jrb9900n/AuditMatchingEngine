/**
 * sa-payment-sync.js
 * Service Autopilot Payment Batch Downloader
 *
 * CONFIRMED ENDPOINT (reverse-engineered 2026-04-12):
 *   POST /WebServices/PaymentListWs.asmx/Query
 *
 * RESPONSE WRAPPED IN: { d: { Total, PaymentItems: [...] } }
 *
 * PAYMENT FIELDS (per record):
 *   ID, CustomerID, PaymentDate, Client, Address,
 *   PaymentAmount, UnusedAmount, RefundedAmount,
 *   Reference, Notes, Type, Deleted, Unrestorable
 *
 * PAYMENT DETAIL (via PaymentOverlayWs):
 *   PaymentID, CustomerID, CustomerName, Date, Amount,
 *   AppliedAmount, UnusedAmount, Deposited, PaymentMethodType,
 *   PaymentMethodName, IsCreditCardPayment, IsACHPayment,
 *   IsPrePayment, HasRefunds, QboID, TxnID, HasQBO
 *
 * TOTAL RECORDS (1/1/2023 - 4/12/2026): 6,090
 */

const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const SA_BASE = 'https://my.serviceautopilot.com';
const BATCH_SIZE = 100;
const DELAY_MS = 300;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const delay = ms => new Promise(r => setTimeout(r, ms));

function buildPayload(startRow, batchSize, startDate, endDate) {
  return {
    PaymentListQueryData: {
      StartRow: startRow,
      StartDate: { Month: startDate.month, Day: startDate.day, Year: startDate.year },
      EndDate: { Month: endDate.month, Day: endDate.day, Year: endDate.year },
      Client: '',
      Reference: '',
      MaxRow: startRow + batchSize - 1,
      Address: '',
      PaymentMethodTypes: [],
      ActiveTab: 'Payments'
    }
  };
}

async function fetchPaymentBatch(page, startRow, startDate, endDate) {
  const payload = buildPayload(startRow, BATCH_SIZE, startDate, endDate);
  const result = await page.evaluate(async (payload) => {
    const res = await fetch('/WebServices/PaymentListWs.asmx/Query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload)
    });
    return res.json();
  }, payload);
  return result?.d?.PaymentItems || [];
}

async function saveToSupabase(payments) {
  if (!payments.length) return;
  const rows = payments.map(p => ({
    sa_id:           p.ID,
    customer_id:     p.CustomerID,
    client:          p.Client,
    address:         p.Address,
    payment_date:    p.PaymentDate,
    payment_amount:  parseFloat(p.PaymentAmount?.replace(/[$,]/g, '')) || 0,
    unused_amount:   parseFloat(p.UnusedAmount?.replace(/[$,]/g, '')) || 0,
    refunded_amount: parseFloat(p.RefundedAmount?.replace(/[$,]/g, '')) || 0,
    reference:       p.Reference,
    notes:           p.Notes,
    payment_type:    p.Type,
    deleted:         p.Deleted,
    raw_data:        p,
    synced_at:       new Date().toISOString()
  }));
  const { error } = await supabase.from('sa_payments').upsert(rows, { onConflict: 'sa_id' });
  if (error) console.error('[SUPABASE ERROR]', error.message);
  else console.log(`[SUPABASE] Saved ${rows.length} payments`);
}

async function run() {
  const START_DATE = { month: 1, day: 1, year: 2023 };
  const END_DATE   = { month: 4, day: 12, year: 2026 };

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
  await page.goto(`${SA_BASE}/Payments.aspx`, { waitUntil: 'networkidle' });
  await delay(2000);

  let startRow = 1;
  let totalFetched = 0;
  let emptyCount = 0;

  while (emptyCount < 3) {
    console.log(`[SA-SYNC] Fetching payments rows ${startRow}-${startRow + BATCH_SIZE}...`);
    const batch = await fetchPaymentBatch(page, startRow, START_DATE, END_DATE);
    if (!batch.length) { emptyCount++; break; }
    emptyCount = 0;
    await saveToSupabase(batch);
    totalFetched += batch.length;
    console.log(`[SA-SYNC] Progress: ${totalFetched} payments synced`);
    startRow += BATCH_SIZE;
    await delay(DELAY_MS);
  }

  console.log(`[SA-SYNC] Complete. Total payments: ${totalFetched}`);
  await browser.close();
}

run().catch(console.error);
