import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Путь к БД можно переопределить переменной окружения DATA_DIR — это нужно для
// хостинга (напр. Render), где база лежит на постоянном диске (/data), чтобы
// не терялась при рестартах. Локально по умолчанию — рядом с кодом.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const db = new Database(path.join(DATA_DIR, 'data.db'));

db.pragma('journal_mode = WAL');

// ---------- Схема ----------
db.exec(`
CREATE TABLE IF NOT EXISTS stations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  osm_id TEXT UNIQUE,              -- id объекта OpenStreetMap (node/way)
  source TEXT DEFAULT 'demo',      -- 'demo' | 'osm'
  brand TEXT NOT NULL,
  name TEXT,
  city TEXT NOT NULL,
  address TEXT,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER NOT NULL,
  status TEXT NOT NULL,            -- 'yes' | 'limit' | 'no'
  fuels TEXT,                      -- JSON массив: ["АИ-92","АИ-95",...]
  limit_liters INTEGER,            -- лимит на отпуск, л
  queue TEXT,                      -- метка очереди
  client_id TEXT,                  -- анонимный идентификатор автора (антиспам)
  weight REAL DEFAULT 1,           -- базовый вес отметки (репутация автора)
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (station_id) REFERENCES stations(id)
);


CREATE TABLE IF NOT EXISTS prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER NOT NULL,
  fuel TEXT NOT NULL,              -- марка топлива
  price REAL NOT NULL,             -- руб/л
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (station_id) REFERENCES stations(id)
);

CREATE INDEX IF NOT EXISTS idx_reports_station ON reports(station_id);
CREATE INDEX IF NOT EXISTS idx_prices_station ON prices(station_id);

-- Подписки на push-уведомления. Пользователь может подписаться на «свою
-- зону» (координаты + радиус) — будем слать пуш при изменении статуса АЗС рядом.
CREATE TABLE IF NOT EXISTS push_subs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT,
  endpoint TEXT UNIQUE NOT NULL,     -- endpoint push-сервиса браузера
  p256dh TEXT NOT NULL,              -- ключ шифрования
  auth TEXT NOT NULL,                -- ключ аутентификации
  lat REAL,                          -- центр зоны интереса
  lng REAL,
  radius_km REAL DEFAULT 10,         -- радиус зоны
  created_at TEXT DEFAULT (datetime('now'))
);
`);

// ---------- Миграции (для уже существующих БД) ----------
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`Миграция: добавлена колонка ${table}.${column}`);
  }
}
ensureColumn('stations', 'osm_id', 'TEXT');
ensureColumn('stations', 'source', "TEXT DEFAULT 'demo'");
ensureColumn('reports', 'client_id', 'TEXT');
ensureColumn('reports', 'weight', 'REAL DEFAULT 1');

// Уникальный индекс на osm_id (нужен для upsert ON CONFLICT при импорте OSM).
// В старых БД колонка добавлена через ALTER без UNIQUE — досоздаём индекс здесь.
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_stations_osm ON stations(osm_id)');

