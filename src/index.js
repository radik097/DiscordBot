import "dotenv/config";
import ffmpegPath from "ffmpeg-static";
import { Client, GatewayIntentBits, Partials, Collection, MessageFlags } from "discord.js";
import { logMessage, logEdit, logDelete } from "./db.js";
import { loadConfig } from "./structureManager.js";
import { loadCommandModules } from "./commandLoader.js";
import { startWebServer } from "./web/server.js";
import { saveAllQueues, restoreQueueState } from "./music/queue.js";
import { resumePlaylistSaveJobs } from "./music/library.js";

process.env.FFMPEG_PATH ??= ffmpegPath;

const NEWCOMER_ROLE = "Новичок";
const MEMBER_ROLE = "Участник";

const { DISCORD_TOKEN, WEB_PORT } = process.env;
if (!DISCORD_TOKEN) {
  console.error("DISCORD_TOKEN не задан в .env");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
});

client.commands = new Collection();
const commandsDir = new URL("./commands/", import.meta.url);
for (const cmd of await loadCommandModules(commandsDir)) {
  client.commands.set(cmd.data.name, cmd);
}

function botOnlyChannelNames() {
  try {
    const config = loadConfig();
    return new Set((config.channels ?? []).filter((c) => c.botOnly).map((c) => c.name));
  } catch (err) {
    console.error("Не удалось прочитать config/structure.json:", err.message);
    return new Set();
  }
}

async function logToBotChannel(guild, text) {
  const names = botOnlyChannelNames();
  const channel = guild.channels.cache.find((c) => names.has(c.name) && c.isTextBased?.());
  if (!channel) return;
  await channel.send(text).catch((err) => console.error("Не удалось написать в бот-лог:", err.message));
}

client.once("clientReady", async () => {
  console.log(`Вошёл как ${client.user.tag}`);
  await restoreQueueState(client);
  resumePlaylistSaveJobs();
  startWebServer(client, WEB_PORT ? Number(WEB_PORT) : 8787);
});

client.on("guildMemberAdd", async (member) => {
  if (member.user.bot) return;
  const role = member.guild.roles.cache.find((r) => r.name === NEWCOMER_ROLE);
  if (!role) {
    console.error(`Роль "${NEWCOMER_ROLE}" не найдена — не могу выдать новичку при входе`);
    return;
  }
  try {
    await member.roles.add(role, "Авто-роль новичка при входе на сервер");
    await logToBotChannel(member.guild, `➕ ${member.user.tag} присоединился(-ась) — выдана роль ${NEWCOMER_ROLE}.`);
  } catch (err) {
    console.error(`Не удалось выдать роль "${NEWCOMER_ROLE}" участнику ${member.user.tag}:`, err.message);
  }
});

client.on("interactionCreate", async (interaction) => {
  if (interaction.isChatInputCommand()) {
    const command = client.commands.get(interaction.commandName);
    if (!command) return;
    try {
      await command.execute(interaction);
    } catch (err) {
      console.error(err);
      const payload = { content: "Произошла ошибка при выполнении команды.", flags: MessageFlags.Ephemeral };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload).catch(() => {});
      } else {
        await interaction.reply(payload).catch(() => {});
      }
    }
    return;
  }

  if (interaction.isButton() && interaction.customId === "rules_accept") {
    const guild = interaction.guild;
    const member = interaction.member;
    if (!guild || !member) return;

    const memberRole = guild.roles.cache.find((r) => r.name === MEMBER_ROLE);
    const newcomerRole = guild.roles.cache.find((r) => r.name === NEWCOMER_ROLE);
    if (!memberRole) {
      return interaction.reply({ content: `Роль "${MEMBER_ROLE}" не найдена на сервере, обратитесь к администратору.`, flags: MessageFlags.Ephemeral });
    }

    if (member.roles.cache.has(memberRole.id)) {
      return interaction.reply({ content: "Вы уже приняли правила.", flags: MessageFlags.Ephemeral });
    }

    try {
      await member.roles.add(memberRole, "Принятие правил через кнопку");
      if (newcomerRole && member.roles.cache.has(newcomerRole.id)) {
        await member.roles.remove(newcomerRole, "Принятие правил через кнопку");
      }
      await interaction.reply({ content: "Добро пожаловать! Правила приняты, доступ открыт.", flags: MessageFlags.Ephemeral });
      await logToBotChannel(guild, `✅ ${interaction.user.tag} принял(а) правила — выдана роль ${MEMBER_ROLE}.`);
    } catch (err) {
      console.error("Не удалось выдать роль после принятия правил:", err.message);
      await interaction.reply({ content: "Не получилось выдать роль — не хватает прав у бота. Сообщите администратору.", flags: MessageFlags.Ephemeral });
    }
  }
});

