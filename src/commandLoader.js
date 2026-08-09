import { readdirSync } from "node:fs";

// Each file in src/commands/ exports either a single {data, execute} command,
// or a `commands` array of such pairs — used when several closely related
// slash commands share helpers (e.g. music.js exporting /play /skip /stop ...).
export async function loadCommandModules(commandsDir) {
  const list = [];
  for (const file of readdirSync(commandsDir).filter((f) => f.endsWith(".js"))) {
    const mod = await import(new URL(file, commandsDir));
    if (Array.isArray(mod.commands)) list.push(...mod.commands);
    else list.push(mod);
  }
  return list;
}
