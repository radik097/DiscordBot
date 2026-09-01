const SELECTED_GUILD_KEY = "discordBot.selectedGuild";
let savedGuildId = null;
try {
  savedGuildId = localStorage.getItem(SELECTED_GUILD_KEY);
} catch {}
const state = {
  guildId: savedGuildId,
  config: null,
  playlists: [],
  musicHistory: [],
  activePlaylistId: null,
  mobileQueueLimit: 20,
  csrfToken: null,
  stagingMode: false,
};

function applyStagingMode(enabled) {
  state.stagingMode = Boolean(enabled);
  for (const panelName of ["music", "cache-history", "playlists", "voice"]) {
    const panel = document.querySelector(`[data-panel="${panelName}"]`);
    const mobileButton = document.querySelector(`[data-mobile-panel="${panelName}"]`);
    if (panel) panel.hidden = state.stagingMode;
    if (mobileButton) mobileButton.hidden = state.stagingMode;
  }
}

function updateMobileQueueWindow() {
  const items = [...document.querySelectorAll("#musicQueue > li")];
  const mobile = window.matchMedia("(max-width: 720px)").matches;
  for (const [index, item] of items.entries()) item.hidden = mobile && index >= state.mobileQueueLimit;
  const more = document.getElementById("musicQueueMore");
  more.hidden = !mobile || state.mobileQueueLimit >= items.length;
  if (!more.hidden) more.textContent = `Показать ещё · ${items.length - state.mobileQueueLimit}`;
}

document.getElementById("musicQueueMore").addEventListener("click", () => {
  state.mobileQueueLimit += 25;
  updateMobileQueueWindow();
});
window.matchMedia("(max-width: 720px)").addEventListener("change", updateMobileQueueWindow);

const phoneDialog = document.getElementById("phoneDialog");
const phoneButton = document.getElementById("phoneConnectBtn");
const isLocalPanel = ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
if (!isLocalPanel && !window.DISCORD_BOT_DEMO) phoneButton.hidden = true;

function renderPhoneAccess(data) {
  const qr = document.getElementById("phoneQr");
  const url = document.getElementById("phoneUrl");
  const disable = document.getElementById("phoneDisable");
  qr.hidden = !data.qrSvg;
  qr.innerHTML = data.qrSvg ?? "";
  url.hidden = !data.publicUrl;
  url.href = data.publicUrl ?? "#";
  url.textContent = data.publicUrl ?? "";
  disable.hidden = !data.enabled;
  document.getElementById("phoneStart").textContent = data.enabled ? "Новый QR-код" : "Создать QR-код";
  const providerName = data.provider === "cloudflare" ? "Cloudflare" : "ngrok";
  document.getElementById("phoneHint").textContent = data.pairExpiresAt
    ? data.qrSvg
      ? `QR-токен действует до ${new Date(data.pairExpiresAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}. Перезагрузка страницы не меняет токен — новый создаётся только кнопкой «Новый QR-код». Провайдер: ${providerName}.`
      : `Ранее созданный QR-токен продолжает действовать до ${new Date(data.pairExpiresAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}, но QR не хранится после перезагрузки страницы. Чтобы показать новый QR, нажмите «Новый QR-код».`
    : data.configured === false
      ? data.provider === "cloudflare"
        ? "Добавьте PUBLIC_BASE_URL и CLOUDFLARE_TUNNEL_TOKEN в .env, затем запустите server-профиль."
        : data.provider === "disabled"
          ? "Удалённый доступ отключён в .env."
          : "Добавьте NGROK_AUTHTOKEN в .env и перезапустите Docker."
      : "Нажмите «Создать QR-код», затем отсканируйте его телефоном.";
  renderPhoneDevices(data.devices ?? []);
}

function renderPhoneDevices(devices) {
  const list = document.getElementById("phoneDevicesList");
  const reset = document.getElementById("phoneResetSessions");
  list.innerHTML = "";
  reset.hidden = devices.length === 0;
  if (!devices.length) {
    const empty = document.createElement("span");
    empty.className = "hint";
    empty.textContent = "Нет активных сессий.";
    list.appendChild(empty);
    return;
  }
  for (const device of devices) {
    const row = document.createElement("div");
    row.className = "phone-device";
    const details = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = device.name;
    const meta = document.createElement("span");
    meta.textContent = `Подключено ${new Date(device.createdAt).toLocaleString("ru-RU")} · активно ${new Date(device.lastSeenAt).toLocaleString("ru-RU")}${device.ip ? ` · IP ${device.ip}` : ""}`;
    details.append(name, meta);
    const revoke = document.createElement("button");
    revoke.type = "button";
    revoke.className = "danger phone-device-revoke";
    revoke.dataset.sessionId = device.id;
    revoke.textContent = "Отключить";
    row.append(details, revoke);
    list.appendChild(row);
  }
}

phoneButton.addEventListener("click", async () => {
  document.getElementById("phoneError").textContent = "";
  phoneDialog.showModal();
  try { renderPhoneAccess(await api("/api/remote-access")); }
  catch (err) { document.getElementById("phoneError").textContent = err.message; }
});
document.getElementById("phoneStart").addEventListener("click", async () => {
  const error = document.getElementById("phoneError");
  error.textContent = "Запускаю защищённый туннель…";
  try { renderPhoneAccess(await api("/api/remote-access", { method: "POST" })); error.textContent = ""; }
  catch (err) { error.textContent = err.message; }
});
document.getElementById("phoneDisable").addEventListener("click", async () => {
  const error = document.getElementById("phoneError");
  try { await api("/api/remote-access", { method: "DELETE" }); renderPhoneAccess({ enabled: false }); error.textContent = "Доступ отключён, мобильные сессии отозваны."; }
  catch (err) { error.textContent = err.message; }
});
document.getElementById("phoneDevicesList").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-session-id]");
  if (!button) return;
  const error = document.getElementById("phoneError");
  button.disabled = true;
  try {
    await api(`/api/remote-access/sessions/${encodeURIComponent(button.dataset.sessionId)}`, { method: "DELETE" });
    renderPhoneAccess(await api("/api/remote-access"));
    error.textContent = "Сессия устройства сброшена.";
  } catch (err) { error.textContent = err.message; button.disabled = false; }
});
document.getElementById("phoneResetSessions").addEventListener("click", async () => {
  const error = document.getElementById("phoneError");
  try {
    const result = await api("/api/remote-access/sessions", { method: "DELETE" });
    renderPhoneAccess(await api("/api/remote-access"));
    error.textContent = `Сброшено сессий: ${result.removed}.`;
  } catch (err) { error.textContent = err.message; }
});

async function api(path, opts) {
  const method = (opts?.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    if (!state.csrfToken) {
      const tokenPayload = await api("/api/csrf");
      state.csrfToken = tokenPayload.token || null;
    }
  }

  const controller = new AbortController();
  const timeoutMs = opts?.timeoutMs ?? (opts?.method && opts.method !== "GET" ? 120000 : 30000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    const headers = { "content-type": "application/json", ...(opts?.headers ?? {}) };
    if (method !== "GET" && method !== "HEAD" && state.csrfToken) {
      headers["x-csrf-token"] = state.csrfToken;
    }
    res = await fetch(path, {
      ...opts,
      signal: opts?.signal ?? controller.signal,
      method,
      headers,
    });
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`Таймаут запроса (${Math.round(timeoutMs / 1000)} с)`);
    throw err;
  } finally {
    clearTimeout(timeout);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (!opts?._retryCsrf && res.status === 403 && method !== "GET" && (data?.error || "").includes("CSRF")) {
      state.csrfToken = null;
      const retryToken = await api("/api/csrf");
      state.csrfToken = retryToken.token || null;
      return api(path, { ...opts, _retryCsrf: true });
    }
    const error = new Error(data.error || data.errors?.join(", ") || `HTTP ${res.status}`);
    error.status = res.status;
    throw error;
  }
  if (data?.token) {
    state.csrfToken = data.token;
  }
  return data;
}

const accessAdminButton = document.getElementById("accessAdminBtn");
const accessAdminDialog = document.getElementById("accessAdminDialog");

