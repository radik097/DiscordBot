import { randomUUID } from "node:crypto";
import {
  closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync,
  renameSync, rmSync, writeFileSync, writeSync,
} from "node:fs";
import { resolve, relative, sep } from "node:path";
import { OpusEncoder } from "@discordjs/opus";
import { EndBehaviorType } from "@discordjs/voice";
import {
  createTranscriptionChunk, createTranscriptionSession, deleteTranscriptionSession,
  getActiveTranscriptionSession, getTranscriptionSession, insertTranscriptionSegments,
  listExpiredTranscriptionAudio,
  listPendingTranscriptionChunks, listTranscriptionChunks, listTranscriptionSegments,
  listTranscriptionSessions, markInterruptedTranscriptionSessions,
  updateTranscriptionChunk, updateTranscriptionSession,
} from "../db.js";
import { getQueue } from "../music/queue.js";
import { exportTranscript, transcriptFilename } from "./export.js";
import { isMistralRealtimeProfile, RealtimePcm16k } from "./realtimePcm.js";
import { registerMusicReferenceSink, scalePcm16le } from "./reference.js";
import { transcriptionSettings } from "./settings.js";
import { transcriptionWorker } from "./workerClient.js";

export const TRANSCRIPTION_ROOT = new URL("../../data/transcriptions/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const PCM_BYTES_PER_SECOND = 48_000 * 2 * 2;
const DEFAULT_CHUNK_MS = 60_000;
const DEFAULT_OVERLAP_MS = 1_000;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60_000;
const MAX_PENDING_CHUNKS = Math.max(1, Number(process.env.TRANSCRIPTION_MAX_PENDING_CHUNKS) || 10);
const MAX_JOB_ATTEMPTS = Math.max(1, Number(process.env.TRANSCRIPTION_JOB_ATTEMPTS) || 3);
const JOB_RETRY_DELAY_MS = Math.max(10, Number(process.env.TRANSCRIPTION_JOB_RETRY_DELAY_MS) || 1_000);
const DEFAULT_FILENAME_TIME_ZONE = process.env.TRANSCRIPTION_FILENAME_TIME_ZONE || "Australia/Sydney";

function boundedLanguage(value) {
  const language = String(value || "auto").toLowerCase();
  if (!["auto", "ru", "en"].includes(language)) throw new Error("Язык должен быть auto, ru или en.");
  return language;
}

function safeInside(root, path) {
  const absoluteRoot = resolve(root);
  const absolute = resolve(path);
  if (absolute !== absoluteRoot && !absolute.startsWith(`${absoluteRoot}${sep}`)) throw new Error("Некорректный путь транскрипции.");
  return absolute;
}

function safeFilenamePart(value, fallback) {
  const normalized = String(value || "")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._]+|[._]+$/g, "")
    .slice(0, 80);
  return normalized || fallback;
}

function calendarStamp(timestamp, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(timestamp))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}_${parts.hour}-${parts.minute}-${parts.second}`;
}

function elapsedStamp(durationMs) {
  const totalSeconds = Math.max(0, Math.floor(Number(durationMs || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, "0")}h${String(minutes).padStart(2, "0")}m${String(seconds).padStart(2, "0")}s`;
}

export function speakerRecordingFilename({
  speaker, sessionStartedAt, startedAt, endedAt,
  timeZone = DEFAULT_FILENAME_TIME_ZONE, extension = "flac",
}) {
  const name = safeFilenamePart(speaker?.name, "speaker");
  const id = safeFilenamePart(speaker?.id, "unknown");
  const range = `${elapsedStamp(startedAt - sessionStartedAt)}-${elapsedStamp(endedAt - sessionStartedAt)}`;
  return `${calendarStamp(startedAt, timeZone)}__${name}__${id}__${range}.${safeFilenamePart(extension, "flac")}`;
}

export class TimedPcmFile {
  constructor(path, startedAt) {
    mkdirSync(resolve(path, ".."), { recursive: true });
    this.path = path;
    this.startedAt = startedAt;
    this.fd = openSync(path, "w");
    this.position = 0;
    this.hasAudio = false;
    this.closed = false;
  }

  write(buffer, capturedAt = Date.now()) {
    if (this.closed || !buffer?.length) return;
    const expected = Math.max(0, Math.round(((capturedAt - this.startedAt) / 1000) * PCM_BYTES_PER_SECOND));
    const aligned = expected - (expected % 4);
    const position = Math.max(this.position, aligned);
    writeSync(this.fd, buffer, 0, buffer.length, position);
    this.position = position + buffer.length;
    this.hasAudio = true;
  }

