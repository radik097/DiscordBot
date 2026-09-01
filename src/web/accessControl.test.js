import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ACCESS_COOKIE,
  AccessControl,
  DAY_MS,
  hashPassword,
  normalizeEmail,
  trustedIdentitySignature,
  verifyPassword,
  verifyTrustedIdentity,
} from "./accessControl.js";

const OWNER = "owner@example.com";
const SECRET = "test-project-identity-secret-that-is-long-enough";

function request(path = "/", { cookie = "", email, now = Date.now(), method = "GET", userAgent = "Chrome Windows" } = {}) {
  const headers = new Headers({ "user-agent": userAgent, "cf-connecting-ip": "203.0.113.4" });
  if (cookie) headers.set("cookie", cookie);
  if (email) {
    const nonce = "request-nonce";
    headers.set("x-dockerhub-identity-email", email);
    headers.set("x-dockerhub-identity-timestamp", String(now));
    headers.set("x-dockerhub-identity-nonce", nonce);
    headers.set("x-dockerhub-identity-signature", trustedIdentitySignature(SECRET, {
      email,
      timestamp: now,
      nonce,
      method,
      path,
    }));
  }
  return new Request(`https://discord.example.com${path}`, { method, headers });
}

function cookieHeader(result, access, req) {
  return access.sessionCookie(result.token, result.session.expiresAt, req).split(";", 1)[0];
}

describe("AccessControl", () => {
  let clock;
  let access;

  beforeEach(() => {
    clock = Date.UTC(2026, 7, 26, 4, 0, 0);
    access = new AccessControl({
      dbPath: ":memory:",
      publicBaseUrl: "https://discord.example.com",
      ownerEmail: OWNER,
      ownerPriorityMs: 5 * 60_000,
      now: () => clock,
    });
  });

  afterEach(() => access.close());

  test("normalizes email and hashes passwords with a unique salt", () => {
    expect(normalizeEmail(" Person@Example.COM ")).toBe("person@example.com");
    expect(() => normalizeEmail("not-an-email")).toThrow();
    const first = hashPassword("a secure password");
    const second = hashPassword("a secure password");
    expect(first).not.toBe(second);
    expect(verifyPassword("a secure password", first)).toBe(true);
    expect(verifyPassword("wrong password", first)).toBe(false);
  });

  test("issues a single-use email-bound link and creates an exact 24 hour session", () => {
    const invite = access.issueInvite("guest@example.com", "day", "discord:42");
    expect(invite.url).toContain("/access/invite?token=");
    expect(invite.expiresAt).toBe(clock + DAY_MS);
    const rawToken = new URL(invite.url).searchParams.get("token");
    expect(access.redeemDayInvite(rawToken, "attacker@example.com", request())).toBeNull();

    const redeemed = access.redeemDayInvite(rawToken, "guest@example.com", request());
    expect(redeemed.session.kind).toBe("day");
    expect(redeemed.session.expiresAt).toBe(clock + DAY_MS);
    expect(access.redeemDayInvite(rawToken, "guest@example.com", request())).toBeNull();

    const cookie = cookieHeader(redeemed, access, request());
    expect(access.authenticate(request("/api/status", { cookie }))?.email).toBe("guest@example.com");
    clock += DAY_MS + 1;
    expect(access.authenticate(request("/api/status", { cookie }))).toBeNull();
  });

  test("activates a permanent account after email proof and supports later password login", () => {
    const invite = access.issueInvite("member@example.com", "permanent", "owner");
    const rawToken = new URL(invite.url).searchParams.get("token");
    const activated = access.completePermanentInvite(rawToken, "member@example.com", "a secure password", request());
    expect(activated.session.kind).toBe("permanent");
    expect(access.completePermanentInvite(rawToken, "member@example.com", "another secure password", request())).toBeNull();

    expect(access.login("member@example.com", "wrong password", request())).toBeNull();
    const login = access.login("MEMBER@example.com", "a secure password", request());
    expect(login.session.kind).toBe("permanent");
    expect(login.session.expiresAt).toBeGreaterThan(clock + DAY_MS);
  });

  test("gives owner mutations a five minute priority lease without blocking reads", () => {
    const owner = access.createOwnerSession(request());
    const dayInvite = access.issueInvite("guest@example.com");
    const guest = access.redeemDayInvite(new URL(dayInvite.url).searchParams.get("token"), "guest@example.com", request());

    expect(access.authorizeMutation(guest.session).allowed).toBe(true);
    expect(access.authorizeMutation(owner.session).allowed).toBe(true);
    const denied = access.authorizeMutation(guest.session);
    expect(denied.allowed).toBe(false);
    expect(denied.status).toBe(423);
    clock += 5 * 60_000 + 1;
    expect(access.authorizeMutation(guest.session).allowed).toBe(true);
  });

  test("requires a current signed gateway identity for owner sessions", () => {
    const owner = access.createOwnerSession(request());
    const cookie = cookieHeader(owner, access, request());
    expect(access.authenticate(request("/api/status", { cookie }), { trustedEmail: OWNER })?.kind).toBe("owner");
    expect(access.authenticate(request("/api/status", { cookie }))).toBeNull();
  });

  test("verifies a signed identity only for the original request", () => {
    const now = clock;
    const valid = request("/access/invite?token=abc", { email: "guest@example.com", now });
    expect(verifyTrustedIdentity(valid, SECRET, now)).toEqual({ email: "guest@example.com" });
    expect(verifyTrustedIdentity(valid, SECRET, now + 60_001)).toBeNull();

    const tampered = new Request("https://discord.example.com/access/invite?token=other", { headers: valid.headers });
    expect(verifyTrustedIdentity(tampered, SECRET, now)).toBeNull();
  });

  test("revokes a permanent account and all of its sessions", () => {
    const invite = access.issueInvite("member@example.com", "permanent", "owner");
    const rawToken = new URL(invite.url).searchParams.get("token");
    const activated = access.completePermanentInvite(rawToken, "member@example.com", "a secure password", request());
    const state = access.listAdminState();
    expect(state.accounts).toHaveLength(1);
    expect(state.sessions).toHaveLength(1);
    expect(access.revokeAccount(state.accounts[0].id)).toBe(true);
    const cookie = cookieHeader(activated, access, request());
    expect(access.authenticate(request("/", { cookie }))).toBeNull();
  });
});