function accessKindLabel(kind) {
  return kind === "owner" ? "владелец" : kind === "day" ? "доступ на 24 часа" : kind === "permanent" ? "постоянный аккаунт" : kind;
}

async function loadAccessIdentity() {
  const me = await api("/api/access/me");
  const label = document.getElementById("accessIdentity");
  label.textContent = me.email
    ? `🔐 ${me.email} · ${accessKindLabel(me.kind)}`
    : "🔒 вход не выполнен";
  label.title = me.expiresAt ? `Сессия до ${fmtTime(me.expiresAt)}` : "";
  accessAdminButton.hidden = !me.owner;
  phoneButton.hidden = !me.owner || (!isLocalPanel && !window.DISCORD_BOT_DEMO);
  return me;
}

function renderAccessRows(container, rows, type) {
  container.innerHTML = "";
  if (!rows.length) {
    const empty = document.createElement("span");
    empty.className = "hint";
    empty.textContent = type === "account" ? "Нет постоянных аккаунтов." : "Нет активных сессий.";
    container.appendChild(empty);
    return;
  }
  for (const item of rows) {
    const row = document.createElement("div");
    row.className = "phone-device";
    const details = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = item.email;
    const meta = document.createElement("span");
    meta.textContent = type === "account"
      ? `Создан ${fmtTime(item.createdAt)}${item.revokedAt ? ` · отозван ${fmtTime(item.revokedAt)}` : ""}`
      : `${accessKindLabel(item.kind)} · ${item.device} · активно ${fmtTime(item.lastSeenAt)} · до ${fmtTime(item.expiresAt)}`;
    details.append(title, meta);
    const revoke = document.createElement("button");
    revoke.type = "button";
    revoke.className = "danger phone-device-revoke";
    revoke.dataset.accessType = type;
    revoke.dataset.accessId = item.id;
    revoke.textContent = "Отозвать";
    if (type === "account" && item.revokedAt) revoke.disabled = true;
    row.append(details, revoke);
    container.appendChild(row);
  }
}

async function loadAccessAdmin() {
  const data = await api("/api/access/admin");
  renderAccessRows(document.getElementById("accessAccounts"), data.accounts || [], "account");
  renderAccessRows(document.getElementById("accessSessions"), data.sessions || [], "session");
}

accessAdminButton.addEventListener("click", async () => {
  accessAdminDialog.showModal();
  document.getElementById("accessAdminError").textContent = "";
  try { await loadAccessAdmin(); }
  catch (error) { document.getElementById("accessAdminError").textContent = error.message; }
});

document.getElementById("accessInvitePermanent").addEventListener("click", async () => {
  const error = document.getElementById("accessAdminError");
  const result = document.getElementById("accessInviteResult");
  error.textContent = "";
  result.hidden = true;
  try {
    const email = document.getElementById("accessInviteEmail").value.trim();
    const invite = await api("/api/access/admin/invites", { method: "POST", body: JSON.stringify({ email, kind: "permanent" }) });
    result.innerHTML = "";
    const text = document.createElement("strong");
    text.textContent = `Ссылка для ${invite.email} (до ${fmtTime(invite.expiresAt)}):`;
    const link = document.createElement("a");
    link.className = "access-link";
    link.href = invite.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = invite.url;
    result.append(text, link);
    result.hidden = false;
    await loadAccessAdmin();
  } catch (err) { error.textContent = err.message; }
});

accessAdminDialog.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-access-id]");
  if (!button) return;
  button.disabled = true;
  const error = document.getElementById("accessAdminError");
  try {
    const resource = button.dataset.accessType === "account" ? "accounts" : "sessions";
    await api(`/api/access/admin/${resource}/${encodeURIComponent(button.dataset.accessId)}`, { method: "DELETE" });
    await loadAccessAdmin();
    error.textContent = "Доступ отозван.";
  } catch (err) {
    error.textContent = err.message;
    button.disabled = false;
  }
});

document.getElementById("accessLogoutBtn").addEventListener("click", async () => {
  try { await api("/api/access/logout", { method: "POST", body: "{}" }); } catch {}
  location.assign("/login");
});

