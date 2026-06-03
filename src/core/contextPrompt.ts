import * as vscode from 'vscode';

/**
 * Project information stored in VS Code settings.
 */
export interface ProjectInfo {
  name: string;
  path: string;
  description?: string;
  techStack?: string[];
  related?: string[];
  notes?: string;
}

/**
 * Get the global prompt from VS Code settings.
 */
export function getGlobalPrompt(): string {
  const config = vscode.workspace.getConfiguration('hydra');
  return config.get<string>('globalPrompt') || '';
}

/**
 * Get all projects from VS Code settings.
 */
export function getProjects(): ProjectInfo[] {
  const config = vscode.workspace.getConfiguration('hydra');
  return config.get<ProjectInfo[]>('projects') || [];
}

/**
 * Get a project by its path.
 */
export function getProjectByPath(projectPath: string): ProjectInfo | undefined {
  const projects = getProjects();
  const normalizedPath = projectPath.replace(/[\\/]+$/, '');
  return projects.find(p => p.path.replace(/[\\/]+$/, '') === normalizedPath);
}

/**
 * Get a project by its name.
 */
export function getProjectByName(name: string): ProjectInfo | undefined {
  const projects = getProjects();
  return projects.find(p => p.name === name);
}

/**
 * Check if global prompt injection is enabled for copilots.
 */
export function shouldInjectOnCopilotCreate(): boolean {
  const config = vscode.workspace.getConfiguration('hydra');
  return config.get<boolean>('injectOnCopilotCreate') ?? true;
}

/**
 * Check if project-level context injection is enabled for workers.
 */
export function shouldInjectOnWorkerCreate(): boolean {
  const config = vscode.workspace.getConfiguration('hydra');
  return config.get<boolean>('injectOnWorkerCreate') ?? true;
}

/**
 * Build the global context prompt for a Copilot.
 * Combines the global prompt with any relevant project context.
 */
export function buildCopilotPrompt(): string {
  const globalPrompt = getGlobalPrompt();
  if (!globalPrompt.trim()) {
    return '';
  }

  const parts: string[] = [
    '## Global Context',
    '',
    globalPrompt.trim(),
  ];

  // Add project summaries if available
  const projects = getProjects();
  if (projects.length > 0) {
    parts.push('', '## Known Projects', '');
    for (const project of projects) {
      parts.push(formatProjectSummary(project));
    }
  }

  return parts.join('\n');
}

/**
 * Build the project-level context prompt for a Worker.
 * Finds the matching project and provides detailed context.
 */
export function buildWorkerPrompt(workerPath: string): string {
  if (!shouldInjectOnWorkerCreate()) {
    return '';
  }

  const globalPrompt = getGlobalPrompt();
  const project = getProjectByPath(workerPath);

  const parts: string[] = [];

  // Add global prompt first if present
  if (globalPrompt.trim() && shouldInjectOnCopilotCreate()) {
    parts.push('## Global Context', '', globalPrompt.trim(), '');
  }

  // Add project-specific context if found
  if (project) {
    parts.push('## Project Context', '');
    parts.push(formatProjectDetail(project));

    // Add related projects context
    if (project.related && project.related.length > 0) {
      const relatedProjects = getProjects().filter(p => project.related!.includes(p.name));
      if (relatedProjects.length > 0) {
        parts.push('', '## Related Projects', '');
        for (const related of relatedProjects) {
          parts.push(formatProjectSummary(related));
        }
      }
    }
  }

  return parts.join('\n');
}

/**
 * Format a brief project summary for the copilot prompt.
 */
function formatProjectSummary(project: ProjectInfo): string {
  const lines: string[] = [`- **${project.name}** (${project.path})`];
  if (project.description) {
    lines.push(`  ${project.description}`);
  }
  if (project.techStack && project.techStack.length > 0) {
    lines.push(`  Tech: ${project.techStack.join(', ')}`);
  }
  return lines.join('\n');
}

/**
 * Format detailed project information for the worker prompt.
 */
function formatProjectDetail(project: ProjectInfo): string {
  const lines: string[] = [`**Name**: ${project.name}`];
  lines.push(`**Path**: ${project.path}`);

  if (project.description) {
    lines.push(`**Description**: ${project.description}`);
  }

  if (project.techStack && project.techStack.length > 0) {
    lines.push(`**Tech Stack**: ${project.techStack.join(', ')}`);
  }

  if (project.related && project.related.length > 0) {
    lines.push(`**Related Projects**: ${project.related.join(', ')}`);
  }

  if (project.notes) {
    lines.push(`**Notes**: ${project.notes}`);
  }

  return lines.join('\n');
}

/**
 * Preview the generated prompt for a given context.
 */
export function previewPrompt(context: 'copilot' | 'worker', workerPath?: string): string {
  if (context === 'copilot') {
    return buildCopilotPrompt();
  }
  if (context === 'worker' && workerPath) {
    return buildWorkerPrompt(workerPath);
  }
  return '';
}