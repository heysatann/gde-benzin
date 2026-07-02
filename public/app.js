// ГдеЗаправка — фронтенд
'use strict';

const STATUS_LABEL = {
  yes: 'Есть топливо',
  limit: 'Лимит на отпуск',
  no: 'Нет топлива',
  unknown: 'Нет данных',
};
const STATUS_SHORT = { yes: 'Есть', limit: 'Лимит', no: 'Нет', unknown: '—' };

const BRAND_ICON = {
  'Газпром нефть': '🔵',
  Роснефть: '🟡',
  Лукойл: '🔴',
  Башнефть: '🟣',
  Татнефть: '🟠',
  Shell: '🐚',
  GGroup: '🟢',
  'АЗС 21': '🅰️',
};

// Состояние приложения
const state = {
  map: null,
  cluster: null,
  markers: {},
  stations: [],

  cities: [],
  currentCity: null,
  filter: 'all',
  selectedId: null,
  meta: { statuses: [], fuels: [], queues: [] },
  reportForm: { status: 'yes', fuels: [], queue: null },
  userPos: null,
};

// Утилиты
function $(sel) {
  return document.querySelector(sel);
}
function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}
function api(url, options) {
  return fetch(url, options).then((r) => {
    if (!r.ok) return r.json().then((e) => Promise.reject(e));
    return r.json();
  });
}
function timeAgo(iso) {
  if (!iso) return '';
  const then = new Date(iso.replace(' ', 'T') + 'Z').getTime();
  const diff = Math.max(0, Date.now() - then);
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ч назад`;
  const d = Math.floor(h / 24);
  return `${d} дн назад`;
}

// Дебаунс — откладываем вызов, пока события идут подряд (панорамирование карты)
function debounce(fn, ms) {
  let t;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
}

// Шкала уверенности (рейтинг доверия к консенсусу отметок)

function confidenceLabel(pct) {
  if (pct >= 75) return 'Высокая';
  if (pct >= 45) return 'Средняя';
  if (pct > 0) return 'Низкая';
  return 'Нет данных';
}
function confidenceHtml(s) {
  const pct = s.confidence || 0;
  const bars = 20;
  const filled = Math.round((pct / 100) * bars);
  const segs = Array.from({ length: bars })
    .map((_, i) => `<i class="${i < filled ? 'on' : ''}"></i>`)
    .join('');
  return `
    <div class="confidence">
      <div class="conf-top">
        <span>Уверенность <span class="conf-i" title="Рассчитывается по числу и свежести отметок водителей и репутации авторов">ⓘ</span></span>
        <span class="conf-pct">${pct}%</span>
      </div>
      <div class="conf-bars">${segs}</div>
      <div class="conf-note">${confidenceLabel(pct)}${
        s.reportsCount ? ' · ' + s.reportsCount + ' независимых отметок' : ''
      }</div>
    </div>`;
}

// ---------- Инициализация ----------
async function init() {
  state.meta = await api('/api/meta');

  // Карта
  state.map = L.map('map', { zoomControl: true }).setView([55.75, 37.61], 11);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap',
  }).addTo(state.map);

  // Кластеризация маркеров: облачка с числом АЗС и цветом по преобладающему статусу
  state.cluster = L.markerClusterGroup({
    maxClusterRadius: 55,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    chunkedLoading: true,
    iconCreateFunction: clusterIcon,
  });
  state.map.addLayer(state.cluster);

  // Догрузка станций по видимой области карты (как на gdezapravka.ru): при
  // панорамировании/зуме подтягиваем АЗС внутри bbox — станции есть везде,
  // а не только в 10 «городах». Запрос дебаунсится, чтобы не спамить сервер.
  state.map.on('moveend', debounce(loadStationsInView, 350));

  // Города
  state.cities = await api('/api/cities');
  const sel = $('#citySelect');
  state.cities.forEach((c) => {
    const o = el('option');
    o.value = c.city;
    o.textContent = `${c.city} (${c.count})`;
    sel.appendChild(o);
  });
  sel.addEventListener('change', () => selectCity(sel.value));

  // Фильтры
  document.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      state.filter = chip.dataset.filter;
      renderList();
      renderMarkers();
    });
  });

  // Кнопка геолокации
  $('#locateBtn').addEventListener('click', locateUser);

  // Панель деталей и модалка
  setupModal();

  // Первый город
  await selectCity(state.cities[0].city);
}

// ---------- Города ----------
// Выбор города = перелёт карты к его центру. Сами станции подтягивает
// loadStationsInView по событию moveend (bbox-режим).
async function selectCity(city) {
  state.currentCity = city;
  $('#citySelect').value = city;
  const c = state.cities.find((x) => x.city === city);
  if (c)
    state.map.setView([c.lat, c.lng], 12); // вызовет moveend → loadStationsInView
  else await loadStationsInView();
}

// Загрузка станций внутри текущей видимой области карты (bbox).
async function loadStationsInView() {
  const b = state.map.getBounds();
  const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].join(',');
  const params = new URLSearchParams({ bbox, limit: '2000' });
  if (state.userPos) {
    params.set('near_lat', state.userPos[0]);
    params.set('near_lng', state.userPos[1]);
  }
  try {
    state.stations = await api('/api/stations?' + params.toString());
  } catch (e) {
    state.stations = [];
  }
  // Определяем «текущий город» по центру области — для заголовка списка
  const center = state.map.getCenter();
  const nearest = nearestCity(center.lat, center.lng);
  if (nearest) {
    state.currentCity = nearest.city;
    $('#citySelect').value = nearest.city;
  }
  renderList();
  renderMarkers();
}

// Ближайший город из справочника к точке (для подписи и селекта)
function nearestCity(lat, lng) {
  let best = null;
  let bestD = Infinity;
  for (const c of state.cities) {
    const d = (c.lat - lat) ** 2 + (c.lng - lng) ** 2;
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

// ---------- Список АЗС ----------
function filteredStations() {
  if (state.filter === 'all') return state.stations;
  return state.stations.filter((s) => (s.status || 'unknown') === state.filter);
}

function renderList() {
  const list = $('#stationList');
  list.innerHTML = '';
  const items = filteredStations();
  $('#listCount').textContent = items.length;
  $('#listTitle').textContent = state.userPos ? 'Ближайшие АЗС' : `АЗС · ${state.currentCity}`;

  if (!items.length) {
    list.appendChild(el('div', 'hint', 'Нет АЗС по выбранному фильтру.'));
    return;
  }

  items.forEach((s) => {
    const st = s.status || 'unknown';
    const card = el('div', 'station-card');
    card.innerHTML = `
      <div class="brand-icon">${BRAND_ICON[s.brand] || '⛽'}</div>
      <div class="info">
        <div class="row1">
          <span class="badge ${st}">${STATUS_SHORT[st]}</span>
          <span class="brand-name">${s.brand}</span>
        </div>
        <div class="addr">${s.address || ''}</div>
        ${s.confirmations ? `<div class="confirm-note">${s.confirmations} подтверждений</div>` : ''}
      </div>
      ${s.distance != null ? `<div class="dist">${s.distance.toFixed(1)} км</div>` : ''}
    `;
    card.addEventListener('click', () => openDetail(s.id));
    list.appendChild(card);
  });
}

// Цвета статусов для колец/сегментов
const STATUS_COLOR = {
  yes: '#22c55e',
  limit: '#f5c518',
  no: '#ef4444',
  unknown: '#8a94a6',
};

// SVG-путь топливной колонки (линейная иконка, рисуется обводкой).
// viewBox 0 0 24 24. Используем внутри <g> с нужным transform/масштабом.
const FUEL_PATHS = `
  <path d="M3 22h12"></path>
  <path d="M4 9h10"></path>
  <path d="M14 22V4a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v18"></path>
  <path d="M14 13h2a2 2 0 0 1 2 2v2a2 2 0 0 0 4 0V9.83a2 2 0 0 0-.59-1.41L18 5"></path>`;

// Иконка колонки заданного размера (px), белой обводкой
function fuelGlyph(px) {
  const scale = px / 24;
  return `<g transform="scale(${scale})" fill="none" stroke="#fff" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round">${FUEL_PATHS}</g>`;
}

