import { afterAll, describe, expect, test } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { clearMusicHistoryForGuild } from "../db.js";
import { getCachedMusicHistoryTrack, listCachedMusicHistory, recordCachedTrack } from "./history.js";

const guildId = `98${Date.now()}`;
const cacheDir = await mkdtemp(path.join(tmpdir(), "discordbot-music-history-"));
const cacheFile = `${"a".repeat(40)}.webm`;
const filePath = path.join(cacheDir, cacheFile);

afterAll(async () => {
  clearMusicHistoryForGuild(guildId);
  await rm(cacheDir, { recursive: true, force: true });
});

describe("cached music history", () => {
  test("keeps one cached song and increments its play count", async () => {
    await writeFile(filePath, new Uint8Array([1, 2, 3, 4]));
    const track = {
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      title: "Example track",
      durationSec: 213,
      requestedBy: "tester",
    };
    await recordCachedTrack(guildId, track, filePath, { cacheDir, playedAt: 1000 });
    await recordCachedTrack(guildId, track, filePath, { cacheDir, playedAt: 2000 });
    const history = await listCachedMusicHistory(guildId, { cacheDir });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ cacheFile, title: "Example track", playCount: 2, lastPlayedAt: 2000 });

    const replay = await getCachedMusicHistoryTrack(guildId, history[0].id, "веб-панель", { cacheDir });
    expect(replay).toMatchObject({ url: track.url, title: track.title, cacheFile, requestedBy: "веб-панель" });
  });

  test("removes history entries whose cache file was pruned", async () => {
    await rm(filePath, { force: true });
    expect(await listCachedMusicHistory(guildId, { cacheDir })).toEqual([]);
  });
});
