import { NestFactory } from "@nestjs/core";
import { BunHttpAdapter } from "nestjs-adapter-bun";
import { AppModule } from "./app.js";

const app = await NestFactory.create(AppModule, new BunHttpAdapter());
app.enableShutdownHooks();
await app.listen(3000, "127.0.0.1");
console.log(`Bun server: ${await app.getUrl()}/hello/world`);
