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

// ---- Оплата визитов ----
// Список записей (reservation/list) сумм не содержит. Сумму «Оплачено» zapis.kz отдаёт отдельным запросом
//   /rest/partner-app/v2/reservations/{запись}/reservation-clients/{клиент записи}/payment-info
// (то же, что журнал показывает на вкладке «Оплата и чеки»). Спрашиваем её только у обслуженных записей
// за последние PAY_DAYS_BACK дней: свежие (PAY_REFRESH_DAYS) — каждый раз, потому что сумма может
// поменяться при завершении услуги; более старые — пока оплата не получена.
const APP_BASE = `${ZAPIS_BASE}/rest/partner-app/v2`;
const PAY_DAYS_BACK = 14;
const PAY_REFRESH_DAYS = 2;
const PAY_CONCURRENCY = 4;

async function zapisRaw(url) {
  const res = await fetch(url, { headers: ZAPIS_HEADERS });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* не JSON */ }
  return { status: res.status, json, text };
}

// Номер «клиента записи» ищем в ответе по записи: любое поле, в названии которого сочетаются
// «reservation» и «client» (число или объект/массив с id), либо массив клиентов с полем id.
function findReservationClientId(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 5) return null;
  const items = Array.isArray(node) ? node.map((v, i) => [String(i), v]) : Object.entries(node);
  for (const [k, v] of items) {
    if (/reservation.*client|client.*reservation/i.test(k)) {
      if ((typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))) && v) return String(v);
      if (Array.isArray(v) && v[0] && typeof v[0] === 'object' && v[0].id) return String(v[0].id);
      if (v && typeof v === 'object' && !Array.isArray(v) && v.id) return String(v.id);
    }
    if (/^clients$/i.test(k) && Array.isArray(v) && v[0] && typeof v[0] === 'object' && v[0].id) return String(v[0].id);
  }
  for (const [, v] of items) {
    const found = findReservationClientId(v, depth + 1);
    if (found) return found;
  }
  return null;
}

// Для лога: ответ без имён, телефонов и комментариев.
function redactedBody(json, text, limit = 3000) {
  if (!json) return text.slice(0, 400);
  return JSON.stringify(json, (k, v) => (/name|phone|surname|email|comment/i.test(k) ? (v == null ? v : '***') : v)).slice(0, limit);
}

async function fetchPayment(id, diag) {
  let clientId = null, total = null;
  const detailUrl = `${APP_BASE}/reservations/${id}`;
  const d = await zapisRaw(detailUrl);
  if (d.json) {
    if (Number(d.json.totalPrice) > 0) total = Number(d.json.totalPrice);
    clientId = findReservationClientId(d.json);
  }
  if (!clientId && diag.fails.length < 2) diag.fails.push(`${detailUrl} → HTTP ${d.status}, номер клиента записи не найден. Ответ: ${redactedBody(d.json, d.text)}`);
  // запасные варианты адреса, если номер клиента записи в ответе не найден
  const candidates = clientId ? [clientId] : [id, null];
  for (const c of candidates) {
    const url = c === null ? `${APP_BASE}/reservations/${id}/payment-info` : `${APP_BASE}/reservations/${id}/reservation-clients/${c}/payment-info`;
    const r = await zapisRaw(url);
    if (Array.isArray(r.json)) return { rows: r.json, total };
    if (!clientId && diag.fails.length < 4) diag.fails.push(`${url} → HTTP ${r.status}: ${r.text.slice(0, 200)}`);
    if (clientId) break;
  }
  return { rows: null, total };
}

