
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

const $ = id => document.getElementById(id);

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

function showAuth() {
  $("auth").classList.remove("hidden");
  $("app").classList.add("hidden");
}

function showApp() {
  $("auth").classList.add("hidden");
  $("app").classList.remove("hidden");

  $("my-name").textContent = currentUser.username;
  $("my-avatar").textContent =
    currentUser.username.charAt(0).toUpperCase();
}

function chatName(chat) {
  if (chat.type === "group") {
    return chat.name || "Группа";
  }

  const other = (chat.members || []).find(
    member => member.id !== currentUser.id
  );

  return other?.username || "Личный чат";
}

function escapeText(value) {
  return String(value ?? "");
}

// Переключение формы входа и регистрации
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

// Возврат к регистрации
$("back-to-auth").addEventListener("click", () => {
  setAuthMode(true);
});

// Вход и начало регистрации
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

    const body = {
      email,
      password
    };

    if (registerMode) {
      body.username = $("username").value.trim();
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

// Подтверждение кода и завершение регистрации
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

// Повторная отправка кода
$("resend-code").addEventListener("click", async () => {
  showError("auth-error", "");

  const button = $("resend-code");
  button.disabled = true;

  try {
    const result = await api("/api/auth/resend-code", {
      method: "POST",
      body: JSON.stringify({
        email: verificationEmail
      })
    });

    showError("auth-error", result.message || "Новый код отправлен.");
  } catch (err) {
    showError("auth-error", err.message);
  } finally {
    button.disabled = false;
  }
});

// Запуск приложения
async function enterApp() {
  showApp();
  connectSocket();
  await loadChats();
}

function connectSocket() {
  if (socket) {
    socket.disconnect();
  }

  socket = io(base, {
    auth: { token }
  });

  socket.on("connect_error", err => {
    console.error("Socket connection error:", err.message);
  });

  socket.on("message:new", message => {
    const chat = chats.find(c => c.id === message.chatId);

    if (chat) {
      chat.lastMessage = message;
    }

    renderChats();

    if (activeChat?.id === message.chatId) {
      appendMessage(message);
    }
  });

  socket.on("chat:created", async () => {
    await loadChats();
  });

  socket.on("chat:deleted", ({ chatId }) => {
    chats = chats.filter(chat => chat.id !== chatId);
    selectedChats.delete(chatId);

    if (activeChat?.id === chatId) {
      activeChat = null;
      $("conversation").classList.add("hidden");
      $("empty-state").classList.remove("hidden");
    }

    renderChats();
  });
}

// Загрузка чатов
async function loadChats() {
  try {
    chats = await api("/api/chats");
    renderChats();
  } catch (err) {
    console.error("Не удалось загрузить чаты:", err);
  }
}

// Форматирование времени
function formatChatTime(value) {
  if (!value) return "";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const now = new Date();

  const sameDay =
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear();

  if (sameDay) {
    return date.toLocaleTimeString("ru-RU", {
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  return date.toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit"
  });
}

// Список чатов
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

    if (activeChat?.id === chat.id) {
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

    const avatar = document.createElement("div");
    avatar.className = "chat-list-avatar";
    avatar.textContent =
      chatName(chat).charAt(0).toUpperCase();

    const content = document.createElement("div");
    content.className = "chat-item-content";

    const top = document.createElement("div");
    top.className = "chat-item-top";

    const title = document.createElement("b");
    title.className = "chat-item-title";
    title.textContent = chatName(chat);

    const time = document.createElement("small");
    time.className = "chat-item-time";

    if (chat.lastMessage?.createdAt) {
      time.textContent = formatChatTime(
        chat.lastMessage.createdAt
      );
    }

    top.append(title, time);

    const preview = document.createElement("small");
    preview.className = "chat-item-preview";

    if (!chat.lastMessage) {
      preview.textContent = "Нет сообщений";
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

// Выбор чатов
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

  $("select-chats").textContent = selectionMode
    ? "×"
    : "☑";

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

$("cancel-selection").addEventListener("click", () => {
  selectionMode = false;
  selectedChats.clear();
  renderChats();
});

$("select-all-chats").addEventListener("click", () => {
  const query = $("search").value.trim().toLowerCase();

  for (const chat of chats) {
    if (chatName(chat).toLowerCase().includes(query)) {
      selectedChats.add(chat.id);
    }
  }

  renderChats();
});

// Удаление чатов
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

      chats = chats.filter(chat => chat.id !== chatId);
      selectedChats.delete(chatId);

      if (activeChat?.id === chatId) {
        activeChat = null;
        $("conversation").classList.add("hidden");
        $("empty-state").classList.remove("hidden");
      }
    } catch (err) {
      errors.push(err.message);
    }
  }

  renderChats();

  if (errors.length) {
    showError(
      "delete-error",
      [...new Set(errors)].join(". ")
    );
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

// Открытие чата
async function openChat(chat) {
  activeChat = chat;

  $("empty-state").classList.add("hidden");
  $("conversation").classList.remove("hidden");

  $("chat-title").textContent = chatName(chat);
  $("chat-avatar").textContent =
    chatName(chat).charAt(0).toUpperCase();

  $("chat-subtitle").textContent =
    chat.type === "group"
      ? `${chat.members.length} участников`
      : "Личный чат";

  $("messages").replaceChildren();

  if (socket?.connected) {
    socket.emit("chat:join", chat.id);
  }

  renderChats();

  try {
    const messages = await api(
      `/api/chats/${encodeURIComponent(chat.id)}/messages`
    );

    if (activeChat?.id !== chat.id) return;

    $("messages").replaceChildren();

    for (const message of messages) {
      await appendMessage(message);
    }

    scrollMessagesToBottom();
  } catch (err) {
    console.error("Ошибка загрузки сообщений:", err);
  }
}

// Создание сообщения
async function appendMessage(message) {
  const container = $("messages");

  if (
    [...container.querySelectorAll("[data-message-id]")]
      .some(el => el.dataset.messageId === message.id)
  ) {
    return;
  }

  const wrapper = document.createElement("div");
  wrapper.className = "message";
  wrapper.dataset.messageId = message.id;

  if (message.userId === currentUser.id) {
    wrapper.classList.add("mine");
  }

  const author = document.createElement("b");
  author.className = "message-author";
  author.textContent = message.userId === currentUser.id
    ? "Вы"
    : message.username || "Пользователь";

  const content = document.createElement("div");
  content.className = "message-content";

  if (message.attachmentId) {
    const image = document.createElement("img");
    image.className = "message-image";
    image.alt = "Фотография";
    image.loading = "lazy";

    try {
      const response = await fetch(
        `${base}/api/attachments/${encodeURIComponent(message.attachmentId)}`,
        {
          headers: {
            Authorization: `Bearer ${token}`
          }
        }
      );

      if (!response.ok) {
        throw new Error("Не удалось загрузить фотографию");
      }

      const blob = await response.blob();
      image.src = await blobToDataUrl(blob);
      content.appendChild(image);
    } catch (err) {
      const errorText = document.createElement("span");
      errorText.textContent =
        "📷 Не удалось загрузить фотографию";
      content.appendChild(errorText);
    }
  } else {
    content.textContent = escapeText(message.content);
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
  container.appendChild(wrapper);

  scrollMessagesToBottom();
}

function scrollMessagesToBottom() {
  const container = $("messages");
  container.scrollTop = container.scrollHeight;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Ошибка чтения файла"));

    reader.readAsDataURL(blob);
  });
}

// Отправка текстового сообщения
$("send-form").addEventListener("submit", event => {
  event.preventDefault();

  const content = $("message-input").value.trim();

  if (!content || !activeChat || !socket?.connected) {
    return;
  }

  $("message-input").value = "";

  socket.emit(
    "message:send",
    {
      chatId: activeChat.id,
      content
    },
    error => {
      if (error) {
        alert(error);
        $("message-input").value = content;
      }
    }
  );
});

// Фотографии
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

  const chatId = activeChat.id;

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

// Создание чата
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

// Вкладки
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => {
      t.classList.remove("active");
    });

    tab.classList.add("active");

    const group = tab.dataset.tab === "group";

    $("direct-panel").classList.toggle("hidden", group);
    $("group-panel").classList.toggle("hidden", !group);

    showError("modal-error", "");
  });
});

