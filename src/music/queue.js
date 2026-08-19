import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
} from "@discordjs/voice";
import { randomUUID } from "node:crypto";
import { getAudioStream } from "./source.js";
import { saveQueueState, loadQueueState } from "./persistence.js";

const IDLE_LEAVE_MS = 5 * 60 * 1000;
const MAX_QUEUE_SIZE = 500;

// s16le, 48kHz, stereo => bytes/sec of raw PCM that a fully realtime playback consumes.
const PCM_BYTES_PER_SEC = 48000 * 2 * 2;

function sanitizeFileName(name) {
  if (!name) return "(без названия)";
  return name.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 100);
}

function queueTrack(track) {
  return {
    ...track,
    queueId: track?.queueId || randomUUID(),
  };
}

class GuildQueue {
  constructor(guildId) {
    this.guildId = guildId;
    this.tracks = [];
    this.playing = null;
    this.volume = 1;
    this.connection = null;
    this.textChannelId = null;
    this.idleTimer = null;
    this.currentProcess = null;
    this.currentResource = null;
    this.currentStreamStats = null;
    this.currentQuality = null;
    this.stabilitySamples = [];
    this.lastTelemetrySample = null;
    this.lastStabilityIssue = null;
    this.playGeneration = 0;
    this.destroyed = false;

    this.player = createAudioPlayer();
    this.player.on("stateChange", (oldState, newState) => {
      console.log(`[music:${guildId}] player: ${oldState.status} -> ${newState.status}`);
    });
    this.player.on(AudioPlayerStatus.Idle, (oldState) => {
      this.handlePlaybackFinished(oldState?.resource?.metadata);
    });
    this.player.on("error", (err) => {
      console.error(`[music:${guildId}] Ошибка плеера:`, err.message, err.resource?.metadata ?? "");
      this.handlePlaybackFinished(err.resource?.metadata);
    });
  }

  handlePlaybackFinished(metadata) {
    if (this.destroyed || metadata?.generation !== this.playGeneration) return;
    this.playing = null;
    void this.playNext();
  }

