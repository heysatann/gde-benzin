// Импорт АЗС из OpenStreetMap через Overpass API.
// Использование:
//   node import-osm.js "Екатеринбург"       — импорт по городу из списка ниже
//   node import-osm.js all                    — импорт по всем городам списка
//   node import-osm.js "Тюмень" 57.15 65.53   — произвольный город с координатами центра
//
// Данные © OpenStreetMap contributors (ODbL).

import db from './db.js';
import { pathToFileURL } from 'url';

// Несколько зеркал Overpass. Перебираем по очереди — часть доступна из РФ,
// часть нет, поэтому фолбэк повышает шанс успешного импорта.
const OVERPASS_MIRRORS = [
  // Зеркало VK/Mail.ru — обычно доступно из РФ
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
];

// Таймаут на одно зеркало (мс). Короткий — чтобы быстро переходить к следующему.
const PER_MIRROR_TIMEOUT = 25000;

// Запрос к Overpass с перебором зеркал и повторами
async function overpassFetch(query) {
  let lastErr;
  for (const url of OVERPASS_MIRRORS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PER_MIRROR_TIMEOUT);

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          // Accept обязателен для части зеркал — без него отдают 406 Not Acceptable
          Accept: 'application/json',
          'User-Agent': 'GdeZapravka/1.0 (fuel map; contact: local)',
        },
        body: 'data=' + encodeURIComponent(query),
        signal: controller.signal,
      });
      clearTimeout(timer);
      // 429/504 — зеркало перегружено; пробуем следующее
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      return data.elements || [];
    } catch (err) {
      lastErr = err;
      console.warn(`  ⚠ зеркало недоступно (${url.split('/')[2]}): ${err.message}`);
    }
  }
  throw new Error(`Все зеркала Overpass недоступны: ${lastErr?.message || 'неизвестная ошибка'}`);
}

// Список городов и радиус поиска (в метрах) вокруг центра
export const CITY_CENTERS = {
  Москва: [55.7558, 37.6173, 25000],
  'Санкт-Петербург': [59.9343, 30.3351, 25000],
  Екатеринбург: [56.8389, 60.6057, 20000],
  Новосибирск: [55.0084, 82.9357, 20000],
  Казань: [55.7963, 49.1088, 18000],
  'Нижний Новгород': [56.2965, 43.9361, 18000],
  Челябинск: [55.1644, 61.4368, 18000],
  Краснодар: [45.0355, 38.9753, 15000],
  'Ростов-на-Дону': [47.2357, 39.7015, 15000],
  Самара: [53.1959, 50.1002, 15000],
};

// Нормализация бренда из тегов OSM
function normalizeBrand(tags) {
  const raw = (tags.brand || tags.operator || tags.name || '').trim();
  if (!raw) return 'АЗС';
  const low = raw.toLowerCase();
  if (low.includes('газпром')) return 'Газпром нефть';
  if (low.includes('роснефт') || low.includes('rosneft')) return 'Роснефть';
  if (low.includes('лукойл') || low.includes('lukoil')) return 'Лукойл';
  if (low.includes('башнефт')) return 'Башнефть';
  if (low.includes('татнефт') || low.includes('tatneft')) return 'Татнефть';
  if (low.includes('shell')) return 'Shell';
  if (low.includes('нефтемагистраль') || low.includes('нм')) return 'GGroup';
  return raw;
}

function buildAddress(tags) {
  const street = tags['addr:street'] || '';
  const house = tags['addr:housenumber'] || '';
  const addr = [street, house].filter(Boolean).join(', ');
  return addr || tags['addr:full'] || '';
}

// Город из тегов OSM. Если явного города нет — берём район/регион/«—».
function cityFromTags(tags) {
  return (
    tags['addr:city'] ||
    tags['addr:town'] ||
    tags['addr:village'] ||
    tags['addr:district'] ||
    tags['addr:region'] ||
    tags['is_in:city'] ||
    ''
  ).trim();
}

export async function fetchCity(city, lat, lng, radius) {
  const query = `
    [out:json][timeout:60];
    (
      node["amenity"="fuel"](around:${radius},${lat},${lng});
      way["amenity"="fuel"](around:${radius},${lat},${lng});
    );
    out center tags;
  `;
  console.log(`Запрос АЗС для «${city}» (r=${radius}м)…`);
  return overpassFetch(query);
}

// Запрос АЗС внутри bbox-тайла (для покрытия всей России сеткой тайлов).
// bbox Overpass: (south,west,north,east).
async function fetchTile(s, w, n, e) {
  const query = `
    [out:json][timeout:120];
    (
      node["amenity"="fuel"](${s},${w},${n},${e});
      way["amenity"="fuel"](${s},${w},${n},${e});
    );
    out center tags;
  `;
  return overpassFetch(query);
}

// Импорт элементов, где город берётся из тегов каждой точки (для russia-режима).
export function importElementsByTag(elements) {
  let added = 0;
  const tx = db.transaction((els) => {
    for (const el of els) {
      const tags = el.tags || {};
      const lat = el.lat ?? el.center?.lat;
      const lng = el.lon ?? el.center?.lon;
      if (lat == null || lng == null) continue;
      const brand = normalizeBrand(tags);
      const name = tags.name || brand;
      const address = buildAddress(tags);
      const city = cityFromTags(tags) || 'Прочие';
      upsert.run({
        osm_id: `${el.type}/${el.id}`,
        brand,
        name,
        city,
        address,
        lat: +lat.toFixed(6),
        lng: +lng.toFixed(6),
      });
      added++;
    }
  });
  tx(elements);
  return added;
}

