/**
 * matching-engine.js
 * QuickBooks <-> Service Autopilot Audit Matching Engine
 *
 * MATCHING STRATEGY (3 tiers, in order of confidence):
 *
 * Tier 1 — Direct QboID match (confidence: 100%)
 *   SA invoices and payments both carry QboID from QB sync.
 *   When QboID is present, match directly. No ambiguity.
 *
 * Tier 2 — Invoice number match (confidence: 95%)
 *   SA InvoiceNumber (e.g. 32310) vs QB DocNumber.
 *   Highly reliable when QboID is missing (e.g. QB sync errors).
 *
 * Tier 3 — Fuzzy match (confidence: variable)
 *   Customer name similarity (Levenshtein) + amount match + date proximity.
 *   Used for unmatched records after Tiers 1 and 2.
 *   Flags for human review when score < FUZZY_THRESHOLD.
 *
 * DISCREPANCY TYPES:
 *   - amount_mismatch: SA and QB amounts differ by > AMOUNT_TOLERANCE
 *   - missing_in_qb: SA invoice has no QB match
 *   - missing_in_sa: QB invoice has no SA match
 *   - payment_not_applied: Payment exists but no application record
 *   - qb_sync_error: SA has QboID but QB record not found
 */

const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Tuning constants
const FUZZY_THRESHOLD    = 0.75;   // Min score to auto-match (below = needs review)
const AMOUNT_TOLERANCE   = 0.02;   // $0.02 tolerance for floating point differences
const DATE_WINDOW_DAYS   = 5;      // Days window for date proximity scoring

// ─── Levenshtein distance ────────────────────────────────────────────────────
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}

function nameSimilarity(a, b) {
  if (!a || !b) return 0;
  const norm = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/s+/g, ' ').trim();
  const na = norm(a), nb = norm(b);
  if (na === nb) return 1;
  const dist = levenshtein(na, nb);
  return 1 - dist / Math.max(na.length, nb.length, 1);
}

function parseAmount(val) {
  if (typeof val === 'number') return val;
  return parseFloat(String(val).replace(/[$,]/g, '')) || 0;
}

function parseDateMs(val) {
  if (!val) return null;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d.getTime();
}

function dateDiffDays(a, b) {
  const ta = parseDateMs(a), tb = parseDateMs(b);
  if (!ta || !tb) return 999;
  return Math.abs(ta - tb) / (1000 * 60 * 60 * 24);
}

// ─── Fuzzy match score ───────────────────────────────────────────────────────
function fuzzyScore(saInvoice, qbInvoice) {
  const nameSim   = nameSimilarity(saInvoice.client, qbInvoice.customer_name);
  const saAmt     = parseAmount(saInvoice.invoice_total);
  const qbAmt     = parseAmount(qbInvoice.amount);
  const amtMatch  = saAmt > 0 && qbAmt > 0 && Math.abs(saAmt - qbAmt) <= AMOUNT_TOLERANCE ? 1 : 0;
  const daysDiff  = dateDiffDays(saInvoice.date, qbInvoice.date);
  const dateScore = Math.max(0, 1 - daysDiff / DATE_WINDOW_DAYS);

  // Weighted average: name 40%, amount 40%, date 20%
  return (nameSim * 0.4) + (amtMatch * 0.4) + (dateScore * 0.2);
}

