const $ = id => document.getElementById(id);
let base = localStorage.getItem("nolink-server") || "http://localhost:3030";
let token = localStorage.getItem("nolink-token") || "";
let me = null, chats = [], activeChat = null, socket = null, registerMode = false;
$("server-url").value = base;

function setAuthMode(reg) {
  registerMode = reg;
  $("auth-title").textContent = reg ? "Создать аккаунт" : "С возвращением";
  $("username").classList.toggle("hidden", !reg);
  $("username-label").classList.toggle("hidden", !reg);
  $("username").required = reg;
  $("auth-submit").textContent = reg ? "Зарегистрироваться" : "Войти";
  $("auth-switch").textContent = reg ? "Уже есть аккаунт? Войти" : "Нет аккаунта? Зарегистрироваться";
  $("auth-error").textContent = "";
}
$("auth-switch").onclick = () => setAuthMode(!registerMode);
$("server-url").onchange = () => {
  base = $("server-url").value.trim().replace(/\/+$/, "");
  localStorage.setItem("nolink-server", base);
};
async function api(path, options={}) {
  const res = await fetch(base + path, {
    ...options,
    headers: {"Content-Type":"application/json", ...(token ? {Authorization:"Bearer "+token}:{}), ...(options.headers||{})}
  });
  const data = await res.json().catch(()=>({error:"Ошибка сервера"}));
  if (!res.ok) throw new Error(data.error || "Ошибка запроса");
  return data;
}
$("auth-form").onsubmit = async e => {
  e.preventDefault(); $("auth-error").textContent = "";
  base = $("server-url").value.trim().replace(/\/+$/, "");
  localStorage.setItem("nolink-server", base);
  try {
    const data = await api(registerMode ? "/api/auth/register" : "/api/auth/login", {
      method:"POST", body:JSON.stringify({
        username:$("username").value.trim(),
        email:$("email").value.trim(),
        password:$("password").value
      })
    });
    token = data.token; me = data.user;
    localStorage.setItem("nolink-token", token);
    showApp();
  } catch(err) {$("auth-error").textContent = err.message;}
};
function showApp() {
  $("auth").classList.add("hidden"); $("app").classList.remove("hidden");
  $("my-name").textContent = me.username; $("my-avatar").textContent = me.username[0].toUpperCase();
  connectSocket(); loadChats();
}
function connectSocket() {
  if (socket) socket.disconnect();
  socket = io(base, {auth:{token}});
  socket.on("connect_error", err => console.warn("NOLINK connection:", err.message));
  socket.on("message:new", msg => {
    const idx = chats.findIndex(c => c.id === msg.chatId);
    if (idx >= 0) {
      chats[idx].lastMessage = msg;
      chats.sort((a,b)=>(b.lastMessage?.createdAt||"").localeCompare(a.lastMessage?.createdAt||""));
      renderChats();
    }
    if (activeChat && activeChat.id === msg.chatId) appendMessage(msg);
  });
}
async function loadChats() {
  try { chats = await api("/api/chats"); renderChats(); }
  catch(err) {console.error(err);}
}
function chatName(c) {
  if (c.name) return c.name;
  const other = c.members.find(m=>m.id!==me.id);
  return other ? other.username : "Личный чат";
}
function renderChats() {
  const q = $("search").value.toLowerCase();
  $("chat-list").innerHTML = "";
  chats.filter(c=>chatName(c).toLowerCase().includes(q)).forEach(c=>{
    const el=document.createElement("div");
    el.className="chat-item"+(activeChat?.id===c.id?" active":"");
    const av=document.createElement("div"); av.className="avatar"; av.textContent=chatName(c)[0].toUpperCase();
    const meta=document.createElement("div"); meta.className="chat-meta";
    const b=document.createElement("b"); b.textContent=chatName(c);
    const small=document.createElement("small"); small.textContent=c.lastMessage?.content || (c.type==="group"?"Групповой чат":"Начните переписку");
    meta.append(b,small); el.append(av,meta); el.onclick=()=>openChat(c); $("chat-list").append(el);
  });
}
$("search").oninput=renderChats;
async function openChat(chat) {
  activeChat=chat; renderChats();
  $("empty-state").classList.add("hidden"); $("conversation").classList.remove("hidden");
  $("chat-title").textContent=chatName(chat);
  $("chat-subtitle").textContent=chat.type==="group" ? `${chat.members.length} участников` : "Личный чат";
  $("chat-avatar").textContent=chatName(chat)[0].toUpperCase();
  $("messages").innerHTML="";
  try {
    const msgs=await api(`/api/chats/${chat.id}/messages`);
    msgs.forEach(appendMessage);
    $("messages").scrollTop=$("messages").scrollHeight;
    socket.emit("chat:join", chat.id);
  } catch(err) {console.error(err);}
}
function appendMessage(m) {
  if (document.querySelector(`[data-message-id="${m.id}"]`)) return;
  const wrap=document.createElement("div"); wrap.className="message"+(m.userId===me.id?" mine":"");
  wrap.dataset.messageId=m.id;
  if (m.userId!==me.id) {const s=document.createElement("div");s.className="sender";s.textContent=m.username;wrap.append(s);}
  const body=document.createElement("div");body.className="body";body.textContent=m.content;
  const time=document.createElement("time");time.textContent=new Date(m.createdAt).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});
  wrap.append(body,time); $("messages").append(wrap); $("messages").scrollTop=$("messages").scrollHeight;
}
$("send-form").onsubmit=async e=>{
  e.preventDefault(); const content=$("message-input").value.trim();
  if(!content||!activeChat)return;
  $("message-input").value="";
  socket.emit("message:send",{chatId:activeChat.id,content},err=>{if(err){console.error(err);$("message-input").value=content;}});
};
function openModal() {$("modal").classList.remove("hidden");$("modal-error").textContent="";$("user-search").value="";$("user-results").innerHTML="";}
$("new-chat").onclick=openModal; $("empty-new").onclick=openModal;
$("modal-close").onclick=()=>$("modal").classList.add("hidden");
document.querySelectorAll(".tab").forEach(t=>t.onclick=()=>{
  document.querySelectorAll(".tab").forEach(x=>x.classList.toggle("active",x===t));
  $("direct-panel").classList.toggle("hidden",t.dataset.tab!=="direct");
  $("group-panel").classList.toggle("hidden",t.dataset.tab!=="group");
});
let searchTimer;
$("user-search").oninput=()=>{
  clearTimeout(searchTimer);
  searchTimer=setTimeout(async()=>{
    const q=$("user-search").value.trim(); if(q.length<2){$("user-results").innerHTML="";return;}
    try{
      const users=await api("/api/users?q="+encodeURIComponent(q));
      $("user-results").innerHTML="";
      users.forEach(u=>{
        const row=document.createElement("div");row.className="user-result";
        const name=document.createElement("b");name.textContent=u.username;
        const btn=document.createElement("button");btn.textContent="Написать";
        btn.onclick=async()=>{try{const c=await api("/api/chats/direct",{method:"POST",body:JSON.stringify({userId:u.id})});$("modal").classList.add("hidden");await loadChats();const found=chats.find(x=>x.id===c.id)||c; if(!found.members) await loadChats(); openChat(chats.find(x=>x.id===c.id)||c);}catch(e){$("modal-error").textContent=e.message;}};
        row.append(name,btn);$("user-results").append(row);
      });
    }catch(e){$("modal-error").textContent=e.message;}
  },250);
};
$("create-group").onclick=async()=>{
  try{
    const name=$("group-name").value.trim();
    const usernames=$("group-members").value.split(",").map(x=>x.trim()).filter(Boolean);
    const c=await api("/api/chats/group",{method:"POST",body:JSON.stringify({name,usernames})});
    $("modal").classList.add("hidden");await loadChats();openChat(chats.find(x=>x.id===c.id));
  }catch(e){$("modal-error").textContent=e.message;}
};
$("logout").onclick=()=>{token="";me=null;localStorage.removeItem("nolink-token");if(socket)socket.disconnect();$("app").classList.add("hidden");$("auth").classList.remove("hidden");};
async function restoreSession(){
  if(!token)return;
  try{const data=await api("/api/me");me=data.user;showApp();}catch(e){token="";localStorage.removeItem("nolink-token");}
}
setAuthMode(false); restoreSession();
