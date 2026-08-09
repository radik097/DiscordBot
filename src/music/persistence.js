import { readFileSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const STATE_PATH = new URL("../../data/queue-state.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function ensureDir(path) {
  mkdirSync(dirname(path), { recursive: true });
}

export function saveQueueState(queues) {
  try {
    ensureDir(STATE_PATH);
    const state = {};
    for (const [guildId, queue] of queues) {
      if (queue.playing || queue.tracks.length > 0) {
        state[guildId] = {
          playing: queue.playing,
          tracks: queue.tracks,
          volume: queue.volume,
          savedAt: Date.now(),
        };
      }
    }
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
    console.log(`[persistence] Сохранено состояние ${Object.keys(state).length} очередей`);
  } catch (err) {
    console.error(`[persistence] Ошибка сохранения состояния:`, err.message);
  }
}

export function loadQueueState() {
  try {
    const data = readFileSync(STATE_PATH, "utf-8");
    const state = JSON.parse(data);
    console.log(`[persistence] Загружено состояние ${Object.keys(state).length} очередей`);
    return state;
  } catch (err) {
    if (err.code === "ENOENT") {
      return {};
    }
    console.error(`[persistence] Ошибка загрузки состояния:`, err.message);
    return {};
  }
}

export function clearQueueState() {
  try {
    const fs = require("node:fs");
    if (fs.existsSync(STATE_PATH)) {
      fs.unlinkSync(STATE_PATH);
    }
    console.log(`[persistence] Состояние очередей очищено`);
  } catch (err) {
    console.error(`[persistence] Ошибка очистки состояния:`, err.message);
  }
}
