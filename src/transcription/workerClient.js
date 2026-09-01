export class TranscriptionWorkerClient {
  constructor({
    baseUrl = process.env.TRANSCRIPTION_WORKER_URL || "http://transcription-worker:8000",
    fetchImpl = globalThis.fetch,
    timeoutMs = Number(process.env.TRANSCRIPTION_WORKER_TIMEOUT_MS) || 180_000,
  } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async health() {
    try {
      const response = await this.fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(5000) });
      return response.ok ? await response.json() : { ready: false, status: response.status };
    } catch (error) {
      return { ready: false, error: error.message };
    }
  }

  async transcribe(job) {
    const response = await this.fetch(`${this.baseUrl}/v1/chunks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(job),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || payload.detail || `Whisper worker HTTP ${response.status}`);
    return payload;
  }
}

export const transcriptionWorker = new TranscriptionWorkerClient();