function fmtDuration(sec) {
  sec = Math.floor(sec || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function fmtTime(ts) {
  return new Date(ts).toLocaleString("ru-RU");
}

// --- Status / guild selector -------------------------------------------

async function loadStatus() {
  const status = await api("/api/status");
  applyStagingMode(status.stagingMode);
  document.getElementById("botTag").textContent = status.ready && status.tag ? `🟢 ${status.tag}` : "🔴 не в сети";
  document.getElementById("uptime").textContent = `аптайм: ${Math.floor(status.uptimeSec / 60)} мин`;

  const select = document.getElementById("guildSelect");
  select.innerHTML = "";
  for (const g of status.guilds) {
    const opt = document.createElement("option");
    opt.value = g.id;
    opt.textContent = `${g.name} (${g.memberCount})`;
    select.appendChild(opt);
  }
  if (!status.guilds.some((guild) => guild.id === state.guildId)) {
    state.guildId = status.guilds[0]?.id ?? null;
  }
  select.value = state.guildId;

  const info = status.guilds.find((g) => g.id === state.guildId);
  document.getElementById("guildInfo").innerHTML = info
    ? `<b>${escapeHtml(info.name)}</b><br/>ID: ${escapeHtml(info.id)}<br/>Участников: ${Number(info.memberCount) || 0}`
    : "Бот не состоит ни в одном сервере.";
}

async function settleTasks(tasks, context) {
  const results = await Promise.allSettled(tasks);
  for (const result of results) {
    if (result.status === "rejected") console.warn(`[${context}]`, result.reason);
  }
}

document.getElementById("guildSelect").addEventListener("change", async (e) => {
  disableMusicMonitor("Мониторинг выключен после смены сервера.");
  state.guildId = e.target.value;
  state.playlists = [];
  const playlistDialog = document.getElementById("playlistNameDialog");
  if (playlistDialog.open) playlistDialog.close();
  try {
    localStorage.setItem(SELECTED_GUILD_KEY, state.guildId);
  } catch {}
  lastQueueSignature = "";
  await settleTasks(
    [loadStatus(), loadMusic(), loadMusicHistory(), loadPlaylists(), loadMusicChannels(), loadVoiceChannels(), loadModeration(), loadMembers(), loadStats(), loadHistoryChannels(), loadTranscriptionChannels(), loadTranscriptions()],
    "guild-change",
  );
});

// --- Config -------------------------------------------------------------

async function loadConfigEditor() {
  state.config = await api("/api/config");
  document.getElementById("configEditor").value = JSON.stringify(state.config, null, 2);
}

document.getElementById("btnValidate").addEventListener("click", async () => {
  const errEl = document.getElementById("configErrors");
  try {
    const parsed = JSON.parse(document.getElementById("configEditor").value);
    const { errors } = await api("/api/config/validate", { method: "POST", body: JSON.stringify(parsed) });
    errEl.textContent = errors.length ? errors.join("\n") : "✅ Всё ок.";
  } catch (err) {
    errEl.textContent = "Ошибка: " + err.message;
  }
});

document.getElementById("btnSave").addEventListener("click", async () => {
  const errEl = document.getElementById("configErrors");
  try {
    const parsed = JSON.parse(document.getElementById("configEditor").value);
    await api("/api/config", { method: "PUT", body: JSON.stringify(parsed) });
    errEl.textContent = "✅ Сохранено в config/structure.json на диске бота.";
  } catch (err) {
    errEl.textContent = "Ошибка: " + err.message;
  }
});

document.getElementById("btnBuild").addEventListener("click", async () => {
  const logEl = document.getElementById("configLog");
  logEl.textContent = "Выполняю build...";
  try {
    const { log } = await api("/api/config/build", { method: "POST", body: JSON.stringify({ guildId: state.guildId }) });
    logEl.textContent = log.join("\n");
  } catch (err) {
    logEl.textContent = "Ошибка: " + err.message;
  }
});

document.getElementById("btnWipe").addEventListener("click", async () => {
  const confirmed = document.getElementById("wipeConfirm").checked;
  const logEl = document.getElementById("configLog");
  if (!confirmed) {
    logEl.textContent = "Отметь чекбокс подтверждения перед wipe.";
    return;
  }
  if (!confirm("Точно удалить ВСЕ каналы и роли на выбранном сервере?")) return;
  logEl.textContent = "Выполняю wipe...";
  try {
    const { log } = await api("/api/config/wipe", { method: "POST", body: JSON.stringify({ guildId: state.guildId, confirm: true }) });
    logEl.textContent = log.join("\n");
  } catch (err) {
    logEl.textContent = "Ошибка: " + err.message;
  }
});

// --- Music ---------------------------------------------------------------

async function loadMusicChannels() {
  if (!state.guildId) return;
  const channels = await api(`/api/guilds/${state.guildId}/voice-channels`);
  const select = document.getElementById("musicChannel");
  const prev = select.value;
  select.innerHTML = "";
  for (const c of channels) {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.name;
    select.appendChild(opt);
  }
  if (prev) select.value = prev;
}

document.getElementById("musicPlay").addEventListener("click", async () => {
  const errEl = document.getElementById("musicError");
  const query = document.getElementById("musicQuery").value.trim();
  if (!query) return (errEl.textContent = "Вставь ссылку на YouTube или запрос.");
  if (musicMonitorEnabled) {
    errEl.textContent = "Готовлю трек для прослушивания в браузере...";
    try {
      await prepareBrowserMonitor(query);
      document.getElementById("musicQuery").value = "";
    } catch (err) {
      errEl.textContent = "Ошибка мониторинга: " + err.message;
    }
    return;
  }
  const channelId = document.getElementById("musicChannel").value;
  if (!channelId) return (errEl.textContent = "На сервере нет голосовых каналов.");
  errEl.textContent = "Обрабатываю трек или плейлист...";
  try {
    const result = await api(`/api/music/${state.guildId}/play`, { method: "POST", body: JSON.stringify({ query, channelId }) });
    errEl.textContent = result.kind === "playlist"
      ? `✅ Плейлист «${result.title}»: добавлено ${result.addedCount} треков`
      : `✅ ${result.track.title}`;
    document.getElementById("musicQuery").value = "";
  } catch (err) {
    errEl.textContent = "Ошибка: " + err.message;
  }
  loadMusic();
});

const PLAYBACK_STATE_LABELS = {
  stable: "● Стабильно",
  warning: "● Нестабильно",
  buffering: "● Буферизация",
  connecting: "● Подключение",
  loading: "● Загрузка",
  paused: "● Пауза",
  idle: "● Ожидание",
};
const PLAYER_STATE_LABELS = {
  playing: "Играет",
  paused: "Пауза",
  buffering: "Буферизация",
  autopaused: "Автопауза",
  idle: "Ожидание",
};
const VOICE_STATE_LABELS = {
  ready: "Готово",
  connecting: "Подключение",
  signalling: "Согласование",
  disconnected: "Отключено",
  destroyed: "Завершено",
};

const musicMonitor = document.getElementById("musicMonitor");
const musicMonitorAudio = document.getElementById("musicMonitorAudio");
const musicMonitorButton = document.getElementById("musicMonitorToggle");
const musicMonitorStatus = document.getElementById("musicMonitorStatus");
let musicMonitorEnabled = false;
let musicMonitorSignature = "";
let latestMusicSnapshot = null;
let preparedMusicMonitor = null;

function releaseMonitorAudio() {
  musicMonitorAudio.pause();
  musicMonitorAudio.removeAttribute("src");
  musicMonitorAudio.load();
  musicMonitorSignature = "";
}

function disableMusicMonitor(message = "Мониторинг выключен.") {
  musicMonitorEnabled = false;
  preparedMusicMonitor = null;
  releaseMonitorAudio();
  musicMonitor.hidden = true;
  musicMonitorButton.textContent = "🎧 Включить мониторинг";
  musicMonitorButton.classList.remove("primary");
  musicMonitorStatus.textContent = message;
  document.getElementById("musicChannel").disabled = false;
  document.getElementById("musicPlay").textContent = "▶️ Включить";
}

async function prepareBrowserMonitor(query) {
  const prepared = await api(`/api/music/${state.guildId}/monitor/prepare`, {
    method: "POST",
    body: JSON.stringify({ query }),
  });
  preparedMusicMonitor = {
    sourceId: prepared.sourceId,
    track: prepared.track,
    expiresAt: prepared.expiresAt,
    volumePercent: Number(document.getElementById("musicVolume").value) || 0,
  };
  musicMonitorSignature = "";
  document.getElementById("musicError").textContent = `✅ «${prepared.track.title}» готов к прослушиванию без Discord`;
  await syncMusicMonitor(latestMusicSnapshot);
}

async function syncMusicMonitor(data) {
  if (!musicMonitorEnabled) return;
  const track = preparedMusicMonitor?.track ?? data?.playing;
  const preparedSourceId = preparedMusicMonitor?.sourceId;
  if (!preparedSourceId && !track?.queueId) {
    if (musicMonitorAudio.hasAttribute("src")) releaseMonitorAudio();
    musicMonitorStatus.textContent = "Введите трек или ссылку и нажмите «Слушать».";
    return;
  }

  const volumePercent = preparedSourceId
    ? preparedMusicMonitor.volumePercent
    : Math.round((Number(data?.volume) || 0) * 100);
  const trackKey = preparedSourceId ?? track.queueId;
  const signature = `${state.guildId}:${trackKey}:${volumePercent}`;
  if (signature === musicMonitorSignature) return;
  musicMonitorSignature = signature;
  const params = new URLSearchParams({
    volume: String(volumePercent),
    nonce: String(Date.now()),
  });
  if (preparedSourceId) params.set("source", preparedSourceId);
  else params.set("track", track.queueId);
  musicMonitorAudio.src = `/api/music/${encodeURIComponent(state.guildId)}/monitor?${params}`;
  musicMonitorAudio.volume = 1;
  musicMonitorAudio.load();
  musicMonitorStatus.textContent = `Подключение к «${track.title}» с громкостью ${volumePercent}%…`;
  try {
    await musicMonitorAudio.play();
    musicMonitorStatus.textContent = `Слушаете «${track.title}» · серверная громкость ${volumePercent}%`;
  } catch {
    musicMonitorStatus.textContent = `Поток готов · громкость ${volumePercent}%. Нажмите ▶ в плеере.`;
  }
}

musicMonitorButton.addEventListener("click", () => {
  if (musicMonitorEnabled) {
    disableMusicMonitor();
    return;
  }
  musicMonitorEnabled = true;
  musicMonitor.hidden = false;
  musicMonitorButton.textContent = "🎧 Выключить мониторинг";
  musicMonitorButton.classList.add("primary");
  document.getElementById("musicChannel").disabled = true;
  document.getElementById("musicPlay").textContent = "🎧 Слушать";
  if (window.DISCORD_BOT_DEMO) {
    musicMonitorStatus.textContent = "Прямой аудиопоток недоступен в демо-режиме.";
    return;
  }
  void syncMusicMonitor(latestMusicSnapshot);
});

musicMonitorAudio.addEventListener("playing", () => {
  if (musicMonitorEnabled) musicMonitorStatus.textContent = "Прямой поток активен · воспроизведение";
});
musicMonitorAudio.addEventListener("error", () => {
  if (musicMonitorEnabled && musicMonitorAudio.hasAttribute("src")) {
    musicMonitorStatus.textContent = "Не удалось открыть прямой поток. Повторите подготовку трека.";
  }
});

let musicLoadInFlight = false;
let lastQueueSignature = "";

const PLAYLIST_SAVE_LABELS = {
  running: "Скачивание идёт в фоне",
  completed: "Плейлист сохранён локально",
  completed_with_errors: "Сохранено с ошибками",
  failed: "Не удалось сохранить плейлист",
};

const PLAYLIST_TRACK_STATUS = {
  pending: "ожидает",
  downloading: "скачивается",
  cached: "в кэше",
  downloaded: "скачан",
  failed: "ошибка",
};

function playlistDate(timestamp) {
  return timestamp ? new Date(timestamp).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" }) : "—";
}

async function loadPlaylistDetails(details, playlistId) {
  const guildId = state.guildId;
  const body = details.querySelector(".playlist-details");
  if (!body || body.dataset.loaded === "true") return;
  body.textContent = "Загружаю треки…";
  try {
    const { playlist } = await api(`/api/music/${guildId}/playlists/${encodeURIComponent(playlistId)}`);
    if (guildId !== state.guildId || !details.isConnected) return;
    body.textContent = "";
    const summary = document.createElement("div");
    summary.className = "hint";
    const resumeTrack = playlist.playback?.tracks?.[0];
    const resumeLabel = resumeTrack
      ? ` · продолжение: ${resumeTrack.title} с ${fmtDuration(resumeTrack.startTimeSec)}`
      : " · запуск с начала";
    summary.textContent = `ID: ${playlist.id} · ${playlist.completed || 0} из ${playlist.total || 0} обработано · сохранено ${playlistDate(playlist.updatedAt)}${resumeLabel}`;
    const actions = document.createElement("div");
    actions.className = "playlist-actions";
    const activate = document.createElement("button");
    activate.type = "button";
    activate.dataset.activatePlaylistId = playlist.id;
    activate.textContent = state.activePlaylistId === playlist.id ? "▶ Сейчас играет" : "▶ Переключиться";
    activate.disabled = state.activePlaylistId === playlist.id;
    actions.appendChild(activate);
    const tracks = document.createElement("ol");
    tracks.className = "playlist-tracks";
    for (const track of playlist.tracks) {
      const item = document.createElement("li");
      const start = Number(track.startTimeSec) > 0 ? ` · старт ${fmtDuration(track.startTimeSec)}` : "";
      item.textContent = `${track.title} (${fmtDuration(track.durationSec)})${start} · ${PLAYLIST_TRACK_STATUS[track.status] ?? track.status ?? "неизвестно"}`;
      tracks.appendChild(item);
    }
    body.append(summary, actions, tracks);
    body.dataset.loaded = "true";
  } catch (err) {
    body.textContent = `Ошибка загрузки: ${err.message}`;
  }
}

function renderSavedPlaylists(playlists) {
  const root = document.getElementById("savedPlaylists");
  const openIds = new Set([...root.querySelectorAll("details[open]")].map((item) => item.dataset.playlistId));
  root.textContent = "";
  document.getElementById("savedPlaylistCount").textContent = playlists.length;

  if (!playlists.length) {
    const empty = document.createElement("div");
    empty.className = "playlist-empty";
    empty.textContent = "Сохранённых плейлистов пока нет.";
    root.appendChild(empty);
    return;
  }

  for (const playlist of playlists) {
    const details = document.createElement("details");
    details.className = "saved-playlist";
    details.dataset.playlistId = playlist.id;

    const summary = document.createElement("summary");
    summary.className = "playlist-summary";
    const main = document.createElement("span");
    main.className = "playlist-summary-main";
    const chevron = document.createElement("span");
    chevron.className = "playlist-chevron";
    chevron.textContent = "›";
    const text = document.createElement("span");
    text.style.minWidth = "0";
    const title = document.createElement("span");
    title.className = "playlist-title";
    title.textContent = playlist.title;
    const meta = document.createElement("span");
    meta.className = "playlist-meta";
    const activeLabel = state.activePlaylistId === playlist.id ? " · ▶ активен" : "";
    meta.textContent = `ID: ${playlist.id} · ${playlist.total || 0} треков${activeLabel} · ${playlistDate(playlist.updatedAt)}`;
    text.append(title, meta);
    main.append(chevron, text);

    const status = document.createElement("span");
    status.className = `playlist-status ${playlist.status || ""}`;
    status.textContent = PLAYLIST_SAVE_LABELS[playlist.status] ?? playlist.status ?? "сохранён";
    summary.append(main, status);

    const body = document.createElement("div");
    body.className = "playlist-details";
    body.textContent = "Откройте плейлист, чтобы загрузить список треков.";
    details.append(summary, body);
    details.addEventListener("toggle", () => {
      if (details.open) void loadPlaylistDetails(details, playlist.id);
    });
    root.appendChild(details);

    if (openIds.has(playlist.id)) {
      details.open = true;
      void loadPlaylistDetails(details, playlist.id);
    }
  }
}

async function loadPlaylists() {
  if (!state.guildId) return;
  const guildId = state.guildId;
  try {
    const { playlists, activePlaylistId } = await api(`/api/music/${guildId}/playlists`);
    if (guildId !== state.guildId) return;
    state.playlists = playlists;
    state.activePlaylistId = activePlaylistId;
    renderSavedPlaylists(playlists);
    document.getElementById("savedPlaylistsError").textContent = "";
  } catch (err) {
    document.getElementById("savedPlaylistsError").textContent = `Ошибка обновления: ${err.message}`;
  }
}

function renderPlaylistSave(save, hasTracks) {
  const button = document.getElementById("musicSavePlaylist");
  const card = document.getElementById("musicSaveStatus");
  const running = save?.status === "running";
  button.disabled = !hasTracks || running;
  button.textContent = running ? "⏳ Сохраняется…" : "💾 Сохранить плейлист";

  if (!save) {
    card.hidden = true;
    return;
  }

  card.hidden = false;
  const total = Math.max(0, Number(save.total) || 0);
  const completed = Math.max(0, Number(save.completed) || 0);
  const percent = total ? Math.min(100, (completed / total) * 100) : 0;
  document.getElementById("musicSaveTitle").textContent = PLAYLIST_SAVE_LABELS[save.status] ?? save.status;
  document.getElementById("musicSaveNumbers").textContent = `${completed} / ${total}`;
  const progress = document.getElementById("musicSaveProgress");
  progress.style.width = `${percent}%`;
  progress.parentElement.setAttribute("aria-valuenow", percent.toFixed(1));

  const parts = [
    `скачано: ${Number(save.downloaded) || 0}`,
    `уже было в кэше: ${Number(save.alreadyCached) || 0}`,
  ];
  if (save.failed) parts.push(`ошибок: ${save.failed}`);
  if (running && save.currentTitle) parts.push(`сейчас: ${save.currentTitle}`);
  else if (save.relativeManifest) parts.push(`список: data/${save.relativeManifest}`);
  document.getElementById("musicSaveDetails").textContent = parts.join(" · ");
}

async function loadMusic() {
  if (!state.guildId) return;
  if (musicLoadInFlight) return;
  musicLoadInFlight = true;
  try {
    const requestedGuildId = state.guildId;
    const data = await api(`/api/music/${requestedGuildId}`);
    if (requestedGuildId !== state.guildId) return;
    latestMusicSnapshot = data;
    const title = document.getElementById("nowPlayingTitle");
    const progressArea = document.getElementById("musicProgressArea");

    if (data.playing) {
      title.textContent = `▶️ ${data.playing.title} (${fmtDuration(data.playing.durationSec)}) — запросил(а) ${data.playing.requestedBy}`;
      progressArea.hidden = false;

      const playback = data.playback ?? {};
      const elapsed = Number(playback.elapsedSec) || 0;
      const duration = Number(playback.durationSec) || Number(data.playing.durationSec) || 0;
      const remaining = playback.remainingSec == null ? null : Math.max(0, Number(playback.remainingSec) || 0);
      const percent = Math.max(0, Math.min(100, Number(playback.progressPercent) || 0));

      document.getElementById("musicElapsed").textContent = `${fmtDuration(elapsed)} / ${duration ? fmtDuration(duration) : "—"}`;
      document.getElementById("musicRemaining").textContent = remaining == null ? "осталось —" : `осталось ${fmtDuration(remaining)}`;
      const progressBar = document.getElementById("musicProgressBar");
      progressBar.style.width = `${percent}%`;
      const progressTrack = progressBar.parentElement;
      progressTrack.setAttribute("aria-valuenow", percent.toFixed(1));
      progressTrack.setAttribute("aria-valuemin", "0");
      progressTrack.setAttribute("aria-valuemax", "100");

      const stability = document.getElementById("musicStability");
      const stabilitySuffix = playback.stabilityPercent == null
        ? " · сбор данных"
        : ` · ${playback.stabilityPercent}% (${playback.sampleCount || 0}с)`;
      stability.textContent = `${PLAYBACK_STATE_LABELS[playback.state] ?? playback.state ?? "—"}${stabilitySuffix}`;
      stability.className = `stability-${playback.state || "loading"}`;

      const buffer = Number(playback.bufferedSec) || 0;
      const speed = playback.decodedKbps == null ? "" : ` · ${playback.decodedKbps} КиБ/с`;
      document.getElementById("musicBuffer").textContent = `${buffer.toFixed(1)} с${speed}`;
      document.getElementById("musicPlayerState").textContent = PLAYER_STATE_LABELS[playback.playerStatus] ?? playback.playerStatus ?? "—";
      document.getElementById("musicVoiceState").textContent = VOICE_STATE_LABELS[playback.voiceStatus] ?? playback.voiceStatus ?? "—";
    } else {
      title.textContent = "Сейчас ничего не играет.";
      progressArea.hidden = true;
      document.getElementById("musicProgressBar").style.width = "0%";
    }

    const queueSignature = data.tracks.map((track) => track.queueId || track.url).join("|");
    if (queueSignature !== lastQueueSignature) {
      lastQueueSignature = queueSignature;
      state.mobileQueueLimit = 20;
      const list = document.getElementById("musicQueue");
      list.innerHTML = "";
      for (const t of data.tracks) {
        const li = document.createElement("li");
        const info = document.createElement("span");
        info.className = "queue-track-info";
        info.textContent = `${t.title} (${fmtDuration(t.durationSec)}) — ${t.requestedBy}`;

        const actions = document.createElement("span");
        actions.className = "queue-track-actions";
        const playButton = document.createElement("button");
        playButton.type = "button";
        playButton.className = "queue-track-play";
        playButton.dataset.queueId = t.queueId;
        playButton.dataset.operation = "play";
        playButton.title = `Включить сейчас: ${t.title}`;
        playButton.setAttribute("aria-label", playButton.title);
        playButton.textContent = "▶";

        const removeButton = document.createElement("button");
        removeButton.type = "button";
        removeButton.className = "queue-track-remove";
        removeButton.dataset.queueId = t.queueId;
        removeButton.dataset.operation = "remove";
        removeButton.title = `Удалить из очереди: ${t.title}`;
        removeButton.setAttribute("aria-label", removeButton.title);
        removeButton.textContent = "✕";

        actions.append(playButton, removeButton);
        li.append(info, actions);
        list.appendChild(li);
      }
      updateMobileQueueWindow();
    }
    document.getElementById("musicQueueCount").textContent = data.tracks.length;
    renderPlaylistSave(data.playlistSave, Boolean(data.playing || data.tracks.length));

    const vol = document.getElementById("musicVolume");
    if (document.activeElement !== vol) {
      vol.value = preparedMusicMonitor
        ? preparedMusicMonitor.volumePercent
        : Math.round((data.volume ?? 1) * 100);
    }
    document.getElementById("musicVolumeLabel").textContent = `${vol.value}%`;
    const musicError = document.getElementById("musicError");
    if (musicError.textContent.startsWith("Ошибка обновления:")) musicError.textContent = "";
    void syncMusicMonitor(data);
  } catch (err) {
    document.getElementById("musicError").textContent = "Ошибка обновления: " + err.message;
  } finally {
    musicLoadInFlight = false;
  }
}

async function musicAction(action, body) {
  try {
    const gatewayRetryDelays = action === "volume" ? [400, 900, 1800] : [];
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await api(`/api/music/${state.guildId}/${action}`, { method: "POST", body: body ? JSON.stringify(body) : "{}" });
      } catch (err) {
        const retryableGatewayError = [502, 503, 504].includes(err?.status);
        if (!retryableGatewayError || attempt >= gatewayRetryDelays.length) throw err;
        await new Promise((resolve) => setTimeout(resolve, gatewayRetryDelays[attempt]));
      }
    }
  } catch (err) {
    document.getElementById("musicError").textContent = "Ошибка: " + err.message;
    return null;
  } finally {
    if (action !== "volume") void loadMusic();
  }
}

