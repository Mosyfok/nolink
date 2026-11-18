
require("dotenv").config();

const express = require("express");
const http = require("http");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const { Server } = require("socket.io");
const {
  randomUUID,
  randomInt,
  createHash,
  timingSafeEqual
} = require("crypto");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT || 3030);
const SECRET = process.env.JWT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const CODE_LIFETIME_MINUTES = 10;
const CODE_RESEND_SECONDS = 60;
const MAX_CODE_ATTEMPTS = 5;

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

pool.on("error", err => {
  console.error("PostgreSQL connection error:", err.message);
});

// Gmail SMTP
function getMailer() {
  const user = process.env.MAIL_USER;
  const password = (process.env.MAIL_APP_PASSWORD || "")
    .replace(/\s/g, "");

  if (!user || !password) {
    throw new Error("Настройки Gmail не добавлены на сервере");
  }

  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
      user,
      pass: password
    },
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 20000
  });
}

async function sendVerificationEmail(email, code) {
  const mailer = getMailer();

  const from = process.env.MAIL_FROM || process.env.MAIL_USER;

  await mailer.sendMail({
    from: `NOLINK <${from}>`,
    to: email,
    subject: "Код подтверждения NOLINK",
    text:
      `Добро пожаловать в NOLINK!\n\n` +
      `Твой код подтверждения: ${code}\n\n` +
      `Код действует ${CODE_LIFETIME_MINUTES} минут.\n` +
      `Если ты не регистрировался в NOLINK, просто проигнорируй это письмо.`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#222">
        <h1 style="color:#5865f2">NOLINK</h1>
        <h2>Подтверждение электронной почты</h2>
        <p>Добро пожаловать в NOLINK!</p>
        <p>Твой код подтверждения:</p>
        <div style="font-size:32px;font-weight:bold;letter-spacing:8px;padding:16px 0">
          ${code}
        </div>
        <p>Код действует ${CODE_LIFETIME_MINUTES} минут.</p>
        <p style="color:#777;font-size:12px">
          Если ты не регистрировался в NOLINK, проигнорируй это письмо.
        </p>
      </div>
    `
  });
}

function makeCodeHash(email, code) {
  return createHash("sha256")
    .update(`${SECRET}:${email}:${code}`)
    .digest("hex");
}

function safeHashCompare(first, second) {
  const a = Buffer.from(first || "", "hex");
  const b = Buffer.from(second || "", "hex");

  return (
    a.length === 32 &&
    b.length === 32 &&
    timingSafeEqual(a, b)
  );
}

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );

    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS email_verified BOOLEAN
      NOT NULL DEFAULT FALSE;

    CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower
      ON users (LOWER(username));

    CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower
      ON users (LOWER(email));

    CREATE TABLE IF NOT EXISTS pending_registrations (
      email TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      last_sent_at TIMESTAMPTZ NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0
    );

    CREATE UNIQUE INDEX IF NOT EXISTS pending_username_lower
      ON pending_registrations (LOWER(username));

    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('direct', 'group')),
      name TEXT,
      created_at TIMESTAMPTZ NOT NULL
    );

    ALTER TABLE chats
      ADD COLUMN IF NOT EXISTS owner_id TEXT
      REFERENCES users(id) ON DELETE SET NULL;

    CREATE TABLE IF NOT EXISTS members (
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (chat_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      mime_type TEXT NOT NULL,
      filename TEXT NOT NULL,
      data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );

    ALTER TABLE messages
      ADD COLUMN IF NOT EXISTS attachment_id TEXT
      REFERENCES attachments(id) ON DELETE SET NULL;

    CREATE TABLE IF NOT EXISTS hidden_chats (
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      hidden_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (chat_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_chat_time
      ON messages(chat_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_members_user
      ON members(user_id);

    CREATE INDEX IF NOT EXISTS idx_attachments_chat
      ON attachments(chat_id);
  `);

  console.log("NOLINK PostgreSQL database is ready.");
}

const app = express();
const corsOrigin = process.env.CORS_ORIGIN || "*";

app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: "8mb" }));

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: corsOrigin }
});

async function getUser(id) {
  const result = await pool.query(
    `SELECT id, username, email,
            email_verified AS "emailVerified",
            created_at AS "createdAt"
     FROM users
     WHERE id = $1`,
    [id]
  );

  return result.rows[0] || null;
}

