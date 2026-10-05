export const LOG_LEVELS = ["log", "error", "warn", "debug", "verbose", "fatal"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LoggerService {
  log(message: any, ...optionalParams: any[]): any;
  error(message: any, ...optionalParams: any[]): any;
  warn(message: any, ...optionalParams: any[]): any;
  debug?(message: any, ...optionalParams: any[]): any;
  verbose?(message: any, ...optionalParams: any[]): any;
  fatal?(message: any, ...optionalParams: any[]): any;
  setLogLevels?(levels: LogLevel[]): any;
}
export interface ConsoleLoggerOptions {
  logLevels?: LogLevel[];
  timestamp?: boolean;
  prefix?: string;
  colors?: boolean;
  json?: boolean;
  context?: string;
  forceConsole?: boolean;
  compact?: boolean | number;
  maxArrayLength?: number | null;
  maxStringLength?: number | null;
  sorted?: boolean | ((a: string, b: string) => number);
  depth?: number | null;
  showHidden?: boolean;
  breakLength?: number;
  structuredParams?: boolean;
  flattenParams?: boolean;
  redact?: string[] | { paths: string[]; censor?: string };
}

const priorities: Record<LogLevel, number> = {
  verbose: 0,
  debug: 1,
  log: 2,
  warn: 3,
  error: 4,
  fatal: 5,
};
function levelEnabled(level: LogLevel, levels: readonly LogLevel[]): boolean {
  return levels.some((configured) => priorities[level] >= priorities[configured]);
}

export class ConsoleLogger implements LoggerService {
  protected context: string;
  protected readonly options: ConsoleLoggerOptions;
  private levels: LogLevel[];
  private previousTimestamp?: number;
  private readonly originalContext: string;

  constructor(options?: ConsoleLoggerOptions);
  constructor(context: string, options?: ConsoleLoggerOptions);
  constructor(
    contextOrOptions: string | ConsoleLoggerOptions = "",
    options: ConsoleLoggerOptions = {},
  ) {
    this.context = typeof contextOrOptions === "string" ? contextOrOptions : "";
    this.options = typeof contextOrOptions === "string" ? options : contextOrOptions;
    this.context = this.context || this.options.context || "";
    this.originalContext = this.context;
    for (const option of [
      "compact",
      "maxArrayLength",
      "maxStringLength",
      "sorted",
      "depth",
      "showHidden",
      "breakLength",
      "structuredParams",
      "flattenParams",
      "redact",
    ] as const) {
      if (this.options[option] !== undefined) {
        throw new Error(`ConsoleLogger option ${option} is not implemented yet.`);
      }
    }
    this.levels = [...(this.options.logLevels ?? LOG_LEVELS)];
  }

  setContext(context: string): void {
    this.context = context;
  }
  resetContext(): void {
    this.context = this.originalContext;
  }
  setLogLevels(levels: LogLevel[]): void {
    this.levels = [...levels];
  }
  isLevelEnabled(level: LogLevel): boolean {
    return levelEnabled(level, this.levels);
  }
  log(message: any, ...params: any[]): void {
    this.write("log", message, params);
  }
  error(message: any, ...params: any[]): void {
    this.write("error", message, params);
  }
  warn(message: any, ...params: any[]): void {
    this.write("warn", message, params);
  }
  debug(message: any, ...params: any[]): void {
    this.write("debug", message, params);
  }
  verbose(message: any, ...params: any[]): void {
    this.write("verbose", message, params);
  }
  fatal(message: any, ...params: any[]): void {
    this.write("fatal", message, params);
  }

  private write(level: LogLevel, message: any, params: any[]): void {
    if (!this.isLevelEnabled(level)) return;
    const values = [...params];
    const context = typeof values.at(-1) === "string" ? values.pop() : this.context;
    const now = Date.now();
    const elapsed =
      this.options.timestamp && this.previousTimestamp !== undefined
        ? ` +${now - this.previousTimestamp}ms`
        : "";
    this.previousTimestamp = now;
    const prefix = `[${this.options.prefix ?? "Nest"}] ${new Date(now).toISOString()} ${level.toUpperCase()}`;
    const color = level === "error" || level === "fatal" ? 31 : level === "warn" ? 33 : 32;
    const label = this.options.colors ? `\u001b[${color}m${prefix}\u001b[0m` : prefix;
    const output = this.options.json
      ? [JSON.stringify({ level, context, message, optionalParams: values, timestamp: now })]
      : [`${label}${context ? ` [${context}]` : ""}${elapsed}`, message, ...values];
    if (level === "error" || level === "fatal") console.error(...output);
    else if (level === "warn") console.warn(...output);
    else console.log(...output);
  }
}

export class Logger implements LoggerService {
  private static instance: LoggerService | false = new ConsoleLogger();
  private static usesDefaultConsole = true;
  private static levels: LogLevel[] = [...LOG_LEVELS];
  private static buffering = false;
  private static readonly buffer: Array<() => void> = [];
  private readonly consoleLogger: ConsoleLogger;

  constructor(
    protected readonly context = "",
    protected readonly options: { timestamp?: boolean } = {},
  ) {
    this.consoleLogger = new ConsoleLogger(context, options);
  }
  get localInstance(): LoggerService {
    return Logger.usesDefaultConsole
      ? this.consoleLogger
      : Logger.instance || new ConsoleLogger({ logLevels: [] });
  }

  log(message: any, ...params: any[]): void {
    this.write("log", message, params);
  }
  error(message: any, ...params: any[]): void {
    this.write("error", message, params);
  }
  warn(message: any, ...params: any[]): void {
    this.write("warn", message, params);
  }
  debug(message: any, ...params: any[]): void {
    this.write("debug", message, params);
  }
  verbose(message: any, ...params: any[]): void {
    this.write("verbose", message, params);
  }
  fatal(message: any, ...params: any[]): void {
    this.write("fatal", message, params);
  }

  static log(message: any, ...params: any[]): void {
    this.emit("log", message, params);
  }
  static error(message: any, ...params: any[]): void {
    this.emit("error", message, params);
  }
  static warn(message: any, ...params: any[]): void {
    this.emit("warn", message, params);
  }
  static debug(message: any, ...params: any[]): void {
    this.emit("debug", message, params);
  }
  static verbose(message: any, ...params: any[]): void {
    this.emit("verbose", message, params);
  }
  static fatal(message: any, ...params: any[]): void {
    this.emit("fatal", message, params);
  }

  static overrideLogger(logger: LoggerService | LogLevel[] | boolean): void {
    if (Array.isArray(logger)) {
      this.levels = [...logger];
      if (this.instance) this.instance.setLogLevels?.(logger);
    } else {
      if (logger instanceof Logger) {
        throw new Error("Logger overrides must implement LoggerService without extending Logger.");
      }
      this.instance = typeof logger === "boolean" ? (logger ? new ConsoleLogger() : false) : logger;
      this.usesDefaultConsole = logger === true;
      this.levels = [...LOG_LEVELS];
    }
  }
  static isLevelEnabled(level: LogLevel): boolean {
    return levelEnabled(level, this.levels);
  }
  static getTimestamp(): string {
    return new Date().toISOString();
  }
  static attachBuffer(): void {
    this.buffering = true;
  }
  static detachBuffer(): void {
    this.buffering = false;
  }
  static flush(): void {
    this.buffering = false;
    const records = this.buffer.splice(0);
    for (const record of records) record();
  }

  private write(level: LogLevel, message: any, params: any[]): void {
    const emit = () => {
      if (Logger.instance && Logger.isLevelEnabled(level)) {
        if (Logger.usesDefaultConsole) this.consoleLogger[level](message, ...params);
        else Logger.instance[level]?.(message, ...params, ...(this.context ? [this.context] : []));
      }
    };
    if (Logger.buffering) Logger.buffer.push(emit);
    else emit();
  }
  private static emit(level: LogLevel, message: any, params: any[]): void {
    const emit = () => {
      if (this.instance && this.isLevelEnabled(level)) this.instance[level]?.(message, ...params);
    };
    if (this.buffering) this.buffer.push(emit);
    else emit();
  }
}
