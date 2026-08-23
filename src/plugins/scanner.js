import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { PluginValidationError, validatePluginManifest, verifyPluginSignature } from "./manifest.js";

const NATIVE_EXTENSIONS = new Set([".dll", ".dylib", ".exe", ".node", ".so"]);
const DEPENDENCY_ARTIFACTS = new Set(["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"]);
const FORBIDDEN_JS = [
  [/\bprocess\s*\.\s*env\b/, "process.env"],
  [/\bBun\s*\.\s*(?:spawn|spawnSync|shell)\b/, "Bun process API"],
  [/(?:from\s*|import\s*(?:\(|)|require\s*\()\s*["'](?:node:)?(?:child_process|cluster|dgram|fs|net|tls|worker_threads|vm|bun:sqlite)["']/, "privileged import"],
];

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function pluginScanLimits(env = process.env) {
  return {
    maxFiles: positiveInteger(env.PLUGIN_MAX_FILES, 512),
    maxPackageBytes: positiveInteger(env.PLUGIN_MAX_PACKAGE_BYTES, 50 * 1024 * 1024),
    maxUnpackedBytes: positiveInteger(env.PLUGIN_MAX_UNPACKED_BYTES, 200 * 1024 * 1024),
  };
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function collectFiles(root, limits) {
  const canonicalRoot = await realpath(root);
  const files = [];
  let totalBytes = 0;

  async function walk(directory, relativeDirectory = "") {
    for (const name of await readdir(directory)) {
      const fullPath = path.join(directory, name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const stat = await lstat(fullPath);
      if (stat.isSymbolicLink()) {
        throw new PluginValidationError(`Симлинки запрещены: ${relativePath}`, "SYMLINK_FORBIDDEN");
      }
      const canonical = await realpath(fullPath);
      if (!isWithin(canonicalRoot, canonical)) {
        throw new PluginValidationError(`Путь выходит за пределы пакета: ${relativePath}`, "PATH_TRAVERSAL");
      }
      if (stat.isDirectory()) {
        if (relativePath.split("/").includes("node_modules")) {
          throw new PluginValidationError("node_modules внутри пакета запрещён", "DEPENDENCIES_FORBIDDEN");
        }
        await walk(fullPath, relativePath);
        continue;
      }
      if (!stat.isFile()) throw new PluginValidationError(`Неподдерживаемый тип файла: ${relativePath}`);
      files.push({ path: relativePath, fullPath, bytes: stat.size });
      totalBytes += stat.size;
      if (files.length > limits.maxFiles) throw new PluginValidationError("Превышен лимит числа файлов", "FILE_COUNT_LIMIT");
      if (totalBytes > limits.maxUnpackedBytes) throw new PluginValidationError("Превышен лимит распакованного размера", "UNPACKED_SIZE_LIMIT");
    }
  }

  await walk(canonicalRoot);
  return { files, totalBytes };
}

async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function inspectJavaScript(file, manifest) {
  if (![".js", ".mjs", ".cjs"].includes(path.extname(file.path).toLowerCase())) return [];
  const source = await readFile(file.fullPath, "utf8");
  const findings = [];
  for (const [pattern, label] of FORBIDDEN_JS) {
    if (pattern.test(source)) findings.push({ file: file.path, rule: label });
  }
  if (!manifest.permissions.includes("network.egress") && /\bfetch\s*\(/.test(source)) {
    findings.push({ file: file.path, rule: "network without capability" });
  }
  return findings;
}

export async function scanPluginDirectory(root, {
  limits = pluginScanLimits(),
  publicKeys = {},
  declaredPackageBytes = 0,
} = {}) {
  if (declaredPackageBytes > limits.maxPackageBytes) {
    throw new PluginValidationError("Архив превышает лимит размера", "PACKAGE_SIZE_LIMIT");
  }
  const inventory = await collectFiles(root, limits);
  const byPath = new Map(inventory.files.map((file) => [file.path, file]));
  const manifestFile = byPath.get("plugin.json");
  if (!manifestFile) throw new PluginValidationError("В корне пакета отсутствует plugin.json");

  let sourceManifest;
  try {
    sourceManifest = JSON.parse(await readFile(manifestFile.fullPath, "utf8"));
  } catch {
    throw new PluginValidationError("plugin.json содержит некорректный JSON");
  }
  const manifest = validatePluginManifest(sourceManifest);

  for (const file of inventory.files) {
    const extension = path.extname(file.path).toLowerCase();
    if (NATIVE_EXTENSIONS.has(extension) || /\.so(?:\.|$)/i.test(file.path)) {
      throw new PluginValidationError(`Native binary запрещён: ${file.path}`, "NATIVE_BINARY_FORBIDDEN");
    }
    if (DEPENDENCY_ARTIFACTS.has(path.basename(file.path))) {
      throw new PluginValidationError(`Lockfile/dependency bundle запрещён: ${file.path}`, "DEPENDENCIES_FORBIDDEN");
    }
  }

  const packageFiles = inventory.files.filter((file) => file.path !== "plugin.json");
  for (const file of packageFiles) {
    if (!manifest.hashes[file.path]) {
      throw new PluginValidationError(`Файл не покрыт hashes: ${file.path}`, "HASH_COVERAGE_INCOMPLETE");
    }
    const digest = await sha256(file.fullPath);
    if (digest !== manifest.hashes[file.path]) {
      throw new PluginValidationError(`SHA-256 не совпадает: ${file.path}`, "HASH_MISMATCH");
    }
  }
  for (const declared of Object.keys(manifest.hashes)) {
    if (!byPath.has(declared)) {
      throw new PluginValidationError(`hashes ссылается на отсутствующий файл: ${declared}`, "HASH_FILE_MISSING");
    }
  }
  if (!byPath.has(manifest.entry)) throw new PluginValidationError("entry отсутствует в пакете", "ENTRY_MISSING");
  if (manifest.ui && !byPath.has(manifest.ui.entry)) throw new PluginValidationError("ui.entry отсутствует в пакете", "ENTRY_MISSING");
  if (manifest.runtime === "wasi") {
    const header = (await readFile(byPath.get(manifest.entry).fullPath)).subarray(0, 4);
    if (!header.equals(Buffer.from([0x00, 0x61, 0x73, 0x6d]))) {
      throw new PluginValidationError("WASI entry не содержит WebAssembly magic header", "WASM_INVALID");
    }
  }

  const forbiddenApis = (await Promise.all(packageFiles.map((file) => inspectJavaScript(file, manifest)))).flat();
  if (forbiddenApis.length) {
    const first = forbiddenApis[0];
    throw new PluginValidationError(`Запрещённый JS API (${first.rule}) в ${first.file}`, "FORBIDDEN_API");
  }

  const signature = verifyPluginSignature(manifest, publicKeys);
  return {
    state: "permission_review",
    manifest,
    signature,
    inventory: {
      files: inventory.files.length,
      unpackedBytes: inventory.totalBytes,
      paths: inventory.files.map((file) => file.path).sort(),
    },
    scannedAt: Date.now(),
  };
}
