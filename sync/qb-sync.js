/**
 * qb-sync.js
 * QuickBooks Online Invoice + Payment Downloader
 * Uses PRODUCTION credentials and QBO API.
 */

const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const QB_BASE = 'https://quickbooks.api.intuit.com/v3/company';
const REALM_ID = process.env.QB_REALM_ID;
const BATCH_SIZE = 1000;
const delay = ms => new Promise(r => setTimeout(r, ms));

async function refreshAccessToken() {
  if (!process.env.QB_CLIENT_ID || !process.env.QB_CLIENT_SECRET || !process.env.QB_REFRESH_TOKEN) {
    console.error('[ERROR] QB_CLIENT_ID, QB_CLIENT_SECRET, QB_REFRESH_TOKEN required in .env');
    process.exit(1);
  }
  const creds = Buffer.from(`${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`).toString('base64');
  const params = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: process.env.QB_REFRESH_TOKEN });
  try {
    const res = await axios.post('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', params.toString(), {
      headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    console.log('[QB-SYNC] Token refreshed successfully');
    return res.data.access_token;
  } catch(err) {
    console.error('[QB-SYNC] Token refresh failed:', err.response?.data || err.message);
    process.exit(1);
  }
}

async function qbQuery(token, query) {
  const res = await axios.get(`${QB_BASE}/${REALM_ID}/query`, {
    params: { query, minorversion: 65 },
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
  });
  return res.data.QueryResponse;
}

async function syncInvoices(token) {
  console.log('[QB-SYNC] Fetching invoices...');
  let startPos = 1, totalFetched = 0;
  while (true) {
    const query = `SELECT * FROM Invoice STARTPOSITION ${startPos} MAXRESULTS ${BATCH_SIZE}`;
    const response = await qbQuery(token, query);
    const invoices = response?.Invoice || [];
    if (!invoices.length) break;
    const rows = invoices.map(inv => ({
      qb_id:          inv.Id,
      invoice_number: inv.DocNumber,
      customer_name:  inv.CustomerRef?.name,
      amount:         parseFloat(inv.TotalAmt) || 0,
      balance:        parseFloat(inv.Balance) || 0,
      date:           inv.TxnDate,
      due_date:       inv.DueDate,
      status:         parseFloat(inv.Balance) === 0 ? 'Paid' : parseFloat(inv.Balance) < parseFloat(inv.TotalAmt) ? 'Partial' : 'Open',
      raw_data:       inv,
      synced_at:      new Date().toISOString()
    }));
    const { error } = await supabase.from('qb_invoices').upsert(rows, { onConflict: 'qb_id' });
    if (error) console.error('[QB-SYNC ERROR]', error.message);
    totalFetched += invoices.length;
    console.log(`[QB-SYNC] Invoices: ${totalFetched} fetched`);
    if (invoices.length < BATCH_SIZE) break;
    startPos += BATCH_SIZE;
    await delay(200);
  }
  console.log(`[QB-SYNC] Invoices complete: ${totalFetched} total`);
  return totalFetched;
}

async function syncPayments(token) {
  console.log('[QB-SYNC] Fetching payments...');
  let startPos = 1, totalFetched = 0;
  while (true) {
    const query = `SELECT * FROM Payment STARTPOSITION ${startPos} MAXRESULTS ${BATCH_SIZE}`;
    const response = await qbQuery(token, query);
    const payments = response?.Payment || [];
    if (!payments.length) break;
    const rows = payments.map(pmt => ({
      qb_id:          pmt.Id,
      customer_name:  pmt.CustomerRef?.name,
      amount:         parseFloat(pmt.TotalAmt) || 0,
      date:           pmt.TxnDate,
      payment_method: pmt.PaymentMethodRef?.name || null,
      raw_data:       pmt,
      synced_at:      new Date().toISOString()
    }));
    const { error } = await supabase.from('qb_payments').upsert(rows, { onConflict: 'qb_id' });
    if (error) console.error('[QB-SYNC ERROR]', error.message);
    totalFetched += payments.length;
    console.log(`[QB-SYNC] Payments: ${totalFetched} fetched`);
    if (payments.length < BATCH_SIZE) break;
    startPos += BATCH_SIZE;
    await delay(200);
  }
  console.log(`[QB-SYNC] Payments complete: ${totalFetched} total`);
  return totalFetched;
}

async function run() {
  if (!REALM_ID) {
    console.error('[ERROR] QB_REALM_ID required in .env');
    process.exit(1);
  }
  console.log('[QB-SYNC] Starting QuickBooks sync...');
  console.log(`[QB-SYNC] Realm ID: ${REALM_ID}`);
  const token = await refreshAccessToken();
  const invoices = await syncInvoices(token);
  const payments = await syncPayments(token);
  console.log('');
  console.log('═══════════════════════════════════════');
  console.log('  QB SYNC COMPLETE');
  console.log(`  Invoices: ${invoices}`);
  console.log(`  Payments: ${payments}`);
  console.log('═══════════════════════════════════════');
}

run().catch(console.error);
