const state = { guildId: null, config: null };

async function api(path, opts) {
  const res = await fetch(path, {
    ...opts,
    headers: { "content-type": "application/json", ...(opts?.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.errors?.join(", ") || `HTTP ${res.status}`);
  return data;
}

function fmtDuration(sec) {
  sec = Math.floor(sec || 0);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

function fmtTime(ts) {
  return new Date(ts).toLocaleString("ru-RU");
}

// --- Status / guild selector -------------------------------------------

async function loadStatus() {
  const status = await api("/api/status");
  document.getElementById("botTag").textContent = status.tag ? `🟢 ${status.tag}` : "🔴 не в сети";
  document.getElementById("uptime").textContent = `аптайм: ${Math.floor(status.uptimeSec / 60)} мин`;

  const select = document.getElementById("guildSelect");
  select.innerHTML = "";
  for (const g of status.guilds) {
    const opt = document.createElement("option");
    opt.value = g.id;
    opt.textContent = `${g.name} (${g.memberCount})`;
    select.appendChild(opt);
  }
  if (!state.guildId && status.guilds.length) state.guildId = status.guilds[0].id;
  select.value = state.guildId;

  const info = status.guilds.find((g) => g.id === state.guildId);
  document.getElementById("guildInfo").innerHTML = info
    ? `<b>${info.name}</b><br/>ID: ${info.id}<br/>Участников: ${info.memberCount}`
    : "Бот не состоит ни в одном сервере.";
}

document.getElementById("guildSelect").addEventListener("change", async (e) => {
  state.guildId = e.target.value;
  await Promise.all([loadStatus(), loadMusic(), loadMusicChannels(), loadVoiceChannels(), loadModeration(), loadMembers(), loadStats(), loadHistoryChannels()]);
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
  const channelId = document.getElementById("musicChannel").value;
  const query = document.getElementById("musicQuery").value.trim();
  if (!channelId) return (errEl.textContent = "На сервере нет голосовых каналов.");
  if (!query) return (errEl.textContent = "Вставь ссылку на YouTube или запрос.");
  errEl.textContent = "Ищу трек...";
  try {
    const { track } = await api(`/api/music/${state.guildId}/play`, { method: "POST", body: JSON.stringify({ query, channelId }) });
    errEl.textContent = `✅ ${track.title}`;
    document.getElementById("musicQuery").value = "";
  } catch (err) {
    errEl.textContent = "Ошибка: " + err.message;
  }
  loadMusic();
});

async function loadMusic() {
  if (!state.guildId) return;
  const data = await api(`/api/music/${state.guildId}`);
  const now = document.getElementById("nowPlaying");
  now.innerHTML = data.playing
    ? `▶️ <b>${data.playing.title}</b> (${fmtDuration(data.playing.durationSec)}) — запросил(а) ${data.playing.requestedBy}`
    : "Сейчас ничего не играет.";

  const list = document.getElementById("musicQueue");
  list.innerHTML = "";
  for (const t of data.tracks) {
    const li = document.createElement("li");
    li.textContent = `${t.title} (${fmtDuration(t.durationSec)}) — ${t.requestedBy}`;
    list.appendChild(li);
  }

  const vol = document.getElementById("musicVolume");
  vol.value = Math.round((data.volume ?? 1) * 100);
  document.getElementById("musicVolumeLabel").textContent = `${vol.value}%`;
}

async function musicAction(action, body) {
  try {
    await api(`/api/music/${state.guildId}/${action}`, { method: "POST", body: body ? JSON.stringify(body) : "{}" });
  } catch (err) {
    document.getElementById("musicError").textContent = "Ошибка: " + err.message;
  }
  loadMusic();
}

document.getElementById("musicPause").addEventListener("click", () => musicAction("pause"));
document.getElementById("musicResume").addEventListener("click", () => musicAction("resume"));
document.getElementById("musicSkip").addEventListener("click", () => musicAction("skip"));
document.getElementById("musicStop").addEventListener("click", () => musicAction("stop"));
document.getElementById("musicVolume").addEventListener("change", (e) => {
  document.getElementById("musicVolumeLabel").textContent = `${e.target.value}%`;
  musicAction("volume", { level: Number(e.target.value) });
});

setInterval(() => loadMusic(), 3000);

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
        loadModeration();
      });
      li.innerHTML = `<span>${m.tag} (${m.id})</span>`;
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
      loadModeration();
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
    div.innerHTML = `<div class="meta">${m.author_tag} — ${fmtTime(m.created_at)}${m.edited_at ? " (ред.)" : ""}${m.deleted_at ? " (удалено)" : ""}</div><div>${m.content ? escapeHtml(m.content) : "<i>(без текста)</i>"}</div>`;
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

// --- Boot --------------------------------------------------------------

(async function boot() {
  await loadStatus();
  await Promise.all([loadConfigEditor(), loadMusic(), loadMusicChannels(), loadVoiceChannels(), loadModeration(), loadMembers(), loadStats(), loadHistoryChannels()]);
  await loadVoiceMembers();
})();

setInterval(loadStatus, 15000);
