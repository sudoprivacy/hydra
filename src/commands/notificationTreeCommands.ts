import * as vscode from 'vscode';
import { NotificationStateService } from '../core/notificationStateService';
import { buildSessionNotificationSummary } from '../core/sessionNotificationSummary';
import { TmuxItem } from '../providers/tmuxSessionProvider';
import { resolveSessionNotificationClearScope } from './notificationScope';
import { resolveSessionName } from './treeItemResolver';
import { openHydraSessionByName, reviewHydraSessionByName } from './openHydraSession';

export interface NotificationTreeCommands {
  openSessionNotification(item?: TmuxItem): Promise<void>;
  openInboxNotification(itemOrId?: unknown): Promise<void>;
  markNotificationRead(itemOrId?: unknown): Promise<void>;
  markSessionNotificationsRead(item?: TmuxItem): Promise<void>;
  clearSessionNotifications(item?: TmuxItem): Promise<void>;
  clearReadNotifications(): Promise<void>;
}

function getNotificationId(item?: unknown): string | undefined {
  if (typeof item === 'string' && item) {
    return item;
  }
  const candidate = item as unknown as { notificationId?: unknown } | undefined;
  return typeof candidate?.notificationId === 'string' && candidate.notificationId
    ? candidate.notificationId
    : undefined;
}

export function createNotificationTreeCommands(
  notificationState: NotificationStateService,
): NotificationTreeCommands {
  const openNotificationById = async (notificationId: string): Promise<void> => {
    const result = notificationState.open(notificationId, 'extension');
    const action = result.action;
    if (!action) {
      vscode.window.showInformationMessage(`Marked notification read: ${result.notification.title}`);
      return;
    }

    if (action.type === 'open-session') {
      await openHydraSessionByName(action.session);
      return;
    }
    if (action.type === 'review-diff') {
      await reviewHydraSessionByName(action.session);
    }
  };

  return {
    async openSessionNotification(item?: TmuxItem): Promise<void> {
      try {
        const notificationId = getNotificationId(item);
        if (notificationId) {
          await openNotificationById(notificationId);
          return;
        }

        const sessionName = resolveSessionName(item);
        if (!sessionName) {
          vscode.window.showErrorMessage('No session selected');
          return;
        }

        const summary = buildSessionNotificationSummary(sessionName, notificationState.getByTargetSession(sessionName));
        if (!summary) {
          vscode.window.showInformationMessage(`No unread notifications for ${sessionName}`);
          return;
        }

        await openNotificationById(summary.attention.id);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to open notification: ${error instanceof Error ? error.message : String(error)}`);
      }
    },

    async openInboxNotification(itemOrId?: unknown): Promise<void> {
      try {
        const notificationId = getNotificationId(itemOrId);
        if (!notificationId) {
          vscode.window.showErrorMessage('No notification selected');
          return;
        }
        await openNotificationById(notificationId);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to open notification: ${error instanceof Error ? error.message : String(error)}`);
      }
    },

    async markNotificationRead(itemOrId?: unknown): Promise<void> {
      try {
        const notificationId = getNotificationId(itemOrId);
        if (!notificationId) {
          vscode.window.showErrorMessage('No notification selected');
          return;
        }
        const result = notificationState.markRead(notificationId, 'extension');
        vscode.window.showInformationMessage(
          result.markedRead === 0
            ? `Notification already read: ${result.notification.title}`
            : `Marked notification read: ${result.notification.title}`,
        );
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to mark notification read: ${error instanceof Error ? error.message : String(error)}`);
      }
    },

    async markSessionNotificationsRead(item?: TmuxItem): Promise<void> {
      try {
        const sessionName = resolveSessionName(item);
        if (!sessionName) {
          vscode.window.showErrorMessage('No session selected');
          return;
        }

        const result = notificationState.markTargetSessionRead(sessionName, 'extension');
        vscode.window.showInformationMessage(
          result.markedRead === 0
            ? `No unread notifications for ${sessionName}`
            : `Marked ${result.markedRead} notification${result.markedRead === 1 ? '' : 's'} read`,
        );
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to mark notifications read: ${error instanceof Error ? error.message : String(error)}`);
      }
    },

    async clearSessionNotifications(item?: TmuxItem): Promise<void> {
      try {
        const sessionName = resolveSessionName(item);
        if (!sessionName) {
          vscode.window.showErrorMessage('No session selected');
          return;
        }

        const clearScope = resolveSessionNotificationClearScope(item, sessionName);
        const count = clearScope.lookup === 'session'
          ? notificationState.getBySession(sessionName).length
          : notificationState.getByTargetSession(sessionName).length;
        if (count === 0) {
          vscode.window.showInformationMessage(`No notifications for ${sessionName}`);
          return;
        }

        const choice = await vscode.window.showWarningMessage(
          `Clear ${count} notification${count === 1 ? '' : 's'} for ${sessionName}?`,
          { modal: true },
          'Clear',
        );
        if (choice !== 'Clear') {
          return;
        }

        const result = notificationState.clear(clearScope.filters, 'extension');
        vscode.window.showInformationMessage(
          `Cleared ${result.cleared} notification${result.cleared === 1 ? '' : 's'}`,
        );
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to clear notifications: ${error instanceof Error ? error.message : String(error)}`);
      }
    },

    async clearReadNotifications(): Promise<void> {
      try {
        const readCount = notificationState.getSnapshot().notifications
          .filter(notification => notification.readAt !== null)
          .length;
        if (readCount === 0) {
          vscode.window.showInformationMessage('No read notifications to clear');
          return;
        }

        const choice = await vscode.window.showWarningMessage(
          `Clear ${readCount} read notification${readCount === 1 ? '' : 's'}?`,
          { modal: true },
          'Clear Read',
        );
        if (choice !== 'Clear Read') {
          return;
        }

        const result = notificationState.clearRead({}, 'extension');
        vscode.window.showInformationMessage(
          `Cleared ${result.cleared} read notification${result.cleared === 1 ? '' : 's'}`,
        );
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to clear read notifications: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}
