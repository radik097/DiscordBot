# Cloudflare Zero Trust Tunnel

Ниже описана рекомендуемая схема для постоянного доступа к DiscordBot через
Cloudflare Zero Trust без публикации порта `8787` в интернет.

## Какая схема нужна

Для `/get-url`, Cloudflare OTP и постоянных email-аккаунтов используется
следующая цепочка:

```text
Телефон или ПК
  -> Cloudflare Access
  -> Cloudflare Tunnel
  -> cloudflared
  -> DockerHub gateway:4180
  -> host.docker.internal:8787
  -> DiscordBot
```

`cloudflared` должен направлять hostname на `http://gateway:4180`, а не прямо
на `discord-bot:8787`. Gateway проверяет подписанный Cloudflare Access JWT,
удаляет любые подставленные клиентом identity-заголовки и создаёт новую
HMAC-подпись подтверждённой почты для DiscordBot.

Прямой маршрут `cloudflared -> discord-bot:8787` подходит только для
упрощённого standalone-доступа и `/phone`. Он не преобразует Cloudflare JWT в
подписанную identity-схему DiscordBot, поэтому email-приглашения в такой
конфигурации работать не будут.

## Требования

- домен добавлен в Cloudflare и использует Cloudflare DNS;
- Docker Desktop или Docker Engine уже запускает DiscordBot и DockerHub
  gateway;
- исходящие соединения к Cloudflare разрешены; при строгом firewall проверьте
  доступ к порту `7844`;
- подготовлен длинный случайный `SESSION_SECRET` не короче 32 символов;
- реальные токены и секреты записываются только в локальные `.env` и никогда
  не коммитятся.

Cloudflare рекомендует remotely-managed tunnel для большинства установок: его
конфигурация хранится в Zero Trust и может изменяться из Dashboard, API или
Terraform.

## 1. Создать named tunnel

1. Откройте Cloudflare Dashboard.
2. Перейдите в **Networking -> Tunnels**.
3. Нажмите **Create a tunnel**, выберите `cloudflared` и задайте понятное имя,
   например `private-docker-hub`.
4. Выберите Docker и скопируйте только значение после `--token`. Это секрет
   туннеля: любой, кто получил его, сможет запустить connector этого tunnel.
5. Пока не запускайте вторую копию `cloudflared`, если connector уже работает.

Официальная инструкция: [Create a tunnel (dashboard)](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/).

## 2. Добавить published hostname

В настройках созданного tunnel добавьте published application route:

| Поле | Значение |
| --- | --- |
| Subdomain | `discord` |
| Domain | ваш домен, например `example.com` |
| Path | пусто |
| Service type | `HTTP` |
| URL | `gateway:4180` |

Итоговый адрес будет выглядеть как `https://discord.example.com`. Для текущей
установки используется `https://discord.llmtechspec.xyz`.

Важно:

- указывайте `http://gateway:4180`, а не `localhost:4180`: внутри контейнера
  `localhost` означает сам контейнер `cloudflared`;
- не задавайте ручной HTTP Host header — gateway маршрутизирует проект по
  исходному публичному hostname;
- если Cloudflare сообщает о существующей записи A, AAAA или CNAME, удалите
  конфликтующую DNS-запись либо выберите другой hostname;
- порт `8787` должен оставаться опубликованным только на `127.0.0.1`.

О маршрутизации published applications:
[Cloudflare Tunnel routes](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/).

## 3. Включить One-time PIN

1. Откройте **Zero Trust -> Integrations -> Identity providers**.
2. Нажмите **Add new identity provider**.
3. Выберите **One-time PIN** и сохраните.

Cloudflare отправляет PIN только адресам, разрешённым Access-политикой. PIN
одноразовый, а запрос нового кода аннулирует предыдущий.

Официальная инструкция: [One-time PIN login](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/).

## 4. Создать Access application для приглашений

Создайте **Self-hosted application**, защищающую только путь приглашений:

```text
discord.example.com/access/invite*
```

Рекомендуемые параметры:

- имя: `DiscordBot email invites`;
- Session duration: не более `24 hours`;
- Allow policy для адресов, которым разрешено получать приглашения;
- если `/get-url` должен принимать произвольную почту, политика может требовать
  login method `One-time PIN`, но приложение обязательно должно оставаться
  ограниченным путём `/access/invite*`.

Не создавайте правило `Include Everyone` и не защищайте этой гостевой политикой
весь `discord.example.com`. Селектор только по login method `One-time PIN`
пропускает любого владельца действующей почты; безопасность invitation flow
дополнительно обеспечивают одноразовый token, точное совпадение email и проверка
подписи gateway.

После сохранения приложения скопируйте его **Application Audience (AUD)**. Он
нужен gateway для проверки `cf-access-jwt-assertion`.

Справка по политикам: [Cloudflare Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/).

## 5. Настроить DockerHub gateway

В локальном `D:\DockerHub\.env` задайте:

