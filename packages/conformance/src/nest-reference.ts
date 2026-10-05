import "reflect-metadata";
import * as common from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Server } from "node:http";
import { createFixture } from "./fixture.js";

export async function createReference() {
  const app = await NestFactory.create(createFixture(common), {
    logger: false,
    abortOnError: false,
  });
  try {
    await app.listen(0, "127.0.0.1");
    const server: Server = app.getHttpServer();
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP address for the NestJS reference server.");
    }
    return {
      async fetch(path: string, init?: RequestInit): Promise<Response> {
        return fetch(`http://127.0.0.1:${address.port}${path}`, init);
      },
      close: () => app.close(),
    };
  } catch (error) {
    await app.close();
    throw error;
  }
}
