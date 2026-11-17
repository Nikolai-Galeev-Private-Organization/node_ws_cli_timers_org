# Timers Server (MongoDB, CLI + WebSocket)

Серверная часть учебного приложения «Таймеры» на Express + MongoDB с поддержкой WebSocket.  
Адаптирована под работу с CLI-клиентом: **без HTML-рендеринга, без cookies**, обмен данными — только JSON (HTTP) и JSON-сообщения (WS).

## Отличия от веб-версии

- Удалены `nunjucks`, `cookie-parser`, `views/`, `public/`.
- Удалён маршрут `GET /` (главная HTML-страница).
- Middleware авторизации читает `sessionId` **не из cookies**, а из:
  1. заголовка `Authorization: Bearer <sessionId>`,
  2. заголовка `X-Session-Id`,
  3. GET-параметра `?sessionId=...`.
- `/signup`, `/login`, `/logout` возвращают **JSON** вместо редиректов и `Set-Cookie`.
- Добавлен **WebSocket-сервер** на том же HTTP-порту по пути `/ws`.
- Аутентификация WS — метод **передачи токена в сокетах** (sessionId в query-параметре `?sessionId=...`).

## Запуск

```bash
npm install
npm start        # migrate-mongo up + node index.js
npm run dev      # migrate-mongo up + nodemon index.js
npm run migrate  # только миграции
```

HTTP-сервер: http://localhost:3000  
WebSocket: `ws://localhost:3000/ws?sessionId=<sid>`

### Переменные окружения

Создайте `.env` в корне `server/` на основе `.env-sample`:

```
DB_URI="mongodb+srv://<user>:<password>@<cluster>.mongodb.net/?retryWrites=true&w=majority&authSource=admin"
PORT=3000
```

Имя базы в строке подключения можно не указывать — приложение и миграции явно используют `sample_mflix`.

## Тестовый пользователь

При старте сервера, если его нет, создаётся:

| username | password |
| -------- | -------- |
| `admin`  | `pwd007` |

Пароль хранится в виде SHA-256 хеша (встроенный `crypto`).

## Хранение данных (MongoDB, база `sample_mflix`)

| Коллекция        | Назначение                     | Документ                                                        |
| ---------------- | ------------------------------ | --------------------------------------------------------------- |
| `timer_users`    | Пользователи                   | `{ _id, username, password (hash) }`                            |
| `timer_sessions` | Активные сессии                | `{ sessionId, userId }`                                         |
| `timers`         | Таймеры                        | `{ id, userId, start, end?, duration?, description, isActive }` |
| `changelog`      | История миграций migrate-mongo | создаётся автоматически                                         |

### Миграции

```bash
npm run migrate
```

Запускаются автоматически перед стартом сервера.

- `20261030115246-create-timer-collections.js` — создаёт коллекции и индексы:
  - `timer_users.username` — unique;
  - `timer_sessions.sessionId` — unique;
  - `timer_sessions.userId` — unique;
  - `timers.{ userId, isActive }` — составной.
- `20261120100000-timers-id-index.js` — уникальный индекс на `timers.id` (для быстрого поиска по публичному ID).

## Аутентификация (HTTP)

- `/signup` и `/login` возвращают `{ "sessionId": "..." }`. Клиент сам решает, где хранить этот токен.
- При успешном логине: если у пользователя уже есть сессия в `timer_sessions` — она переиспользуется.
- Middleware проверки сессии кладёт найденного пользователя в `req.user`.
- Middleware `auth` защищает `/api/timers*`: без активной сессии → `401 Unauthorized`.
- Все таймеры содержат `userId`; пользователь видит и останавливает только свои.

## REST API

Все защищённые эндпоинты принимают `sessionId` одним из трёх способов:

```
Authorization: Bearer <sessionId>
X-Session-Id: <sessionId>
?sessionId=<sessionId>
```