document.getElementById("musicPause").addEventListener("click", () => musicAction("pause"));
document.getElementById("musicResume").addEventListener("click", () => musicAction("resume"));
document.getElementById("musicSkip").addEventListener("click", () => musicAction("skip"));
document.getElementById("musicStop").addEventListener("click", () => musicAction("stop"));

const volumeControl = document.getElementById("musicVolume");
let volumeDebounceTimer = null;
let pendingHostVolume = null;
let volumeRequestRunning = false;

async function flushHostVolume() {
  if (volumeRequestRunning) return;
  volumeRequestRunning = true;
  try {
    while (pendingHostVolume !== null) {
      const requestedLevel = pendingHostVolume;
      pendingHostVolume = null;
      if (musicMonitorEnabled && preparedMusicMonitor) {
        preparedMusicMonitor.volumePercent = requestedLevel;
        musicMonitorSignature = "";
        await syncMusicMonitor(latestMusicSnapshot);
        if (pendingHostVolume === null) {
          document.getElementById("musicError").textContent = `🎧 Громкость монитора применена: ${requestedLevel}%`;
        }
        continue;
      }
      const result = await musicAction("volume", { level: requestedLevel });
      if (!result) continue;
      const appliedLevel = Math.round((Number(result.volume) || 0) * 100);
      if (pendingHostVolume === null) {
        volumeControl.value = appliedLevel;
        document.getElementById("musicVolumeLabel").textContent = `${appliedLevel}%`;
        document.getElementById("musicError").textContent = `🔊 Громкость бота применена: ${appliedLevel}%`;
      }
    }
  } finally {
    volumeRequestRunning = false;
  }
}

