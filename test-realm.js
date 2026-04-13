require('dotenv').config();
const axios = require('axios');

async function test() {
  const creds = Buffer.from(process.env.QB_CLIENT_ID + ':' + process.env.QB_CLIENT_SECRET).toString('base64');
  const r = await axios.post('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
    'grant_type=refresh_token&refresh_token=' + process.env.QB_REFRESH_TOKEN,
    { headers: { 'Authorization': 'Basic ' + creds, 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  const token = r.data.access_token;
  console.log('[TEST] Token refreshed. Now trying all known realm IDs...');

  // All realm IDs we've seen across this project
  const realms = [
    '9341456862365430',  // from QB homepage URL
    '9341456862346650',  // from developer dashboard
    '9341456862333687',  // from developer dashboard alternate
    '193514489',         // common format short ID
  ];

  for (const realm of realms) {
    try {
      const res = await axios.get(
        'https://quickbooks.api.intuit.com/v3/company/' + realm + '/companyinfo/' + realm,
        { headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' } }
      );
      console.log('[REALM ' + realm + '] ✅ SUCCESS:', res.data.CompanyInfo?.CompanyName);
    } catch(e) {
      const code = e.response?.data?.Fault?.Error?.[0]?.code;
      console.log('[REALM ' + realm + '] ❌', e.response?.status, 'code:', code);
    }
  }

  // Also try to get the realm from the token introspection
  try {
    const intro = await axios.post('https://oauth.platform.intuit.com/oauth2/v1/tokens/userinfo',
      null,
      { headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' } }
    );
    console.log('[USERINFO]', JSON.stringify(intro.data));
  } catch(e) {
    console.log('[USERINFO failed]', e.response?.status, JSON.stringify(e.response?.data));
  }
}
test().catch(e => console.error('[ERROR]', e.message));
