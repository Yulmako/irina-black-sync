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

// ---- Оплата визита ----
// В журнале zapis.kz у записи есть «Итого» и «Оплачено» (оно меняется, когда администратор
// принимает оплату или правит сумму при завершении услуги). Точное имя поля в ответе списка
// записей заранее неизвестно, поэтому ищем по типичным названиям; весь «платёжный» кусок записи
// дополнительно сохраняем в pay_info — по нему можно уточнить поле, не трогая zapis.kz.
const PAID_KEY = /^(paid|payed|paidsum|paidamount|payedsum|payedamount|amountpaid|totalpaid|sumpaid|paysum|paymentsum|paymentamount|paymenttotal|paidtotal|oplacheno)$/i;
const TOTAL_KEY = /^(total|totalprice|totalsum|totalcost|totalamount|price|sum|cost|amount|finalprice|finalsum|itogo)$/i;
const PAY_ARRAY_KEY = /^(payments?|checks?|receipts?|transactions?)$/i;
const PAY_INFO_KEY = /pay|paid|sum|price|cost|amount|total|discount|debt|balance|check|receipt|transaction|itog|oplat/i;

function toNum(v) {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v.replace(/\s/g, '').replace(',', '.')))) {
    return Number(v.replace(/\s/g, '').replace(',', '.'));
  }
  return null;
}

function sumPayments(arr) {
  let sum = 0, any = false;
  for (const p of arr) {
    if (!p || typeof p !== 'object') continue;
    for (const [k, v] of Object.entries(p)) {
      if (/^(amount|sum|value|paid|total)$/i.test(k) && toNum(v) !== null) { sum += toNum(v); any = true; break; }
    }
  }
  return any ? sum : null;
}

function extractPay(r) {
  let paid = null, total = null;
  const scan = (obj, depth) => {
    for (const [k, v] of Object.entries(obj)) {
      if (paid === null && PAID_KEY.test(k) && toNum(v) !== null) paid = toNum(v);
      else if (total === null && TOTAL_KEY.test(k) && toNum(v) !== null) total = toNum(v);
      else if (paid === null && PAY_ARRAY_KEY.test(k) && Array.isArray(v)) paid = sumPayments(v);
      else if (depth < 1 && v && typeof v === 'object' && !Array.isArray(v) && /pay|check|receipt|total|bill/i.test(k)) scan(v, depth + 1);
    }
  };
  scan(r, 0);
  const info = {};
  for (const [k, v] of Object.entries(r)) {
    if (!PAY_INFO_KEY.test(k)) continue;
    if (v === null || ['number', 'string', 'boolean'].includes(typeof v)) info[k] = typeof v === 'string' ? v.slice(0, 80) : v;
    else if (JSON.stringify(v).length <= 1500) info[k] = v;
  }
  return { paid: paid !== null && paid > 0 ? paid : null, total: total !== null && total > 0 ? total : null, pay_info: Object.keys(info).length ? info : null };
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
    ...extractPay(r),
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
  const sample = []; // несколько «сырых» записей для диагностики оплаты (без имён и телефонов)
  let cursor = new Date(rangeStart);
  while (cursor < rangeEnd) {
    const windowEnd = new Date(cursor);
    windowEnd.setDate(windowEnd.getDate() + WINDOW_DAYS);
    const chunkEnd = windowEnd > rangeEnd ? rangeEnd : windowEnd;

    const records = await fetchWindow(fmt(cursor), fmt(chunkEnd));
    for (const r of records) {
      const cleaned = cleanRecord(r, mastersMap);
      if (cleaned) byId.set(cleaned.id, cleaned);
      if (cleaned && sample.length < 3 && /SERVED|COMPLETE|DONE|PAID/i.test(String(r.status || ''))) sample.push(r);
    }
    cursor = chunkEnd;
  }

  return { bookings: Array.from(byId.values()), rangeStart, rangeEnd, sample };
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
    try {
      await post(chunk);
    } catch (err) {
      // Колонок оплаты в базе ещё нет (не выполнен supabase/bookings_paid.sql) — синхронизация не должна ломаться.
      if (!/paid|total|pay_info|PGRST204/i.test(String(err.message))) throw err;
      if (!upsertBookings.warned) {
        console.warn('ВНИМАНИЕ: в таблице bookings нет колонок оплаты — выполните supabase/bookings_paid.sql. Записи сохраняются без оплаты.');
        upsertBookings.warned = true;
      }
      await post(chunk.map(({ paid, total, pay_info, ...rest }) => rest));
    }
  }
}

function post(chunk) {
  return supabase('/rest/v1/bookings?on_conflict=id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(chunk),
  });
}

async function updateSyncStatus({ rangeStart, rangeEnd, count }) {
  await supabase('/rest/v1/sync_status?id=eq.1', {
    method: 'PATCH',
    body: JSON.stringify({
      last_synced_at: new Date().toISOString(),
      range_from: fmt(rangeStart),
      range_to: fmt(rangeEnd),
      count,
    }),
  });
}

async function main() {
  const { bookings, rangeStart, rangeEnd, sample } = await fetchAllBookings();
  await upsertBookings(bookings);
  const withPaid = bookings.filter((b) => b.paid);
  console.log(`Оплата найдена у ${withPaid.length} из ${bookings.length} записей.`);
  if (!withPaid.length && bookings.length) {
    console.warn('Поле оплаты в ответе zapis.kz не найдено. Пример записей (имена и телефоны скрыты):');
    const redact = (k, v) => (/name|phone|surname|email|comment|note|title/i.test(k) ? '***' : typeof v === 'string' ? v.slice(0, 60) : v);
    for (const r of sample) console.warn(JSON.stringify(r, redact));
    if (!sample.length) console.warn('Нет ни одной записи со статусом «обслужен» — смотрите статусы:', [...new Set(bookings.map((b) => b.status))].join(', '));
  }
  await updateSyncStatus({ rangeStart, rangeEnd, count: bookings.length });
  console.log(`Synced ${bookings.length} bookings (${fmt(rangeStart)} — ${fmt(rangeEnd)}) into Supabase.`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
