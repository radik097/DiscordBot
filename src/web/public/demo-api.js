(function setupDemoApi() {
  const params = new URLSearchParams(location.search);
  const enabled = location.hostname.endsWith(".github.io") || params.get("demo") === "1";
  if (!enabled) return;

  window.DISCORD_BOT_DEMO = true;
  document.documentElement.dataset.demo = "true";
  document.title = "DiscordBot — интерактивная демонстрация";

  const DEMO_GUILD_ID = "demo-server-001";
  const startedAt = Date.now() - ((2 * 60 + 14) * 60 * 1000);
  const now = () => Date.now();
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

  const tracks = [
    { queueId: "demo-track-2", title: "Midnight Drive — Demo Artist", durationSec: 198, requestedBy: "DemoUser", url: "https://example.invalid/midnight-drive" },
    { queueId: "demo-track-3", title: "Ocean Breeze — Demo Artist", durationSec: 245, requestedBy: "DemoUser", url: "https://example.invalid/ocean-breeze" },
    { queueId: "demo-track-4", title: "City Lights — Demo Artist", durationSec: 230, requestedBy: "DemoUser", url: "https://example.invalid/city-lights" },
    { queueId: "demo-track-5", title: "Starlight Highway — Demo Artist", durationSec: 207, requestedBy: "DemoUser", url: "https://example.invalid/starlight-highway" },
  ];

  const playlists = [
    {
      id: "demo-playlist-focus",
      title: "Электроника для работы",
      status: "completed",
      total: 5,
      completed: 5,
      updatedAt: now() - 35 * 60 * 1000,
      tracks: [
        { title: "Aurora Lights — Demo Artist", durationSec: 222, startTimeSec: 78, status: "cached" },
        ...tracks.map((track) => ({ ...track, startTimeSec: 0, status: "cached" })),
      ],
      playback: { tracks: [{ title: "Aurora Lights — Demo Artist", startTimeSec: 78 }] },
    },
    {
      id: "demo-playlist-evening",
      title: "Спокойный вечер",
      status: "completed",
      total: 3,
      completed: 3,
      updatedAt: now() - 24 * 60 * 60 * 1000,
      tracks: tracks.slice(0, 3).map((track) => ({ ...track, startTimeSec: 0, status: "cached" })),
      playback: { tracks: [] },
    },
  ];

  const members = [
    { id: "demo-user-001", tag: "DemoUser#0001", roles: ["Участник", "Музыка"], status: "online" },
    { id: "demo-user-002", tag: "SampleMod#0002", roles: ["Модератор"], status: "idle" },
    { id: "demo-user-003", tag: "ExampleGuest#0003", roles: ["Новичок"], status: "offline" },
  ];

  const voiceMembers = [
    { id: "demo-user-001", tag: "DemoUser#0001", serverMute: false, selfMute: false },
    { id: "demo-user-002", tag: "SampleMod#0002", serverMute: false, selfMute: true },
  ];

  const moderation = {
    muted: [{ id: "demo-user-004", tag: "MutedExample#0004" }],
    jailed: [],
  };

  const demoConfig = {
    guild: { name: "Demo Community" },
    roles: [
      { name: "Новичок", color: "#95a5a6" },
      { name: "Участник", color: "#5865f2" },
      { name: "Модератор", color: "#57f287" },
    ],
    channels: [
      { name: "информация", type: "category" },
      { name: "общий", type: "text", parent: "информация" },
      { name: "Lounge", type: "voice" },
    ],
  };

  const history = [
    { author_tag: "DemoUser#0001", content: "Это безопасная демонстрация интерфейса.", created_at: now() - 18 * 60 * 1000 },
    { author_tag: "SampleMod#0002", content: "Данные не загружаются из Discord API.", created_at: now() - 12 * 60 * 1000 },
    { author_tag: "ExampleGuest#0003", content: "Все действия выполняются только в памяти страницы.", created_at: now() - 4 * 60 * 1000 },
  ];
  const cachedMusicHistory = tracks.slice(0, 3).map((track, index) => ({
    id: index + 1,
    cacheFile: `${String(index + 1).repeat(40)}.webm`,
    url: track.url,
    title: track.title,
    durationSec: track.durationSec,
    requestedBy: track.requestedBy,
    sourceType: index === 0 ? "spotify-match" : null,
    sourceService: index === 0 ? "spotify.com" : "youtube.com",
    sizeBytes: 3_000_000 + index * 750_000,
    firstPlayedAt: now() - (index + 3) * 60 * 60 * 1000,
    lastPlayedAt: now() - (index + 1) * 20 * 60 * 1000,
    playCount: index + 1,
  }));

  let current = { queueId: "demo-track-1", title: "Aurora Lights — Demo Artist", durationSec: 222, requestedBy: "DemoUser", url: "https://example.invalid/aurora-lights" };
  let queue = copy(tracks);
  let elapsedBase = 78;
  let elapsedChangedAt = now();
  let paused = false;
  let volume = 0.85;
  let playlistSave = {
    status: "completed",
    total: 5,
    completed: 5,
    downloaded: 4,
    alreadyCached: 1,
    failed: 0,
    relativeManifest: "playlists/demo-server-001/demo-playlist-focus.json",
  };
  let activePlaylistId = "demo-playlist-focus";
  let phoneEnabled = false;
  let phoneDevices = [];
  let demoTranscription = null;
  let demoTranscriptionSessions = [];
  const transcriptionCatalog = [
    { id: "local", label: "Локальный faster-whisper", cloud: false, models: [
      { id: "tiny", label: "Whisper Tiny", note: "самая быстрая" },
      { id: "base", label: "Whisper Base", note: "быстрая" },
      { id: "small", label: "Whisper Small", note: "рекомендуется" },
      { id: "medium", label: "Whisper Medium", note: "точнее" },
      { id: "large-v3", label: "Whisper Large v3", note: "максимальная точность" },
      { id: "distil-large-v3", label: "Distil Large v3", note: "быстрее Large v3" },
    ] },
    { id: "openai", label: "OpenAI", cloud: true, models: [
      { id: "gpt-4o-mini-transcribe", label: "GPT-4o mini Transcribe", note: "рекомендуется" },
      { id: "gpt-4o-transcribe", label: "GPT-4o Transcribe", note: "повышенная точность" },
      { id: "whisper-1", label: "Whisper API", note: "совместимая модель" },
    ] },
    { id: "mistral", label: "Mistral", cloud: true, models: [
      { id: "voxtral-mini-latest", label: "Voxtral Mini Transcribe", note: "актуальная batch-модель" },
    ] },
  ];
  let demoTranscriptionSettings = {
    provider: "local", model: "small", catalog: transcriptionCatalog,
    keys: { openai: { configured: false, source: null, masked: null }, mistral: { configured: false, source: null, masked: null } },
    worker: { ready: true, device: "cuda", loadedModel: "small" },
  };

  function elapsed() {
    if (!current) return 0;
    const live = paused ? 0 : Math.floor((now() - elapsedChangedAt) / 1000);
    return Math.min(current.durationSec, elapsedBase + live);
  }

  function setElapsed(value) {
    elapsedBase = Math.max(0, Number(value) || 0);
    elapsedChangedAt = now();
  }

  function musicState() {
    const played = elapsed();
    const duration = current?.durationSec || 0;
    return {
      playing: current ? copy(current) : null,
      tracks: copy(queue),
      volume,
      playlistSave: copy(playlistSave),
      playback: current ? {
        elapsedSec: played,
        durationSec: duration,
        remainingSec: Math.max(0, duration - played),
        progressPercent: duration ? (played / duration) * 100 : 0,
        state: paused ? "paused" : "stable",
        stabilityPercent: 99,
        sampleCount: 64,
        bufferedSec: 8.4,
        decodedKbps: 320,
        playerStatus: paused ? "paused" : "playing",
        voiceStatus: "ready",
      } : null,
    };
  }

  function parseBody(init) {
    try { return init?.body ? JSON.parse(init.body) : {}; }
    catch { return {}; }
  }

  function demoQrSvg() {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21" role="img" aria-label="Демонстрационный QR-код"><rect width="21" height="21" fill="white"/><path fill="#131316" d="M1 1h6v6H1zm2 2v2h2V3zM14 1h6v6h-6zm2 2v2h2V3zM1 14h6v6H1zm2 2v2h2v-2zM9 2h2v2H9zm2 3h2v3h-2zM8 9h3v2H8zm5 0h2v2h-2zm3 0h4v2h-4zM9 12h2v3H9zm3 1h3v2h-3zm4-1h2v3h-2zm3 2h1v2h-1zm-7 3h2v3h-2zm3-1h2v2h-2zm3 2h2v2h-2z"/></svg>';
  }

  async function route(path, method, init) {
    const body = parseBody(init);

    if (path === "/api/csrf") return json({ token: "demo-csrf-token" });
    if (path === "/api/status") return json({
      ready: true,
      tag: "DemoBot#0001",
      uptimeSec: Math.floor((now() - startedAt) / 1000),
      guilds: [{ id: DEMO_GUILD_ID, name: "Demo Community", memberCount: 128 }],
    });

    if (path === "/api/config" && method === "GET") return json(copy(demoConfig));
    if (path === "/api/config/validate") return json({ errors: [] });
    if (path === "/api/config" && method === "PUT") return json({ ok: true, demo: true });
    if (path === "/api/config/build") return json({ log: ["[demo] Конфигурация проверена.", "[demo] Изменения не отправлялись в Discord."] });
    if (path === "/api/config/wipe") return json({ log: ["[demo] Wipe симулирован.", "[demo] Ни один сервер не был изменён."] });

    if (/^\/api\/guilds\/[^/]+\/voice-channels$/.test(path)) return json([
      { id: "demo-voice-lounge", name: "Lounge" },
      { id: "demo-voice-focus", name: "Фокус" },
    ]);
    if (/^\/api\/guilds\/[^/]+\/text-channels$/.test(path)) return json([
      { id: "demo-text-general", name: "общий" },
      { id: "demo-text-log", name: "бот-лог" },
    ]);
    if (/^\/api\/guilds\/[^/]+\/members$/.test(path)) return json(copy(members));

    if (/^\/api\/music\/[^/]+$/.test(path) && method === "GET") return json(musicState());
    if (/^\/api\/music\/[^/]+\/history$/.test(path) && method === "GET") return json({ tracks: copy(cachedMusicHistory) });
    const cachedHistoryPlay = path.match(/^\/api\/music\/[^/]+\/history\/(\d+)\/play$/);
    if (cachedHistoryPlay) {
      const entry = cachedMusicHistory.find((item) => item.id === Number(cachedHistoryPlay[1]));
      if (!entry) return json({ error: "Демо-песня не найдена в кэше." }, 404);
      current = { ...copy(entry), queueId: `demo-history-${now()}`, requestedBy: "веб-панель" };
      entry.playCount += 1;
      entry.lastPlayedAt = now();
      setElapsed(0);
      paused = false;
      return json({ ok: true, track: copy(current) });
    }
    if (/^\/api\/music\/[^/]+\/play$/.test(path)) {
      const title = body.query?.trim() ? `Demo Track — ${body.query.trim().slice(0, 40)}` : "Demo Track";
      current = { queueId: `demo-track-${now()}`, title, durationSec: 210, requestedBy: "DemoUser", url: "https://example.invalid/demo-track" };
      setElapsed(0);
      paused = false;
      return json({ kind: "track", track: copy(current) });
    }
    if (/^\/api\/music\/[^/]+\/(pause|resume|skip|stop|volume)$/.test(path)) {
      const action = path.split("/").pop();
      if (action === "pause") { elapsedBase = elapsed(); elapsedChangedAt = now(); paused = true; }
      if (action === "resume") { elapsedChangedAt = now(); paused = false; }
      if (action === "skip") { current = queue.shift() || null; setElapsed(0); paused = false; }
      if (action === "stop") { current = null; queue = []; setElapsed(0); }
      if (action === "volume") {
        volume = Math.max(0, Math.min(2, Number(body.level) / 100));
        return json({ ok: true, volume });
      }
      return json({ ok: true });
    }
    if (/^\/api\/music\/[^/]+\/track$/.test(path)) {
      const index = queue.findIndex((track) => track.queueId === body.queueId);
      if (index < 0) return json({ error: "Демо-трек не найден." }, 404);
      const [track] = queue.splice(index, 1);
      if (body.operation === "play") { current = track; setElapsed(0); paused = false; }
      return json({ track: copy(track) });
    }
    if (/^\/api\/music\/[^/]+\/save-playlist$/.test(path)) {
      const title = body.title?.trim() || "Демо-плейлист";
      const job = { ...copy(playlistSave), title, alreadyRunning: false };
      playlists.unshift({
        id: `demo-playlist-${now()}`,
        title,
        status: "completed",
        total: (current ? 1 : 0) + queue.length,
        completed: (current ? 1 : 0) + queue.length,
        updatedAt: now(),
        tracks: [current, ...queue].filter(Boolean).map((track) => ({ ...track, startTimeSec: 0, status: "cached" })),
        playback: { tracks: current ? [{ title: current.title, startTimeSec: elapsed() }] : [] },
      });
      return json({ job });
    }
    if (/^\/api\/music\/[^/]+\/playlists$/.test(path)) return json({
      playlists: playlists.map(({ tracks: _tracks, playback: _playback, ...playlist }) => playlist),
      activePlaylistId,
    });
    const playlistDetails = path.match(/^\/api\/music\/[^/]+\/playlists\/([^/]+)$/);
    if (playlistDetails && method === "GET") {
      const playlist = playlists.find((item) => item.id === decodeURIComponent(playlistDetails[1]));
      return playlist ? json({ playlist: copy(playlist) }) : json({ error: "Демо-плейлист не найден." }, 404);
    }
    const playlistActivate = path.match(/^\/api\/music\/[^/]+\/playlists\/([^/]+)\/activate$/);
    if (playlistActivate) {
      const playlist = playlists.find((item) => item.id === decodeURIComponent(playlistActivate[1]));
      if (!playlist) return json({ error: "Демо-плейлист не найден." }, 404);
      const wasActive = activePlaylistId === playlist.id;
      activePlaylistId = playlist.id;
      const restoredTracks = playlist.tracks.map((track, index) => ({ ...track, queueId: `demo-restored-${index}` }));
      current = restoredTracks.shift() || null;
      queue = restoredTracks;
      setElapsed(playlist.playback?.tracks?.[0]?.startTimeSec || 0);
      paused = false;
      return json({ alreadyActive: wasActive, resumed: true, playlist: copy(playlist), addedCount: 1 + queue.length });
    }

    if (/^\/api\/voice\/[^/]+\/[^/]+$/.test(path) && method === "GET") return json(copy(voiceMembers));
    if (/^\/api\/voice\/[^/]+\/[^/]+\/(mute|unmute|ban)$/.test(path)) return json({ ok: true, demo: true });

    const moderationList = path.match(/^\/api\/moderation\/[^/]+\/(muted|jailed)$/);
    if (moderationList && method === "GET") return json(copy(moderation[moderationList[1]]));
    const moderationAction = path.match(/^\/api\/moderation\/[^/]+\/(mute|unmute|jail|unjail)$/);
    if (moderationAction) {
      const action = moderationAction[1];
      const listName = action.includes("jail") ? "jailed" : "muted";
      if (action.startsWith("un")) moderation[listName] = moderation[listName].filter((item) => item.id !== body.userId);
      else if (!moderation[listName].some((item) => item.id === body.userId)) moderation[listName].push({ id: body.userId, tag: `DemoMember#${String(moderation[listName].length + 10).padStart(4, "0")}` });
      return json({ ok: true, demo: true });
    }

    if (path === "/api/history/channels") return json([{ channel_id: "demo-general", channel_name: "общий" }, { channel_id: "demo-guides", channel_name: "гайды" }]);
    if (path === "/api/history/messages") return json(copy(history));
    if (/^\/api\/stats\/[^/]+$/.test(path)) return json({
      totalMessages: 342,
      topUsers: [{ author_tag: "DemoUser#0001", count: 128 }, { author_tag: "SampleMod#0002", count: 91 }],
      topChannels: [{ channel_name: "общий", count: 201 }, { channel_name: "гайды", count: 86 }],
      last7Days: [
        { day: "2026-08-14", count: 34 }, { day: "2026-08-15", count: 51 },
        { day: "2026-08-16", count: 48 }, { day: "2026-08-17", count: 62 },
        { day: "2026-08-18", count: 57 }, { day: "2026-08-19", count: 49 },
        { day: "2026-08-20", count: 41 },
      ],
    });
    if (path === "/api/downloads" && method === "POST") return json({ ok: true, id: `demo-download-${now()}`, status: "queued" }, 202);
    if (path === "/api/downloads") return json({
      settings: { enabled: true, maxBytes: 524288000, concurrency: 2, maxQueue: 20, cooldownMs: 30000, linkTtlMs: 1800000, publicLinks: true, allowedRoles: ["Ботоводство"] },
      queue: [],
      history: [{ id: "demo-download", userTag: "DemoUser#0001", sourceHost: "youtube.com", status: "linked", sizeBytes: 31457280, createdAt: now() - 120000 }],
      available: [{ id: "demo-download", filename: "demo-video.mp4", size: 31457280, expiresAt: now() + 1800000, url: "#demo-download" }],
    });

    if (path === "/api/transcription-settings" && method === "GET") return json(copy(demoTranscriptionSettings));
    if (path === "/api/transcription-settings" && method === "PUT") {
      demoTranscriptionSettings.provider = body.provider || demoTranscriptionSettings.provider;
      demoTranscriptionSettings.model = body.model || demoTranscriptionSettings.model;
      for (const provider of ["openai", "mistral"]) {
        if (body.keys?.[provider]) demoTranscriptionSettings.keys[provider] = { configured: true, source: "panel", masked: "••••demo" };
        if (body.clear?.includes(provider)) demoTranscriptionSettings.keys[provider] = { configured: false, source: null, masked: null };
      }
      demoTranscriptionSettings.worker.loadedModel = demoTranscriptionSettings.provider === "local" ? demoTranscriptionSettings.model : "small";
      return json(copy(demoTranscriptionSettings));
    }

    if (path === "/api/transcriptions" && method === "POST") {
      const id = `00000000-0000-4000-8000-${String(now()).slice(-12)}`;
      demoTranscription = {
        id, guildId: DEMO_GUILD_ID, status: "recording", language: body.language || "auto",
        provider: body.provider || demoTranscriptionSettings.provider,
        model: body.model || demoTranscriptionSettings.model,
        startedAt: now(), chunks: [], segments: [],
      };
      demoTranscriptionSessions.unshift(copy(demoTranscription));
      return json(copy(demoTranscription), 201);
    }
    if (path === "/api/transcriptions" && method === "GET") return json({
      active: demoTranscription ? copy(demoTranscription) : null,
      workerQueue: 0,
      sessions: copy(demoTranscriptionSessions),
    });
    const demoTranscriptionStop = path.match(/^\/api\/transcriptions\/([^/]+)\/stop$/);
    if (demoTranscriptionStop && method === "POST") {
      if (!demoTranscription) return json({ error: "Демо-запись не активна." }, 400);
      demoTranscription.status = "completed";
      demoTranscription.segments = [
        { id: 1, startMs: 1200, endMs: 4600, speakerName: "DemoUser", text: "Это пример локальной транскрипции.", aecApplied: true, aecConfidence: 0.74 },
        { id: 2, startMs: 5100, endMs: 8200, speakerName: "SampleMod", text: "Музыка бота исключена из текста.", aecApplied: true, aecConfidence: 0.68 },
      ];
      demoTranscriptionSessions[0] = copy(demoTranscription);
      const result = copy(demoTranscription);
      demoTranscription = null;
      return json(result);
    }
    const demoTranscriptionDelete = path.match(/^\/api\/transcriptions\/([^/]+)$/);
    if (demoTranscriptionDelete && method === "DELETE") {
      demoTranscriptionSessions = demoTranscriptionSessions.filter((session) => session.id !== demoTranscriptionDelete[1]);
      return json({ ok: true });
    }

    if (path === "/api/remote-access" && method === "GET") return json({
      enabled: phoneEnabled,
      configured: true,
      provider: "cloudflare",
      publicUrl: phoneEnabled ? "https://demo.example.invalid" : null,
      devices: copy(phoneDevices),
    });
    if (path === "/api/remote-access" && method === "POST") {
      phoneEnabled = true;
      return json({
        enabled: true,
        configured: true,
        provider: "cloudflare",
        publicUrl: "https://demo.example.invalid",
        pairExpiresAt: now() + 5 * 60 * 1000,
        qrSvg: demoQrSvg(),
        devices: copy(phoneDevices),
      });
    }
    if (path === "/api/remote-access" && method === "DELETE") {
      phoneEnabled = false;
      phoneDevices = [];
      return json({ ok: true });
    }
    if (path === "/api/remote-access/sessions" && method === "DELETE") {
      const removed = phoneDevices.length;
      phoneDevices = [];
      return json({ removed });
    }
    if (/^\/api\/remote-access\/sessions\/[^/]+$/.test(path) && method === "DELETE") return json({ removed: 0 });

    return json({ error: `Эта операция не реализована в демо: ${method} ${path}` }, 404);
  }

  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request?.url || input, location.href);
    if (!url.pathname.startsWith("/api/")) return nativeFetch(input, init);
    const method = (init.method || request?.method || "GET").toUpperCase();
    await new Promise((resolve) => setTimeout(resolve, method === "GET" ? 55 : 120));
    return route(url.pathname, method, init);
  };

  const badge = document.createElement("span");
  badge.className = "demo-badge";
  badge.textContent = "● Демо-данные";
  badge.title = "API Discord не подключён; все изменения существуют только до обновления страницы.";
  document.querySelector(".statusbar")?.prepend(badge);
})();