  close(durationMs) {
    if (this.closed) return;
    const bytes = Math.max(this.position, Math.round((Math.max(0, durationMs) / 1000) * PCM_BYTES_PER_SECOND));
    ftruncateSync(this.fd, bytes - (bytes % 4));
    closeSync(this.fd);
    this.closed = true;
  }
}

function memberSnapshot(guild, userId) {
  const member = guild.members.cache.get(userId);
  if (!member || member.user?.bot) return null;
  return { id: String(userId), name: member.displayName || member.user?.globalName || member.user?.username || String(userId) };
}

export class TranscriptionService {
  constructor({
    root = TRANSCRIPTION_ROOT,
    worker = transcriptionWorker,
    settings = transcriptionSettings,
    queueProvider = getQueue,
    chunkMs = Number(process.env.TRANSCRIPTION_CHUNK_MS) || DEFAULT_CHUNK_MS,
    overlapMs = Number(process.env.TRANSCRIPTION_CHUNK_OVERLAP_MS) || DEFAULT_OVERLAP_MS,
    retentionMs = Number(process.env.TRANSCRIPTION_AUDIO_RETENTION_MS) || DEFAULT_RETENTION_MS,
    maxActive = Math.max(1, Number(process.env.TRANSCRIPTION_MAX_ACTIVE) || 1),
    maxJobAttempts = MAX_JOB_ATTEMPTS,
    jobRetryDelayMs = JOB_RETRY_DELAY_MS,
    filenameTimeZone = DEFAULT_FILENAME_TIME_ZONE,
    now = () => Date.now(),
  } = {}) {
    this.root = resolve(root);
    this.worker = worker;
    this.settings = settings;
    this.queueProvider = queueProvider;
    this.chunkMs = Math.max(1000, chunkMs);
    this.overlapMs = Math.max(0, Math.min(Number(overlapMs) || 0, this.chunkMs / 4));
    this.retentionMs = Math.max(60_000, retentionMs);
    this.maxActive = maxActive;
    this.maxJobAttempts = Math.max(1, Number(maxJobAttempts) || 1);
    this.jobRetryDelayMs = Math.max(1, Number(jobRetryDelayMs) || 1);
    this.filenameTimeZone = filenameTimeZone;
    this.now = now;
    this.active = new Map();
    this.jobs = [];
    this.processing = false;
    mkdirSync(this.root, { recursive: true });
  }

  async configuration() {
    return { ...this.settings.view(), worker: await this.worker.health() };
  }

  async updateConfiguration(changes) {
    const view = this.settings.update(changes);
    const profile = this.settings.resolve(view.provider, view.model);
    const prepared = typeof this.worker.prepare === "function" ? await this.worker.prepare(profile) : null;
    return { ...view, worker: { ...(await this.worker.health()), prepared } };
  }

  async start({ guild, voiceChannel, announceChannel = null, language = "auto", provider, model, startedById, startedByTag }) {
    if (!guild?.id || !voiceChannel?.id) throw new Error("Выберите голосовой канал.");
    if (this.active.has(guild.id) || getActiveTranscriptionSession(guild.id)) throw new Error("На сервере уже идёт транскрипция.");
    if (this.active.size >= this.maxActive) throw new Error("Достигнут лимит одновременных транскрипций.");
    const profile = this.settings.resolve(provider, model);
    const health = await this.worker.health();
    if (!health?.ready) throw new Error(`Worker транскрипции недоступен${health?.error ? `: ${health.error}` : "."}`);
    if (typeof this.worker.prepare === "function") await this.worker.prepare(profile);

    const id = randomUUID();
    const startedAt = this.now();
    const queue = this.queueProvider(guild.id);
    queue.acquireVoiceLease(`transcription:${id}`, voiceChannel);
    const state = {
      id, guild, queue, voiceChannelId: voiceChannel.id,
      announceChannelId: announceChannel?.id ?? null,
      language: boundedLanguage(language), provider: profile.provider, model: profile.model,
      startedAt, chunkIndex: 0,
      speakers: new Map(), decoders: new Map(), subscriptions: new Map(),
      realtimeProfile: isMistralRealtimeProfile(profile) ? profile : null,
      realtimeStreams: new Map(), liveSegments: new Map(), realtimeErrors: [],
      pendingJobs: 0, stopped: false, timer: null, unregisterReference: null,
    };
    try {
      createTranscriptionSession({
        id, guildId: guild.id, voiceChannelId: voiceChannel.id,
        announceChannelId: state.announceChannelId, language: state.language,
        provider: state.provider, model: state.model,
        startedById, startedByTag, startedAt, audioExpiresAt: startedAt + this.retentionMs,
      });
      this.#openChunk(state, startedAt, startedAt + this.chunkMs);
      const receiver = queue.connection.receiver;
      state.onSpeaking = (userId) => this.#subscribeSpeaker(state, receiver, userId);
      receiver.speaking.on("start", state.onSpeaking);
      state.unregisterReference = registerMusicReferenceSink(guild.id, (pcm, volume, capturedAt) => {
        if (!state.current || state.stopped) return;
        if (!state.current.reference) {
          state.current.reference = new TimedPcmFile(resolve(state.current.directory, "music.s16le"), state.current.startedAt);
        }
        state.current.reference.write(scalePcm16le(pcm, volume), capturedAt);
      });
      this.active.set(guild.id, state);
      this.#scheduleRotation(state);
      return this.details(id);
    } catch (error) {
      queue.releaseVoiceLease(`transcription:${id}`);
      throw error;
    }
  }

