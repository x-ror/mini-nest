import "reflect-metadata";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Agent, request as httpRequest } from "node:http";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { NestFactory, type AbstractHttpAdapter } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { BunHttpAdapter } from "nestjs-adapter-bun";
import { NodeHttpAdapter } from "nestjs-adapter-node";
import { FixtureModule } from "./fixture.js";

const bunVersion = process.versions.bun;
const mode = process.argv[2] ?? (bunVersion === undefined ? "node" : "bun");
const serverMode = process.argv[3] === "--server";
const clientMode = process.argv[3] === "--client";
const durationMs = Number(process.env.BENCH_DURATION_MS ?? 10_000);
const warmupMs = Number(process.env.BENCH_WARMUP_MS ?? 2_000);
const concurrency = Number(process.env.BENCH_CONCURRENCY ?? 32);
const clientProcesses = Number(process.env.BENCH_CLIENT_PROCESSES ?? 4);
const runsCount = Number(process.env.BENCH_RUNS ?? 3);
const workload = process.env.BENCH_WORKLOAD ?? "json";
if (!["node", "bun", "express", "fastify"].includes(mode)) {
  throw new Error("Usage: benchmark.js [node|bun|express|fastify]");
}
if (
  ![durationMs, warmupMs, concurrency, clientProcesses, runsCount].every(Number.isSafeInteger) ||
  durationMs <= 0 ||
  warmupMs < 0 ||
  concurrency <= 0 ||
  clientProcesses <= 0 ||
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
interface ClientResult extends RunResult {
  buckets: number[];
  totalLatencyUs: number;
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
  agent: Agent,
  state: { buckets: Uint32Array; requests: number; failures: number; totalLatencyUs: number },
): Promise<void> {
  while (performance.now() < until) {
    const start = performance.now();
    try {
      const work = selectedWorkloads[workloadSequence++ % selectedWorkloads.length]!;
      const status = await new Promise<number>((resolve, reject) => {
        const request = httpRequest(
          new URL(work.path, baseUrl),
          {
            method: work.init?.method ?? "GET",
            headers: work.init?.headers as Record<string, string> | undefined,
            agent,
          },
          (response) => {
            response.once("error", reject);
            response.once("end", () => resolve(response.statusCode ?? 0));
            response.resume();
          },
        );
        request.once("error", reject);
        request.end(work.init?.body);
      });
      if (measure) {
        state.requests++;
        if (status !== work.expectedStatus) state.failures++;
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

async function runClient(
  baseUrl: string,
  clientConcurrency: number,
  onReady: () => void,
  waitForStart: () => Promise<void>,
): Promise<ClientResult> {
  const agent = new Agent({ keepAlive: true, maxSockets: clientConcurrency });
  try {
    const warmupState = {
      buckets: new Uint32Array(32),
      requests: 0,
      failures: 0,
      totalLatencyUs: 0,
    };
    await Promise.all(
      Array.from({ length: clientConcurrency }, () =>
        worker(baseUrl, performance.now() + warmupMs, false, agent, warmupState),
      ),
    );
    onReady();
    await waitForStart();
    const state = { ...warmupState, buckets: new Uint32Array(32), requests: 0, failures: 0 };
    const started = performance.now();
    const deadline = started + durationMs;
    await Promise.all(
      Array.from({ length: clientConcurrency }, () =>
        worker(baseUrl, deadline, true, agent, state),
      ),
    );
    const elapsedSeconds = (performance.now() - started) / 1000;
    return {
      requests: state.requests,
      failures: state.failures,
      requestsPerSecond: state.requests / elapsedSeconds,
      meanLatencyMs: Number((state.totalLatencyUs / Math.max(state.requests, 1) / 1000).toFixed(3)),
      p50UpperBoundMs: percentile(state.buckets, state.requests, 0.5),
      p95UpperBoundMs: percentile(state.buckets, state.requests, 0.95),
      p99UpperBoundMs: percentile(state.buckets, state.requests, 0.99),
      elapsedSeconds,
      buckets: Array.from(state.buckets),
      totalLatencyUs: state.totalLatencyUs,
    };
  } finally {
    agent.destroy();
  }
}

async function runServer(): Promise<void> {
  const adapter: AbstractHttpAdapter =
    mode === "express"
      ? new ExpressAdapter()
      : mode === "fastify"
        ? new FastifyAdapter()
        : mode === "bun"
          ? new BunHttpAdapter()
          : new NodeHttpAdapter();
  const app = await NestFactory.create(FixtureModule, adapter, {
    logger: false,
    abortOnError: false,
  });
  await app.listen(0, "127.0.0.1");
  console.log(`BENCH_SERVER_READY ${await app.getUrl()}`);
  await new Promise<void>((resolve, reject) => {
    const shutdown = () => {
      app.close().then(resolve, reject);
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  });
}

async function startServerProcess(): Promise<{ baseUrl: string; stop: () => Promise<void> }> {
  const scriptPath = process.argv[1];
  if (!scriptPath) throw new Error("Cannot resolve the benchmark script path.");
  const child = spawn(process.execPath, [scriptPath, mode, "--server"], {
    stdio: ["ignore", "pipe", "inherit"],
    env: process.env,
  });
  const lines = createInterface({ input: child.stdout });
  let serverUrl: string | undefined;
  const ready = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for benchmark server.")),
      30_000,
    );
    timeout.unref();
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      if (!serverUrl) {
        clearTimeout(timeout);
        reject(new Error(`Benchmark server exited before startup (code ${code}).`));
      }
    });
    lines.on("line", (line) => {
      const prefix = "BENCH_SERVER_READY ";
      if (line.startsWith(prefix)) {
        serverUrl = line.slice(prefix.length);
        clearTimeout(timeout);
        resolve(serverUrl);
      } else {
        console.log(line);
      }
    });
  });
  try {
    const baseUrl = await ready;
    return {
      baseUrl,
      stop: async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill("SIGTERM");
        await once(child, "exit");
        lines.close();
      },
    };
  } catch (error) {
    child.kill("SIGTERM");
    lines.close();
    throw error;
  }
}

