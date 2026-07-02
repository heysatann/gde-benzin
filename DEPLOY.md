# 🚀 Деплой «ГдеЗаправка» — полная инструкция

Проект = **Node.js + Express + SQLite** (бэкенд) + статичный фронтенд в `public/`.

> ⚠️ Важно: на **GitHub Pages задеплоить НЕЛЬЗЯ** — Pages отдаёт только
> статические файлы, а у нас есть сервер (API, база данных, push). Поэтому:
>
> 1. **Код** → храним на **GitHub**.
> 2. **Запуск** → на бесплатном Node-хостинге (**Render.com** — рекомендую,
>    или Railway / Fly.io / VPS). Хостинг сам берёт код из вашего GitHub-репо.

---

## Часть 1. Заливаем код на GitHub

### 1.1. Создайте репозиторий на GitHub

1. Откройте https://github.com/new
2. Repository name: `gde-zapravka`
3. Тип: **Private** или **Public** — на ваше усмотрение.
4. **Не** ставьте галочки «Add README / .gitignore / license» (они уже есть в проекте).
5. Нажмите **Create repository**.

### 1.2. Залейте проект (выполните в папке проекта)

Откройте терминал в `c:\Users\inkoz\Documents\Zapravka` и выполните по порядку.
Замените `USERNAME` на ваш логин GitHub.

```bash
git init
git add .
git commit -m "Первый коммит: сервис-карта АЗС"
git branch -M main
git remote add origin https://github.com/USERNAME/gde-zapravka.git
git push -u origin main
```

Если Git попросит логин/пароль — введите логин GitHub и вместо пароля
**Personal Access Token** (Settings → Developer settings → Personal access
tokens → Tokens (classic) → Generate new token, дайте права `repo`).

> ✅ Файлы `node_modules/`, `data.db`, `vapid.json`, `*.log` уже игнорируются
> (см. `.gitignore`) — секреты и мусор в репозиторий не попадут.

### 1.3. Как обновлять код в будущем

После любых правок:

```bash
git add .
git commit -m "Что изменил"
git push
```

Render (см. ниже) автоматически пересоберёт и перезапустит сайт после `push`.

---

## Часть 2. Запуск на Render.com (бесплатно)

В проекте уже лежит `render.yaml` — Render прочитает его сам.

1. Зайдите на https://render.com и войдите через **GitHub** (Sign up with GitHub).
2. Разрешите Render доступ к вашему репозиторию `gde-zapravka`.
3. Нажмите **New +** → **Blueprint**.
4. Выберите репозиторий `gde-zapravka` → **Connect**.
5. Render покажет сервис `gde-zapravka` из `render.yaml` → нажмите **Apply**.
6. Дождитесь сборки (5–7 минут). Когда статус станет **Live** — сайт готов.
7. Ссылка вида `https://gde-zapravka.onrender.com` — это ваш рабочий сайт.

**Что настроено автоматически (через `render.yaml`):**

- `npm install` при сборке, `npm start` при запуске;
- переменная `PORT` (Render задаёт сам, сервер её читает);
- постоянный диск `/data` (1 ГБ) — база `data.db` там переживает рестарты;
- `DATA_DIR=/data` — сервер кладёт базу на этот диск.

> 💡 На бесплатном тарифе Render сервис «засыпает» после 15 минут без
> запросов — первый заход после сна грузится ~30 секунд. Это нормально.

### Push-уведомления (необязательно)

Если хотите веб-пуши в проде — задайте VAPID-ключи:

1. Сгенерируйте ключи локально:
   ```bash
   npx web-push generate-vapid-keys
   ```
2. В Render: сервис → **Environment** → **Add Environment Variable**, добавьте:
   - `VAPID_PUBLIC_KEY` = публичный ключ
   - `VAPID_PRIVATE_KEY` = приватный ключ
   - `VAPID_SUBJECT` = `mailto:you@example.com`
3. **Save changes** — сервис перезапустится.

---

## Часть 3. Альтернатива — Railway.app

1. https://railway.app → **Login with GitHub**.
2. **New Project** → **Deploy from GitHub repo** → выберите `gde-zapravka`.
3. Railway сам определит Node, выполнит `npm install` и `npm start`.
4. В **Variables** при желании добавьте `DATA_DIR` и VAPID-ключи.
5. В **Settings → Networking** нажмите **Generate Domain** — получите ссылку.

> Для сохранности базы на Railway добавьте **Volume** и смонтируйте его,
> например, в `/data`, затем переменную `DATA_DIR=/data`.

---

## Часть 4. Локальный запуск (для проверки перед деплоем)

```bash
npm install
npm start
# откройте http://localhost:3000
```

Импорт реальных АЗС из OpenStreetMap для города (пример):

```bash
node import-osm.js "Екатеринбург"
```

---

## Частые проблемы

| Проблема                                 | Решение                                                                |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| `git push` просит пароль и не пускает    | Используйте Personal Access Token вместо пароля                        |
| На Render ошибка сборки `better-sqlite3` | Проверьте, что `NODE_VERSION` = 20.x (задано в `render.yaml`)          |
| После рестарта пропали данные            | Проверьте, что подключён диск и задан `DATA_DIR=/data`                 |
| Старый вид карты после обновления        | Сделайте Ctrl+F5 (жёсткое обновление) — Service Worker кэширует ассеты |
| Первый заход грузится долго              | Норма для бесплатного Render (сервис «просыпается»)                    |