// ---------- Маркеры на карте ----------
// Одиночная АЗС — «кругляшок» в стиле аналога: тёмный круг + сплошное кольцо
// в цвете статуса + иконка колонки в центре. Всё рисуем внутри одного SVG,
// чтобы никакие внешние стили не могли «съесть» содержимое.
function markerIcon(status) {
  const st = status || 'unknown';
  const size = 36;
  const cxy = size / 2;
  const sw = 5; // толщина кольца
  const r = cxy - sw / 2 - 1;
  const color = STATUS_COLOR[st];
  const gpx = 18; // размер глифа
  const go = (size - gpx) / 2; // смещение для центрирования глифа
  const html = `
    <div class="dot" style="width:${size}px;height:${size}px">
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        <circle cx="${cxy}" cy="${cxy}" r="${r}" fill="#171d29" stroke="#0b0e14" stroke-width="1"/>
        <circle cx="${cxy}" cy="${cxy}" r="${r}" fill="none" stroke="${color}" stroke-width="${sw}"/>
        <g transform="translate(${go} ${go})">${fuelGlyph(gpx)}</g>
      </svg>
    </div>`;
  return L.divIcon({
    className: '',
    html,
    iconSize: [size, size],
    iconAnchor: [cxy, cxy],
    popupAnchor: [0, -cxy],
  });
}

