require("dotenv").config();

const express = require("express");
const { nanoid } = require("nanoid");
const crypto = require("crypto");
const { MongoClient } = require("mongodb");
const http = require("http");
const { WebSocketServer } = require("ws");

const app = express();
app.use(express.json());

// При экспорте server напрямую Vercel может принять запрос до завершения init().
// Чтобы избежать db is undefined, добавлен асинхронный guard-middleware.
app.use(async (req, res, next) => {
  try {
    await init();
    next();
  } catch (err) {
    console.error("Init wait failed:", err);
    res.status(503).json({ error: "Service initializing, retry" });
  }
});

const hash = (password) => crypto.createHash("sha256").update(password).digest("hex");

let db;
let client;

// ---------- HTTP middleware ----------
app.use(async (req, res, next) => {
  let sessionId = null;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) sessionId = authHeader.slice(7).trim();
  if (!sessionId && req.headers["x-session-id"]) sessionId = req.headers["x-session-id"];
  if (!sessionId && req.query.sessionId) sessionId = req.query.sessionId;

  if (sessionId) {
    try {
      const session = await db.collection("timer_sessions").findOne({ sessionId });
      if (session) {
        const user = await db.collection("timer_users").findOne({ _id: session.userId });
        if (user) req.user = user;
      }
    } catch (err) {
      console.error("Auth middleware error:", err);
    }
  }
  next();
});

const auth = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  next();
};

// ---------- WebSocket: реестр подключений ----------
/** Map<userId, Set<WebSocket>> */
const wsClients = new Map();

function addWsClient(userId, ws) {
  if (!wsClients.has(userId)) wsClients.set(userId, new Set());
  wsClients.get(userId).add(ws);
}

function removeWsClient(userId, ws) {
  const set = wsClients.get(userId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) wsClients.delete(userId);
}

function sendToUser(userId, payload) {
  const set = wsClients.get(userId);
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

// ---------- Формирование payloads ----------
async function buildAllTimers(userId) {
  const timers = await db.collection("timers").find({ userId }).toArray();
  return timers.map((t) => ({
    ...t,
    progress: t.isActive ? Date.now() - t.start : t.duration || 0,
  }));
}

async function buildActiveTimers(userId) {
  const timers = await db.collection("timers").find({ userId, isActive: true }).toArray();
  return timers.map((t) => ({ ...t, progress: Date.now() - t.start }));
}

async function broadcastAllTimers(userId) {
  const all = await buildAllTimers(userId);
  sendToUser(userId, { type: "all_timers", timers: all });
}

// ---------- REST-эндпоинты (+ broadcast) ----------
app.post("/signup", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "username and password are required" });

    const existing = await db.collection("timer_users").findOne({ username });
    if (existing) return res.status(400).json({ error: "User already exists" });

    const newUser = { _id: nanoid(), username, password: hash(password) };
    await db.collection("timer_users").insertOne(newUser);

    const sessionId = nanoid();
    await db.collection("timer_sessions").insertOne({ sessionId, userId: newUser._id });
    res.json({ sessionId });
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "username and password are required" });

    const user = await db.collection("timer_users").findOne({ username });
    if (!user || user.password !== hash(password)) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    let session = await db.collection("timer_sessions").findOne({ userId: user._id });
    let sessionId;
    if (session) {
      sessionId = session.sessionId;
    } else {
      sessionId = nanoid();
      await db.collection("timer_sessions").insertOne({ sessionId, userId: user._id });
    }
    res.json({ sessionId });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.get("/logout", async (req, res) => {
  try {
    let sessionId = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) sessionId = authHeader.slice(7).trim();
    if (!sessionId && req.headers["x-session-id"]) sessionId = req.headers["x-session-id"];
    if (!sessionId && req.query.sessionId) sessionId = req.query.sessionId;

    if (sessionId) {
      const session = await db.collection("timer_sessions").findOne({ sessionId });
      await db.collection("timer_sessions").deleteOne({ sessionId });
      if (session) {
        const set = wsClients.get(session.userId);
        if (set) for (const ws of set) ws.close(1000, "logout");
        wsClients.delete(session.userId);
      }
    }
  } catch (err) {
    console.error("Logout error:", err);
  }
  res.json({});
});

