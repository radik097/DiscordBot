import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  clearPlaylistPlaybackState,
  getSavedPlaylist,
  listSavedPlaylists,
  savePlaylistPlaybackState,
} from "./library.js";

const guildId = "999999999999999999";
const directory = fileURLToPath(new URL(`../../data/playlists/${guildId}/`, import.meta.url));

describe("saved playlist identities and playback state", () => {
  beforeEach(() => {
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true });
    for (const id of ["playlist-a", "playlist-b"]) {
      writeFileSync(path.join(directory, `${id}.json`), JSON.stringify({
        version: 1,
        id,
        title: "Одинаковое имя",
        status: "completed",
        total: 1,
        updatedAt: id === "playlist-a" ? 1 : 2,
        tracks: [{ url: `https://youtu.be/${id}`, title: id, durationSec: 300 }],
      }));
    }
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  test("keeps playlists with equal names separate by ID", async () => {
    expect((await listSavedPlaylists(guildId)).map((playlist) => playlist.id)).toEqual(["playlist-b", "playlist-a"]);
  });

  test("stores and clears an independent resume snapshot", async () => {
    expect(await savePlaylistPlaybackState(guildId, "playlist-a", [{ url: "https://youtu.be/a", title: "A", durationSec: 300, startTimeSec: 123 }])).toBe(true);
    expect((await getSavedPlaylist(guildId, "playlist-a")).playback.tracks[0].startTimeSec).toBe(123);
    expect(await clearPlaylistPlaybackState(guildId, "playlist-a")).toBe(true);
    expect((await getSavedPlaylist(guildId, "playlist-a")).playback).toBeNull();
  });

  test("preserves cached Discord attachment identity in a resume snapshot", async () => {
    const attachment = {
      url: "https://cdn.discordapp.com/attachments/1/2/clip.mp4",
      title: "clip.mp4",
      durationSec: 12,
      startTimeSec: 4,
      sourceType: "attachment",
      cacheFile: `upload-${"c".repeat(64)}.mp4`,
      sizeBytes: 1234,
      contentType: "video/mp4",
    };
    expect(await savePlaylistPlaybackState(guildId, "playlist-a", [attachment])).toBe(true);
    expect((await getSavedPlaylist(guildId, "playlist-a")).playback.tracks[0]).toMatchObject({
      sourceType: "attachment",
      cacheFile: attachment.cacheFile,
      sizeBytes: 1234,
      contentType: "video/mp4",
    });
  });

  test("preserves a cached Cobalt source in a resume snapshot", async () => {
    const cobalt = {
      url: "https://soundcloud.com/artist/track",
      title: "Artist Track",
      durationSec: 180,
      sourceType: "cobalt",
      cacheFile: `cobalt-${"d".repeat(64)}.opus`,
      sizeBytes: 4321,
      contentType: "audio/opus",
    };
    expect(await savePlaylistPlaybackState(guildId, "playlist-a", [cobalt])).toBe(true);
    expect((await getSavedPlaylist(guildId, "playlist-a")).playback.tracks[0]).toMatchObject({
      sourceType: "cobalt",
      cacheFile: cobalt.cacheFile,
      sizeBytes: 4321,
      contentType: "audio/opus",
    });
  });
});