| Метод  | URL                          | Auth | Назначение                                   |
| ------ | ---------------------------- | ---- | -------------------------------------------- |
| `POST` | `/signup`                    | —    | Регистрация, `{ username, password }`        |
| `POST` | `/login`                     | —    | Логин, `{ username, password }`              |
| `GET`  | `/logout`                    | —    | Удаление сессии (и закрытие WS пользователя) |
| `GET`  | `/api/timers?isActive=true`  | ✅   | Активные таймеры текущего пользователя       |
| `GET`  | `/api/timers?isActive=false` | ✅   | Завершённые таймеры текущего пользователя    |
| `POST` | `/api/timers`                | ✅   | Создать таймер, `{ description }`            |
| `POST` | `/api/timers/:id/stop`       | ✅   | Остановить свой таймер                       |

> ✅ — требуется активная сессия.

### `POST /signup`

**Body:** `{ "username": "newuser", "password": "secret123" }`

**200 OK:** `{ "sessionId": "..." }`  
**400 Bad Request:** `{ "error": "username and password are required" }` / `{ "error": "User already exists" }`

### `POST /login`

**Body:** `{ "username": "admin", "password": "pwd007" }`

**200 OK:** `{ "sessionId": "..." }`  
**401 Unauthorized:** `{ "error": "Invalid username or password" }`

### `GET /logout`

Читает `sessionId` из заголовка или `?sessionId=`. Удаляет запись из `timer_sessions` и **закрывает WS-соединения** этого пользователя (код `1000`, reason `logout`).

**200 OK:** `{}`

### `GET /api/timers?isActive=true`

Возвращает массив активных таймеров с полем `progress = Date.now() - start`.

```json
[
  {
    "id": "abc123",
    "userId": "user-id",
    "start": 1700000000000,
    "description": "Timer 1",
    "isActive": true,
    "progress": 5234
  }
]
```

### `GET /api/timers?isActive=false`

Возвращает завершённые таймеры с полями `end`, `duration`.

### `POST /api/timers`

**Body:** `{ "description": "My timer" }`  
**201 Created:** `{ id, userId, start, description, isActive: true }`  
**400 Bad Request:** `{ "error": "Description is required" }`

После успешного создания сервер **отправляет `all_timers`** по WS этому пользователю.

### `POST /api/timers/:id/stop`

| Ситуация       | Код | Тело                                      |
| -------------- | --- | ----------------------------------------- |
| Успех          | 204 | —                                         |
| Не авторизован | 401 | `{ "error": "Unauthorized" }`             |
| Не найден      | 404 | `{ "error": "Timer not found" }`          |
| Чужой таймер   | 403 | `{ "error": "Forbidden" }`                |
| Уже остановлен | 400 | `{ "error": "Timer is already stopped" }` |

После успешной остановки сервер **отправляет `all_timers`** по WS этому пользователю.

## WebSocket API

### Подключение и аутентификация

WebSocket-сервер поднимается на том же HTTP-сервере (`new WebSocketServer({ server, path: "/ws" })`).

Аутентификация — **метод передачи токена в сокетах**: `sessionId` передаётся в query-параметре при подключении.