async function isMember(chatId, userId) {
  const result = await pool.query(
    "SELECT 1 FROM members WHERE chat_id = $1 AND user_id = $2",
    [chatId, userId]
  );

  return result.rowCount > 0;
}

function auth(req, res, next) {
  (async () => {
    const raw = (req.headers.authorization || "")
      .replace(/^Bearer\s+/i, "");

    if (!raw) {
      return res.status(401).json({
        error: "Нужно войти в аккаунт"
      });
    }

    const payload = jwt.verify(raw, SECRET);
    const user = await getUser(payload.id);

    if (!user) {
      return res.status(401).json({
        error: "Аккаунт не найден"
      });
    }

    req.user = user;
    next();
  })().catch(() => {
    if (!res.headersSent) {
      res.status(401).json({
        error: "Нужно войти в аккаунт"
      });
    }
  });
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username
  };
}

async function chatPayload(chatId) {
  const chatResult = await pool.query(
    `SELECT id, type, name, owner_id AS "ownerId",
            created_at AS "createdAt"
     FROM chats
     WHERE id = $1`,
    [chatId]
  );

  const chat = chatResult.rows[0];

  if (!chat) return null;

  const [membersResult, lastResult] = await Promise.all([
    pool.query(
      `SELECT u.id, u.username
       FROM users u
       JOIN members m ON m.user_id = u.id
       WHERE m.chat_id = $1
       ORDER BY u.username`,
      [chatId]
    ),

    pool.query(
      `SELECT m.id, m.chat_id AS "chatId",
              m.user_id AS "userId", u.username,
              m.content, m.attachment_id AS "attachmentId",
              m.created_at AS "createdAt"
       FROM messages m
       JOIN users u ON u.id = m.user_id
       WHERE m.chat_id = $1
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

// Начало регистрации: отправка кода
app.post("/api/auth/register", async (req, res) => {
  try {
    const { username, email, password } = req.body || {};

    if (
      typeof username !== "string" ||
      !/^[\p{L}\p{N}_]{3,20}$/u.test(username)
    ) {
      return res.status(400).json({
        error: "Имя: 3–20 символов, буквы, цифры или _"
      });
    }

    if (
      typeof email !== "string" ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
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

    const normalizedEmail = email.trim().toLowerCase();
    const normalizedUsername = username.trim();

    const existing = await pool.query(
      `SELECT id FROM users
       WHERE LOWER(email) = $1 OR LOWER(username) = LOWER($2)`,
      [normalizedEmail, normalizedUsername]
    );

    if (existing.rowCount > 0) {
      return res.status(409).json({
        error: "Имя пользователя или почта уже заняты"
      });
    }

    const pending = await pool.query(
      `SELECT email, last_sent_at
       FROM pending_registrations
       WHERE email = $1`,
      [normalizedEmail]
    );

    if (pending.rows[0]) {
      const elapsed =
        Date.now() - new Date(pending.rows[0].last_sent_at).getTime();

      if (elapsed < CODE_RESEND_SECONDS * 1000) {
        const wait = Math.ceil(
          (CODE_RESEND_SECONDS * 1000 - elapsed) / 1000
        );

        return res.status(429).json({
          error: `Подожди ${wait} сек. перед повторной отправкой кода`
        });
      }
    }

    const usernamePending = await pool.query(
      `SELECT email FROM pending_registrations
       WHERE LOWER(username) = LOWER($1) AND email <> $2`,
      [normalizedUsername, normalizedEmail]
    );

    if (usernamePending.rowCount > 0) {
      return res.status(409).json({
        error: "Это имя уже используется в другой регистрации"
      });
    }

    const code = String(randomInt(100000, 1000000));
    const passwordHash = await bcrypt.hash(password, 12);
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + CODE_LIFETIME_MINUTES * 60 * 1000
    );

    await pool.query(
      `INSERT INTO pending_registrations
       (email, username, password_hash, code_hash,
        expires_at, last_sent_at, attempts)
       VALUES ($1, $2, $3, $4, $5, $6, 0)
       ON CONFLICT (email)
       DO UPDATE SET
         username = EXCLUDED.username,
         password_hash = EXCLUDED.password_hash,
         code_hash = EXCLUDED.code_hash,
         expires_at = EXCLUDED.expires_at,
         last_sent_at = EXCLUDED.last_sent_at,
         attempts = 0`,
      [
        normalizedEmail,
        normalizedUsername,
        passwordHash,
        makeCodeHash(normalizedEmail, code),
        expiresAt,
        now
      ]
    );

    try {
      await sendVerificationEmail(normalizedEmail, code);
    } catch (mailError) {
      await pool.query(
        "DELETE FROM pending_registrations WHERE email = $1",
        [normalizedEmail]
      );

      console.error("Email sending error:", mailError.message);

      return res.status(503).json({
        error: "Не удалось отправить письмо. Проверь настройки Gmail на сервере."
      });
    }

    res.status(200).json({
      ok: true,
      verificationRequired: true,
      email: normalizedEmail,
      message: "Код подтверждения отправлен на почту"
    });
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

// Повторная отправка кода
app.post("/api/auth/resend-code", async (req, res) => {
  try {
    const email = String(req.body?.email || "")
      .trim()
      .toLowerCase();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({
        error: "Укажи корректную почту"
      });
    }

    const result = await pool.query(
      `SELECT email, last_sent_at
       FROM pending_registrations
       WHERE email = $1`,
      [email]
    );

    const pending = result.rows[0];

    if (!pending) {
      return res.status(400).json({
        error: "Сначала начни регистрацию заново"
      });
    }

    const elapsed =
      Date.now() - new Date(pending.last_sent_at).getTime();

    if (elapsed < CODE_RESEND_SECONDS * 1000) {
      const wait = Math.ceil(
        (CODE_RESEND_SECONDS * 1000 - elapsed) / 1000
      );

      return res.status(429).json({
        error: `Подожди ${wait} сек. перед повторной отправкой`
      });
    }

    const code = String(randomInt(100000, 1000000));
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + CODE_LIFETIME_MINUTES * 60 * 1000
    );

    await pool.query(
      `UPDATE pending_registrations
       SET code_hash = $2,
           expires_at = $3,
           last_sent_at = $4,
           attempts = 0
       WHERE email = $1`,
      [
        email,
        makeCodeHash(email, code),
        expiresAt,
        now
      ]
    );

    try {
      await sendVerificationEmail(email, code);
    } catch (mailError) {
      console.error("Resend email error:", mailError.message);

      return res.status(503).json({
        error: "Не удалось отправить письмо"
      });
    }

    res.json({
      ok: true,
      message: "Новый код отправлен"
    });
  } catch (err) {
    console.error("Resend code error:", err);
    res.status(500).json({
      error: "Ошибка повторной отправки"
    });
  }
});

// Подтверждение почты и создание аккаунта
app.post("/api/auth/verify-registration", async (req, res) => {
  const email = String(req.body?.email || "")
    .trim()
    .toLowerCase();

  const code = String(req.body?.code || "").trim();

  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    !/^\d{6}$/.test(code)
  ) {
    return res.status(400).json({
      error: "Проверь почту и шестизначный код"
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `SELECT email, username, password_hash, code_hash,
              expires_at, attempts
       FROM pending_registrations
       WHERE email = $1
       FOR UPDATE`,
      [email]
    );

    const pending = result.rows[0];

    if (!pending) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        error: "Регистрация не найдена. Начни её заново."
      });
    }

    if (new Date(pending.expires_at).getTime() < Date.now()) {
      await client.query(
        "DELETE FROM pending_registrations WHERE email = $1",
        [email]
      );

      await client.query("COMMIT");

      return res.status(400).json({
        error: "Код истёк. Начни регистрацию заново."
      });
    }

    if (pending.attempts >= MAX_CODE_ATTEMPTS) {
      await client.query(
        "DELETE FROM pending_registrations WHERE email = $1",
        [email]
      );

      await client.query("COMMIT");

      return res.status(429).json({
        error: "Слишком много попыток. Начни регистрацию заново."
      });
    }

    const validCode = safeHashCompare(
      pending.code_hash,
      makeCodeHash(email, code)
    );

    if (!validCode) {
      const nextAttempts = pending.attempts + 1;

      if (nextAttempts >= MAX_CODE_ATTEMPTS) {
        await client.query(
          "DELETE FROM pending_registrations WHERE email = $1",
          [email]
        );
      } else {
        await client.query(
          `UPDATE pending_registrations
           SET attempts = $2
           WHERE email = $1`,
          [email, nextAttempts]
        );
      }

      await client.query("COMMIT");

      return res.status(400).json({
        error: nextAttempts >= MAX_CODE_ATTEMPTS
          ? "Попытки закончились. Начни регистрацию заново."
          : `Неверный код. Осталось попыток: ${MAX_CODE_ATTEMPTS - nextAttempts}`
      });
    }

    const id = randomUUID();
    const now = new Date();

    await client.query(
      `INSERT INTO users
       (id, username, email, password_hash, created_at, email_verified)
       VALUES ($1, $2, $3, $4, $5, TRUE)`,
      [
        id,
        pending.username,
        email,
        pending.password_hash,
        now
      ]
    );

    await client.query(
      "DELETE FROM pending_registrations WHERE email = $1",
      [email]
    );

    await client.query("COMMIT");

    const user = await getUser(id);
    const token = jwt.sign(
      { id },
      SECRET,
      { expiresIn: "30d" }
    );

    res.status(201).json({ user, token });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});

    if (err.code === "23505") {
      return res.status(409).json({
        error: "Имя пользователя или почта уже заняты"
      });
    }

    console.error("Verify registration error:", err);

    res.status(500).json({
      error: "Не удалось подтвердить регистрацию"
    });
  } finally {
    client.release();
  }
});

// Вход
app.post("/api/auth/login", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim();
    const password = String(req.body?.password || "");

    const result = await pool.query(
      "SELECT * FROM users WHERE LOWER(email) = LOWER($1)",
      [email]
    );

    const userRecord = result.rows[0];

    if (
      !userRecord ||
      !await bcrypt.compare(password, userRecord.password_hash)
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

// Текущий пользователь
app.get("/api/me", auth, (req, res) => {
  res.json({ user: req.user });
});

// Поиск пользователей
app.get("/api/users", auth, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim().slice(0, 30);

    if (q.length < 2) return res.json([]);

    const result = await pool.query(
      `SELECT id, username
       FROM users
       WHERE username ILIKE $1 AND id <> $2
       ORDER BY username
       LIMIT 20`,
      [`%${q}%`, req.user.id]
    );

    res.json(result.rows.map(publicUser));
  } catch (err) {
    console.error("User search error:", err);
    res.status(500).json({ error: "Ошибка поиска" });
  }
});

// Список чатов
app.get("/api/chats", auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT m.chat_id
       FROM members m
       WHERE m.user_id = $1
         AND NOT EXISTS (
           SELECT 1
           FROM hidden_chats h
           WHERE h.chat_id = m.chat_id
             AND h.user_id = $1
         )
       ORDER BY m.chat_id`,
      [req.user.id]
    );

    const chats = await Promise.all(
      result.rows.map(row => chatPayload(row.chat_id))
    );

    res.json(chats.filter(Boolean));
  } catch (err) {
    console.error("Load chats error:", err);
    res.status(500).json({ error: "Ошибка загрузки чатов" });
  }
});

