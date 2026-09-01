export class TranscriptionWorkerClient {
  constructor({
    baseUrl = process.env.TRANSCRIPTION_WORKER_URL || "http://transcription-worker:8000",
    fetchImpl = globalThis.fetch,
    timeoutMs = Number(process.env.TRANSCRIPTION_WORKER_TIMEOUT_MS) || 180_000,
    installTimeoutMs = Number(process.env.TRANSCRIPTION_MODEL_INSTALL_TIMEOUT_MS) || 30 * 60_000,
  } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.installTimeoutMs = installTimeoutMs;
  }

  #headers(profile, json = true) {
    const headers = {
      "x-transcription-provider": profile.provider,
      "x-transcription-model": profile.model,
    };
    if (json) headers["content-type"] = "application/json";
    if (profile.apiKey) headers.authorization = `Bearer ${profile.apiKey}`;
    return headers;
  }

  async health() {
    try {
      const response = await this.fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(5000) });
      return response.ok ? await response.json() : { ready: false, status: response.status };
    } catch (error) {
      return { ready: false, error: error.message };
    }
  }

  async prepare(profile) {
    const response = await this.fetch(`${this.baseUrl}/v1/models/install`, {
      method: "POST",
      headers: this.#headers(profile),
      body: JSON.stringify({ provider: profile.provider, model: profile.model }),
      signal: AbortSignal.timeout(this.installTimeoutMs),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || payload.detail || `Whisper model install HTTP ${response.status}`);
    return payload;
  }

  async transcribe(job, profile) {
    const response = await this.fetch(`${this.baseUrl}/v1/chunks`, {
      method: "POST",
      headers: this.#headers(profile),
      body: JSON.stringify(job),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || payload.detail || `Whisper worker HTTP ${response.status}`);
    return payload;
  }
}

export const transcriptionWorker = new TranscriptionWorkerClient();
