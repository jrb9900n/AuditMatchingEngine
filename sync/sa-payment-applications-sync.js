/**
 * sa-payment-applications-sync.js (fixed)
 * - Handles HTML responses (session timeout / WAF) gracefully
 * - Re-authenticates automatically when session expires
 * - Resumes from last checkpoint (skips already-processed payments)
 * - Retries failed payments up to 3 times
 *
 * 2026-08-19: switched from PaymentOverlayWs.asmx/GetAppliedInvoices to
 * PaymentOverlayWs.asmx/GetPaymentData. The former is a confirmed, permanent
 * SA-side outage (returns SA's own generic error page for every payment,
 * regardless of ID, session, or record validity - see the fetchAppliedInvoices
 * comment below for the full diagnosis). GetPaymentData is a separate, already
 * proven-reliable endpoint (used elsewhere for QBStatus checks) that happens
 * to return the identical data under its own `Invoices` array - confirmed live
 * against real payments of both CreditCard and Check type, including an exact
 * match against a payment whose applications were already hand-verified via a
 * different path that same day. Same request body shape ({PaymentID}), so this
 * is a one-line endpoint swap plus one field-name fix (GetPaymentData's
 * invoice items use `Number`, not `InvoiceNumber`) - the existing
 * `result?.d?.Invoices` fallback below had already half-anticipated this.
 */

const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const SA_BASE  = 'https://my.serviceautopilot.com';
const DELAY_MS = 300;
const MAX_RETRIES = 6;
const MAX_SESSION_ERRORS = 20;
const fs = require('fs');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const delay = ms => new Promise(r => setTimeout(r, ms));

// ─── Fetch with HTML-safe response handling ───────────────────────────────────
async function fetchAppliedInvoices(page, paymentGuid) {
  return page.evaluate(async (paymentGuid) => {
    try {
      const res = await fetch('/WebServices/PaymentOverlayWs.asmx/GetPaymentData', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ PaymentID: paymentGuid })
      });
      const text = await res.text();
      if (text.trimStart().startsWith('<')) {
        // Any HTML response used to be assumed to mean session expired, which
        // triggered a re-login-and-retry loop. Confirmed 2026-08-18: this
        // endpoint can also return SA's own generic app error page (title
        // "Error", references "My Day" / a support phone number) with a 200
        // status - happens for a payment ID that has already synced fine in
        // the past, ruling out both session expiry and a bad record. Retrying
        // that case just burns re-logins for an error re-login can't fix.
        // Only the real login page (has the #txtLogin field) means the
        // session is actually gone.
        const isRealLoginPage = text.includes('txtLogin') && text.includes('txtPassword');
        return { __html_response: true, __is_login_page: isRealLoginPage, status: res.status, htmlSnippet: text.slice(0, 300) };
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
    // GetPaymentData's Invoices[] items use `Number`, not `InvoiceNumber`
    // (that field name is only what GetAppliedInvoices used to return).
    invoice_number: app.InvoiceNumber ?? app.Number,
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
    let attemptsMade = 0;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      attemptsMade = attempt;
      result = await fetchAppliedInvoices(page, payment.sa_id);

      // Genuine session expiry (real login page) — re-login and retry.
      if (result?.__html_response && result.__is_login_page) {
        sessionErrors++;
        console.log(`[APP-SYNC] Session expired (payment ${payment.sa_id}), re-logging in... (attempt ${attempt})`);

        // Abort once re-logins pile up, regardless of earlier progress — the
        // processed === 0 condition this used to carry meant a single early
        // success permanently disabled this guard for the rest of the run, so
        // a session that died for good later (password rotation, WAF block)
        // would grind through every remaining payment doing up to MAX_RETRIES
        // failed logins each, effectively hanging run:full for hours.
        if (sessionErrors >= MAX_SESSION_ERRORS) {
          console.error(`[APP-SYNC] ABORT: ${sessionErrors} total re-logins this run — SA session cannot be sustained. Exiting.`);
          await browser.close();
          process.exit(1);
        }

        await login(page);
        await delay(1000);
        continue;
      }

      // HTML response that is NOT the login page - SA's own generic app error
      // page. Confirmed 2026-08-18: this endpoint returns this same error page
      // for payments that have synced fine before, so it isn't a bad record
      // or an expired session - re-logging in cannot fix it. No point retrying.
      if (result?.__html_response) {
        console.warn(`[APP-SYNC] SA API error (not session expiry, no retry) for payment ${payment.sa_id}: ${result.htmlSnippet?.replace(/\s+/g, ' ').slice(0, 150)}`);
        break;
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
      console.error(`[APP-SYNC] Failed after ${attemptsMade} attempt${attemptsMade === 1 ? '' : 's'} (of ${MAX_RETRIES} max): payment ${payment.sa_id}`);
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