function queueHostVolume(level, immediate = false) {
  pendingHostVolume = Math.max(0, Math.min(200, Number(level) || 0));
  document.getElementById("musicVolumeLabel").textContent = `${pendingHostVolume}%`;
  if (volumeDebounceTimer) clearTimeout(volumeDebounceTimer);
  volumeDebounceTimer = null;
  if (immediate) void flushHostVolume();
  else volumeDebounceTimer = setTimeout(() => {
    volumeDebounceTimer = null;
    void flushHostVolume();
  }, 160);
}

volumeControl.addEventListener("input", (event) => queueHostVolume(event.target.value));
volumeControl.addEventListener("change", (event) => queueHostVolume(event.target.value, true));

document.getElementById("musicQueue").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-queue-id]");
  if (!button) return;
  button.disabled = true;
  const operation = button.dataset.operation;
  try {
    const result = await api(`/api/music/${state.guildId}/track`, {
      method: "POST",
      body: JSON.stringify({ queueId: button.dataset.queueId, operation }),
    });
    document.getElementById("musicError").textContent = operation === "play"
      ? `▶️ Включаю «${result.track.title}»`
      : `🗑️ «${result.track.title}» удалён из очереди`;
    lastQueueSignature = "";
  } catch (err) {
    document.getElementById("musicError").textContent = "Ошибка: " + err.message;
  } finally {
    loadMusic();
  }
});

function suggestedPlaylistName() {
  const date = new Date().toLocaleDateString("ru-RU");
  return `Плейлист ${date}`;
}

async function openPlaylistNameDialog() {
  const dialog = document.getElementById("playlistNameDialog");
  if (dialog.open) return;
  const select = document.getElementById("playlistExistingName");
  const input = document.getElementById("playlistCustomName");
  document.getElementById("playlistNameError").textContent = "";
  await loadPlaylists();
  select.textContent = "";
  const fresh = document.createElement("option");
  fresh.value = "";
  fresh.textContent = "Новый плейлист";
  select.appendChild(fresh);
  for (const playlist of state.playlists) {
    const option = document.createElement("option");
    option.value = playlist.title;
    option.textContent = playlist.title;
    select.appendChild(option);
  }
  select.value = "";
  input.value = suggestedPlaylistName();
  dialog.showModal();
  input.focus();
  input.select();
}

document.getElementById("musicSavePlaylist").addEventListener("click", () => {
  void openPlaylistNameDialog();
});

document.getElementById("playlistExistingName").addEventListener("change", (event) => {
  const input = document.getElementById("playlistCustomName");
  input.value = event.target.value || suggestedPlaylistName();
  input.focus();
  input.select();
});

