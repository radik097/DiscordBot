import { describe, expect, test } from "bun:test";
import { TranscriptionWorkerClient } from "./workerClient.js";

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
});
