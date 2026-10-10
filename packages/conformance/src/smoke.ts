import { ExpressAdapter } from "@nestjs/platform-express";
import { NodeHttpAdapter } from "nestjs-adapter-node";
import { compareAdapters } from "./compare.js";

await compareAdapters(
  () => new NodeHttpAdapter(),
  () => new ExpressAdapter(),
);
