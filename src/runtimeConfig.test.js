import { describe, expect, test } from "bun:test";
import { resolveRuntimeConfig } from "./runtimeConfig.js";

describe("runtime deployment configuration", () => {
  test("uses ngrok for local mode by default", () => {
    expect(resolveRuntimeConfig({ DEPLOYMENT_MODE: "local" })).toEqual({
      deploymentMode: "local",
      remoteProvider: "ngrok",
      publicBaseUrl: "",
    });
  });

  test("uses Cloudflare for server mode and normalizes the public origin", () => {
    expect(resolveRuntimeConfig({
      DEPLOYMENT_MODE: "server",
      PUBLIC_BASE_URL: "https://panel.example.com/ignored/path",
    })).toEqual({
      deploymentMode: "server",
      remoteProvider: "cloudflare",
      publicBaseUrl: "https://panel.example.com",
    });
  });

  test("requires a public URL for Cloudflare mode", () => {
    expect(() => resolveRuntimeConfig({ DEPLOYMENT_MODE: "server" })).toThrow("PUBLIC_BASE_URL");
  });

  test("rejects unsupported modes and insecure public URLs", () => {
    expect(() => resolveRuntimeConfig({ DEPLOYMENT_MODE: "production" })).toThrow("DEPLOYMENT_MODE");
    expect(() => resolveRuntimeConfig({
      DEPLOYMENT_MODE: "server",
      PUBLIC_BASE_URL: "http://panel.example.com",
    })).toThrow("HTTPS");
  });
});
