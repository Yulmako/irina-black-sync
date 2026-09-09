#!/usr/bin/env node
// Temporary diagnostic script. Prints exactly where the Supabase request
// goes and what comes back, without ever printing the secret values
// themselves. Replace scripts/sync.js content with this file's content
// TEMPORARILY, run the workflow once, paste the log back, then restore
// the real sync.js afterwards.

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

function safe(v) {
  // Never print the raw secret. Only shape/length info.
  return {
    length: v.length,
    startsWithHttps: v.startsWith('https://'),
    startsWithHttp: v.startsWith('http://'),
    hasWhitespace: /\s/.test(v),
    hasDashboardWord: v.includes('dashboard'),
    hasSupabaseCo: v.includes('.supabase.co'),
    first10: v.slice(0, 10),
    last10: v.slice(-10),
  };
}

console.log('--- SUPABASE_URL diagnostics ---');
console.log(JSON.stringify(safe(SUPABASE_URL), null, 2));

let hostname = null;
let pathname = null;
let parseError = null;
try {
  const u = new URL(SUPABASE_URL);
  hostname = u.hostname;
  pathname = u.pathname;
} catch (e) {
  parseError = e.message;
}
console.log('Parsed hostname:', hostname);
console.log('Parsed pathname (should be empty "/"):', pathname);
console.log('Parse error (should be null):', parseError);

console.log('--- SUPABASE_SERVICE_KEY diagnostics ---');
console.log(JSON.stringify(safe(SUPABASE_SERVICE_KEY), null, 2));
// A valid Supabase service_role key is a JWT: three base64 segments
// separated by dots. Decode just the middle segment (the payload) to
// confirm which project ref and role it actually carries.
try {
  const parts = SUPABASE_SERVICE_KEY.split('.');
  console.log('JWT segment count (should be 3):', parts.length);
  if (parts.length === 3) {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    console.log('JWT payload ref (project):', payload.ref);
    console.log('JWT payload role (should be service_role):', payload.role);
  }
} catch (e) {
  console.log('Could not decode JWT payload:', e.message);
}

console.log('--- Live test request ---');
const testUrl = `${SUPABASE_URL}/rest/v1/bookings?select=id&limit=1`;
console.log('Requesting (path only, host already shown above):', new URL(testUrl).pathname + new URL(testUrl).search);

fetch(testUrl, {
  headers: {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  },
})
  .then(async (res) => {
    const text = await res.text();
    console.log('HTTP status:', res.status);
    console.log('Response body (first 500 chars):', text.slice(0, 500));
  })
  .catch((err) => {
    console.log('Fetch threw an error:', err.message);
  });
