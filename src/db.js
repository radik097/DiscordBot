import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = new URL("../data/history.sqlite", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const MESSAGE_RETENTION_MS = Number(process.env.MESSAGE_HISTORY_TTL_MS) || 30 * 24 * 60 * 60_000;
const HISTORY_ARCHIVE_BATCH = Number(process.env.MESSAGE_ARCHIVE_BATCH) || 500;

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH, { create: true });

db.exec("PRAGMA journal_mode=WAL;");
db.exec("PRAGMA synchronous=NORMAL;");
db.exec("PRAGMA busy_timeout=5000;");

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    channel_name TEXT,
    author_id TEXT NOT NULL,
    author_tag TEXT,
    content TEXT,
    attachments TEXT,
    created_at INTEGER NOT NULL,
    edited_at INTEGER,
    deleted_at INTEGER
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS message_archive (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    channel_name TEXT,
    author_id TEXT NOT NULL,
    author_tag TEXT,
    content TEXT,
    attachments TEXT,
    created_at INTEGER NOT NULL,
    edited_at INTEGER,
    deleted_at INTEGER,
    archived_at INTEGER NOT NULL
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS mobile_sessions (
    hash TEXT PRIMARY KEY,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    user_agent TEXT NOT NULL,
    ip TEXT,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS queue_states (
    guild_id TEXT PRIMARY KEY,
    version INTEGER NOT NULL DEFAULT 2,
    state_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    action TEXT NOT NULL,
    actor_session TEXT,
    actor_guild_id TEXT,
    actor_ip TEXT,
    actor_user_agent TEXT,
    resource TEXT,
    details TEXT
  );
`);

db.exec("CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at);");
db.exec("CREATE INDEX IF NOT EXISTS idx_messages_guild ON messages(guild_id, created_at);");
db.exec("CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);");
db.exec("CREATE INDEX IF NOT EXISTS idx_messages_archived_at ON message_archive(archived_at);");
db.exec("CREATE INDEX IF NOT EXISTS idx_audit_action_time ON audit_log(action, created_at);");
db.exec("CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_log(actor_session);");
db.exec("CREATE INDEX IF NOT EXISTS idx_mobile_sessions_expires_at ON mobile_sessions(expires_at);");
db.exec("CREATE INDEX IF NOT EXISTS idx_queue_states_updated_at ON queue_states(updated_at);");

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at)
`);

const insertStmt = db.prepare(`
  INSERT INTO messages (id, guild_id, channel_id, channel_name, author_id, author_tag, content, attachments, created_at)
  VALUES ($id, $guildId, $channelId, $channelName, $authorId, $authorTag, $content, $attachments, $createdAt)
  ON CONFLICT(id) DO NOTHING
`);
const upsertMobileSessionStmt = db.prepare(`
  INSERT INTO mobile_sessions (hash, id, name, user_agent, ip, created_at, last_seen_at, expires_at)
  VALUES ($hash, $id, $name, $userAgent, $ip, $createdAt, $lastSeenAt, $expiresAt)
  ON CONFLICT(hash) DO UPDATE SET
    id = excluded.id,
    name = excluded.name,
    user_agent = excluded.user_agent,
    ip = excluded.ip,
    created_at = excluded.created_at,
    last_seen_at = excluded.last_seen_at,
    expires_at = excluded.expires_at
`);
const removeMobileSessionStmt = db.prepare(`DELETE FROM mobile_sessions WHERE hash = $hash`);
const removeMobileSessionByIdStmt = db.prepare(`DELETE FROM mobile_sessions WHERE id = $id`);
const clearMobileSessionsStmt = db.prepare(`DELETE FROM mobile_sessions`);
const clearMobileSessionsExpiredStmt = db.prepare(`DELETE FROM mobile_sessions WHERE expires_at <= $now`);

const listMobileSessionsStmt = db.prepare(`
  SELECT
    hash,
    id,
    name,
    user_agent AS userAgent,
    ip,
    created_at AS createdAt,
    last_seen_at AS lastSeenAt,
    expires_at AS expiresAt
  FROM mobile_sessions
  ORDER BY last_seen_at DESC
`);
const getMobileSessionByHashStmt = db.prepare(`
  SELECT
    hash,
    id,
    name,
    user_agent AS userAgent,
    ip,
    created_at AS createdAt,
    last_seen_at AS lastSeenAt,
    expires_at AS expiresAt
  FROM mobile_sessions
  WHERE hash = $hash
`);

const queueStateUpsertStmt = db.prepare(`
  INSERT INTO queue_states (guild_id, version, state_json, updated_at)
  VALUES ($guildId, $version, $stateJson, $updatedAt)
  ON CONFLICT(guild_id) DO UPDATE SET
    version = excluded.version,
    state_json = excluded.state_json,
    updated_at = excluded.updated_at
`);
const queueStateGetStmt = db.prepare(`
  SELECT version, state_json, updated_at
  FROM queue_states
  WHERE guild_id = $guildId
`);
const queueStateListStmt = db.prepare(`
  SELECT guild_id, version, state_json, updated_at
  FROM queue_states
`);
const queueStateDeleteStmt = db.prepare(`DELETE FROM queue_states WHERE guild_id = $guildId`);
const queueStateClearStmt = db.prepare(`DELETE FROM queue_states`);
const markEditedStmt = db.prepare(`UPDATE messages SET content = $content, edited_at = $editedAt WHERE id = $id`);
const markDeletedStmt = db.prepare(`UPDATE messages SET deleted_at = $deletedAt WHERE id = $id`);
const archiveMessagesStmt = db.prepare(`
  INSERT INTO message_archive (id, guild_id, channel_id, channel_name, author_id, author_tag, content, attachments, created_at, edited_at, deleted_at, archived_at)
  SELECT id, guild_id, channel_id, channel_name, author_id, author_tag, content, attachments, created_at, edited_at, deleted_at, $archivedAt
  FROM messages
  WHERE id IN (SELECT id FROM messages WHERE created_at < $threshold ORDER BY created_at LIMIT $limit)
`);
const cleanupMessagesStmt = db.prepare(`
  DELETE FROM messages
  WHERE id IN (SELECT id FROM messages WHERE created_at < $threshold ORDER BY created_at LIMIT $limit)
`);
const countExpiredMessagesStmt = db.prepare(`
  SELECT COUNT(*) as c
  FROM messages
  WHERE created_at < $threshold
`);
const listMessageChannelsStmt = db.prepare(`SELECT DISTINCT channel_id, channel_name FROM messages WHERE guild_id = $guildId ORDER BY channel_name`);

const insertAuditStmt = db.prepare(`
  INSERT INTO audit_log (created_at, action, actor_session, actor_guild_id, actor_ip, actor_user_agent, resource, details)
  VALUES ($createdAt, $action, $actorSession, $actorGuildId, $actorIp, $actorUserAgent, $resource, $details)
`);

export function logMessage(message) {
  insertStmt.run({
    $id: message.id,
    $guildId: message.guildId ?? "",
    $channelId: message.channelId,
    $channelName: message.channel?.name ?? null,
    $authorId: message.author.id,
    $authorTag: message.author.tag,
    $content: message.content ?? "",
    $attachments: JSON.stringify([...message.attachments.values()].map((a) => a.url)),
    $createdAt: message.createdTimestamp,
  });
}

export function logEdit(message) {
  markEditedStmt.run({
    $id: message.id,
    $content: message.content ?? "",
    $editedAt: Date.now(),
  });
}

export function logDelete(messageId) {
  markDeletedStmt.run({ $id: messageId, $deletedAt: Date.now() });
}

export function archiveExpiredHistory() {
  const threshold = Date.now() - MESSAGE_RETENTION_MS;
  const total = countExpiredMessagesStmt.get({ $threshold: threshold }).c ?? 0;
  if (total <= 0) return 0;

  const limit = HISTORY_ARCHIVE_BATCH;
  const archivedAt = Date.now();
  let moved = 0;
  while (true) {
    archiveMessagesStmt.run({
      $threshold: threshold,
      $limit: limit,
      $archivedAt: archivedAt,
    });
    cleanupMessagesStmt.run({
      $threshold: threshold,
      $limit: limit,
    });
    const changed = cleanupMessagesStmt.changes;
    moved += changed;
    if (changed < limit) break;
  }
  return moved;
}

export function getSavedMobileSessions() {
  return listMobileSessionsStmt.all();
}

export function getSavedMobileSession(hash) {
  return getMobileSessionByHashStmt.get({ $hash: hash }) || null;
}

export function setSavedMobileSession(session) {
  upsertMobileSessionStmt.run({
    $hash: session.hash,
    $id: session.id,
    $name: session.name,
    $userAgent: session.userAgent,
    $ip: session.ip ?? null,
    $createdAt: session.createdAt,
    $lastSeenAt: session.lastSeenAt,
    $expiresAt: session.expiresAt,
  });
}

export function clearExpiredMobileSessions(now = Date.now()) {
  return clearMobileSessionsExpiredStmt.run({ $now: now }).changes;
}

export function clearSavedMobileSessionByHash(hash) {
  return removeMobileSessionStmt.run({ $hash: hash }).changes > 0;
}

export function clearSavedMobileSessionById(id) {
  return removeMobileSessionByIdStmt.run({ $id: id }).changes > 0;
}

export function clearAllSavedMobileSessions() {
  return clearMobileSessionsStmt.run().changes;
}

export function getSavedQueueState(guildId) {
  const row = queueStateGetStmt.get({ $guildId: guildId });
  if (!row) return null;
  return {
    version: row.version,
    updatedAt: row.updated_at,
    state: parseJsonOrNull(row.state_json),
  };
}

export function getSavedQueueStates() {
  return queueStateListStmt.all().map((row) => ({
    guildId: row.guild_id,
    version: row.version,
    updatedAt: row.updated_at,
    state: parseJsonOrNull(row.state_json),
  }));
}

export function setSavedQueueState(guildId, version, stateJson, updatedAt = Date.now()) {
  queueStateUpsertStmt.run({
    $guildId: guildId,
    $version: Number(version) || 2,
    $stateJson: JSON.stringify(stateJson ?? {}),
    $updatedAt: updatedAt,
  });
}

export function clearSavedQueueState(guildId) {
  queueStateDeleteStmt.run({ $guildId: guildId });
}

export function clearAllSavedQueueStates() {
  queueStateClearStmt.run();
}

export function getHistory({ guildId, channelId, limit = 50 } = {}) {
  const clauses = [];
  const params = {};
  if (guildId) {
    clauses.push("guild_id = $guildId");
    params.$guildId = guildId;
  }
  if (channelId) {
    clauses.push("channel_id = $channelId");
    params.$channelId = channelId;
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  params.$limit = Math.min(Math.max(Number(limit) || 50, 1), 500);
  return db.prepare(`SELECT * FROM messages ${where} ORDER BY created_at DESC LIMIT $limit`).all(params);
}

export function getStats(guildId) {
  const totalMessages = db
    .prepare(`SELECT COUNT(*) as c FROM messages WHERE guild_id = $g AND deleted_at IS NULL`)
    .get({ $g: guildId }).c;
  const topUsers = db
    .prepare(`
      SELECT author_tag, COUNT(*) as count FROM messages
      WHERE guild_id = $g AND deleted_at IS NULL
      GROUP BY author_id ORDER BY count DESC LIMIT 10
    `)
    .all({ $g: guildId });
  const topChannels = db
    .prepare(`
      SELECT channel_name, COUNT(*) as count FROM messages
      WHERE guild_id = $g AND deleted_at IS NULL
      GROUP BY channel_id ORDER BY count DESC LIMIT 10
    `)
    .all({ $g: guildId });
  const last7Days = db
    .prepare(`
      SELECT date(created_at / 1000, 'unixepoch') as day, COUNT(*) as count FROM messages
      WHERE guild_id = $g AND deleted_at IS NULL AND created_at >= $since
      GROUP BY day ORDER BY day
    `)
    .all({ $g: guildId, $since: Date.now() - 7 * 24 * 60 * 60 * 1000 });

  return { totalMessages, topUsers, topChannels, last7Days };
}

export function listHistoryChannels(guildId) {
  return listMessageChannelsStmt.all({ $guildId: guildId });
}

export function logAuditAction({
  action,
  actorSession = null,
  actorGuildId = null,
  actorIp = null,
  actorUserAgent = null,
  resource = null,
  details = null,
} = {}) {
  insertAuditStmt.run({
    $createdAt: Date.now(),
    $action: String(action || "").slice(0, 120),
    $actorSession: actorSession,
    $actorGuildId: actorGuildId,
    $actorIp: actorIp,
    $actorUserAgent: actorUserAgent,
    $resource: resource ? String(resource).slice(0, 200) : null,
    $details: details ? JSON.stringify(details).slice(0, 1024) : null,
  });
}

export function listRecentAudits({ guildId, limit = 50 } = {}) {
  return db
    .prepare(`
      SELECT id, created_at as createdAt, action, actor_session, actor_guild_id, actor_ip, actor_user_agent, resource, details
      FROM audit_log
      WHERE actor_guild_id IS NULL OR actor_guild_id = $guildId
      ORDER BY created_at DESC
      LIMIT $limit
    `)
    .all({ $guildId: guildId ?? "", $limit: Math.min(Math.max(Number(limit) || 50, 1), 200) });
}

function parseJsonOrNull(value) {
  if (value === null || value === undefined) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