// Поиск пользователей
let userSearchTimer = null;

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
      button.textContent = user.username;

      button.addEventListener("click", async () => {
        try {
          const chat = await api("/api/chats/direct", {
            method: "POST",
            body: JSON.stringify({
              userId: user.id
            })
          });

          await loadChats();
          closeNewChatModal();

          const found = chats.find(c => c.id === chat.id);
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

// Создание группы
$("create-group").addEventListener("click", async () => {
  showError("modal-error", "");

  const name = $("group-name").value.trim();

  const usernames = $("group-members").value
    .split(",")
    .map(name => name.trim())
    .filter(Boolean);

  try {
    const chat = await api("/api/chats/group", {
      method: "POST",
      body: JSON.stringify({
        name,
        usernames
      })
    });

    $("group-name").value = "";
    $("group-members").value = "";

    await loadChats();
    closeNewChatModal();

    const found = chats.find(c => c.id === chat.id);
    if (found) await openChat(found);
  } catch (err) {
    showError("modal-error", err.message);
  }
});

// Выход
$("logout").addEventListener("click", () => {
  if (socket) socket.disconnect();

  localStorage.removeItem("nolink-token");

  token = null;
  currentUser = null;
  activeChat = null;
  chats = [];
  selectedChats.clear();

  setAuthMode(false);
  showAuth();
});

// Восстановление сессии
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