// Иконка кластера — «кругляшок» как на gdezapravka.ru: тёмный круг с числом
// АЗС в центре и кольцом-донатом, сегменты которого показывают доли статусов
// (зелёный — есть, красный — нет, жёлтый — лимит, серый — нет данных).
function clusterIcon(cluster) {
  const markers = cluster.getAllChildMarkers();
  const count = cluster.getChildCount();
  const tally = { yes: 0, limit: 0, no: 0, unknown: 0 };
  markers.forEach((m) => {
    tally[m.options.stStatus || 'unknown']++;
  });

  const size = count < 10 ? 42 : count < 50 ? 52 : count < 200 ? 62 : 72;
  const cxy = size / 2;
  const sw = size < 50 ? 6 : 8; // толщина цветного кольца
  const r = cxy - sw / 2 - 2; // радиус, по которому идёт кольцо (у самого края)
  const rInner = r - sw / 2; // радиус сплошного тёмного диска (внутри кольца)
  const circ = 2 * Math.PI * r;

  // Строим сегменты кольца в порядке yes → limit → no → unknown
  const order = ['yes', 'limit', 'no', 'unknown'];
  let offset = 0;
  const segs = order
    .filter((k) => tally[k] > 0)
    .map((k) => {
      const frac = tally[k] / count;
      const len = frac * circ;
      const dash = `${len} ${circ - len}`;
      const seg = `<circle cx="${cxy}" cy="${cxy}" r="${r}" fill="none"
        stroke="${STATUS_COLOR[k]}" stroke-width="${sw}"
        stroke-dasharray="${dash}" stroke-dashoffset="${-offset}"
        transform="rotate(-90 ${cxy} ${cxy})" stroke-linecap="butt"/>`;
      offset += len;
      return seg;
    })
    .join('');

  const fontSize = size < 50 ? 16 : size < 60 ? 19 : 23;
  // Число рисуем как SVG <text> прямо внутри SVG — так его не сможет
  // «спрятать»/обрезать никакая внешняя таблица стилей (в т.ч. markercluster).
  const html = `
    <div class="cluster-donut" style="width:${size}px;height:${size}px">
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        <!-- фоновое серое кольцо (незаполненная часть) -->
        <circle cx="${cxy}" cy="${cxy}" r="${r}" fill="none" stroke="#39414f" stroke-width="${sw}"/>
        ${segs}
        <!-- сплошной тёмный диск в центре: на нём читается число -->
        <circle cx="${cxy}" cy="${cxy}" r="${rInner}" fill="#171d29" stroke="#0b0e14" stroke-width="1"/>
        <text x="${cxy}" y="${cxy}" fill="#fff" font-size="${fontSize}"
          font-weight="800" text-anchor="middle" dominant-baseline="central"
          font-family="-apple-system,Segoe UI,Roboto,Arial,sans-serif">${count}</text>
      </svg>
    </div>`;

  return L.divIcon({ html, className: '', iconSize: [size, size] });
}

