import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Collection } from "discord.js";
import { AccessControl, trustedIdentitySignature } from "./accessControl.js";
import { startWebServer } from "./server.js";
import { downloadService } from "../downloads/service.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ffmpegPath from "ffmpeg-static";
import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { getQueue } from "../music/queue.js";
import { AUDIO_CACHE_DIR } from "../music/source.js";

const SECRET = "integration-project-identity-secret-long-enough";
const OWNER = "owner@example.com";

function cookieFrom(response) {
  return String(response.headers.get("set-cookie") || "").split(";", 1)[0];
}

function identityHeaders(path, email, method = "GET") {
  const timestamp = Date.now();
  const nonce = `nonce-${timestamp}`;
  return {
    "x-dockerhub-identity-email": email,
    "x-dockerhub-identity-timestamp": String(timestamp),
    "x-dockerhub-identity-nonce": nonce,
    "x-dockerhub-identity-signature": trustedIdentitySignature(SECRET, { email, timestamp, nonce, method, path }),
  };
}

describe("web email access integration", () => {
  let access;
  let server;
  let base;

  beforeEach(() => {
    access = new AccessControl({ dbPath: ":memory:", publicBaseUrl: "https://discord.example.com", ownerEmail: OWNER });
    const client = {
      isReady: () => true,
      user: { tag: "TestBot#0001" },
      guilds: { cache: new Collection() },
    };
    server = startWebServer(client, 0, { accessControl: access, identitySecret: SECRET });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    await server.stopRemoteAccess();
    server.stopPanel();
    server.stop(true);
  });

  test("redeems a day invite only for the confirmed email", async () => {
    const invite = access.issueInvite("guest@example.com", "day", "discord:42");
    const path = new URL(invite.url).pathname + new URL(invite.url).search;

    const wrong = await fetch(`${base}${path}`, { headers: identityHeaders(path, "wrong@example.com"), redirect: "manual" });
    expect(wrong.status).toBe(403);

    const redeemed = await fetch(`${base}${path}`, { headers: identityHeaders(path, "guest@example.com"), redirect: "manual" });
    expect(redeemed.status).toBe(303);
    const cookie = cookieFrom(redeemed);
    expect(cookie).toContain("discordbot_access_session=");

    const me = await fetch(`${base}/api/access/me`, { headers: { cookie } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email: "guest@example.com", kind: "day", owner: false });
  });

  test("serves a short-lived download token without exposing the storage path", async () => {
    const filePath = join(tmpdir(), `discord-download-${crypto.randomUUID()}.txt`);
    await Bun.write(filePath, "download payload");
    downloadService.publicBaseUrl = base;
    const link = downloadService.createPublicLink({ id: crypto.randomUUID(), path: filePath, filename: "пример.txt", size: 16 });
    expect(link.url).not.toContain(filePath);
    const response = await fetch(link.url);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("content-disposition")).toContain("filename*=UTF-8''");
    expect(await response.text()).toBe("download payload");
    downloadService.cleanupExpired(link.expiresAt + 1);
  });

  test("queues an authenticated website video without holding the web request open", async () => {
    let submitted;
    const downloads = {
      status: () => ({ settings: {}, queue: [], history: [], available: [] }),
      startPublic: (request) => {
        submitted = request;
        return { id: "queued-video" };
      },
      takePublicFile: () => null,
    };
    const isolatedAccess = new AccessControl({ dbPath: ":memory:", publicBaseUrl: "https://discord.example.com", ownerEmail: OWNER });
    const isolatedClient = {
      isReady: () => true,
      user: { tag: "TestBot#0001" },
      guilds: { cache: new Collection() },
    };
    const isolated = startWebServer(isolatedClient, 0, {
      accessControl: isolatedAccess,
      identitySecret: SECRET,
      downloads,
    });
    const isolatedBase = `http://127.0.0.1:${isolated.port}`;
    try {
      const owner = await fetch(`${isolatedBase}/`, { redirect: "manual" });
      const cookie = cookieFrom(owner);
      const csrf = (await (await fetch(`${isolatedBase}/api/csrf`, { headers: { cookie } })).json()).token;
      const response = await fetch(`${isolatedBase}/api/downloads`, {
        method: "POST",
        headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
        body: JSON.stringify({
          guildId: "guild",
          url: "https://youtube.com/watch?v=abc",
          format: "video",
          quality: "1080",
        }),
      });
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({ id: "queued-video", status: "queued" });
      expect(submitted).toMatchObject({
        guildId: "guild",
        sourceUrl: "https://youtube.com/watch?v=abc",
        format: "video",
        quality: "1080",
      });
    } finally {
      await isolated.stopRemoteAccess();
      isolated.stopPanel();
      isolated.stop(true);
    }
  });

  test("starts and exports a transcription through the owner web panel", async () => {
    const voiceChannel = { id: "voice-1", name: "Meeting", isVoiceBased: () => true, toString: () => "#Meeting" };
    const messages = [];
    const textChannel = {
      id: "text-1", name: "transcripts", isTextBased: () => true, isThread: () => false,
      send: async (message) => messages.push(message),
    };
    const guild = {
      id: "guild-transcription",
      channels: { cache: new Collection([[voiceChannel.id, voiceChannel], [textChannel.id, textChannel]]) },
    };
    const session = {
      id: "00000000-0000-4000-8000-000000000001", guildId: guild.id,
      announceChannelId: textChannel.id, language: "auto", status: "recording",
    };
    const transcriptions = {
      status: () => ({ active: session, sessions: [session], workerQueue: 0 }),
      start: async (request) => ({ ...session, language: request.language }),
      details: () => session,
      stop: async () => ({ ...session, status: "finalizing" }),
      export: (_id, format) => ({ content: "[00:00:00] Алиса: Привет", filename: `transcript.${format}` }),
      delete: () => true,
    };
    const isolatedAccess = new AccessControl({ dbPath: ":memory:", publicBaseUrl: "https://discord.example.com", ownerEmail: OWNER });
    const isolatedClient = {
      isReady: () => true,
      user: { tag: "TestBot#0001" },
      guilds: { cache: new Collection([[guild.id, guild]]) },
    };
    const isolated = startWebServer(isolatedClient, 0, {
      accessControl: isolatedAccess, identitySecret: SECRET, transcriptions,
    });
    const isolatedBase = `http://127.0.0.1:${isolated.port}`;
    try {
      const owner = await fetch(`${isolatedBase}/`, { redirect: "manual" });
      const cookie = cookieFrom(owner);
      const csrf = (await (await fetch(`${isolatedBase}/api/csrf`, { headers: { cookie } })).json()).token;
      const started = await fetch(`${isolatedBase}/api/transcriptions`, {
        method: "POST",
        headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
        body: JSON.stringify({ guildId: guild.id, voiceChannelId: voiceChannel.id, announceChannelId: textChannel.id, language: "ru" }),
      });
      expect(started.status).toBe(201);
      expect(await started.json()).toMatchObject({ id: session.id, language: "ru" });
      expect(messages[0]).toContain("Транскрипция начата");

      const exported = await fetch(`${isolatedBase}/api/transcriptions/${session.id}/export?format=srt`, { headers: { cookie } });
      expect(exported.status).toBe(200);
      expect(exported.headers.get("content-type")).toContain("application/x-subrip");
      expect(await exported.text()).toContain("Алиса: Привет");
    } finally {
      await isolated.stopRemoteAccess();
      isolated.stopPanel();
      isolated.stop(true);
    }
  });

  test("streams the current cached track through the authenticated monitor endpoint", async () => {
    const guildId = `monitor-${crypto.randomUUID()}`;
    const filePath = join(AUDIO_CACHE_DIR, `${guildId}.wav`);
    const generated = spawnSync(ffmpegPath, [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000",
      "-t", "0.2", "-ac", "2", filePath,
    ]);
    expect(generated.status).toBe(0);
    const queue = getQueue(guildId);
    queue.playing = { queueId: crypto.randomUUID(), title: "Monitor fixture" };
    queue.currentLocalFile = filePath;
    queue.volume = 0.5;

    try {
      const owner = await fetch(`${base}/`, { redirect: "manual" });
      const response = await fetch(`${base}/api/music/${guildId}/monitor`, {
        headers: { cookie: cookieFrom(owner) },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("audio/mpeg");
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(100);
    } finally {
      queue.destroy();
      await rm(filePath, { force: true });
    }
  });

  test("owner activity blocks a guest mutation but not guest reads", async () => {
    const invite = access.issueInvite("guest@example.com", "day", "discord:42");
    const path = new URL(invite.url).pathname + new URL(invite.url).search;
    const redeemed = await fetch(`${base}${path}`, { headers: identityHeaders(path, "guest@example.com"), redirect: "manual" });
    const guestCookie = cookieFrom(redeemed);
    const guestCsrf = (await (await fetch(`${base}/api/csrf`, { headers: { cookie: guestCookie } })).json()).token;

    const ownerRoot = await fetch(`${base}/`, { redirect: "manual" });
    const ownerCookie = cookieFrom(ownerRoot);
    const ownerCsrf = (await (await fetch(`${base}/api/csrf`, { headers: { cookie: ownerCookie } })).json()).token;
    const ownerMutation = await fetch(`${base}/api/access/admin/invites`, {
      method: "POST",
      headers: { cookie: ownerCookie, "x-csrf-token": ownerCsrf, "content-type": "application/json" },
      body: JSON.stringify({ email: "member@example.com", kind: "permanent" }),
    });
    expect(ownerMutation.status).toBe(201);

    const guestRead = await fetch(`${base}/api/status`, { headers: { cookie: guestCookie } });
    expect(guestRead.status).toBe(200);
    const guestMutation = await fetch(`${base}/api/music/guild/stop`, {
      method: "POST",
      headers: { cookie: guestCookie, "x-csrf-token": guestCsrf, "content-type": "application/json" },
      body: "{}",
    });
    expect(guestMutation.status).toBe(423);
    expect((await guestMutation.json()).error).toContain("Владелец сейчас управляет");
  });

  test("activates a permanent account and later signs in with email and password", async () => {
    const invite = access.issueInvite("member@example.com", "permanent", "owner");
    const inviteUrl = new URL(invite.url);
    const path = `${inviteUrl.pathname}${inviteUrl.search}`;
    const setup = await fetch(`${base}${path}`, { headers: identityHeaders(path, "member@example.com"), redirect: "manual" });
    expect(setup.status).toBe(200);
    const setupHtml = await setup.text();
    expect(setupHtml).toContain("Создание постоянного доступа");
    expect(setupHtml).toContain('data-password-toggle="newPassword,newPasswordConfirm"');
    expect(setupHtml).toContain('autocomplete="username" readonly');
    expect(setupHtml).toContain("Сохранить пароль в браузере");
    expect(setupHtml).toContain('src="/access-auth.js"');
    const formProof = setupHtml.match(/name="proof" type="hidden" value="([^"]+)"/)?.[1];
    expect(formProof).toBeTruthy();

    const formPath = "/access/invite";
    const rejected = await fetch(`${base}${formPath}`, {
      method: "POST",
      headers: {
        ...identityHeaders(formPath, "member@example.com", "POST"),
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://attacker.example.com",
      },
      body: new URLSearchParams({
        token: inviteUrl.searchParams.get("token"),
        password: "a secure password",
        passwordConfirm: "a secure password",
      }),
      redirect: "manual",
    });
    expect(rejected.status).toBe(403);
    expect(await rejected.text()).toContain("Запрос отклонён");

    const activated = await fetch(`${base}${formPath}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "null",
      },
      body: new URLSearchParams({
        token: inviteUrl.searchParams.get("token"),
        proof: formProof,
        password: "a secure password",
        passwordConfirm: "a secure password",
      }),
      redirect: "manual",
    });
    expect(activated.status).toBe(303);

    const login = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://discord.example.com" },
      body: new URLSearchParams({ email: "member@example.com", password: "a secure password" }),
      redirect: "manual",
    });
    expect(login.status).toBe(303);
    expect(cookieFrom(login)).toContain("discordbot_access_session=");
  });

  test("offers password visibility before submitting the login form", async () => {
    const login = await fetch(`${base}/login`, {
      headers: {
        host: "discord.example.com",
        "x-forwarded-for": "203.0.113.10",
        "x-forwarded-host": "discord.example.com",
        "x-forwarded-proto": "https",
      },
      redirect: "manual",
    });
    expect(login.status).toBe(200);
    const html = await login.text();
    expect(html).toContain('id="loginPassword"');
    expect(html).toContain('data-password-toggle="loginPassword"');
    expect(html).toContain("Показать пароль");
    expect(html).toContain("Сохранить пароль в браузере");

    const script = await fetch(`${base}/access-auth.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("javascript");
    const scriptText = await script.text();
    expect(scriptText).toContain('input.type = show ? "text" : "password"');
    expect(scriptText).toContain("new PasswordCredential");
  });

  test("serves a Cloudflare-compatible CSP without weakening inline script protection", async () => {
    const first = await fetch(`${base}/login`, {
      headers: {
        host: "discord.example.com",
        "x-forwarded-for": "203.0.113.10",
        "x-forwarded-host": "discord.example.com",
        "x-forwarded-proto": "https",
      },
    });
    const second = await fetch(`${base}/login`, {
      headers: {
        host: "discord.example.com",
        "x-forwarded-for": "203.0.113.10",
        "x-forwarded-host": "discord.example.com",
        "x-forwarded-proto": "https",
      },
    });
    const firstCsp = first.headers.get("content-security-policy") ?? "";
    const secondCsp = second.headers.get("content-security-policy") ?? "";
    const scriptDirective = firstCsp.split(";").find((part) => part.trim().startsWith("script-src")) ?? "";

    expect(scriptDirective).toContain("'self'");
    expect(scriptDirective).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
    expect(scriptDirective).toContain("https://static.cloudflareinsights.com");
    expect(scriptDirective).not.toContain("'unsafe-inline'");
    expect(firstCsp).toContain("connect-src 'self' https://cloudflareinsights.com");
    expect(secondCsp).not.toBe(firstCsp);
  });

  test("returns an empty favicon response instead of a server error", async () => {
    const response = await fetch(`${base}/favicon.ico`);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  test("serves one CSP policy on the authenticated panel root", async () => {
    const response = await fetch(`${base}/`, { redirect: "manual" });
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(response.status).toBe(200);
    expect(csp.match(/default-src/g)?.length).toBe(1);
  });
});
