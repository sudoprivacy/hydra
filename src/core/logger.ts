import * as os from 'os';
import { appendRotatingLog, appendRotatingLogSync, DEFAULT_LOG_MAX_FILE_SIZE_BYTES, DEFAULT_LOG_MAX_FILES, ensureLogDirectorySync, type LogRotationOptions } from './logRotation';
import { sanitizeLogContext, type SanitizedLogValue } from './logRedaction';
import { getHydraLogFile, getHydraLogsDir } from './path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  scope: string;
  message: string;
  platform: string;
  pid: number;
  [key: string]: SanitizedLogValue | string | number;
}

export type LogContext = Record<string, unknown>;
export type LogSink = (entry: LogEntry, line: string) => void;

export interface LoggerConfig extends Partial<LogRotationOptions> {
  level?: LogLevel;
  filePath?: string;
  flushDelayMs?: number;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const DEFAULT_FLUSH_DELAY_MS = 100;

class HydraLogger {
  private queue: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private flushInProgress: Promise<void> | undefined;
  private sinks = new Set<LogSink>();
  private config: Required<Pick<LoggerConfig, 'level' | 'flushDelayMs'>> & {
    filePath?: string;
    maxFileSizeBytes: number;
    maxFiles: number;
  } = {
    level: 'info',
    flushDelayMs: DEFAULT_FLUSH_DELAY_MS,
    maxFileSizeBytes: DEFAULT_LOG_MAX_FILE_SIZE_BYTES,
    maxFiles: DEFAULT_LOG_MAX_FILES,
  };

  configure(config: LoggerConfig): void {
    if (config.level && isLogLevel(config.level)) {
      this.config.level = config.level;
    }
    if (config.filePath) {
      this.config.filePath = config.filePath;
    }
    if (Number.isFinite(config.maxFileSizeBytes)) {
      this.config.maxFileSizeBytes = Math.max(1024, Math.floor(config.maxFileSizeBytes!));
    }
    if (Number.isFinite(config.maxFiles)) {
      this.config.maxFiles = Math.max(1, Math.floor(config.maxFiles!));
    }
    if (Number.isFinite(config.flushDelayMs)) {
      this.config.flushDelayMs = Math.max(0, Math.floor(config.flushDelayMs!));
    }
  }

  addSink(sink: LogSink): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  debug(scope: string, message: string, context?: LogContext): void {
    this.log('debug', scope, message, context);
  }

  info(scope: string, message: string, context?: LogContext): void {
    this.log('info', scope, message, context);
  }

  warn(scope: string, message: string, context?: LogContext): void {
    this.log('warn', scope, message, context);
  }

  error(scope: string, message: string, context?: LogContext): void {
    this.log('error', scope, message, context);
  }

  log(level: LogLevel, scope: string, message: string, context?: LogContext): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      scope,
      message,
      platform: process.platform,
      pid: process.pid,
      ...sanitizeLogContext(context),
    };
    const line = `${JSON.stringify(entry)}\n`;

    for (const sink of this.sinks) {
      try {
        sink(entry, line);
      } catch {
        // Sink failures must not affect Hydra.
      }
    }

    this.queue.push(line);
    this.scheduleFlush();
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.flushInProgress) {
      await this.flushInProgress.catch(() => {});
    }
    const lines = this.drainQueue();
    if (!lines) {
      return;
    }
    const filePath = this.getFilePath();
    const rotation = this.getRotationOptions();
    this.flushInProgress = appendRotatingLog(filePath, lines, rotation)
      .catch(() => {})
      .finally(() => {
        this.flushInProgress = undefined;
      });
    await this.flushInProgress;
  }

  flushSync(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    const lines = this.drainQueue();
    if (!lines) {
      return;
    }
    try {
      appendRotatingLogSync(this.getFilePath(), lines, this.getRotationOptions());
    } catch {
      // Logging must not crash Hydra.
    }
  }

  getLogFilePath(): string {
    return this.getFilePath();
  }

  getLogsDir(): string {
    return getHydraLogsDir();
  }

  ensureLogsDir(): void {
    ensureLogDirectorySync(this.getLogsDir());
  }

  resetForTests(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.queue = [];
    this.flushInProgress = undefined;
    this.sinks.clear();
    this.config = {
      level: 'info',
      flushDelayMs: DEFAULT_FLUSH_DELAY_MS,
      maxFileSizeBytes: DEFAULT_LOG_MAX_FILE_SIZE_BYTES,
      maxFiles: DEFAULT_LOG_MAX_FILES,
    };
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.config.level];
  }

  private scheduleFlush(): void {
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, this.config.flushDelayMs);
  }

  private drainQueue(): string {
    const lines = this.queue.join('');
    this.queue = [];
    return lines;
  }

  private getFilePath(): string {
    return this.config.filePath || getHydraLogFile();
  }

  private getRotationOptions(): LogRotationOptions {
    return {
      maxFileSizeBytes: this.config.maxFileSizeBytes,
      maxFiles: this.config.maxFiles,
    };
  }
}

export const logger = new HydraLogger();

export function isLogLevel(value: string): value is LogLevel {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error';
}

export function formatLogEntryForOutput(entry: LogEntry): string {
  const details = Object.entries(entry)
    .filter(([key]) => !['ts', 'level', 'scope', 'message', 'platform', 'pid'].includes(key))
    .map(([key, value]) => `${key}=${formatOutputValue(value)}`)
    .join(' ');
  return `[${entry.ts}] [${entry.level}] ${entry.scope}: ${entry.message}${details ? ` ${details}` : ''}`;
}

function formatOutputValue(value: unknown): string {
  if (typeof value === 'string') {
    return value.includes(' ') ? JSON.stringify(value) : value;
  }
  return JSON.stringify(value);
}

export function getHydraLogsDirectory(): string {
  return getHydraLogsDir();
}

export function getHydraLogFilePath(): string {
  return getHydraLogFile();
}

export function getHostSummary(): Record<string, string | number> {
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    pid: process.pid,
    home: os.homedir(),
  };
}
