/**
 * Smoke test: session notification summary projection.
 *
 * Run: node out/smoke/sessionNotificationSummarySmoke.js
 */

import * as assert from 'assert';
import { buildSessionNotificationSummary } from '../core/sessionNotificationSummary';
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
    targetSession: 'worker_a',
    sourceSession: null,
    ...overrides,
  };
}

function testNoUnread(): void {
  const summary = buildSessionNotificationSummary('worker_a', [
    notification('read', 'error', '2026-01-01T00:00:00.000Z', { readAt: '2026-01-01T00:01:00.000Z' }),
  ]);
  assert.equal(summary, undefined);
}

function testPriorityWins(): void {
  const summary = buildSessionNotificationSummary('worker_a', [
    notification('complete-newer', 'complete', '2026-01-01T00:10:00.000Z'),
    notification('error-older', 'error', '2026-01-01T00:00:00.000Z'),
    notification('blocked', 'blocked', '2026-01-01T00:05:00.000Z'),
  ]);
  assert.ok(summary);
  assert.equal(summary.attention.id, 'error-older');
  assert.equal(summary.kind, 'error');
  assert.equal(summary.badge, 'E');
  assert.match(summary.description, /^3 unread .* error: error title$/);
}

function testNewestWinsWithinPriority(): void {
  const summary = buildSessionNotificationSummary('worker_a', [
    notification('old', 'needs-input', '2026-01-01T00:00:00.000Z'),
    notification('new', 'needs-input', '2026-01-01T00:10:00.000Z'),
  ]);
  assert.ok(summary);
  assert.equal(summary.attention.id, 'new');
  assert.equal(summary.badge, '?');
}

function testTextNormalizationAndTruncation(): void {
  const longTitle = [
    'This',
    'notification',
    'title',
    'has',
    'a',
    'large',
    'amount',
    'of',
    'spacing',
    'and',
    'content',
    'that',
    'must',
    'be',
    'truncated',
  ].join('\n  ');
  const summary = buildSessionNotificationSummary('worker_a', [
    notification('long', 'info', '2026-01-01T00:00:00.000Z', { title: longTitle }),
  ]);
  assert.ok(summary);
  assert.equal(summary.badge, 'i');
  assert.ok(!summary.description.includes('\n'));
  assert.ok(summary.description.endsWith('...'));
  assert.ok(summary.description.length < 120);
}

function testBadgeMapping(): void {
  const cases: Array<[NotificationKind, string]> = [
    ['error', 'E'],
    ['blocked', 'B'],
    ['needs-input', '?'],
    ['complete', 'C'],
    ['info', 'i'],
  ];
  for (const [kind, badge] of cases) {
    const summary = buildSessionNotificationSummary('worker_a', [
      notification(kind, kind, '2026-01-01T00:00:00.000Z'),
    ]);
    assert.ok(summary);
    assert.equal(summary.badge, badge);
  }
}

function main(): void {
  testNoUnread();
  testPriorityWins();
  testNewestWinsWithinPriority();
  testTextNormalizationAndTruncation();
  testBadgeMapping();
  console.log('sessionNotificationSummarySmoke: ok');
}

main();
