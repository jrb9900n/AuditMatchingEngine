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
  console.log('[TEST] Client ID being used:', process.env.QB_CLIENT_ID?.substring(0,20));

  for (const realm of ['9341456862365430', '9341456862346650', '9341456862333687']) {
    try {
      const res = await axios.get(
        'https://quickbooks.api.intuit.com/v3/company/' + realm + '/companyinfo/' + realm,
        { headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' } }
      );
      console.log('[REALM ' + realm + '] SUCCESS:', res.data.CompanyInfo?.CompanyName);
    } catch(e) {
      const errData = e.response?.data;
      console.log('[REALM ' + realm + '] status:', e.response?.status);
      console.log('[REALM ' + realm + '] full error:', JSON.stringify(errData));
    }
  }
}
test().catch(e => console.error('[ERROR]', e.message));