// История сообщений — логируем всё, включая сообщения самого бота.
client.on("messageCreate", async (message) => {
  if (message.guildId) logMessage(message);

  // Защита bot-only канала: Administrator обходит permission overwrites в Discord,
  // поэтому одних прав канала недостаточно — удаляем чужие сообщения явно.
  if (!message.author.bot && message.guild && botOnlyChannelNames().has(message.channel.name)) {
    try {
      await message.delete();
      const warn = await message.channel.send(
        `${message.author}, в этот канал может писать только бот.`
      );
      setTimeout(() => warn.delete().catch(() => {}), 5000);
    } catch (err) {
      console.error("Не удалось удалить сообщение в bot-only канале:", err.message);
    }
  }
});

client.on("messageUpdate", async (_old, newMessage) => {
  if (newMessage.partial) {
    try {
      newMessage = await newMessage.fetch();
    } catch {
      return;
    }
  }
  if (newMessage.guildId) logEdit(newMessage);
});

client.on("messageDelete", (message) => {
  logDelete(message.id);
});

client.on("shardDisconnect", (_event, shardId) => {
  console.warn(`[discord] Шард ${shardId} отключён, ожидаю автоматическое переподключение`);
});
client.on("shardReconnecting", (shardId) => {
  console.warn(`[discord] Шард ${shardId} переподключается`);
});
client.on("shardResume", (shardId, replayedEvents) => {
  console.log(`[discord] Сессия шарда ${shardId} восстановлена, событий повторено: ${replayedEvents}`);
});
client.on("shardError", (err, shardId) => {
  console.error(`[discord] Ошибка WebSocket шарда ${shardId}:`, err.message);
});
client.on("error", (err) => console.error("[discord] Ошибка клиента:", err.message));
client.on("warn", (message) => console.warn("[discord]", message));

let shuttingDown = false;
async function shutdown(reason, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${reason}, сохраняю состояние и завершаю работу...`);
  saveAllQueues();
  try {
    await client.destroy();
  } catch (err) {
    console.error("[shutdown] Ошибка завершения Discord-клиента:", err.message);
  }
  process.exit(exitCode);
}

client.on("invalidated", () => {
  console.error("[discord] Сессия признана недействительной — перезапускаю процесс для чистого входа");
  void shutdown("Discord-сессия недействительна", 1);
});

client.login(DISCORD_TOKEN).catch((err) => {
  console.error("[discord] Не удалось войти:", err.message);
  void shutdown("Ошибка входа в Discord", 1);
});

// Graceful shutdown handlers
process.on("SIGTERM", () => void shutdown("Получен SIGTERM"));
process.on("SIGINT", () => void shutdown("Получен SIGINT"));

process.on("uncaughtException", (err) => {
  console.error("[uncaught] Необработанное исключение:", err);
  void shutdown("Необработанное исключение", 1);
});

process.on("unhandledRejection", (reason) => {
  console.error("[unhandled] Необработанный Promise rejection:", reason);
  saveAllQueues();
});
