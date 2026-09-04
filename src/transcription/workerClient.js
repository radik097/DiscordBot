function toWebSocketUrl(baseUrl) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1/realtime`;
  return url.toString();
}

export class RealtimeWorkerStream {
  constructor({ url, headers, webSocketFactory, onEvent = () => {}, maxBufferedBytes = 512 * 1024 }) {
    this.onEvent = onEvent;
    this.maxBufferedBytes = maxBufferedBytes;
    this.buffered = [];
    this.bufferedBytes = 0;
    this.open = false;
    this.closed = false;
    this.stopRequested = false;
    this.socket = webSocketFactory(url, { headers });
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.done = new Promise((resolve) => { this.resolveDone = resolve; });
    this.socket.binaryType = "arraybuffer";
    this.socket.addEventListener("open", () => {
      this.open = true;
      this.resolveReady(this);
      for (const chunk of this.buffered) this.socket.send(chunk);
      this.buffered = [];
      this.bufferedBytes = 0;
      if (this.stopRequested) this.socket.send(JSON.stringify({ type: "stop" }));
    });
    this.socket.addEventListener("message", (event) => {
      try {
        const payload = JSON.parse(typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8"));
        this.onEvent(payload);
      } catch {
        this.onEvent({ type: "error", error: "Worker realtime returned invalid JSON" });
      }
    });
    this.socket.addEventListener("error", () => {
      const error = new Error("Worker realtime WebSocket connection failed");
      if (!this.open) this.rejectReady(error);
      this.onEvent({ type: "error", error: error.message });
    });
    this.socket.addEventListener("close", () => {
      this.closed = true;
      if (!this.open) this.rejectReady(new Error("Worker realtime WebSocket closed before opening"));
      this.resolveDone();
    });
  }

  send(chunk) {
    if (this.closed || this.stopRequested || !chunk?.length) return false;
    const bytes = Buffer.from(chunk);
    if (this.open) {
      this.socket.send(bytes);
      return true;
    }
    if (this.bufferedBytes + bytes.length > this.maxBufferedBytes) {
      while (this.buffered.length && this.bufferedBytes + bytes.length > this.maxBufferedBytes) {
        this.bufferedBytes -= this.buffered.shift().length;
      }
    }
    this.buffered.push(bytes);
    this.bufferedBytes += bytes.length;
    return true;
  }

  close() {
    if (this.closed || this.stopRequested) return this.done;
    this.stopRequested = true;
    this.buffered = [];
    this.bufferedBytes = 0;
    if (this.open) this.socket.send(JSON.stringify({ type: "stop" }));
    return this.done;
  }
}

export class TranscriptionWorkerClient {
  constructor({
    baseUrl = process.env.TRANSCRIPTION_WORKER_URL || "http://transcription-worker:8000",
    fetchImpl = globalThis.fetch,
    webSocketFactory = (url, options) => new WebSocket(url, options),
    timeoutMs = Number(process.env.TRANSCRIPTION_WORKER_TIMEOUT_MS) || 180_000,
    installTimeoutMs = Number(process.env.TRANSCRIPTION_MODEL_INSTALL_TIMEOUT_MS) || 30 * 60_000,
  } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.fetch = fetchImpl;
    this.webSocketFactory = webSocketFactory;
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

  openRealtime(profile, { onEvent, targetDelayMs = Number(process.env.TRANSCRIPTION_REALTIME_DELAY_MS) || 1_000 } = {}) {
    if (profile?.provider !== "mistral" || profile?.model !== "voxtral-mini-transcribe-realtime-2602" || !profile?.apiKey) {
      throw new Error("Mistral realtime profile is not configured");
    }
    return new RealtimeWorkerStream({
      url: toWebSocketUrl(this.baseUrl),
      headers: {
        ...this.#headers(profile, false),
        "x-transcription-delay-ms": String(Math.max(240, Math.min(5_000, Number(targetDelayMs) || 1_000))),
      },
      webSocketFactory: this.webSocketFactory,
      onEvent,
    });
  }
}

export const transcriptionWorker = new TranscriptionWorkerClient();
