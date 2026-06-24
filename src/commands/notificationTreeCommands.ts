import * as vscode from 'vscode';
import { NotificationStateService } from '../core/notificationStateService';
import { buildSessionNotificationSummary } from '../core/sessionNotificationSummary';
import { TmuxItem } from '../providers/tmuxSessionProvider';
import { resolveSessionNotificationClearScope } from './notificationScope';
import { resolveSessionName } from './treeItemResolver';
import { openHydraSessionByName, reviewHydraSessionByName } from './openHydraSession';

export interface NotificationTreeCommands {
  openSessionNotification(item?: TmuxItem): Promise<void>;
  markSessionNotificationsRead(item?: TmuxItem): Promise<void>;
  clearSessionNotifications(item?: TmuxItem): Promise<void>;
}

function getNotificationId(item?: TmuxItem): string | undefined {
  const candidate = item as unknown as { notificationId?: unknown } | undefined;
  return typeof candidate?.notificationId === 'string' && candidate.notificationId
    ? candidate.notificationId
    : undefined;
}

export function createNotificationTreeCommands(
  notificationState: NotificationStateService,
): NotificationTreeCommands {
  return {
    async openSessionNotification(item?: TmuxItem): Promise<void> {
      try {
        const sessionName = resolveSessionName(item);
        if (!sessionName) {
          vscode.window.showErrorMessage('No session selected');
          return;
        }

        const notificationId = getNotificationId(item);
        let targetNotificationId = notificationId;
        if (!targetNotificationId) {
          const summary = buildSessionNotificationSummary(sessionName, notificationState.getByTargetSession(sessionName));
          if (!summary) {
            vscode.window.showInformationMessage(`No unread notifications for ${sessionName}`);
            return;
          }
          targetNotificationId = summary.attention.id;
        }

        const result = notificationState.open(targetNotificationId, 'extension');
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
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to open notification: ${error instanceof Error ? error.message : String(error)}`);
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
  };
}
