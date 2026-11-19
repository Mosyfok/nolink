const base = "https://nolink.onrender.com";

let token = localStorage.getItem("nolink-token");
let currentUser = null;
let socket = null;
let chats = [];
let activeChat = null;
let selectedChats = new Set();
let selectionMode = false;
let pendingDelete = [];

let registerMode = false;
let verificationMode = false;
let verificationEmail = "";

let badgeAdmin = false;
let badgeSearchTimer = null;
let userSearchTimer = null;

let replyToMessage = null;
let typingTimer = null;
let isTyping = false;
let typingUsers = new Map();

const $ = id => document.getElementById(id);

/* =========================================================
   API
   ========================================================= */

async function api(path, options = {}) {
  const headers = {
    ...(options.body instanceof FormData
      ? {}
      : { "Content-Type": "application/json" }),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers || {})
  };

  const response = await fetch(base + path, {
    ...options,
    headers
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Ошибка сервера");
  }

  return data;
}

function showError(id, message) {
  const element = $(id);
  if (element) element.textContent = message || "";
}

function escapeText(value) {
  return String(value ?? "");
}

/* =========================================================
   АВТОРИЗАЦИЯ И ПРОФИЛЬ
   ========================================================= */

function showAuth() {
  $("auth").classList.remove("hidden");
  $("app").classList.add("hidden");
}