document.getElementById("playlistNameCancel").addEventListener("click", () => {
  document.getElementById("playlistNameDialog").close();
});

document.getElementById("playlistNameForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const dialog = document.getElementById("playlistNameDialog");
  const confirm = document.getElementById("playlistNameConfirm");
  const title = document.getElementById("playlistCustomName").value.trim();
  const error = document.getElementById("playlistNameError");
  error.textContent = "";
  if (!title) {
    error.textContent = "Введите имя плейлиста.";
    return;
  }
  confirm.disabled = true;
  try {
    const result = await api(`/api/music/${state.guildId}/save-playlist`, {
      method: "POST",
      body: JSON.stringify({ title }),
    });
    dialog.close();
    document.getElementById("musicError").textContent = result.job.alreadyRunning
      ? "Сохранение этого плейлиста уже выполняется."
      : `💾 «${result.job.title}»: фоновое сохранение ${result.job.total} треков запущено`;
  } catch (err) {
    error.textContent = "Ошибка сохранения: " + err.message;
  } finally {
    confirm.disabled = false;
    void loadMusic();
    void loadPlaylists();
  }
});

document.getElementById("refreshPlaylists").addEventListener("click", () => void loadPlaylists());

function renderMusicHistory(tracks) {
  const root = document.getElementById("cachedMusicHistory");
  root.innerHTML = "";
  document.getElementById("cachedHistoryCount").textContent = tracks.length;
  if (!tracks.length) {
    const empty = document.createElement("div");
    empty.className = "playlist-empty";
    empty.textContent = "Закэшированных проигранных песен пока нет.";
    root.appendChild(empty);
    return;
  }
  for (const track of tracks) {
    const card = document.createElement("div");
    card.className = "cached-history-item";
    const info = document.createElement("div");
    info.className = "cached-history-info";
    const title = document.createElement("strong");
    title.textContent = track.title;
    const meta = document.createElement("span");
    const source = track.sourceService || (track.sourceType === "spotify-match" ? "Spotify → YouTube" : "кэш");
    meta.textContent = `${fmtDuration(track.durationSec)} · ${formatBytes(track.sizeBytes)} · ${source} · запусков: ${track.playCount} · ${fmtTime(track.lastPlayedAt)}`;
    info.append(title, meta);
    const play = document.createElement("button");
    play.type = "button";
    play.className = "cached-history-play";
    play.dataset.historyId = track.id;
    play.title = `Включить из кэша: ${track.title}`;
    play.textContent = "▶ Включить";
    card.append(info, play);
    root.appendChild(card);
  }
}

async function loadMusicHistory() {
  if (!state.guildId) return;
  const guildId = state.guildId;
  try {
    const { tracks } = await api(`/api/music/${guildId}/history`);
    if (guildId !== state.guildId) return;
    state.musicHistory = tracks;
    renderMusicHistory(tracks);
    document.getElementById("cachedHistoryError").textContent = "";
  } catch (err) {
    document.getElementById("cachedHistoryError").textContent = `Ошибка обновления: ${err.message}`;
  }
}

document.getElementById("refreshCachedHistory").addEventListener("click", () => void loadMusicHistory());

document.getElementById("cachedMusicHistory").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-history-id]");
  if (!button) return;
  const channelId = document.getElementById("musicChannel").value;
  const error = document.getElementById("cachedHistoryError");
  if (!channelId) {
    error.textContent = "Выберите голосовой канал в панели «Музыка».";
    return;
  }
  button.disabled = true;
  try {
    const result = await api(`/api/music/${state.guildId}/history/${encodeURIComponent(button.dataset.historyId)}/play`, {
      method: "POST",
      body: JSON.stringify({ channelId }),
    });
    error.textContent = `▶️ «${result.track.title}» добавлена из кэша`;
    lastQueueSignature = "";
    await loadMusic();
  } catch (err) {
    error.textContent = `Ошибка запуска: ${err.message}`;
  } finally {
    button.disabled = false;
    void loadMusicHistory();
  }
});

document.getElementById("savedPlaylists").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-activate-playlist-id]");
  if (!button) return;
  const channelId = document.getElementById("musicChannel").value;
  const error = document.getElementById("savedPlaylistsError");
  if (!channelId) {
    error.textContent = "Выберите голосовой канал в панели «Музыка».";
    return;
  }
  button.disabled = true;
  error.textContent = "Переключаю плейлист…";
  try {
    const result = await api(`/api/music/${state.guildId}/playlists/${encodeURIComponent(button.dataset.activatePlaylistId)}/activate`, {
      method: "POST",
      body: JSON.stringify({ channelId }),
    });
    error.textContent = result.alreadyActive
      ? `Плейлист «${result.playlist.title}» уже активен.`
      : `${result.resumed ? "⏱️ Восстановлен" : "▶️ Запущен"} плейлист «${result.playlist.title}», треков: ${result.addedCount}.`;
    lastQueueSignature = "";
    await Promise.all([loadMusic(), loadPlaylists()]);
  } catch (err) {
    error.textContent = `Ошибка переключения: ${err.message}`;
    button.disabled = false;
  }
});

setInterval(() => loadMusic(), 1000);
setInterval(() => void loadPlaylists(), 5000);
setInterval(() => void loadMusicHistory(), 10000);

// --- Voice ------------------------------------------------------------

async function loadVoiceChannels() {
  if (!state.guildId) return;
  const channels = await api(`/api/guilds/${state.guildId}/voice-channels`);
  const select = document.getElementById("voiceChannelSelect");
  const prev = select.value;
  select.innerHTML = "";
  for (const c of channels) {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.name;
    select.appendChild(opt);
  }
  if (prev && channels.some((c) => c.id === prev)) select.value = prev;
}

async function voiceAction(userId, action, body) {
  const statusEl = document.getElementById("voiceStatus");
  try {
    await api(`/api/voice/${state.guildId}/${userId}/${action}`, { method: "POST", body: JSON.stringify(body ?? {}) });
    statusEl.textContent = "";
  } catch (err) {
    statusEl.textContent = "Ошибка: " + err.message;
  }
  loadVoiceMembers();
}

