import { ExpressAdapter } from "@nestjs/platform-express";
import { NodeHttpAdapter } from "nestjs-adapter-node";
import { compareAdapters } from "./compare.js";
import { checkLifecycle } from "./lifecycle.js";

await compareAdapters(
  () => new NodeHttpAdapter(),
  () => new ExpressAdapter(),
);
await checkLifecycle("native-node", (options) => new NodeHttpAdapter(options));
