import { afterEach, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalManifestPayload, validatePluginManifest } from "./manifest.js";
import { PluginRegistry } from "./registry.js";
import { scanPluginDirectory } from "./scanner.js";
import { loadTrustedPluginKeys } from "./trustedKeys.js";

const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix = "plugin-test-") {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}

function baseManifest(overrides = {}) {
  return {
    id: "example.echo",
    version: "1.0.0",
    apiVersion: "1",
    runtime: "wasi",
    entry: "plugin.wasm",
    permissions: ["discord.commands", "storage.kv"],
    commands: ["echo"],
    events: [],
    routes: [],
    jobs: [],
    tools: [],
    ui: null,
    hashes: {},
    signature: null,
    ...overrides,
  };
}

async function writeWasiPackage(root, { extraFiles = {}, manifestOverrides = {} } = {}) {
  const wasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  const files = { "plugin.wasm": wasm, ...extraFiles };
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), content);
  }
  const hashes = Object.fromEntries(Object.entries(files).map(([relative, content]) => [relative, digest(content)]));
  const manifest = baseManifest({ hashes, ...manifestOverrides });
  await writeFile(path.join(root, "plugin.json"), JSON.stringify(manifest));
  return manifest;
}

async function writeTrustedPackage(root, source, { permissions = ["discord.commands"] } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  await writeFile(path.join(root, "index.js"), source);
  const unsigned = baseManifest({
    runtime: "trusted-js",
    entry: "index.js",
    permissions,
    hashes: { "index.js": digest(source) },
    signature: { algorithm: "Ed25519", keyId: "official-test", value: "AA==" },
  });
  const normalized = validatePluginManifest(unsigned);
  unsigned.signature.value = sign(null, canonicalManifestPayload(normalized), privateKey).toString("base64");
  await writeFile(path.join(root, "plugin.json"), JSON.stringify(unsigned));
  return { publicKey: publicKey.export({ type: "spki", format: "pem" }) };
}

describe("plugin quarantine scanner", () => {
  test("accepts a hashed WASI package only for permission review", async () => {
    const root = await temporaryDirectory();
    await writeWasiPackage(root);
    const result = await scanPluginDirectory(root);
    expect(result.state).toBe("permission_review");
    expect(result.signature).toEqual({ verified: false, keyId: null, reason: "unsigned" });
    expect(result.inventory.paths).toEqual(["plugin.json", "plugin.wasm"]);
  });

  test("persists a scan record without enabling the plugin", async () => {
    const root = await temporaryDirectory("plugin-registry-");
    const registry = new PluginRegistry({ root });
    const uploadId = registry.createUploadId();
    const packageRoot = path.join(registry.uploadPath(uploadId), "package");
    await mkdir(packageRoot, { recursive: true });
    await writeWasiPackage(packageRoot);

    const record = await registry.scanQuarantined(uploadId);
    const saved = JSON.parse(await readFile(path.join(registry.uploadPath(uploadId), "scan.json"), "utf8"));
    expect(record.state).toBe("permission_review");
    expect(saved.plugin.id).toBe("example.echo");
    expect((await registry.listQuarantined())[0].state).toBe("permission_review");
  });

  test("rejects manifest path traversal and quarantine id traversal", async () => {
    expect(() => validatePluginManifest(baseManifest({ entry: "../plugin.wasm", hashes: { "../plugin.wasm": "a".repeat(64) } })))
      .toThrow("пределы пакета");
    const registry = new PluginRegistry({ root: await temporaryDirectory() });
    expect(() => registry.uploadPath("../../outside")).toThrow("upload id");
  });

  test("rejects symlinks before hash review", async () => {
    const root = await temporaryDirectory();
    await writeWasiPackage(root);
    await symlink(path.join(root, "plugin.wasm"), path.join(root, "linked.wasm"));
    await expect(scanPluginDirectory(root)).rejects.toMatchObject({ code: "SYMLINK_FORBIDDEN" });
  });

  test("enforces package and unpacked size limits", async () => {
    const root = await temporaryDirectory();
    await writeWasiPackage(root);
    await expect(scanPluginDirectory(root, {
      declaredPackageBytes: 11,
      limits: { maxFiles: 10, maxPackageBytes: 10, maxUnpackedBytes: 10_000 },
    })).rejects.toMatchObject({ code: "PACKAGE_SIZE_LIMIT" });
    await expect(scanPluginDirectory(root, {
      limits: { maxFiles: 10, maxPackageBytes: 10_000, maxUnpackedBytes: 5 },
    })).rejects.toMatchObject({ code: "UNPACKED_SIZE_LIMIT" });
  });

  test("rejects native binaries and incomplete hash coverage", async () => {
    const nativeRoot = await temporaryDirectory();
    await writeWasiPackage(nativeRoot, { extraFiles: { "addon.node": "native" } });
    await expect(scanPluginDirectory(nativeRoot)).rejects.toMatchObject({ code: "NATIVE_BINARY_FORBIDDEN" });

    const uncoveredRoot = await temporaryDirectory();
    await writeWasiPackage(uncoveredRoot);
    await writeFile(path.join(uncoveredRoot, "extra.txt"), "not declared");
    await expect(scanPluginDirectory(uncoveredRoot)).rejects.toMatchObject({ code: "HASH_COVERAGE_INCOMPLETE" });
  });

  test("rejects changed content and invalid WASM", async () => {
    const changedRoot = await temporaryDirectory();
    await writeWasiPackage(changedRoot);
    await writeFile(path.join(changedRoot, "plugin.wasm"), "changed");
    await expect(scanPluginDirectory(changedRoot)).rejects.toMatchObject({ code: "HASH_MISMATCH" });

    const invalidRoot = await temporaryDirectory();
    await writeWasiPackage(invalidRoot, { extraFiles: {}, manifestOverrides: { hashes: { "plugin.wasm": digest("not-wasm") } } });
    await writeFile(path.join(invalidRoot, "plugin.wasm"), "not-wasm");
    await expect(scanPluginDirectory(invalidRoot)).rejects.toMatchObject({ code: "WASM_INVALID" });
  });

  test("requires a valid Ed25519 signature for trusted JavaScript", async () => {
    expect(() => validatePluginManifest(baseManifest({
      runtime: "trusted-js",
      entry: "index.js",
      hashes: { "index.js": "a".repeat(64) },
    }))).toThrow("подпись");

    const root = await temporaryDirectory();
    const { publicKey } = await writeTrustedPackage(root, "export default () => 'ok';");
    const result = await scanPluginDirectory(root, { publicKeys: { "official-test": publicKey } });
    expect(result.signature).toEqual({ verified: true, keyId: "official-test", reason: null });
  });

  test("rejects privileged APIs even in a correctly signed package", async () => {
    const root = await temporaryDirectory();
    const { publicKey } = await writeTrustedPackage(root, "import 'node:fs'; export default 1;");
    await expect(scanPluginDirectory(root, { publicKeys: { "official-test": publicKey } }))
      .rejects.toMatchObject({ code: "FORBIDDEN_API" });
  });

  test("loads trusted public keys from an external local JSON file", async () => {
    const root = await temporaryDirectory();
    const { publicKey } = generateKeyPairSync("ed25519");
    const filePath = path.join(root, "keys.json");
    await writeFile(filePath, JSON.stringify({
      "official-test": publicKey.export({ type: "spki", format: "pem" }),
    }));
    const keys = await loadTrustedPluginKeys({ filePath, allowMissing: false });
    expect(keys["official-test"]).toContain("BEGIN PUBLIC KEY");
  });
});
