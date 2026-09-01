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

db.exec(`
  CREATE TABLE IF NOT EXISTS downloads (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    channel_id TEXT,
    user_id TEXT NOT NULL,
    user_tag TEXT,
    source_host TEXT NOT NULL,
    source_url TEXT NOT NULL,
    status TEXT NOT NULL,
    filename TEXT,
    size_bytes INTEGER,
    error TEXT,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,
    expires_at INTEGER
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS music_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    cache_file TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    duration_sec REAL NOT NULL DEFAULT 0,
    thumbnail TEXT,
    requested_by TEXT,
    source_type TEXT,
    source_service TEXT,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    first_played_at INTEGER NOT NULL,
    last_played_at INTEGER NOT NULL,
    play_count INTEGER NOT NULL DEFAULT 1,
    UNIQUE(guild_id, cache_file)
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS transcription_sessions (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    voice_channel_id TEXT NOT NULL,
    announce_channel_id TEXT,
    status TEXT NOT NULL,
    language TEXT NOT NULL DEFAULT 'auto',
    started_by_id TEXT NOT NULL,
    started_by_tag TEXT,
    started_at INTEGER NOT NULL,
    stopped_at INTEGER,
    audio_expires_at INTEGER NOT NULL,
    audio_deleted_at INTEGER,
    error TEXT
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS transcription_chunks (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    status TEXT NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    directory TEXT NOT NULL,
    speaker_count INTEGER NOT NULL DEFAULT 0,
    aec_confidence REAL,
    error TEXT,
    created_at INTEGER NOT NULL,
    processed_at INTEGER,
    UNIQUE(session_id, chunk_index)
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS transcription_segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    chunk_id TEXT NOT NULL,
    speaker_id TEXT NOT NULL,
    speaker_name TEXT NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    text TEXT NOT NULL,
    language TEXT,
    confidence REAL,
    aec_applied INTEGER NOT NULL DEFAULT 0,
    aec_confidence REAL,
    created_at INTEGER NOT NULL
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
db.exec("CREATE INDEX IF NOT EXISTS idx_downloads_guild_created ON downloads(guild_id, created_at);");
db.exec("CREATE INDEX IF NOT EXISTS idx_music_history_guild_played ON music_history(guild_id, last_played_at);");
db.exec("CREATE INDEX IF NOT EXISTS idx_transcription_sessions_guild_started ON transcription_sessions(guild_id, started_at DESC);");
db.exec("CREATE INDEX IF NOT EXISTS idx_transcription_chunks_session_index ON transcription_chunks(session_id, chunk_index);");
db.exec("CREATE INDEX IF NOT EXISTS idx_transcription_segments_session_time ON transcription_segments(session_id, start_ms, id);");

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
const insertDownloadStmt = db.prepare(`
  INSERT INTO downloads (id, guild_id, channel_id, user_id, user_tag, source_host, source_url, status, created_at)
  VALUES ($id, $guildId, $channelId, $userId, $userTag, $sourceHost, $sourceUrl, $status, $createdAt)
`);
const upsertMusicHistoryStmt = db.prepare(`
  INSERT INTO music_history (
    guild_id, cache_file, url, title, duration_sec, thumbnail, requested_by,
    source_type, source_service, size_bytes, first_played_at, last_played_at, play_count
  ) VALUES (
    $guildId, $cacheFile, $url, $title, $durationSec, $thumbnail, $requestedBy,
    $sourceType, $sourceService, $sizeBytes, $playedAt, $playedAt, 1
  )
  ON CONFLICT(guild_id, cache_file) DO UPDATE SET
    url = excluded.url,
    title = excluded.title,
    duration_sec = excluded.duration_sec,
    thumbnail = excluded.thumbnail,
    requested_by = excluded.requested_by,
    source_type = excluded.source_type,
    source_service = excluded.source_service,
    size_bytes = excluded.size_bytes,
    last_played_at = excluded.last_played_at,
    play_count = music_history.play_count + 1
`);
const listMusicHistoryStmt = db.prepare(`
  SELECT id, guild_id AS guildId, cache_file AS cacheFile, url, title,
         duration_sec AS durationSec, thumbnail, requested_by AS requestedBy,
         source_type AS sourceType, source_service AS sourceService,
         size_bytes AS sizeBytes, first_played_at AS firstPlayedAt,
         last_played_at AS lastPlayedAt, play_count AS playCount
  FROM music_history
  WHERE guild_id = $guildId
  ORDER BY last_played_at DESC
  LIMIT $limit
`);
const getMusicHistoryStmt = db.prepare(`
  SELECT id, guild_id AS guildId, cache_file AS cacheFile, url, title,
         duration_sec AS durationSec, thumbnail, requested_by AS requestedBy,
         source_type AS sourceType, source_service AS sourceService,
         size_bytes AS sizeBytes, first_played_at AS firstPlayedAt,
         last_played_at AS lastPlayedAt, play_count AS playCount
  FROM music_history
  WHERE guild_id = $guildId AND id = $id
`);
const deleteMusicHistoryStmt = db.prepare(`DELETE FROM music_history WHERE guild_id = $guildId AND id = $id`);
const clearMusicHistoryStmt = db.prepare(`DELETE FROM music_history WHERE guild_id = $guildId`);

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

export function createDownloadRecord(record) {
  insertDownloadStmt.run({
    $id: record.id,
    $guildId: record.guildId ?? "",
    $channelId: record.channelId ?? null,
    $userId: record.userId,
    $userTag: record.userTag ?? null,
    $sourceHost: record.sourceHost,
    $sourceUrl: record.sourceUrl,
    $status: record.status,
    $createdAt: record.createdAt ?? Date.now(),
  });
}

export function updateDownloadRecord(id, changes = {}) {
  const columns = {
    status: "status",
    filename: "filename",
    sizeBytes: "size_bytes",
    error: "error",
    startedAt: "started_at",
    completedAt: "completed_at",
    expiresAt: "expires_at",
  };
  const sets = [];
  const params = { $id: id };
  for (const [key, column] of Object.entries(columns)) {
    if (!Object.hasOwn(changes, key)) continue;
    sets.push(`${column} = $${key}`);
    params[`$${key}`] = changes[key] ?? null;
  }
  if (sets.length) db.prepare(`UPDATE downloads SET ${sets.join(", ")} WHERE id = $id`).run(params);
}

export function listDownloadRecords({ guildId, limit = 100 } = {}) {
  const bounded = Math.min(Math.max(Number(limit) || 100, 1), 500);
  if (guildId) {
    return db.prepare(`
      SELECT id, guild_id as guildId, channel_id as channelId, user_id as userId, user_tag as userTag,
             source_host as sourceHost, source_url as sourceUrl, status, filename, size_bytes as sizeBytes,
             error, created_at as createdAt, started_at as startedAt, completed_at as completedAt, expires_at as expiresAt
      FROM downloads WHERE guild_id = $guildId ORDER BY created_at DESC LIMIT $limit
    `).all({ $guildId: guildId, $limit: bounded });
  }
  return db.prepare(`
    SELECT id, guild_id as guildId, channel_id as channelId, user_id as userId, user_tag as userTag,
           source_host as sourceHost, source_url as sourceUrl, status, filename, size_bytes as sizeBytes,
           error, created_at as createdAt, started_at as startedAt, completed_at as completedAt, expires_at as expiresAt
    FROM downloads ORDER BY created_at DESC LIMIT $limit
  `).all({ $limit: bounded });
}

export function upsertMusicHistory(record) {
  upsertMusicHistoryStmt.run({
    $guildId: record.guildId,
    $cacheFile: record.cacheFile,
    $url: record.url,
    $title: record.title,
    $durationSec: Number(record.durationSec) || 0,
    $thumbnail: record.thumbnail ?? null,
    $requestedBy: record.requestedBy ?? null,
    $sourceType: record.sourceType ?? null,
    $sourceService: record.sourceService ?? null,
    $sizeBytes: Number(record.sizeBytes) || 0,
    $playedAt: Number(record.playedAt) || Date.now(),
  });
}

export function listMusicHistoryRows(guildId, limit = 100) {
  return listMusicHistoryStmt.all({
    $guildId: String(guildId),
    $limit: Math.min(Math.max(Number(limit) || 100, 1), 500),
  });
}

export function getMusicHistoryRow(guildId, id) {
  return getMusicHistoryStmt.get({ $guildId: String(guildId), $id: Number(id) }) || null;
}

export function deleteMusicHistoryRow(guildId, id) {
  return deleteMusicHistoryStmt.run({ $guildId: String(guildId), $id: Number(id) }).changes > 0;
}

export function clearMusicHistoryForGuild(guildId) {
  return clearMusicHistoryStmt.run({ $guildId: String(guildId) }).changes;
}

export function createTranscriptionSession(record) {
  db.prepare(`
    INSERT INTO transcription_sessions (
      id, guild_id, voice_channel_id, announce_channel_id, status, language,
      started_by_id, started_by_tag, started_at, audio_expires_at
    ) VALUES ($id, $guildId, $voiceChannelId, $announceChannelId, $status, $language,
      $startedById, $startedByTag, $startedAt, $audioExpiresAt)
  `).run({
    $id: record.id,
    $guildId: record.guildId,
    $voiceChannelId: record.voiceChannelId,
    $announceChannelId: record.announceChannelId ?? null,
    $status: record.status ?? "recording",
    $language: record.language ?? "auto",
    $startedById: record.startedById,
    $startedByTag: record.startedByTag ?? null,
    $startedAt: record.startedAt ?? Date.now(),
    $audioExpiresAt: record.audioExpiresAt,
  });
}

export function updateTranscriptionSession(id, changes = {}) {
  const columns = {
    status: "status", stoppedAt: "stopped_at", audioExpiresAt: "audio_expires_at",
    audioDeletedAt: "audio_deleted_at", error: "error",
  };
  const sets = [];
  const params = { $id: id };
  for (const [key, column] of Object.entries(columns)) {
    if (!Object.hasOwn(changes, key)) continue;
    sets.push(`${column} = $${key}`);
    params[`$${key}`] = changes[key] ?? null;
  }
  if (sets.length) db.prepare(`UPDATE transcription_sessions SET ${sets.join(", ")} WHERE id = $id`).run(params);
}

const transcriptionSessionSelect = `
  SELECT id, guild_id as guildId, voice_channel_id as voiceChannelId,
    announce_channel_id as announceChannelId, status, language,
    started_by_id as startedById, started_by_tag as startedByTag,
    started_at as startedAt, stopped_at as stoppedAt,
    audio_expires_at as audioExpiresAt, audio_deleted_at as audioDeletedAt, error
  FROM transcription_sessions`;

export function getTranscriptionSession(id) {
  return db.prepare(`${transcriptionSessionSelect} WHERE id = $id`).get({ $id: String(id) }) || null;
}

export function getActiveTranscriptionSession(guildId) {
  return db.prepare(`${transcriptionSessionSelect} WHERE guild_id = $guildId AND status IN ('recording','finalizing') ORDER BY started_at DESC LIMIT 1`)
    .get({ $guildId: String(guildId) }) || null;
}

export function listTranscriptionSessions(guildId, limit = 50) {
  return db.prepare(`${transcriptionSessionSelect} WHERE guild_id = $guildId ORDER BY started_at DESC LIMIT $limit`)
    .all({ $guildId: String(guildId), $limit: Math.min(Math.max(Number(limit) || 50, 1), 200) });
}

export function listExpiredTranscriptionAudio(now = Date.now(), limit = 100) {
  return db.prepare(`${transcriptionSessionSelect}
    WHERE audio_expires_at <= $now AND audio_deleted_at IS NULL
      AND status NOT IN ('recording','finalizing')
    ORDER BY audio_expires_at LIMIT $limit`)
    .all({ $now: now, $limit: Math.min(Math.max(Number(limit) || 100, 1), 500) });
}

export function createTranscriptionChunk(record) {
  db.prepare(`
    INSERT INTO transcription_chunks (
      id, session_id, chunk_index, status, start_ms, end_ms, directory,
      speaker_count, created_at
    ) VALUES ($id, $sessionId, $chunkIndex, $status, $startMs, $endMs, $directory,
      $speakerCount, $createdAt)
  `).run({
    $id: record.id,
    $sessionId: record.sessionId,
    $chunkIndex: record.chunkIndex,
    $status: record.status ?? "pending",
    $startMs: record.startMs,
    $endMs: record.endMs,
    $directory: record.directory,
    $speakerCount: record.speakerCount ?? 0,
    $createdAt: record.createdAt ?? Date.now(),
  });
}

export function updateTranscriptionChunk(id, changes = {}) {
  const columns = {
    status: "status", speakerCount: "speaker_count", aecConfidence: "aec_confidence",
    error: "error", processedAt: "processed_at",
  };
  const sets = [];
  const params = { $id: id };
  for (const [key, column] of Object.entries(columns)) {
    if (!Object.hasOwn(changes, key)) continue;
    sets.push(`${column} = $${key}`);
    params[`$${key}`] = changes[key] ?? null;
  }
  if (sets.length) db.prepare(`UPDATE transcription_chunks SET ${sets.join(", ")} WHERE id = $id`).run(params);
}

export function listTranscriptionChunks(sessionId) {
  return db.prepare(`
    SELECT id, session_id as sessionId, chunk_index as chunkIndex, status,
      start_ms as startMs, end_ms as endMs, directory, speaker_count as speakerCount,
      aec_confidence as aecConfidence, error, created_at as createdAt, processed_at as processedAt
    FROM transcription_chunks WHERE session_id = $sessionId ORDER BY chunk_index
  `).all({ $sessionId: String(sessionId) });
}

export function listPendingTranscriptionChunks() {
  return db.prepare(`
    SELECT id, session_id as sessionId, chunk_index as chunkIndex, status,
      start_ms as startMs, end_ms as endMs, directory, speaker_count as speakerCount,
      created_at as createdAt
    FROM transcription_chunks WHERE status IN ('pending','processing') ORDER BY created_at
  `).all();
}

export function insertTranscriptionSegments(sessionId, chunkId, segments = []) {
  const insert = db.prepare(`
    INSERT INTO transcription_segments (
      session_id, chunk_id, speaker_id, speaker_name, start_ms, end_ms, text,
      language, confidence, aec_applied, aec_confidence, created_at
    ) VALUES ($sessionId, $chunkId, $speakerId, $speakerName, $startMs, $endMs, $text,
      $language, $confidence, $aecApplied, $aecConfidence, $createdAt)
  `);
  const tx = db.transaction((rows) => {
    db.prepare("DELETE FROM transcription_segments WHERE chunk_id = $chunkId").run({ $chunkId: chunkId });
    for (const segment of rows) insert.run({
      $sessionId: sessionId,
      $chunkId: chunkId,
      $speakerId: segment.speakerId,
      $speakerName: segment.speakerName,
      $startMs: Math.max(0, Math.round(segment.startMs)),
      $endMs: Math.max(0, Math.round(segment.endMs)),
      $text: String(segment.text || "").trim(),
      $language: segment.language ?? null,
      $confidence: Number.isFinite(segment.confidence) ? segment.confidence : null,
      $aecApplied: segment.aecApplied ? 1 : 0,
      $aecConfidence: Number.isFinite(segment.aecConfidence) ? segment.aecConfidence : null,
      $createdAt: Date.now(),
    });
  });
  tx(segments.filter((segment) => String(segment.text || "").trim()));
}

export function listTranscriptionSegments(sessionId) {
  return db.prepare(`
    SELECT id, session_id as sessionId, chunk_id as chunkId, speaker_id as speakerId,
      speaker_name as speakerName, start_ms as startMs, end_ms as endMs, text,
      language, confidence, aec_applied as aecApplied, aec_confidence as aecConfidence,
      created_at as createdAt
    FROM transcription_segments WHERE session_id = $sessionId ORDER BY start_ms, id
  `).all({ $sessionId: String(sessionId) }).map((row) => ({ ...row, aecApplied: Boolean(row.aecApplied) }));
}

export function deleteTranscriptionSession(id) {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM transcription_segments WHERE session_id = $id").run({ $id: id });
    db.prepare("DELETE FROM transcription_chunks WHERE session_id = $id").run({ $id: id });
    return db.prepare("DELETE FROM transcription_sessions WHERE id = $id").run({ $id: id }).changes;
  });
  return tx() > 0;
}

export function markInterruptedTranscriptionSessions(now = Date.now()) {
  return db.prepare(`
    UPDATE transcription_sessions SET status = 'interrupted', stopped_at = COALESCE(stopped_at, $now),
      error = COALESCE(error, 'Процесс бота был перезапущен')
    WHERE status IN ('recording','finalizing')
  `).run({ $now: now }).changes;
}

function parseJsonOrNull(value) {
  if (value === null || value === undefined) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