function renderMarkers() {
  // Очищаем кластер-слой
  state.cluster.clearLayers();
  state.markers = {};

  const batch = [];
  filteredStations().forEach((s) => {
    const m = L.marker([s.lat, s.lng], {
      icon: markerIcon(s.status),
      stStatus: s.status || 'unknown',
    });
    m.on('click', () => openDetail(s.id));
    state.markers[s.id] = m;
    batch.push(m);
  });
  state.cluster.addLayers(batch);
}

// ---------- Геолокация ----------
function locateUser() {
  if (!navigator.geolocation) return alert('Геолокация не поддерживается');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.userPos = [pos.coords.latitude, pos.coords.longitude];
      state.map.setView(state.userPos, 13);
      L.circleMarker(state.userPos, { radius: 8, color: '#2ea043', fillOpacity: 0.9 })
        .addTo(state.map)
        .bindPopup('Вы здесь');
      // Пересортировать список по расстоянию
      selectCity(state.currentCity);
    },
    () => alert('Не удалось определить местоположение')
  );
}

// ---------- Панель деталей ----------
async function openDetail(id) {
  state.selectedId = id;
  const s = await api('/api/stations/' + id);
  const st = s.status || 'unknown';
  const panel = $('#detailPanel');
  const c = $('#detailContent');

  const fuelPills = state.meta.fuels
    .map((f) => `<span class="fuel-pill ${s.fuels.includes(f) ? 'on' : ''}">${f}</span>`)
    .join('');

  const priceRows = s.prices.length
    ? s.prices
        .map(
          (p) => `
      <div class="price-row">
        <span class="fuel">${p.fuel}</span>
        <span class="val">${p.price.toFixed(2)} <span>₽/л · ${timeAgo(p.created_at)}</span></span>
      </div>`
        )
        .join('')
    : '<div class="hint">Цен пока нет. Добавьте первую!</div>';

  const fuelOptions = state.meta.fuels.map((f) => `<option value="${f}">${f}</option>`).join('');

  const history = s.history.length
    ? s.history
        .map(
          (h) =>
            `<div class="history-item"><b>${STATUS_SHORT[h.status]}</b> · ${
              h.fuels.join(', ') || '—'
            }${h.queue ? ' · ' + h.queue : ''} · ${timeAgo(h.created_at)}</div>`
        )
        .join('')
    : '<div class="hint">История пуста.</div>';

  c.innerHTML = `
    <div class="detail-head">
      <div class="brand-icon">${BRAND_ICON[s.brand] || '⛽'}</div>
      <h2>${s.brand}</h2>
      <button class="detail-close" id="detailClose">×</button>
    </div>

    <div class="status-box ${st}">
      <div class="status-title ${st}">${STATUS_LABEL[st]}</div>
      ${confidenceHtml(s)}
      <div class="status-meta">
        ${s.address || ''} · ${s.city}${s.source === 'osm' ? ' · <span title="Импортировано из OpenStreetMap">OSM</span>' : ''}<br>
        ${s.confirmations ? s.confirmations + ' подтверждений · ' : ''}${
          s.updatedAt ? 'обновлено ' + timeAgo(s.updatedAt) : 'ещё нет отметок'
        }
        ${s.limit ? '<br>Лимит на отпуск: ' + s.limit + ' л' : ''}
        ${s.queue ? '<br>Очередь: ' + s.queue : ''}
      </div>
    </div>


    <div class="section-label">Доступное топливо</div>
    <div class="fuel-pills">${fuelPills}</div>

    <div class="section-label">Цены, ₽/л</div>
    <div class="price-grid">${priceRows}</div>
    <div class="add-price">
      <select id="priceFuel">${fuelOptions}</select>
      <input type="number" id="priceValue" placeholder="63.41" step="0.01" min="0" />
      <button class="btn primary" id="priceAdd" style="padding:8px 14px;flex:0;">+</button>
    </div>

    <div class="detail-actions">
      <button class="btn primary block" id="openReport">📝 Отметить наличие</button>
      <button class="btn ghost block" id="routeBtn">🧭 Маршрут</button>
    </div>

    <div class="section-label">История отметок</div>
    ${history}
  `;

  panel.classList.remove('hidden');
  if (state.markers[id]) state.map.panTo([s.lat, s.lng]);

  $('#detailClose').addEventListener('click', () => panel.classList.add('hidden'));
  $('#openReport').addEventListener('click', () => openReport(s));
  $('#routeBtn').addEventListener('click', () => {
    window.open(`https://yandex.ru/maps/?rtext=~${s.lat},${s.lng}&rtt=auto`, '_blank');
  });
  $('#priceAdd').addEventListener('click', async () => {
    const fuel = $('#priceFuel').value;
    const price = $('#priceValue').value;
    if (!price) return;
    try {
      await api(`/api/stations/${id}/price`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fuel, price }),
      });
      openDetail(id);
    } catch (e) {
      alert(e.error || 'Ошибка добавления цены');
    }
  });
}