// Создание или открытие личного чата
app.post("/api/chats/direct", auth, async (req, res) => {
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    const otherResult = await client.query(
      "SELECT id FROM users WHERE id = $1",
      [String(req.body?.userId || "")]
    );

    const other = otherResult.rows[0];

    if (!other || other.id === req.user.id) {
      return res.status(400).json({
        error: "Пользователь не найден"
      });
    }

    const existing = await client.query(
      `SELECT c.id
       FROM chats c
       JOIN members a
         ON a.chat_id = c.id AND a.user_id = $1
       JOIN members b
         ON b.chat_id = c.id AND b.user_id = $2
       WHERE c.type = 'direct'
       LIMIT 1`,
      [req.user.id, other.id]
    );

    if (existing.rows[0]) {
      const id = existing.rows[0].id;

      await client.query(
        `DELETE FROM hidden_chats
         WHERE chat_id = $1 AND user_id = $2`,
        [id, req.user.id]
      );

      return res.json(await chatPayload(id));
    }

    const id = randomUUID();
    const now = new Date();

    await client.query("BEGIN");
    transactionStarted = true;

    await client.query(
      `INSERT INTO chats (id, type, created_at)
       VALUES ($1, 'direct', $2)`,
      [id, now]
    );

    await client.query(
      `INSERT INTO members (chat_id, user_id)
       VALUES ($1, $2), ($1, $3)`,
      [id, req.user.id, other.id]
    );

    await client.query("COMMIT");
    transactionStarted = false;

    const createdChat = await chatPayload(id);

    for (const userId of [req.user.id, other.id]) {
      io.to(`user:${userId}`).emit("chat:created", {
        chatId: id
      });
    }

    res.status(201).json(createdChat);
  } catch (err) {
    if (transactionStarted) {
      await client.query("ROLLBACK").catch(() => {});
    }

    console.error("Create direct chat error:", err);
    res.status(500).json({ error: "Ошибка создания чата" });
  } finally {
    client.release();
  }
});

