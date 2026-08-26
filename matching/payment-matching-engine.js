/**
 * payment-matching-engine.js
 * QuickBooks <-> Service Autopilot payment reconciliation
 *
 * Mirrors matching-engine.js (which matches invoices) but for payments.
 * SA never populates a payment-level QboID link (confirmed 2026-07-31 — 0 of
 * ~7,000 sa_payments rows have qbo_id set), so Tier 1 will rarely fire today,
 * but is kept for forward compatibility in case that ever changes.
 *
 * MATCHING STRATEGY (2 tiers):
 *
 * Tier 1 — Direct QboID match (confidence: 100%)
 *   sa_payments.qbo_id === qb_payments.qb_id, when present.
 *
 * Tier 2 — Fuzzy match (confidence: variable)
 *   Customer name similarity (Levenshtein) + amount match (exact, payments
 *   don't partial-settle the way invoice balances do) + date proximity.
 *   Flags for human review when score < FUZZY_THRESHOLD.
 */

const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Tuning constants — DATE_WINDOW_DAYS wider than the invoice engine's (5d) since
// payment posting dates lag the actual transaction date more than invoice dates do.
const FUZZY_THRESHOLD  = 0.75;
const AMOUNT_TOLERANCE = 0.02;
const DATE_WINDOW_DAYS = 7;

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
  const norm = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
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

const QB_METHOD_NAMES = {
  '51': 'ACH', '44': 'Check', '43': 'Cash', '49': 'Debit Card',
  '45': 'American Express', '46': 'Discover', '47': 'MasterCard',
  '48': 'Visa', '50': 'Gift Card', '52': 'Trade Account', '55': 'Visa-DUP',
};
function qbPaymentMethodName(qb) {
  if (qb.payment_method) return qb.payment_method;
  const id = qb.raw_data?.PaymentMethodRef?.value;
  return QB_METHOD_NAMES[id] || (id ? `Unknown(${id})` : null);
}

function fuzzyScore(sa, qb) {
  const nameSim   = nameSimilarity(sa.client, qb.customer_name);
  const saAmt     = parseAmount(sa.payment_amount);
  const qbAmt     = parseAmount(qb.amount);
  // Payments are all-or-nothing at the transaction level (unlike invoice
  // balances, which partial-settle) — require an exact amount match, not a
  // tolerance-scaled score, so two coincidentally-similar amounts don't
  // outscore a real match elsewhere in the candidate set.
  const amtMatch  = saAmt > 0 && qbAmt > 0 && Math.abs(saAmt - qbAmt) <= AMOUNT_TOLERANCE ? 1 : 0;
  const daysDiff  = dateDiffDays(sa.payment_date, qb.date);
  const dateScore = Math.max(0, 1 - daysDiff / DATE_WINDOW_DAYS);

  // Amount is the strongest signal for payments (name variants are common —
  // "Bob Smith" vs "Robert & Bob Smith" — but two unrelated payments landing
  // on the exact same dollar amount within the date window is rare).
  return (nameSim * 0.3) + (amtMatch * 0.5) + (dateScore * 0.2);
}

