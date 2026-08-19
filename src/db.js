import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = new URL("../data/history.sqlite", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

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

db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_guild ON messages(guild_id, created_at);`);

const insertStmt = db.prepare(`
  INSERT INTO messages (id, guild_id, channel_id, channel_name, author_id, author_tag, content, attachments, created_at)
  VALUES ($id, $guildId, $channelId, $channelName, $authorId, $authorTag, $content, $attachments, $createdAt)
  ON CONFLICT(id) DO NOTHING
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

const markEditedStmt = db.prepare(`UPDATE messages SET content = $content, edited_at = $editedAt WHERE id = $id`);

export function logEdit(message) {
  markEditedStmt.run({
    $id: message.id,
    $content: message.content ?? "",
    $editedAt: Date.now(),
  });
}

const markDeletedStmt = db.prepare(`UPDATE messages SET deleted_at = $deletedAt WHERE id = $id`);

export function logDelete(messageId) {
  markDeletedStmt.run({ $id: messageId, $deletedAt: Date.now() });
}

// Used by the web panel's history browser.
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
  return db
    .prepare(`SELECT * FROM messages ${where} ORDER BY created_at DESC LIMIT $limit`)
    .all(params);
}

export function getStats(guildId) {
  const totalMessages = db
    .prepare(`SELECT COUNT(*) as c FROM messages WHERE guild_id = $g AND deleted_at IS NULL`)
    .get({ $g: guildId }).c;

  const topUsers = db
    .prepare(
      `SELECT author_tag, COUNT(*) as count FROM messages
       WHERE guild_id = $g AND deleted_at IS NULL
       GROUP BY author_id ORDER BY count DESC LIMIT 10`
    )
    .all({ $g: guildId });

  const topChannels = db
    .prepare(
      `SELECT channel_name, COUNT(*) as count FROM messages
       WHERE guild_id = $g AND deleted_at IS NULL
       GROUP BY channel_id ORDER BY count DESC LIMIT 10`
    )
    .all({ $g: guildId });

  const last7Days = db
    .prepare(
      `SELECT date(created_at / 1000, 'unixepoch') as day, COUNT(*) as count FROM messages
       WHERE guild_id = $g AND deleted_at IS NULL AND created_at >= $since
       GROUP BY day ORDER BY day`
    )
    .all({ $g: guildId, $since: Date.now() - 7 * 24 * 60 * 60 * 1000 });

  return { totalMessages, topUsers, topChannels, last7Days };
}

export function listHistoryChannels(guildId) {
  return db
    .prepare(`SELECT DISTINCT channel_id, channel_name FROM messages WHERE guild_id = $guildId ORDER BY channel_name`)
    .all({ $guildId: guildId });
}