// Создание группы
app.post("/api/chats/group", auth, async (req, res) => {
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    const name = String(req.body?.name || "").trim().slice(0, 60);

    const usernames = Array.isArray(req.body?.usernames)
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
        `SELECT id FROM users
         WHERE LOWER(username) = LOWER($1)`,
        [String(username).trim()]
      );

      if (result.rows[0]) {
        found.push(result.rows[0].id);
      }
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
    transactionStarted = true;

    await client.query(
      `INSERT INTO chats
       (id, type, name, owner_id, created_at)
       VALUES ($1, 'group', $2, $3, $4)`,
      [id, name, req.user.id, now]
    );

    for (const userId of unique) {
      await client.query(
        `INSERT INTO members (chat_id, user_id)
         VALUES ($1, $2)`,
        [id, userId]
      );
    }

    await client.query("COMMIT");
    transactionStarted = false;

    const createdChat = await chatPayload(id);

    for (const userId of unique) {
      io.to(`user:${userId}`).emit("chat:created", {
        chatId: id
      });
    }

    res.status(201).json(createdChat);
  } catch (err) {
    if (transactionStarted) {
      await client.query("ROLLBACK").catch(() => {});
    }

    console.error("Create group error:", err);
    res.status(500).json({ error: "Ошибка создания группы" });
  } finally {
    client.release();
  }
});

