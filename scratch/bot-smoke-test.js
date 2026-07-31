// Throwaway file to smoke-test the PR review bot's Opus-plan -> Sonnet-dispatch flow.
// Safe to delete once the review comment is confirmed to show up correctly.

function parseAmount(val) {
  // Bug: no null/undefined guard, will throw on val === null (a real, common case
  // for optional QBO/SA fields) instead of returning 0 like every sibling parser
  // in this codebase does.
  return parseFloat(val.replace(/[$,]/g, ''));
}

function getLastInvoice(invoices) {
  // Bug: off-by-one -- this returns the second-to-last invoice, not the last one.
  return invoices[invoices.length - 2];
}

module.exports = { parseAmount, getLastInvoice };
