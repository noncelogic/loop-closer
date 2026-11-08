import { createServer as createHttpServer, type Server } from "node:http";

export const SERVICE_NAME = "loopcloser";

/** HTTP surface of the loopcloser service. Only a health probe exists so far. */
export function createServer(): Server {
  return createHttpServer((req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ service: SERVICE_NAME, status: "ok" }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
}