// Удаление чата
app.delete("/api/chats/:id", auth, async (req, res) => {
  const chatId = String(req.params.id || "");
  const mode = String(req.body?.mode || "");

  try {
    const chatResult = await pool.query(
      `SELECT id, type, owner_id
       FROM chats
       WHERE id = $1`,
      [chatId]
    );

    const chat = chatResult.rows[0];

    if (!chat || !await isMember(chatId, req.user.id)) {
      return res.status(404).json({
        error: "Чат не найден"
      });
    }

    if (mode === "me") {
      await pool.query(
        `INSERT INTO hidden_chats
         (chat_id, user_id, hidden_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (chat_id, user_id)
         DO UPDATE SET hidden_at = NOW()`,
        [chatId, req.user.id]
      );

      return res.json({
        ok: true,
        mode: "me",
        chatId
      });
    }

    if (mode !== "everyone") {
      return res.status(400).json({
        error: "Неизвестный вариант удаления"
      });
    }

    if (
      chat.type === "group" &&
      chat.owner_id !== req.user.id
    ) {
      return res.status(403).json({
        error: "Удалить группу у всех может только её создатель"
      });
    }

    const members = await pool.query(
      "SELECT user_id FROM members WHERE chat_id = $1",
      [chatId]
    );

    await pool.query(
      "DELETE FROM chats WHERE id = $1",
      [chatId]
    );

    for (const member of members.rows) {
      io.to(`user:${member.user_id}`).emit(
        "chat:deleted",
        { chatId }
      );
    }

    res.json({
      ok: true,
      mode: "everyone",
      chatId
    });
  } catch (err) {
    console.error("Delete chat error:", err);
    res.status(500).json({
      error: "Не удалось удалить чат"
    });
  }
});