async function loadVoiceMembers() {
  if (!state.guildId) return;
  const channelId = document.getElementById("voiceChannelSelect").value;
  const tbody = document.querySelector("#voiceMembersTable tbody");
  if (!channelId) {
    tbody.innerHTML = "";
    return;
  }

  let members;
  try {
    members = await api(`/api/voice/${state.guildId}/${channelId}`);
  } catch (err) {
    document.getElementById("voiceStatus").textContent = "Ошибка: " + err.message;
    return;
  }

  tbody.innerHTML = "";
  if (!members.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="3" class="hint">В канале никого нет.</td>`;
    tbody.appendChild(tr);
    return;
  }

  for (const m of members) {
    const tr = document.createElement("tr");

    const tdName = document.createElement("td");
    tdName.textContent = m.tag;
    tr.appendChild(tdName);

    const tdStatus = document.createElement("td");
    tdStatus.textContent = m.serverMute ? "🔇 замьючен" : m.selfMute ? "🎤 (сам замьючен)" : "🎤 говорит";
    tr.appendChild(tdStatus);

    const tdActions = document.createElement("td");
    tdActions.style.display = "flex";
    tdActions.style.gap = "6px";

    const muteBtn = document.createElement("button");
    muteBtn.textContent = m.serverMute ? "Размьютить" : "Мьютить";
    muteBtn.addEventListener("click", () => voiceAction(m.id, m.serverMute ? "unmute" : "mute"));
    tdActions.appendChild(muteBtn);

    const banBtn = document.createElement("button");
    banBtn.className = "danger";
    banBtn.textContent = "Бан";
    banBtn.addEventListener("click", () => {
      if (!confirm(`Забанить ${m.tag} на этом сервере?`)) return;
      voiceAction(m.id, "ban");
    });
    tdActions.appendChild(banBtn);

    tr.appendChild(tdActions);
    tbody.appendChild(tr);
  }
}

document.getElementById("voiceChannelSelect").addEventListener("change", loadVoiceMembers);

setInterval(() => loadVoiceMembers(), 3000);

// --- Moderation ------------------------------------------------------------

async function loadModeration() {
  if (!state.guildId) return;
  const statusEl = document.getElementById("modStatus");
  const render = (el, members, unAction) => {
    el.innerHTML = "";
    for (const m of members) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.textContent = "Снять";
      btn.addEventListener("click", async () => {
        try {
          await api(`/api/moderation/${state.guildId}/${unAction}`, { method: "POST", body: JSON.stringify({ userId: m.id }) });
          statusEl.textContent = `✅ Снято с ${m.tag}.`;
        } catch (err) {
          statusEl.textContent = "Ошибка: " + err.message;
        }
        void loadModeration().catch((err) => console.warn("[moderation]", err));
      });
      const label = document.createElement("span");
      label.textContent = `${m.tag} (${m.id})`;
      li.appendChild(label);
      li.appendChild(btn);
      el.appendChild(li);
    }
  };
  render(document.getElementById("mutedList"), await api(`/api/moderation/${state.guildId}/muted`), "unmute");
  render(document.getElementById("jailedList"), await api(`/api/moderation/${state.guildId}/jailed`), "unjail");
}

document.querySelectorAll(".modform button").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const statusEl = document.getElementById("modStatus");
    const userId = document.getElementById("modUserId").value.trim();
    const reason = document.getElementById("modReason").value.trim();
    if (!userId) {
      statusEl.textContent = "Укажи ID пользователя.";
      return;
    }
    statusEl.textContent = "Выполняю...";
    try {
      await api(`/api/moderation/${state.guildId}/${btn.dataset.action}`, { method: "POST", body: JSON.stringify({ userId, reason }) });
      statusEl.textContent = "✅ Готово.";
      void loadModeration().catch((err) => console.warn("[moderation]", err));
    } catch (err) {
      statusEl.textContent = "Ошибка: " + err.message;
    }
  });
});

// --- History ---------------------------------------------------------------

async function loadHistoryChannels() {
  if (!state.guildId) return;
  const channels = await api(`/api/history/channels?guildId=${state.guildId}`);
  const select = document.getElementById("historyChannel");
  select.innerHTML = "";
  for (const c of channels) {
    const opt = document.createElement("option");
    opt.value = c.channel_id;
    opt.textContent = c.channel_name || c.channel_id;
    select.appendChild(opt);
  }
}

document.getElementById("historyLoad").addEventListener("click", async () => {
  const channelId = document.getElementById("historyChannel").value;
  const limit = document.getElementById("historyLimit").value;
  const messages = await api(`/api/history/messages?guildId=${state.guildId}&channelId=${channelId}&limit=${limit}`);
  const list = document.getElementById("historyList");
  list.innerHTML = "";
  for (const m of messages) {
    const div = document.createElement("div");
    div.className = "msg" + (m.deleted_at ? " deleted" : "");
    div.innerHTML = `<div class="meta">${escapeHtml(m.author_tag || "?")} — ${fmtTime(m.created_at)}${m.edited_at ? " (ред.)" : ""}${m.deleted_at ? " (удалено)" : ""}</div><div>${m.content ? escapeHtml(m.content) : "<i>(без текста)</i>"}</div>`;
    list.appendChild(div);
  }
});

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// --- Members ----------------------------------------------------------

let allMembers = [];

const STATUS_LABEL = { online: "онлайн", idle: "нет на месте", dnd: "не беспокоить", offline: "не в сети" };

function renderMembers(members) {
  const tbody = document.querySelector("#membersTable tbody");
  tbody.innerHTML = "";
  for (const m of members) {
    const tr = document.createElement("tr");
    const status = m.status ?? "offline";
    tr.innerHTML = `<td><span class="status-dot status-${status}" title="${STATUS_LABEL[status] ?? status}"></span></td><td>${escapeHtml(m.tag)}</td><td>${m.roles.map(escapeHtml).join(", ")}</td>`;
    tbody.appendChild(tr);
  }
}

async function loadMembers() {
  if (!state.guildId) return;
  allMembers = await api(`/api/guilds/${state.guildId}/members`);
  allMembers.sort((a, b) => a.tag.localeCompare(b.tag));
  renderMembers(allMembers);
}

document.getElementById("memberSearch").addEventListener("input", (e) => {
  const q = e.target.value.trim().toLowerCase();
  renderMembers(q ? allMembers.filter((m) => m.tag.toLowerCase().includes(q)) : allMembers);
});

// --- Stats ---------------------------------------------------------------

async function loadStats() {
  if (!state.guildId) return;
  const stats = await api(`/api/stats/${state.guildId}`);
  document.getElementById("statsTotal").innerHTML = `Всего сообщений (не удалённых): <b>${stats.totalMessages}</b>`;

  const usersBody = document.getElementById("statsUsers");
  usersBody.innerHTML = "";
  for (const u of stats.topUsers) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${escapeHtml(u.author_tag)}</td><td>${u.count}</td>`;
    usersBody.appendChild(tr);
  }

  const chBody = document.getElementById("statsChannels");
  chBody.innerHTML = "";
  for (const c of stats.topChannels) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${escapeHtml(c.channel_name || "?")}</td><td>${c.count}</td>`;
    chBody.appendChild(tr);
  }

  const daysBody = document.getElementById("statsDays");
  daysBody.innerHTML = "";
  for (const d of stats.last7Days) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${d.day}</td><td>${d.count}</td>`;
    daysBody.appendChild(tr);
  }
}

// --- Downloads -----------------------------------------------------------

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (!bytes) return "—";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

const DOWNLOAD_STATUS = {
  queued: "в очереди", processing: "скачивается", ready: "готово",
  linked: "выдана ссылка", error: "ошибка",
};
let downloadPollTimer = null;

function scheduleDownloadRefresh() {
  if (downloadPollTimer) return;
  downloadPollTimer = setTimeout(() => {
    downloadPollTimer = null;
    void loadDownloads().catch((err) => console.warn("[downloads]", err));
  }, 3000);
}

async function loadDownloads() {
  const suffix = state.guildId ? `?guildId=${encodeURIComponent(state.guildId)}` : "";
  const data = await api(`/api/downloads${suffix}`);
  const settings = data.settings;
  const settingsBox = document.getElementById("downloadSettings");
  settingsBox.innerHTML = "";
  const items = [
    ["Cobalt", settings.enabled ? "подключён" : "не настроен"],
    ["Права", settings.allowedRoles.join(", ") || "только администратор"],
    ["Лимит файла", formatBytes(settings.maxBytes)],
    ["Очередь", `${settings.concurrency} одновременно · до ${settings.maxQueue}`],
    ["Cooldown", `${Math.round(settings.cooldownMs / 1000)} сек.`],
    ["Ссылки", settings.publicLinks ? `${Math.round(settings.linkTtlMs / 60000)} мин.` : "не настроены"],
  ];
  for (const [label, value] of items) {
    const card = document.createElement("div");
    const title = document.createElement("span");
    title.className = "metric-label";
    title.textContent = label;
    const detail = document.createElement("strong");
    detail.textContent = value;
    card.append(title, detail);
    settingsBox.appendChild(card);
  }
  const queue = document.getElementById("downloadQueue");
  queue.textContent = data.queue.length
    ? data.queue.map((job) => `${job.userTag || job.userId}: ${job.sourceHost} — ${DOWNLOAD_STATUS[job.status] || job.status}`).join("\n")
    : "Очередь пуста.";
  const body = document.getElementById("downloadHistory");
  body.innerHTML = "";
  const available = new Map((data.available || []).map((item) => [item.id, item]));
  for (const item of data.history) {
    const row = document.createElement("tr");
    for (const value of [fmtTime(item.createdAt), item.userTag || item.userId, item.sourceHost, DOWNLOAD_STATUS[item.status] || item.status, formatBytes(item.sizeBytes)]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.appendChild(cell);
    }
    const fileCell = document.createElement("td");
    const ready = available.get(item.id);
    if (ready) {
      const link = document.createElement("a");
      link.href = ready.url;
      link.textContent = "Скачать";
      link.title = `${ready.filename} · ссылка до ${fmtTime(ready.expiresAt)}`;
      fileCell.appendChild(link);
    } else {
      fileCell.textContent = "—";
    }
    row.appendChild(fileCell);
    if (item.error) row.title = item.error;
    body.appendChild(row);
  }
  if (data.queue.length) scheduleDownloadRefresh();
}

