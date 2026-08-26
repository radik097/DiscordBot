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
    expect(await setup.text()).toContain("Создание постоянного доступа");

    const formPath = "/access/invite";
    const activated = await fetch(`${base}${formPath}`, {
      method: "POST",
      headers: {
        ...identityHeaders(formPath, "member@example.com", "POST"),
        "content-type": "application/x-www-form-urlencoded",
        origin: base,
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
      headers: { "content-type": "application/x-www-form-urlencoded", origin: base },
      body: new URLSearchParams({ email: "member@example.com", password: "a secure password" }),
      redirect: "manual",
    });
    expect(login.status).toBe(303);
    expect(cookieFrom(login)).toContain("discordbot_access_session=");
  });
});
