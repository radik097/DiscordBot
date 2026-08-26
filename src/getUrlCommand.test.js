import { describe, expect, test } from "bun:test";
import { MessageFlags } from "discord.js";
import { BOT_OPERATOR_ROLE_NAME } from "./commands/phone.js";
import { data, execute } from "./commands/get-url.js";
import { registerAccessControl, unregisterAccessControl } from "./web/accessControlRegistry.js";

function interaction(roleNames = [BOT_OPERATOR_ROLE_NAME], email = "guest@example.com") {
  const client = {};
  const replies = [];
  const deferred = [];
  const edits = [];
  return {
    client,
    guild: { roles: { cache: new Map() } },
    member: { roles: { cache: roleNames.map((name) => ({ name })) } },
    user: { id: "42", tag: "operator#0001" },
    options: { getString: () => email },
    reply: async (value) => { replies.push(value); return value; },
    deferReply: async (value) => { deferred.push(value); return value; },
    editReply: async (value) => { edits.push(value); return value; },
    replies,
    deferred,
    edits,
  };
}

describe("/get-url", () => {
  test("registers the requested slash command and email option", () => {
    expect(data.name).toBe("get-url");
    expect(data.options[0].name).toBe("email");
    expect(data.options[0].required).toBe(true);
  });

  test("denies users without the operator role", async () => {
    const i = interaction(["Administrator"]);
    await execute(i);
    expect(i.replies[0].flags).toBe(MessageFlags.Ephemeral);
    expect(i.replies[0].content).toContain(BOT_OPERATOR_ROLE_NAME);
  });

  test("returns an ephemeral email-bound one-day link", async () => {
    const i = interaction();
    registerAccessControl(i.client, {
      issueInvite(email, kind, actor) {
        expect(email).toBe("guest@example.com");
        expect(kind).toBe("day");
        expect(actor).toBe("discord:42");
        return {
          email,
          url: "https://discord.example.com/access/invite?token=secret",
          expiresAt: Date.now() + 86_400_000,
        };
      },
    });
    try {
      await execute(i);
      expect(i.deferred[0].flags).toBe(MessageFlags.Ephemeral);
      expect(i.edits[0].content).toContain("guest@example.com");
      expect(i.edits[0].content).toContain("24 часа");
    } finally {
      unregisterAccessControl(i.client);
    }
  });
});