  connect(voiceChannel) {
    if (this.destroyed) throw new Error("Очередь уже завершена");
    if (this.connection) {
      if (this.connection.joinConfig.channelId !== voiceChannel.id) {
        this.connection.rejoin({ channelId: voiceChannel.id });
      }
      return;
    }
    this.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
    });
    const subscription = this.connection.subscribe(this.player);
    if (!subscription) console.error(`[music:${this.guildId}] connection.subscribe() вернул undefined — плеер не подписан на соединение!`);

    this.connection.on("stateChange", (oldState, newState) => {
      console.log(`[music:${this.guildId}] connection: ${oldState.status} -> ${newState.status}`);
    });

    entersState(this.connection, VoiceConnectionStatus.Ready, 15000).catch((err) =>
      console.error(`[music:${this.guildId}] Соединение не дошло до Ready:`, err.message)
    );

    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5000),
        ]);
      } catch {
        this.destroy();
      }
    });
  }

  clearIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  scheduleIdleLeave() {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => this.destroy(), IDLE_LEAVE_MS);
  }

  async enqueue(track) {
    return this.enqueueMany([track]);
  }

  async enqueueMany(tracks) {
    if (!Array.isArray(tracks) || tracks.length === 0) return 0;
    if (this.tracks.length + tracks.length > MAX_QUEUE_SIZE) {
      const available = Math.max(0, MAX_QUEUE_SIZE - this.tracks.length);
      throw new Error(`В очереди недостаточно места: доступно ${available}, требуется ${tracks.length} (максимум ${MAX_QUEUE_SIZE})`);
    }
    this.tracks.push(...tracks.map(queueTrack));
    this.clearIdleTimer();
    if (!this.playing) await this.playNext();
    scheduleQueueSave();
    return tracks.length;
  }

  removeTrack(queueId) {
    if (this.destroyed) return null;
    const index = this.tracks.findIndex((track) => track.queueId === queueId);
    if (index < 0) return null;
    const [removed] = this.tracks.splice(index, 1);
    saveQueueState(queues);
    return removed;
  }

  playTrackNow(queueId) {
    if (this.destroyed) return null;
    const index = this.tracks.findIndex((track) => track.queueId === queueId);
    if (index < 0) return null;
    const [selected] = this.tracks.splice(index, 1);
    this.tracks.unshift(selected);
    this.clearIdleTimer();
    if (this.playing) this.skip();
    else void this.playNext();
    saveQueueState(queues);
    return selected;
  }

  getPlaylistSnapshot() {
    if (this.destroyed) return [];
    return [this.playing, ...this.tracks]
      .filter(Boolean)
      .map((track) => ({ ...track }));
  }

  killCurrentProcess() {
    this.stopStatsLogging();
    if (this.currentProcess && !this.currentProcess.killed) {
      this.currentProcess.kill();
    }
    this.currentProcess = null;
  }

  // Logs, once a second, how much audio ffmpeg has buffered (decoded from the
  // cached file) versus how much has actually been played out to the voice
  // connection. If "played" stalls while "buffered" keeps climbing, that's the
  // Discord/voice send side falling behind, not the source — points at CPU.
  startStatsLogging(streamStats) {
    this.stopStatsLogging();
    let lastBytesOut = 0;
    let lastPlaybackMs = 0;
    let lastSampleAt = Date.now();
    this.currentStreamStats = streamStats;
    this.stabilitySamples = [];
    this.lastTelemetrySample = null;
    this.lastStabilityIssue = null;
    this.statsInterval = setInterval(() => {
      const resource = this.currentResource;
      if (!resource) return;

      const now = Date.now();
      const wallDeltaMs = Math.max(1, now - lastSampleAt);
      lastSampleAt = now;
      const bufferedDelta = streamStats.bytesOut - lastBytesOut;
      lastBytesOut = streamStats.bytesOut;

      const playbackMs = resource.playbackDuration;
      const playbackDeltaMs = Math.max(0, playbackMs - lastPlaybackMs);
      const playedDelta = (playbackDeltaMs / 1000) * PCM_BYTES_PER_SEC;
      lastPlaybackMs = playbackMs;

      const playerStatus = this.player.state.status;
      const voiceStatus = this.connection?.state?.status ?? "disconnected";
      let healthy = null;
      let reason = null;

      if (playerStatus === AudioPlayerStatus.Playing) {
        healthy = voiceStatus === VoiceConnectionStatus.Ready
          && playbackDeltaMs >= Math.min(500, wallDeltaMs * 0.5);
        if (voiceStatus !== VoiceConnectionStatus.Ready) reason = "voice-not-ready";
        else if (!healthy) reason = "playback-stalled";
      } else if (playerStatus === AudioPlayerStatus.Buffering || playerStatus === AudioPlayerStatus.AutoPaused) {
        healthy = false;
        reason = "buffering";
      }

      if (healthy !== null) {
        this.stabilitySamples.push(healthy);
        if (this.stabilitySamples.length > 30) this.stabilitySamples.shift();
      }
      if (reason) this.lastStabilityIssue = { reason, at: now };
      this.lastTelemetrySample = {
        at: now,
        healthy,
        reason,
        playbackRate: playbackDeltaMs / wallDeltaMs,
        decodedBytesPerSec: (bufferedDelta * 1000) / wallDeltaMs,
      };

      console.log(
        `[music:${this.guildId}] буфер: ${(bufferedDelta / 1e6).toFixed(2)} MB/s | воспроизведено: ${(playedDelta / 1e6).toFixed(2)} MB/s`
      );
    }, 1000);
  }

  stopStatsLogging() {
    if (this.statsInterval) clearInterval(this.statsInterval);
    this.statsInterval = null;
  }

  getPlaybackStatus() {
    if (!this.playing) {
      return {
        state: "idle",
        playerStatus: this.player.state.status,
        voiceStatus: this.connection?.state?.status ?? "disconnected",
        elapsedSec: 0,
        remainingSec: 0,
        durationSec: 0,
        progressPercent: 0,
        bufferedSec: 0,
        stabilityPercent: null,
        sampleCount: 0,
        serverTime: Date.now(),
      };
    }

    const playerStatus = this.player.state.status;
    const voiceStatus = this.connection?.state?.status ?? "disconnected";
    const elapsedSec = Math.max(0, (this.currentResource?.playbackDuration ?? 0) / 1000);
    const durationSec = Math.max(0, Number(this.playing.durationSec) || 0);
    const remainingSec = durationSec ? Math.max(0, durationSec - elapsedSec) : null;
    const progressPercent = durationSec ? Math.min(100, (elapsedSec / durationSec) * 100) : 0;
    const decodedSec = (this.currentStreamStats?.bytesOut ?? 0) / PCM_BYTES_PER_SEC;
    const bufferedSec = Math.max(0, decodedSec - elapsedSec);
    const stableCount = this.stabilitySamples.filter(Boolean).length;
    const stabilityPercent = this.stabilitySamples.length
      ? Math.round((stableCount / this.stabilitySamples.length) * 100)
      : null;

    let state = "loading";
    if (playerStatus === AudioPlayerStatus.Playing && voiceStatus === VoiceConnectionStatus.Ready) {
      state = this.lastTelemetrySample?.healthy === false ? "warning" : "stable";
    } else if (playerStatus === AudioPlayerStatus.Paused) state = "paused";
    else if (playerStatus === AudioPlayerStatus.Buffering || playerStatus === AudioPlayerStatus.AutoPaused) state = "buffering";
    else if (voiceStatus !== VoiceConnectionStatus.Ready) state = "connecting";

    return {
      state,
      playerStatus,
      voiceStatus,
      elapsedSec,
      remainingSec,
      durationSec,
      progressPercent,
      bufferedSec,
      stabilityPercent,
      sampleCount: this.stabilitySamples.length,
      playbackRate: this.lastTelemetrySample?.playbackRate ?? null,
      decodedKbps: this.lastTelemetrySample
        ? Math.round(this.lastTelemetrySample.decodedBytesPerSec / 1024)
        : null,
      quality: this.currentQuality,
      lastIssue: this.lastStabilityIssue,
      serverTime: Date.now(),
    };
  }

  async playNext() {
    const generation = ++this.playGeneration;
    this.killCurrentProcess();
    this.currentResource = null;
    this.currentStreamStats = null;
    this.currentQuality = null;
    const next = this.tracks.shift();
    if (!next) {
      this.playing = null;
      this.scheduleIdleLeave();
      return;
    }
    this.playing = next;
    try {
      const { stream, type, process: child, quality, stats } = await getAudioStream(next.url, next._quality ?? "best");
      if (generation !== this.playGeneration) {
        stream.destroy();
        if (!child.killed) child.kill();
        return;
      }
      this.currentProcess = child;
      this.currentQuality = quality;
      console.log(`[music:${this.guildId}] Поток запущен для "${sanitizeFileName(next.title)}", quality=${quality}, type=${type}`);
      const resource = createAudioResource(stream, {
        inputType: type,
        inlineVolume: true,
        metadata: { queueId: next.queueId, generation },
      });
      resource.volume?.setVolume(this.volume);
      this.currentResource = resource;
      this.player.play(resource);
      this.startStatsLogging(stats);
    } catch (err) {
      if (generation !== this.playGeneration) return;
      const attempts = (next._attempts ?? 0) + 1;
      console.error(`[music:${this.guildId}] Не удалось получить поток для "${sanitizeFileName(next.title)}" (попытка ${attempts}):`, err.message);

      if (err.message.includes("403")) {
        if (!next._quality || next._quality === "best") {
          console.warn(`[music:${this.guildId}] 403 ошибка, пробую худшее качество...`);
          next._quality = "worst";
          next._attempts = 0;
          this.tracks.unshift(next);
          await new Promise((r) => setTimeout(r, 2000));
        } else if (attempts <= 2) {
          next._attempts = attempts;
          this.tracks.unshift(next);
          await new Promise((r) => setTimeout(r, 3000));
        } else {
          console.error(`[music:${this.guildId}] Сдаюсь после ${attempts} попыток и 403 ошибок, пропускаю "${sanitizeFileName(next.title)}"`);
        }
      } else if (attempts <= 2) {
        next._attempts = attempts;
        this.tracks.unshift(next);
        await new Promise((r) => setTimeout(r, 2000));
      } else {
        console.error(`[music:${this.guildId}] Сдаюсь после ${attempts} попыток, пропускаю "${sanitizeFileName(next.title)}"`);
      }
      await this.playNext();
    }
  }

  skip() {
    this.playGeneration += 1;
    const stopped = this.player.stop(true);
    this.playing = null;
    if (!this.destroyed) void this.playNext();
    scheduleQueueSave();
    return stopped;
  }

  pause() {
    if (this.destroyed) return false;
    return this.player.pause();
  }

  resume() {
    if (this.destroyed) return false;
    return this.player.unpause();
  }

  setVolume(v) {
    if (this.destroyed) return;
    this.volume = v;
    this.currentResource?.volume?.setVolume(v);
    scheduleQueueSave();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.playGeneration += 1;
    this.clearIdleTimer();
    this.stopStatsLogging();
    this.killCurrentProcess();
    this.tracks = [];
    this.playing = null;
    this.currentResource = null;
    this.currentStreamStats = null;
    this.currentQuality = null;
    this.stabilitySamples = [];
    this.lastTelemetrySample = null;
    try {
      this.player.stop(true);
    } catch {}
    try {
      this.connection?.destroy();
    } catch {}
    this.connection = null;
    queues.delete(this.guildId);
    scheduleQueueSave();
  }
}

