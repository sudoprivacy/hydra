import * as vscode from 'vscode';
import { TmuxItem } from './tmuxSessionProvider';

/**
 * Fixed button item for creating new copilots/workers.
 * These items appear at the end of the tree view when there are existing items,
 * providing a quick way to create new sessions without scrolling back to the top.
 */
export class CreateButtonItem extends TmuxItem {
  constructor(
    public readonly commandId: string,
    label: string,
    itemDescription?: string,
    itemTooltip?: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'createButtonItem';
    this.description = itemDescription;
    this.tooltip = itemTooltip || label;
    this.iconPath = new vscode.ThemeIcon('add');
    this.command = {
      command: commandId,
      title: label,
    };
  }
}

/**
 * Create button for copilots - shows available agent options.
 */
export class CreateCopilotButtonItem extends CreateButtonItem {
  constructor(agentType?: string) {
    if (agentType) {
      super(
        `hydra.startCopilot${agentType.charAt(0).toUpperCase() + agentType.slice(1)}`,
        `Create ${agentType} Copilot`,
        undefined,
        `Create a new ${agentType} copilot session`
      );
    } else {
      super(
        'hydra.createCopilot',
        'Create Copilot...',
        undefined,
        'Create a new copilot session'
      );
    }
  }
}

/**
 * Create button for workers.
 */
export class CreateWorkerButtonItem extends CreateButtonItem {
  constructor() {
    super(
      'hydra.createWorker',
      'Create Worker...',
      undefined,
      'Create a new worker session'
    );
  }
}