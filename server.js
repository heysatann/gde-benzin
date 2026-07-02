import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import webpush from 'web-push';
import db from './db.js';
import { refreshAllCities } from './import-osm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ---------- Web Push (VAPID) ----------
// Ключи VAPID генерируются один раз и сохраняются в vapid.json (не в git).
// Можно переопределить через переменные окружения VAPID_PUBLIC/VAPID_PRIVATE.
const VAPID_FILE = path.join(__dirname, 'vapid.json');
let vapid;
if (process.env.VAPID_PUBLIC && process.env.VAPID_PRIVATE) {
  vapid = { publicKey: process.env.VAPID_PUBLIC, privateKey: process.env.VAPID_PRIVATE };
} else if (fs.existsSync(VAPID_FILE)) {
  vapid = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
} else {
  vapid = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_FILE, JSON.stringify(vapid, null, 2));
  console.log('Сгенерированы VAPID-ключи → vapid.json');
}
webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || 'mailto:admin@gdezapravka.local',
  vapid.publicKey,
  vapid.privateKey
);

// Отправка push подписчикам, чья «зона интереса» покрывает точку (lat,lng).
async function notifyNearby(lat, lng, payload) {
  const subs = db.prepare('SELECT * FROM push_subs').all();
  const dead = [];
  await Promise.all(
    subs.map(async (sub) => {
      // Фильтр по радиусу зоны (если координаты подписки заданы)
      if (sub.lat != null && sub.lng != null) {
        const d = distanceKm(lat, lng, sub.lat, sub.lng);
        if (d > (sub.radius_km || 10)) return;
      }
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(payload)
        );
      } catch (err) {
        // 404/410 — подписка недействительна, удаляем
        if (err.statusCode === 404 || err.statusCode === 410) dead.push(sub.endpoint);
      }
    })
  );
  if (dead.length) {
    const del = db.prepare('DELETE FROM push_subs WHERE endpoint = ?');
    dead.forEach((e) => del.run(e));
  }
}

