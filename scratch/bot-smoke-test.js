// Throwaway file to smoke-test the PR review bot's Opus-plan -> Sonnet-dispatch flow.
// Safe to delete once the review comment is confirmed to show up correctly.

function parseAmount(val) {
  // Guard: return 0 for null/undefined/empty string, consistent with every sibling
  // parser in this codebase that handles optional QBO/SA fields.
  if (val === null || val === undefined || val === '') return 0;
  // Guard: numeric inputs don't have .replace; return them directly.
  if (typeof val === 'number') return isNaN(val) ? 0 : val;
  const result = parseFloat(String(val).replace(/[$,]/g, ''));
  // parseFloat returns NaN for unparseable strings; coerce to 0 per sibling convention.
  return isNaN(result) ? 0 : result;
}

function getLastInvoice(invoices) {
  // Guard: return undefined for null/undefined/empty arrays to avoid TypeError
  // on .length access and silent data loss on single-element arrays.
  if (!invoices || invoices.length === 0) return undefined;
  // Fix: was invoices.length - 2 (off-by-one, returned second-to-last element).
  return invoices[invoices.length - 1];
}

module.exports = { parseAmount, getLastInvoice };
