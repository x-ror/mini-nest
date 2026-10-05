export interface HttpExceptionOptions {
  cause?: unknown;
  description?: string;
  errorCode?: string;
}
export interface DescriptionAndOptions {
  description?: string;
  httpExceptionOptions?: HttpExceptionOptions;
}
export type HttpExceptionBodyMessage = string | string[] | number;
export interface HttpExceptionBody {
  statusCode: number;
  message: HttpExceptionBodyMessage;
  error?: string;
  errorCode?: string;
}

export class HttpException extends Error {
  errorCode?: string;

  constructor(
    private readonly response: string | Record<string, any>,
    private readonly status: number,
    private readonly options?: HttpExceptionOptions,
  ) {
    const message =
      typeof response === "string"
        ? response
        : typeof response.message === "string"
          ? response.message
          : "";
    super(message, options && { cause: options.cause });
    this.name = new.target.name;
    if (typeof response !== "string" && typeof response.message !== "string") {
      this.message = this.name.match(/[A-Z][a-z]+/g)?.join(" ") ?? this.name;
    }
    this.errorCode = options?.errorCode;
  }

  initCause(): void {
    if (this.options?.cause !== undefined) this.cause = this.options.cause;
  }
  initErrorCode(): void {
    this.errorCode = this.options?.errorCode;
  }
  initName(): void {
    this.name = this.constructor.name;
  }
  initMessage(): void {
    this.message =
      typeof this.response === "string"
        ? this.response
        : typeof this.response.message === "string"
          ? this.response.message
          : (this.constructor.name.match(/[A-Z][a-z]+/g)?.join(" ") ?? this.constructor.name);
  }
  getResponse(): string | object {
    return this.response;
  }
  getStatus(): number {
    return this.status;
  }

  static createBody<T extends Record<string, unknown>>(custom: T): T;
  static createBody(
    message: HttpExceptionBodyMessage | null | undefined,
    error: string,
    statusCode: number,
    errorCode?: string,
  ): HttpExceptionBody;
  static createBody(
    message: Record<string, unknown> | HttpExceptionBodyMessage | null | undefined,
    error?: string,
    statusCode?: number,
    errorCode?: string,
  ): Record<string, unknown> | HttpExceptionBody {
    if (message !== null && typeof message === "object" && !Array.isArray(message)) return message;
    if (statusCode === undefined || error === undefined)
      throw new Error("Missing HTTP exception status or description.");
    const body: HttpExceptionBody = !message
      ? { message: error, statusCode }
      : { message: message as HttpExceptionBodyMessage, error, statusCode };
    if (errorCode !== undefined) body.errorCode = errorCode;
    return body;
  }

  static getDescriptionFrom(value: string | HttpExceptionOptions): string {
    return typeof value === "string" ? value : (value.description ?? "");
  }
  static getHttpExceptionOptionsFrom(value: string | HttpExceptionOptions): HttpExceptionOptions {
    return typeof value === "string" ? {} : value;
  }
  static extractDescriptionAndOptionsFrom(
    value: string | HttpExceptionOptions,
  ): DescriptionAndOptions {
    return typeof value === "string"
      ? { description: value }
      : { description: value.description, httpExceptionOptions: value };
  }
}
