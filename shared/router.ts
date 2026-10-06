import { BadRequestException } from "@nestjs/common";
import { match } from "path-to-regexp";
import { NullObject, type NativeRequest } from "./request.js";
import type { NativeResponse } from "./response.js";

function decodeParameter(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    if (error instanceof URIError)
      throw new BadRequestException(`Failed to decode param '${value}'`);
    throw error;
  }
}

export type Next = (error?: unknown) => void;
export type Handler = (request: NativeRequest, response: NativeResponse, next: Next) => unknown;
export type Fail = (error: unknown, request: NativeRequest, response: NativeResponse) => void;
type Params = Record<string, string | string[]>;
interface Layer {
  method?: string;
  // `true` means a match without parameters.
  match: (path: string) => Params | boolean;
  handler: Handler;
}

export class NativeRouter {
  // ponytail: linear scan in registration order; index static routes or use a
  // radix tree if apps with hundreds of routes show up in profiles.
  private readonly layers: Layer[] = [];
  use(path: string, handler: Handler): void {
    this.add(undefined, path, handler, false);
  }
  route(method: string, path: string, handler: Handler): void {
    this.add(method, path, handler, true);
  }
  private add(method: string | undefined, path: string, handler: Handler, end: boolean): void {
    let matcher: Layer["match"];
    if (!end && path === "/") {
      matcher = () => true;
    } else if (/^[\w\-./~%]+$/.test(path) && !path.endsWith("/")) {
      // Paths without path-to-regexp syntax are compared as plain strings.
      const nested = `${path}/`;
      matcher = end
        ? (value) => value === path || value === nested
        : (value) => value === path || value.startsWith(nested);
    } else {
      const compiled = match<Params>(path, {
        end,
        sensitive: true,
        trailing: true,
        decode: decodeParameter,
      });
      matcher = (value) => {
        const result = compiled(value);
        return result ? result.params : false;
      };
    }
    this.layers.push({ method, handler, match: matcher });
  }

  run(request: NativeRequest, response: NativeResponse, notFound: Handler, fail: Fail): void {
    const layers = this.layers;
    const method = request.method;
    const path = request.path;
    let index = 0;
    let routeParams = false;
    const rejected = (error: unknown): void => fail(error, request, response);
    const step = (): void => {
      if (response.headersSent) return;
      try {
        let handler = notFound;
        while (index < layers.length) {
          const layer = layers[index++]!;
          const layerMethod = layer.method;
          if (
            layerMethod !== undefined &&
            layerMethod !== method &&
            layerMethod !== "ALL" &&
            !(method === "HEAD" && layerMethod === "GET")
          ) {
            continue;
          }
          const result = layer.match(path);
          if (result === false) continue;
          if (layerMethod !== undefined) {
            if (result !== true) {
              request.params = result;
              routeParams = true;
            } else if (routeParams) {
              request.params = new NullObject();
              routeParams = false;
            }
          }
          handler = layer.handler;
          break;
        }
        let called = false;
        const result = handler(request, response, (error) => {
          if (called) throw new Error("next() may only be called once.");
          called = true;
          if (error === undefined || error === null) step();
          else fail(error, request, response);
        });
        if (typeof (result as PromiseLike<unknown> | undefined)?.then === "function") {
          (result as PromiseLike<unknown>).then(undefined, rejected);
        }
      } catch (error) {
        fail(error, request, response);
      }
    };
    step();
  }
}