async function runMatching() {
  console.log('[PAY-MATCH] Loading SA payments...');
  const { data: saPayments, error: saErr } = await supabase
    .from('sa_payments')
    .select('*')
    .eq('deleted', false);
  if (saErr) throw new Error('SA payments: ' + saErr.message);

  console.log('[PAY-MATCH] Loading QB payments...');
  const { data: qbPayments, error: qbErr } = await supabase
    .from('qb_payments')
    .select('*');
  if (qbErr) throw new Error('QB payments: ' + qbErr.message);

  console.log(`[PAY-MATCH] Matching ${saPayments.length} SA payments against ${qbPayments.length} QB payments...`);

  const qbByQboId = new Map(qbPayments.filter(q => q.qb_id).map(q => [q.qb_id, q]));
  const matchedQbIds = new Set();

  // Bucket QB payments by rounded amount so the fuzzy pass doesn't scan the
  // full ~7,500-row QB set for every SA payment (O(n*m) was fine for the
  // one-off manual check but this runs unattended on a schedule).
  const qbByAmount = new Map();
  for (const qb of qbPayments) {
    const key = parseAmount(qb.amount).toFixed(2);
    if (!qbByAmount.has(key)) qbByAmount.set(key, []);
    qbByAmount.get(key).push(qb);
  }

  const results = [];
  let tier1 = 0, tier2 = 0, unmatched = 0;

  for (const sa of saPayments) {
    let match = null;
    let matchType = null;
    let score = 0;

    // ── Tier 1: Direct QboID (rarely present today, kept for forward compat) ──
    if (sa.qbo_id && qbByQboId.has(sa.qbo_id)) {
      match = qbByQboId.get(sa.qbo_id);
      matchType = 'direct_qbo_id';
      score = 1.0;
      tier1++;
    }

    // ── Tier 2: Fuzzy match, scoped to same-amount candidates ─────────────
    if (!match) {
      const candidates = qbByAmount.get(parseAmount(sa.payment_amount).toFixed(2)) || [];
      let bestScore = 0, bestMatch = null;
      for (const qb of candidates) {
        if (matchedQbIds.has(qb.qb_id)) continue;
        const s = fuzzyScore(sa, qb);
        if (s > bestScore) { bestScore = s; bestMatch = qb; }
      }
      if (bestScore >= FUZZY_THRESHOLD) {
        match = bestMatch;
        matchType = 'fuzzy';
        score = bestScore;
        tier2++;
      } else {
        unmatched++;
      }
    }

    let status = 'unmatched_sa';
    let amountDiff = null;

    if (match) {
      matchedQbIds.add(match.qb_id);
      const saAmt = parseAmount(sa.payment_amount);
      const qbAmt = parseAmount(match.amount);
      amountDiff = saAmt - qbAmt;
      status = Math.abs(amountDiff) <= AMOUNT_TOLERANCE ? 'matched' : 'discrepancy';
    }

    results.push({
      sa_payment_sa_id: sa.sa_id,
      qb_payment_id:    match?.qb_id || null,
      match_type:       match ? matchType : 'unmatched',
      match_score:      score,
      match_status:     status,
      sa_amount:        parseAmount(sa.payment_amount),
      qb_amount:        match ? parseAmount(match.amount) : null,
      amount_diff:      amountDiff,
      sa_customer:      sa.client,
      qb_customer:      match?.customer_name || null,
      payment_method:   match ? qbPaymentMethodName(match) : null,
      sa_payment_date:  sa.payment_date,
      qb_payment_date:  match?.date || null,
      notes:            score > 0 && score < FUZZY_THRESHOLD ? 'Low confidence fuzzy match - review recommended' : null,
      created_at:       new Date().toISOString(),
    });
  }

  for (const qb of qbPayments) {
    if (!matchedQbIds.has(qb.qb_id)) {
      results.push({
        sa_payment_sa_id: null,
        qb_payment_id:    qb.qb_id,
        match_type:       'unmatched',
        match_score:      0,
        match_status:     'unmatched_qb',
        sa_amount:        null,
        qb_amount:        parseAmount(qb.amount),
        amount_diff:      null,
        sa_customer:      null,
        qb_customer:      qb.customer_name,
        payment_method:   qbPaymentMethodName(qb),
        sa_payment_date:  null,
        qb_payment_date:  qb.date,
        notes:            'In QB but not found in SA',
        created_at:       new Date().toISOString(),
      });
    }
  }

  console.log('[PAY-MATCH] Saving results to payment_matches...');
  await supabase.from('payment_matches').delete().neq('id', 0);

  const CHUNK = 500;
  for (let i = 0; i < results.length; i += CHUNK) {
    const chunk = results.slice(i, i + CHUNK);
    const { error } = await supabase.from('payment_matches').insert(chunk);
    if (error) console.error('[PAY-MATCH ERROR]', error.message);
  }

  const matched     = results.filter(r => r.match_status === 'matched').length;
  const discrepancy = results.filter(r => r.match_status === 'discrepancy').length;
  const unmatchedSA = results.filter(r => r.match_status === 'unmatched_sa').length;
  const unmatchedQB = results.filter(r => r.match_status === 'unmatched_qb').length;

  console.log('');
  console.log('═══════════════════════════════════════');
  console.log('  PAYMENT MATCHING COMPLETE');
  console.log('═══════════════════════════════════════');
  console.log(`  Total SA payments:     ${saPayments.length}`);
  console.log(`  Total QB payments:     ${qbPayments.length}`);
  console.log(`  Tier 1 (QboID):        ${tier1}`);
  console.log(`  Tier 2 (Fuzzy):        ${tier2}`);
  console.log(`  ✅ Matched:            ${matched}`);
  console.log(`  ⚠️  Discrepancies:     ${discrepancy}`);
  console.log(`  ❌ Unmatched SA:       ${unmatchedSA}`);
  console.log(`  ❌ Unmatched QB:       ${unmatchedQB}`);
  console.log('═══════════════════════════════════════');
}

runMatching().catch(console.error);
