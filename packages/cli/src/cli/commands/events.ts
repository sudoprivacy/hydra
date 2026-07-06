import { Command } from 'commander';
import {
  EventLog,
  readCursorFile,
  writeCursorFile,
  type HydraEvent,
} from '../../core/events';
import { outputError, outputResult, type OutputOpts } from '../output';

interface EventsOptions {
  after?: string;
  follow?: boolean;
  cursorFile?: string;
}

const FOLLOW_POLL_INTERVAL_MS = 250;

export function registerEventsCommand(program: Command): void {
  program
    .command('events')
    .description('Read Hydra local event stream')
    .option('--after <seq>', 'Only return events with seq greater than this value')
    .option('--follow', 'Keep streaming new events as JSON lines')
    .option('--cursor-file <path>', 'Read the starting seq from a cursor file and update it after printing events')
    .action(async (opts: EventsOptions) => {
      const globalOpts = program.opts() as OutputOpts;
      try {
        const log = new EventLog();
        let after = opts.after != null
          ? parseSeq(opts.after, '--after')
          : opts.cursorFile
            ? readCursorFile(opts.cursorFile)
            : 0;

        if (!opts.follow) {
          const events = log.read({ after });
          const lastSeq = events.length > 0 ? events[events.length - 1].seq : after;
          if (opts.cursorFile && events.length > 0) {
            writeCursorFile(opts.cursorFile, lastSeq);
          }
          outputResult(
            {
              status: 'ok',
              events,
              count: events.length,
              lastSeq,
            },
            globalOpts,
            () => {
              if (events.length === 0) {
                console.log('No events.');
                return;
              }
              for (const event of events) {
                printPrettyEvent(event);
              }
            },
          );
          return;
        }

        while (true) {
          const events = log.read({ after, tolerateIncompleteTail: true });
          for (const event of events) {
            if (!globalOpts.quiet) {
              if (globalOpts.json) {
                process.stdout.write(`${JSON.stringify(event)}\n`);
              } else {
                printPrettyEvent(event);
              }
            }
            after = event.seq;
            if (opts.cursorFile) {
              writeCursorFile(opts.cursorFile, after);
            }
          }
          await sleep(FOLLOW_POLL_INTERVAL_MS);
        }
      } catch (error) {
        outputError(error, globalOpts);
      }
    });
}

function parseSeq(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return parsed;
}

function printPrettyEvent(event: HydraEvent): void {
  const session = event.session ? ` session=${event.session}` : '';
  const role = event.role ? ` role=${event.role}` : '';
  const agent = event.agent ? ` agent=${event.agent}` : '';
  console.log(`#${event.seq} ${event.ts} ${event.type}${session}${role}${agent}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