// Простейший разбор/выдача анонимного client_id через cookie (антиспам, репутация)
app.use((req, res, next) => {
  const cookies = Object.fromEntries(
    (req.headers.cookie || '')
      .split(';')
      .map((c) => c.trim().split('='))
      .filter((p) => p[0])
  );
  let cid = cookies.cid;
  if (!cid || !/^[a-f0-9]{32}$/.test(cid)) {
    cid = crypto.randomBytes(16).toString('hex');
    res.setHeader('Set-Cookie', `cid=${cid}; Path=/; Max-Age=31536000; SameSite=Lax`);
  }
  req.clientId = cid;
  req.clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
    .split(',')[0]
    .trim();
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Список допустимых значений
const STATUSES = ['yes', 'limit', 'no'];
const FUELS = ['АИ-92', 'АИ-95', 'АИ-98', 'АИ-100', 'ДТ', 'Газ'];
const QUEUES = [
  'Нет очереди',
  '1–3 машины',
  '4–8 машин',
  '8–20 машин',
  '≈20–50 машин',
  '≈50+ машин',
];

// ---------- Вспомогательное ----------
function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Актуальные цены (последняя цена по каждой марке)
const pricesStmt = db.prepare(`
  SELECT p.fuel, p.price, p.created_at
  FROM prices p
  JOIN (SELECT fuel, MAX(id) AS mid FROM prices WHERE station_id = ? GROUP BY fuel) m
    ON p.id = m.mid
  ORDER BY p.fuel
`);

// Все отметки станции за окно доверия (последние 12 часов)
const recentReportsStmt = db.prepare(`
  SELECT status, fuels, limit_liters, queue, client_id, weight, created_at,
         (julianday('now') - julianday(created_at)) * 24 AS age_h
  FROM reports
  WHERE station_id = ? AND (julianday('now') - julianday(created_at)) * 24 <= 12
  ORDER BY id DESC
`);

// Период полураспада доверия: свежие отметки весят больше
const HALF_LIFE_H = 3;
function timeDecay(ageHours) {
  return Math.pow(0.5, Math.max(0, ageHours) / HALF_LIFE_H);
}

// ---------- Рейтинг доверия (антифрод-консенсус) ----------
// Считаем взвешенное голосование по статусу. Вес отметки = репутация автора × свежесть.
// Один автор голосует один раз (берётся его самая свежая отметка).
function computeConsensus(stationId) {
  const rows = recentReportsStmt.all(stationId);
  if (!rows.length) {
    return {
      status: null,
      confidence: 0,
      confirmations: 0,
      fuels: [],
      limit: null,
      queue: null,
      updatedAt: null,
      reportsCount: 0,
    };
  }

  // Один голос на автора (первый = самый свежий, т.к. ORDER BY id DESC)
  const seen = new Set();
  const votes = [];
  for (const r of rows) {
    const key = r.client_id || 'anon-' + r.created_at;
    if (seen.has(key)) continue;
    seen.add(key);
    votes.push(r);
  }

  const weights = { yes: 0, limit: 0, no: 0 };
  let totalW = 0;
  for (const v of votes) {
    const w = (v.weight || 1) * timeDecay(v.age_h);
    weights[v.status] = (weights[v.status] || 0) + w;
    totalW += w;
  }

  // Победивший статус
  let status = 'yes';
  for (const st of STATUSES) if (weights[st] > weights[status]) status = st;

  const share = totalW > 0 ? weights[status] / totalW : 0;
  // Насыщение по числу независимых голосов: 1 голос ≈ 0.55, растёт к 1
  const volume = 1 - Math.exp(-votes.length / 2.5);
  const confidence = Math.round(share * volume * 100);

  // Данные берём из самой свежей отметки победившего статуса
  const winner = votes.find((v) => v.status === status) || votes[0];
  const confirmations = votes.filter((v) => v.status === status).length;

  return {
    status,
    confidence,
    confirmations,
    fuels: winner.fuels ? JSON.parse(winner.fuels) : [],
    limit: winner.limit_liters,
    queue: winner.queue,
    updatedAt: winner.created_at,
    reportsCount: votes.length,
  };
}

function enrichStation(s) {
  const c = computeConsensus(s.id);
  return { ...s, ...c };
}

// ---------- Антиспам ----------
// Ограничения на частоту отметок.
const RATE = {
  perStationCooldownSec: 120, // не чаще 1 отметки на конкретную АЗС от одного client_id
  perClientWindowSec: 60, // окно скользящего лимита
  perClientMaxInWindow: 8, // максимум отметок за окно с одного client_id
  perIpWindowSec: 60,
  perIpMaxInWindow: 20, // грубый лимит по IP (несколько человек за NAT)
};

const lastOnStationStmt = db.prepare(
  "SELECT (julianday('now') - julianday(created_at)) * 86400 AS sec FROM reports WHERE station_id = ? AND client_id = ? ORDER BY id DESC LIMIT 1"
);
const countByClientStmt = db.prepare(
  "SELECT COUNT(*) AS c FROM reports WHERE client_id = ? AND (julianday('now') - julianday(created_at)) * 86400 <= ?"
);
// Грубый лимит по IP держим в памяти (IP не хранится в БД).
const ipHits = new Map();
function checkIpLimit(ip) {
  const now = Date.now();
  const arr = (ipHits.get(ip) || []).filter((t) => now - t < RATE.perIpWindowSec * 1000);
  arr.push(now);
  ipHits.set(ip, arr);
  return arr.length <= RATE.perIpMaxInWindow;
}

function antiSpamCheck(stationId, clientId, ip) {
  if (!checkIpLimit(ip)) {
    return { ok: false, error: 'Слишком много отметок с вашей сети. Повторите позже.' };
  }
  const last = lastOnStationStmt.get(stationId, clientId);
  if (last && last.sec < RATE.perStationCooldownSec) {
    const wait = Math.ceil(RATE.perStationCooldownSec - last.sec);
    return { ok: false, error: `Вы уже отмечали эту АЗС. Повторно можно через ${wait} с.` };
  }
  const cnt = countByClientStmt.get(clientId, RATE.perClientWindowSec).c;
  if (cnt >= RATE.perClientMaxInWindow) {
    return { ok: false, error: 'Слишком частые отметки. Немного подождите.' };
  }
  return { ok: true };
}

// ---------- Репутация автора ----------
// Репутация = насколько отметки автора совпадали с итоговым консенсусом.
// Возвращаем вес в диапазоне ~[0.3 .. 2.0]. Новичок = 1.0.
const authorHistoryStmt = db.prepare(`
  SELECT r.station_id, r.status, r.created_at
  FROM reports r
  WHERE r.client_id = ?
  ORDER BY r.id DESC LIMIT 50
`);
function computeReputation(clientId) {
  const rows = authorHistoryStmt.all(clientId);
  if (rows.length < 2) return 1.0;
  let agree = 0;
  let total = 0;
  for (const r of rows) {
    const cons = computeConsensus(r.station_id);
    if (!cons.status) continue;
    total++;
    if (cons.status === r.status) agree++;
  }
  if (total === 0) return 1.0;
  const ratio = agree / total; // 0..1
  // Плавно из 0.3 (постоянно расходится с консенсусом) в 2.0 (всегда совпадает)
  return +(0.3 + ratio * 1.7).toFixed(3);
}

// ---------- API ----------

// Список городов (только реальные города РФ; служебные метки скрываем).
app.get('/api/cities', (req, res) => {
  const rows = db
    .prepare(
      `SELECT city, AVG(lat) AS lat, AVG(lng) AS lng, COUNT(*) AS count
       FROM stations
       WHERE city IS NOT NULL AND city <> '' AND city <> 'Прочие'
       GROUP BY city
       HAVING count >= 3
       ORDER BY count DESC, city`
    )
    .all();
  res.json(rows);
});

// Список станций. Поддерживает три режима (идея из gdezapravka.ru):
//   ?bbox=west,south,east,north  — станции внутри видимой области карты (для панорамирования)
//   ?city=Москва                 — станции города
//   (без параметров)             — все (ограничено limit)
// near_lat/near_lng — сортировка по близости; limit — потолок выдачи (по умолч. 2000).
app.get('/api/stations', (req, res) => {
  const { city, bbox, near_lat, near_lng } = req.query;
  const limit = Math.min(parseInt(req.query.limit, 10) || 2000, 5000);

  let rows;
  if (bbox) {
    // bbox = west,south,east,north (lng_min, lat_min, lng_max, lat_max)
    const parts = String(bbox).split(',').map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite)) {
      const [w, s, e, n] = parts;
      rows = db
        .prepare('SELECT * FROM stations WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ? LIMIT ?')
        .all(Math.min(s, n), Math.max(s, n), Math.min(w, e), Math.max(w, e), limit);
    } else {
      return res.status(400).json({ error: 'Некорректный bbox' });
    }
  } else if (city) {
    rows = db.prepare('SELECT * FROM stations WHERE city = ? LIMIT ?').all(city, limit);
  } else {
    rows = db.prepare('SELECT * FROM stations LIMIT ?').all(limit);
  }
  let result = rows.map(enrichStation);

  // Сортировка по расстоянию, если переданы координаты
  if (near_lat && near_lng) {
    const la = parseFloat(near_lat);
    const ln = parseFloat(near_lng);
    result = result
      .map((s) => ({ ...s, distance: distanceKm(la, ln, s.lat, s.lng) }))
      .sort((a, b) => a.distance - b.distance);
  }
  res.json(result);
});

