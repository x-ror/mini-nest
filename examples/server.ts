import { NestFactory } from "@nestjs/core";
import { NodeHttpAdapter } from "nestjs-adapter-node";
import { AppModule } from "./app.js";

const app = await NestFactory.create(AppModule, new NodeHttpAdapter());
app.enableShutdownHooks();
await app.listen(3000, "127.0.0.1");
console.log(`Node server: ${await app.getUrl()}/hello/world`);
