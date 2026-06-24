/**
 * Smoke test: notification inbox projection.
 *
 * Run: node out/smoke/notificationInboxProjectionSmoke.js
 */

import assert from 'node:assert/strict';
import { buildNotificationInboxProjection } from '../core/notificationInboxProjection';
import type { NotificationSnapshot } from '../core/notificationState';
import type { HydraNotification, NotificationKind } from '../core/notifications';

function notification(
  id: string,
  kind: NotificationKind,
  createdAt: string,
  overrides: Partial<HydraNotification> = {},
): HydraNotification {
  return {
    id,
    createdAt,
    readAt: null,
    kind,
    title: `${kind} title`,
    body: '',
    targetSession: 'repo_copilot',
    sourceSession: 'repo_worker',
    ...overrides,
  };
}

function snapshot(notifications: HydraNotification[]): NotificationSnapshot {
  return {
    loadedAt: '2026-06-24T00:00:00.000Z',
    lastEventSeq: 42,
    notifications,
    totalCount: notifications.length,
    unreadCount: notifications.filter(item => item.readAt === null).length,
  };
}

function testUnreadOnlyAndNoDuplicateTargetSource(): void {
  const projection = buildNotificationInboxProjection(snapshot([
    notification('read', 'error', '2026-06-24T00:00:00.000Z', {
      readAt: '2026-06-24T00:01:00.000Z',
    }),
    notification('target-source', 'complete', '2026-06-24T00:02:00.000Z', {
      targetSession: 'repo_copilot',
      sourceSession: 'repo_worker',
    }),
  ]));

  assert.equal(projection.loadedAt, '2026-06-24T00:00:00.000Z');
  assert.equal(projection.lastEventSeq, 42);
  assert.equal(projection.unreadCount, 1);
  assert.deepEqual(projection.items.map(item => item.notification.id), ['target-source']);
  assert.equal(projection.groups.length, 1);
  assert.equal(projection.groups[0].id, 'target:repo_copilot');
  assert.equal(projection.groups[0].source, 'target');
  assert.equal(projection.groups[0].items.length, 1);
}

function testPriorityAndNewestOrdering(): void {
  const projection = buildNotificationInboxProjection(snapshot([
    notification('complete-newest', 'complete', '2026-06-24T00:10:00.000Z'),
    notification('needs-input-old', 'needs-input', '2026-06-24T00:00:00.000Z'),
    notification('blocked-middle', 'blocked', '2026-06-24T00:05:00.000Z'),
    notification('needs-input-new', 'needs-input', '2026-06-24T00:06:00.000Z'),
  ]));

  assert.deepEqual(
    projection.items.map(item => item.notification.id),
    ['blocked-middle', 'needs-input-new', 'needs-input-old', 'complete-newest'],
  );
  assert.equal(projection.groups[0].kind, 'blocked');
}

function testSourceAndUnassignedFallbackGroups(): void {
  const projection = buildNotificationInboxProjection(snapshot([
    notification('source-only', 'info', '2026-06-24T00:00:00.000Z', {
      targetSession: null,
      sourceSession: 'orphan_worker',
    }),
    notification('unassigned', 'error', '2026-06-24T00:01:00.000Z', {
      targetSession: null,
      sourceSession: null,
    }),
  ]));

  assert.deepEqual(
    projection.groups.map(group => group.id),
    ['unassigned', 'source:orphan_worker'],
  );
  assert.equal(projection.groups[0].source, 'unassigned');
  assert.equal(projection.groups[1].source, 'source');
  assert.equal(projection.groups[1].sessionName, 'orphan_worker');
}

function testStableTieBreakById(): void {
  const projection = buildNotificationInboxProjection(snapshot([
    notification('b', 'info', '2026-06-24T00:00:00.000Z'),
    notification('a', 'info', '2026-06-24T00:00:00.000Z'),
  ]));

  assert.deepEqual(projection.items.map(item => item.notification.id), ['a', 'b']);
}

function main(): void {
  testUnreadOnlyAndNoDuplicateTargetSource();
  testPriorityAndNewestOrdering();
  testSourceAndUnassignedFallbackGroups();
  testStableTieBreakById();
  console.log('notificationInboxProjectionSmoke: ok');
}

main();
