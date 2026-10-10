import assert from "node:assert/strict";
import { Controller, Get, Module, Sse } from "@nestjs/common";
import { NestFactory, type AbstractHttpAdapter } from "@nestjs/core";
import { finalize, interval, map } from "rxjs";

/** Signals and counters the lifecycle routes share with the checks. */
const state = {
  finalized: 0,
  started: [] as (() => void)[],
};
function nextStart(): Promise<void> {
  return new Promise((resolve) => state.started.push(resolve));
}
function markStarted(): void {
  state.started.shift()?.();
}

@Controller("lifecycle")
class LifecycleController {
  /** Never answers: only a forced close can end it. */
  @Get("hang") hang(): Promise<never> {
    markStarted();
    return new Promise(() => {});
  }
  @Get("slow") async slow() {
    markStarted();
    await new Promise((resolve) => setTimeout(resolve, 150));
    return { slow: true };
  }
  @Sse("stream") stream() {
    markStarted();
    return interval(10).pipe(
      map((index) => ({ data: { index } })),
      finalize(() => state.finalized++),
    );
  }
}
@Module({ controllers: [LifecycleController] })
class LifecycleModule {}

type Options = { shutdownTimeout?: number; forceCloseConnections?: boolean };

async function start(createAdapter: (options: Options) => AbstractHttpAdapter, options: Options) {
  const app = await NestFactory.create(LifecycleModule, createAdapter(options), {
    logger: false,
    forceCloseConnections: options.forceCloseConnections,
  });
  await app.listen(0, "127.0.0.1");
  return { app, base: await app.getUrl() };
}

async function waitFor(condition: () => boolean, what: string, timeout = 2000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Shutdown and disconnect behavior every adapter must share: graceful drain,
 * the shutdownTimeout and forceCloseConnections cut-offs, and releasing a
 * streamed response when the client goes away.
 */
export async function checkLifecycle(
  label: string,
  createAdapter: (options: Options) => AbstractHttpAdapter,
): Promise<void> {
  // close() waits for an in-flight request and still delivers its response.
  {
    const { app, base } = await start(createAdapter, {});
    let closing: Promise<void> | undefined;
    try {
      const started = nextStart();
      const pending = fetch(`${base}/lifecycle/slow`);
      await started;
      closing = app.close();
      const response = await pending;
      assert.equal(response.status, 200, `${label}: graceful close delivers the response`);
      assert.deepEqual(await response.json(), { slow: true });
      await closing;
      await assert.rejects(fetch(`${base}/lifecycle/slow`), `${label}: closed server refuses`);
    } finally {
      // A failed assertion must not leave the server listening.
      await (closing ?? app.close());
    }
  }

  // shutdownTimeout forcibly ends connections that outlive it.
  {
    const { app, base } = await start(createAdapter, { shutdownTimeout: 100 });
    let closed = false;
    try {
      const started = nextStart();
      const pending = fetch(`${base}/lifecycle/hang`).then(
        () => "answered",
        () => "dropped",
      );
      await started;
      const before = Date.now();
      await app.close();
      closed = true;
      const elapsed = Date.now() - before;
      assert.ok(elapsed >= 90 && elapsed < 2000, `${label}: shutdownTimeout took ${elapsed} ms`);
      assert.equal(await pending, "dropped", `${label}: hung request is dropped on timeout`);
    } finally {
      if (!closed) await app.close();
    }
  }

  // forceCloseConnections ends open connections right away.
  {
    const { app, base } = await start(createAdapter, { forceCloseConnections: true });
    let closed = false;
    try {
      const started = nextStart();
      const pending = fetch(`${base}/lifecycle/hang`).then(
        () => "answered",
        () => "dropped",
      );
      await started;
      const before = Date.now();
      await app.close();
      closed = true;
      const elapsed = Date.now() - before;
      assert.ok(elapsed < 1000, `${label}: forceCloseConnections took ${elapsed} ms`);
      assert.equal(await pending, "dropped", `${label}: forced close drops the request`);
    } finally {
      if (!closed) await app.close();
    }
  }

  // A client that disconnects from an SSE stream unsubscribes the Observable.
  {
    const { app, base } = await start(createAdapter, {});
    try {
      const finalized = state.finalized;
      const controller = new AbortController();
      const response = await fetch(`${base}/lifecycle/stream`, { signal: controller.signal });
      const reader = response.body!.getReader();
      // Nest opens the stream with a bare newline; read until the first event.
      let received = "";
      while (!/data: \{"index":\d+\}/.test(received)) {
        const chunk = await reader.read();
        assert.ok(!chunk.done, `${label}: SSE stream ended early`);
        received += new TextDecoder().decode(chunk.value);
      }
      controller.abort();
      await reader.cancel().catch(() => {});
      await waitFor(() => state.finalized > finalized, `${label}: SSE unsubscribe on disconnect`);
      // The server keeps serving after the aborted stream.
      const next = await fetch(`${base}/lifecycle/slow`);
      assert.equal(next.status, 200);
      await next.arrayBuffer();
    } finally {
      await app.close();
    }
  }
  console.log(
    `${label}: graceful close, shutdownTimeout, forceCloseConnections and SSE disconnect passed.`,
  );
}