```env
PUBLIC_BASE_DOMAIN=example.com
TUNNEL_TOKEN=<token named tunnel>

AUTH_REQUIRED=true
ALLOWED_EMAIL=owner@example.com
SESSION_SECRET=<random secret, at least 32 characters>

CLOUDFLARE_ACCESS_ISSUER=https://your-team.cloudflareaccess.com
CLOUDFLARE_ACCESS_AUD=<AUD owner/hub Access application>
CLOUDFLARE_PROJECT_ACCESS_AUD=<AUD DiscordBot email-invite application>
```

`CLOUDFLARE_ACCESS_ISSUER` — адрес вашей Zero Trust team без завершающего `/`.
`CLOUDFLARE_PROJECT_ACCESS_AUD` должен относиться именно к приложению
`discord.example.com/access/invite*`.

Сначала проверьте tunnel и обе Access application. `AUTH_REQUIRED=true`
включайте последним: при неполной конфигурации gateway намеренно отказывает в
доступе.

Запуск:

```powershell
Set-Location D:\DockerHub
docker compose --profile tunnel up -d --build --wait
docker compose --profile tunnel ps
docker logs --tail 100 private-docker-hub-cloudflared
```

В этой схеме token хранится как `TUNNEL_TOKEN` в DockerHub. Не дублируйте его в
репозитории DiscordBot и не запускайте профиль `server` DiscordBot: второй
connector для того же маршрута не нужен.

## 6. Настроить DiscordBot

В локальном `.env` DiscordBot:

```env
WEB_BIND_ADDRESS=127.0.0.1
WEB_PORT=8787

DEPLOYMENT_MODE=server
REMOTE_ACCESS_PROVIDER=cloudflare
PUBLIC_BASE_URL=https://discord.example.com
ACCESS_PUBLIC_BASE_URL=https://discord.example.com
ACCESS_OWNER_EMAIL=owner@example.com

# Точно то же значение, что SESSION_SECRET у DockerHub gateway.
PROJECT_IDENTITY_SECRET=<same secret as gateway SESSION_SECRET>

# Shared tunnel уже запущен в DockerHub, поэтому без профиля server.
COMPOSE_PROFILES=pot
```

`PROJECT_IDENTITY_SECRET` и `SESSION_SECRET` должны совпадать побайтно. Секрет
используется только между gateway и DiscordBot и не передаётся браузеру.

Запуск DiscordBot:

```powershell
docker compose up -d --build discord-bot
docker compose exec -T discord-bot bun run src/deploy-commands.js
```

Если стабильный Cloudflare URL нужен только для email-входа, а `/phone` должен
по-прежнему создавать ngrok-ссылки, оставьте `DEPLOYMENT_MODE=local` и
`REMOTE_ACCESS_PROVIDER=auto`. Tunnel через gateway продолжит работать.

## 7. Проверить подключение

```powershell
# DiscordBot доступен только локально.
Invoke-RestMethod http://127.0.0.1:8787/health

# Gateway работает.
Invoke-RestMethod http://127.0.0.1:4180/healthz

# Публичный маршрут отвечает через Cloudflare.
curl.exe -I https://discord.example.com/health
```

Затем выполните полный пользовательский сценарий:

1. Пользователь с ролью `Ботовод` запускает `/get-url email:user@example.com`.
2. Получатель открывает персональную ссылку.
3. Cloudflare отправляет OTP на ту же почту.
4. После OTP суточная ссылка сразу создаёт 24-часовую сессию; постоянная ссылка
   предлагает создать пароль.
5. Повторный вход постоянного пользователя выполняется на `/login` по email и
   паролю без passkey.

## Диагностика

| Симптом | Что проверить |
| --- | --- |
| Cloudflare `502` | Route должен вести на `http://gateway:4180`; gateway и `cloudflared` должны находиться в одной Docker network. |
| Tunnel `Down` | Валидность `TUNNEL_TOKEN`, исходящий порт `7844`, логи `private-docker-hub-cloudflared`. |
| OTP не приходит | Email должен совпадать с Access policy; новый PIN отменяет предыдущий; проверьте письма от `noreply@notify.cloudflare.com`. |
| «Подтверждённая почта не совпадает» | В Cloudflare Access выполнен вход под другим email, чем указан в `/get-url`. |
| «Запрос отклонён» после пароля | `ACCESS_PUBLIC_BASE_URL` должен точно совпадать с публичным origin; требуется DiscordBot `1.10.3` или новее. |
| `401` после перезапуска | Проверьте постоянные volumes `data`, одинаковый `PROJECT_IDENTITY_SECRET` и актуальные Access AUD/issuer. |
| DNS record already exists | Удалите конфликтующую A/AAAA/CNAME запись или используйте другой hostname. |

## Безопасность

- не публикуйте `4180` и `8787` на `0.0.0.0`;
- не коммитьте tunnel token, Discord token, `SESSION_SECRET`, AUD или session
  cookies;
- не используйте гостевую OTP-политику для `hub`, `ai`, `telegram` или всей
  панели DiscordBot;
- потерянный tunnel token нужно сменить в Cloudflare и локальном `.env`;
- tunnel создаёт только исходящие соединения, поэтому входящий порт на роутере
  или VPS открывать не требуется.

