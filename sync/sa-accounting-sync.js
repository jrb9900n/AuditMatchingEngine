/**
 * sa-accounting-sync.js
 * Service Autopilot Accounting Data Extractor
 * 
 * Extracts invoice, payment, and accounting data from Service Autopilot
 * by driving a real Chromium browser via Playwright (required to bypass Incapsula WAF).
 * 
 * Target pages:
 *   - Accounting dropdown -> Invoices
 *   - Accounting dropdown -> Payments
 * 
 * Discovered endpoints will be stored in discovered-endpoints.json
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SA_BASE = 'https://my.serviceautopilot.com';
const ENDPOINTS_FILE = path.join(__dirname, 'discovered-endpoints.json');
const DATA_DIR = path.join(__dirname, '..', 'data');

// Delay helper
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run() {
  console.log('[SA-SYNC] Starting Service Autopilot accounting sync...');
  
  if (!process.env.SA_EMAIL || !process.env.SA_PASSWORD) {
    console.error('[SA-SYNC] ERROR: SA_EMAIL and SA_PASSWORD environment variables required');
    process.exit(1);
  }

  const discoveredEndpoints = [];

  const browser = await chromium.launch({ 
    headless: false, // Must be false - SA WAF blocks headless
    slowMo: 100 
  });
  
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });

  // Intercept all .asmx requests
  context.on('request', request => {
    const url = request.url();
    if (url.includes('.asmx')) {
      console.log('[ENDPOINT FOUND]', request.method(), url);
      console.log('  Payload:', request.postData()?.substring(0, 200));
      discoveredEndpoints.push({
        method: request.method(),
        url,
        payload: request.postData(),
        timestamp: new Date().toISOString()
      });
    }
  });

  context.on('response', async response => {
    const url = response.url();
    if (url.includes('.asmx')) {
      try {
        const body = await response.text();
        console.log('[RESPONSE]', url, '→', body.substring(0, 300));
      } catch(e) {}
    }
  });

  const page = await context.newPage();

  try {
    // Step 1: Login
    console.log('[SA-SYNC] Navigating to login page...');
    await page.goto(`${SA_BASE}/`, { waitUntil: 'networkidle' });
    await delay(2000);

    console.log('[SA-SYNC] Filling login form...');
    await page.fill('input[type="email"], input[name*="email"], input[name*="Email"], #email', process.env.SA_EMAIL);
    await delay(500);
    await page.fill('input[type="password"], input[name*="password"], input[name*="Password"], #password', process.env.SA_PASSWORD);
    await delay(500);
    await page.click('button[type="submit"], input[type="submit"], .login-btn, .btn-login');
    
    await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 });
    await delay(3000);
    console.log('[SA-SYNC] Login complete. Current URL:', page.url());

    // Step 2: Navigate to Accounting -> Invoices
    console.log('[SA-SYNC] Looking for Accounting menu...');
    
    // Try clicking Accounting dropdown
    const accountingSelectors = [
      'a:has-text("Accounting")',
      'li:has-text("Accounting") > a',
      '[href*="accounting"]',
      'nav a:has-text("Accounting")'
    ];
    
    for (const sel of accountingSelectors) {
      try {
        await page.click(sel, { timeout: 3000 });
        console.log('[SA-SYNC] Clicked Accounting with selector:', sel);
        await delay(1500);
        break;
      } catch(e) {}
    }

    // Click Invoices
    const invoiceSelectors = [
      'a:has-text("Invoices")',
      'li:has-text("Invoices") > a',
      '[href*="invoice"]'
    ];

    for (const sel of invoiceSelectors) {
      try {
        await page.click(sel, { timeout: 3000 });
        console.log('[SA-SYNC] Clicked Invoices with selector:', sel);
        await delay(3000);
        break;
      } catch(e) {}
    }

    console.log('[SA-SYNC] On Invoices page. Waiting for data load...');
    await delay(5000);

    // Step 3: Navigate to Accounting -> Payments
    console.log('[SA-SYNC] Navigating to Payments...');
    for (const sel of accountingSelectors) {
      try {
        await page.click(sel, { timeout: 3000 });
        await delay(1500);
        break;
      } catch(e) {}
    }

    const paymentSelectors = [
      'a:has-text("Payments")',
      'li:has-text("Payments") > a',
      '[href*="payment"]'
    ];

    for (const sel of paymentSelectors) {
      try {
        await page.click(sel, { timeout: 3000 });
        console.log('[SA-SYNC] Clicked Payments with selector:', sel);
        await delay(3000);
        break;
      } catch(e) {}
    }

    await delay(5000);

  } catch(err) {
    console.error('[SA-SYNC] Error:', err.message);
  } finally {
    // Save discovered endpoints
    fs.writeFileSync(ENDPOINTS_FILE, JSON.stringify(discoveredEndpoints, null, 2));
    console.log(`[SA-SYNC] Saved ${discoveredEndpoints.length} discovered endpoints to ${ENDPOINTS_FILE}`);
    
    await browser.close();
  }
}

run().catch(console.error);
