import { LogLevel, getTimeOfDay } from '@temporalio/core-bridge';

export type LogMetadata = Record<string | symbol, any>;

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestampNanos: bigint;
  /** Custom attributes */
  meta?: LogMetadata;
}

/**
 * Implement this interface in order to customize worker logging
 */
export interface Logger {
  log(level: LogLevel, message: string, meta?: LogMetadata): any;
  trace(message: string, meta?: LogMetadata): any;
  debug(message: string, meta?: LogMetadata): any;
  info(message: string, meta?: LogMetadata): any;
  warn(message: string, meta?: LogMetadata): any;
  error(message: string, meta?: LogMetadata): any;
}

export { LogLevel };

export const LogTimestamp = Symbol('log_timestamp');

const severities: LogLevel[] = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR'];

/**
 * Log messages using `console.error` and basic formatting
 */
function defaultLogFunction({ level, timestampNanos, message, meta }: LogEntry): void {
  const date = new Date(Number(timestampNanos / 1_000_000n));
  if (meta === undefined) {
    console.error(date, `[${level}]`, message);
  } else {
    console.error(date, `[${level}]`, message, meta);
  }
}

/**
 * Takes a `[seconds, nanos]` tuple as returned from getTimeOfDay and turns it into bigint.
 */
export function timeOfDayToBigint([seconds, nanos]: [number, number]): bigint {
  return BigInt(seconds) * 1_000_000_000n + BigInt(nanos);
}

/**
 * Default worker logger - uses a default log function to log messages to `console.error`.
 * See constructor arguments for customization.
 */
export class DefaultLogger implements Logger {
  protected readonly severity: number;

  constructor(public readonly level: LogLevel = 'INFO', protected readonly logFunction = defaultLogFunction) {
    this.severity = severities.indexOf(this.level);
  }

  log(level: LogLevel, message: string, meta?: LogMetadata): void {
    if (severities.indexOf(level) >= this.severity) {
      const { [LogTimestamp]: timestampNanos, ...rest } = meta ?? {};
      this.logFunction({
        level,
        message,
        meta: Object.keys(rest).length === 0 ? undefined : rest,
        timestampNanos: timestampNanos ?? timeOfDayToBigint(getTimeOfDay()),
      });
    }
  }

  trace(message: string, meta?: LogMetadata): void {
    this.log('TRACE', message, meta);
  }

  debug(message: string, meta?: LogMetadata): void {
    this.log('DEBUG', message, meta);
  }

  info(message: string, meta?: LogMetadata): void {
    this.log('INFO', message, meta);
  }

  warn(message: string, meta?: LogMetadata): void {
    this.log('WARN', message, meta);
  }

  error(message: string, meta?: LogMetadata): void {
    this.log('ERROR', message, meta);
  }
}