const downloadFormat = document.getElementById("downloadFormat");
const downloadQuality = document.getElementById("downloadQuality");
downloadFormat.addEventListener("change", () => {
  downloadQuality.disabled = downloadFormat.value === "audio";
});

document.getElementById("downloadForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = document.getElementById("downloadResult");
  const submit = document.getElementById("downloadSubmit");
  const url = document.getElementById("downloadUrl").value.trim();
  if (!state.guildId) return (result.textContent = "Сначала выберите Discord-сервер.");
  if (!url) return (result.textContent = "Вставьте ссылку на публичное видео.");
  submit.disabled = true;
  result.textContent = "Добавляю загрузку в очередь…";
  try {
    const queued = await api("/api/downloads", {
      method: "POST",
      body: JSON.stringify({
        guildId: state.guildId,
        url,
        format: downloadFormat.value,
        quality: downloadQuality.value,
      }),
    });
    document.getElementById("downloadUrl").value = "";
    result.textContent = `✅ Загрузка ${queued.id.slice(0, 8)} поставлена в очередь. Ссылка появится в истории после обработки.`;
    await loadDownloads();
  } catch (err) {
    result.textContent = "Ошибка: " + err.message;
  } finally {
    submit.disabled = false;
  }
});

document.getElementById("downloadsRefresh").addEventListener("click", () => {
  void loadDownloads().catch((err) => console.warn("[downloads]", err));
});

// --- Transcription -------------------------------------------------------

let activeTranscriptionId = null;
let transcriptionPollTimer = null;

function transcriptClock(milliseconds) {
  const total = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
  return `${String(Math.floor(total / 3600)).padStart(2, "0")}:${String(Math.floor((total % 3600) / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

async function loadTranscriptionChannels() {
  if (!state.guildId) return;
  const [voice, text] = await Promise.all([
    api(`/api/guilds/${state.guildId}/voice-channels`),
    api(`/api/guilds/${state.guildId}/text-channels`),
  ]);
  for (const [selectId, channels] of [["transcriptionVoice", voice], ["transcriptionText", text]]) {
    const select = document.getElementById(selectId);
    const previous = select.value;
    select.innerHTML = channels.map((channel) => `<option value="${escapeHtml(channel.id)}">${escapeHtml(channel.name)}</option>`).join("");
    if (channels.some((channel) => channel.id === previous)) select.value = previous;
  }
}

function renderTranscript(segments = []) {
  const live = document.getElementById("transcriptionLive");
  live.innerHTML = "";
  if (!segments.length) {
    live.innerHTML = '<span class="hint">Распознанный текст появится после первого минутного чанка.</span>';
    return;
  }
  for (const segment of segments) {
    const line = document.createElement("div");
    line.className = `transcript-line${segment.aecConfidence != null && segment.aecConfidence < 0.12 ? " transcription-aec-low" : ""}`;
    const time = document.createElement("span");
    time.className = "transcript-time";
    time.textContent = transcriptClock(segment.startMs);
    const speaker = document.createElement("span");
    speaker.className = "transcript-speaker";
    speaker.textContent = segment.speakerName;
    const textNode = document.createElement("span");
    textNode.textContent = segment.text;
    line.append(time, speaker, textNode);
    live.appendChild(line);
  }
  live.scrollTop = live.scrollHeight;
}

function scheduleTranscriptionRefresh() {
  if (transcriptionPollTimer) return;
  transcriptionPollTimer = setTimeout(() => {
    transcriptionPollTimer = null;
    void loadTranscriptions().catch((error) => console.warn("[transcription]", error));
  }, 5000);
}

async function loadTranscriptions() {
  if (!state.guildId) return;
  const data = await api(`/api/transcriptions?guildId=${encodeURIComponent(state.guildId)}`);
  const active = data.active?.id ? data.active : null;
  activeTranscriptionId = active?.id || null;
  document.getElementById("transcriptionStart").disabled = Boolean(active);
  document.getElementById("transcriptionStop").disabled = !active || active.status === "finalizing";
  document.getElementById("transcriptionStatus").textContent = active
    ? `🔴 ${active.status} · чанков ${active.chunks?.length || 0} · очередь worker ${data.workerQueue}`
    : "Запись не активна.";
  renderTranscript(active?.segments || []);
  const tbody = document.getElementById("transcriptionSessions");
  tbody.innerHTML = "";
  for (const session of data.sessions || []) {
    const row = document.createElement("tr");
    for (const value of [fmtTime(session.startedAt), session.status, session.language]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.appendChild(cell);
    }
    const exportsCell = document.createElement("td");
    for (const format of ["txt", "srt"]) {
      const link = document.createElement("a");
      link.href = `/api/transcriptions/${encodeURIComponent(session.id)}/export?format=${format}`;
      link.textContent = format.toUpperCase();
      link.className = "button-link";
      link.download = "";
      exportsCell.append(link, document.createTextNode(" "));
    }
    const actionCell = document.createElement("td");
    const open = document.createElement("button");
    open.type = "button";
    open.textContent = "Открыть";
    open.addEventListener("click", async () => {
      const status = document.getElementById("transcriptionStatus");
      try {
        const details = await api(`/api/transcriptions/${encodeURIComponent(session.id)}`);
        renderTranscript(details.segments || []);
        status.textContent = `Просмотр сессии ${session.id} · сегментов ${details.segments?.length || 0}`;
      } catch (error) {
        status.textContent = "Ошибка просмотра: " + error.message;
      }
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Удалить";
    remove.disabled = ["recording", "finalizing"].includes(session.status);
    remove.addEventListener("click", async () => {
      if (!confirm("Удалить текст и сохранённые аудиочанки этой сессии?")) return;
      await api(`/api/transcriptions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      await loadTranscriptions();
    });
    actionCell.append(open, document.createTextNode(" "), remove);
    row.append(exportsCell, actionCell);
    tbody.appendChild(row);
  }
  if (active) scheduleTranscriptionRefresh();
}

document.getElementById("transcriptionForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = document.getElementById("transcriptionStatus");
  status.textContent = "Подключаю локальную модель…";
  try {
    await api("/api/transcriptions", {
      method: "POST",
      body: JSON.stringify({
        guildId: state.guildId,
        voiceChannelId: document.getElementById("transcriptionVoice").value,
        announceChannelId: document.getElementById("transcriptionText").value,
        language: document.getElementById("transcriptionLanguage").value,
      }),
    });
    await loadTranscriptions();
  } catch (error) {
    status.textContent = "Ошибка: " + error.message;
  }
});

document.getElementById("transcriptionStop").addEventListener("click", async () => {
  if (!activeTranscriptionId) return;
  const status = document.getElementById("transcriptionStatus");
  status.textContent = "Останавливаю и закрываю последний чанк…";
  try {
    await api(`/api/transcriptions/${encodeURIComponent(activeTranscriptionId)}/stop`, { method: "POST", body: "{}" });
    await loadTranscriptions();
  } catch (error) {
    status.textContent = "Ошибка: " + error.message;
  }
});

document.getElementById("transcriptionRefresh").addEventListener("click", () => {
  void loadTranscriptions().catch((error) => console.warn("[transcription]", error));
});

// --- Boot --------------------------------------------------------------

(async function boot() {
  try {
    await loadAccessIdentity();
    await loadStatus();
    await settleTasks(
      [loadConfigEditor(), loadMusic(), loadMusicHistory(), loadPlaylists(), loadMusicChannels(), loadVoiceChannels(), loadModeration(), loadMembers(), loadStats(), loadHistoryChannels(), loadDownloads(), loadTranscriptionChannels(), loadTranscriptions()],
      "boot",
    );
    await loadVoiceMembers();
  } catch (err) {
    document.getElementById("botTag").textContent = "🔴 панель недоступна";
    console.error("[boot]", err);
  }
})();

setInterval(() => void loadStatus().catch((err) => console.warn("[status]", err)), 15000);
