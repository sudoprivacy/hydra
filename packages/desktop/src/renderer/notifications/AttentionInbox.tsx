import type { InboxNotificationModel } from '../missionControl/boardModel';
import { relativeTime } from '../missionControl/format';

export interface AttentionInboxProps {
  notifications: readonly InboxNotificationModel[];
  canOpen: (notification: InboxNotificationModel) => boolean;
  onOpen: (notification: InboxNotificationModel) => void;
  onMarkRead: (notification: InboxNotificationModel) => void;
  onDismiss: (notification: InboxNotificationModel) => void;
}

export function AttentionInbox({
  notifications,
  canOpen,
  onOpen,
  onMarkRead,
  onDismiss,
}: AttentionInboxProps): JSX.Element {
  return (
    <section className="hydra-inbox" aria-labelledby="attention-inbox-title">
      <header className="hydra-inbox__head">
        <div>
          <h2 id="attention-inbox-title">Attention Inbox</h2>
          <p>Completion, input requests, and runtime errors across every worker.</p>
        </div>
        <span className="hydra-inbox__count">{notifications.length}</span>
      </header>

      {notifications.length === 0 ? (
        <div className="hydra-inbox__empty">Nothing needs attention.</div>
      ) : (
        <div className="hydra-inbox__rows">
          {notifications.map((notification) => (
            <article
              key={notification.id}
              className={`hydra-inbox-row hydra-inbox-row--${notification.kind}${notification.read ? '' : ' hydra-inbox-row--unread'}`}
            >
              <span className={`hydra-inbox-row__kind hydra-inbox-row__kind--${notification.kind}`}>
                {kindLabel(notification.kind)}
              </span>
              <div className="hydra-inbox-row__content">
                <div className="hydra-inbox-row__title">
                  {notification.title}
                  {!notification.read ? <span className="hydra-inbox-row__new">new</span> : null}
                </div>
                {notification.body ? <p>{notification.body}</p> : null}
                <div className="hydra-inbox-row__meta">
                  <span>{notification.sourceSession ?? 'unknown worker'}</span>
                  <span>→</span>
                  <span>{notification.targetSession ?? 'Global inbox'}</span>
                  <span>·</span>
                  <span>{relativeTime(notification.createdAt)}</span>
                </div>
              </div>
              <div className="hydra-inbox-row__actions">
                <button
                  type="button"
                  className="hydra-btn hydra-btn--sm hydra-btn--primary"
                  disabled={!canOpen(notification)}
                  onClick={() => onOpen(notification)}
                >
                  Open
                </button>
                {!notification.read ? (
                  <button type="button" className="hydra-btn hydra-btn--sm" onClick={() => onMarkRead(notification)}>
                    Mark read
                  </button>
                ) : null}
                <button
                  type="button"
                  className="hydra-btn hydra-btn--sm"
                  onClick={() => onDismiss(notification)}
                >
                  Dismiss
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function kindLabel(kind: InboxNotificationModel['kind']): string {
  switch (kind) {
    case 'complete':
      return 'Complete';
    case 'needs-input':
      return 'Needs input';
    case 'error':
      return 'Error';
  }
}
