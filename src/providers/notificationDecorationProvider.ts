import * as vscode from 'vscode';
import {
  buildSessionNotificationSummary,
  type SessionNotificationSource,
} from '../core/sessionNotificationSummary';
import type { NotificationKind } from '../core/notifications';

const NOTIFICATION_DECORATION_SCHEME = 'hydra-notification';
const NOTIFICATION_DECORATION_AUTHORITY = 'session';

export function getNotificationDecorationUri(sessionName: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: NOTIFICATION_DECORATION_SCHEME,
    authority: NOTIFICATION_DECORATION_AUTHORITY,
    path: `/${encodeURIComponent(sessionName)}`,
  });
}

export function parseNotificationDecorationUri(uri: vscode.Uri): string | undefined {
  if (uri.scheme !== NOTIFICATION_DECORATION_SCHEME || uri.authority !== NOTIFICATION_DECORATION_AUTHORITY) {
    return undefined;
  }
  const encoded = uri.path.replace(/^\//, '');
  if (!encoded) {
    return undefined;
  }
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}

export class NotificationDecorationProvider implements vscode.FileDecorationProvider {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.onDidChangeEmitter.event;

  constructor(private readonly notifications: SessionNotificationSource) {}

  provideFileDecoration(uri: vscode.Uri): vscode.ProviderResult<vscode.FileDecoration> {
    const sessionName = parseNotificationDecorationUri(uri);
    if (!sessionName) {
      return undefined;
    }

    const summary = buildSessionNotificationSummary(sessionName, this.notifications.getByTargetSession(sessionName));
    if (!summary) {
      const completion = this.notifications.getLatestSourceCompletion?.(sessionName);
      return completion
        ? new vscode.FileDecoration('C', 'Hydra worker completed', getDecorationColor('complete'))
        : undefined;
    }

    return new vscode.FileDecoration(
      summary.badge,
      `${summary.unreadCount} unread Hydra notification${summary.unreadCount === 1 ? '' : 's'}`,
      getDecorationColor(summary.kind),
    );
  }

  refresh(): void {
    this.onDidChangeEmitter.fire(undefined);
  }
}

function getDecorationColor(kind: NotificationKind): vscode.ThemeColor {
  switch (kind) {
    case 'error':
      return new vscode.ThemeColor('charts.red');
    case 'blocked':
      return new vscode.ThemeColor('charts.purple');
    case 'needs-input':
      return new vscode.ThemeColor('charts.yellow');
    case 'complete':
      return new vscode.ThemeColor('charts.green');
    case 'info':
      return new vscode.ThemeColor('charts.blue');
  }
}