// ---------- Модалка "Отметить наличие" ----------
function setupModal() {
  const modal = $('#reportModal');

  // Марки топлива
  const fuelTags = $('#fuelTags');
  state.meta.fuels.forEach((f) => {
    const t = el('button', 'tag', f);
    t.dataset.fuel = f;
    t.addEventListener('click', () => {
      t.classList.toggle('on');
      const idx = state.reportForm.fuels.indexOf(f);
      if (idx >= 0) state.reportForm.fuels.splice(idx, 1);
      else state.reportForm.fuels.push(f);
    });
    fuelTags.appendChild(t);
  });

  // Очередь
  const queueTags = $('#queueTags');
  state.meta.queues.forEach((q) => {
    const t = el('button', 'tag', q);
    t.dataset.queue = q;
    t.addEventListener('click', () => {
      const wasOn = t.classList.contains('on');
      queueTags.querySelectorAll('.tag').forEach((x) => x.classList.remove('on'));
      if (!wasOn) {
        t.classList.add('on');
        state.reportForm.queue = q;
      } else {
        state.reportForm.queue = null;
      }
    });
    queueTags.appendChild(t);
  });

  // Статус
  $('#statusSeg')
    .querySelectorAll('.seg-btn')
    .forEach((b) => {
      b.addEventListener('click', () => {
        $('#statusSeg')
          .querySelectorAll('.seg-btn')
          .forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        state.reportForm.status = b.dataset.status;
      });
    });

  $('#reportCancel').addEventListener('click', () => modal.classList.add('hidden'));
  $('#reportSubmit').addEventListener('click', submitReport);
}

function openReport(s) {
  // Сброс формы
  state.reportForm = { status: 'yes', fuels: [], queue: null };
  $('#reportTitle').textContent = 'Отметить наличие — ' + s.brand;
  $('#statusSeg')
    .querySelectorAll('.seg-btn')
    .forEach((b) => b.classList.toggle('active', b.dataset.status === 'yes'));
  $('#fuelTags')
    .querySelectorAll('.tag')
    .forEach((t) => t.classList.remove('on'));
  $('#queueTags')
    .querySelectorAll('.tag')
    .forEach((t) => t.classList.remove('on'));
  $('#limitInput').value = '';
  $('#reportModal').classList.remove('hidden');
}

