import assert from 'node:assert/strict';

import {
  AUTO_UPDATE_INITIAL_DELAY_MS,
  AUTO_UPDATE_INTERVAL_MS,
  startDesktopAutoUpdates,
  type DesktopUpdateInfo,
  type DesktopUpdater,
  type UpdateDialogOptions,
} from '../autoUpdate';

class FakeUpdater implements DesktopUpdater {
  configured: Parameters<DesktopUpdater['configure']>[0] | undefined;
  checkCount = 0;
  downloadCount = 0;
  quitCount = 0;
  checkError: Error | undefined;
  private errorListener: ((error: unknown) => void) | undefined;
  private availableListener: ((info: DesktopUpdateInfo) => void) | undefined;
  private downloadedListener: ((info: DesktopUpdateInfo) => void) | undefined;

  configure(options: Parameters<DesktopUpdater['configure']>[0]): void {
    this.configured = options;
  }

  onError(listener: (error: unknown) => void): void {
    this.errorListener = listener;
  }

  onUpdateAvailable(listener: (info: DesktopUpdateInfo) => void): void {
    this.availableListener = listener;
  }

  onUpdateDownloaded(listener: (info: DesktopUpdateInfo) => void): void {
    this.downloadedListener = listener;
  }

  async checkForUpdates(): Promise<void> {
    this.checkCount += 1;
    if (this.checkError) {
      throw this.checkError;
    }
  }

  async downloadUpdate(): Promise<void> {
    this.downloadCount += 1;
  }

  quitAndInstall(): void {
    this.quitCount += 1;
  }

  emitAvailable(version: string): void {
    this.availableListener?.({ version });
  }

  emitDownloaded(version: string): void {
    this.downloadedListener?.({ version });
  }

  emitError(error: Error): void {
    this.errorListener?.(error);
  }
}

async function flushPromises(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
  await new Promise<void>(resolve => setImmediate(resolve));
}

async function run(): Promise<void> {
  const disabledUpdater = new FakeUpdater();
  const disabled = startDesktopAutoUpdates({
    isPackaged: false,
    platform: 'darwin',
    updater: disabledUpdater,
    showMessageBox: async () => ({ response: 1 }),
    scheduleOnce: () => assert.fail('development build must not schedule update checks'),
    scheduleRecurring: () => assert.fail('development build must not schedule recurring checks'),
    log: () => undefined,
  });
  assert.equal(disabled.enabled, false);
  assert.equal(disabledUpdater.configured, undefined);

  const updater = new FakeUpdater();
  const onceTasks: Array<{ task: () => void; delayMs: number }> = [];
  const recurringTasks: Array<{ task: () => void; delayMs: number }> = [];
  const prompts: UpdateDialogOptions[] = [];
  const responses = [0, 0];
  const logs: string[] = [];
  const controller = startDesktopAutoUpdates({
    isPackaged: true,
    platform: 'darwin',
    updater,
    showMessageBox: async (dialogOptions) => {
      prompts.push(dialogOptions);
      return { response: responses.shift() ?? 1 };
    },
    scheduleOnce: (task, delayMs) => onceTasks.push({ task, delayMs }),
    scheduleRecurring: (task, delayMs) => recurringTasks.push({ task, delayMs }),
    log: message => logs.push(message),
  });

  assert.equal(controller.enabled, true);
  assert.deepEqual(updater.configured, {
    allowPrerelease: false,
    autoDownload: false,
    autoInstallOnAppQuit: true,
    fullChangelog: false,
  });
  assert.equal(onceTasks[0]?.delayMs, AUTO_UPDATE_INITIAL_DELAY_MS);
  assert.equal(recurringTasks[0]?.delayMs, AUTO_UPDATE_INTERVAL_MS);

  onceTasks[0]?.task();
  await flushPromises();
  assert.equal(updater.checkCount, 1, 'initial timer checks for updates');

  updater.emitAvailable('0.3.2026071501');
  await flushPromises();
  assert.equal(prompts[0]?.message, 'Hydra 0.3.2026071501 is available');
  assert.equal(updater.downloadCount, 1, 'accepting the first prompt downloads the update');

  updater.emitDownloaded('0.3.2026071501');
  await flushPromises();
  assert.equal(prompts[1]?.message, 'Hydra 0.3.2026071501 is ready to install');
  assert.equal(updater.quitCount, 1, 'accepting the second prompt restarts into the updater');

  updater.checkError = new Error('offline');
  await controller.checkNow();
  updater.emitError(new Error('provider failed'));
  assert.equal(logs.length, 2, 'check and provider failures are logged without blocking startup');

  const laterUpdater = new FakeUpdater();
  startDesktopAutoUpdates({
    isPackaged: true,
    platform: 'darwin',
    updater: laterUpdater,
    showMessageBox: async () => ({ response: 1 }),
    scheduleOnce: () => undefined,
    scheduleRecurring: () => undefined,
    log: () => undefined,
  });
  laterUpdater.emitAvailable('0.3.2026071501');
  await flushPromises();
  assert.equal(laterUpdater.downloadCount, 0, 'choosing Later leaves the current version running');

  console.log('autoUpdateSmoke: ok');
}

void run();
