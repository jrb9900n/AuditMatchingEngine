# AuditMatchingEngine

Financial reconciliation engine: QuickBooks vs Service Autopilot.

## Status: Awaiting QB OAuth tokens — everything else ready

## Quick Start
```bash
npm install && npx playwright install chromium
cp .env.example .env
node setup.js
npm run sync:sa
npm run sync:qb  # needs OAuth first
npm run match
```

## QB OAuth
1. developer.intuit.com/app/developer/playground
2. Client ID + Secret → Get Authorization Code → authorize
3. node sync/qb-get-tokens.js <code> 9341456862365430
4. Add QB_REFRESH_TOKEN to .env → npm run sync:qb

## Key Values
- QB Client ID: ABnfJZ9B4zp4zRcbV6sThPI4LzJdmBup4O8KOhgrQnWQLzI2EW
- QB Realm ID: 9341456862365430
- Redirect URI: https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl
- Supabase: https://aaefxprwvewxwxqjrfzs.supabase.co

## SA Data
- 8,439 invoices in Supabase
- 6,090 payments ready
- Payment-to-invoice: GetAppliedInvoices confirmed working
