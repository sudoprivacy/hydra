import * as vscode from 'vscode';
import * as path from 'path';
import { ProjectInfo, getProjects } from '../core/contextPrompt';

/**
 * Add a new project to the projects configuration.
 */
export async function addProject(): Promise<void> {
  // Step 1: Choose project folder
  const folderUris = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Select Project Folder'
  });

  if (!folderUris || folderUris.length === 0) {
    return;
  }

  const projectPath = folderUris[0].fsPath;

  // Step 2: Enter project name (default to folder name)
  const defaultName = path.basename(projectPath);
  const nameInput = await vscode.window.showInputBox({
    prompt: 'Project name',
    value: defaultName,
    placeHolder: defaultName,
    validateInput: (value) => {
      if (!value.trim()) {
        return 'Project name is required';
      }
      const existing = getProjects().find(p => p.name === value.trim());
      if (existing) {
        return `Project "${value.trim()}" already exists`;
      }
      return undefined;
    }
  });

  if (!nameInput) {
    return;
  }

  const name = nameInput.trim();

  // Step 3: Optional description
  const description = await vscode.window.showInputBox({
    prompt: 'Project description (optional)',
    placeHolder: 'Brief description of the project purpose'
  });

  // Step 4: Optional tech stack
  const techStackInput = await vscode.window.showInputBox({
    prompt: 'Tech stack (optional, comma-separated)',
    placeHolder: 'TypeScript, React, Node.js'
  });

  const techStack = techStackInput
    ? techStackInput.split(',').map(t => t.trim()).filter(t => t)
    : undefined;

  // Step 5: Optional notes
  const notes = await vscode.window.showInputBox({
    prompt: 'Additional notes (optional)',
    placeHolder: 'Any extra context for AI workers'
  });

  // Create the project entry
  const newProject: ProjectInfo = {
    name,
    path: projectPath,
    description: description?.trim() || undefined,
    techStack,
    notes: notes?.trim() || undefined
  };

  // Save to settings
  const config = vscode.workspace.getConfiguration('hydra');
  const existingProjects = config.get<ProjectInfo[]>('projects') || [];
  existingProjects.push(newProject);

  await config.update('projects', existingProjects, vscode.ConfigurationTarget.Global);

  vscode.window.showInformationMessage(`Project "${name}" added successfully`);
  vscode.commands.executeCommand('tmux.refresh');
}

/**
 * Edit an existing project.
 */
export async function editProject(item: unknown): Promise<void> {
  // Resolve the project from the tree item argument or pick from list
  let project: ProjectInfo | undefined;

  if (item && typeof item === 'object' && 'project' in item) {
    project = (item as { project: ProjectInfo }).project;
  }

  if (!project) {
    const projects = getProjects();
    if (projects.length === 0) {
      vscode.window.showWarningMessage('No projects configured');
      return;
    }

    const picked = await vscode.window.showQuickPick(
      projects.map(p => ({
        label: p.name,
        description: p.path,
        project: p
      })),
      { placeHolder: 'Select project to edit' }
    );

    if (!picked) {
      return;
    }

    project = picked.project;
  }

  // Edit name
  const nameInput = await vscode.window.showInputBox({
    prompt: 'Project name',
    value: project.name,
    validateInput: (value) => {
      if (!value.trim()) {
        return 'Project name is required';
      }
      const existing = getProjects().find(p => p.name === value.trim() && p.path !== project!.path);
      if (existing) {
        return `Project "${value.trim()}" already exists`;
      }
      return undefined;
    }
  });

  if (!nameInput) {
    return;
  }

  const newName = nameInput.trim();

  // Edit description
  const description = await vscode.window.showInputBox({
    prompt: 'Project description (optional)',
    value: project.description || '',
    placeHolder: 'Brief description of the project purpose'
  });

  // Edit tech stack
  const techStackInput = await vscode.window.showInputBox({
    prompt: 'Tech stack (optional, comma-separated)',
    value: project.techStack?.join(', ') || '',
    placeHolder: 'TypeScript, React, Node.js'
  });

  const techStack = techStackInput
    ? techStackInput.split(',').map(t => t.trim()).filter(t => t)
    : undefined;

  // Edit related projects
  const allProjects = getProjects().filter(p => p.path !== project!.path);
  const relatedPicks = await vscode.window.showQuickPick(
    allProjects.map(p => ({
      label: p.name,
      picked: project!.related?.includes(p.name) ?? false
    })),
    {
      placeHolder: 'Select related projects (optional)',
      canPickMany: true
    }
  );

  const related = relatedPicks?.map(p => p.label);

  // Edit notes
  const notes = await vscode.window.showInputBox({
    prompt: 'Additional notes (optional)',
    value: project.notes || '',
    placeHolder: 'Any extra context for AI workers'
  });

  // Update the project in settings
  const config = vscode.workspace.getConfiguration('hydra');
  const existingProjects = config.get<ProjectInfo[]>('projects') || [];
  const index = existingProjects.findIndex(p => p.path === project!.path);

  if (index >= 0) {
    existingProjects[index] = {
      ...project!,
      name: newName,
      description: description?.trim() || undefined,
      techStack,
      related: related && related.length > 0 ? related : undefined,
      notes: notes?.trim() || undefined
    };

    await config.update('projects', existingProjects, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`Project "${newName}" updated`);
    vscode.commands.executeCommand('tmux.refresh');
  }
}

/**
 * Remove a project from the configuration.
 */
export async function removeProject(item: unknown): Promise<void> {
  // Resolve the project from the tree item argument or pick from list
  let project: ProjectInfo | undefined;

  if (item && typeof item === 'object' && 'project' in item) {
    project = (item as { project: ProjectInfo }).project;
  }

  if (!project) {
    const projects = getProjects();
    if (projects.length === 0) {
      vscode.window.showWarningMessage('No projects configured');
      return;
    }

    const picked = await vscode.window.showQuickPick(
      projects.map(p => ({
        label: p.name,
        description: p.path,
        project: p
      })),
      { placeHolder: 'Select project to remove' }
    );

    if (!picked) {
      return;
    }

    project = picked.project;
  }

  // Confirm deletion
  const confirm = await vscode.window.showWarningMessage(
    `Remove project "${project.name}"?`,
    'Remove',
    'Cancel'
  );

  if (confirm !== 'Remove') {
    return;
  }

  // Remove from settings
  const config = vscode.workspace.getConfiguration('hydra');
  const existingProjects = config.get<ProjectInfo[]>('projects') || [];
  const filtered = existingProjects.filter(p => p.path !== project!.path);

  await config.update('projects', filtered, vscode.ConfigurationTarget.Global);

  vscode.window.showInformationMessage(`Project "${project.name}" removed`);
  vscode.commands.executeCommand('tmux.refresh');
}