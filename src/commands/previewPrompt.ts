import * as vscode from 'vscode';
import { buildCopilotPrompt, buildWorkerPrompt, getProjects } from '../core/contextPrompt';

/**
 * Preview the generated prompt for copilot or worker context.
 */
export async function previewGeneratedPrompt(): Promise<void> {
  // Ask which context to preview
  const contextChoice = await vscode.window.showQuickPick(
    [
      {
        label: 'Copilot Prompt',
        description: 'Global context injected into new copilots',
        value: 'copilot' as const
      },
      {
        label: 'Worker Prompt',
        description: 'Project-level context injected into new workers',
        value: 'worker' as const
      }
    ],
    { placeHolder: 'Select which prompt to preview' }
  );

  if (!contextChoice) {
    return;
  }

  if (contextChoice.value === 'copilot') {
    const prompt = buildCopilotPrompt();
    await showPromptPreview('Copilot Global Context', prompt);
  } else {
    // For worker prompt, need to select a project or provide a path
    const projects = getProjects();
    if (projects.length === 0) {
      const pathInput = await vscode.window.showInputBox({
        prompt: 'Enter worker path to preview',
        placeHolder: '/path/to/project'
      });
      if (pathInput) {
        const prompt = buildWorkerPrompt(pathInput);
        await showPromptPreview('Worker Context', prompt);
      }
    } else {
      const projectChoice = await vscode.window.showQuickPick(
        projects.map(p => ({
          label: p.name,
          description: p.path,
          path: p.path
        })),
        { placeHolder: 'Select project to preview worker prompt' }
      );

      if (projectChoice) {
        const prompt = buildWorkerPrompt(projectChoice.path);
        await showPromptPreview(`Worker Context for ${projectChoice.label}`, prompt);
      }
    }
  }
}

/**
 * Show the prompt preview in a new document.
 */
async function showPromptPreview(title: string, prompt: string): Promise<void> {
  if (!prompt.trim()) {
    vscode.window.showInformationMessage(`${title}: No prompt configured`);
    return;
  }

  // Create a temporary untitled document
  const content = `# ${title}\n\n---\n\n${prompt}\n\n---\n\n*This is a preview of the prompt that would be injected.*`;
  const doc = await vscode.workspace.openTextDocument({
    content,
    language: 'markdown'
  });

  await vscode.window.showTextDocument(doc, {
    preview: true,
    viewColumn: vscode.ViewColumn.Beside
  });
}