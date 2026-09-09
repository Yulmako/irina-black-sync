#!/usr/bin/env node
/**
 * Pulls bookings from the zapis.kz partner cabinet and upserts them
 * straight into Supabase. Runs hourly via GitHub Actions — see
 * .github/workflows/sync.yml. Nothing here depends on Claude at runtime;
 * this script and the schedule that runs it belong entirely to this repo.
 *
 * Required secrets (set as GitHub Actions repository secrets):
 *   ZAPIS_COOKIE          — raw Cookie header from an authenticated
 *                           zapis.kz browser session (see README).
 *   SUPABASE_URL          — e.g. https://xxxxx.supabase.co
 *   SUPABASE_SERVICE_KEY  — the Supabase project's service_role key
 *                           (Project Settings → API). Full write access —
 *                           never put this in the frontend, only here.
 *
 * When the zapis.kz session expires, requests come back 401/403 and this
 * script exits with a non-zero code — which fails the GitHub Actions run
 * and (by default) emails the repo owner. That email is the signal to
 * repeat the cookie-copy step in the README.
 */

process.env.TZ = 'Asia/Almaty'; // zapis.kz timestamps have no timezone marker

const COOKIE = process.env.ZAPIS_COOKIE;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

for (const [name, val] of Object.entries({
  ZAPIS_COOKIE: COOKIE,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
})) {
  if (!val) {
    console.error(`Missing ${name} environment variable/secret.`);
    process.exit(1);
  }
}

const ZAPIS_BASE = 'https://zapis.kz';
const ZAPIS_HEADERS = {
  Cookie: COOKIE,
  Accept: 'application/json',
  'User-Agent': 'Mozilla/5.0 (compatible; SalonSync/1.0)',
};

const DAYS_BACK = 14;
const DAYS_FORWARD = 120;
const WINDOW_DAYS = 7; // zapis.kz silently truncates wider date ranges

function fmt(d) {
  return d.toISOString().slice(0, 10);
}

async function zapisJson(url) {
  const res = await fetch(url, { headers: ZAPIS_HEADERS });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`AUTH_EXPIRED (${res.status}) — the zapis.kz session cookie needs to be refreshed.`);
  }
  if (!res.ok) throw new Error(`zapis.kz request failed ${res.status} for ${url}`);
  const body = await res.json();
  if (body && body.status && body.status !== 'OK') {
    throw new Error(`AUTH_EXPIRED — unexpected API status "${body.status}" for ${url}`);
  }
  return body.response;
}

async function fetchMasters() {
  const list = await zapisJson(`${ZAPIS_BASE}/rest/v2/partner-web/reservation/masters-list`);
  const map = {};
  for (const m of list) {
    map[m.id] = [m.name, m.surname].filter(Boolean).join(' ').trim() || String(m.id);
  }
  return map;
}

async function fetchWindow(startDate, endDate) {
  const url = `${ZAPIS_BASE}/rest/v2/partner-web/reservation/list?master=&startDate=${startDate}&endDate=${endDate}`;
  return zapisJson(url);
}

function cleanRecord(r, mastersMap) {
  if (!r || r.type !== 'reservation' || !r.start) return null; // skip "rest-time" blocks
  return {
    id: String(r.id),
    master: mastersMap[r.resourceId] || 'Без имени',
    start: new Date(r.start).toISOString(),
    end: r.end ? new Date(r.end).toISOString() : null,
    client_id: r.client != null ? String(r.client) : null,
    client_name: r.titleName || '',
    client_phone: r.titlePhone || '',
    services: Array.isArray(r.services) ? r.services.filter(Boolean) : [],
    status: r.status || 'AWAITING',
    online: !!r.isOnline,
    new_client: !!r.isNew,
    synced_at: new Date().toISOString(),
  };
}

async function fetchAllBookings() {
  const mastersMap = await fetchMasters();

  const today = new Date();
  const rangeStart = new Date(today);
  rangeStart.setDate(rangeStart.getDate() - DAYS_BACK);
  const rangeEnd = new Date(today);
  rangeEnd.setDate(rangeEnd.getDate() + DAYS_FORWARD);

  const byId = new Map();
  let cursor = new Date(rangeStart);
  while (cursor < rangeEnd) {
    const windowEnd = new Date(cursor);
    windowEnd.setDate(windowEnd.getDate() + WINDOW_DAYS);
    const chunkEnd = windowEnd > rangeEnd ? rangeEnd : windowEnd;

    const records = await fetchWindow(fmt(cursor), fmt(chunkEnd));
    for (const r of records) {
      const cleaned = cleanRecord(r, mastersMap);
      if (cleaned) byId.set(cleaned.id, cleaned);
    }
    cursor = chunkEnd;
  }

  return { bookings: Array.from(byId.values()), rangeStart, rangeEnd };
}

async function supabase(path, init) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(init && init.headers),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase request failed ${res.status} for ${path}: ${text}`);
  }
  return res;
}

async function upsertBookings(bookings) {
  // Batch to keep individual requests small and reliable.
  const BATCH = 200;
  for (let i = 0; i < bookings.length; i += BATCH) {
    const chunk = bookings.slice(i, i + BATCH);
    const res = await supabase('/rest/v1/bookings?on_conflict=id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(chunk),
    });
    const text = await res.text();
    let written;
    try {
      written = JSON.parse(text).length;
    } catch {
      written = 'unknown (could not parse response)';
    }
    console.log(`  batch ${i}-${i + chunk.length}: sent ${chunk.length}, HTTP ${res.status}, rows returned: ${written}`);
  }
}

async function updateSyncStatus({ rangeStart, rangeEnd, count }) {
  const res = await supabase('/rest/v1/sync_status?id=eq.1', {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      last_synced_at: new Date().toISOString(),
      range_from: fmt(rangeStart),
      range_to: fmt(rangeEnd),
      count,
    }),
  });
  const text = await res.text();
  console.log(`  sync_status update: HTTP ${res.status}, response: ${text.slice(0, 300)}`);
}

async function main() {
  const { bookings, rangeStart, rangeEnd } = await fetchAllBookings();
  console.log(`Fetched ${bookings.length} bookings from zapis.kz. Writing to Supabase...`);
  await upsertBookings(bookings);
  await updateSyncStatus({ rangeStart, rangeEnd, count: bookings.length });

  const verifyRes = await supabase('/rest/v1/bookings?select=id', {
    headers: { Prefer: 'count=exact', Range: '0-0' },
  });
  console.log('Verification — total rows now in table (content-range header):', verifyRes.headers.get('content-range'));

  console.log(`Synced ${bookings.length} bookings (${fmt(rangeStart)} — ${fmt(rangeEnd)}) into Supabase.`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
