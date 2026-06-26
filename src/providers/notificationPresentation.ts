import * as vscode from 'vscode';
import type { HydraNotification, NotificationKind } from '../core/notifications';

export function getNotificationThemeColor(kind: NotificationKind): vscode.ThemeColor {
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

export function getNotificationIcon(kind: NotificationKind): string {
  switch (kind) {
    case 'error':
      return 'error';
    case 'blocked':
    case 'needs-input':
      return 'warning';
    case 'complete':
      return 'pass';
    case 'info':
      return 'info';
  }
}

export function formatNotificationDetailLabel(notification: HydraNotification): string {
  const title = notification.title || notification.body || 'Notification';
  return notification.kind === 'complete'
    ? title
    : `${notification.kind}: ${title}`;
}

export function formatNotificationSessionLabel(sessionName: string | null): string | undefined {
  if (!sessionName) return undefined;
  return sessionName.replace(/^task_/, '');
}

export function formatNotificationDescription(notification: HydraNotification): string | undefined {
  const parts = [
    formatNotificationSessionLabel(notification.sourceSession),
    formatNotificationAge(notification.createdAt),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' - ') : undefined;
}

export function formatNotificationAge(createdAt: string): string | undefined {
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }

  const now = Math.floor(Date.now() / 1000);
  const diffSec = now - Math.floor(timestamp / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);

  if (diffMin < 1) return 'now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function buildNotificationTooltip(
  notification: HydraNotification,
  footer: string,
): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown('**Hydra notification**\n\n');
  md.appendMarkdown('- Kind: ');
  md.appendText(notification.kind);
  md.appendMarkdown('\n');
  md.appendMarkdown('- Title: ');
  md.appendText(notification.title);
  md.appendMarkdown('\n');
  if (notification.body) {
    md.appendMarkdown('- Body: ');
    md.appendText(notification.body);
    md.appendMarkdown('\n');
  }
  md.appendMarkdown('- Created: ');
  md.appendText(notification.createdAt);
  md.appendMarkdown('\n');
  if (notification.targetSession) {
    md.appendMarkdown('- Target: ');
    md.appendText(notification.targetSession);
    md.appendMarkdown('\n');
  }
  if (notification.sourceSession) {
    md.appendMarkdown('- Source: ');
    md.appendText(notification.sourceSession);
    md.appendMarkdown('\n');
  }
  if (notification.action) {
    md.appendMarkdown('- Action: ');
    md.appendText(`${notification.action.type}:${notification.action.session}`);
    md.appendMarkdown('\n');
  }
  md.appendMarkdown('\n');
  md.appendText(footer);
  return md;
}
