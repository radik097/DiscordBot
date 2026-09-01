import "dotenv/config";
import { REST, Routes } from "discord.js";
import { loadCommandModules } from "./commandLoader.js";

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error("Заполни DISCORD_TOKEN и CLIENT_ID в .env перед регистрацией команд.");
  process.exit(1);
}

const commandsDir = new URL("./commands/", import.meta.url);
const commands = (await loadCommandModules(commandsDir)).map((cmd) => cmd.data.toJSON());

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

const route = GUILD_ID
  ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
  : Routes.applicationCommands(CLIENT_ID);

const result = await rest.put(route, { body: commands });
console.log(
  `Зарегистрировано команд: ${result.length} (${GUILD_ID ? `на сервере ${GUILD_ID}` : "глобально, обновится до часа"})`
);
