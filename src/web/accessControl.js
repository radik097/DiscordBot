import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

export const ACCESS_COOKIE = "discordbot_access_session";
export const DAY_MS = 24 * 60 * 60_000;
export const DEFAULT_OWNER_PRIORITY_MS = 5 * 60_000;

const DEFAULT_PERMANENT_SESSION_MS = 30 * DAY_MS;
const DEFAULT_INVITE_MS = DAY_MS;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

const sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");
const token = (bytes = 32) => randomBytes(bytes).toString("base64url");

export function normalizeEmail(value) {
  const email = String(value ?? "").trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) {
    const error = new Error("Укажите корректный адрес электронной почты");
    error.status = 400;
    throw error;
  }
  return email;
}

export function validatePassword(value) {
  const password = String(value ?? "");
  if (password.length < 12 || password.length > 128) {
    const error = new Error("Пароль должен содержать от 12 до 128 символов");
    error.status = 400;
    throw error;
  }
  return password;
}

export function hashPassword(password, salt = token(16)) {
  const normalized = validatePassword(password);
  const digest = scryptSync(normalized, salt, 64, SCRYPT_OPTIONS).toString("base64url");
  return `scrypt:${salt}:${digest}`;
}

export function verifyPassword(password, encoded) {
  const [algorithm, salt, expectedValue, extra] = String(encoded ?? "").split(":");
  if (algorithm !== "scrypt" || !salt || !expectedValue || extra) return false;
  let actual;
  try {
    actual = scryptSync(String(password ?? ""), salt, 64, SCRYPT_OPTIONS);
  } catch {
    return false;
  }
  const expected = Buffer.from(expectedValue, "base64url");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function trustedIdentitySignature(secret, { email, timestamp, nonce, method, path }) {
  return createHmac("sha256", secret)
    .update(`${normalizeEmail(email)}\n${timestamp}\n${nonce}\n${String(method).toUpperCase()}\n${path}`)
    .digest("base64url");
}

export function verifyTrustedIdentity(req, secret, now = Date.now()) {
  if (!secret || String(secret).length < 32) return null;
  const email = req.headers.get("x-dockerhub-identity-email");
  const timestamp = Number(req.headers.get("x-dockerhub-identity-timestamp"));
  const nonce = req.headers.get("x-dockerhub-identity-nonce");
  const supplied = req.headers.get("x-dockerhub-identity-signature");
  if (!email || !Number.isFinite(timestamp) || !nonce || !supplied || Math.abs(now - timestamp) > 60_000) return null;

  const url = new URL(req.url);
  let expected;
  try {
    expected = trustedIdentitySignature(secret, {
      email,
      timestamp,
      nonce,
      method: req.method,
      path: `${url.pathname}${url.search}`,
    });
  } catch {
    return null;
  }
  const actualBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  return { email: normalizeEmail(email) };
}

function parseCookie(req, name) {
  for (const item of String(req.headers.get("cookie") ?? "").split(";")) {
    const [candidate, ...value] = item.trim().split("=");
    if (candidate === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

function deviceName(userAgent) {
  const ua = String(userAgent || "Неизвестное устройство");
  const os = /Android/i.test(ua) ? "Android"
    : /iPhone|iPad/i.test(ua) ? "iPhone/iPad"
      : /Windows/i.test(ua) ? "Windows"
        : /Macintosh|Mac OS/i.test(ua) ? "macOS"
          : /Linux/i.test(ua) ? "Linux"
            : "Устройство";
  const browser = /Edg\//i.test(ua) ? "Edge"
    : /Firefox\//i.test(ua) ? "Firefox"
      : /CriOS|Chrome\//i.test(ua) ? "Chrome"
        : /Safari\//i.test(ua) ? "Safari"
          : "Браузер";
  return `${browser} · ${os}`;
}

function requestMetadata(req) {
  const forwarded = req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for") || "";
  const ip = String(forwarded).split(",")[0].trim().slice(0, 80) || null;
  const userAgent = String(req.headers.get("user-agent") || "Неизвестное устройство").slice(0, 240);
  return { ip, userAgent, device: deviceName(userAgent) };
}

function sessionRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    kind: row.kind,
    csrf: row.csrf,
    device: row.device,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

export class AccessControl {
  constructor({
    dbPath = process.env.ACCESS_DB_PATH || new URL("../../data/access.sqlite", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
    publicBaseUrl = process.env.ACCESS_PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL || "http://127.0.0.1:8787",
    ownerEmail = process.env.ACCESS_OWNER_EMAIL || "rodionaustralia@gmail.com",
    ownerPriorityMs = Number(process.env.ACCESS_OWNER_PRIORITY_MS) || DEFAULT_OWNER_PRIORITY_MS,
    now = () => Date.now(),
  } = {}) {
    this.dbPath = dbPath;
    this.publicBaseUrl = String(publicBaseUrl).replace(/\/$/, "");
    this.ownerEmail = normalizeEmail(ownerEmail);
    this.ownerPriorityMs = ownerPriorityMs;
    this.now = now;
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;");
    this.migrate();
    this.dummyPasswordHash = hashPassword("not-a-real-password-value");
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS access_invites (
        token_hash TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('day', 'permanent')),
        created_by TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_access_invites_email ON access_invites(email, expires_at);

      CREATE TABLE IF NOT EXISTS access_accounts (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        revoked_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS access_sessions (
        token_hash TEXT PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('owner', 'day', 'permanent')),
        csrf TEXT NOT NULL,
        device TEXT NOT NULL,
        user_agent TEXT NOT NULL,
        ip TEXT,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_access_sessions_email ON access_sessions(email, expires_at);
      CREATE INDEX IF NOT EXISTS idx_access_sessions_expires ON access_sessions(expires_at);

      CREATE TABLE IF NOT EXISTS access_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  close() {
    this.db.close();
  }

  cleanup() {
    const now = this.now();
    this.db.query("DELETE FROM access_sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL").run(now);
    this.db.query("DELETE FROM access_invites WHERE expires_at <= ? OR revoked_at IS NOT NULL OR used_at IS NOT NULL").run(now);
  }

  issueInvite(emailValue, kind = "day", issuedBy = null, ttlMs = DEFAULT_INVITE_MS) {
    const email = normalizeEmail(emailValue);
    if (!['day', 'permanent'].includes(kind)) {
      const error = new Error("Неизвестный тип доступа");
      error.status = 400;
      throw error;
    }
    const rawToken = token();
    const now = this.now();
    const expiresAt = now + Math.max(60_000, Number(ttlMs) || DEFAULT_INVITE_MS);
    this.db.query(`
      INSERT INTO access_invites (token_hash, email, kind, created_by, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(sha256(rawToken), email, kind, issuedBy ? String(issuedBy).slice(0, 160) : null, now, expiresAt);
    return {
      email,
      kind,
      expiresAt,
      url: `${this.publicBaseUrl}/access/invite?token=${encodeURIComponent(rawToken)}`,
    };
  }

  getInvite(rawToken) {
    if (!rawToken) return null;
    const now = this.now();
    const row = this.db.query(`
      SELECT email, kind, created_at, expires_at
      FROM access_invites
      WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?
    `).get(sha256(rawToken), now);
    return row ? { email: row.email, kind: row.kind, createdAt: row.created_at, expiresAt: row.expires_at } : null;
  }

  createSession(emailValue, kind, req, ttlMs) {
    const email = normalizeEmail(emailValue);
    const now = this.now();
    const rawToken = token();
    const metadata = requestMetadata(req);
    const session = {
      tokenHash: sha256(rawToken),
      id: token(12),
      email,
      kind,
      csrf: token(24),
      ...metadata,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + ttlMs,
    };
    this.db.query(`
      INSERT INTO access_sessions
        (token_hash, id, email, kind, csrf, device, user_agent, ip, created_at, last_seen_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(session.tokenHash, session.id, session.email, session.kind, session.csrf, session.device, session.userAgent, session.ip, session.createdAt, session.lastSeenAt, session.expiresAt);
    return { token: rawToken, session };
  }

  redeemDayInvite(rawToken, identityEmail, req) {
    const email = normalizeEmail(identityEmail);
    const invite = this.getInvite(rawToken);
    if (!invite || invite.kind !== "day" || invite.email !== email) return null;
    const now = this.now();
    const consume = this.db.query(`
      UPDATE access_invites SET used_at = ?
      WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ? AND email = ? AND kind = 'day'
    `).run(now, sha256(rawToken), now, email);
    if (consume.changes !== 1) return null;
    return this.createSession(email, "day", req, DAY_MS);
  }

  completePermanentInvite(rawToken, identityEmail, password, req) {
    const email = normalizeEmail(identityEmail);
    const invite = this.getInvite(rawToken);
    if (!invite || invite.kind !== "permanent" || invite.email !== email) return null;
    const passwordHash = hashPassword(password);
    const now = this.now();
    const consume = this.db.query(`
      UPDATE access_invites SET used_at = ?
      WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ? AND email = ? AND kind = 'permanent'
    `).run(now, sha256(rawToken), now, email);
    if (consume.changes !== 1) return null;
    this.db.query(`
      INSERT INTO access_accounts (id, email, password_hash, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET
        password_hash = excluded.password_hash,
        updated_at = excluded.updated_at,
        revoked_at = NULL
    `).run(token(12), email, passwordHash, "permanent-invite", now, now);
    return this.createSession(email, "permanent", req, DEFAULT_PERMANENT_SESSION_MS);
  }

  login(emailValue, password, req) {
    const email = normalizeEmail(emailValue);
    const account = this.db.query(`
      SELECT password_hash FROM access_accounts WHERE email = ? AND revoked_at IS NULL
    `).get(email);
    const valid = verifyPassword(password, account?.password_hash || this.dummyPasswordHash);
    if (!account || !valid) return null;
    return this.createSession(email, "permanent", req, DEFAULT_PERMANENT_SESSION_MS);
  }

  createOwnerSession(req) {
    return this.createSession(this.ownerEmail, "owner", req, DAY_MS);
  }

  authenticate(req, { trustedEmail = null } = {}) {
    this.cleanup();
    const rawToken = parseCookie(req, ACCESS_COOKIE);
    if (!rawToken) return null;
    const now = this.now();
    const row = this.db.query(`
      SELECT id, email, kind, csrf, device, created_at, last_seen_at, expires_at, revoked_at
      FROM access_sessions
      WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?
    `).get(sha256(rawToken), now);
    const session = sessionRow(row);
    if (!session) return null;
    if (session.kind === "owner" && normalizeEmail(trustedEmail || "invalid@example.invalid") !== this.ownerEmail) return null;
    if (now - session.lastSeenAt >= 60_000) {
      this.db.query("UPDATE access_sessions SET last_seen_at = ? WHERE id = ?").run(now, session.id);
      session.lastSeenAt = now;
    }
    return session;
  }

  sessionCookie(rawToken, expiresAt, req) {
    const secure = new URL(req.url).protocol === "https:" || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(new URL(req.url).hostname);
    return `${ACCESS_COOKIE}=${encodeURIComponent(rawToken)}; Path=/; Max-Age=${Math.max(0, Math.floor((expiresAt - this.now()) / 1000))}; HttpOnly${secure ? "; Secure" : ""}; SameSite=Lax`;
  }

  clearCookie(req) {
    const secure = new URL(req.url).protocol === "https:" || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(new URL(req.url).hostname);
    return `${ACCESS_COOKIE}=; Path=/; Max-Age=0; HttpOnly${secure ? "; Secure" : ""}; SameSite=Lax`;
  }

  revokeCurrent(req) {
    const rawToken = parseCookie(req, ACCESS_COOKIE);
    if (!rawToken) return false;
    return this.db.query("UPDATE access_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL").run(this.now(), sha256(rawToken)).changes > 0;
  }

  noteOwnerMutation() {
    const now = this.now();
    this.db.query(`
      INSERT INTO access_state (key, value, updated_at) VALUES ('owner_last_mutation', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(String(now), now);
    return now;
  }

  ownerActivity() {
    const row = this.db.query("SELECT value FROM access_state WHERE key = 'owner_last_mutation'").get();
    const lastMutationAt = Number(row?.value) || 0;
    const lockedUntil = lastMutationAt + this.ownerPriorityMs;
    return { lastMutationAt: lastMutationAt || null, lockedUntil, active: lockedUntil > this.now() };
  }

  authorizeMutation(session) {
    if (!session) return { allowed: false, status: 401, reason: "Требуется авторизация" };
    if (session.kind === "owner") {
      this.noteOwnerMutation();
      return { allowed: true };
    }
    const owner = this.ownerActivity();
    if (owner.active) {
      return {
        allowed: false,
        status: 423,
        reason: "Владелец сейчас управляет ботом. Повторите после периода бездействия владельца.",
        retryAfterMs: owner.lockedUntil - this.now(),
      };
    }
    return { allowed: true };
  }

  listAdminState() {
    this.cleanup();
    const accounts = this.db.query(`
      SELECT id, email, created_at AS createdAt, updated_at AS updatedAt, revoked_at AS revokedAt
      FROM access_accounts ORDER BY created_at DESC
    `).all();
    const sessions = this.db.query(`
      SELECT id, email, kind, device, created_at AS createdAt, last_seen_at AS lastSeenAt, expires_at AS expiresAt
      FROM access_sessions WHERE revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC
    `).all(this.now());
    return { accounts, sessions, owner: this.ownerActivity() };
  }

  revokeSession(id) {
    return this.db.query("UPDATE access_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(this.now(), String(id)).changes > 0;
  }

  revokeAccount(id) {
    const now = this.now();
    const account = this.db.query("SELECT email FROM access_accounts WHERE id = ? AND revoked_at IS NULL").get(String(id));
    if (!account) return false;
    this.db.transaction(() => {
      this.db.query("UPDATE access_accounts SET revoked_at = ?, updated_at = ? WHERE id = ?").run(now, now, String(id));
      this.db.query("UPDATE access_sessions SET revoked_at = ? WHERE email = ? AND kind = 'permanent' AND revoked_at IS NULL").run(now, account.email);
    })();
    return true;
  }
}
