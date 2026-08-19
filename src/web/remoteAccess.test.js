import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteAccess, isLocalRequest } from "./remoteAccess.js";

describe("mobile remote access", () => {
  test("distinguishes local requests from forwarded tunnel traffic", () => {
    expect(isLocalRequest(new Request("http://127.0.0.1:8787/", { headers: { host: "127.0.0.1:8787" } }))).toBe(true);
    expect(isLocalRequest(new Request("https://demo.ngrok.app/", { headers: { host: "demo.ngrok.app", "x-forwarded-for": "203.0.113.2" } }))).toBe(false);
  });

  test("pairing tokens coexist, survive link previews, and are consumed only by exchange", async () => {
    const oldToken = process.env.NGROK_AUTHTOKEN;
    process.env.NGROK_AUTHTOKEN = "test-token";
    let closed = false;
    const access = new RemoteAccess({
      port: 8787,
      sessionFile: null,
      tunnelFactory: async () => ({ url: () => "https://demo.ngrok.app", close: async () => { closed = true; } }),
    });
    try {
      const pairing = await access.start();
      expect(pairing.qrSvg).toContain("<svg");
      const pairToken = new URL(pairing.connectUrl).searchParams.get("token");
      const secondPairing = await access.issuePairing();
      const secondPairToken = new URL(secondPairing.connectUrl).searchParams.get("token");
      expect(access.isPairingValid(pairToken)).toBe(true);
      expect(access.isPairingValid(pairToken)).toBe(true);
      expect(access.isPairingValid(secondPairToken)).toBe(true);
      expect(access.exchange("wrong-token")).toBeNull();
      const remoteRequest = new Request("https://demo.ngrok.app/connect", { headers: { "user-agent": "Mozilla/5.0 (Linux; Android 15) Chrome/140", "x-forwarded-for": "203.0.113.2" } });
      const session = access.exchange(pairToken, remoteRequest);
      expect(session).not.toBeNull();
      expect(access.exchange(pairToken)).toBeNull();
      expect(access.isPairingValid(secondPairToken)).toBe(true);
      expect(access.listSessions()[0].name).toBe("Chrome · Android");
      const cookie = access.sessionCookie(session.sessionToken, session.expiresAt);
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Secure");
      const auth = access.isAuthenticated(new Request("https://demo.ngrok.app/", { headers: { cookie } }));
      expect(auth).toBeTruthy();
      expect(typeof auth).toBe("object");
      const deviceId = access.listSessions()[0].id;
      expect(access.revokeSession(deviceId)).toBe(true);
      expect(access.isAuthenticated(new Request("https://demo.ngrok.app/", { headers: { cookie } }))).toBe(false);
      access.exchange(secondPairToken, remoteRequest);
      expect(access.revokeAllSessions()).toBe(1);
      await access.stop();
      expect(closed).toBe(true);
      expect(access.isAuthenticated(new Request("https://demo.ngrok.app/", { headers: { cookie } }))).toBe(false);
    } finally {
      if (oldToken === undefined) delete process.env.NGROK_AUTHTOKEN;
      else process.env.NGROK_AUTHTOKEN = oldToken;
    }
  });

  test("restores hashed sessions after a process restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "discordbot-mobile-"));
    const sessionFile = join(dir, "sessions.json");
    const oldToken = process.env.NGROK_AUTHTOKEN;
    process.env.NGROK_AUTHTOKEN = "test-token";
    try {
      const first = new RemoteAccess({ sessionFile, tunnelFactory: async () => ({ url: () => "https://stable.ngrok.app", close: async () => {} }) });
      const pairing = await first.start();
      const issued = first.exchange(new URL(pairing.connectUrl).searchParams.get("token"), new Request("https://stable.ngrok.app/connect", { headers: { "user-agent": "Safari iPhone" } }));
      const cookie = first.sessionCookie(issued.sessionToken, issued.expiresAt);
      const restored = new RemoteAccess({ sessionFile });
      expect(restored.listSessions()).toHaveLength(1);
      expect(typeof restored.isAuthenticated(new Request("https://stable.ngrok.app/", { headers: { cookie } }))).toBe("object");
    } finally {
      if (oldToken === undefined) delete process.env.NGROK_AUTHTOKEN;
      else process.env.NGROK_AUTHTOKEN = oldToken;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