  #openChunk(state, startedAt, rotateAt, previous = null) {
    const directory = safeInside(this.root, resolve(this.root, state.id, `chunk-${String(state.chunkIndex).padStart(6, "0")}`));
    mkdirSync(directory, { recursive: true });
    state.current = {
      index: state.chunkIndex, startedAt, rotateAt, directory,
      keepFromMs: previous ? this.overlapMs : 0,
      tracks: new Map(), reference: null, speakers: new Map(),
    };
    if (previous && this.overlapMs > 0) this.#seedOverlap(state.current, previous);
  }

  #seedOverlap(current, previous) {
    const tailBytes = Math.round((this.overlapMs / 1000) * PCM_BYTES_PER_SECOND);
    const copyTail = (source, destination) => {
      if (!source?.hasAudio || !existsSync(source.path)) return null;
      const contents = readFileSync(source.path);
      const tail = contents.subarray(Math.max(0, contents.length - tailBytes));
      const target = new TimedPcmFile(destination, current.startedAt);
      target.write(tail, current.startedAt);
      return target;
    };
    for (const [userId, source] of previous.tracks) {
      const target = copyTail(source, resolve(current.directory, `speaker-${userId}.s16le`));
      if (!target) continue;
      current.tracks.set(userId, target);
      const speaker = previous.speakers.get(userId);
      if (speaker) current.speakers.set(userId, speaker);
    }
    current.reference = copyTail(previous.reference, resolve(current.directory, "music.s16le"));
  }

  #scheduleRotation(state) {
    if (state.stopped) return;
    const delay = Math.max(1, state.current.rotateAt - this.now());
    state.timer = setTimeout(() => {
      void this.#rotate(state, this.now()).catch((error) => this.#failSession(state, error));
    }, delay);
    state.timer.unref?.();
  }

  #subscribeSpeaker(state, receiver, userId) {
    if (state.stopped || state.subscriptions.has(userId)) return;
    const speaker = memberSnapshot(state.guild, userId);
    if (!speaker) return;
    const decoder = new OpusEncoder(48_000, 2);
    const stream = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
    const realtime = state.realtimeProfile ? this.#openRealtimeSpeaker(state, userId, speaker) : null;
    state.decoders.set(userId, decoder);
    state.subscriptions.set(userId, stream);
    state.speakers.set(userId, speaker);
    stream.on("data", (packet) => {
      if (state.stopped) return;
      try {
        const capturedAt = this.now();
        const current = state.current;
        const pcm = decoder.decode(packet);
        let track = current.tracks.get(userId);
        if (!track) {
          track = new TimedPcmFile(resolve(current.directory, `speaker-${userId}.s16le`), current.startedAt);
          current.tracks.set(userId, track);
          current.speakers.set(userId, speaker);
        }
        track.write(pcm, capturedAt);
        if (realtime) {
          const realtimePcm = realtime.converter.push(pcm);
          if (realtimePcm.length) realtime.stream.send(realtimePcm);
        }
      } catch (error) {
        console.warn(`[transcription:${state.id}] Не удалось декодировать ${userId}:`, error.message);
      }
    });
    const cleanup = () => {
      state.subscriptions.delete(userId);
      state.decoders.delete(userId);
      const activeRealtime = state.realtimeStreams.get(userId);
      if (activeRealtime) {
        state.realtimeStreams.delete(userId);
        void activeRealtime.stream.close();
      }
    };
    stream.once("close", cleanup);
    stream.once("error", (error) => {
      console.warn(`[transcription:${state.id}] Поток ${userId}:`, error.message);
      cleanup();
    });
  }

  #openRealtimeSpeaker(state, userId, speaker) {
    try {
      const converter = new RealtimePcm16k();
      const stream = this.worker.openRealtime(state.realtimeProfile, {
        onEvent: (event) => this.#handleRealtimeEvent(state, userId, speaker, event),
      });
      const realtime = { stream, converter, speaker };
      state.realtimeStreams.set(userId, realtime);
      void stream.ready.catch((error) => this.#recordRealtimeError(state, userId, error.message));
      return realtime;
    } catch (error) {
      this.#recordRealtimeError(state, userId, error.message);
      return null;
    }
  }

  #handleRealtimeEvent(state, userId, speaker, event) {
    if (!event || state.stopped) return;
    if (event.type === "error") {
      this.#recordRealtimeError(state, userId, event.error || "Realtime worker error");
      return;
    }
    if (event.type !== "delta" || !event.text) return;
    const timestamp = Math.max(0, this.now() - state.startedAt);
    const current = state.liveSegments.get(userId) || {
      speakerId: speaker.id,
      speakerName: speaker.name,
      startMs: timestamp,
      endMs: timestamp,
      text: "",
      language: state.language === "auto" ? null : state.language,
      confidence: null,
      live: true,
    };
    current.text += String(event.text);
    current.endMs = timestamp;
    state.liveSegments.set(userId, current);
  }

  #recordRealtimeError(state, userId, message) {
    const error = String(message || "Realtime transcription error").slice(0, 300);
    state.realtimeErrors.push({ speakerId: String(userId), error, at: this.now() });
    if (state.realtimeErrors.length > 20) state.realtimeErrors.shift();
    console.warn(`[transcription:${state.id}] Realtime ${userId}: ${error}`);
  }

  async #closeRealtimeStreams(state) {
    const closing = [...state.realtimeStreams.values()].map(({ stream }) => stream.close());
    state.realtimeStreams.clear();
    if (!closing.length) return;
    await Promise.race([
      Promise.allSettled(closing),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }

  async #rotate(state, endedAt, final = false) {
    if (!state.current) return;
    clearTimeout(state.timer);
    const current = state.current;
    state.current = null;
    const durationMs = Math.max(0, endedAt - current.startedAt);
    for (const track of current.tracks.values()) track.close(durationMs);
    current.reference?.close(durationMs);
    const relativeDirectory = relative(this.root, current.directory).replaceAll("\\", "/");
    const chunkId = randomUUID();
    const speakers = [];
    for (const [userId, track] of current.tracks) {
      const speaker = current.speakers.get(userId);
      if (!speaker) continue;
      const filename = speakerRecordingFilename({
        speaker,
        sessionStartedAt: state.startedAt,
        startedAt: current.startedAt,
        endedAt,
        timeZone: this.filenameTimeZone,
        extension: "s16le",
      });
      const archivedPath = safeInside(this.root, resolve(current.directory, filename));
      if (track.path !== archivedPath) renameSync(track.path, archivedPath);
      track.path = archivedPath;
      speakers.push({
        ...speaker,
        file: relative(this.root, archivedPath).replaceAll("\\", "/"),
      });
    }
    const metadata = {
      sessionId: state.id, chunkId, chunkIndex: current.index,
      startMs: current.startedAt - state.startedAt,
      endMs: endedAt - state.startedAt,
      keepFromMs: current.keepFromMs,
      language: state.language, provider: state.provider, model: state.model, speakers,
      referenceFile: current.reference?.hasAudio ? `${relativeDirectory}/music.s16le` : null,
    };
    writeFileSync(resolve(current.directory, "job.json"), JSON.stringify(metadata, null, 2));
    createTranscriptionChunk({
      id: chunkId, sessionId: state.id, chunkIndex: current.index,
      status: speakers.length ? "pending" : "ready",
      startMs: metadata.startMs, endMs: metadata.endMs,
      directory: relativeDirectory, speakerCount: speakers.length,
    });
    if (speakers.length) {
      if (listPendingTranscriptionChunks().length > MAX_PENDING_CHUNKS) {
        updateTranscriptionChunk(chunkId, {
          status: "error", error: "Очередь Whisper превысила безопасный лимит.", processedAt: this.now(),
        });
        throw new Error("Очередь Whisper превысила безопасный лимит.");
      }
      state.pendingJobs += 1;
      this.jobs.push({ state, metadata, attempt: 1 });
      void this.#pump();
    }
    if (!final && !state.stopped) {
      state.liveSegments.clear();
      state.chunkIndex += 1;
      this.#openChunk(state, endedAt - this.overlapMs, endedAt + this.chunkMs, current);
      this.#scheduleRotation(state);
    }
    this.#maybeComplete(state);
  }

  async #pump() {
    if (this.processing) return;
    const item = this.jobs.shift();
    if (!item) return;
    this.processing = true;
    const { state, metadata, attempt = 1 } = item;
    let terminal = false;
    updateTranscriptionChunk(metadata.chunkId, { status: "processing", error: null });
    try {
      const profile = this.settings.resolve(metadata.provider, metadata.model);
      const result = await this.worker.transcribe({ ...metadata, root: "/data/transcriptions" }, profile);
      const segments = (result.segments || []).map((segment) => ({
        ...segment,
        startMs: metadata.startMs + Number(segment.startMs || 0),
        endMs: metadata.startMs + Number(segment.endMs || 0),
      }));
      insertTranscriptionSegments(state.id, metadata.chunkId, segments);
      updateTranscriptionChunk(metadata.chunkId, {
        status: "ready", aecConfidence: result.aecConfidence,
        processedAt: this.now(), error: null,
      });
      await this.#announcePartial(state, metadata, segments);
      terminal = true;
    } catch (error) {
      if (attempt < this.maxJobAttempts) {
        updateTranscriptionChunk(metadata.chunkId, {
          status: "pending",
          error: `Попытка ${attempt}/${this.maxJobAttempts}: ${error.message}`,
        });
        setTimeout(() => {
          this.jobs.push({ state, metadata, attempt: attempt + 1 });
          void this.#pump();
        }, this.jobRetryDelayMs * attempt).unref?.();
        return;
      }
      updateTranscriptionChunk(metadata.chunkId, {
        status: "error", error: error.message, processedAt: this.now(),
      });
      terminal = true;
    } finally {
      this.processing = false;
      if (terminal) {
        state.pendingJobs = Math.max(0, state.pendingJobs - 1);
        this.#maybeComplete(state);
      }
      void this.#pump();
    }
  }

  async #announcePartial(state, metadata, segments) {
    if (!segments.length || !state.guild || !state.announceChannelId) return;
    const channel = state.guild.channels?.cache?.get?.(state.announceChannelId);
    if (!channel?.send) return;
    const lines = segments.map((segment) => {
      const seconds = Math.max(0, Math.floor(Number(segment.startMs || 0) / 1000));
      const stamp = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
      return `[${stamp}] **${String(segment.speakerName || segment.speakerId).slice(0, 80)}:** ${segment.text}`;
    });
    const heading = `📝 **Транскрипция · минута ${metadata.chunkIndex + 1}**\n`;
    const message = `${heading}${lines.join("\n")}`.slice(0, 1_950);
    await channel.send({ content: message, allowedMentions: { parse: [] } }).catch((error) => {
      console.warn(`[transcription:${state.id}] Не удалось отправить минутный текст:`, error.message);
    });
  }

  #maybeComplete(state) {
    if (state.fatal || !state.stopped || state.current || state.pendingJobs > 0) return;
    const chunks = listTranscriptionChunks(state.id);
    const failed = chunks.some((chunk) => chunk.status === "error");
    updateTranscriptionSession(state.id, {
      status: failed ? "completed_with_errors" : "completed",
      stoppedAt: state.stoppedAt,
      error: failed ? "Некоторые чанки не удалось обработать." : null,
    });
  }

  async stop(guildId) {
    const state = this.active.get(String(guildId));
    if (!state) throw new Error("Активная транскрипция не найдена.");
    state.stopped = true;
    state.stoppedAt = this.now();
    clearTimeout(state.timer);
    state.unregisterReference?.();
    state.queue.connection?.receiver?.speaking?.off?.("start", state.onSpeaking);
    for (const stream of state.subscriptions.values()) stream.destroy();
    state.subscriptions.clear();
    state.decoders.clear();
    await this.#closeRealtimeStreams(state);
    state.queue.releaseVoiceLease(`transcription:${state.id}`);
    this.active.delete(String(guildId));
    updateTranscriptionSession(state.id, {
      status: "finalizing", stoppedAt: state.stoppedAt,
      audioExpiresAt: state.stoppedAt + this.retentionMs,
    });
    await this.#rotate(state, state.stoppedAt, true);
    this.#maybeComplete(state);
    return this.details(state.id);
  }

  #failSession(state, error) {
    console.error(`[transcription:${state.id}]`, error);
    const stoppedAt = this.now();
    state.stopped = true;
    state.fatal = true;
    state.stoppedAt = stoppedAt;
    clearTimeout(state.timer);
    state.unregisterReference?.();
    state.queue.connection?.receiver?.speaking?.off?.("start", state.onSpeaking);
    for (const stream of state.subscriptions.values()) stream.destroy();
    state.subscriptions.clear();
    state.decoders.clear();
    for (const { stream } of state.realtimeStreams.values()) void stream.close();
    state.realtimeStreams.clear();
    state.queue.releaseVoiceLease(`transcription:${state.id}`);
    this.active.delete(String(state.guild.id));
    if (state.current) {
      const durationMs = Math.max(0, stoppedAt - state.current.startedAt);
      for (const track of state.current.tracks.values()) track.close(durationMs);
      state.current.reference?.close(durationMs);
      state.current = null;
    }
    updateTranscriptionSession(state.id, {
      status: "error", stoppedAt, audioExpiresAt: stoppedAt + this.retentionMs, error: error.message,
    });
  }

  status(guildId) {
    const active = this.active.get(String(guildId));
    return {
      workerQueue: this.jobs.length + (this.processing ? 1 : 0),
      active: active ? this.details(active.id) : getActiveTranscriptionSession(guildId),
      sessions: listTranscriptionSessions(guildId),
    };
  }

  details(id) {
    const session = getTranscriptionSession(id);
    if (!session) return null;
    const active = [...this.active.values()].find((candidate) => candidate.id === String(id));
    return {
      ...session,
      chunks: listTranscriptionChunks(id),
      segments: listTranscriptionSegments(id),
      liveSegments: active ? [...active.liveSegments.values()].map((segment) => ({ ...segment })) : [],
      realtime: {
        enabled: isMistralRealtimeProfile(session),
        streams: active?.realtimeStreams.size || 0,
        errors: active ? active.realtimeErrors.map((error) => ({ ...error })) : [],
      },
    };
  }

  export(id, format = "txt") {
    const session = getTranscriptionSession(id);
    if (!session) throw new Error("Сессия транскрипции не найдена.");
    const partial = ["recording", "finalizing"].includes(session.status);
    return {
      content: exportTranscript(session, listTranscriptionSegments(id), format, { partial }),
      filename: transcriptFilename(session, format, partial),
      partial,
    };
  }

  delete(id) {
    const session = getTranscriptionSession(id);
    if (!session) return false;
    if (["recording", "finalizing"].includes(session.status)) throw new Error("Сначала остановите транскрипцию.");
    const directory = safeInside(this.root, resolve(this.root, id));
    rmSync(directory, { recursive: true, force: true });
    return deleteTranscriptionSession(id);
  }

  cleanupExpired(now = this.now()) {
    let removed = 0;
    for (const session of listExpiredTranscriptionAudio(now)) {
      const directory = safeInside(this.root, resolve(this.root, session.id));
      rmSync(directory, { recursive: true, force: true });
      updateTranscriptionSession(session.id, { audioDeletedAt: now });
      removed += 1;
    }
    return removed;
  }

  resumePending() {
    markInterruptedTranscriptionSessions(this.now());
    const recovered = new Map();
    for (const chunk of listPendingTranscriptionChunks()) {
      const jobPath = safeInside(this.root, resolve(this.root, chunk.directory, "job.json"));
      if (!existsSync(jobPath)) {
        updateTranscriptionChunk(chunk.id, { status: "error", error: "Файл задания не найден.", processedAt: this.now() });
        continue;
      }
      const session = getTranscriptionSession(chunk.sessionId);
      if (!session) continue;
      const metadata = JSON.parse(readFileSync(jobPath, "utf8"));
      let state = recovered.get(session.id);
      if (!state) {
        state = { id: session.id, stopped: true, stoppedAt: session.stoppedAt || this.now(), current: null, pendingJobs: 0 };
        recovered.set(session.id, state);
      }
      state.pendingJobs += 1;
      this.jobs.push({ state, metadata, attempt: 1 });
    }
    void this.#pump();
  }

  async shutdown() {
    for (const guildId of [...this.active.keys()]) {
      await this.stop(guildId).catch((error) => console.warn(`[transcription:${guildId}] shutdown:`, error.message));
    }
  }
}

export const transcriptionService = new TranscriptionService();