// ─── Main matching function ──────────────────────────────────────────────────
async function runMatching() {
  console.log('[MATCH] Loading SA invoices...');
  const { data: saInvoices, error: saErr } = await supabase
    .from('sa_invoices')
    .select('*')
    .eq('deleted', false);
  if (saErr) throw new Error('SA invoices: ' + saErr.message);

  console.log('[MATCH] Loading QB invoices...');
  const { data: qbInvoices, error: qbErr } = await supabase
    .from('qb_invoices')
    .select('*');
  if (qbErr) throw new Error('QB invoices: ' + qbErr.message);

  console.log(`[MATCH] Matching ${saInvoices.length} SA invoices against ${qbInvoices.length} QB invoices...`);

  // Build QB lookup maps for fast access
  const qbByQboId      = new Map(qbInvoices.filter(q => q.qb_id).map(q => [q.qb_id, q]));
  const qbByInvNumber  = new Map(qbInvoices.filter(q => q.invoice_number).map(q => [String(q.invoice_number), q]));
  const matchedQbIds   = new Set();

  const results = [];
  let tier1 = 0, tier2 = 0, tier3 = 0, unmatched = 0;

  for (const sa of saInvoices) {
    let match = null;
    let matchType = null;
    let score = 0;

    // ── Tier 1: Direct QboID ──────────────────────────────────────────────
    if (sa.qbo_id && qbByQboId.has(sa.qbo_id)) {
      match     = qbByQboId.get(sa.qbo_id);
      matchType = 'direct_qbo_id';
      score     = 1.0;
      tier1++;
    }

    // ── Tier 2: Invoice number ────────────────────────────────────────────
    if (!match && sa.invoice_number) {
      const qb = qbByInvNumber.get(String(sa.invoice_number));
      if (qb) {
        match     = qb;
        matchType = 'invoice_number';
        score     = 0.95;
        tier2++;
      }
    }

    // ── Tier 3: Fuzzy match ───────────────────────────────────────────────
    if (!match) {
      let bestScore = 0, bestMatch = null;
      for (const qb of qbInvoices) {
        if (matchedQbIds.has(qb.qb_id)) continue;
        const s = fuzzyScore(sa, qb);
        if (s > bestScore) { bestScore = s; bestMatch = qb; }
      }
      if (bestScore >= FUZZY_THRESHOLD) {
        match     = bestMatch;
        matchType = 'fuzzy';
        score     = bestScore;
        tier3++;
      } else {
        unmatched++;
      }
    }

    // ── Determine discrepancy status ──────────────────────────────────────
    let status = 'unmatched_sa';
    let amountDiff = null;

    if (match) {
      matchedQbIds.add(match.qb_id);
      const saAmt = parseAmount(sa.invoice_total);
      const qbAmt = parseAmount(match.amount);
      amountDiff  = saAmt - qbAmt;
      status = Math.abs(amountDiff) <= AMOUNT_TOLERANCE ? 'matched' : 'discrepancy';
    }

    results.push({
      sa_invoice_sa_id:  sa.sa_id,
      qb_invoice_id:     match?.qb_id || null,
      match_type:        match ? matchType : 'unmatched',
      match_score:       score,
      match_status:      status,
      sa_amount:         parseAmount(sa.invoice_total),
      qb_amount:         match ? parseAmount(match.amount) : null,
      amount_diff:       amountDiff,
      sa_customer:       sa.client,
      qb_customer:       match?.customer_name || null,
      notes:             score < FUZZY_THRESHOLD && match ? 'Low confidence fuzzy match - review recommended' : null,
      created_at:        new Date().toISOString()
    });
  }

  // ── Flag QB invoices with no SA match ─────────────────────────────────
  for (const qb of qbInvoices) {
    if (!matchedQbIds.has(qb.qb_id)) {
      results.push({
        sa_invoice_sa_id: null,
        qb_invoice_id:    qb.qb_id,
        match_type:       'unmatched',
        match_score:      0,
        match_status:     'unmatched_qb',
        sa_amount:        null,
        qb_amount:        parseAmount(qb.amount),
        amount_diff:      null,
        sa_customer:      null,
        qb_customer:      qb.customer_name,
        notes:            'In QB but not found in SA',
        created_at:       new Date().toISOString()
      });
    }
  }

  // ── Save results ──────────────────────────────────────────────────────
  console.log('[MATCH] Saving results to audit_matches...');

  // Clear previous results
  await supabase.from('audit_matches').delete().neq('id', 0);

  // Batch insert in chunks of 500
  const CHUNK = 500;
  for (let i = 0; i < results.length; i += CHUNK) {
    const chunk = results.slice(i, i + CHUNK);
    const { error } = await supabase.from('audit_matches').insert(chunk);
    if (error) console.error('[MATCH ERROR]', error.message);
  }

  // ── Summary ───────────────────────────────────────────────────────────
  const matched     = results.filter(r => r.match_status === 'matched').length;
  const discrepancy = results.filter(r => r.match_status === 'discrepancy').length;
  const unmatchedSA = results.filter(r => r.match_status === 'unmatched_sa').length;
  const unmatchedQB = results.filter(r => r.match_status === 'unmatched_qb').length;

  console.log('');
  console.log('═══════════════════════════════════════');
  console.log('  AUDIT MATCHING COMPLETE');
  console.log('═══════════════════════════════════════');
  console.log(`  Total SA invoices:     ${saInvoices.length}`);
  console.log(`  Total QB invoices:     ${qbInvoices.length}`);
  console.log(`  Tier 1 (QboID):        ${tier1}`);
  console.log(`  Tier 2 (Inv Number):   ${tier2}`);
  console.log(`  Tier 3 (Fuzzy):        ${tier3}`);
  console.log(`  ✅ Matched:            ${matched}`);
  console.log(`  ⚠️  Discrepancies:     ${discrepancy}`);
  console.log(`  ❌ Unmatched SA:       ${unmatchedSA}`);
  console.log(`  ❌ Unmatched QB:       ${unmatchedQB}`);
  console.log('═══════════════════════════════════════');
}

runMatching().catch(console.error);
