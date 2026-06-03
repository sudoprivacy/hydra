import * as vscode from 'vscode';
import { ProjectInfo, getProjects } from '../core/contextPrompt';

/**
 * Tree item representing a project in the Projects view.
 */
export class ProjectItem extends vscode.TreeItem {
  constructor(
    public readonly project: ProjectInfo,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(project.name, collapsibleState);
    this.id = project.path;
    this.description = project.description || project.path;
    this.contextValue = 'projectItem';
    this.iconPath = new vscode.ThemeIcon('folder');
    this.tooltip = formatProjectTooltip(project);
    this.command = {
      command: 'hydra.editProject',
      title: 'Edit Project',
      arguments: [this]
    };
  }
}

/**
 * Tree item showing project details.
 */
export class ProjectDetailItem extends vscode.TreeItem {
  constructor(
    label: string,
    value: string | undefined,
    icon: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = value || '-';
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = 'projectDetailItem';
  }
}

function formatProjectTooltip(project: ProjectInfo): string {
  const parts: string[] = [project.name, project.path];
  if (project.description) parts.push(project.description);
  if (project.techStack && project.techStack.length > 0) {
    parts.push(`Tech: ${project.techStack.join(', ')}`);
  }
  if (project.related && project.related.length > 0) {
    parts.push(`Related: ${project.related.join(', ')}`);
  }
  if (project.notes) parts.push(project.notes);
  return parts.join('\n');
}

/**
 * Tree data provider for the Projects view.
 */
export class ProjectsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getParent(_element: vscode.TreeItem): vscode.TreeItem | undefined {
    return undefined;
  }

  async getChildren(_element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!_element) {
      return this.getRootItems();
    }

    if (_element instanceof ProjectItem) {
      return this.getProjectDetailItems(_element.project);
    }

    return [];
  }

  private async getRootItems(): Promise<vscode.TreeItem[]> {
    const projects = getProjects();

    if (projects.length === 0) {
      const hint = new vscode.TreeItem('No projects configured');
      hint.iconPath = new vscode.ThemeIcon('info');
      hint.description = 'Add a project to provide context to workers';
      return [hint];
    }

    return projects.map(p => new ProjectItem(p, vscode.TreeItemCollapsibleState.Collapsed));
  }

  private async getProjectDetailItems(project: ProjectInfo): Promise<vscode.TreeItem[]> {
    const items: vscode.TreeItem[] = [];

    items.push(new ProjectDetailItem('Path', project.path, 'folder'));
    items.push(new ProjectDetailItem('Description', project.description, 'note'));

    if (project.techStack && project.techStack.length > 0) {
      const techItem = new vscode.TreeItem('Tech Stack', vscode.TreeItemCollapsibleState.None);
      techItem.description = project.techStack.join(', ');
      techItem.iconPath = new vscode.ThemeIcon('symbol-keyword');
      items.push(techItem);
    }

    if (project.related && project.related.length > 0) {
      const relatedItem = new vscode.TreeItem('Related', vscode.TreeItemCollapsibleState.None);
      relatedItem.description = project.related.join(', ');
      relatedItem.iconPath = new vscode.ThemeIcon('references');
      items.push(relatedItem);
    }

    if (project.notes) {
      const notesItem = new vscode.TreeItem('Notes', vscode.TreeItemCollapsibleState.None);
      notesItem.description = project.notes;
      notesItem.iconPath = new vscode.ThemeIcon('comment');
      items.push(notesItem);
    }

    return items;
  }
}