// Импорт АЗС по всей России сеткой тайлов. Границы РФ (без учёта Калининграда
// восточнее 180° — берём материковую часть широким прямоугольником).
// step — размер тайла в градусах (меньше = больше запросов, но надёжнее).
export async function importRussia({ step = 4, delayMs = 1500 } = {}) {
  const LAT_MIN = 41,
    LAT_MAX = 70; // от Кавказа до Заполярья
  const LNG_MIN = 19,
    LNG_MAX = 180; // от Калининграда до Чукотки
  let total = 0;
  let tile = 0;
  const tilesLat = Math.ceil((LAT_MAX - LAT_MIN) / step);
  const tilesLng = Math.ceil((LNG_MAX - LNG_MIN) / step);
  const tilesTotal = tilesLat * tilesLng;

  for (let lat = LAT_MIN; lat < LAT_MAX; lat += step) {
    for (let lng = LNG_MIN; lng < LNG_MAX; lng += step) {
      tile++;
      const s = lat,
        w = lng,
        n = Math.min(lat + step, LAT_MAX),
        e = Math.min(lng + step, LNG_MAX);
      try {
        const els = await fetchTile(s, w, n, e);
        const added = importElementsByTag(els);
        total += added;
        if (added > 0) {
          console.log(
            `  [${tile}/${tilesTotal}] тайл ${s.toFixed(0)},${w.toFixed(0)}..${n.toFixed(0)},${e.toFixed(0)}: +${added} (всего ${total})`
          );
        }
      } catch (err) {
        console.error(`  ✗ тайл ${s},${w}: ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  console.log(`Готово по России. Всего обработано: ${total} АЗС.`);
  return total;
}

const upsert = db.prepare(`

  INSERT INTO stations (osm_id, source, brand, name, city, address, lat, lng)
  VALUES (@osm_id, 'osm', @brand, @name, @city, @address, @lat, @lng)
  ON CONFLICT(osm_id) DO UPDATE SET
    brand=excluded.brand,
    name=excluded.name,
    city=excluded.city,
    address=excluded.address,
    lat=excluded.lat,
    lng=excluded.lng
`);

export function importElements(city, elements) {
  let added = 0;
  const tx = db.transaction((els) => {
    for (const e of els) {
      const tags = e.tags || {};
      const lat = e.lat ?? e.center?.lat;
      const lng = e.lon ?? e.center?.lon;
      if (lat == null || lng == null) continue;
      const brand = normalizeBrand(tags);
      const name = tags.name || brand;
      const address = buildAddress(tags);
      upsert.run({
        osm_id: `${e.type}/${e.id}`,
        brand,
        name,
        city,
        address,
        lat: +lat.toFixed(6),
        lng: +lng.toFixed(6),
      });
      added++;
    }
  });
  tx(elements);
  return added;
}

// Обновить все города из списка (используется cron-планировщиком в server.js).
// Возвращает суммарное число обработанных АЗС.
export async function refreshAllCities({ delayMs = 2000 } = {}) {
  let total = 0;
  for (const [city, [lat, lng, r]] of Object.entries(CITY_CENTERS)) {
    try {
      const els = await fetchCity(city, lat, lng, r);
      total += importElements(city, els);
      await new Promise((res) => setTimeout(res, delayMs));
    } catch (err) {
      console.error(`  ✗ ${city}: ${err.message}`);
    }
  }
  return total;
}

async function run() {
  const arg = process.argv[2];

  if (!arg) {
    console.log('Укажите город. Примеры:');
    console.log('  node import-osm.js "Екатеринбург"');
    console.log('  node import-osm.js all       — 10 крупных городов');
    console.log('  node import-osm.js russia    — ВСЯ Россия (все города, ~30–40 тыс. АЗС, долго)');
    console.log('  node import-osm.js "Тюмень" 57.15 65.53');
    process.exit(0);
  }

  // Импорт всей России сеткой тайлов
  if (arg === 'russia') {
    const step = process.argv[3] ? parseFloat(process.argv[3]) : 4;
    console.log(`Импорт АЗС по всей России (шаг тайла ${step}°)… Это надолго.`);
    await importRussia({ step });
    process.exit(0);
  }

  let targets = [];
  if (arg === 'all') {
    targets = Object.entries(CITY_CENTERS).map(([city, [lat, lng, r]]) => ({ city, lat, lng, r }));
  } else if (process.argv[3] && process.argv[4]) {
    targets = [{ city: arg, lat: +process.argv[3], lng: +process.argv[4], r: 15000 }];
  } else if (CITY_CENTERS[arg]) {
    const [lat, lng, r] = CITY_CENTERS[arg];
    targets = [{ city: arg, lat, lng, r }];
  } else {
    console.error(
      `Город «${arg}» не найден в списке. Передайте координаты: node import-osm.js "${arg}" <lat> <lng>`
    );
    process.exit(1);
  }

  let total = 0;
  for (const t of targets) {
    try {
      const els = await fetchCity(t.city, t.lat, t.lng, t.r);
      const added = importElements(t.city, els);
      total += added;
      console.log(`  ✓ ${t.city}: импортировано/обновлено ${added} АЗС`);
      // Пауза, чтобы не перегружать публичный Overpass
      if (targets.length > 1) await new Promise((r) => setTimeout(r, 2000));
    } catch (err) {
      console.error(`  ✗ ${t.city}: ${err.message}`);
    }
  }
  console.log(`Готово. Всего обработано: ${total} АЗС.`);
  process.exit(0);
}

// Запускаем CLI только при прямом вызове файла (не при импорте из server.js)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
