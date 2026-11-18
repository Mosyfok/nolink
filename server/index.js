
require("dotenv").config();

const express = require("express");
const http = require("http");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");
const { randomUUID } = require("crypto");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT || 3030);
const SECRET = process.env.JWT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

if (!SECRET || SECRET.length < 24) {
  console.error("JWT_SECRET must contain at least 24 characters.");
  process.exit(1);
}

if (!DATABASE_URL) {
  console.error("DATABASE_URL is missing.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10
});

pool.on("error", (err) => {
  console.error("PostgreSQL connection error:", err.message);
});

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower
    ON users (LOWER(username));

    CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower
    ON users (LOWER(email));

    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('direct','group')),
      name TEXT,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS members (
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY(chat_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_chat_time
    ON messages(chat_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_members_user
    ON members(user_id);
  `);

  console.log("NOLINK PostgreSQL database is ready.");
}

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json({ limit: "32kb" }));

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: process.env.CORS_ORIGIN || "*" }
});

async function getUser(id) {
  const result = await pool.query(
    `SELECT id, username, email, created_at AS "createdAt"
     FROM users WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

async function isMember(chatId, userId) {
  const result = await pool.query(
    "SELECT 1 FROM members WHERE chat_id=$1 AND user_id=$2",
    [chatId, userId]
  );
  return result.rowCount > 0;
}

function auth(req, res, next) {
  (async () => {
    const raw = (req.headers.authorization || "")
      .replace(/^Bearer\s+/i, "");

    const payload = jwt.verify(raw, SECRET);
    const user = await getUser(payload.id);

    if (!user) {
      return res.status(401).json({ error: "Аккаунт не найден" });
    }

    req.user = user;
    next();
  })().catch(() => {
    res.status(401).json({ error: "Нужно войти в аккаунт" });
  });
}

function publicUser(user) {
  return { id: user.id, username: user.username };
}

async function chatPayload(chatId) {
  const chatResult = await pool.query(
    `SELECT id, type, name, created_at AS "createdAt"
     FROM chats WHERE id=$1`,
    [chatId]
  );

  const chat = chatResult.rows[0];
  if (!chat) return null;

  const [membersResult, lastResult] = await Promise.all([
    pool.query(
      `SELECT u.id, u.username
       FROM users u
       JOIN members m ON m.user_id=u.id
       WHERE m.chat_id=$1
       ORDER BY u.username`,
      [chatId]
    ),
    pool.query(
      `SELECT m.id, m.chat_id AS "chatId",
              m.user_id AS "userId", u.username,
              m.content, m.created_at AS "createdAt"
       FROM messages m
       JOIN users u ON u.id=m.user_id
       WHERE m.chat_id=$1
       ORDER BY m.created_at DESC
       LIMIT 1`,
      [chatId]
    )
  ]);

  return {
    ...chat,
    members: membersResult.rows,
    lastMessage: lastResult.rows[0] || null
  };
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, app: "NOLINK" });
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const { username, email, password } = req.body || {};

    if (
      typeof username !== "string" ||
      !/^[a-zA-Z0-9_]{3,20}$/.test(username)
    ) {
      return res.status(400).json({
        error: "Имя: 3–20 символов, латиница, цифры или _"
      });
    }

    if (
      typeof email !== "string" ||
      !/^.+@.+\..+$/.test(email) ||
      email.length > 254
    ) {
      return res.status(400).json({
        error: "Укажи корректную почту"
      });
    }

    if (
      typeof password !== "string" ||
      password.length < 8 ||
      password.length > 128
    ) {
      return res.status(400).json({
        error: "Пароль должен содержать от 8 до 128 символов"
      });
    }

    const id = randomUUID();
    const now = new Date();
    const hash = await bcrypt.hash(password, 12);

    await pool.query(
      `INSERT INTO users
       (id, username, email, password_hash, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, username, email, hash, now]
    );

    const user = await getUser(id);
    const token = jwt.sign({ id }, SECRET, { expiresIn: "30d" });

    res.status(201).json({ user, token });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({
        error: "Имя пользователя или почта уже заняты"
      });
    }

    console.error("Registration error:", err);
    res.status(500).json({ error: "Ошибка регистрации" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};

    const result = await pool.query(
      "SELECT * FROM users WHERE LOWER(email)=LOWER($1)",
      [String(email || "")]
    );

    const userRecord = result.rows[0];

    if (
      !userRecord ||
      !await bcrypt.compare(
        String(password || ""),
        userRecord.password_hash
      )
    ) {
      return res.status(401).json({
        error: "Неверная почта или пароль"
      });
    }

    const user = await getUser(userRecord.id);
    const token = jwt.sign(
      { id: userRecord.id },
      SECRET,
      { expiresIn: "30d" }
    );

    res.json({ user, token });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Ошибка входа" });
  }
});

app.get("/api/me", auth, (req, res) => {
  res.json({ user: req.user });
});

app.get("/api/users", auth, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim().slice(0, 30);

    if (q.length < 2) return res.json([]);

    const result = await pool.query(
      `SELECT id, username FROM users
       WHERE username ILIKE $1 AND id<>$2
       ORDER BY username LIMIT 20`,
      [`%${q}%`, req.user.id]
    );

    res.json(result.rows.map(publicUser));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Ошибка поиска" });
  }
});

app.get("/api/chats", auth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT chat_id FROM members WHERE user_id=$1",
      [req.user.id]
    );

    const chats = await Promise.all(
      result.rows.map(row => chatPayload(row.chat_id))
    );

    res.json(chats.filter(Boolean));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Ошибка загрузки чатов" });
  }
});

app.post("/api/chats/direct", auth, async (req, res) => {
  const client = await pool.connect();

  try {
    const otherResult = await client.query(
      "SELECT id FROM users WHERE id=$1",
      [String(req.body.userId || "")]
    );

    const other = otherResult.rows[0];

    if (!other || other.id === req.user.id) {
      return res.status(400).json({
        error: "Пользователь не найден"
      });
    }

    const existing = await client.query(
      `SELECT c.id FROM chats c
       JOIN members a ON a.chat_id=c.id AND a.user_id=$1
       JOIN members b ON b.chat_id=c.id AND b.user_id=$2
       WHERE c.type='direct' LIMIT 1`,
      [req.user.id, other.id]
    );

    if (existing.rows[0]) {
      const chat = await chatPayload(existing.rows[0].id);
      return res.json(chat);
    }

    const id = randomUUID();
    const now = new Date();

    await client.query("BEGIN");

    await client.query(
      "INSERT INTO chats(id,type,created_at) VALUES($1,'direct',$2)",
      [id, now]
    );

    await client.query(
      "INSERT INTO members(chat_id,user_id) VALUES($1,$2),($1,$3)",
      [id, req.user.id, other.id]
    );

    await client.query("COMMIT");

    res.status(201).json(await chatPayload(id));
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(err);
    res.status(500).json({ error: "Ошибка создания чата" });
  } finally {
    client.release();
  }
});

app.post("/api/chats/group", auth, async (req, res) => {
  const client = await pool.connect();

  try {
    const name = String(req.body.name || "").trim().slice(0, 60);
    const usernames = Array.isArray(req.body.usernames)
      ? req.body.usernames.slice(0, 49)
      : [];

    if (!name) {
      return res.status(400).json({
        error: "Укажи название группы"
      });
    }

    const found = [];

    for (const username of usernames) {
      const result = await client.query(
        "SELECT id FROM users WHERE LOWER(username)=LOWER($1)",
        [String(username)]
      );

      if (result.rows[0]) found.push(result.rows[0].id);
    }

    const unique = [...new Set([req.user.id, ...found])];

    if (unique.length < 2) {
      return res.status(400).json({
        error: "Добавь хотя бы одного зарегистрированного участника"
      });
    }

    const id = randomUUID();
    const now = new Date();

    await client.query("BEGIN");

    await client.query(
      "INSERT INTO chats(id,type,name,created_at) VALUES($1,'group',$2,$3)",
      [id, name, now]
    );

    for (const userId of unique) {
      await client.query(
        "INSERT INTO members(chat_id,user_id) VALUES($1,$2)",
        [id, userId]
      );
    }

    await client.query("COMMIT");

    res.status(201).json(await chatPayload(id));
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(err);
    res.status(500).json({ error: "Ошибка создания группы" });
  } finally {
    client.release();
  }
});

app.get("/api/chats/:id/messages", auth, async (req, res) => {
  try {
    if (!await isMember(req.params.id, req.user.id)) {
      return res.status(403).json({
        error: "Нет доступа к этому чату"
      });
    }

    const result = await pool.query(
      `SELECT m.id, m.chat_id AS "chatId",
              m.user_id AS "userId", u.username,
              m.content, m.created_at AS "createdAt"
       FROM messages m
       JOIN users u ON u.id=m.user_id
       WHERE m.chat_id=$1
       ORDER BY m.created_at DESC LIMIT 100`,
      [req.params.id]
    );

    res.json(result.rows.reverse());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Ошибка загрузки сообщений" });
  }
});

io.use(async (socket, next) => {
  try {
    const payload = jwt.verify(
      socket.handshake.auth?.token || "",
      SECRET
    );

    const user = await getUser(payload.id);

    if (!user) return next(new Error("Аккаунт не найден"));

    socket.user = user;
    next();
  } catch (err) {
    next(new Error("Требуется авторизация"));
  }
});

io.on("connection", socket => {
  socket.on("chat:join", async chatId => {
    try {
      if (
        typeof chatId === "string" &&
        await isMember(chatId, socket.user.id)
      ) {
        socket.join(chatId);
      }
    } catch (err) {
      console.error(err);
    }
  });

  socket.on("message:send", async (payload, ack) => {
    try {
      const chatId = String(payload?.chatId || "");
      const content = String(payload?.content || "").trim();

      if (!await isMember(chatId, socket.user.id)) {
        throw new Error("Нет доступа к чату");
      }

      if (!content || content.length > 4000) {
        throw new Error(
          "Сообщение должно содержать от 1 до 4000 символов"
        );
      }

      const msg = {
        id: randomUUID(),
        chatId,
        userId: socket.user.id,
        username: socket.user.username,
        content,
        createdAt: new Date()
      };

      await pool.query(
        `INSERT INTO messages
         (id,chat_id,user_id,content,created_at)
         VALUES($1,$2,$3,$4,$5)`,
        [
          msg.id,
          chatId,
          msg.userId,
          content,
          msg.createdAt
        ]
      );

      io.to(chatId).emit("message:new", msg);

      if (typeof ack === "function") ack(null);
    } catch (err) {
      if (typeof ack === "function") ack(err.message);
    }
  });
});

async function start() {
  try {
    await initializeDatabase();

    server.listen(PORT, "0.0.0.0", () => {
      console.log(`NOLINK server listening on port ${PORT}`);
    });
  } catch (err) {
    console.error("Could not start NOLINK:", err);
    process.exit(1);
  }
}

start();
