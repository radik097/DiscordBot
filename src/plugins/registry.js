import { mkdir, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { PluginValidationError } from "./manifest.js";
import { scanPluginDirectory } from "./scanner.js";

const UPLOAD_ID = /^[a-z0-9][a-z0-9-]{5,79}$/;

function defaultRoot() {
  return process.env.PLUGINS_ROOT || new URL("../../plugins/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

export class PluginRegistry {
  constructor({ root = defaultRoot(), publicKeys = {} } = {}) {
    this.root = path.resolve(root);
    this.publicKeys = publicKeys;
    this.quarantineRoot = path.join(this.root, "quarantine");
  }

  async initialize() {
    await mkdir(this.quarantineRoot, { recursive: true });
    await mkdir(path.join(this.root, "approved"), { recursive: true });
    await mkdir(path.join(this.root, "disabled"), { recursive: true });
  }

  createUploadId() {
    return `upload-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
  }

  uploadPath(uploadId) {
    if (!UPLOAD_ID.test(uploadId)) throw new PluginValidationError("Некорректный upload id", "UPLOAD_ID_INVALID");
    return path.join(this.quarantineRoot, uploadId);
  }

  async scanQuarantined(uploadId, options = {}) {
    await this.initialize();
    const uploadRoot = this.uploadPath(uploadId);
    const packageRoot = path.join(uploadRoot, "package");
    let canonicalPackage;
    try {
      canonicalPackage = await realpath(packageRoot);
    } catch {
      throw new PluginValidationError("Пакет не найден в карантине", "QUARANTINE_PACKAGE_MISSING");
    }
    const relative = path.relative(await realpath(this.quarantineRoot), canonicalPackage);
    if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
      throw new PluginValidationError("Пакет выходит за пределы карантина", "PATH_TRAVERSAL");
    }

    const result = await scanPluginDirectory(canonicalPackage, {
      publicKeys: this.publicKeys,
      ...options,
    });
    const record = {
      schemaVersion: 1,
      uploadId,
      state: result.state,
      plugin: { id: result.manifest.id, version: result.manifest.version, runtime: result.manifest.runtime },
      permissions: result.manifest.permissions,
      signature: result.signature,
      inventory: result.inventory,
      scannedAt: result.scannedAt,
    };
    const temporary = path.join(uploadRoot, `scan.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    const destination = path.join(uploadRoot, "scan.json");
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, destination);
    return record;
  }

  async listQuarantined() {
    await this.initialize();
    const records = [];
    for (const uploadId of await readdir(this.quarantineRoot)) {
      if (!UPLOAD_ID.test(uploadId)) continue;
      try {
        records.push(JSON.parse(await readFile(path.join(this.uploadPath(uploadId), "scan.json"), "utf8")));
      } catch {
        records.push({ schemaVersion: 1, uploadId, state: "quarantined" });
      }
    }
    return records.sort((a, b) => a.uploadId.localeCompare(b.uploadId));
  }
}
