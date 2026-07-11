import { AsyncPushIterator } from './asyncPushIterator';
import { EventLog, type Disposable, type HydraEvent } from './events';
import { logger } from './logger';

export interface EventHubOptions {
  pollIntervalMs?: number;
  maxHistoryEvents?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_MAX_HISTORY_EVENTS = 100_000;

/** One retained-log load, one external-writer tailer, and in-process fan-out. */
export class EventHub implements Disposable {
  private readonly subscribers = new Set<AsyncPushIterator<HydraEvent>>();
  private readonly pollIntervalMs: number;
  private readonly maxHistoryEvents: number;
  private history: HydraEvent[] = [];
  private cursor = 0;
  private started = false;
  private disposed = false;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private appendSubscription: Disposable | undefined;

  constructor(
    private readonly eventLog: EventLog = new EventLog(),
    options: EventHubOptions = {},
  ) {
    this.pollIntervalMs = Math.max(10, Math.trunc(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS));
    this.maxHistoryEvents = Math.max(1, Math.trunc(options.maxHistoryEvents ?? DEFAULT_MAX_HISTORY_EVENTS));
  }

  subscribe(after = 0): AsyncIterableIterator<HydraEvent> {
    if (this.disposed) throw new Error('EventHub is disposed');
    this.start();
    let subscription: AsyncPushIterator<HydraEvent>;
    subscription = new AsyncPushIterator(() => {
      this.subscribers.delete(subscription);
      if (this.subscribers.size === 0) this.stop();
    });
    this.subscribers.add(subscription);
    for (const event of this.history) {
      if (event.seq > after) subscription.push(event);
    }
    return subscription;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const subscriber of [...this.subscribers]) subscriber.close();
    this.stop();
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    const appendedDuringLoad: HydraEvent[] = [];
    let loading = true;
    this.appendSubscription = this.eventLog.onDidAppend(event => {
      if (loading) appendedDuringLoad.push(event);
      else this.publishLocalAppend(event);
    });
    let retained: HydraEvent[];
    try {
      retained = this.eventLog.read({ after: 0, tolerateIncompleteTail: true });
    } catch (error) {
      loading = false;
      this.appendSubscription.dispose();
      this.appendSubscription = undefined;
      this.started = false;
      throw error;
    }
    loading = false;
    this.history = [];
    this.cursor = 0;
    for (const event of [...retained, ...appendedDuringLoad].sort((a, b) => a.seq - b.seq)) {
      this.publish(event);
    }
    this.schedulePoll();
  }

  private stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    this.appendSubscription?.dispose();
    this.appendSubscription = undefined;
    this.history = [];
    this.cursor = 0;
  }

  private schedulePoll(): void {
    if (!this.started || this.pollTimer) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      if (!this.started) return;
      try {
        const events = this.eventLog.read({ after: this.cursor, tolerateIncompleteTail: true });
        for (const event of events) this.publish(event);
      } catch (error) {
        logger.warn('event-hub.tail', 'Failed to read new Hydra events', { error });
      }
      this.schedulePoll();
    }, this.pollIntervalMs);
  }

  private publish(event: HydraEvent): void {
    if (event.seq <= this.cursor) return;
    this.cursor = event.seq;
    this.history.push(event);
    if (this.history.length > this.maxHistoryEvents) {
      this.history.splice(0, this.history.length - this.maxHistoryEvents);
    }
    for (const subscriber of this.subscribers) subscriber.push(event);
  }

  private publishLocalAppend(event: HydraEvent): void {
    if (event.seq > this.cursor + 1) {
      try {
        const missing = this.eventLog.read({ after: this.cursor, tolerateIncompleteTail: true });
        for (const candidate of missing) this.publish(candidate);
        return;
      } catch (error) {
        logger.warn('event-hub.gap', 'Failed to fill an event sequence gap before local fan-out', {
          cursor: this.cursor,
          eventSeq: event.seq,
          error,
        });
      }
    }
    this.publish(event);
  }
}
