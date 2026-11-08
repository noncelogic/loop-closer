import type { AddressInfo } from "node:net";
import { loadConfig } from "./config.ts";
import { createServer, SERVICE_NAME } from "./server.ts";

const config = loadConfig();
const server = createServer();

server.listen(config.port, config.host, () => {
  const { address, port } = server.address() as AddressInfo;
  console.log(`${SERVICE_NAME} listening on http://${address}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
  });
}
