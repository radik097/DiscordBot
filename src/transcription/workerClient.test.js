import { describe, expect, test } from "bun:test";
import { TranscriptionWorkerClient } from "./workerClient.js";

class MockWebSocket extends EventTarget {
  constructor() {
    super();
    this.sent = [];
  }
  send(value) { this.sent.push(value); }
  emit(type, data) { this.dispatchEvent(type === "message" ? new MessageEvent(type, { data }) : new Event(type)); }
}

describe("transcription worker client", () => {
  test("passes cloud credentials only in authorization headers", async () => {
    const calls = [];
    const client = new TranscriptionWorkerClient({
      baseUrl: "http://worker",
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ ready: true, segments: [] }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const profile = { provider: "openai", model: "gpt-4o-mini-transcribe", apiKey: "secret-cloud-key" };
    await client.prepare(profile);
    await client.transcribe({ sessionId: "job" }, profile);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.init.headers.authorization).toBe("Bearer secret-cloud-key");
      expect(call.init.headers["x-transcription-model"]).toBe("gpt-4o-mini-transcribe");
      expect(call.init.body).not.toContain("secret-cloud-key");
    }
  });

  test("opens the worker realtime socket with headers and streams binary PCM", async () => {
    const socket = new MockWebSocket();
    let opened;
    const events = [];
    const client = new TranscriptionWorkerClient({
      baseUrl: "http://worker:8000",
      webSocketFactory: (url, options) => {
        opened = { url, options };
        return socket;
      },
    });
    const stream = client.openRealtime(
      { provider: "mistral", model: "voxtral-mini-transcribe-realtime-2602", apiKey: "secret-cloud-key" },
      { onEvent: (event) => events.push(event), targetDelayMs: 800 },
    );
    stream.send(Buffer.from([1, 2, 3, 4]));
    expect(socket.sent).toHaveLength(0);
    socket.emit("open");
    await stream.ready;
    expect(opened.url).toBe("ws://worker:8000/v1/realtime");
    expect(opened.options.headers.authorization).toBe("Bearer secret-cloud-key");
    expect(opened.options.headers["x-transcription-delay-ms"]).toBe("800");
    expect(Buffer.from(socket.sent[0])).toEqual(Buffer.from([1, 2, 3, 4]));
    socket.emit("message", JSON.stringify({ type: "delta", text: "Привет" }));
    expect(events).toEqual([{ type: "delta", text: "Привет" }]);
    void stream.close();
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ type: "stop" }));
    socket.emit("close");
    await stream.done;
  });
});
