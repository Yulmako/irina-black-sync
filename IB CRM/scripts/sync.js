#!/usr/bin/env node
/**
 * Syncs bookings from the zapis.kz partner cabinet into data/bookings.json.
 *
 * Requires the ZAPIS_COOKIE environment variable — the raw "Cookie" header
 * value copied from an authenticated browser session at zapis.kz (see the
 * setup instructions for how to grab it from DevTools). This script never
 * logs in on its own; it just replays that existing session to call the
 * same internal API the zapis.kz web app itself uses.
 *
 * When the cookie expires, requests come back 401/403 and this script
 * exits with a non-zero code — which makes the GitHub Actions run fail
 * and (by default) emails the repo owner. That failure email is your
 * signal to repeat the cookie-copy step.
 */

// Interpret the "Sep 8, 2026 9:00:00 AM"-style timestamps zapis.kz returns
// as Almaty local time, regardless of what timezone the runner is in.
process.env.TZ = 'Asia/Almaty';

const fs = require('fs');
const path = require('path');

const COOKIE = process.env.ZAPIS_COOKIE;
if (!COOKIE) {
  console.error('Missing ZAPIS_COOKIE environment variable/secret.');
  process.exit(1);
}

const BASE = 'https://zapis.kz';
const HEADERS = {
  Cookie: COOKIE,
  Accept: 'application/json',
  'User-Agent': 'Mozilla/5.0 (compatible; IrinaBlackSync/1.0)',
};

// How much history / how far ahead to pull each run.
const DAYS_BACK = 14;
const DAYS_FORWARD = 120;
// zapis.kz silently truncates results for date ranges wider than ~1 month,
// so we always page through in narrow windows and de-duplicate by id.
const WINDOW_DAYS = 7;

function fmt(d) {
  return d.toISOString().slice(0, 10);
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`AUTH_EXPIRED (${res.status}) — the session cookie needs to be refreshed.`);
  }
  if (!res.ok) {
    throw new Error(`Request failed ${res.status} for ${url}`);
  }
  const body = await res.json();
  if (body && body.status && body.status !== 'OK') {
    throw new Error(`AUTH_EXPIRED — unexpected API status "${body.status}" for ${url}`);
  }
  return body.response;
}

async function fetchMasters() {
  const list = await fetchJson(`${BASE}/rest/v2/partner-web/reservation/masters-list`);
  const map = {};
  for (const m of list) {
    map[m.id] = [m.name, m.surname].filter(Boolean).join(' ').trim() || String(m.id);
  }
  return map;
}

async function fetchWindow(startDate, endDate) {
  const url = `${BASE}/rest/v2/partner-web/reservation/list?master=&startDate=${startDate}&endDate=${endDate}`;
  return fetchJson(url);
}

function cleanRecord(r, mastersMap) {
  if (!r || r.type !== 'reservation') return null; // skips "rest-time" background blocks
  if (!r.start) return null;
  return {
    id: String(r.id),
    master: mastersMap[r.resourceId] || 'Без имени',
    start: new Date(r.start).toISOString(),
    end: r.end ? new Date(r.end).toISOString() : null,
    clientId: r.client != null ? String(r.client) : null,
    clientName: r.titleName || '',
    clientPhone: r.titlePhone || '',
    services: Array.isArray(r.services) ? r.services.filter(Boolean) : [],
    status: r.status || 'AWAITING',
    online: !!r.isOnline,
    newClient: !!r.isNew,
  };
}

async function main() {
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

  const bookings = Array.from(byId.values()).sort(
    (a, b) => new Date(a.start) - new Date(b.start)
  );

  const outDir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, 'bookings.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        rangeFrom: fmt(rangeStart),
        rangeTo: fmt(rangeEnd),
        count: bookings.length,
        bookings,
      },
      null,
      2
    )
  );

  console.log(`Synced ${bookings.length} bookings (${fmt(rangeStart)} — ${fmt(rangeEnd)}).`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