// Дописывает bookings[i].paid / .total (только у тех, у кого получилось); возвращает сколько записей получили оплату.
async function enrichPayments(bookings, existingPaid) {
  const now = Date.now();
  const from = now - PAY_DAYS_BACK * 86400000;
  const fresh = now - PAY_REFRESH_DAYS * 86400000;
  const byId = new Map(bookings.map((b) => [b.id, b]));
  const targets = bookings.filter((b) => {
    const t = new Date(b.start).getTime();
    return b.status === 'SERVED' && t >= from && t <= now && (t >= fresh || !existingPaid.get(b.id));
  });
  const done = new Set();      // получена оплата (paid + total)
  const totalOnly = new Set(); // получено только «Итого» (оплату получить не удалось)
  const diag = { fails: [], errors: 0 };
  let idx = 0, failedInRow = 0, aborted = false;
  async function worker() {
    while (idx < targets.length && !aborted) {
      const b = targets[idx++];
      if (done.has(b.id)) continue;
      try {
        const { rows, total } = await fetchPayment(b.id, diag);
        if (!rows) {
          if (total) { b.total = total; totalOnly.add(b.id); }
          if (++failedInRow >= 6 && !done.size) aborted = true;
          continue;
        }
        failedInRow = 0;
        for (const row of rows) {
          const target = byId.get(String(row.reservationId));
          if (!target) continue;
          target.paid = Number(row.paidAmount) > 0 ? Number(row.paidAmount) : null;
          target.total = Number(row.totalAmount) > 0 ? Number(row.totalAmount) : null;
          done.add(target.id);
          totalOnly.delete(target.id);
        }
      } catch (e) {
        diag.errors++;
        if (diag.fails.length < 3) diag.fails.push(`${b.id}: ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: PAY_CONCURRENCY }, worker));
  const got = bookings.filter((b) => done.has(b.id) && b.paid).length;
  console.log(`Оплата: запрошено ${targets.length}, получено по ${done.size}, из них с суммой ${got}; только «Итого»: ${totalOnly.size}.`);
  if (diag.fails.length) {
    console.warn(aborted ? 'Запросы оплаты остановлены: первые записи не удалось получить. Примеры ответов zapis.kz:' : 'Примеры неудачных запросов оплаты:');
    diag.fails.forEach((f) => console.warn('  ' + f));
  }
  return { done, totalOnly };
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

async function loadExistingPaid() {
  const since = new Date(Date.now() - (PAY_DAYS_BACK + 1) * 86400000).toISOString();
  try {
    const res = await supabase(`/rest/v1/bookings?select=id,paid&start=gte.${encodeURIComponent(since)}&limit=5000`);
    return new Map((await res.json()).map((r) => [String(r.id), r.paid]));
  } catch (e) {
    console.warn('Колонок оплаты в таблице bookings ещё нет — выполните supabase/bookings_paid.sql.');
    return null;
  }
}

async function upsertBookings(bookings) {
  // Batch to keep individual requests small and reliable.
  const BATCH = 200;
  for (let i = 0; i < bookings.length; i += BATCH) {
    const chunk = bookings.slice(i, i + BATCH);
    await supabase('/rest/v1/bookings?on_conflict=id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify(chunk),
    });
  }
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
  const { bookings, rangeStart, rangeEnd } = await fetchAllBookings();
  // Оплату подмешиваем только если в базе есть колонки; записи без новой оплаты сохраняются без полей paid/total,
  // чтобы не затереть уже сохранённую сумму.
  const existingPaid = await loadExistingPaid();
  const { done, totalOnly } = existingPaid ? await enrichPayments(bookings, existingPaid) : { done: new Set(), totalOnly: new Set() };
  const withPay = bookings.filter((b) => done.has(b.id));
  const withTotal = bookings.filter((b) => totalOnly.has(b.id)).map(({ paid, ...rest }) => rest);
  const plain = bookings.filter((b) => !done.has(b.id) && !totalOnly.has(b.id)).map(({ paid, total, ...rest }) => rest);
  await upsertBookings(withPay);
  await upsertBookings(withTotal);
  await upsertBookings(plain);
  await updateSyncStatus({ rangeStart, rangeEnd, count: bookings.length });
  console.log(`Synced ${bookings.length} bookings (${fmt(rangeStart)} — ${fmt(rangeEnd)}) into Supabase.`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
