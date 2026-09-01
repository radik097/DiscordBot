import { afterEach, describe, expect, test } from "bun:test";
import { getQueue } from "./queue.js";

const queues = [];

afterEach(() => {
  for (const queue of queues.splice(0)) queue.destroy(true);
});

describe("shared music and transcription voice connection", () => {
  test("stopping music keeps the connection while transcription owns a lease", () => {
    const queue = getQueue(`lease-${crypto.randomUUID()}`);
    queues.push(queue);
    let destroyed = false;
    queue.connection = {
      joinConfig: { channelId: "voice-1" },
      destroy() { destroyed = true; },
    };
    queue.voiceLeases.add("transcription:test");
    queue.playing = { queueId: "track-1", title: "Fixture" };
    queue.tracks.push({ queueId: "track-2", title: "Queued" });

    queue.destroy();

    expect(destroyed).toBe(false);
    expect(queue.destroyed).toBe(false);
    expect(queue.connection).not.toBeNull();
    expect(queue.playing).toBeNull();
    expect(queue.tracks).toEqual([]);
  });

  test("does not move active music to another channel for transcription", () => {
    const queue = getQueue(`lease-${crypto.randomUUID()}`);
    queues.push(queue);
    queue.connection = { joinConfig: { channelId: "music-channel" }, destroy() {} };
    queue.playing = { queueId: "track-1", title: "Fixture" };

    expect(() => queue.acquireVoiceLease("transcription:test", { id: "meeting-channel" }))
      .toThrow("Музыка уже играет в другом голосовом канале");
  });
});
