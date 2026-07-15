export const AUTO_UPDATE_INITIAL_DELAY_MS = 15_000;
export const AUTO_UPDATE_INTERVAL_MS = 4 * 60 * 60 * 1_000;

export interface DesktopUpdateInfo {
  version: string;
}

export interface DesktopUpdater {
  configure(options: {
    allowPrerelease: boolean;
    autoDownload: boolean;
    autoInstallOnAppQuit: boolean;
    fullChangelog: boolean;
  }): void;
  onError(listener: (error: unknown) => void): void;
  onUpdateAvailable(listener: (info: DesktopUpdateInfo) => void): void;
  onUpdateDownloaded(listener: (info: DesktopUpdateInfo) => void): void;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void;
}

export interface UpdateDialogOptions {
  type: 'info';
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  noLink: boolean;
}

export interface DesktopAutoUpdateOptions {
  disabled?: boolean;
  isPackaged: boolean;
  platform: string;
  updater: DesktopUpdater;
  showMessageBox(options: UpdateDialogOptions): Promise<{ response: number }>;
  scheduleOnce(task: () => void, delayMs: number): void;
  scheduleRecurring(task: () => void, delayMs: number): void;
  log(message: string, error?: unknown): void;
}

export interface DesktopAutoUpdateController {
  enabled: boolean;
  checkNow(): Promise<void>;
}

function disabledController(): DesktopAutoUpdateController {
  return {
    enabled: false,
    checkNow: async () => undefined,
  };
}

export function startDesktopAutoUpdates(options: DesktopAutoUpdateOptions): DesktopAutoUpdateController {
  if (options.disabled || !options.isPackaged || options.platform !== 'darwin') {
    return disabledController();
  }

  const { updater } = options;
  updater.configure({
    allowPrerelease: false,
    autoDownload: false,
    autoInstallOnAppQuit: true,
    fullChangelog: false,
  });

  let checkInFlight = false;
  let downloadPromptOpen = false;
  let downloadStarted = false;
  let restartPromptOpen = false;

  const checkNow = async (): Promise<void> => {
    if (checkInFlight) {
      return;
    }
    checkInFlight = true;
    try {
      await updater.checkForUpdates();
    } catch (error) {
      options.log('hydra-desktop updater: update check failed', error);
    } finally {
      checkInFlight = false;
    }
  };

  updater.onError((error) => {
    options.log('hydra-desktop updater: updater error', error);
  });

  updater.onUpdateAvailable((info) => {
    if (downloadPromptOpen || downloadStarted) {
      return;
    }
    downloadPromptOpen = true;
    void options.showMessageBox({
      type: 'info',
      title: 'Hydra Update',
      message: `Hydra ${info.version} is available`,
      detail: 'Download the update now? You can keep using Hydra while it downloads.',
      buttons: ['Download Update', 'Later'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    }).then(async ({ response }) => {
      if (response !== 0) {
        return;
      }
      downloadStarted = true;
      try {
        await updater.downloadUpdate();
      } catch (error) {
        downloadStarted = false;
        options.log('hydra-desktop updater: update download failed', error);
      }
    }).catch((error: unknown) => {
      options.log('hydra-desktop updater: failed to show download prompt', error);
    }).finally(() => {
      downloadPromptOpen = false;
    });
  });

  updater.onUpdateDownloaded((info) => {
    if (restartPromptOpen) {
      return;
    }
    restartPromptOpen = true;
    void options.showMessageBox({
      type: 'info',
      title: 'Hydra Update Ready',
      message: `Hydra ${info.version} is ready to install`,
      detail: 'Restart now to finish updating. If you choose Later, the update will install when Hydra quits.',
      buttons: ['Restart and Install', 'Later'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    }).then(({ response }) => {
      if (response === 0) {
        updater.quitAndInstall(false, true);
      }
    }).catch((error: unknown) => {
      options.log('hydra-desktop updater: failed to show restart prompt', error);
    });
  });

  options.scheduleOnce(() => void checkNow(), AUTO_UPDATE_INITIAL_DELAY_MS);
  options.scheduleRecurring(() => void checkNow(), AUTO_UPDATE_INTERVAL_MS);

  return { enabled: true, checkNow };
}
