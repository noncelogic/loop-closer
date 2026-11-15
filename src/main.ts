import type { AddressInfo } from "node:net";
import { API_KEYS_DIR, loadApiKeys, loadConfig } from "./config.ts";
import { createServer, SERVICE_NAME } from "./server.ts";

const config = loadConfig();
const apiKeys = loadApiKeys();
if (apiKeys.size === 0) console.warn(`no API keys under ${API_KEYS_DIR}: every /v1 call will be refused`);
const server = createServer({ apiKeys });

server.listen(config.port, config.host, () => {
  const { address, port } = server.address() as AddressInfo;
  console.log(`${SERVICE_NAME} listening on http://${address}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
  });
}
