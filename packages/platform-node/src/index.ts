import type { Server } from "node:http";
import type { HttpAdapter, RequestHandler } from "@mini-nest/common";
import { createHttpServer } from "./node-server.js";

export class NodeAdapter implements HttpAdapter<Server> {
  private server?: Server;

  async listen(handler: RequestHandler, port: number, hostname = "0.0.0.0"): Promise<Server> {
    if (this.server) throw new Error("Adapter is already listening.");
    const server = createHttpServer(handler);
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, hostname);
      });
      server.on("error", (error) => {
        console.error("HTTP server error", error);
      });
      return server;
    } catch (error) {
      this.server = undefined;
      throw error;
    }
  }

  getHttpServer(): Server {
    if (!this.server) throw new Error("Adapter is not listening.");
    return this.server;
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    this.server = undefined;
  }
}