// Детали станции
app.get('/api/stations/:id', (req, res) => {
  const s = db.prepare('SELECT * FROM stations WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Станция не найдена' });
  const enriched = enrichStation(s);
  const prices = pricesStmt.all(s.id);
  const history = db
    .prepare(
      'SELECT status, fuels, limit_liters, queue, created_at FROM reports WHERE station_id = ? ORDER BY id DESC LIMIT 10'
    )
    .all(s.id)
    .map((r) => ({ ...r, fuels: r.fuels ? JSON.parse(r.fuels) : [] }));
  res.json({ ...enriched, prices, history });
});

// Отметить наличие
app.post('/api/stations/:id/report', (req, res) => {
  const s = db
    .prepare('SELECT id, brand, city, lat, lng FROM stations WHERE id = ?')
    .get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Станция не найдена' });

  const { status, fuels = [], limit_liters = null, queue = null } = req.body;
  if (!STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Некорректный статус' });
  }
  // Антиспам: частота отметок
  const guard = antiSpamCheck(s.id, req.clientId, req.clientIp);
  if (!guard.ok) return res.status(429).json({ error: guard.error });

  const cleanFuels = Array.isArray(fuels) ? fuels.filter((f) => FUELS.includes(f)) : [];
  const cleanQueue = queue && QUEUES.includes(queue) ? queue : null;
  const cleanLimit =
    limit_liters != null && limit_liters !== '' ? parseInt(limit_liters, 10) || null : null;

  // Статус ДО новой отметки — чтобы уведомлять только при реальном изменении
  const prevStatus = computeConsensus(s.id).status;

  // Вес отметки = текущая репутация автора
  const weight = computeReputation(req.clientId);

  db.prepare(
    'INSERT INTO reports (station_id, status, fuels, limit_liters, queue, client_id, weight) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(s.id, status, JSON.stringify(cleanFuels), cleanLimit, cleanQueue, req.clientId, weight);

  const full = db.prepare('SELECT * FROM stations WHERE id = ?').get(s.id);
  const enriched = enrichStation(full);

  // Push подписчикам поблизости, если консенсус-статус изменился
  if (enriched.status !== prevStatus) {
    const label = { yes: 'есть топливо', limit: 'лимит на отпуск', no: 'нет топлива' }[
      enriched.status
    ];
    notifyNearby(s.lat, s.lng, {
      title: `${s.brand} — ${label}`,
      body: `${s.city}${full.address ? ', ' + full.address : ''}`,
      url: '/',
      tag: 'st-' + s.id,
    }).catch(() => {});
  }

  res.json({ ...enriched, yourWeight: weight });
});

// Добавить цену
app.post('/api/stations/:id/price', (req, res) => {
  const s = db.prepare('SELECT id FROM stations WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Станция не найдена' });

  const { fuel, price } = req.body;
  if (!FUELS.includes(fuel)) return res.status(400).json({ error: 'Некорректная марка топлива' });
  const p = parseFloat(price);
  if (!p || p <= 0 || p > 1000) return res.status(400).json({ error: 'Некорректная цена' });

  db.prepare('INSERT INTO prices (station_id, fuel, price) VALUES (?, ?, ?)').run(s.id, fuel, p);
  res.json(pricesStmt.all(s.id));
});