// Получение сообщений
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
              m.content, m.attachment_id AS "attachmentId",
              m.created_at AS "createdAt"
       FROM messages m
       JOIN users u ON u.id = m.user_id
       WHERE m.chat_id = $1
       ORDER BY m.created_at DESC
       LIMIT 100`,
      [req.params.id]
    );

    res.json(result.rows.reverse());
  } catch (err) {
    console.error("Load messages error:", err);
    res.status(500).json({
      error: "Ошибка загрузки сообщений"
    });
  }
});

// Загрузка фотографии
app.post("/api/chats/:id/images", auth, async (req, res) => {
  try {
    const chatId = String(req.params.id || "");

    if (!await isMember(chatId, req.user.id)) {
      return res.status(403).json({
        error: "Нет доступа к чату"
      });
    }

    const mime = String(req.body?.mime || "");

    const filename = String(req.body?.filename || "photo")
      .replace(/[^\w.\-а-яА-Я]/g, "_")
      .slice(0, 100);

    const allowed = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif"
    ];

    if (!allowed.includes(mime)) {
      return res.status(400).json({
        error: "Поддерживаются JPG, PNG, WEBP и GIF"
      });
    }

    const encoded = String(req.body?.data || "");

    if (
      !encoded ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
    ) {
      return res.status(400).json({
        error: "Некорректный файл"
      });
    }

    const buffer = Buffer.from(encoded, "base64");

    if (!buffer.length || buffer.length > MAX_IMAGE_SIZE) {
      return res.status(400).json({
        error: "Размер фотографии должен быть не больше 5 МБ"
      });
    }

    const isJpeg =
      mime === "image/jpeg" &&
      buffer.length >= 3 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff;

    const isPng =
      mime === "image/png" &&
      buffer.length >= 8 &&
      buffer.subarray(0, 8).equals(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
      );

    const isWebp =
      mime === "image/webp" &&
      buffer.length >= 12 &&
      buffer.toString("ascii", 0, 4) === "RIFF" &&
      buffer.toString("ascii", 8, 12) === "WEBP";

    const isGif =
      mime === "image/gif" &&
      buffer.length >= 6 &&
      ["GIF87a", "GIF89a"].includes(
        buffer.toString("ascii", 0, 6)
      );

    if (!isJpeg && !isPng && !isWebp && !isGif) {
      return res.status(400).json({
        error: "Файл не похож на поддерживаемое изображение"
      });
    }

    const attachmentId = randomUUID();
    const messageId = randomUUID();
    const now = new Date();

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      await client.query(
        `INSERT INTO attachments
         (id, chat_id, user_id, mime_type, filename, data, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          attachmentId,
          chatId,
          req.user.id,
          mime,
          filename,
          buffer,
          now
        ]
      );

      await client.query(
        `INSERT INTO messages
         (id, chat_id, user_id, content, attachment_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          messageId,
          chatId,
          req.user.id,
          "Фотография",
          attachmentId,
          now
        ]
      );

      await client.query(
        `DELETE FROM hidden_chats
         WHERE chat_id = $1 AND user_id = $2`,
        [chatId, req.user.id]
      );

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    const msg = {
      id: messageId,
      chatId,
      userId: req.user.id,
      username: req.user.username,
      content: "Фотография",
      attachmentId,
      createdAt: now
    };

    io.to(chatId).emit("message:new", msg);

    res.status(201).json(msg);
  } catch (err) {
    console.error("Image upload error:", err);
    res.status(500).json({
      error: "Не удалось отправить фотографию"
    });
  }
});

// Получение фотографии
app.get("/api/attachments/:id", auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.chat_id, a.mime_type, a.data
       FROM attachments a
       WHERE a.id = $1`,
      [req.params.id]
    );

    const attachment = result.rows[0];

    if (
      !attachment ||
      !await isMember(attachment.chat_id, req.user.id)
    ) {
      return res.status(404).json({
        error: "Фотография не найдена"
      });
    }

    res.setHeader("Content-Type", attachment.mime_type);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, max-age=3600");

    res.send(attachment.data);
  } catch (err) {
    console.error("Get attachment error:", err);
    res.status(500).json({
      error: "Ошибка загрузки фотографии"
    });
  }
});

// Авторизация Socket.IO
io.use(async (socket, next) => {
  try {
    const payload = jwt.verify(
      socket.handshake.auth?.token || "",
      SECRET
    );

    const user = await getUser(payload.id);

    if (!user) {
      return next(new Error("Аккаунт не найден"));
    }

    socket.user = user;
    next();
  } catch (err) {
    next(new Error("Требуется авторизация"));
  }
});

io.on("connection", socket => {
  socket.join(`user:${socket.user.id}`);

  socket.on("chat:join", async chatId => {
    try {
      if (
        typeof chatId === "string" &&
        await isMember(chatId, socket.user.id)
      ) {
        socket.join(chatId);
      }
    } catch (err) {
      console.error("Chat join error:", err);
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
        attachmentId: null,
        createdAt: new Date()
      };

      await pool.query(
        `INSERT INTO messages
         (id, chat_id, user_id, content, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          msg.id,
          chatId,
          msg.userId,
          content,
          msg.createdAt
        ]
      );

      await pool.query(
        `DELETE FROM hidden_chats
         WHERE chat_id = $1 AND user_id = $2`,
        [chatId, socket.user.id]
      );

      io.to(chatId).emit("message:new", msg);

      if (typeof ack === "function") {
        ack(null);
      }
    } catch (err) {
      if (typeof ack === "function") {
        ack(err.message);
      }
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
