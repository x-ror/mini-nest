import { ExpressAdapter } from "@nestjs/platform-express";
import { NodeHttpAdapter } from "@nest-native/platform-node";
import { compareAdapters } from "./compare.js";

await compareAdapters(new NodeHttpAdapter(), new ExpressAdapter());
