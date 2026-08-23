import { describe, expect, test } from "bun:test";
import { MessageFlags } from "discord.js";
import { BOT_OPERATOR_ROLE_NAME, data, execute, hasBotOperatorRole } from "./commands/phone.js";
import { registerRemoteAccess, unregisterRemoteAccess } from "./web/remoteAccessRegistry.js";

function interactionWithRoles(roleNames, overrides = {}) {
  const replies = [];
  const deferred = [];
  const edits = [];
  const client = {};
  return {
    client,
    guild: { roles: { cache: new Map() } },
    member: { roles: { cache: roleNames.map((name, index) => ({ id: String(index + 1), name })) } },
    user: { id: "42", tag: "operator#0001" },
    reply: async (payload) => { replies.push(payload); return payload; },
    deferReply: async (payload) => { deferred.push(payload); return payload; },
    editReply: async (payload) => { edits.push(payload); return payload; },
    replies,
    deferred,
    edits,
    ...overrides,
  };
}

describe("/phone", () => {
  test("is registered as a guild-only command", () => {
    expect(data.toJSON()).toMatchObject({ name: "phone", dm_permission: false });
  });

  test("recognizes the Ботовод role case-insensitively", () => {
    expect(hasBotOperatorRole(interactionWithRoles(["ботовод"]))).toBe(true);
    expect(hasBotOperatorRole(interactionWithRoles(["Administrator"]))).toBe(false);
  });

  test("denies everyone without the Ботовод role and does not issue a link", async () => {
    const interaction = interactionWithRoles(["Administrator"]);
    let starts = 0;
    registerRemoteAccess(interaction.client, { start: async () => { starts += 1; } });
    try {
      await execute(interaction);
      expect(starts).toBe(0);
      expect(interaction.deferred).toHaveLength(0);
      expect(interaction.replies).toHaveLength(1);
      expect(interaction.replies[0].flags).toBe(MessageFlags.Ephemeral);
      expect(interaction.replies[0].content).toContain(BOT_OPERATOR_ROLE_NAME);
    } finally {
      unregisterRemoteAccess(interaction.client);
    }
  });

  test("sends a fresh pairing URL only in an ephemeral response", async () => {
    const interaction = interactionWithRoles([BOT_OPERATOR_ROLE_NAME]);
    registerRemoteAccess(interaction.client, {
      start: async () => ({
        connectUrl: "https://panel.example/connect?token=one-time-token",
        pairExpiresAt: 1_800_000_000_000,
      }),
    });
    try {
      await execute(interaction);
      expect(interaction.replies).toHaveLength(0);
      expect(interaction.deferred).toEqual([{ flags: MessageFlags.Ephemeral }]);
      expect(interaction.edits).toHaveLength(1);
      expect(interaction.edits[0].content).toContain("https://panel.example/connect?token=one-time-token");
      expect(interaction.edits[0].content).toContain("только один раз");
    } finally {
      unregisterRemoteAccess(interaction.client);
    }
  });
});
