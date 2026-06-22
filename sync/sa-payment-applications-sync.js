/**
 * sa-payment-applications-sync.js (fixed)
 * - Handles HTML responses (session timeout / WAF) gracefully
 * - Re-authenticates automatically when session expires
 * - Resumes from last checkpoint (skips already-processed payments)
 * - Retries failed payments up to 3 times
 */

const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const SA_BASE  = 'https://my.serviceautopilot.com';
const DELAY_MS = 300;
const MAX_RETRIES = 6;
const fs = require('fs');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const delay = ms => new Promise(r => setTimeout(r, ms));

// ─── Fetch with HTML-safe response handling ───────────────────────────────────
async function fetchAppliedInvoices(page, paymentGuid) {
  return page.evaluate(async (paymentGuid) => {
    try {
      const res = await fetch('/WebServices/PaymentOverlayWs.asmx/GetAppliedInvoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ PaymentID: paymentGuid })
      });
      const text = await res.text();
      // If it starts with < it's an HTML error page (session expired / WAF)
      if (text.trimStart().startsWith('<')) {
        return { __html_response: true, status: res.status };
      }
      return JSON.parse(text);
    } catch (e) {
      return { error: e.message };
    }
  }, paymentGuid);
}

// ─── Re-login ─────────────────────────────────────────────────────────────────
async function login(page) {
  console.log('[APP-SYNC] Logging in...');
  await page.goto(SA_BASE, { waitUntil: 'networkidle' });
  await page.fill('#txtLogin',    process.env.SA_EMAIL);
  await page.fill('#txtPassword', process.env.SA_PASSWORD);
  await page.click('button:has-text("Log In")');
  await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 20000 });
  await page.goto(`${SA_BASE}/Payments.aspx`, { waitUntil: 'networkidle' });
  await delay(2000);
  console.log('[APP-SYNC] Logged in.');
}

// ─── Save applications to Supabase ───────────────────────────────────────────
async function saveApplications(paymentSaId, applications) {
  if (!applications.length) return;
  const rows = applications.map(app => ({
    payment_sa_id:  paymentSaId,
    invoice_number: app.InvoiceNumber,
    invoice_sa_id:  app.InvoiceID,
    amount_applied: app.AmountApplied ?? app.Payment ?? app.PaymentAmount ?? 0,
    invoice_total:  app.InvoiceTotal  ?? app.Total   ?? null,
    balance_after:  app.Balance       ?? null,
    invoice_date:   app.InvoiceDate   ?? app.Date    ?? null,
    customer_name:  app.CustomerName  ?? app.Client  ?? null,
    raw_data:       app,
    synced_at:      new Date().toISOString()
  }));
  const { error } = await supabase
    .from('sa_payment_applications')
    .upsert(rows, { onConflict: 'payment_sa_id,invoice_number' });
  if (error) console.error('[SUPABASE ERROR]', error.message);
}

// ─── Get already-processed payment IDs so we can resume ──────────────────────
async function getAlreadyProcessed() {
  const { data, error } = await supabase
    .from('sa_payment_applications')
    .select('payment_sa_id');
  if (error) return new Set();
  return new Set(data.map(r => r.payment_sa_id));
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function run() {
  console.log('[APP-SYNC] Starting...');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();
  await login(page);

  // Load all payments from Supabase
  const { data: payments, error: payErr } = await supabase
    .from('sa_payments')
    .select('sa_id, payment_date, client')
    .order('payment_date', { ascending: false });
  if (payErr) { console.error('[ERROR]', payErr.message); process.exit(1); }
  console.log(`[APP-SYNC] ${payments.length} payments to process.`);

  // Resume: skip payments already in sa_payment_applications
  const alreadyDone = await getAlreadyProcessed();
  const todo = payments.filter(p => !alreadyDone.has(p.sa_id));
  console.log(`[APP-SYNC] ${alreadyDone.size} already processed. ${todo.length} remaining.`);

  let processed = 0;
  let skippedEmpty = 0;
  let errors = 0;
  let totalApplications = 0;
  let sessionErrors = 0;

  for (const payment of todo) {
    let result = null;
    let success = false;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      result = await fetchAppliedInvoices(page, payment.sa_id);

      // Session expired — re-login and retry
      if (result?.__html_response) {
        sessionErrors++;
        console.log(`[APP-SYNC] Session expired (payment ${payment.sa_id}), re-logging in... (attempt ${attempt})`);

        // If we've re-logged in many times but saved nothing, the portal is likely
        // blocking the session entirely (e.g. bot detection). Abort early.
        if (sessionErrors >= 20 && processed === 0) {
          console.error(`[APP-SYNC] ABORT: ${sessionErrors} re-logins with 0 successful fetches — portal is blocking this session. Exiting.`);
          await browser.close();
          process.exit(1);
        }

        await login(page);
        await delay(1000);
        continue;
      }

      // Non-session error (network, bad JSON, etc.) — no point retrying
      if (result?.error) {
        console.warn(`[APP-SYNC] Fetch error (no retry): ${result.error}`);
        break;
      }

      success = true;
      break;
    }

    if (!success) {
      console.error(`[APP-SYNC] Failed after ${MAX_RETRIES} attempts: payment ${payment.sa_id}`);
      errors++;
      continue;
    }

    const applications = result?.d?.AppliedInvoices
      ?? result?.d?.Invoices
      ?? (Array.isArray(result?.d) ? result.d : []);

    if (Array.isArray(applications) && applications.length > 0) {
      await saveApplications(payment.sa_id, applications);
      totalApplications += applications.length;
    } else {
      skippedEmpty++;
    }

    processed++;
    if (processed % 100 === 0) {
      console.log(`[APP-SYNC] ${processed}/${todo.length} processed | ${totalApplications} applications | ${errors} errors | ${sessionErrors} re-logins`);
    }

    await delay(DELAY_MS);
  }

  console.log(`\n[APP-SYNC] Done.`);
  console.log(`  Processed:    ${processed}`);
  console.log(`  Applications: ${totalApplications}`);
  console.log(`  Empty:        ${skippedEmpty}`);
  console.log(`  Errors:       ${errors}`);
  console.log(`  Re-logins:    ${sessionErrors}`);

  await browser.close();
}

run().catch(console.error);
