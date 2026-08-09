import { readFileSync, writeFileSync } from "node:fs";
import { ChannelType, PermissionsBitField } from "discord.js";

const CONFIG_PATH = new URL("../config/structure.json", import.meta.url);

export function loadConfig() {
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  return JSON.parse(raw);
}

export function saveConfig(config) {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

// Offline structural check (no Discord API calls): every role/category/permission
// name referenced anywhere in the config actually exists. Used by both the CLI
// (`bun run validate-config`) and the web panel's config editor.
export function validateConfig(config) {
  const errors = [];
  const flagNames = new Set(Object.keys(PermissionsBitField.Flags));
  const roleNames = new Set((config.roles ?? []).map((r) => r.name));
  roleNames.add("@everyone");
  const catNames = new Set((config.categories ?? []).map((c) => c.name));
  const chanNames = new Set((config.channels ?? []).map((c) => c.name));

  const checkPerms = (list, ctx) => {
    for (const p of list ?? []) if (!flagNames.has(p)) errors.push(`Unknown permission '${p}' in ${ctx}`);
  };
  const checkRoleSpec = (spec, ctx) => {
    for (const [role, entry] of Object.entries(spec ?? {})) {
      if (!roleNames.has(role)) errors.push(`Unknown role '${role}' in ${ctx}`);
      if (Array.isArray(entry)) checkPerms(entry, ctx + "/" + role);
      else {
        checkPerms(entry.allow, ctx + "/" + role + "/allow");
        checkPerms(entry.deny, ctx + "/" + role + "/deny");
      }
    }
  };

  for (const r of config.roles ?? []) checkPerms(r.permissions, "role:" + r.name);
  for (const [role, perms] of Object.entries(config.globalDenyRoles ?? {})) {
    if (!roleNames.has(role)) errors.push("Unknown role in globalDenyRoles: " + role);
    checkPerms(perms, "globalDenyRoles/" + role);
  }
  for (const [role, perms] of Object.entries(config.alwaysAllRoles ?? {})) {
    if (!roleNames.has(role)) errors.push("Unknown role in alwaysAllRoles: " + role);
    checkPerms(perms, "alwaysAllRoles/" + role);
  }
  for (const rule of config.isolationRoles ?? []) {
    if (!roleNames.has(rule.role)) errors.push("Unknown role in isolationRoles: " + rule.role);
    checkPerms(rule.permissions, "isolationRoles/" + rule.role);
  }
  for (const role of config.musicAllowedRoles ?? []) {
    if (!roleNames.has(role)) errors.push("Unknown role in musicAllowedRoles: " + role);
  }

  for (const c of config.categories ?? []) checkRoleSpec(c.roles, "category:" + c.name);
  for (const ch of config.channels ?? []) {
    checkRoleSpec(ch.roles, "channel:" + ch.name);
    if (ch.category && !catNames.has(ch.category)) errors.push(`Channel '${ch.name}' references unknown category '${ch.category}'`);
  }
  for (const rule of config.isolationRoles ?? [])
    for (const name of rule.onlyChannels ?? []) if (!chanNames.has(name)) errors.push("isolationRoles onlyChannels references unknown channel: " + name);

  return errors;
}

function resolveColorValue(color) {
  if (typeof color === "number") return color;
  if (typeof color === "string" && color.startsWith("#")) return parseInt(color.slice(1), 16);
  return color;
}

function resolvePermissionBits(names = []) {
  return names.map((name) => {
    const bit = PermissionsBitField.Flags[name];
    if (bit === undefined) {
      throw new Error(`Неизвестный флаг права: "${name}"`);
    }
    return bit;
  });
}

// entry is either an array of allowed perms, or { allow: [...], deny: [...] }
function buildOverwrite(entry) {
  if (Array.isArray(entry)) {
    return { allow: resolvePermissionBits(entry), deny: [] };
  }
  return {
    allow: resolvePermissionBits(entry.allow ?? []),
    deny: resolvePermissionBits(entry.deny ?? []),
  };
}

// Overwrites are collected into a Map<id, {allow:Set, deny:Set}> so the same
// target (e.g. "@everyone") can be touched both by an explicit `roles` entry
// and by botOnly logic without producing two conflicting overwrite objects.
function newOverwriteMap() {
  return new Map();
}

function mergeOverwrite(map, id, { allow = [], deny = [] }) {
  if (!map.has(id)) map.set(id, { allow: new Set(), deny: new Set() });
  const entry = map.get(id);
  for (const bit of allow) {
    entry.allow.add(bit);
    entry.deny.delete(bit);
  }
  for (const bit of deny) {
    entry.deny.add(bit);
    entry.allow.delete(bit);
  }
}

function overwriteMapToArray(map) {
  return [...map.entries()].map(([id, { allow, deny }]) => ({
    id,
    allow: [...allow],
    deny: [...deny],
  }));
}

function applyRoleSpecToMap(guild, rolesMap, roleSpec, map) {
  for (const [roleName, entry] of Object.entries(roleSpec)) {
    const roleId = roleName === "@everyone" ? guild.roles.everyone.id : rolesMap.get(roleName)?.id;
    if (!roleId) {
      console.warn(`[structure] Роль "${roleName}" не найдена, пропускаю overwrite`);
      continue;
    }
    mergeOverwrite(map, roleId, buildOverwrite(entry));
  }
}

function resolveRoleId(guild, rolesMap, roleName) {
  const id = roleName === "@everyone" ? guild.roles.everyone.id : rolesMap.get(roleName)?.id;
  if (!id) console.warn(`[structure] Роль "${roleName}" не найдена (глобальное правило), пропускаю`);
  return id;
}

// config.globalDenyRoles: { "RoleName": ["Perm", ...] } — deny these perms on
// every channel/category, e.g. Muted can never SendMessages anywhere without
// repeating the same overwrite by hand on every single channel.
function applyGlobalDenyRoles(guild, rolesMap, config, map) {
  for (const [roleName, perms] of Object.entries(config.globalDenyRoles ?? {})) {
    const roleId = resolveRoleId(guild, rolesMap, roleName);
    if (!roleId) continue;
    mergeOverwrite(map, roleId, { deny: resolvePermissionBits(perms) });
  }
}

// config.alwaysAllRoles: { "RoleName": ["Perm", ...] } — allow these perms on
// every channel/category, for staff roles that lack Administrator and would
// otherwise be locked out by the per-channel gating like everyone else.
function applyAlwaysAllRoles(guild, rolesMap, config, map) {
  for (const [roleName, perms] of Object.entries(config.alwaysAllRoles ?? {})) {
    const roleId = resolveRoleId(guild, rolesMap, roleName);
    if (!roleId) continue;
    mergeOverwrite(map, roleId, { allow: resolvePermissionBits(perms) });
  }
}

// config.isolationRoles: [{ role, onlyChannels: [...names], permissions: [...] }]
// — the named role gets `permissions` denied on every channel/category except
// the ones listed in onlyChannels, where it gets them explicitly allowed
// instead. Applied last so it can't be silently overridden by a per-channel
// `roles` entry elsewhere in the config (e.g. someone forgetting to exclude
// a jailed role from a newly added channel).
function applyIsolationRoles(guild, rolesMap, config, map, channelOrCategoryName) {
  for (const rule of config.isolationRoles ?? []) {
    const roleId = resolveRoleId(guild, rolesMap, rule.role);
    if (!roleId) continue;
    const bits = resolvePermissionBits(rule.permissions ?? []);
    const isAllowed = (rule.onlyChannels ?? []).includes(channelOrCategoryName);
    mergeOverwrite(map, roleId, isAllowed ? { allow: bits } : { deny: bits });
  }
}

const CHANNEL_TYPE_MAP = {
  text: ChannelType.GuildText,
  voice: ChannelType.GuildVoice,
  announcement: ChannelType.GuildAnnouncement,
  forum: ChannelType.GuildForum,
  stage: ChannelType.GuildStageVoice,
};

const CHANNEL_TYPE_REVERSE = Object.fromEntries(Object.entries(CHANNEL_TYPE_MAP).map(([k, v]) => [v, k]));

function isTopicError(err) {
  return err?.code === 50035 && "topic" in (err?.rawError?.errors ?? {});
}

export async function buildStructure(guild, config, { botMemberId } = {}) {
  const log = [];

  // 1. Roles — create missing ones, and sync base permissions/color/hoist/mentionable
  // on existing ones too (a role that already existed before the bot managed this
  // server keeps whatever permissions it had until build() actively overwrites them).
  const rolesMap = new Map(guild.roles.cache.map((r) => [r.name, r]));
  for (const roleDef of config.roles ?? []) {
    const payload = {
      name: roleDef.name,
      colors: roleDef.color ? { primary: resolveColorValue(roleDef.color) } : undefined,
      hoist: roleDef.hoist ?? false,
      mentionable: roleDef.mentionable ?? false,
      permissions: resolvePermissionBits(roleDef.permissions ?? []),
    };
    const existing = rolesMap.get(roleDef.name);
    if (!existing) {
      try {
        const role = await guild.roles.create({ ...payload, reason: "Создание структуры сервера из config/structure.json" });
        rolesMap.set(role.name, role);
        log.push(`Создана роль "${role.name}"`);
      } catch (err) {
        log.push(`⚠ Не удалось создать роль "${roleDef.name}": ${err.message}`);
      }
    } else {
      try {
        await existing.edit({ ...payload, reason: "Синхронизация прав из config/structure.json" });
        log.push(`Роль "${roleDef.name}" уже существует — обновил права/цвет`);
      } catch (err) {
        log.push(`⚠ Не удалось обновить роль "${roleDef.name}": ${err.message}`);
      }
    }
  }

  // 2. Categories.
  const categoriesMap = new Map(
    guild.channels.cache.filter((c) => c.type === ChannelType.GuildCategory).map((c) => [c.name, c])
  );
  for (const catDef of config.categories ?? []) {
    let category = categoriesMap.get(catDef.name);
    const map = newOverwriteMap();
    applyGlobalDenyRoles(guild, rolesMap, config, map);
    applyAlwaysAllRoles(guild, rolesMap, config, map);
    applyRoleSpecToMap(guild, rolesMap, catDef.roles ?? {}, map);
    applyIsolationRoles(guild, rolesMap, config, map, catDef.name);
    const overwrites = overwriteMapToArray(map);
    try {
      if (!category) {
        category = await guild.channels.create({
          name: catDef.name,
          type: ChannelType.GuildCategory,
          permissionOverwrites: overwrites,
          reason: "Создание структуры сервера из config/structure.json",
        });
        categoriesMap.set(category.name, category);
        log.push(`Создана категория "${category.name}"`);
      } else {
        await category.permissionOverwrites.set(overwrites);
        log.push(`Категория "${category.name}" уже существует — обновил права`);
      }
    } catch (err) {
      log.push(`⚠ Не удалось создать/обновить категорию "${catDef.name}": ${err.message}`);
    }
  }

  // 3. Channels.
  const channelsMap = new Map(
    guild.channels.cache.filter((c) => c.type !== ChannelType.GuildCategory).map((c) => [c.name, c])
  );
  for (const chDef of config.channels ?? []) {
    const type = CHANNEL_TYPE_MAP[chDef.type] ?? ChannelType.GuildText;
    const parent = chDef.category ? categoriesMap.get(chDef.category) : null;
    if (chDef.category && !parent) {
      log.push(`⚠ Категория "${chDef.category}" для канала "${chDef.name}" не найдена — создаю без категории`);
    }

    const map = newOverwriteMap();
    applyGlobalDenyRoles(guild, rolesMap, config, map);
    applyAlwaysAllRoles(guild, rolesMap, config, map);
    applyRoleSpecToMap(guild, rolesMap, chDef.roles ?? {}, map);
    if (chDef.botOnly) {
      mergeOverwrite(map, guild.roles.everyone.id, { deny: resolvePermissionBits(["SendMessages"]) });
      if (botMemberId) {
        mergeOverwrite(map, botMemberId, { allow: resolvePermissionBits(["ViewChannel", "SendMessages"]) });
      }
    }
    applyIsolationRoles(guild, rolesMap, config, map, chDef.name);
    const overwrites = overwriteMapToArray(map);

    let channel = channelsMap.get(chDef.name);
    try {
      if (!channel) {
        const createOpts = {
          name: chDef.name,
          type,
          parent: parent ?? undefined,
          topic: chDef.topic,
          permissionOverwrites: overwrites,
          reason: "Создание структуры сервера из config/structure.json",
        };
        try {
          channel = await guild.channels.create(createOpts);
        } catch (err) {
          if (chDef.topic && isTopicError(err)) {
            log.push(`⚠ Канал "${chDef.name}": Discord отклонил topic (${err.message}) — создаю без topic`);
            channel = await guild.channels.create({ ...createOpts, topic: undefined });
          } else {
            throw err;
          }
        }
        channelsMap.set(channel.name, channel);
        log.push(`Создан канал "${channel.name}"${chDef.botOnly ? " (только для бота)" : ""}`);
      } else {
        if (parent && channel.parentId !== parent.id) await channel.setParent(parent.id);
        await channel.permissionOverwrites.set(overwrites);
        log.push(`Канал "${channel.name}" уже существует — обновил права/категорию`);
      }
    } catch (err) {
      log.push(`⚠ Не удалось создать/обновить канал "${chDef.name}": ${err.message}`);
    }
  }

  return log;
}

export async function wipeStructure(guild, config = {}) {
  const log = [];
  const me = guild.members.me;
  const protectedNames = new Set(config.protectedChannels ?? []);

  const channels = [...guild.channels.cache.values()];
  for (const channel of channels) {
    if (protectedNames.has(channel.name)) {
      log.push(`⏭ Канал "${channel.name}" в защищённом списке (protectedChannels) — пропускаю`);
      continue;
    }
    try {
      await channel.delete("Полная очистка структуры сервера по запросу пользователя");
      log.push(`Удалён канал "${channel.name}"`);
    } catch (err) {
      log.push(`⚠ Не удалось удалить канал "${channel.name}": ${err.message}`);
    }
  }

  const roles = [...guild.roles.cache.values()];
  for (const role of roles) {
    if (role.id === guild.roles.everyone.id) continue; // нельзя удалить
    if (role.managed) continue; // роли интеграций/бота — управляются Discord
    if (me && role.position >= me.roles.highest.position) {
      log.push(`⚠ Роль "${role.name}" выше или равна роли бота — пропускаю`);
      continue;
    }
    try {
      await role.delete("Полная очистка структуры сервера по запросу пользователя");
      log.push(`Удалена роль "${role.name}"`);
    } catch (err) {
      log.push(`⚠ Не удалось удалить роль "${role.name}": ${err.message}`);
    }
  }

  return log;
}

// Reverse direction: read the guild's current roles/categories/channels and
// turn them into the same JSON shape config/structure.json uses.
function overwritesToRoleSpec(guild, overwriteCache, botMemberId) {
  const roles = {};
  let botOnly = false;

  for (const ow of overwriteCache.values()) {
    if (ow.type === 1) {
      // member-type overwrite — only meaningful one we track is the bot's own
      if (ow.id === botMemberId) botOnly = true;
      continue;
    }
    const roleName = ow.id === guild.roles.everyone.id ? "@everyone" : guild.roles.cache.get(ow.id)?.name;
    if (!roleName) continue;

    const allow = ow.allow.toArray();
    const deny = ow.deny.toArray();
    if (!allow.length && !deny.length) continue;

    roles[roleName] = deny.length ? { allow, deny } : allow;
  }

  // botOnly reconstructs "@everyone deny SendMessages" + bot allow on build();
  // drop that exact pair here so re-importing doesn't duplicate it.
  if (botOnly && roles["@everyone"]) {
    const everyone = roles["@everyone"];
    const deny = Array.isArray(everyone) ? [] : everyone.deny.filter((p) => p !== "SendMessages");
    const allow = Array.isArray(everyone) ? everyone : everyone.allow;
    if (!deny.length && !allow.length) delete roles["@everyone"];
    else roles["@everyone"] = deny.length ? { allow, deny } : allow;
  }

  return { roles, botOnly };
}

export function exportStructure(guild, { botMemberId } = {}) {
  const roles = [...guild.roles.cache.values()]
    .filter((r) => r.id !== guild.roles.everyone.id && !r.managed)
    .sort((a, b) => b.position - a.position)
    .map((r) => ({
      name: r.name,
      color: `#${r.color.toString(16).padStart(6, "0")}`,
      hoist: r.hoist,
      mentionable: r.mentionable,
      permissions: r.permissions.toArray(),
    }));

  const categories = [...guild.channels.cache.values()]
    .filter((c) => c.type === ChannelType.GuildCategory)
    .sort((a, b) => a.position - b.position)
    .map((c) => {
      const { roles: roleSpec } = overwritesToRoleSpec(guild, c.permissionOverwrites.cache, botMemberId);
      const entry = { name: c.name };
      if (Object.keys(roleSpec).length) entry.roles = roleSpec;
      return entry;
    });

  const channels = [...guild.channels.cache.values()]
    .filter((c) => c.type !== ChannelType.GuildCategory && CHANNEL_TYPE_REVERSE[c.type])
    .sort((a, b) => a.position - b.position)
    .map((c) => {
      const { roles: roleSpec, botOnly } = overwritesToRoleSpec(guild, c.permissionOverwrites.cache, botMemberId);
      const entry = { name: c.name, type: CHANNEL_TYPE_REVERSE[c.type] };
      const parent = c.parentId ? guild.channels.cache.get(c.parentId) : null;
      if (parent) entry.category = parent.name;
      if (c.topic) entry.topic = c.topic;
      if (botOnly) entry.botOnly = true;
      if (Object.keys(roleSpec).length) entry.roles = roleSpec;
      return entry;
    });

  return { roles, categories, channels };
}
