import { describe, expect, test } from "bun:test";
import { canUseTranscription, createTranscribeCommand } from "./commands/transcribe.js";

function interaction({ roles = [], admin = false } = {}) {
  return {
    member: {
      permissions: { has: () => admin },
      roles: { cache: roles.map((name) => ({ name })) },
    },
  };
}

describe("/transcribe", () => {
  test("allows only Administrator or Ботоводство", () => {
    expect(canUseTranscription(interaction({ roles: ["БОТОВОДСТВО"] }))).toBe(true);
    expect(canUseTranscription(interaction({ admin: true }))).toBe(true);
    expect(canUseTranscription(interaction({ roles: ["Участник"] }))).toBe(false);
  });

  test("registers lifecycle and TXT/SRT export subcommands", () => {
    const json = createTranscribeCommand({}).data.toJSON();
    expect(json.options.map((option) => option.name)).toEqual(["start", "status", "stop", "export", "delete"]);
    const exportCommand = json.options.find((option) => option.name === "export");
    expect(exportCommand.options.find((option) => option.name === "format").choices.map((choice) => choice.value)).toEqual(["txt", "srt"]);
    const startCommand = json.options.find((option) => option.name === "start");
    const modelValues = startCommand.options.find((option) => option.name === "model").choices.map((choice) => choice.value);
    expect(modelValues).toContain("local:small");
    expect(modelValues).toContain("openai:gpt-4o-mini-transcribe");
    expect(modelValues).toContain("mistral:voxtral-mini-latest");
    expect(modelValues).toContain("mistral:voxtral-mini-transcribe-realtime-2602");
  });
});
