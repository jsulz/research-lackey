import type { Logger, LogLevel } from "../core/ports";

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Parses a LOG_LEVEL value. Anything unrecognized falls back to `info`. */
export function parseLogLevel(value: string | undefined): LogLevel {
  const v = (value ?? "").trim().toLowerCase();
  return v in RANK ? (v as LogLevel) : "info";
}

type Sink = (line: string) => void;

/** Writes one JSON line per call at or above `level`. */
export class JsonLogger implements Logger {
  constructor(
    private readonly level: LogLevel,
    private readonly sink: Sink = (line) => console.log(line),
  ) {}

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.write("debug", msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>): void {
    this.write("info", msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>): void {
    this.write("warn", msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>): void {
    this.write("error", msg, fields);
  }

  private write(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (RANK[level] < RANK[this.level]) return;
    this.sink(JSON.stringify({ ...fields, level, msg }));
  }
}