async function submitReport() {
  const payload = {
    status: state.reportForm.status,
    fuels: state.reportForm.fuels,
    queue: state.reportForm.queue,
    limit_liters: $('#limitInput').value || null,
  };
  try {
    await api(`/api/stations/${state.selectedId}/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    $('#reportModal').classList.add('hidden');
    // Обновить данные
    await selectCity(state.currentCity);
    openDetail(state.selectedId);
  } catch (e) {
    alert(e.error || 'Ошибка отправки отметки');
  }
}

// ================= PWA: регистрация SW, установка, push =================
const pwa = {
  swReg: null,
  deferredPrompt: null,
};

async function initPWA() {
  if (!('serviceWorker' in navigator)) return;
  try {
    pwa.swReg = await navigator.serviceWorker.register('/sw.js');
  } catch (e) {
    console.warn('SW не зарегистрирован:', e);
  }

  // Баннер установки (Android/Chrome)
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    pwa.deferredPrompt = e;
    if (!localStorage.getItem('installDismissed')) {
      $('#installBanner').classList.remove('hidden');
    }
  });
  $('#installYes')?.addEventListener('click', async () => {
    $('#installBanner').classList.add('hidden');
    if (pwa.deferredPrompt) {
      pwa.deferredPrompt.prompt();
      await pwa.deferredPrompt.userChoice;
      pwa.deferredPrompt = null;
    }
  });
  $('#installNo')?.addEventListener('click', () => {
    $('#installBanner').classList.add('hidden');
    localStorage.setItem('installDismissed', '1');
  });

  // Кнопка уведомлений
  setupNotifyButton();
}

// base64 → Uint8Array (для applicationServerKey)
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

function setupNotifyButton() {
  const btn = $('#notifyBtn');
  if (!btn) return;
  const supported = 'Notification' in window && 'PushManager' in window;
  if (!supported) {
    btn.style.display = 'none';
    return;
  }
  // Отразить текущее состояние подписки
  navigator.serviceWorker.ready.then((reg) =>
    reg.pushManager.getSubscription().then((sub) => btn.classList.toggle('on', !!sub))
  );

  btn.addEventListener('click', async () => {
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    if (existing) {
      // Отписка
      await fetch('/api/push/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: existing.endpoint }),
      });
      await existing.unsubscribe();
      btn.classList.remove('on');
      alert('Уведомления отключены.');
      return;
    }
    // Подписка
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      alert('Разрешение на уведомления не выдано.');
      return;
    }
    try {
      const { publicKey } = await api('/api/push/key');
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      // Зона интереса = центр карты + радиус ~15 км
      const c = state.map.getCenter();
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subscription: sub.toJSON(),
          lat: c.lat,
          lng: c.lng,
          radius_km: 15,
        }),
      });
      btn.classList.add('on');
      alert('Готово! Пришлём уведомление, когда рядом изменится наличие топлива.');
    } catch (e) {
      console.error(e);
      alert('Не удалось подписаться на уведомления.');
    }
  });
}

// ================= Мобильная «шторка» списка =================
function initMobileSheet() {
  const sidebar = $('#sidebar');
  if (!sidebar) return;
  // Тап по «ручке» (верхняя зона) — открыть/закрыть
  sidebar.addEventListener('click', (e) => {
    if (window.innerWidth > 768) return;
    // Клик по верхней области (ручка/заголовок) переключает шторку
    if (e.target.closest('.station-card')) return; // карточки не мешаем
    const rect = sidebar.getBoundingClientRect();
    if (e.clientY - rect.top < 60) sidebar.classList.toggle('open');
  });
}

// При открытии карточки на телефоне — свернуть шторку, чтобы видеть карту/детали
const _openDetail = openDetail;
openDetail = function (id) {
  if (window.innerWidth <= 768) $('#sidebar')?.classList.remove('open');
  return _openDetail(id);
};

init().then(() => {
  initPWA();
  initMobileSheet();
});
