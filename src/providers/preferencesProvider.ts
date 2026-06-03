import * as vscode from 'vscode';
import {
  getGlobalPrompt,
  getProjects,
  shouldInjectOnCopilotCreate,
  shouldInjectOnWorkerCreate
} from '../core/contextPrompt';

/**
 * Tree item for the Preferences view.
 */
export class PreferenceItem extends vscode.TreeItem {
  constructor(
    label: string,
    value: string | boolean,
    icon: string,
    command?: vscode.Command
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = typeof value === 'boolean'
      ? (value ? 'Enabled' : 'Disabled')
      : (value || 'Not set');
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = 'preferenceItem';
    if (command) {
      this.command = command;
    }
  }
}

/**
 * Tree data provider for the Preferences view.
 */
export class PreferencesProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getParent(): vscode.TreeItem | undefined {
    return undefined;
  }

  async getChildren(): Promise<vscode.TreeItem[]> {
    const items: vscode.TreeItem[] = [];

    // Global Prompt
    const globalPrompt = getGlobalPrompt();
    const promptPreview = globalPrompt
      ? globalPrompt.substring(0, 50) + (globalPrompt.length > 50 ? '...' : '')
      : 'Not set';
    items.push(new PreferenceItem(
      'Global Prompt',
      promptPreview,
      'note',
      {
        command: 'hydra.editGlobalPrompt',
        title: 'Edit Global Prompt'
      }
    ));

    // Projects count
    const projects = getProjects();
    items.push(new PreferenceItem(
      'Projects',
      `${projects.length} configured`,
      'folder',
      {
        command: 'hydra.addProject',
        title: 'Add Project'
      }
    ));

    // Inject on Copilot Create
    items.push(new PreferenceItem(
      'Inject on Copilot Create',
      shouldInjectOnCopilotCreate(),
      'hubot',
      {
        command: 'hydra.toggleInjectOnCopilotCreate',
        title: 'Toggle'
      }
    ));

    // Inject on Worker Create
    items.push(new PreferenceItem(
      'Inject on Worker Create',
      shouldInjectOnWorkerCreate(),
      'server-process',
      {
        command: 'hydra.toggleInjectOnWorkerCreate',
        title: 'Toggle'
      }
    ));

    // Preview prompt
    const previewItem = new vscode.TreeItem('Preview Generated Prompt', vscode.TreeItemCollapsibleState.None);
    previewItem.iconPath = new vscode.ThemeIcon('eye');
    previewItem.command = {
      command: 'hydra.previewPrompt',
      title: 'Preview Generated Prompt'
    };
    previewItem.contextValue = 'previewPromptItem';
    items.push(previewItem);

    return items;
  }
}