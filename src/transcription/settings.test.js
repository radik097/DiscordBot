import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TranscriptionSettings } from "./settings.js";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(env = {}) {
  const root = mkdtempSync(join(tmpdir(), "transcription-settings-"));
  roots.push(root);
  return {
    root,
    path: join(root, "settings.json"),
    keyPath: join(root, "settings.key"),
    env,
  };
}

describe("transcription model settings", () => {
  test("encrypts panel keys and never returns their plaintext", () => {
    const options = fixture();
    const settings = new TranscriptionSettings(options);
    const view = settings.update({
      provider: "openai", model: "gpt-4o-mini-transcribe",
      keys: { openai: "sk-private-example-1234" },
    });
    expect(view.keys.openai).toEqual({ configured: true, source: "panel", masked: "••••1234" });
    expect(JSON.stringify(view)).not.toContain("sk-private");
    expect(readFileSync(options.path, "utf8")).not.toContain("sk-private");
    expect(new TranscriptionSettings(options).resolve()).toMatchObject({
      provider: "openai", model: "gpt-4o-mini-transcribe", apiKey: "sk-private-example-1234",
    });
  });

  test("supports environment keys, clearing saved keys and strict model pairing", () => {
    const options = fixture({ MISTRAL_API_KEY: "mistral-environment-key" });
    const settings = new TranscriptionSettings(options);
    expect(settings.update({ provider: "mistral", model: "voxtral-mini-latest" }).keys.mistral.source).toBe("environment");
    expect(settings.resolve()).toMatchObject({ apiKey: "mistral-environment-key" });
    expect(() => settings.update({ provider: "mistral", model: "small" })).toThrow("недоступна");
  });
});