```js
const ws = new WebSocket(`ws://localhost:3000/ws?sessionId=${sessionId}`);
```

Если `sessionId` отсутствует или не найден в `timer_sessions`, сервер закрывает соединение:

| Код  | Reason            |
| ---- | ----------------- |
| 4001 | `No sessionId`    |
| 4002 | `Invalid session` |
| 1000 | `logout`          |
| 1011 | `internal error`  |

После успешной аутентификации сервер регистрирует соединение в реестре:

```js
const wsClients = new Map(); // Map<userId, Set<WebSocket>>
```

Один пользователь может иметь несколько WS-соединений (например, несколько CLI-клиентов) — все они получают одинаковые сообщения.

### Сообщения сервер → клиент

Все сообщения — JSON-объекты с полем `type`.

#### `all_timers`

Сервер отправляет **один раз сразу после подключения**, а также **после каждой операции создания и остановки таймера**. Содержит все таймеры пользователя — активные и завершённые.

```json
{
  "type": "all_timers",
  "timers": [
    {
      "id": "abc123",
      "userId": "user-id",
      "start": 1700000000000,
      "description": "Task A",
      "isActive": true,
      "progress": 12345
    },
    {
      "id": "def456",
      "userId": "user-id",
      "start": 1699999000000,
      "end": 1699999500000,
      "duration": 500000,
      "description": "Task B",
      "isActive": false,
      "progress": 500000
    }
  ]
}
```

- Для активных: `progress = Date.now() - start`.
- Для завершённых: `progress = duration`.

#### `active_timers`

Сервер отправляет **каждую секунду** каждому подключённому пользователю. Содержит только активные таймеры этого пользователя с рассчитанным `progress`.

```json
{
  "type": "active_timers",
  "timers": [
    {
      "id": "abc123",
      "userId": "user-id",
      "start": 1700000000000,
      "description": "Task A",
      "isActive": true,
      "progress": 12345
    }
  ]
}
```

> Broadcast'ы изолированы по `userId`: пользователь получает только свои таймеры.

### Сообщения клиент → сервер

В текущей реализации **не используются** — все операции (`start`, `stop`) выполняются через REST, WS — только для нотификаций. Это допустимый вариант по заданию.

## Быстрая проверка (PowerShell)

```powershell
# Логин
$login = Invoke-RestMethod -Uri "http://localhost:3000/login" `
  -Method Post -ContentType "application/json" `
  -Body '{"username":"admin","password":"pwd007"}'
$sid = $login.sessionId

# Создать таймер
$timer = Invoke-RestMethod -Uri "http://localhost:3000/api/timers" `
  -Method Post -ContentType "application/json" `
  -Headers @{ "X-Session-Id" = $sid } `
  -Body '{"description":"smoke test"}'

# Активные
Invoke-RestMethod -Uri "http://localhost:3000/api/timers?isActive=true&sessionId=$sid"

# Остановить
Invoke-RestMethod -Uri "http://localhost:3000/api/timers/$($timer.id)/stop" `
  -Method Post -Headers @{ "X-Session-Id" = $sid }

# Логаут
Invoke-RestMethod -Uri "http://localhost:3000/logout?sessionId=$sid"
```

## Проверка WebSocket (Node.js one-liner)

```bash
node -e "
const WebSocket = require('ws');
const sid = process.argv[1];
const ws = new WebSocket('ws://localhost:3000/ws?sessionId=' + sid);
ws.on('open', () => console.log('[ws] connected'));
ws.on('message', (m) => { const o = JSON.parse(m); console.log('[ws]', o.type, o.timers.length); });
ws.on('close', (code, reason) => console.log('[ws] closed', code, reason.toString()));
setTimeout(() => process.exit(0), 5000);
" "$YOUR_SESSION_ID"
```

Ожидаемый вывод: `connected`, затем `all_timers N`, затем несколько `active_timers M` раз в секунду.

## Проверка «с нуля» (пустая БД)

1. Удалите базу `sample_mflix` в Compass.
2. Запустите `npm start`.
3. В логах:

   ```
   MIGRATED UP: 20261030115246-create-timer-collections.js
   MIGRATED UP: 20261120100000-timers-id-index.js
   Connected to MongoDB (sample_mflix)
   Admin user created
     Listening on http://localhost:3000
     WebSocket on ws://localhost:3000/ws?sessionId=<sid>
   ```

4. В Compass появятся коллекции `timer_users`, `timer_sessions`, `timers`, `changelog` и пользователь `admin`.

## Заметки по зависимостям

- `ws@8` — WebSocket-сервер (используется и на сервере, и в CLI-клиенте).
- `eslint@8` — последняя ветка, совместимая с `@babel/eslint-parser@7` и `eslint-plugin-*@27/11/5`. Переход на `eslint@9` требует flat-конфига и не нужен в учебных целях.
- `nodemon@3`, `prettier@3`, `@babel/core@7` — актуальные стабильные.
- `npm audit` показывает **moderate** в dev-зависимостях `eslint` (`ajv`, `glob`, `minimatch`). Они не участвуют в рантайме сервера и не влияют на работоспособность.
- `migrate-mongo@14` требует **Node.js ≥ 20**.