// Справочники
app.get('/api/meta', (req, res) => {
  res.json({ statuses: STATUSES, fuels: FUELS, queues: QUEUES });
});

// ---------- Push-подписки ----------
// Публичный VAPID-ключ (нужен клиенту для подписки)
app.get('/api/push/key', (req, res) => {
  res.json({ publicKey: vapid.publicKey });
});

// Подписаться на уведомления по зоне (lat/lng/radius_km — необязательно)
app.post('/api/push/subscribe', (req, res) => {
  const { subscription, lat = null, lng = null, radius_km = 10 } = req.body || {};
  if (!subscription || !subscription.endpoint || !subscription.keys) {
    return res.status(400).json({ error: 'Некорректная подписка' });
  }
  db.prepare(
    `INSERT INTO push_subs (client_id, endpoint, p256dh, auth, lat, lng, radius_km)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       client_id=excluded.client_id, p256dh=excluded.p256dh, auth=excluded.auth,
       lat=excluded.lat, lng=excluded.lng, radius_km=excluded.radius_km`
  ).run(
    req.clientId,
    subscription.endpoint,
    subscription.keys.p256dh,
    subscription.keys.auth,
    lat != null ? Number(lat) : null,
    lng != null ? Number(lng) : null,
    Number(radius_km) || 10
  );
  res.json({ ok: true });
});

// Отписаться
app.post('/api/push/unsubscribe', (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint) db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(endpoint);
  res.json({ ok: true });
});

// ---------- Планировщик автообновления данных OSM (cron) ----------
// Интервал задаётся переменной окружения OSM_REFRESH_HOURS.
// По умолчанию ВЫКЛЮЧЕНО (0), чтобы не «замусоривать» карту частичными
// данными OSM без отметок. Включить: OSM_REFRESH_HOURS=24 npm start
const REFRESH_HOURS = parseFloat(process.env.OSM_REFRESH_HOURS ?? '0');

let refreshing = false;
async function scheduledRefresh() {
  if (refreshing) return;
  refreshing = true;
  const t0 = Date.now();
  console.log('[cron] Автообновление АЗС из OpenStreetMap…');
  try {
    const total = await refreshAllCities({ delayMs: 3000 });
    console.log(
      `[cron] Готово: обработано ${total} АЗС за ${((Date.now() - t0) / 1000).toFixed(0)} c`
    );
  } catch (err) {
    console.error('[cron] Ошибка автообновления:', err.message);
  } finally {
    refreshing = false;
  }
}

function startScheduler() {
  if (!REFRESH_HOURS || REFRESH_HOURS <= 0) {
    console.log('[cron] Автообновление OSM отключено (OSM_REFRESH_HOURS=0).');
    return;
  }
  const ms = REFRESH_HOURS * 3600 * 1000;
  console.log(`[cron] Автообновление OSM каждые ${REFRESH_HOURS} ч.`);
  // Первый прогон — через 30 секунд после старта, чтобы не тормозить запуск.
  setTimeout(scheduledRefresh, 30 * 1000);
  setInterval(scheduledRefresh, ms);
}

// Ручной запуск обновления (для отладки/кнопки администратора).
app.post('/api/admin/refresh-osm', async (req, res) => {
  if (refreshing) return res.status(409).json({ error: 'Обновление уже выполняется' });
  scheduledRefresh();
  res.json({ ok: true, message: 'Обновление запущено в фоне' });
});

app.listen(PORT, () => {
  console.log(`ГдеЗаправка запущена: http://localhost:${PORT}`);
  startScheduler();
});