app.get("/api/timers", auth, async (req, res) => {
  try {
    const { isActive } = req.query;
    const isActiveBool = isActive === "true";
    const userId = req.user._id;
    const timers = await db.collection("timers").find({ userId, isActive: isActiveBool }).toArray();
    const result = timers.map((t) => (t.isActive ? { ...t, progress: Date.now() - t.start } : t));
    res.json(result);
  } catch (err) {
    console.error("GET /api/timers error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.post("/api/timers", auth, async (req, res) => {
  try {
    const { description } = req.body;
    if (!description) return res.status(400).json({ error: "Description is required" });

    const newTimer = {
      id: nanoid(),
      userId: req.user._id,
      start: Date.now(),
      description,
      isActive: true,
    };
    await db.collection("timers").insertOne(newTimer);

    broadcastAllTimers(req.user._id).catch((e) => console.error("broadcast all:", e));

    res.status(201).json(newTimer);
  } catch (err) {
    console.error("POST /api/timers error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.post("/api/timers/:id/stop", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id;

    const timer = await db.collection("timers").findOne({ id });
    if (!timer) return res.status(404).json({ error: "Timer not found" });
    if (timer.userId !== userId) return res.status(403).json({ error: "Forbidden" });
    if (!timer.isActive) return res.status(400).json({ error: "Timer is already stopped" });

    const end = Date.now();
    await db.collection("timers").updateOne({ id }, { $set: { end, duration: end - timer.start, isActive: false } });

    broadcastAllTimers(userId).catch((e) => console.error("broadcast all:", e));

    res.sendStatus(204);
  } catch (err) {
    console.error("POST /api/timers/:id/stop error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ---------- HTTP server + WebSocketServer (создаются сразу) ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", async (ws, req) => {
  try {
    await init(); // гарантия готовности db
    const url = new URL(req.url, `http://${req.headers.host}`);
    const sessionId = url.searchParams.get("sessionId");

    if (!sessionId) {
      ws.close(4001, "No sessionId");
      return;
    }

    const session = await db.collection("timer_sessions").findOne({ sessionId });
    if (!session) {
      ws.close(4002, "Invalid session");
      return;
    }

    const userId = session.userId;
    ws._userId = userId;
    addWsClient(userId, ws);
    console.log(`WS connected: user=${userId}`);

    ws.on("close", () => {
      removeWsClient(userId, ws);
      console.log(`WS closed: user=${userId}`);
    });

    ws.on("error", (err) => console.error("WS error:", err));

    const all = await buildAllTimers(userId);
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "all_timers", timers: all }));
    }
  } catch (err) {
    console.error("WS connection error:", err);
    try {
      ws.close(1011, "internal error");
    } catch {
      /* ignore */
    }
  }
});

// ---------- Инициализация (MongoDB, миграции, admin, интервал) ----------
let initPromise = null;

async function init() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    client = new MongoClient(process.env.DB_URI || "mongodb://localhost:27017");
    await client.connect();
    db = client.db("sample_mflix");
    console.log("Connected to MongoDB (sample_mflix)");

    const existingAdmin = await db.collection("timer_users").findOne({ username: "admin" });
    if (!existingAdmin) {
      await db.collection("timer_users").insertOne({
        _id: nanoid(),
        username: "admin",
        password: hash("pwd007"),
      });
      console.log("Admin user created");
    }

    // Каждую секунду: active_timers каждому клиенту
    setInterval(async () => {
      if (wsClients.size === 0) return;
      for (const userId of wsClients.keys()) {
        try {
          const active = await buildActiveTimers(userId);
          sendToUser(userId, { type: "active_timers", timers: active });
        } catch (err) {
          console.error("broadcast active error:", err);
        }
      }
    }, 1000);
  })();

  return initPromise;
}

// ---------- Экспорт для Vercel ----------
// Vercel вызывает модуль при каждом запросе (но кэширует загрузку модуля в рамках экземпляра функции).
// Экспортируем HTTP-сервер напрямую — он обработает и HTTP-запросы, и WebSocket upgrade.
module.exports = server;

// ---------- Локальный запуск ----------
if (require.main === module) {
  init()
    .then(() => {
      const port = process.env.PORT || 3000;
      server.listen(port, () => {
        console.log(`  Listening on http://localhost:${port}`);
        console.log(`  WebSocket on ws://localhost:${port}/ws?sessionId=<sid>`);
      });
    })
    .catch((err) => {
      console.error("Failed to start server:", err);
      process.exit(1);
    });
} else {
  // На Vercel: инициализация запускается при загрузке модуля.
  // Vercel дождётся завершения promise, если функция экспортирует асинхронный обработчик, но при экспорте server напрямую запросы могут прийти до готовности db.
  // Поэтому middleware ждёт initPromise.
  init().catch((err) => console.error("Vercel init failed:", err));
}
