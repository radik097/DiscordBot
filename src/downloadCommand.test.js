import { describe, expect, test } from "bun:test";
import { PermissionFlagsBits } from "discord.js";
import { canUseDownload, createDownloadCommand } from "./commands/download.js";

function interaction({ roles = [], admin = false, attachmentSizeLimit = 10_000, format = "video", quality = "1080" } = {}) {
  const calls = [];
  return {
    guild: { roles: { cache: new Map() } }, guildId: "guild", channelId: "channel",
    user: { id: "user", tag: "User#0001" }, attachmentSizeLimit,
    memberPermissions: { has: (permission) => admin && permission === PermissionFlagsBits.Administrator },
    member: { roles: { cache: { some: (fn) => roles.some((name) => fn({ name })) } } },
    options: { getString: (name) => ({ url: "https://youtube.com/watch?v=abc", format, quality })[name] ?? null },
    reply: async (payload) => calls.push(["reply", payload]),
    deferReply: async (payload) => calls.push(["defer", payload]),
    editReply: async (payload) => calls.push(["edit", payload]),
    calls,
  };
}

describe("/download access", () => {
  test("allows configured role case-insensitively and Administrator", () => {
    expect(canUseDownload(interaction({ roles: ["БОТОВОДСТВО"] }), { downloadAllowedRoles: ["Ботоводство"] })).toBe(true);
    expect(canUseDownload(interaction({ admin: true }), { downloadAllowedRoles: [] })).toBe(true);
  });

  test("denies members without an allowed role", () => {
    expect(canUseDownload(interaction({ roles: ["Участник"] }), { downloadAllowedRoles: ["Ботоводство"] })).toBe(false);
  });

  test("uploads a small result and removes its temporary file", async () => {
    const removed = [];
    let request;
    const service = {
      run: async (value) => {
        request = value;
        return { id: "job", path: "C:/tmp/clip.mp4", filename: "clip.mp4", size: 9000, itemCount: 1 };
      },
      remove: (path) => removed.push(path),
    };
    const command = createDownloadCommand(service, () => ({ downloadAllowedRoles: ["Ботоводство"] }));
    const i = interaction({ roles: ["Ботоводство"], attachmentSizeLimit: 10_000 });
    await command.execute(i);
    expect(i.calls.map(([name]) => name)).toEqual(["defer", "edit"]);
    expect(i.calls[1][1].files[0].name).toBe("clip.mp4");
    expect(removed).toEqual(["C:/tmp/clip.mp4"]);
    expect(request).toMatchObject({ format: "video", quality: "1080" });
  });

  test("registers explicit video format and quality choices", () => {
    const command = createDownloadCommand({}, () => ({}));
    const json = command.data.toJSON();
    expect(json.options.find((option) => option.name === "format").choices.map((choice) => choice.value)).toEqual(["video", "audio"]);
    expect(json.options.find((option) => option.name === "quality").choices.map((choice) => choice.value)).toContain("2160");
  });

  test("creates a temporary link above the interaction attachment limit", async () => {
    const service = {
      run: async () => ({ id: "job", path: "C:/tmp/clip.mp4", filename: "clip.mp4", size: 10001, itemCount: 1 }),
      createPublicLink: () => ({ url: "https://panel.example/downloads/token/clip.mp4", expiresAt: 2_000_000_000_000 }),
    };
    const command = createDownloadCommand(service, () => ({ downloadAllowedRoles: ["Ботоводство"] }));
    const i = interaction({ roles: ["Ботоводство"], attachmentSizeLimit: 10_000 });
    await command.execute(i);
    expect(i.calls[1][1].content).toContain("https://panel.example/downloads/token/clip.mp4");
  });
});
