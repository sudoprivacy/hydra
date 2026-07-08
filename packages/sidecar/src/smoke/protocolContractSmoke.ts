/**
 * Smoke test: protocol DTO field names match docs/cli-contract.md.
 *
 * Extends the intent of `smoke:cli-contract` to the seam: instead of shelling
 * the CLI and checking its JSON, it drives real DTOs through the in-process seam
 * and asserts their field names against the field tables parsed live from
 * docs/cli-contract.md. If the DTOs drift from the declared control-plane
 * contract — a missing field, an undocumented extra — this fails.
 *
 * Run: node packages/sidecar/out/smoke/protocolContractSmoke.js
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createHydraControlClient, transportFactory } from '@hydra/protocol';
import { FakeBackend } from './fakeBackend';

const CONTRACT_DOC = path.resolve(__dirname, '..', '..', '..', '..', 'docs', 'cli-contract.md');

interface DocField {
  name: string;
  /** Documented as "… or undefined": the JSON key may be absent. */
  optional: boolean;
}

/** Parse the first `| Field | Type |` table after a heading line. */
function parseFieldTable(md: string, heading: RegExp): DocField[] {
  const lines = md.split(/\r?\n/);
  let i = lines.findIndex(line => heading.test(line));
  assert.ok(i >= 0, `contract doc: heading ${heading} not found`);
  while (i < lines.length && !lines[i].trim().startsWith('|')) i++;
  assert.ok(i < lines.length, `contract doc: no table after ${heading}`);

  const fields: DocField[] = [];
  for (; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw.startsWith('|')) break;
    const cells = raw.split('|').slice(1, -1).map(cell => cell.trim());
    const first = cells[0] ?? '';
    if (/^-+$/.test(first) || first === '' || /^field$/i.test(first)) {
      continue; // separator / header / blank
    }
    const match = first.match(/^`([^`]+)`$/);
    if (!match) continue;
    fields.push({ name: match[1], optional: /undefined/i.test(cells[1] ?? '') });
  }
  assert.ok(fields.length > 0, `contract doc: no fields parsed after ${heading}`);
  return fields;
}

function assertMatchesContract(label: string, produced: Record<string, unknown>, fields: DocField[]): void {
  const documented = new Set(fields.map(field => field.name));
  for (const field of fields) {
    if (!field.optional) {
      assert.ok(field.name in produced, `${label}: DTO is missing documented field "${field.name}"`);
    }
  }
  for (const key of Object.keys(produced)) {
    assert.ok(documented.has(key), `${label}: DTO has field "${key}" not in cli-contract.md`);
  }
}

async function main(): Promise<void> {
  if (!fs.existsSync(CONTRACT_DOC)) {
    console.log(`protocolContractSmoke: skipped (contract doc not found at ${CONTRACT_DOC})`);
    return;
  }
  const md = fs.readFileSync(CONTRACT_DOC, 'utf-8');
  const copilotFields = parseFieldTable(md, /^Copilot entries include:/);
  const workerFields = parseFieldTable(md, /^Worker entries include:/);
  const logsFields = parseFieldTable(md, /hydra worker logs <session> --json/);
  const notificationFields = parseFieldTable(md, /^Notification records include:/);

  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-proto-contract-'));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  process.env.HYDRA_HOME = path.join(tempHome, '.hydra');
  process.env.HYDRA_TELEMETRY = '0';
  delete process.env.HYDRA_CONFIG_PATH;

  try {
    // Register one worker + one copilot session directly on the fake backend;
    // sync() discovers both and maps them to DTOs — deterministic, no launch.
    const backend = new FakeBackend();
    const workerSession = 'task_guard';
    const copilotSession = 'hydra-copilot-claude';
    for (const [session, role] of [[workerSession, 'worker'], [copilotSession, 'copilot']] as const) {
      const workdir = path.join(tempHome, session);
      fs.mkdirSync(workdir, { recursive: true });
      backend.sessions.add(session);
      backend.roles.set(session, role);
      backend.agents.set(session, 'claude');
      backend.workdirs.set(session, workdir);
    }

    const { HydraAppService } = await import('../appService');
    const client = createHydraControlClient(
      transportFactory({ kind: 'in-process', appService: new HydraAppService({ backend }) }),
    );

    const sessions = await client.listSessions();
    const workerDto = sessions.workers.find(w => w.session === workerSession);
    const copilotDto = sessions.copilots.find(c => c.session === copilotSession);
    assert.ok(workerDto, 'seeded worker should be discovered');
    assert.ok(copilotDto, 'seeded copilot should be discovered');

    assertMatchesContract('list worker entry', workerDto as unknown as Record<string, unknown>, workerFields);
    assertMatchesContract('list copilot entry', copilotDto as unknown as Record<string, unknown>, copilotFields);

    const logs = await client.getLogs(workerSession, 'worker', 10);
    assertMatchesContract('worker logs', logs as unknown as Record<string, unknown>, logsFields);

    const { NotificationStore } = await import('@hydra/core/notifications');
    new NotificationStore().create({
      kind: 'complete',
      title: 'done',
      sourceSession: workerSession,
      targetSession: workerSession,
    });
    const notifications = await client.listNotifications({ session: workerSession });
    assert.equal(notifications.count, 1, 'seeded notification should be listed');
    assertMatchesContract(
      'notification record',
      notifications.notifications[0] as unknown as Record<string, unknown>,
      notificationFields,
    );

    console.log('protocolContractSmoke: ok');
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
