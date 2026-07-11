// The wire vocabulary — the single source of truth for op/topic names, shared
// by the client (which builds `transport.request(op, ...)`) and the server
// (`HydraAppService`, which dispatches on the same strings). Keeping them here
// means the two sides can never drift, and a future `RestWsTransport` speaks
// the exact same op names as `InProcessTransport`.
//
// Names mirror the CLI verbs (docs/cli-contract.md) so scripts, copilots, and
// the desktop app share one domain language.

/** Request/response operations, carried by `HydraTransport.request`. */
export const Op = {
  listSessions: 'sessions.list',
  listWorkerRuntimeV2: 'workerRuntime.v2.list',
  createWorker: 'worker.create',
  createCopilot: 'copilot.create',
  startSession: 'session.start',
  stopWorker: 'worker.stop',
  deleteSession: 'session.delete',
  renameSession: 'session.rename',
  restoreSession: 'session.restore',
  getLogs: 'session.logs',
  sendMessage: 'session.send',
  broadcastToWorkers: 'worker.broadcast',
  listNotifications: 'notifications.list',
  listNotificationOccurrencesV2: 'notifications.v2.list',
  markNotificationRead: 'notifications.markRead',
  dismissNotification: 'notifications.dismiss',
  clearNotifications: 'notifications.clear',
  getDiff: 'diff.get',
  getFileSnapshot: 'diff.fileSnapshot',
  // App-internal — NOT a CLI verb (absent from docs/cli-contract.md). Powers the
  // sidebar's per-code-worker `git status --porcelain` change count (`U:N`).
  getGitStatus: 'gitStatus.get',
} as const;

export type OpName = (typeof Op)[keyof typeof Op];

/** Streaming subscriptions, carried by `HydraTransport.stream`. */
export const Topic = {
  events: 'events',
  notifications: 'notifications',
  notificationOccurrencesV2: 'notifications-v2',
} as const;

export type TopicName = (typeof Topic)[keyof typeof Topic];
