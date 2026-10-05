import { BadRequestException } from "@nestjs/common";
import { match, type MatchFunction } from "path-to-regexp";
import type { NativeRequest } from "./request.js";
import type { NativeResponse } from "./response.js";

export type Next = (error?: unknown) => void;
export type Handler = (request: NativeRequest, response: NativeResponse, next: Next) => unknown;
interface Layer {
  method?: string;
  match: MatchFunction<Record<string, string | string[]>>;
  handler: Handler;
}

export class NativeRouter {
  private readonly layers: Layer[] = [];
  use(path: string, handler: Handler): void { this.add(undefined, path, handler, false); }
  route(method: string, path: string, handler: Handler): void { this.add(method, path, handler, true); }
  private add(method: string | undefined, path: string, handler: Handler, end: boolean): void {
    this.layers.push({ method, handler, match: match(path, { end, sensitive: true, trailing: true }) });
  }

  async run(request: NativeRequest, response: NativeResponse, notFound: Handler): Promise<void> {
    const dispatch = async (index: number): Promise<void> => {
      if (response.headersSent) return;
      const layer = this.layers[index];
      if (!layer) { await notFound(request, response, () => {}); return; }
      if (layer.method && layer.method !== "ALL" && layer.method !== request.method &&
        !(request.method === "HEAD" && layer.method === "GET")) {
        return dispatch(index + 1);
      }
      let result;
      try { result = layer.match(request.path); }
      catch (error) {
        if (error instanceof URIError) throw new BadRequestException("Invalid route parameter");
        throw error;
      }
      if (!result) return dispatch(index + 1);
      if (layer.method) request.params = result.params;
      let called = false;
      let proceed!: (error?: unknown) => void;
      const continuation = new Promise<unknown>((resolve) => { proceed = resolve; });
      const next: Next = (error) => {
        if (called) throw new Error("next() may only be called once.");
        called = true;
        proceed(error);
      };
      await layer.handler(request, response, next);
      if (response.headersSent) return;
      const error = await Promise.race([continuation, response.done.then(() => undefined)]);
      if (error !== undefined) throw error;
      if (called && !response.headersSent) await dispatch(index + 1);
    };
    await dispatch(0);
  }
}
