/**
 * sa-payment-sync.js
 * Service Autopilot Payment Batch Downloader
 *
 * CONFIRMED ENDPOINT: POST /WebServices/PaymentListWs.asmx/Query
 * TOTAL RECORDS (1/1/2023-4/12/2026): 6,090
 *
 * PAGINATION NOTE:
 *   StartRow and MaxRow are 1-based inclusive range (not offset+size).
 *   Batch 1: StartRow:1,   MaxRow:100  -> rows 1-100
 *   Batch 2: StartRow:101, MaxRow:200  -> rows 101-200
 *   Batch 3: StartRow:201, MaxRow:300  -> rows 201-300
 */

const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const SA_BASE = 'https://my.serviceautopilot.com';
const BATCH_SIZE = 100;
const DELAY_MS = 300;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const delay = ms => new Promise(r => setTimeout(r, ms));

function parseAmount(val) {
  if (typeof val === 'number') return val;
  return parseFloat(String(val).replace(/[$,]/g, '')) || 0;
}

async function fetchPaymentBatch(page, startRow, endRow, startDate, endDate) {
  return page.evaluate(async ({ startRow, endRow, startDate, endDate }) => {
    const res = await fetch('/WebServices/PaymentListWs.asmx/Query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        PaymentListQueryData: {
          StartRow: startRow,
          StartDate: { Month: startDate.month, Day: startDate.day, Year: startDate.year },
          EndDate:   { Month: endDate.month,   Day: endDate.day,   Year: endDate.year },
          Client: '', Reference: '',
          MaxRow: endRow,
          Address: '', PaymentMethodTypes: [], ActiveTab: 'Payments'
        }
      })
    });
    return res.json();
  }, { startRow, endRow, startDate, endDate });
}

async function saveToSupabase(payments) {
  if (!payments.length) return;
  const rows = payments.map(p => ({
    sa_id:           p.ID,
    customer_id:     p.CustomerID,
    client:          p.Client,
    address:         p.Address,
    payment_date:    p.PaymentDate,
    payment_amount:  parseAmount(p.PaymentAmount),
    unused_amount:   parseAmount(p.UnusedAmount),
    refunded_amount: parseAmount(p.RefundedAmount),
    reference:       p.Reference,
    notes:           p.Notes,
    payment_type:    p.Type,
    deleted:         p.Deleted || false,
    raw_data:        p,
    synced_at:       new Date().toISOString()
  }));
  const { error } = await supabase
    .from('sa_payments')
    .upsert(rows, { onConflict: 'sa_id' });
  if (error) console.error('[SUPABASE ERROR]', error.message);
  else console.log(`[SUPABASE] Saved ${rows.length} payments`);
}

async function run() {
  // END_DATE is always today so each run picks up new payments.
  const now = new Date();
  const END_DATE = { month: now.getMonth() + 1, day: now.getDate(), year: now.getFullYear() };

  // Incremental mode: if the table already has recent data (last payment within 7 days),
  // scan only the past 90 days to keep weekly runs fast (~15 min vs 1-2 hrs full).
  let startFrom = new Date('2023-01-01');
  try {
    const { data } = await supabase.from('sa_payments').select('payment_date').order('payment_date', { ascending: false }).limit(1);
    if (data?.[0]?.payment_date) {
      const daysSince = (now - new Date(data[0].payment_date)) / 86400000;
      if (daysSince < 7) {
        startFrom = new Date(now - 90 * 86400000);
        console.log(`[SA-SYNC] Incremental mode: ${startFrom.toISOString().slice(0, 10)} to today`);
      } else {
        console.log(`[SA-SYNC] Full mode: last payment ${data[0].payment_date} is ${Math.round(daysSince)}d old`);
      }
    }
  } catch (e) {
    console.warn(`[SA-SYNC] Could not check last sync date, using full mode: ${e.message}`);
  }
  const START_DATE = { month: startFrom.getMonth() + 1, day: startFrom.getDate(), year: startFrom.getFullYear() };

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
    const endRow = startRow + BATCH_SIZE - 1;
    console.log(`[SA-SYNC] Fetching payments rows ${startRow}-${endRow}...`);
    
    const result = await fetchPaymentBatch(page, startRow, endRow, START_DATE, END_DATE);
    const batch = result?.d?.PaymentItems || [];

    if (!batch.length) {
      emptyCount++;
      console.log(`[SA-SYNC] Empty batch (${emptyCount}/3)`);
    } else {
      emptyCount = 0;
      await saveToSupabase(batch);
      totalFetched += batch.length;
      console.log(`[SA-SYNC] Progress: ${totalFetched} payments synced`);
      startRow += BATCH_SIZE;
      await delay(DELAY_MS);
    }
  }

  console.log(`[SA-SYNC] Complete. Total: ${totalFetched} payments`);
  await browser.close();
}

run().catch(console.error);