if (serverMode) {
  await runServer();
} else if (clientMode) {
  const baseUrl = process.env.BENCH_BASE_URL;
  const clientConcurrency = Number(process.env.BENCH_CLIENT_CONCURRENCY);
  if (!baseUrl || !Number.isSafeInteger(clientConcurrency) || clientConcurrency <= 0) {
    throw new Error("Benchmark client process requires a base URL and positive concurrency.");
  }
  const startSignal = createInterface({ input: process.stdin });
  const startMessage = once(startSignal, "line");
  const waitForStart = async (): Promise<void> => {
    await startMessage;
    startSignal.close();
  };
  const result = await runClient(
    baseUrl,
    clientConcurrency,
    () => console.log("BENCH_CLIENT_READY"),
    waitForStart,
  );
  console.log(`BENCH_CLIENT_RESULT ${JSON.stringify(result)}`);
} else {
  const server = await startServerProcess();
  try {
    const baseUrl = server.baseUrl;
    const results: RunResult[] = [];
    for (let run = 0; run < runsCount; run++) {
      const clients = Array.from({ length: clientProcesses }, (_, index) => {
        const clientConcurrency =
          Math.floor(concurrency / clientProcesses) +
          (index < concurrency % clientProcesses ? 1 : 0);
        if (clientConcurrency === 0) return null;
        const child = spawn(process.execPath, [process.argv[1]!, mode, "--client"], {
          stdio: ["pipe", "pipe", "inherit"],
          env: {
            ...process.env,
            BENCH_BASE_URL: baseUrl,
            BENCH_CLIENT_CONCURRENCY: String(clientConcurrency),
          },
        });
        const lines = createInterface({ input: child.stdout });
        let resolveReady!: () => void;
        let rejectReady!: (error: Error) => void;
        const ready = new Promise<void>((resolve, reject) => {
          resolveReady = resolve;
          rejectReady = reject;
        });
        const result = new Promise<ClientResult>((resolve, reject) => {
          let result: ClientResult | undefined;
          lines.on("line", (line) => {
            const prefix = "BENCH_CLIENT_RESULT ";
            if (line.startsWith(prefix)) {
              result = JSON.parse(line.slice(prefix.length)) as ClientResult;
            } else if (line === "BENCH_CLIENT_READY") {
              resolveReady();
            } else {
              console.log(line);
            }
          });
          child.once("error", (error) => {
            rejectReady(error);
            reject(error);
          });
          child.once("exit", (code) => {
            lines.close();
            rejectReady(new Error(`Benchmark client exited before ready (code ${code}).`));
            if (code !== 0 || !result) {
              reject(new Error(`Benchmark client exited without results (code ${code}).`));
              return;
            }
            resolve(result);
          });
        });
        return { child, ready, result };
      });
      const activeClients = clients.filter((client) => client !== null);
      await Promise.all(activeClients.map((client) => client.ready));
      for (const client of activeClients) client.child.stdin.end("START\n");
      const clientResults = await Promise.all(activeClients.map((client) => client.result));
      const buckets = new Uint32Array(32);
      const requests = clientResults.reduce((total, result) => total + result.requests, 0);
      for (const result of clientResults) {
        result.buckets.forEach((count, index) => {
          buckets[index] = (buckets[index] ?? 0) + count;
        });
      }
      const totalLatencyUs = clientResults.reduce(
        (total, result) => total + result.totalLatencyUs,
        0,
      );
      const elapsedSeconds = Math.max(
        ...clientResults.map((result) => result.elapsedSeconds),
        Number.EPSILON,
      );
      results.push({
        requests,
        failures: clientResults.reduce((total, result) => total + result.failures, 0),
        requestsPerSecond: Math.round(requests / elapsedSeconds),
        meanLatencyMs: Number((totalLatencyUs / Math.max(requests, 1) / 1000).toFixed(3)),
        p50UpperBoundMs: Number(percentile(buckets, requests, 0.5).toFixed(3)),
        p95UpperBoundMs: Number(percentile(buckets, requests, 0.95).toFixed(3)),
        p99UpperBoundMs: Number(percentile(buckets, requests, 0.99).toFixed(3)),
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
          clientProcesses,
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
    await server.stop();
  }
}
