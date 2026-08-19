# 🤖 Discord Bot

Текущая версия: **1.3.0**. Подробное описание изменений — в
[CHANGELOG.md](CHANGELOG.md).

Discord-бот на discord.js/Bun: управление структурой сервера (роли, каналы, права),
музыка с YouTube с кэшированием на диск, история сообщений, веб-панель управления.
Работает в Docker.

**Возможности:**
- 🎵 Музыка с YouTube (`yt-dlp` + `ffmpeg`), кэш скачанных треков на диске — повторное
  воспроизведение идёт с диска, а не по сети
- 🖥️ Веб-панель (`http://127.0.0.1:8787`) — конфиг, музыка, голосовой дашборд
  (кто в канале + мьют/бан), участники, модерация, история, статистика
- ⚙️ Декларативная структура сервера (`config/structure.json`) — роли, каналы,
  права, изоляция ролей ("тюрьма"), глобальные deny/allow-правила
- 🗒️ История сообщений (создание/редактирование/удаление) в SQLite
- ♻️ Восстановление очереди музыки после перезапуска
- 🐳 Docker Compose с health-check и лимитами ресурсов

---

## 🚀 Быстрый старт

```bash
cp .env.example .env
# впишите DISCORD_TOKEN, CLIENT_ID, (опционально) GUILD_ID
cp config/structure.example.json config/structure.json
# отредактируйте под свой сервер — роли/каналы/права

docker compose up -d
docker compose logs -f
```

Веб-панель: http://127.0.0.1:8787 (слушает только localhost — без авторизации,
доступ не выходит за пределы этого компьютера).

Зарегистрировать слэш-команды в Discord:
```bash
docker compose exec discord-bot bun run src/deploy-commands.js
```

---

## ⚙️ Требования

- Docker (Docker Desktop на Windows/macOS, Docker Engine на Linux)
- Токен бота и Application ID из [Discord Developer Portal](https://discord.com/developers/applications)

---

## 🔧 Конфигурация

### `.env`
```bash
DISCORD_TOKEN=   # обязательно — Bot Token из Developer Portal
CLIENT_ID=       # обязательно — Application ID
GUILD_ID=        # опционально — для мгновенной регистрации команд на одном сервере
WEB_PORT=8787    # опционально
```

### `config/structure.json`
Не коммитится в репозиторий (см. `.gitignore`) — это конфигурация конкретного
Discord-сервера. Шаблон лежит в `config/structure.example.json`, скопируйте его
и отредактируйте под себя:
- `roles` — роли с цветом/правами/hoist
- `categories`, `channels` — категории и каналы с оверрайтами прав
- `musicAllowedRoles` — кому доступны музыкальные команды
- `globalDenyRoles` / `alwaysAllRoles` — права, применяемые на все каналы сразу
- `isolationRoles` — роли-изоляторы (например, "тюрьма"): доступ только к whitelisted каналам
- `protectedChannels` — каналы, которые `/setup wipe` не тронет

### `config/rules.md`
Текст правил сервера, публикуется командой `/rules post`.

---

## 📋 Команды

### Docker
```bash
docker compose up -d         # запустить
docker compose down          # остановить и удалить контейнер
docker compose logs -f       # логи в реальном времени
docker compose restart       # перезапуск
docker compose build --no-cache && docker compose up -d   # пересборка после обновления кода
```

### Discord (слэш-команды)
```
/play <трек, запрос или плейлист>    /skip    /pause    /resume    /stop
/queue                        /nowplaying         /volume <0-200>
/setup build                  создать структуру сервера из конфига
/setup export                 выгрузить текущую структуру сервера в конфиг
/setup validate                офлайн-проверка конфига
/setup wipe                   удалить всё, кроме protectedChannels
/rules post                    опубликовать правила
```

`/play` принимает обычную ссылку на YouTube-плейлист, параметр `list=...`
или ID плейлиста и добавляет до 500 доступных роликов в очередь по порядку.
Динамические YouTube Mix (`list=RD...`) сохраняют исходный `v=...` либо
восстанавливают seed-видео из ID, после чего также разбиваются на треки.
Веб-панель обновляет музыкальный прогресс каждую секунду и показывает
прошедшее/оставшееся время, буфер, состояния плеера и voice-соединения,
а также стабильность воспроизведения по последним 30 секундным замерам.

---

## 📁 Структура проекта

```
discord-bot/
├── src/
│   ├── index.js              # точка входа, обработчики событий
│   ├── commandLoader.js
│   ├── db.js                 # SQLite: история сообщений, статистика
│   ├── structureManager.js   # применение config/structure.json к серверу
│   ├── commands/              # слэш-команды (music, rules, setup)
│   ├── music/
│   │   ├── queue.js           # очередь, воспроизведение, статистика буфера
│   │   ├── source.js          # yt-dlp + ffmpeg + кэш на диске
│   │   └── persistence.js     # сохранение/восстановление очереди
│   └── web/
│       ├── server.js          # REST API (Bun.serve)
│       └── public/            # веб-панель (HTML/CSS/JS)
├── config/
│   ├── structure.example.json # шаблон — коммитится
│   ├── structure.json         # реальный конфиг сервера — НЕ коммитится
│   └── rules.md
├── data/                       # SQLite, кэш аудио, лог — НЕ коммитится
├── scripts/                    # init-скрипты, systemd unit
├── Dockerfile
└── docker-compose.yml
```

---

## 🐛 Диагностика

**Бот не стартует** — `docker compose logs`, проверить `DISCORD_TOKEN`/`CLIENT_ID` в `.env`.

**Музыка не играет** — `docker compose logs | grep -iE "yt-dlp|ffmpeg|cache"`. Частые причины:
отсутствие интернета у контейнера, устаревший кэш (можно почистить `data/cache/audio/`).

**Веб-панель не открывается** — проверить `docker compose ps` (контейнер должен быть `Up`),
`curl http://127.0.0.1:8787/health`.

**Порт 8787 занят** — сменить `WEB_PORT` в `.env`, `docker compose up -d`.

---

## 🔒 Безопасность

- Веб-панель слушает `0.0.0.0` внутри контейнера, но наружу пробрасывается только
  на `127.0.0.1` хоста (см. `docker-compose.yml`) — без авторизации, не открывать
  в интернет/локальную сеть без дополнительной защиты.
- `.env` и `config/structure.json` не коммитятся — в первом токены, во втором
  конфигурация конкретного вашего сервера.
- `data/` (история сообщений, кэш аудио, логи) не коммитится.

---

## 📝 Лицензия

Проект предоставляется как есть, для управления собственным Discord-сервером.
