import { describe, expect, test } from "bun:test";
import { PermissionFlagsBits } from "discord.js";
import { canUseMusicCommands } from "./commands/music.js";

function interactionWithRoles(roleNames, { administrator = false } = {}) {
  return {
    guild: { roles: { cache: new Map() } },
    member: {
      permissions: { has: (permission) => permission === PermissionFlagsBits.Administrator && administrator },
      roles: { cache: roleNames.map((name) => ({ name })) },
    },
  };
}

describe("music command access", () => {
  test("allows the Ботоводство role even when musicAllowedRoles is empty", () => {
    expect(canUseMusicCommands(interactionWithRoles(["Ботоводство"]), { musicAllowedRoles: [] })).toBe(true);
    expect(canUseMusicCommands(interactionWithRoles(["ботоводство"]), { musicAllowedRoles: [] })).toBe(true);
  });

  test("keeps administrator and configured music-role access", () => {
    expect(canUseMusicCommands(interactionWithRoles([], { administrator: true }), { musicAllowedRoles: [] })).toBe(true);
    expect(canUseMusicCommands(interactionWithRoles(["DJ"]), { musicAllowedRoles: ["DJ"] })).toBe(true);
  });

  test("denies a member without an allowed role", () => {
    expect(canUseMusicCommands(interactionWithRoles(["Участник"]), { musicAllowedRoles: [] })).toBe(false);
  });
});
