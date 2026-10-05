export type RequestHandler = (request: Request) => Promise<Response>;

export interface HttpAdapter<TServer = unknown> {
  listen(handler: RequestHandler, port: number, hostname?: string): Promise<TServer>;
  getHttpServer(): TServer;
  close(): Promise<void>;
}
