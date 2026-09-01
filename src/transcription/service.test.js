import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OpusEncoder } from "@discordjs/opus";
import { TimedPcmFile, TranscriptionService } from "./service.js";

async function eventually(check, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Условие не выполнено вовремя");
}

function fixture() {
  const speaking = new EventEmitter();
  const streams = new Map();
  const receiver = {
    speaking,
    subscribe(userId) {
      const stream = new PassThrough();
      streams.set(userId, stream);
      return stream;
    },
  };
  const queue = {
    connection: { receiver },
    acquired: [], released: [],
    acquireVoiceLease(id) { this.acquired.push(id); return this.connection; },
    releaseVoiceLease(id) { this.released.push(id); },
  };
  const guildId = `guild-${crypto.randomUUID()}`;
  const guild = {
    id: guildId,
    members: { cache: new Map([["123", { displayName: "Алиса", user: { bot: false, username: "alice" } }]]) },
  };
  const messages = [];
  const announceChannel = { id: "text-1", send: async (payload) => messages.push(payload) };
  guild.channels = { cache: new Map([[announceChannel.id, announceChannel]]) };
  const voiceChannel = { id: "voice-1", guild };
  return { speaking, streams, queue, guild, voiceChannel, announceChannel, messages };
}

describe("transcription service", () => {
  test("writes sparse PCM on a wall-clock timeline", async () => {
    const root = await mkdtemp(join(tmpdir(), "timed-pcm-"));
    const path = join(root, "track.s16le");
    try {
      const track = new TimedPcmFile(path, 1_000);
      track.write(Buffer.alloc(3_840, 1), 1_500);
      track.close(1_000);
      expect((await stat(path)).size).toBe(192_000);
      expect(track.hasAudio).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("captures one Discord speaker, processes a chunk and keeps the voice lease independent", async () => {
    const root = await mkdtemp(join(tmpdir(), "transcription-service-"));
    const { speaking, streams, queue, guild, voiceChannel, announceChannel, messages } = fixture();
    const preparedProfiles = [];
    const submittedJobs = [];
    const submittedProfiles = [];
    const settings = {
      resolve: (provider = "local", model = "small") => ({
        provider, model, cloud: provider !== "local",
        ...(provider === "local" ? {} : { apiKey: "in-memory-cloud-key" }),
      }),
    };
    const worker = {
      health: async () => ({ ready: true }),
      prepare: async (profile) => { preparedProfiles.push(profile); return profile; },
      transcribe: async (job, profile) => {
        submittedJobs.push(job);
        submittedProfiles.push(profile);
        return {
          aecConfidence: 0.7,
          segments: [{ speakerId: job.speakers[0].id, speakerName: job.speakers[0].name, startMs: 10, endMs: 400, text: "Привет", language: "ru", confidence: 0.9, aecApplied: true, aecConfidence: 0.7 }],
        };
      },
    };
    const service = new TranscriptionService({ root, worker, settings, queueProvider: () => queue, chunkMs: 60_000 });
    let session;
    try {
      session = await service.start({
        guild, voiceChannel, announceChannel, language: "auto",
        provider: "mistral", model: "voxtral-mini-latest",
        startedById: "operator", startedByTag: "Operator",
      });
      speaking.emit("start", "123");
      const encoder = new OpusEncoder(48_000, 2);
      streams.get("123").write(encoder.encode(Buffer.alloc(3_840), 960));
      await new Promise((resolve) => setTimeout(resolve, 15));
      await service.stop(guild.id);
      const completed = await eventually(() => {
        const details = service.details(session.id);
        return details?.status === "completed" ? details : null;
      });
      expect(completed.segments[0]).toMatchObject({ speakerName: "Алиса", text: "Привет", aecApplied: true });
      expect(completed).toMatchObject({ provider: "mistral", model: "voxtral-mini-latest" });
      expect(preparedProfiles[0].apiKey).toBe("in-memory-cloud-key");
      expect(submittedProfiles[0].apiKey).toBe("in-memory-cloud-key");
      expect(JSON.stringify(submittedJobs[0])).not.toContain("in-memory-cloud-key");
      expect(messages[0]).toMatchObject({ allowedMentions: { parse: [] } });
      expect(messages[0].content).toContain("**Алиса:** Привет");
      expect(queue.acquired).toEqual([`transcription:${session.id}`]);
      expect(queue.released).toEqual([`transcription:${session.id}`]);
    } finally {
      if (session) service.delete(session.id);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("retries a transient worker failure without completing the session early", async () => {
    const root = await mkdtemp(join(tmpdir(), "transcription-retry-"));
    const { speaking, streams, queue, guild, voiceChannel } = fixture();
    let attempts = 0;
    const worker = {
      health: async () => ({ ready: true }),
      prepare: async (profile) => profile,
      transcribe: async (job) => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary worker failure");
        return {
          aecConfidence: 0,
          segments: [{
            speakerId: job.speakers[0].id, speakerName: job.speakers[0].name,
            startMs: 0, endMs: 100, text: "Повтор успешен", language: "ru",
          }],
        };
      },
    };
    const service = new TranscriptionService({
      root, worker, queueProvider: () => queue, chunkMs: 60_000,
      maxJobAttempts: 3, jobRetryDelayMs: 5,
    });
    let session;
    try {
      session = await service.start({ guild, voiceChannel, startedById: "operator", startedByTag: "Operator" });
      speaking.emit("start", "123");
      const encoder = new OpusEncoder(48_000, 2);
      streams.get("123").write(encoder.encode(Buffer.alloc(3_840), 960));
      await new Promise((resolve) => setTimeout(resolve, 15));
      await service.stop(guild.id);
      const completed = await eventually(() => {
        const details = service.details(session.id);
        return details?.status === "completed" ? details : null;
      });
      expect(attempts).toBe(2);
      expect(completed.segments[0].text).toBe("Повтор успешен");
    } finally {
      if (session) service.delete(session.id);
      await rm(root, { recursive: true, force: true });
    }
  });
});
