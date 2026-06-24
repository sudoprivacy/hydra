import { Command, Option } from 'commander';
import { isHydraEventSource, type HydraEventSource } from '../../core/events';
import {
  isNotificationKind,
  NotificationStore,
  type NotificationAction,
  type NotificationKind,
  type NotificationListFilters,
} from '../../core/notifications';
import { outputError, outputResult, type OutputOpts } from '../output';

interface NotifyCreateOptions {
  session?: string;
  from?: string;
  kind?: string;
  title?: string;
  body?: string;
  dedupeKey?: string;
  action?: string;
  actionSession?: string;
  workerId?: string;
  branch?: string;
  workdir?: string;
  agent?: string;
  eventSource?: string;
}

interface NotifyListOptions {
  session?: string;
  target?: string;
  from?: string;
  kind?: string;
  unread?: boolean;
  limit?: string;
}

interface NotifyClearOptions {
  session?: string;
  target?: string;
  from?: string;
  read?: boolean;
}

export function registerNotifyCommands(program: Command): void {
  const notify = program
    .command('notify')
    .description('Create and manage Hydra notifications');

  notify
    .command('create')
    .description('Create a structured Hydra notification')
    .option('--session <target>', 'Target session for the notification')
    .option('--from <source>', 'Source session that created the notification')
    .option('--kind <kind>', 'Notification kind: complete, needs-input, error, blocked, info', 'info')
    .option('--title <text>', 'Notification title')
    .option('--body <text>', 'Notification body', '')
    .option('--dedupe-key <key>', 'Idempotency key for repeated hook attempts')
    .option('--action <type>', 'Notification action: open-session or review-diff')
    .option('--action-session <session>', 'Session for the notification action')
    .option('--worker-id <number>', 'Worker number for notification context')
    .option('--branch <branch>', 'Branch name for notification context')
    .option('--workdir <path>', 'Workdir for notification context')
    .option('--agent <agent>', 'Agent for notification context')
    .addOption(new Option('--event-source <source>').hideHelp())
    .action((opts: NotifyCreateOptions) => {
      const globalOpts = program.opts() as OutputOpts;
      try {
        const store = new NotificationStore();
        const kind = parseKind(opts.kind);
        const title = opts.title?.trim();
        if (!title) {
          throw new Error('--title is required');
        }
        const action = parseAction(opts.action, opts.actionSession || opts.from);
        const workerId = parseOptionalInteger(opts.workerId, '--worker-id');
        const result = store.create({
          kind,
          title,
          body: opts.body || '',
          targetSession: opts.session || null,
          sourceSession: opts.from || null,
          dedupeKey: opts.dedupeKey,
          action,
          context: {
            workerId,
            branch: opts.branch ?? null,
            workdir: opts.workdir ?? null,
            agent: opts.agent ?? null,
          },
          eventSource: parseEventSource(opts.eventSource),
        });

        outputResult(
          {
            status: result.created ? 'created' : 'exists',
            created: result.created,
            notification: result.notification,
          },
          globalOpts,
          () => {
            const verb = result.created ? 'Created' : 'Existing';
            console.log(`${verb} notification ${result.notification.id}: ${result.notification.title}`);
          },
        );
      } catch (error) {
        outputError(error, globalOpts);
      }
    });

  notify
    .command('list')
    .description('List structured Hydra notifications')
    .option('--session <session>', 'Filter by target or source session')
    .option('--target <session>', 'Filter by target session')
    .option('--from <session>', 'Filter by source session')
    .option('--kind <kind>', 'Filter by notification kind')
    .option('--unread', 'Show unread notifications only')
    .option('--limit <number>', 'Limit number of notifications returned')
    .action((opts: NotifyListOptions) => {
      const globalOpts = program.opts() as OutputOpts;
      try {
        const filters: NotificationListFilters = {
          session: opts.session,
          targetSession: opts.target,
          sourceSession: opts.from,
          kind: opts.kind ? parseKind(opts.kind) : undefined,
          unread: opts.unread === true,
          limit: parseOptionalInteger(opts.limit, '--limit'),
        };
        const result = new NotificationStore().list(filters);
        outputResult(
          {
            status: 'ok',
            notifications: result.notifications,
            count: result.count,
            unreadCount: result.unreadCount,
            totalCount: result.totalCount,
          },
          globalOpts,
          () => {
            if (result.notifications.length === 0) {
              console.log('No notifications.');
              return;
            }
            for (const notification of result.notifications) {
              const read = notification.readAt ? 'read' : 'unread';
              console.log(`[${read}] ${notification.id} ${notification.kind}: ${notification.title}`);
              if (notification.body) {
                console.log(`  ${notification.body}`);
              }
            }
          },
        );
      } catch (error) {
        outputError(error, globalOpts);
      }
    });

  notify
    .command('read <id>')
    .description('Mark a Hydra notification as read')
    .action((id: string) => {
      const globalOpts = program.opts() as OutputOpts;
      try {
        const result = new NotificationStore().markRead(id);
        outputResult(
          {
            status: 'ok',
            notification: result.notification,
            markedRead: result.markedRead,
          },
          globalOpts,
          () => {
            console.log(`Marked read: ${result.notification.id}`);
          },
        );
      } catch (error) {
        outputError(error, globalOpts);
      }
    });

  notify
    .command('clear')
    .description('Clear Hydra notifications')
    .option('--session <session>', 'Clear notifications for a target or source session')
    .option('--target <session>', 'Clear notifications for a target session')
    .option('--from <session>', 'Clear notifications from a source session')
    .option('--read', 'Clear read notifications only')
    .action((opts: NotifyClearOptions) => {
      const globalOpts = program.opts() as OutputOpts;
      try {
        const filters = {
          session: opts.session,
          targetSession: opts.target,
          sourceSession: opts.from,
        };
        const result = opts.read
          ? new NotificationStore().clearRead(filters)
          : new NotificationStore().clear(filters);
        outputResult(
          {
            status: 'ok',
            cleared: result.cleared,
          },
          globalOpts,
          () => {
            const qualifier = opts.read ? ' read' : '';
            console.log(`Cleared ${result.cleared}${qualifier} notification${result.cleared === 1 ? '' : 's'}.`);
          },
        );
      } catch (error) {
        outputError(error, globalOpts);
      }
    });

  notify
    .command('open <id>')
    .description('Mark a notification read and return its action')
    .action((id: string) => {
      const globalOpts = program.opts() as OutputOpts;
      try {
        const result = new NotificationStore().open(id);
        outputResult(
          {
            status: 'ok',
            opened: result.opened,
            notification: result.notification,
            action: result.action,
            markedRead: result.markedRead,
          },
          globalOpts,
          () => {
            const action = result.action ? ` action=${result.action.type}:${result.action.session}` : '';
            console.log(`Opened notification data: ${result.notification.id}${action}`);
          },
        );
      } catch (error) {
        outputError(error, globalOpts);
      }
    });
}

function parseEventSource(value: string | undefined): HydraEventSource {
  const normalized = (value || 'cli').trim();
  if (isHydraEventSource(normalized)) {
    return normalized;
  }
  throw new Error(`Invalid event source "${value}". Expected: cli, extension, session-manager, or hook.`);
}

function parseKind(value: string | undefined): NotificationKind {
  const normalized = (value || 'info').trim();
  if (isNotificationKind(normalized)) {
    return normalized;
  }
  throw new Error(`Invalid notification kind "${value}". Expected: complete, needs-input, error, blocked, info.`);
}

function parseAction(type: string | undefined, fallbackSession: string | undefined): NotificationAction | undefined {
  if (!type) {
    return undefined;
  }
  const normalized = type.trim();
  if (normalized !== 'open-session' && normalized !== 'review-diff') {
    throw new Error(`Invalid notification action "${type}". Expected: open-session or review-diff.`);
  }
  const session = fallbackSession?.trim();
  if (!session) {
    throw new Error('--action-session is required when --action is set');
  }
  return { type: normalized, session };
}

function parseOptionalInteger(value: string | undefined, flag: string): number | undefined {
  if (value == null) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return parsed;
}