const queues = new Map();
let saveTimer = null;

function scheduleQueueSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveQueueState(queues);
  }, 100);
  saveTimer.unref?.();
}

export function getQueue(guildId) {
  let q = queues.get(guildId);
  if (!q) {
    q = new GuildQueue(guildId);
    queues.set(guildId, q);
  }
  return q;
}

export function peekQueue(guildId) {
  return queues.get(guildId) ?? null;
}

export function listQueues() {
  return [...queues.values()];
}

export function getAllQueues() {
  return queues;
}

export function saveAllQueues() {
  saveQueueState(queues);
}

export async function restoreQueueState(client) {
  const state = loadQueueState();
  let restored = 0;
  for (const [guildId, data] of Object.entries(state)) {
    try {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) continue;

      const queue = getQueue(guildId);
      const restoredTracks = [data.playing, ...(Array.isArray(data.tracks) ? data.tracks : [])]
        .filter((track) => track?.url)
        .map(queueTrack);
      queue.tracks = restoredTracks;
      restored += restoredTracks.length;
      queue.textChannelId = data.textChannelId ?? null;
      if (data.volume) {
        queue.setVolume(data.volume);
      }
      if (restoredTracks.length && data.voiceChannelId) {
        const voiceChannel = guild.channels.cache.get(data.voiceChannelId);
        if (voiceChannel?.isVoiceBased?.()) {
          queue.connect(voiceChannel);
          void queue.playNext();
        } else {
          console.warn(`[persistence] Голосовой канал ${data.voiceChannelId} больше недоступен — очередь сохранена без автозапуска`);
        }
      }
    } catch (err) {
      console.error(`[persistence] Ошибка восстановления очереди для гильдии ${guildId}:`, err.message);
    }
  }
  if (restored > 0) {
    console.log(`[persistence] Восстановлено ${restored} треков в очередях`);
  }
}
