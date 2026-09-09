#!/usr/bin/env node
// Temporary diagnostic script, round 2: tests an actual write.

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

async function main() {
  console.log('--- Write test ---');
  const testRow = {
    id: '__debug_test__',
    master: 'Debug',
    start: new Date().toISOString(),
    end: null,
    client_id: null,
    client_name: 'Debug row',
    client_phone: '',
    services: [],
    status: 'AWAITING',
    online: false,
    new_client: false,
    synced_at: new Date().toISOString(),
  };

  const postRes = await fetch(`${SUPABASE_URL}/rest/v1/bookings?on_conflict=id`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify([testRow]),
  });
  const postText = await postRes.text();
  console.log('POST status:', postRes.status);
  console.log('POST response body:', postText.slice(0, 1000));

  console.log('--- Read-back test (right after write) ---');
  const getRes = await fetch(`${SUPABASE_URL}/rest/v1/bookings?id=eq.__debug_test__&select=*`, {
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
  });
  const getText = await getRes.text();
  console.log('GET status:', getRes.status);
  console.log('GET response body:', getText.slice(0, 1000));

  console.log('--- Full count check ---');
  const countRes = await fetch(`${SUPABASE_URL}/rest/v1/bookings?select=id`, {
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      Prefer: 'count=exact',
    },
  });
  console.log('Count response header content-range:', countRes.headers.get('content-range'));
  console.log('Count status:', countRes.status);
}

main().catch((err) => {
  console.log('ERROR:', err.message || err);
  process.exit(1);
});
