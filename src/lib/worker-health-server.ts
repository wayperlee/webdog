import { createServer, type Server } from "node:http";

/** Internal container port; the public Cloudflare router never forwards to it. */
export async function startWorkerHealthServer(port: number, check: () => Promise<void>): Promise<Server> {
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    if (request.method !== "GET" || request.url !== "/health") {
      response.writeHead(404).end(JSON.stringify({ ok: false }));
      return;
    }
    void check().then(() => {
      response.writeHead(200).end(JSON.stringify({ ok: true }));
    }).catch(() => {
      response.writeHead(503).end(JSON.stringify({ ok: false }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => reject(error);
    server.once("error", failed);
    server.listen(port, "0.0.0.0", () => { server.removeListener("error", failed); resolve(); });
  });
  return server;
}

export async function closeWorkerHealthServer(server: Server) {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
