/**
 * sa-payment-applications-sync.js
 * Service Autopilot Payment-to-Invoice Application Downloader
 *
 * For each payment, fetches the invoices it was applied to.
 * This is the key linkage table for the audit matching engine.
 *
 * CONFIRMED ENDPOINTS (reverse-engineered 2026-04-12):
 *   POST /WebServices/PaymentOverlayWs.asmx/GetPaymentData
 *     Payload: { "PaymentID": "<guid>" }
 *     Returns: Full payment detail including QboID
 *
 *   POST /WebServices/PaymentOverlayWs.asmx/GetAppliedInvoices
 *     Payload: { "PaymentID": "<guid>" }
 *     Returns: List of invoices this payment was applied to
 *
 * CONFIRMED LIVE EXAMPLE:
 *   Payment 7f795e40 ($97.06 Visa, 4/9/2026)
 *     -> Invoice #32310 ($97.06 total, $0.00 balance, date 4/8/2026)
 *     -> Customer: Ernie and Lisa Millard (Home)
 *
 * STRATEGY:
 *   1. Pull all payments from sa_payments table (already synced)
 *   2. For each payment, call GetAppliedInvoices
 *   3. Store each application record in sa_payment_applications
 *   Run AFTER sa-payment-sync.js and sa-invoice-sync.js
 */

const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const SA_BASE = 'https://my.serviceautopilot.com';
const DELAY_MS = 150; // polite delay

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const delay = ms => new Promise(r => setTimeout(r, ms));

async function fetchAppliedInvoices(page, paymentGuid) {
  return page.evaluate(async (paymentGuid) => {
    try {
      const res = await fetch('/WebServices/PaymentOverlayWs.asmx/GetAppliedInvoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ PaymentID: paymentGuid })
      });
      return res.json();
    } catch(e) { return { error: e.message }; }
  }, paymentGuid);
}

async function fetchPaymentDetail(page, paymentGuid) {
  return page.evaluate(async (paymentGuid) => {
    try {
      const res = await fetch('/WebServices/PaymentOverlayWs.asmx/GetPaymentData', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ PaymentID: paymentGuid })
      });
      return res.json();
    } catch(e) { return { error: e.message }; }
  }, paymentGuid);
}

async function saveApplications(paymentId, applications) {
  if (!applications.length) return;
  const rows = applications.map(app => ({
    payment_sa_id:   paymentId,
    invoice_number:  app.InvoiceNumber,
    invoice_sa_id:   app.InvoiceID,
    amount_applied:  app.AmountApplied || app.Payment || app.PaymentAmount,
    invoice_total:   app.InvoiceTotal || app.Total,
    balance_after:   app.Balance,
    invoice_date:    app.InvoiceDate || app.Date,
    customer_name:   app.CustomerName || app.Client,
    raw_data:        app,
    synced_at:       new Date().toISOString()
  }));
  const { error } = await supabase
    .from('sa_payment_applications')
    .upsert(rows, { onConflict: 'payment_sa_id,invoice_number' });
  if (error) console.error('[SUPABASE ERROR]', error.message);
}

async function run() {
  console.log('[APP-SYNC] Launching browser...');
  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  });
  const page = await context.newPage();

  // Login
  await page.goto(SA_BASE, { waitUntil: 'networkidle' });
  await page.fill('#txtLogin', process.env.SA_EMAIL);
  await page.fill('#txtPassword', process.env.SA_PASSWORD);
  await page.click('button:has-text("Log In")');
  await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 });
  await page.goto(`${SA_BASE}/Payments.aspx`, { waitUntil: 'networkidle' });
  await delay(2000);

  // Get all payment IDs from Supabase
  const { data: payments, error } = await supabase
    .from('sa_payments')
    .select('sa_id')
    .order('payment_date', { ascending: false });

  if (error) { console.error('[ERROR] Could not fetch payments:', error.message); process.exit(1); }
  console.log(`[APP-SYNC] Processing ${payments.length} payments...`);

  let processed = 0;
  let totalApplications = 0;

  for (const payment of payments) {
    try {
      const result = await fetchAppliedInvoices(page, payment.sa_id);
      const applications = result?.d?.AppliedInvoices || result?.d?.Invoices || result?.d || [];
      
      if (Array.isArray(applications) && applications.length) {
        await saveApplications(payment.sa_id, applications);
        totalApplications += applications.length;
      }

      processed++;
      if (processed % 100 === 0) console.log(`[APP-SYNC] Progress: ${processed}/${payments.length} payments processed, ${totalApplications} applications found`);
      await delay(DELAY_MS);

    } catch(err) {
      console.error(`[APP-SYNC] Error processing payment ${payment.sa_id}:`, err.message);
    }
  }

  console.log(`[APP-SYNC] Complete. ${processed} payments processed, ${totalApplications} applications saved.`);
  await browser.close();
}

run().catch(console.error);
