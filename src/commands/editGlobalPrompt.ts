import * as vscode from 'vscode';
import { getGlobalPrompt } from '../core/contextPrompt';

/**
 * Edit the global prompt in a text editor.
 */
export async function editGlobalPrompt(): Promise<void> {
  const currentPrompt = getGlobalPrompt();

  // Show a quick pick to choose between editing in input box or full editor
  const choice = await vscode.window.showQuickPick(
    [
      {
        label: 'Edit in Input Box',
        description: 'Quick edit for short prompts',
        value: 'input' as const
      },
      {
        label: 'Edit in New File',
        description: 'Full editor for longer prompts',
        value: 'file' as const
      }
    ],
    { placeHolder: 'How would you like to edit the global prompt?' }
  );

  if (!choice) {
    return;
  }

  if (choice.value === 'input') {
    const newPrompt = await vscode.window.showInputBox({
      prompt: 'Global Prompt',
      value: currentPrompt,
      placeHolder: 'Enter global context to inject into all copilots and workers...'
    });

    if (newPrompt !== undefined) {
      const config = vscode.workspace.getConfiguration('hydra');
      await config.update('globalPrompt', newPrompt, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage('Global prompt updated');
      vscode.commands.executeCommand('tmux.refresh');
    }
  } else {
    // Create a temporary untitled document for editing
    const doc = await vscode.workspace.openTextDocument({
      content: currentPrompt,
      language: 'markdown'
    });

    await vscode.window.showTextDocument(doc);

    // Listen for save
    const disposable = vscode.workspace.onDidSaveTextDocument(async (savedDoc) => {
      if (savedDoc.uri.toString() === doc.uri.toString()) {
        const newPrompt = savedDoc.getText();
        const config = vscode.workspace.getConfiguration('hydra');
        await config.update('globalPrompt', newPrompt, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage('Global prompt saved');
        vscode.commands.executeCommand('tmux.refresh');
      }
    });

    // Clean up listener when editor is closed
    vscode.workspace.onDidCloseTextDocument((closedDoc) => {
      if (closedDoc.uri.toString() === doc.uri.toString()) {
        disposable.dispose();
      }
    });
  }
}

/**
 * Toggle the injectOnCopilotCreate setting.
 */
export async function toggleInjectOnCopilotCreate(): Promise<void> {
  const config = vscode.workspace.getConfiguration('hydra');
  const currentValue = config.get<boolean>('injectOnCopilotCreate') ?? true;
  await config.update('injectOnCopilotCreate', !currentValue, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(
    `Global prompt injection for copilots ${!currentValue ? 'enabled' : 'disabled'}`
  );
  vscode.commands.executeCommand('tmux.refresh');
}

/**
 * Toggle the injectOnWorkerCreate setting.
 */
export async function toggleInjectOnWorkerCreate(): Promise<void> {
  const config = vscode.workspace.getConfiguration('hydra');
  const currentValue = config.get<boolean>('injectOnWorkerCreate') ?? true;
  await config.update('injectOnWorkerCreate', !currentValue, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(
    `Project context injection for workers ${!currentValue ? 'enabled' : 'disabled'}`
  );
  vscode.commands.executeCommand('tmux.refresh');
}