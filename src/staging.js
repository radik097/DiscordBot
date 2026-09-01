import "dotenv/config";
import { Collection } from "discord.js";
import { startWebServer } from "./web/server.js";

const port = Number(process.env.WEB_PORT) || 8788;
const client = {
  isReady: () => true,
  user: { tag: "Access staging (без Discord и музыки)" },
  guilds: { cache: new Collection() },
};

const server = startWebServer(client, port);
console.log(`[staging] Тестовый клон авторизации запущен на http://127.0.0.1:${server.port}`);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await server.stopRemoteAccess?.();
  server.stopPanel?.();
  server.stop?.(true);
  process.exit(0);
}

process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
