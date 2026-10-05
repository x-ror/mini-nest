import "reflect-metadata";
import { performance } from "node:perf_hooks";
import { NestFactory, type AbstractHttpAdapter } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { BunHttpAdapter } from "nestjs-adapter-bun";
import { NodeHttpAdapter } from "nestjs-adapter-node";
import { FixtureModule } from "./fixture.js";

const bunVersion = process.versions.bun;
const mode = process.argv[2] ?? (bunVersion === undefined ? "node" : "bun");
const durationMs = Number(process.env.BENCH_DURATION_MS ?? 10_000);
const warmupMs = Number(process.env.BENCH_WARMUP_MS ?? 2_000);
const concurrency = Number(process.env.BENCH_CONCURRENCY ?? 32);
if (!["node", "bun", "express"].includes(mode)) {
  throw new Error("Usage: benchmark.js [node|bun|express]");
}
if (
  ![durationMs, warmupMs, concurrency].every(Number.isSafeInteger) ||
  durationMs <= 0 ||
  warmupMs < 0 ||
  concurrency <= 0
) {
  throw new Error(
    "BENCH_DURATION_MS and BENCH_CONCURRENCY must be positive integers; warmup must be nonnegative.",
  );
}
if (mode === "bun" && bunVersion === undefined) throw new Error("Run Bun benchmarks with Bun.");
if (mode === "node" && bunVersion !== undefined) throw new Error("Run Node benchmarks with Node.");

const adapter: AbstractHttpAdapter =
  mode === "express"
    ? new ExpressAdapter()
    : mode === "bun"
      ? new BunHttpAdapter()
      : new NodeHttpAdapter();
const app = await NestFactory.create(FixtureModule, adapter, {
  logger: false,
  abortOnError: false,
});

const buckets = new Uint32Array(32);
let requests = 0;
let failures = 0;
let totalLatencyUs = 0;

function recordLatency(milliseconds: number): void {
  const microseconds = Math.max(1, Math.ceil(milliseconds * 1000));
  const bucket = Math.min(31, Math.floor(Math.log2(microseconds)));
  buckets[bucket] = (buckets[bucket] ?? 0) + 1;
  totalLatencyUs += microseconds;
}

function percentile(percent: number): number {
  const target = Math.ceil(requests * percent);
  let cumulative = 0;
  for (let i = 0; i < buckets.length; i++) {
    cumulative += buckets[i] ?? 0;
    if (cumulative >= target) return 2 ** (i + 1) / 1000;
  }
  return 2 ** buckets.length / 1000;
}

async function worker(url: string, until: number, measure: boolean): Promise<void> {
  while (performance.now() < until) {
    const start = performance.now();
    try {
      const response = await fetch(url);
      await response.arrayBuffer();
      if (measure) {
        requests++;
        if (response.status !== 200) failures++;
        recordLatency(performance.now() - start);
      }
    } catch {
      if (measure) {
        requests++;
        failures++;
        recordLatency(performance.now() - start);
      }
    }
  }
}

try {
  await app.listen(0, "127.0.0.1");
  const url = `${await app.getUrl()}/api`;
  await Promise.all(
    Array.from({ length: concurrency }, () => worker(url, performance.now() + warmupMs, false)),
  );
  const started = performance.now();
  const deadline = started + durationMs;
  await Promise.all(Array.from({ length: concurrency }, () => worker(url, deadline, true)));
  const elapsedSeconds = (performance.now() - started) / 1000;
  console.log(
    JSON.stringify(
      {
        mode,
        runtime: bunVersion === undefined ? `Node ${process.version}` : `Bun ${bunVersion}`,
        concurrency,
        warmupMs,
        durationMs,
        elapsedSeconds: Number(elapsedSeconds.toFixed(3)),
        requests,
        failures,
        requestsPerSecond: Math.round(requests / elapsedSeconds),
        latencyMs: {
          mean: Number((totalLatencyUs / Math.max(requests, 1) / 1000).toFixed(3)),
          p50UpperBound: Number(percentile(0.5).toFixed(3)),
          p95UpperBound: Number(percentile(0.95).toFixed(3)),
          p99UpperBound: Number(percentile(0.99).toFixed(3)),
        },
      },
      null,
      2,
    ),
  );
  if (failures > 0) process.exitCode = 1;
} finally {
  await app.close();
}
