require('dotenv').config();
const axios = require('axios');

async function test() {
  const creds = Buffer.from(process.env.QB_CLIENT_ID + ':' + process.env.QB_CLIENT_SECRET).toString('base64');
  const r = await axios.post('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
    'grant_type=refresh_token&refresh_token=' + process.env.QB_REFRESH_TOKEN,
    { headers: { 'Authorization': 'Basic ' + creds, 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  const token = r.data.access_token;
  console.log('[TEST] Token refreshed OK');

  // Test the real realm from michael browser cookie
  const realms = [
    '9130357265584656',  // from michael QB browser cookie - MOST LIKELY CORRECT
    '9341456862365430',
    '9341456862346650',
    '9341456862333687',
  ];

  for (const realm of realms) {
    try {
      const res = await axios.get(
        'https://quickbooks.api.intuit.com/v3/company/' + realm + '/companyinfo/' + realm,
        { headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' } }
      );
      console.log('[REALM ' + realm + '] SUCCESS:', res.data.CompanyInfo?.CompanyName);
    } catch(e) {
      const code = e.response?.data?.Fault?.Error?.[0]?.code;
      console.log('[REALM ' + realm + '] FAILED:', e.response?.status, 'code:', code);
    }
  }
}
test().catch(e => console.error('[ERROR]', e.message));
