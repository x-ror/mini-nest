import { afterEach, it, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import { ConsoleLogger, Logger, type LoggerService } from "@mini-nest/common";

afterEach(() => {
  Logger.detachBuffer();
  Logger.flush();
  Logger.overrideLogger(true);
});

it("filters levels, preserves context and selects error/warn output", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const logger = new ConsoleLogger("Original", { logLevels: ["warn"], colors: false });
  logger.log("hidden");
  logger.debug("hidden");
  logger.warn("warning");
  logger.error("failed", "stack", "Override");
  logger.fatal("fatal");
  assert.equal(log.mock.calls.length, 0);
  assert.equal(warn.mock.calls.length, 1);
  assert.equal(error.mock.calls.length, 2);
  assert.match(String(error.mock.calls[0]?.[0]), /\[Override\]/);
  logger.setContext("Changed");
  logger.resetContext();
  logger.setLogLevels(["log"]);
  logger.log("visible");
  assert.match(String(log.mock.calls[0]?.[0]), /\[Original\]/);
});

it("supports JSON output and relative timestamps without Node imports", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const json = new ConsoleLogger({ json: true, context: "Json" });
  json.log({ message: "value" });
  const record = JSON.parse(String(log.mock.calls[0]?.[0]));
  assert.equal(record.context, "Json");
  assert.deepEqual(record.message, { message: "value" });
  const logger = new Logger("Timed", { timestamp: true });
  logger.log("first");
  logger.log("second");
  assert.match(String(log.mock.calls[2]?.[0]), /\+\d+ms/);
});

it("delegates to custom loggers, supports buffering and disabled logging", () => {
  const log = vi.fn();
  const custom: LoggerService = { log, error: vi.fn(), warn: vi.fn() };
  Logger.overrideLogger(custom);
  const logger = new Logger("Service");
  Logger.attachBuffer();
  logger.log("buffered");
  Logger.log("static", "Context");
  assert.equal(log.mock.calls.length, 0);
  Logger.flush();
  assert.deepEqual(log.mock.calls, [
    ["buffered", "Service"],
    ["static", "Context"],
  ]);
  Logger.overrideLogger(false);
  logger.log("disabled");
  assert.equal(log.mock.calls.length, 2);
  Logger.overrideLogger(custom);
  Logger.overrideLogger(["error"]);
  logger.log("filtered");
  Logger.error("visible");
  assert.equal(log.mock.calls.length, 2);
  assert.equal(Logger.isLevelEnabled("debug"), false);
});

it("rejects advanced formatting options instead of silently ignoring them", () => {
  assert.throws(() => new ConsoleLogger({ redact: ["password"] }), /not implemented/);
});

it("preserves options on ConsoleLogger overrides and rejects recursive Logger overrides", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  Logger.overrideLogger(new ConsoleLogger({ json: true }));
  const logger = new Logger("Service");
  logger.log("json override");
  assert.equal(JSON.parse(String(log.mock.calls[0]?.[0])).message, "json override");
  assert.equal(JSON.parse(String(log.mock.calls[0]?.[0])).context, "Service");
  assert.throws(() => Logger.overrideLogger(logger), /without extending Logger/);
});
