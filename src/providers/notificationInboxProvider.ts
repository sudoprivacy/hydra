import * as vscode from 'vscode';
import {
  buildNotificationInboxProjection,
  type NotificationInboxGroup,
  type NotificationInboxProjection,
} from '../core/notificationInboxProjection';
import type { NotificationStateService } from '../core/notificationStateService';
import type { HydraNotification } from '../core/notifications';
import {
  buildNotificationTooltip,
  formatNotificationAge,
  formatNotificationDescription,
  formatNotificationDetailLabel,
  formatNotificationSessionLabel,
  getNotificationIcon,
  getNotificationThemeColor,
} from './notificationPresentation';

type NotificationInboxTreeItem = NotificationInboxGroupItem | NotificationInboxNotificationItem;

export class NotificationInboxGroupItem extends vscode.TreeItem {
  public readonly groupId: string;
  public readonly sessionName: string | null;

  constructor(group: NotificationInboxGroup) {
    const label = formatNotificationSessionLabel(group.sessionName) ?? 'Unassigned';
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.groupId = group.id;
    this.sessionName = group.sessionName;
    this.id = `inbox-group:${group.id}`;
    this.contextValue = 'inboxGroupItem';
    this.description = `${group.unreadCount} unread`;
    this.iconPath = new vscode.ThemeIcon(
      getNotificationIcon(group.kind),
      getNotificationThemeColor(group.kind),
    );
    this.tooltip = buildGroupTooltip(group);
  }
}

export class NotificationInboxNotificationItem extends vscode.TreeItem {
  public readonly notificationId: string;
  public readonly sessionName: string | null;
  public readonly notification: HydraNotification;

  constructor(group: NotificationInboxGroup, notification: HydraNotification) {
    super(formatNotificationDetailLabel(notification), vscode.TreeItemCollapsibleState.None);
    this.notification = notification;
    this.notificationId = notification.id;
    this.sessionName = group.sessionName;
    this.id = `inbox-notification:${notification.id}`;
    this.contextValue = 'inboxNotificationItem';
    this.description = formatNotificationDescription(notification) ?? formatNotificationAge(notification.createdAt);
    this.iconPath = new vscode.ThemeIcon(
      getNotificationIcon(notification.kind),
      getNotificationThemeColor(notification.kind),
    );
    this.tooltip = buildNotificationTooltip(notification, 'Click to open this notification and mark it read.');
    this.command = {
      command: 'hydra.openInboxNotification',
      title: 'Open Notification',
      arguments: [this],
    };
  }
}

export class NotificationInboxProvider implements vscode.TreeDataProvider<NotificationInboxTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<NotificationInboxTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private projection: NotificationInboxProjection | undefined;

  constructor(private readonly notifications: NotificationStateService) {}

  refresh(): void {
    this.projection = undefined;
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: NotificationInboxTreeItem): vscode.TreeItem {
    return element;
  }

  getParent(element: NotificationInboxTreeItem): NotificationInboxTreeItem | undefined {
    if (element instanceof NotificationInboxGroupItem) {
      return undefined;
    }
    const projection = this.getProjection();
    const group = projection.groups.find(candidate =>
      candidate.items.some(item => item.notification.id === element.notificationId),
    );
    return group ? new NotificationInboxGroupItem(group) : undefined;
  }

  getChildren(element?: NotificationInboxTreeItem): NotificationInboxTreeItem[] {
    if (!element) {
      return this.getProjection().groups.map(group => new NotificationInboxGroupItem(group));
    }
    if (element instanceof NotificationInboxGroupItem) {
      const group = this.getProjection().groups.find(candidate => candidate.id === element.groupId);
      return group
        ? group.items.map(item => new NotificationInboxNotificationItem(group, item.notification))
        : [];
    }
    return [];
  }

  private getProjection(): NotificationInboxProjection {
    if (!this.projection) {
      this.projection = buildNotificationInboxProjection(this.notifications.getSnapshot());
    }
    return this.projection;
  }
}

function buildGroupTooltip(group: NotificationInboxGroup): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown('**Hydra inbox group**\n\n');
  md.appendMarkdown('- Unread: ');
  md.appendText(String(group.unreadCount));
  md.appendMarkdown('\n');
  md.appendMarkdown('- Top kind: ');
  md.appendText(group.kind);
  md.appendMarkdown('\n');
  if (group.sessionName) {
    md.appendMarkdown('- Session: ');
    md.appendText(group.sessionName);
    md.appendMarkdown('\n');
  }
  md.appendMarkdown('- Grouped by: ');
  md.appendText(group.source);
  md.appendMarkdown('\n');
  md.appendMarkdown('- Latest: ');
  md.appendText(group.latestCreatedAt);
  return md;
}
