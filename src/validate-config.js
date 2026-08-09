import { loadConfig, validateConfig } from "./structureManager.js";

const config = loadConfig();
console.log("Roles:", config.roles.length, "Categories:", config.categories.length, "Channels:", config.channels.length);

for (const name of config.protectedChannels ?? []) {
  const known = new Set(config.channels.map((c) => c.name));
  if (!known.has(name)) console.warn(`Note: protectedChannels entry '${name}' doesn't match any channel in config (fine if it only exists live on Discord)`);
}

const errors = validateConfig(config);
if (errors.length) {
  console.log("ERRORS:");
  errors.forEach((e) => console.log(" -", e));
  process.exit(1);
} else {
  console.log("All references valid.");
}
