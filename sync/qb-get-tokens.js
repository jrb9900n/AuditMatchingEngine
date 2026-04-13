/**
 * qb-get-tokens.js
 * QuickBooks OAuth2 Token Exchange Helper
 *
 * Run this ONCE after completing the OAuth flow in the browser.
 * It exchanges your authorization code for access + refresh tokens.
 *
 * STEPS:
 *   1. In developer.intuit.com OAuth Playground:
 *      - Enter Client ID and Client Secret
 *      - Click "Get Authorization Code"
 *      - Authorize with your QuickBooks account
 *      - Copy the "Authorization Code" shown
 *      - Copy the "RealmID" shown
 *
 *   2. Run: node qb-get-tokens.js <authorization_code> <realm_id>
 *
 *   3. Copy the refresh_token from the output into your .env file
 *
 * CONFIRMED VALUES:
 *   QB_CLIENT_ID=ABnfJZ9B4zp4zRcbV6sThPI4LzJdmBup4O8KOhgrQnWQLzI2EW
 *   QB_REALM_ID=9341456862365430
 *   Redirect URI: https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl
 */

const axios = require('axios');
require('dotenv').config();

async function getTokens(authCode, realmId) {
  const clientId     = process.env.QB_CLIENT_ID;
  const clientSecret = process.env.QB_CLIENT_SECRET;
  const redirectUri  = 'https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl';

  if (!clientId || !clientSecret) {
    console.error('[ERROR] QB_CLIENT_ID and QB_CLIENT_SECRET must be set in .env');
    process.exit(1);
  }

  console.log('[QB-AUTH] Exchanging authorization code for tokens...');

  const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const params = new URLSearchParams({
    grant_type:   'authorization_code',
    code:         authCode,
    redirect_uri: redirectUri
  });

  try {
    const res = await axios.post(
      'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
      params.toString(),
      {
        headers: {
          'Authorization': `Basic ${creds}`,
          'Content-Type':  'application/x-www-form-urlencoded',
          'Accept':        'application/json'
        }
      }
    );

    const { access_token, refresh_token, expires_in, x_refresh_token_expires_in } = res.data;

    console.log('');
    console.log('═══════════════════════════════════════════════════');
    console.log('  QB OAUTH TOKENS - ADD TO YOUR .env FILE');
    console.log('═══════════════════════════════════════════════════');
    console.log(`QB_REALM_ID=${realmId}`);
    console.log(`QB_REFRESH_TOKEN=${refresh_token}`);
    console.log('');
    console.log(`Access token (expires in ${expires_in}s - do not store):`);
    console.log(access_token.substring(0, 50) + '...');
    console.log(`Refresh token expires in: ${Math.round(x_refresh_token_expires_in / 86400)} days`);
    console.log('═══════════════════════════════════════════════════');
    console.log('');
    console.log('Add QB_REALM_ID and QB_REFRESH_TOKEN to your .env then run:');
    console.log('  npm run sync:qb');

  } catch (err) {
    console.error('[ERROR]', err.response?.data || err.message);
    console.error('');
    console.error('Make sure your authorization code is fresh (they expire in ~10 minutes)');
    console.error('Get a new one from: https://developer.intuit.com/app/developer/playground');
  }
}

const [,, authCode, realmId] = process.argv;
if (!authCode || !realmId) {
  console.error('Usage: node qb-get-tokens.js <authorization_code> <realm_id>');
  console.error('Example: node qb-get-tokens.js AB11abc123 9341456862365430');
  process.exit(1);
}

getTokens(authCode, realmId || process.env.QB_REALM_ID);
