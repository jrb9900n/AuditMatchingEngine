/**
 * setup.js
 * Pre-flight checker — validates all credentials and DB tables before running syncs.
 * Run this first: node setup.js
 */

const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
require('dotenv').config();

const REQUIRED_TABLES = ['sa_invoices','sa_payments','sa_payment_applications','qb_invoices','qb_payments','audit_matches'];
const REQUIRED_ENV_SA = ['SA_EMAIL','SA_PASSWORD','SUPABASE_URL','SUPABASE_SERVICE_KEY'];
const REQUIRED_ENV_QB = ['QB_CLIENT_ID','QB_CLIENT_SECRET','QB_REFRESH_TOKEN','QB_REALM_ID'];

let passed = 0, failed = 0;

function check(name, result, detail = '') {
  if (result) { console.log(`  ✅ ${name}`); passed++; }
  else { console.log(`  ❌ ${name}${detail ? ': ' + detail : ''}`); failed++; }
}

async function run() {
  console.log('');
  console.log('═══════════════════════════════════════════════');
  console.log('  AUDIT MATCHING ENGINE — PRE-FLIGHT CHECK');
  console.log('═══════════════════════════════════════════════');

  // ── 1. Environment variables ─────────────────────────────
  console.log('\n📋 Environment Variables:');
  REQUIRED_ENV_SA.forEach(k => check(k, !!process.env[k], !process.env[k] ? 'missing in .env' : ''));

  const hasQB = REQUIRED_ENV_QB.every(k => !!process.env[k]);
  console.log('\n📋 QuickBooks Variables (needed for qb-sync):');
  REQUIRED_ENV_QB.forEach(k => check(k, !!process.env[k], !process.env[k] ? 'missing — complete OAuth first' : ''));

  // ── 2. Supabase connection ────────────────────────────────
  console.log('\n🗄️  Supabase Connection:');
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    check('Supabase credentials', false, 'SUPABASE_URL or SUPABASE_SERVICE_KEY missing');
  } else {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    for (const table of REQUIRED_TABLES) {
      try {
        const { count, error } = await supabase.from(table).select('*', { count: 'exact', head: true });
        if (error) check(`Table: ${table}`, false, error.message);
        else check(`Table: ${table} (${count} rows)`, true);
      } catch(e) {
        check(`Table: ${table}`, false, e.message);
      }
    }
  }

  // ── 3. QB OAuth (if credentials present) ─────────────────
  if (hasQB) {
    console.log('\n🔐 QuickBooks OAuth:');
    try {
      const creds = Buffer.from(`${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`).toString('base64');
      const params = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: process.env.QB_REFRESH_TOKEN });
      const res = await axios.post('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', params.toString(), {
        headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      check('QB token refresh', !!res.data.access_token);
    } catch(e) {
      check('QB token refresh', false, e.response?.data?.error || e.message);
    }
  }

  // ── Summary ───────────────────────────────────────────────
  console.log('');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════');

  if (failed === 0) {
    console.log('  ✅ All checks passed! Ready to run:');
    console.log('     npm run sync:all   (SA + QB data)');
    console.log('     npm run match      (matching engine)');
  } else {
    console.log('  ⚠️  Fix the issues above before running syncs.');
    if (!hasQB) {
      console.log('');
      console.log('  QB OAuth steps:');
      console.log('  1. Go to developer.intuit.com/app/developer/playground');
      console.log('  2. Enter Client ID + Secret, get authorization code');
      console.log('  3. Run: node sync/qb-get-tokens.js <code> 9341456862365430');
      console.log('  4. Add QB_REFRESH_TOKEN to .env');
    }
  }
  console.log('');
}

run().catch(console.error);