// ---------- Демо-данные (крупные города РФ) ----------
const count = db.prepare('SELECT COUNT(*) AS c FROM stations').get().c;
if (count === 0) {
  const brands = [
    'Газпром нефть',
    'Роснефть',
    'Лукойл',
    'Башнефть',
    'Татнефть',
    'Shell',
    'GGroup',
    'АЗС 21',
  ];
  const cities = [
    { city: 'Москва', lat: 55.7558, lng: 37.6173 },
    { city: 'Санкт-Петербург', lat: 59.9343, lng: 30.3351 },
    { city: 'Екатеринбург', lat: 56.8389, lng: 60.6057 },
    { city: 'Новосибирск', lat: 55.0084, lng: 82.9357 },
    { city: 'Казань', lat: 55.7963, lng: 49.1088 },
    { city: 'Нижний Новгород', lat: 56.2965, lng: 43.9361 },
    { city: 'Челябинск', lat: 55.1644, lng: 61.4368 },
    { city: 'Краснодар', lat: 45.0355, lng: 38.9753 },
    { city: 'Ростов-на-Дону', lat: 47.2357, lng: 39.7015 },
    { city: 'Самара', lat: 53.1959, lng: 50.1002 },
  ];

  const streets = [
    'ул. Ленина',
    'пр. Мира',
    'ул. Гагарина',
    'Московский тракт',
    'ул. Победы',
    'ул. Советская',
    'Объездная дорога',
    'ул. Кирова',
  ];

  const insert = db.prepare(
    'INSERT INTO stations (brand, name, city, address, lat, lng) VALUES (?, ?, ?, ?, ?, ?)'
  );

  const seed = db.transaction(() => {
    for (const c of cities) {
      // по 12 АЗС на город, разбросанных вокруг центра
      for (let i = 0; i < 12; i++) {
        const brand = brands[Math.floor(Math.random() * brands.length)];
        const dLat = (Math.random() - 0.5) * 0.18;
        const dLng = (Math.random() - 0.5) * 0.3;
        const street = streets[Math.floor(Math.random() * streets.length)];
        const houseNo = 1 + Math.floor(Math.random() * 200);
        insert.run(
          brand,
          `${brand} №${i + 1}`,
          c.city,
          `${street}, ${houseNo}`,
          +(c.lat + dLat).toFixed(6),
          +(c.lng + dLng).toFixed(6)
        );
      }
    }
  });
  seed();
  console.log('Демо-данные АЗС созданы.');
}

// ---------- Демо-отметки водителей ----------
// Чтобы карта не выглядела «мёртвой» (все маркеры серые = нет данных), при
// первом запуске генерируем правдоподобные отметки наличия для части АЗС.
// Это же делает картину похожей на аналог: зелёные/жёлтые/красные точки.
const reportsCount = db.prepare('SELECT COUNT(*) AS c FROM reports').get().c;
if (reportsCount === 0) {
  const allFuels = ['АИ-92', 'АИ-95', 'АИ-98', 'АИ-100', 'ДТ', 'Газ'];
  const queues = ['Нет очереди', '1–3 машины', '4–8 машин', '8–20 машин', '≈20–50 машин'];
  const stations = db.prepare('SELECT id FROM stations').all();
  const ins = db.prepare(
    `INSERT INTO reports (station_id, status, fuels, limit_liters, queue, client_id, weight, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', ?))`
  );
  const pins = db.prepare('INSERT INTO prices (station_id, fuel, price) VALUES (?, ?, ?)');

  const seedReports = db.transaction(() => {
    for (const s of stations) {
      // ~80% станций получают хотя бы одну отметку
      if (Math.random() > 0.8) continue;

      // Распределение статусов: чаще «есть», реже «лимит»/«нет»
      const roll = Math.random();
      const status = roll < 0.6 ? 'yes' : roll < 0.8 ? 'limit' : 'no';

      // Марки: для «нет» — пусто, иначе случайный набор
      let fuels = [];
      if (status !== 'no') {
        fuels = allFuels.filter(() => Math.random() < 0.5);
        if (!fuels.length) fuels = ['АИ-92', 'АИ-95'];
      }
      const limit = status === 'limit' ? [10, 15, 20, 30][Math.floor(Math.random() * 4)] : null;
      const queue = Math.random() < 0.6 ? queues[Math.floor(Math.random() * queues.length)] : null;

      // 1–4 независимых «подтверждения» от разных анонимов за последние часы
      const votes = 1 + Math.floor(Math.random() * 4);
      for (let v = 0; v < votes; v++) {
        const ageH = +(Math.random() * 6).toFixed(2); // до 6 часов назад
        ins.run(
          s.id,
          status,
          JSON.stringify(fuels),
          limit,
          queue,
          'seed-' + s.id + '-' + v,
          1,
          `-${ageH} hours`
        );
      }

      // Немного цен для наглядности
      if (status !== 'no' && Math.random() < 0.7) {
        const base = 55 + Math.random() * 12; // 55–67 ₽
        for (const f of fuels.slice(0, 2)) {
          const delta = f === 'АИ-95' ? 4 : f === 'АИ-98' ? 9 : f === 'ДТ' ? 2 : 0;
          pins.run(s.id, f, +(base + delta).toFixed(2));
        }
      }
    }
  });
  seedReports();
  console.log('Демо-отметки водителей созданы (карта «оживлена»).');
}

export default db;
