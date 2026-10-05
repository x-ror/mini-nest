import type { Type, HttpAdapter } from "@mini-nest/common";
import { Application } from "./application.js";
import { Container } from "./di/container.js";

export class NestFactory {
  static async create<TServer = unknown>(
    rootModule: Type,
    adapter?: HttpAdapter<TServer>,
  ): Promise<Application<TServer>> {
    const app = new Application(adapter);
    for (const controller of new Container().createControllers(rootModule)) {
      app.register(controller);
    }
    return app;
  }
}
