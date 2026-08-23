import { PluginRegistry } from "./registry.js";
import { loadTrustedPluginKeys } from "./trustedKeys.js";

const uploadId = process.argv[2];
if (!uploadId) {
  console.error("Использование: bun run src/plugins/scan-cli.js <upload-id>");
  process.exit(2);
}

try {
  const registry = new PluginRegistry({ publicKeys: await loadTrustedPluginKeys() });
  const result = await registry.scanQuarantined(uploadId);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`[plugin-scan] ${error.code || "SCAN_FAILED"}: ${error.message}`);
  process.exit(1);
}