function normalizeNolinkId(value) {
  return String(value || "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();
}

function isValidNolinkId(value) {
  return /^[a-z0-9]{3,8}$/.test(normalizeNolinkId(value));
}

function formatNolinkId(value) {
  const id = normalizeNolinkId(value);
  return id ? `@${id}` : "";
}

function renderVerifiedName(element, username, isVerified) {
  element.replaceChildren();
  element.appendChild(
    document.createTextNode(username || "Пользователь")
  );

  if (isVerified === true) {
    const badge = document.createElement("span");
    badge.className = "verified-badge";
    badge.textContent = "✓";
    badge.title = "Подтверждённый аккаунт";
    badge.setAttribute("aria-label", "Подтверждённый аккаунт");
    element.appendChild(badge);
  }
}

function showApp() {
  $("auth").classList.add("hidden");
  $("app").classList.remove("hidden");

  $("my-name").textContent = currentUser.username;
  $("my-avatar").textContent =
    currentUser.username.charAt(0).toUpperCase();

  renderVerifiedName(
    $("my-name"),
    currentUser.username,
    currentUser.isVerified
  );

  if ($("my-presence")) {
    $("my-presence").textContent =
      currentUser.isOnline === false ? "Не в сети" : "В сети";
  }

  if ($("my-nolink-id")) {
    $("my-nolink-id").textContent =
      formatNolinkId(currentUser.nolinkId);
  }
}

function openProfile() {
  if (!currentUser) return;

  $("profile-avatar").textContent =
    (currentUser.username || "N").charAt(0).toUpperCase();

  $("profile-username").textContent =
    currentUser.username || "Пользователь";

  $("profile-email").textContent = currentUser.email || "—";

  $("profile-nolink-id").textContent =
    formatNolinkId(currentUser.nolinkId) || "Не указан";

  $("profile-presence").textContent =
    currentUser.isOnline === false ? "Не в сети" : "В сети";

  const created = currentUser.createdAt
    ? new Date(currentUser.createdAt)
    : null;

  $("profile-created").textContent =
    created && !Number.isNaN(created.getTime())
      ? created.toLocaleDateString("ru-RU", {
          day: "2-digit",
          month: "long",
          year: "numeric"
        })
      : "—";

  $("profile-modal").classList.remove("hidden");
}

$("profile-open").addEventListener("click", openProfile);

$("profile-close").addEventListener("click", () => {
  $("profile-modal").classList.add("hidden");
});

$("profile-modal").addEventListener("click", event => {
  if (event.target === $("profile-modal")) {
    $("profile-modal").classList.add("hidden");
  }
});

function createUserLabel(user) {
  const container = document.createElement("span");
  const username = document.createElement("span");

  renderVerifiedName(username, user.username, user.isVerified);
  container.appendChild(username);

  if (user.nolinkId) {
    const id = document.createElement("small");
    id.className = "user-nolink-id";
    id.textContent = formatNolinkId(user.nolinkId);
    container.appendChild(id);
  }

  return container;
}

function setAuthMode(mode) {
  registerMode = mode;
  verificationMode = false;

  $("auth-form").classList.remove("hidden");
  $("email-verify-form").classList.add("hidden");
  $("auth-switch").classList.remove("hidden");

  $("auth-title").textContent = registerMode
    ? "Создание аккаунта"
    : "С возвращением";

  $("auth-submit").textContent = registerMode
    ? "Зарегистрироваться"
    : "Войти";

  $("auth-switch").textContent = registerMode
    ? "Уже есть аккаунт? Войти"
    : "Нет аккаунта? Зарегистрироваться";

  $("username").classList.toggle("hidden", !registerMode);
  $("username-label").classList.toggle("hidden", !registerMode);

  if ($("nolink-id")) {
    $("nolink-id").classList.toggle("hidden", !registerMode);
    $("nolink-id").required = registerMode;
    $("nolink-id").value = "";
  }

  if ($("nolink-id-label")) {
    $("nolink-id-label").classList.toggle("hidden", !registerMode);
  }

  if ($("nolink-id-hint")) {
    $("nolink-id-hint").classList.toggle("hidden", !registerMode);
  }

  $("username").required = registerMode;
  $("password").autocomplete = registerMode
    ? "new-password"
    : "current-password";

  $("password").value = "";
  $("verification-code").value = "";

  showError("auth-error", "");
}

$("auth-switch").addEventListener("click", () => {
  setAuthMode(!registerMode);
});

$("back-to-auth").addEventListener("click", () => {
  setAuthMode(true);
});

$("auth-form").addEventListener("submit", async event => {
  event.preventDefault();
  showError("auth-error", "");

  const email = $("email").value.trim();
  const password = $("password").value;
  const submit = $("auth-submit");

  submit.disabled = true;

  try {
    const path = registerMode
      ? "/api/auth/register"
      : "/api/auth/login";

    const body = { email, password };

    if (registerMode) {
      body.username = $("username").value.trim();

      const enteredId = $("nolink-id").value;

      if (!isValidNolinkId(enteredId)) {
        showError(
          "auth-error",
          "NOLINK ID должен содержать от 3 до 8 латинских букв или цифр."
        );
        return;
      }

      body.nolinkId = `@${normalizeNolinkId(enteredId)}`;
    }

    const result = await api(path, {
      method: "POST",
      body: JSON.stringify(body)
    });

    if (registerMode) {
      verificationEmail = result.email || email.toLowerCase();

      $("verify-email").textContent = verificationEmail;
      $("auth-form").classList.add("hidden");
      $("email-verify-form").classList.remove("hidden");
      $("auth-switch").classList.add("hidden");
      $("auth-title").textContent = "Подтверждение почты";
      $("verification-code").value = "";
      $("verification-code").focus();

      showError(
        "auth-error",
        "Код отправлен на почту. Проверь входящие и папку «Спам»."
      );

      verificationMode = true;
      return;
    }

    token = result.token;
    currentUser = result.user;
    localStorage.setItem("nolink-token", token);

    await enterApp();
  } catch (err) {
    showError("auth-error", err.message);
  } finally {
    submit.disabled = false;
  }
});

$("email-verify-form").addEventListener("submit", async event => {
  event.preventDefault();
  showError("auth-error", "");

  const code = $("verification-code").value.trim();

  if (!/^\d{6}$/.test(code)) {
    showError("auth-error", "Введи шестизначный код из письма.");
    return;
  }

  const submit = $("verify-submit");
  submit.disabled = true;

  try {
    const result = await api("/api/auth/verify-registration", {
      method: "POST",
      body: JSON.stringify({
        email: verificationEmail,
        code
      })
    });

    token = result.token;
    currentUser = result.user;
    localStorage.setItem("nolink-token", token);

    verificationMode = false;
    verificationEmail = "";

    await enterApp();
  } catch (err) {
    showError("auth-error", err.message);
  } finally {
    submit.disabled = false;
  }
});

$("resend-code").addEventListener("click", async () => {
  showError("auth-error", "");

  const button = $("resend-code");
  button.disabled = true;

  try {
    const result = await api("/api/auth/resend-code", {
      method: "POST",
      body: JSON.stringify({ email: verificationEmail })
    });

    showError("auth-error", result.message || "Новый код отправлен.");
  } catch (err) {
    showError("auth-error", err.message);
  } finally {
    button.disabled = false;
  }
});

/* =========================================================
   ИНТЕРФЕЙС НОВЫХ ФУНКЦИЙ
   ========================================================= */

function addMessageStyles() {
  if ($("nolink-message-styles")) return;

  const style = document.createElement("style");
  style.id = "nolink-message-styles";

  style.textContent = `
    .message-tools {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 6px;
    }

    .message-tools button,
    .reply-preview button {
      border: 0;
      border-radius: 7px;
      padding: 5px 9px;
      cursor: pointer;
      background: rgba(128,128,128,.15);
      color: inherit;
      font-size: 12px;
    }

    .message-tools button:hover,
    .reply-preview button:hover {
      background: rgba(128,128,128,.28);
    }

    .message-reply {
      border-left: 3px solid #7298d5;
      padding: 5px 8px;
      margin-bottom: 7px;
      border-radius: 4px;
      background: rgba(128,128,128,.12);
      font-size: 12px;
      cursor: pointer;
      overflow-wrap: anywhere;
    }

    .message-edited,
    .message-status {
      opacity: .7;
      font-size: 11px;
      margin-left: 5px;
    }

    .reply-preview {
      display: none;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 8px 12px;
      margin: 5px 0;
      border-left: 3px solid #7298d5;
      background: rgba(128,128,128,.12);
      border-radius: 7px;
      font-size: 12px;
    }

    .reply-preview.visible {
      display: flex;
    }

    .reply-preview-text {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    #typing-indicator {
      min-height: 16px;
      padding: 0 12px;
      font-size: 12px;
      opacity: .7;
    }

    .message-deleted {
      opacity: .7;
      font-style: italic;
    }

    .message-edit-area {
      margin-top: 8px;
      width: 100%;
    }

    .message-edit-area textarea {
      display: block;
      width: 100%;
      min-height: 65px;
      box-sizing: border-box;
      padding: 8px;
      border: 1px solid rgba(128,128,128,.4);
      border-radius: 8px;
      background: var(--input-bg, transparent);
      color: inherit;
      font: inherit;
    }
  `;

  document.head.appendChild(style);
}

function createExtraInterface() {
  addMessageStyles();

  const composer = $("send-form");
  if (!composer) return;

  if (!$("reply-preview")) {
    const preview = document.createElement("div");
    preview.id = "reply-preview";
    preview.className = "reply-preview";

    const text = document.createElement("span");
    text.id = "reply-preview-text";
    text.className = "reply-preview-text";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Отмена";
    cancel.addEventListener("click", clearReply);

    preview.append(text, cancel);
    composer.parentNode.insertBefore(preview, composer);
  }

  if (!$("typing-indicator")) {
    const indicator = document.createElement("div");
    indicator.id = "typing-indicator";

    const subtitle = $("chat-subtitle");

    if (subtitle) {
      subtitle.parentNode.insertBefore(
        indicator,
        subtitle.nextSibling
      );
    } else {
      composer.parentNode.insertBefore(indicator, composer);
    }
  }
}

function clearReply() {
  replyToMessage = null;

  const preview = $("reply-preview");
  if (preview) preview.classList.remove("visible");

  const text = $("reply-preview-text");
  if (text) text.textContent = "";
}

function setReply(message) {
  if (!message || message.deletedAt) return;

  replyToMessage = message;

  const author = String(message.userId) === String(currentUser.id)
    ? "Вы"
    : (message.username || "Пользователь");

  const text = $("reply-preview-text");

  if (text) {
    text.textContent =
      `Ответ на ${author}: ${message.content || "Фотография"}`;
  }

  $("reply-preview").classList.add("visible");
  $("message-input").focus();
}

/* =========================================================
   СТАТУСЫ ПРОЧТЕНИЯ
   ========================================================= */

function getReadStatus(message) {
  if (String(message.userId) !== String(currentUser.id)) return "";

  const readers = (message.readBy || []).filter(
    item => String(item.userId) !== String(currentUser.id)
  );

  if (!readers.length) return "✓ Отправлено";

  if (activeChat?.type === "group") {
    return `✓✓ Прочитано (${readers.length})`;
  }

  return "✓✓ Прочитано";
}

function updateMessageStatus(messageId, readBy) {
  const wrapper = [...document.querySelectorAll("[data-message-id]")]
    .find(element =>
      element.dataset.messageId === String(messageId)
    );

  if (!wrapper) return;

  let message;

  try {
    message = JSON.parse(wrapper.dataset.message || "{}");
  } catch {
    return;
  }

  message.readBy = Array.isArray(readBy) ? readBy : [];

  wrapper.dataset.message = JSON.stringify(message);
  wrapper.dataset.readBy = JSON.stringify(message.readBy);

  const status = wrapper.querySelector(".message-status");

  if (status) {
    status.textContent = getReadStatus(message);
  }
}

/* =========================================================
   ПРАВА АДМИНИСТРАТОРА ГАЛОЧЕК
   ========================================================= */

async function loadBadgeAdminStatus() {
  badgeAdmin = false;
  $("badge-admin-button").classList.add("hidden");

  try {
    const result = await api("/api/badges/admin");
    badgeAdmin = result.isAdmin === true;

    $("badge-admin-button").classList.toggle(
      "hidden",
      !badgeAdmin
    );
  } catch (err) {
    console.error(
      "Не удалось проверить права управления галочками:",
      err
    );
  }
}

/* =========================================================
   ЗАПУСК И SOCKET.IO
   ========================================================= */

async function enterApp() {
  showApp();
  createExtraInterface();
  connectSocket();

  await loadBadgeAdminStatus();
  await loadChats();
}

function connectSocket() {
  if (socket) socket.disconnect();

  socket = io(base, { auth: { token } });

  socket.on("connect_error", err => {
    console.error("Socket connection error:", err.message);
  });

  // Повторно присоединяемся к открытому чату после переподключения.
  socket.on("connect", () => {
    if (activeChat?.id) {
      const chatId = String(activeChat.id);

      socket.emit("chat:join", chatId);
      socket.emit("chat:read", chatId);
    }
  });

  socket.on("presence:snapshot", userIds => {
    const online = new Set(
      (Array.isArray(userIds) ? userIds : []).map(String)
    );

    for (const chat of chats) {
      for (const member of chat.members || []) {
        member.isOnline = online.has(String(member.id));
      }
    }

    if (currentUser) {
      currentUser.isOnline = online.has(String(currentUser.id));
    }

    if ($("my-presence")) {
      $("my-presence").textContent = currentUser?.isOnline
        ? "В сети"
        : "Не в сети";
    }

    updateActiveChatSubtitle();
    renderChats();
  });

  socket.on("presence:update", data => {
    if (!data?.userId) return;
    setUserPresence(data.userId, data.isOnline);
  });

  socket.on("message:new", message => {
    if (!message) return;

    const chat = chats.find(
      item => String(item.id) === String(message.chatId)
    );

    if (chat) {
      chat.lastMessage = message;
    }

    renderChats();

    if (activeChat && String(activeChat.id) === String(message.chatId)) {
      appendMessage(message);

      if (
        String(message.userId) !== String(currentUser.id) &&
        socket?.connected
      ) {
        socket.emit("chat:read", String(message.chatId));
      }
    }
  });

  socket.on("messages:read", data => {
    if (!data || !Array.isArray(data.messageIds)) return;

    for (const messageId of data.messageIds) {
      const wrapper = [...document.querySelectorAll("[data-message-id]")]
        .find(element =>
          element.dataset.messageId === String(messageId)
        );

      if (!wrapper) continue;

      let message;

      try {
        message = JSON.parse(wrapper.dataset.message || "{}");
      } catch {
        continue;
      }

      const readBy = Array.isArray(message.readBy)
        ? [...message.readBy]
        : [];

      if (!readBy.some(
        item => String(item.userId) === String(data.userId)
      )) {
        readBy.push({
          userId: data.userId,
          readAt: data.readAt
        });
      }

      updateMessageStatus(messageId, readBy);
    }
  });

  socket.on("message:updated", message => {
    if (!message) return;

    const chat = chats.find(
      item => String(item.id) === String(message.chatId)
    );

    if (
      chat?.lastMessage &&
      String(chat.lastMessage.id) === String(message.id)
    ) {
      chat.lastMessage = message;
      renderChats();
    }

    if (
      activeChat &&
      String(activeChat.id) === String(message.chatId)
    ) {
      replaceMessage(message);
    }
  });

  // ИСПРАВЛЕННЫЙ ОБРАБОТЧИК СТАТУСА «ПЕЧАТАЕТ…»
  socket.on("typing:update", data => {
    if (!data || !activeChat || !currentUser) return;

    // Сравниваем ID как строки, чтобы не было несовпадения типов.
    if (String(data.chatId) !== String(activeChat.id)) {
      return;
    }

    // Не показываем собственный статус печати.
    if (String(data.userId) === String(currentUser.id)) {
      return;
    }

    const typingUserId = String(data.userId);

    if (data.isTyping === true) {
      typingUsers.set(
        typingUserId,
        data.username || "Пользователь"
      );
    } else {
      typingUsers.delete(typingUserId);
    }

    renderTypingIndicator();
  });

  socket.on("chat:created", async () => {
    await loadChats();
  });

  socket.on("chat:deleted", ({ chatId }) => {
    chats = chats.filter(
      chat => String(chat.id) !== String(chatId)
    );

    selectedChats.delete(chatId);

    if (
      activeChat &&
      String(activeChat.id) === String(chatId)
    ) {
      stopTyping();
      activeChat = null;
      typingUsers.clear();
      renderTypingIndicator();
      clearReply();

      $("conversation").classList.add("hidden");
      $("empty-state").classList.remove("hidden");
    }

    renderChats();
  });

  socket.on("user:badge-updated", async data => {
    if (!data) return;

    const userId = data.userId || data.id;
    if (!userId) return;

    for (const chat of chats) {
      for (const member of chat.members || []) {
        if (String(member.id) === String(userId)) {
          member.isVerified = data.isVerified === true;
        }
      }

      if (
        chat.lastMessage &&
        String(chat.lastMessage.userId) === String(userId)
      ) {
        chat.lastMessage.isVerified = data.isVerified === true;
      }
    }

    if (String(currentUser.id) === String(userId)) {
      currentUser.isVerified = data.isVerified === true;

      renderVerifiedName(
        $("my-name"),
        currentUser.username,
        currentUser.isVerified
      );
    }

    renderChats();

    if (activeChat) {
      const updatedChat = chats.find(
        chat => String(chat.id) === String(activeChat.id)
      );

      if (updatedChat) {
        activeChat = updatedChat;
        await openChat(updatedChat);
      }
    }
  });
}

/* =========================================================
   ПРИСУТСТВИЕ И СТАТУС ЧАТА
   ========================================================= */

function setUserPresence(userId, isOnline) {
  for (const chat of chats) {
    for (const member of chat.members || []) {
      if (String(member.id) === String(userId)) {
        member.isOnline = isOnline === true;
      }
    }
  }

  if (currentUser && String(currentUser.id) === String(userId)) {
    currentUser.isOnline = isOnline === true;

    const label = isOnline ? "В сети" : "Не в сети";

    if ($("my-presence")) $("my-presence").textContent = label;
    if ($("profile-presence")) {
      $("profile-presence").textContent = label;
    }
  }

  if (
    activeChat &&
    String(getOtherMember(activeChat)?.id) === String(userId)
  ) {
    updateActiveChatSubtitle();
  }

  renderChats();
}

function chatName(chat) {
  if (chat.type === "group") {
    return chat.name || "Группа";
  }

  const other = (chat.members || []).find(
    member => String(member.id) !== String(currentUser.id)
  );

  return other?.username || "Личный чат";
}

function getOtherMember(chat) {
  if (!chat || chat.type === "group") return null;

  return (chat.members || []).find(
    member => String(member.id) !== String(currentUser.id)
  ) || null;
}

function updateActiveChatSubtitle() {
  if (!activeChat) return;

  const other = getOtherMember(activeChat);

  $("chat-subtitle").textContent =
    activeChat.type === "group"
      ? `${(activeChat.members || []).length} участников`
      : (other?.isOnline ? "В сети" : "Не в сети");
}

/* =========================================================
   ИНДИКАТОР ПЕЧАТИ
   ========================================================= */

function renderTypingIndicator() {
  const indicator = $("typing-indicator");
  if (!indicator) return;

  const names = [...typingUsers.values()];

  if (!names.length) {
    indicator.textContent = "";
  } else if (names.length === 1) {
    indicator.textContent = `${names[0]} печатает…`;
  } else {
    indicator.textContent = "Несколько человек печатают…";
  }
}

function startTyping() {
  if (!activeChat || !socket?.connected) return;

  if (!isTyping) {
    isTyping = true;

    // Всегда отправляем ID чата строкой.
    socket.emit("typing:start", String(activeChat.id));
  }

  clearTimeout(typingTimer);

  typingTimer = setTimeout(() => {
    stopTyping();
  }, 1500);
}

function stopTyping() {
  clearTimeout(typingTimer);
  typingTimer = null;

  if (isTyping && activeChat && socket?.connected) {
    socket.emit("typing:stop", String(activeChat.id));
  }

  isTyping = false;
}

$("message-input").addEventListener("input", () => {
  if ($("message-input").value.trim()) {
    startTyping();
  } else {
    stopTyping();
  }
});

/* =========================================================
   ЗАГРУЗКА И ОТОБРАЖЕНИЕ ЧАТОВ
   ========================================================= */

async function loadChats() {
  try {
    chats = await api("/api/chats");
    renderChats();
  } catch (err) {
    console.error("Не удалось загрузить чаты:", err);
  }
}

function formatChatTime(value) {
  if (!value) return "";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const now = new Date();

  const sameDay =
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear();

  return sameDay
    ? date.toLocaleTimeString("ru-RU", {
        hour: "2-digit",
        minute: "2-digit"
      })
    : date.toLocaleDateString("ru-RU", {
        day: "2-digit",
        month: "2-digit"
      });
}

function renderChats() {
  const list = $("chat-list");
  list.replaceChildren();

  const query = $("search").value.trim().toLowerCase();

  const filtered = chats.filter(chat =>
    chatName(chat).toLowerCase().includes(query)
  );

  for (const chat of filtered) {
    const item = document.createElement("div");
    item.className = "chat-item";

    if (
      activeChat &&
      String(activeChat.id) === String(chat.id)
    ) {
      item.classList.add("active");
    }

    if (selectedChats.has(chat.id)) {
      item.classList.add("selected");
    }

    if (selectionMode) {
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "chat-select";
      checkbox.checked = selectedChats.has(chat.id);

      checkbox.addEventListener("click", event => {
        event.stopPropagation();
      });

      checkbox.addEventListener("change", () => {
        toggleSelected(chat.id);
      });

      item.appendChild(checkbox);
    }

    const other = getOtherMember(chat);

    const avatar = document.createElement("div");
    avatar.className = "chat-list-avatar";

    if (other?.isOnline) avatar.classList.add("is-online");

    avatar.textContent = chatName(chat).charAt(0).toUpperCase();

    const content = document.createElement("div");
    content.className = "chat-item-content";

    const top = document.createElement("div");
    top.className = "chat-item-top";

    const title = document.createElement("b");
    title.className = "chat-item-title";

    if (other) {
      renderVerifiedName(title, other.username, other.isVerified);
    } else {
      title.textContent = chatName(chat);
    }

    const time = document.createElement("small");
    time.className = "chat-item-time";

    if (chat.lastMessage?.createdAt) {
      time.textContent = formatChatTime(chat.lastMessage.createdAt);
    }

    top.append(title, time);

    const preview = document.createElement("small");
    preview.className = "chat-item-preview";

    if (!chat.lastMessage) {
      preview.textContent = "Нет сообщений";
    } else if (chat.lastMessage.deletedAt) {
      preview.textContent = "Сообщение удалено";
    } else if (chat.lastMessage.attachmentId) {
      preview.textContent = "📷 Фотография";
    } else {
      const messageText = chat.lastMessage.content || "";

      const author =
        chat.type === "group" && chat.lastMessage.username
          ? `${chat.lastMessage.username}: `
          : "";

      preview.textContent = author + messageText;
    }

    content.append(top, preview);
    item.append(avatar, content);

    item.addEventListener("click", () => {
      if (selectionMode) {
        toggleSelected(chat.id);
      } else {
        openChat(chat);
      }
    });

    list.appendChild(item);
  }

  if (!filtered.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Чатов пока нет";
    list.appendChild(empty);
  }

  updateSelectionToolbar();
}

$("search").addEventListener("input", renderChats);

/* =========================================================
   ВЫБОР И УДАЛЕНИЕ ЧАТОВ
   ========================================================= */

function toggleSelected(chatId) {
  if (selectedChats.has(chatId)) {
    selectedChats.delete(chatId);
  } else {
    selectedChats.add(chatId);
  }

  renderChats();
}

function updateSelectionToolbar() {
  $("selection-toolbar").classList.toggle(
    "hidden",
    !selectionMode
  );

  $("select-chats").textContent = selectionMode ? "×" : "☑";

  $("select-chats").title = selectionMode
    ? "Завершить выбор"
    : "Выбрать чаты";

  $("delete-selected").disabled = selectedChats.size === 0;
}

$("select-chats").addEventListener("click", () => {
  selectionMode = !selectionMode;
  selectedChats.clear();
  renderChats();
});

/* ИСПРАВЛЕНО: кнопки может не быть в index.html */
const cancelSelectionButton = $("cancel-selection");

if (cancelSelectionButton) {
  cancelSelectionButton.addEventListener("click", () => {
    selectionMode = false;
    selectedChats.clear();
    renderChats();
  });
}

$("select-all-chats").addEventListener("click", () => {
  const query = $("search").value.trim().toLowerCase();

  for (const chat of chats) {
    if (chatName(chat).toLowerCase().includes(query)) {
      selectedChats.add(chat.id);
    }
  }

  renderChats();
});

function closeDeleteModal() {
  $("delete-modal").classList.add("hidden");
  pendingDelete = [];
  showError("delete-error", "");
}

$("delete-selected").addEventListener("click", () => {
  if (!selectedChats.size) return;

  pendingDelete = [...selectedChats];
  $("delete-modal").classList.remove("hidden");
  showError("delete-error", "");
});

$("delete-cancel").addEventListener("click", closeDeleteModal);
$("delete-cancel-bottom").addEventListener("click", closeDeleteModal);

async function deleteChats(mode) {
  if (!pendingDelete.length) return;

  showError("delete-error", "Удаляем...");

  const ids = [...pendingDelete];
  const errors = [];

  for (const chatId of ids) {
    try {
      await api(`/api/chats/${encodeURIComponent(chatId)}`, {
        method: "DELETE",
        body: JSON.stringify({ mode })
      });

      chats = chats.filter(
        chat => String(chat.id) !== String(chatId)
      );

      selectedChats.delete(chatId);

      if (
        activeChat &&
        String(activeChat.id) === String(chatId)
      ) {
        stopTyping();
        activeChat = null;
        typingUsers.clear();
        renderTypingIndicator();
        clearReply();

        $("conversation").classList.add("hidden");
        $("empty-state").classList.remove("hidden");
      }
    } catch (err) {
      errors.push(err.message);
    }
  }

  renderChats();

  if (errors.length) {
    showError("delete-error", [...new Set(errors)].join(". "));
  } else {
    closeDeleteModal();
    selectionMode = false;
    selectedChats.clear();
    renderChats();
  }
}

$("delete-me").addEventListener("click", () => {
  deleteChats("me");
});

$("delete-everyone").addEventListener("click", () => {
  deleteChats("everyone");
});

/* =========================================================
   ОТКРЫТИЕ ЧАТА
   ========================================================= */

async function openChat(chat) {
  if (
    !activeChat ||
    String(activeChat.id) !== String(chat.id)
  ) {
    stopTyping();
    typingUsers.clear();
    renderTypingIndicator();
    clearReply();
  }

  activeChat = chat;

  $("empty-state").classList.add("hidden");
  $("conversation").classList.remove("hidden");

  const other = getOtherMember(chat);

  renderVerifiedName(
    $("chat-title"),
    chatName(chat),
    other?.isVerified
  );

  $("chat-avatar").textContent =
    chatName(chat).charAt(0).toUpperCase();

  updateActiveChatSubtitle();
  $("messages").replaceChildren();

  if (socket?.connected) {
    socket.emit("chat:join", String(chat.id));
  }

  renderChats();

  try {
    const messages = await api(
      `/api/chats/${encodeURIComponent(chat.id)}/messages`
    );

    if (
      !activeChat ||
      String(activeChat.id) !== String(chat.id)
    ) {
      return;
    }

    $("messages").replaceChildren();

    for (const message of messages) {
      if (
        !activeChat ||
        String(activeChat.id) !== String(chat.id)
      ) {
        return;
      }

      appendMessage(message);
    }

    scrollMessagesToBottom();

    if (socket?.connected) {
      socket.emit("chat:read", String(chat.id));
    }
  } catch (err) {
    console.error("Ошибка загрузки сообщений:", err);
  }
}

/* =========================================================
   СОЗДАНИЕ ЭЛЕМЕНТА СООБЩЕНИЯ
   ========================================================= */

function createMessageElement(message) {
  const wrapper = document.createElement("div");
  wrapper.className = "message";
  wrapper.dataset.messageId = String(message.id);
  wrapper.dataset.message = JSON.stringify(message);
  wrapper.dataset.readBy = JSON.stringify(message.readBy || []);

  if (String(message.userId) === String(currentUser.id)) {
    wrapper.classList.add("mine");
  }

  const author = document.createElement("b");
  author.className = "message-author";

  if (String(message.userId) === String(currentUser.id)) {
    renderVerifiedName(author, "Вы", currentUser.isVerified);
  } else {
    renderVerifiedName(
      author,
      message.username || "Пользователь",
      message.isVerified
    );
  }

  const content = document.createElement("div");
  content.className = "message-content";

  if (message.replyTo) {
    const reply = document.createElement("div");
    reply.className = "message-reply";

    const replyAuthor =
      message.replyTo.username || "Пользователь";

    const replyContent = message.replyTo.deletedAt
      ? "Сообщение удалено"
      : (message.replyTo.content || "Фотография");

    reply.textContent = `${replyAuthor}: ${replyContent}`;

    reply.addEventListener("click", () => {
      const target = [...document.querySelectorAll("[data-message-id]")]
        .find(element =>
          element.dataset.messageId ===
          String(message.replyTo.id)
        );

      if (target) {
        target.scrollIntoView({
          behavior: "smooth",
          block: "center"
        });
      }
    });

    content.appendChild(reply);
  }

  if (message.deletedAt) {
    const deleted = document.createElement("span");
    deleted.className = "message-deleted";
    deleted.textContent = "Сообщение удалено";
    content.appendChild(deleted);
  } else if (message.attachmentId) {
    const image = document.createElement("img");
    image.className = "message-image";
    image.alt = "Фотография";
    image.loading = "lazy";

    content.appendChild(image);

    fetch(
      `${base}/api/attachments/${encodeURIComponent(message.attachmentId)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    )
      .then(response => {
        if (!response.ok) {
          throw new Error("Не удалось загрузить фотографию");
        }

        return response.blob();
      })
      .then(blob => blobToDataUrl(blob))
      .then(dataUrl => {
        image.src = dataUrl;
      })
      .catch(() => {
        image.remove();

        const errorText = document.createElement("span");
        errorText.textContent = "📷 Не удалось загрузить фотографию";
        content.appendChild(errorText);
      });
  } else {
    content.appendChild(
      document.createTextNode(escapeText(message.content))
    );
  }

  const time = document.createElement("small");
  time.className = "message-time";

  const date = new Date(message.createdAt);

  time.textContent = Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString("ru-RU", {
        hour: "2-digit",
        minute: "2-digit"
      });

  wrapper.append(author, content, time);

  if (message.editedAt && !message.deletedAt) {
    const edited = document.createElement("small");
    edited.className = "message-edited";
    edited.textContent = "изменено";
    wrapper.appendChild(edited);
  }

  if (String(message.userId) === String(currentUser.id)) {
    const status = document.createElement("small");
    status.className = "message-status";
    status.textContent = getReadStatus(message);
    wrapper.appendChild(status);
  }

  const tools = document.createElement("div");
  tools.className = "message-tools";

  if (!message.deletedAt) {
    const replyButton = document.createElement("button");
    replyButton.type = "button";
    replyButton.textContent = "Ответить";
    replyButton.addEventListener("click", () => {
      setReply(message);
    });

    tools.appendChild(replyButton);
  }

  if (
    String(message.userId) === String(currentUser.id) &&
    !message.deletedAt
  ) {
    if (!message.attachmentId) {
      const editButton = document.createElement("button");
      editButton.type = "button";
      editButton.textContent = "Изменить";

      editButton.addEventListener("click", () => {
        editMessage(message);
      });

      tools.appendChild(editButton);
    }

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.textContent = "Удалить";

    deleteButton.addEventListener("click", () => {
      deleteMessage(message);
    });

    tools.appendChild(deleteButton);
  }

  if (tools.children.length) {
    wrapper.appendChild(tools);
  }

  return wrapper;
}

function appendMessage(message) {
  if (!message || !$("messages")) return;

  const existing = [...$("messages").querySelectorAll("[data-message-id]")]
    .some(element =>
      element.dataset.messageId === String(message.id)
    );

  if (existing) return;

  const wrapper = createMessageElement(message);
  $("messages").appendChild(wrapper);

  scrollMessagesToBottom();
}

/* =========================================================
   РЕДАКТИРОВАНИЕ СООБЩЕНИЙ
   ========================================================= */

function editMessage(message) {
  if (!socket?.connected || !activeChat) {
    alert("Нет подключения к серверу");
    return;
  }

  const wrapper = [...$("messages").querySelectorAll("[data-message-id]")]
    .find(element =>
      element.dataset.messageId === String(message.id)
    );

  if (!wrapper) return;

  if (wrapper.querySelector(".message-edit-area")) return;

  const content = wrapper.querySelector(".message-content");
  if (!content) return;

  const editor = document.createElement("div");
  editor.className = "message-edit-area";

  const textarea = document.createElement("textarea");
  textarea.value = message.content || "";
  textarea.maxLength = 4000;
  textarea.rows = 3;

  const buttons = document.createElement("div");
  buttons.className = "message-tools";

  const save = document.createElement("button");
  save.type = "button";
  save.textContent = "Сохранить";

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Отмена";

  cancel.addEventListener("click", () => {
    editor.remove();
  });

  save.addEventListener("click", () => {
    const newContent = textarea.value.trim();

    if (!newContent) {
      alert("Сообщение не может быть пустым");
      return;
    }

    if (newContent.length > 4000) {
      alert("Сообщение слишком длинное");
      return;
    }

    if (!socket?.connected) {
      alert("Нет подключения к серверу");
      return;
    }

    save.disabled = true;

    socket.emit(
      "message:edit",
      {
        chatId: String(activeChat.id),
        messageId: message.id,
        content: newContent
      },
      (error, updated) => {
        save.disabled = false;

        if (error) {
          alert(typeof error === "string" ? error : error.message);
          return;
        }

        if (updated) {
          replaceMessage(updated);
        } else {
          alert("Сервер не вернул обновлённое сообщение");
        }
      }
    );
  });

  buttons.append(save, cancel);
  editor.append(textarea, buttons);

  content.after(editor);

  textarea.focus();
  textarea.setSelectionRange(
    textarea.value.length,
    textarea.value.length
  );
}

/* =========================================================
   УДАЛЕНИЕ СООБЩЕНИЙ
   ========================================================= */

function deleteMessage(message) {
  if (!socket?.connected || !activeChat) {
    alert("Нет подключения к серверу");
    return;
  }

  if (!confirm("Удалить это сообщение?")) return;

  socket.emit(
    "message:delete",
    {
      chatId: String(activeChat.id),
      messageId: message.id
    },
    (error, updated) => {
      if (error) {
        alert(error);
        return;
      }

      if (updated) {
        replaceMessage(updated);
      }
    }
  );
}

/* =========================================================
   ЗАМЕНА СООБЩЕНИЯ БЕЗ ПЕРЕМЕЩЕНИЯ В КОНЕЦ
   ========================================================= */

function replaceMessage(message) {
  if (
    !message ||
    !activeChat ||
    String(activeChat.id) !== String(message.chatId)
  ) {
    return;
  }

  const old = [...$("messages").querySelectorAll("[data-message-id]")]
    .find(element =>
      element.dataset.messageId === String(message.id)
    );

  const replacement = createMessageElement(message);

  if (old) {
    old.replaceWith(replacement);
  } else {
    $("messages").appendChild(replacement);
  }

  const chat = chats.find(
    item => String(item.id) === String(message.chatId)
  );

  if (
    chat?.lastMessage &&
    String(chat.lastMessage.id) === String(message.id)
  ) {
    chat.lastMessage = message;
    renderChats();
  }
}

function scrollMessagesToBottom() {
  const container = $("messages");
  if (container) {
    container.scrollTop = container.scrollHeight;
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Ошибка чтения файла"));

    reader.readAsDataURL(blob);
  });
}

/* =========================================================
   ОТПРАВКА СООБЩЕНИЙ И ОТВЕТОВ
   ========================================================= */

$("send-form").addEventListener("submit", event => {
  event.preventDefault();

  const content = $("message-input").value.trim();

  if (!content || !activeChat || !socket?.connected) {
    return;
  }

  const chatId = String(activeChat.id);
  const replyToMessageId = replyToMessage?.id || null;

  $("message-input").value = "";
  stopTyping();

  socket.emit(
    "message:send",
    {
      chatId,
      content,
      replyToMessageId
    },
    (error, sentMessage) => {
      if (error) {
        alert(error);
        $("message-input").value = content;
        return;
      }

      clearReply();

      if (sentMessage) {
        const chat = chats.find(
          item => String(item.id) === String(chatId)
        );

        if (chat) {
          chat.lastMessage = sentMessage;
          renderChats();
        }
      }
    }
  );
});

/* =========================================================
   ФОТОГРАФИИ
   ========================================================= */

$("photo-button").addEventListener("click", () => {
  if (!activeChat) {
    alert("Сначала открой чат");
    return;
  }

  $("photo-input").click();
});

$("photo-input").addEventListener("change", async () => {
  const file = $("photo-input").files[0];

  if (!file) return;

  $("photo-input").value = "";

  const allowed = [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif"
  ];

  if (!allowed.includes(file.type)) {
    alert("Поддерживаются JPG, PNG, WEBP и GIF");
    return;
  }

  if (file.size > 5 * 1024 * 1024) {
    alert("Фотография должна быть не больше 5 МБ");
    return;
  }

  if (!activeChat) return;

  const chatId = String(activeChat.id);

  try {
    const dataUrl = await blobToDataUrl(file);
    const base64 = dataUrl.split(",")[1];

    await api(`/api/chats/${encodeURIComponent(chatId)}/images`, {
      method: "POST",
      body: JSON.stringify({
        filename: file.name,
        mime: file.type,
        data: base64
      })
    });
  } catch (err) {
    alert(err.message);
  }
});

/* =========================================================
   СОЗДАНИЕ ЧАТОВ
   ========================================================= */

function openNewChatModal() {
  $("modal").classList.remove("hidden");
  showError("modal-error", "");
}

function closeNewChatModal() {
  $("modal").classList.add("hidden");
}

$("new-chat").addEventListener("click", openNewChatModal);
$("empty-new").addEventListener("click", openNewChatModal);
$("modal-close").addEventListener("click", closeNewChatModal);

document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(item => {
      item.classList.remove("active");
    });

    tab.classList.add("active");

    const group = tab.dataset.tab === "group";

    $("direct-panel").classList.toggle("hidden", group);
    $("group-panel").classList.toggle("hidden", !group);

    showError("modal-error", "");
  });
});

$("user-search").addEventListener("input", () => {
  clearTimeout(userSearchTimer);
  userSearchTimer = setTimeout(searchUsers, 300);
});

async function searchUsers() {
  const query = $("user-search").value.trim();
  const results = $("user-results");

  results.replaceChildren();

  if (query.length < 2) return;

  try {
    const users = await api(
      `/api/users?q=${encodeURIComponent(query)}`
    );

    for (const user of users) {
      const button = document.createElement("button");
      button.className = "user-result";
      button.appendChild(createUserLabel(user));

      button.addEventListener("click", async () => {
        try {
          const chat = await api("/api/chats/direct", {
            method: "POST",
            body: JSON.stringify({ userId: user.id })
          });

          await loadChats();
          closeNewChatModal();

          const found = chats.find(
            item => String(item.id) === String(chat.id)
          );

          if (found) await openChat(found);
        } catch (err) {
          showError("modal-error", err.message);
        }
      });

      results.appendChild(button);
    }

    if (!users.length) {
      const empty = document.createElement("p");
      empty.textContent = "Пользователи не найдены";
      results.appendChild(empty);
    }
  } catch (err) {
    showError("modal-error", err.message);
  }
}

/* =========================================================
   СОЗДАНИЕ ГРУППЫ
   ========================================================= */

$("create-group").addEventListener("click", async () => {
  showError("modal-error", "");

  const name = $("group-name").value.trim();

  const usernames = $("group-members").value
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);

  try {
    const chat = await api("/api/chats/group", {
      method: "POST",
      body: JSON.stringify({ name, usernames })
    });

    $("group-name").value = "";
    $("group-members").value = "";

    await loadChats();
    closeNewChatModal();

    const found = chats.find(
      item => String(item.id) === String(chat.id)
    );

    if (found) await openChat(found);
  } catch (err) {
    showError("modal-error", err.message);
  }
});

/* =========================================================
   УПРАВЛЕНИЕ ГАЛОЧКАМИ
   ========================================================= */

function openBadgeModal() {
  if (!badgeAdmin) return;

  $("badge-modal").classList.remove("hidden");
  $("badge-user-search").value = "";
  $("badge-user-results").replaceChildren();

  showError("badge-error", "");
  $("badge-user-search").focus();
}

function closeBadgeModal() {
  $("badge-modal").classList.add("hidden");
  $("badge-user-search").value = "";
  $("badge-user-results").replaceChildren();

  showError("badge-error", "");
}

$("badge-admin-button").addEventListener("click", openBadgeModal);
$("badge-modal-close").addEventListener("click", closeBadgeModal);

$("badge-user-search").addEventListener("input", () => {
  clearTimeout(badgeSearchTimer);
  badgeSearchTimer = setTimeout(searchBadgeUsers, 300);
});

async function searchBadgeUsers() {
  if (!badgeAdmin) return;

  const query = $("badge-user-search").value.trim();
  const results = $("badge-user-results");

  results.replaceChildren();
  showError("badge-error", "");

  if (query.length < 2) return;

  try {
    const users = await api(
      `/api/badges/users?q=${encodeURIComponent(query)}`
    );

    for (const user of users) {
      const row = document.createElement("div");
      row.className = "user-result";

      const name = createUserLabel(user);

      const button = document.createElement("button");
      button.type = "button";
      button.className = "primary";

      button.textContent = user.isVerified
        ? "Снять галочку"
        : "Выдать галочку";

      button.addEventListener("click", async () => {
        button.disabled = true;
        showError("badge-error", "");

        try {
          await api(
            `/api/badges/users/${encodeURIComponent(user.id)}`,
            {
              method: "PATCH",
              body: JSON.stringify({
                verified: !user.isVerified
              })
            }
          );

          user.isVerified = !user.isVerified;

          const updatedName = createUserLabel(user);
          name.replaceWith(updatedName);

          button.textContent = user.isVerified
            ? "Снять галочку"
            : "Выдать галочку";

          await loadChats();

          if (activeChat) {
            const updatedChat = chats.find(
              chat => String(chat.id) === String(activeChat.id)
            );

            if (updatedChat) {
              activeChat = updatedChat;
              await openChat(updatedChat);
            }
          }

          showError(
            "badge-error",
            user.isVerified ? "Галочка выдана." : "Галочка снята."
          );
        } catch (err) {
          showError("badge-error", err.message);
        } finally {
          button.disabled = false;
        }
      });

      row.append(name, button);
      results.appendChild(row);
    }

    if (!users.length) {
      const empty = document.createElement("p");
      empty.textContent = "Пользователи не найдены";
      results.appendChild(empty);
    }
  } catch (err) {
    showError("badge-error", err.message);
  }
}

/* =========================================================
   ВЫХОД
   ========================================================= */

$("logout").addEventListener("click", () => {
  stopTyping();

  if (socket) {
    socket.disconnect();
    socket = null;
  }

  localStorage.removeItem("nolink-token");

  token = null;
  currentUser = null;
  activeChat = null;
  chats = [];

  selectedChats.clear();
  badgeAdmin = false;
  replyToMessage = null;
  typingUsers.clear();

  $("badge-admin-button").classList.add("hidden");
  $("profile-modal").classList.add("hidden");

  closeBadgeModal();
  setAuthMode(false);
  showAuth();
});

/* =========================================================
   ВОССТАНОВЛЕНИЕ СЕССИИ
   ========================================================= */

async function restoreSession() {
  if (!token) {
    showAuth();
    return;
  }

  try {
    const result = await api("/api/me");
    currentUser = result.user;

    await enterApp();
  } catch (err) {
    localStorage.removeItem("nolink-token");
    token = null;
    showAuth();
  }
}

restoreSession();