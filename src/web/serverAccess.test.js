import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Collection } from "discord.js";
import { AccessControl, trustedIdentitySignature } from "./accessControl.js";
import { startWebServer } from "./server.js";

const SECRET = "integration-project-identity-secret-long-enough";
const OWNER = "rodionaustralia@gmail.com";

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
        ...identityHeaders(formPath, "member@example.com", "POST"),
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://discord.example.com",
      },
      body: new URLSearchParams({
        token: inviteUrl.searchParams.get("token"),
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
});
