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
const runsCount = Number(process.env.BENCH_RUNS ?? 3);
const workload = process.env.BENCH_WORKLOAD ?? "json";
if (!["node", "bun", "express"].includes(mode)) {
  throw new Error("Usage: benchmark.js [node|bun|express]");
}
if (
  ![durationMs, warmupMs, concurrency, runsCount].every(Number.isSafeInteger) ||
  durationMs <= 0 ||
  warmupMs < 0 ||
  concurrency <= 0 ||
  runsCount <= 0
) {
  throw new Error(
    "BENCH_DURATION_MS, BENCH_CONCURRENCY, and BENCH_RUNS must be positive integers; warmup must be nonnegative.",
  );
}
if (!["json", "route", "post", "mixed"].includes(workload)) {
  throw new Error("BENCH_WORKLOAD must be json, route, post, or mixed.");
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

type WorkloadRequest = { path: string; init?: RequestInit; expectedStatus: number };
const workloadRequests: WorkloadRequest[] = [
  { path: "/api", expectedStatus: 200 },
  { path: "/api/items/42?tag=first&tag=second", expectedStatus: 200 },
  {
    path: "/api/echo",
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "benchmark", values: [1, 2, 3] }),
    },
    expectedStatus: 201,
  },
];
const selectedWorkloads =
  workload === "mixed"
    ? workloadRequests
    : [workloadRequests[{ json: 0, route: 1, post: 2 }[workload]!]];
let workloadSequence = 0;

interface RunResult {
  requests: number;
  failures: number;
  requestsPerSecond: number;
  meanLatencyMs: number;
  p50UpperBoundMs: number;
  p95UpperBoundMs: number;
  p99UpperBoundMs: number;
  elapsedSeconds: number;
}

function recordLatency(buckets: Uint32Array, milliseconds: number): number {
  const microseconds = Math.max(1, Math.ceil(milliseconds * 1000));
  const bucket = Math.min(31, Math.floor(Math.log2(microseconds)));
  buckets[bucket] = (buckets[bucket] ?? 0) + 1;
  return microseconds;
}

function percentile(buckets: Uint32Array, requests: number, percent: number): number {
  const target = Math.ceil(requests * percent);
  let cumulative = 0;
  for (let i = 0; i < buckets.length; i++) {
    cumulative += buckets[i] ?? 0;
    if (cumulative >= target) return 2 ** (i + 1) / 1000;
  }
  return 2 ** buckets.length / 1000;
}

async function worker(
  baseUrl: string,
  until: number,
  measure: boolean,
  state: { buckets: Uint32Array; requests: number; failures: number; totalLatencyUs: number },
): Promise<void> {
  while (performance.now() < until) {
    const start = performance.now();
    try {
      const work = selectedWorkloads[workloadSequence++ % selectedWorkloads.length]!;
      const response = await fetch(`${baseUrl}${work.path}`, work.init);
      await response.arrayBuffer();
      if (measure) {
        state.requests++;
        if (response.status !== work.expectedStatus) state.failures++;
        state.totalLatencyUs += recordLatency(state.buckets, performance.now() - start);
      }
    } catch {
      if (measure) {
        state.requests++;
        state.failures++;
        state.totalLatencyUs += recordLatency(state.buckets, performance.now() - start);
      }
    }
  }
}

try {
  await app.listen(0, "127.0.0.1");
  const baseUrl = await app.getUrl();
  const results: RunResult[] = [];
  for (let run = 0; run < runsCount; run++) {
    const warmupState = {
      buckets: new Uint32Array(32),
      requests: 0,
      failures: 0,
      totalLatencyUs: 0,
    };
    await Promise.all(
      Array.from({ length: concurrency }, () =>
        worker(baseUrl, performance.now() + warmupMs, false, warmupState),
      ),
    );
    const state = { ...warmupState, buckets: new Uint32Array(32), requests: 0, failures: 0 };
    const started = performance.now();
    const deadline = started + durationMs;
    await Promise.all(
      Array.from({ length: concurrency }, () => worker(baseUrl, deadline, true, state)),
    );
    const elapsedSeconds = (performance.now() - started) / 1000;
    results.push({
      requests: state.requests,
      failures: state.failures,
      requestsPerSecond: Math.round(state.requests / elapsedSeconds),
      meanLatencyMs: Number((state.totalLatencyUs / Math.max(state.requests, 1) / 1000).toFixed(3)),
      p50UpperBoundMs: Number(percentile(state.buckets, state.requests, 0.5).toFixed(3)),
      p95UpperBoundMs: Number(percentile(state.buckets, state.requests, 0.95).toFixed(3)),
      p99UpperBoundMs: Number(percentile(state.buckets, state.requests, 0.99).toFixed(3)),
      elapsedSeconds: Number(elapsedSeconds.toFixed(3)),
    });
  }
  const rates = results.map((result) => result.requestsPerSecond);
  const averageRate = rates.reduce((total, value) => total + value, 0) / rates.length;
  const standardDeviation = Math.sqrt(
    rates.reduce((total, value) => total + (value - averageRate) ** 2, 0) / rates.length,
  );
  console.log(
    JSON.stringify(
      {
        mode,
        workload,
        runtime: bunVersion === undefined ? `Node ${process.version}` : `Bun ${bunVersion}`,
        concurrency,
        warmupMs,
        durationMs,
        runs: results,
        summary: {
          requestsPerSecondMean: Math.round(averageRate),
          requestsPerSecondStandardDeviation: Math.round(standardDeviation),
          failures: results.reduce((total, result) => total + result.failures, 0),
        },
      },
      null,
      2,
    ),
  );
  if (results.some((result) => result.failures > 0)) process.exitCode = 1;
} finally {
  await app.close();
}
