import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// Track temp files for cleanup on extension deactivation
const tempFiles: string[] = [];

/**
 * Smart terminal paste: intercepts Cmd+V in terminal context.
 *
 * When clipboard contains image data (and no text), saves the image to a temp file
 * and types the file path into the active terminal. This enables image paste for
 * AI CLI tools (Claude Code, OpenCode) that accept file path input for images.
 *
 * When clipboard contains text, falls through to the default terminal paste behavior
 * with zero performance impact (no external process invocation needed).
 */
export async function terminalSmartPaste(): Promise<void> {
  const terminal = vscode.window.activeTerminal;
  if (!terminal) {
    // No terminal focused, do nothing (VS Code will handle it)
    return;
  }

  // Fast path: check if clipboard has text content.
  // vscode.env.clipboard.readText() works on both local and Remote-SSH (proxied by VS Code).
  // If text is present, user almost certainly wants to paste text, not an image.
  // This avoids calling any external process for the common case.
  const clipboardText = await vscode.env.clipboard.readText();
  if (clipboardText.length > 0) {
    // Clipboard has text → execute default terminal paste
    await vscode.commands.executeCommand('workbench.action.terminal.paste');
    return;
  }

  // Slow path: clipboard has no text. Check for image data using platform-specific tools.
  // This only runs when clipboard is likely an image (e.g., after taking a screenshot).
  const imagePath = await saveClipboardImage();

  if (imagePath) {
    // IMPORTANT: use the terminal reference captured before saveClipboardImage().
    // In Remote-SSH mode, saveClipboardImage() may open a webview panel to capture
    // local clipboard image data, which steals UI focus and changes activeTerminal.
    // Reusing vscode.window.activeTerminal here can send the path to the wrong target.
    // We intentionally keep the pre-captured terminal instance and restore focus after.
    terminal.sendText(imagePath, false);
    terminal.show(false);
  } else {
    // No image either. Fall through to default paste (which will likely do nothing,
    // but maintaining the chain is safer than swallowing the event).
    await vscode.commands.executeCommand('workbench.action.terminal.paste');
  }
}

/**
 * Force paste image from clipboard, ignoring any text content.
 * Useful when clipboard has both text and image (e.g., copied from rich document)
 * and the user explicitly wants to paste the image.
 */
export async function pasteImageForce(): Promise<void> {
  const terminal = vscode.window.activeTerminal;
  if (!terminal) {
    vscode.window.showWarningMessage('No active terminal to paste into.');
    return;
  }

  const imagePath = await saveClipboardImage();

  if (imagePath) {
    terminal.sendText(imagePath, false);
    terminal.show(false);
  } else {
    vscode.window.showInformationMessage('No image found in clipboard.');
  }
}

/**
 * Save clipboard image to a temp file. Returns the file path, or null if no image.
 * Dispatches to platform-specific implementation.
 */
async function saveClipboardImage(): Promise<string | null> {
  // Remote-SSH detection: extension host runs on the remote machine,
  // but the clipboard is on the local machine. Direct system tools (pbpaste/xclip)
  // cannot read local clipboard from the remote host process.
  const isRemote = Boolean(vscode.env.remoteName)
    || (vscode.workspace.workspaceFolders ?? []).some((f) => f.uri.scheme !== 'file');

  if (isRemote) {
    return saveClipboardImageRemote();
  }

  const platform = process.platform;
  if (platform === 'darwin') {
    return saveClipboardImageMacOS();
  }
  if (platform === 'linux') {
    return saveClipboardImageLinux();
  }
  if (platform === 'win32') {
    return saveClipboardImageWindows();
  }

  vscode.window.showInformationMessage(
    'Clipboard image paste is currently supported on macOS, Linux, and Windows only.'
  );
  return null;
}

/**
 * Remote-SSH: Use a VS Code webview to read clipboard image from the LOCAL machine.
 *
 * In Remote-SSH, the extension host runs on the remote machine and can't access
 * the local clipboard via system tools. But VS Code webviews run on the LOCAL (UI)
 * side and have access to clipboard data through browser/Electron paste events.
 *
 * Flow: webview (local) captures paste event → reads image as base64 → sends via
 * postMessage to extension host (remote) → saves to remote filesystem.
 */
async function saveClipboardImageRemote(): Promise<string | null> {
  return new Promise((resolve) => {
    const panel = vscode.window.createWebviewPanel(
      'tmux-paste-image',
      '📋 Paste Image',
      {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: false, // Must take focus so the user can Cmd+V in it.
      },
      {
        enableScripts: true,
        retainContextWhenHidden: false,
      }
    );

    let resolved = false;

    const finish = (result: string | null) => {
      if (!resolved) {
        resolved = true;
        resolve(result);
      }
      panel.dispose();
    };

    // Auto-close after 5 minutes if no paste received.
    const timeout = setTimeout(() => finish(null), 300_000);

    panel.onDidDispose(() => {
      clearTimeout(timeout);
      if (!resolved) {
        resolved = true;
        resolve(null);
      }
    });

    panel.webview.onDidReceiveMessage(async (msg: { type: string; data?: string }) => {
      clearTimeout(timeout);

      if (msg.type === 'image' && msg.data) {
        try {
          // Strip the data URL prefix (e.g., "data:image/png;base64,").
          const base64Data = msg.data.replace(/^data:image\/\w+;base64,/, '');
          const buffer = Buffer.from(base64Data, 'base64');

          // Save to remote /tmp/ (extension host runs on remote in Remote-SSH).
          const tmpDir = path.join(os.tmpdir(), 'vscode-tmux-paste');
          if (!fs.existsSync(tmpDir)) {
            fs.mkdirSync(tmpDir, { recursive: true });
          }
          const tmpFile = path.join(
            tmpDir,
            `clipboard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`
          );
          fs.writeFileSync(tmpFile, buffer);
          tempFiles.push(tmpFile);

          finish(tmpFile);
        } catch {
          vscode.window.showErrorMessage('Failed to save clipboard image.');
          finish(null);
        }
      } else if (msg.type === 'no_image') {
        vscode.window.showInformationMessage('No image found in clipboard. Copy a screenshot first.');
        finish(null);
      } else if (msg.type === 'cancel') {
        finish(null);
      }
    });

    panel.webview.html = getPasteWebviewHtml();
  });
}

/**
 * Returns the HTML for the clipboard image paste webview.
 * The webview auto-focuses a contenteditable paste target so the user
 * only needs to press Cmd+V once to paste the image.
 */
function getPasteWebviewHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      user-select: none;
    }
    #paste-area {
      width: min(400px, 90%);
      min-height: 200px;
      border: 2px dashed var(--vscode-input-border, #555);
      border-radius: 12px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px;
      cursor: text;
      transition: border-color 0.2s, background-color 0.2s;
      outline: none;
    }
    #paste-area:focus {
      border-color: var(--vscode-focusBorder, #007acc);
      background: var(--vscode-input-background, rgba(255,255,255,0.05));
    }
    #paste-area.success {
      border-color: #4caf50;
      background: rgba(76, 175, 80, 0.08);
    }
    .icon { font-size: 48px; margin-bottom: 16px; }
    .title { font-size: 16px; font-weight: 600; margin-bottom: 8px; }
    .hint { font-size: 13px; opacity: 0.65; line-height: 1.5; text-align: center; }
    .preview {
      max-width: 100%;
      max-height: 160px;
      margin-top: 16px;
      border-radius: 6px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.2);
    }
    kbd {
      background: var(--vscode-keybindingLabel-background, #333);
      color: var(--vscode-keybindingLabel-foreground, #ccc);
      border: 1px solid var(--vscode-keybindingLabel-border, #555);
      border-bottom-width: 2px;
      border-radius: 4px;
      padding: 1px 6px;
      font-size: 12px;
      font-family: inherit;
    }
    .cancel-btn {
      margin-top: 16px;
      padding: 6px 16px;
      background: transparent;
      color: var(--vscode-foreground);
      border: 1px solid var(--vscode-input-border, #555);
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      opacity: 0.6;
    }
    .cancel-btn:hover { opacity: 1; }
  </style>
</head>
<body>
  <div id="paste-area" tabindex="0" contenteditable="true" aria-label="Paste area for clipboard image">
    <div class="icon">📋</div>
    <div class="title">Paste your image here</div>
    <div class="hint">
      Press <kbd>⌘</kbd><kbd>V</kbd> to paste from clipboard<br>
      <small>The image will be uploaded to the remote host automatically</small>
    </div>
  </div>
  <button class="cancel-btn" id="cancel-btn">Cancel</button>

  <script>
    const vscode = acquireVsCodeApi();
    const pasteArea = document.getElementById('paste-area');
    const cancelBtn = document.getElementById('cancel-btn');

    // Auto-focus so user can immediately Cmd+V.
    setTimeout(() => pasteArea.focus(), 100);

    pasteArea.addEventListener('paste', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const items = e.clipboardData?.items;
      if (!items) {
        vscode.postMessage({ type: 'no_image' });
        return;
      }

      // Find an image item in the clipboard.
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const blob = item.getAsFile();
          if (!blob) {
            continue;
          }

          // Show upload feedback.
          pasteArea.classList.add('success');
          pasteArea.innerHTML = '<div class="icon">⏳</div><div class="title">Uploading to remote host...</div>';
          cancelBtn.style.display = 'none';

          const reader = new FileReader();
          reader.onloadend = () => {
            vscode.postMessage({ type: 'image', data: reader.result });
          };
          reader.onerror = () => {
            vscode.postMessage({ type: 'no_image' });
          };
          reader.readAsDataURL(blob);
          return;
        }
      }

      // No image found in paste data.
      vscode.postMessage({ type: 'no_image' });
    });

    // Prevent typing text into the contenteditable area.
    pasteArea.addEventListener('keydown', (e) => {
      // Only allow Cmd+V / Ctrl+V, block everything else.
      if ((e.metaKey || e.ctrlKey) && e.key === 'v') {
        return;
      }
      if (e.key === 'Escape') {
        vscode.postMessage({ type: 'cancel' });
        return;
      }
      e.preventDefault();
    });

    cancelBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'cancel' });
    });
  </script>
</body>
</html>`;
}

/**
 * macOS: Use osascript with NSPasteboard to read clipboard image data.
 * Checks for PNG first (lossless), then TIFF (macOS screenshot default format).
 * Saves as PNG file regardless of source format.
 */
async function saveClipboardImageMacOS(): Promise<string | null> {
  const tmpDir = path.join(os.tmpdir(), 'vscode-tmux-paste');
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }
  const tmpFile = path.join(
    tmpDir,
    `clipboard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`
  );

  return new Promise((resolve) => {
    // AppleScript using Objective-C bridge (JXA-style "use framework") to access NSPasteboard directly.
    // This is more reliable than `pbpaste` which only handles text.
    // Checks PNG first, then TIFF. Converts TIFF to PNG via NSBitmapImageRep for consistency.
    const script = `
use framework "AppKit"

set pb to current application's NSPasteboard's generalPasteboard()

-- Try PNG first (preferred, lossless)
set pngData to pb's dataForType:(current application's NSPasteboardTypePNG)
if pngData is not missing value then
    pngData's writeToFile:"${tmpFile}" atomically:true
    return "OK"
end if

-- Fall back to TIFF (macOS screenshot default), convert to PNG for portability
set tiffData to pb's dataForType:(current application's NSPasteboardTypeTIFF)
if tiffData is not missing value then
    set imgRep to current application's NSBitmapImageRep's imageRepWithData:tiffData
    set pngOut to imgRep's representationUsingType:(current application's NSBitmapImageFileTypePNG) properties:(missing value)
    pngOut's writeToFile:"${tmpFile}" atomically:true
    return "OK"
end if

return "NO_IMAGE"
`;

    const proc = spawn('osascript', ['-']);
    let stdout = '';

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.on('close', (code: number | null) => {
      if (code === 0 && stdout.trim() === 'OK') {
        tempFiles.push(tmpFile);
        resolve(tmpFile);
      } else {
        // Clean up partial file if it exists
        try {
          fs.unlinkSync(tmpFile);
        } catch {
          // Ignore cleanup failure
        }
        resolve(null);
      }
    });

    proc.on('error', () => {
      resolve(null);
    });

    proc.stdin.write(script);
    proc.stdin.end();
  });
}

/**
 * Linux: Try xclip (X11) first, then wl-paste (Wayland) to read clipboard image.
 * Falls back gracefully if neither tool is installed.
 */
async function saveClipboardImageLinux(): Promise<string | null> {
  const tmpDir = path.join(os.tmpdir(), 'vscode-tmux-paste');
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }
  const tmpFile = path.join(
    tmpDir,
    `clipboard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`
  );

  // Try clipboard tools in order of preference
  const tools = [
    // X11: xclip reads clipboard content by type
    { cmd: 'xclip', args: ['-selection', 'clipboard', '-t', 'image/png', '-o'] },
    // Wayland: wl-paste reads clipboard content by MIME type
    { cmd: 'wl-paste', args: ['--type', 'image/png'] },
  ];

  for (const tool of tools) {
    const result = await new Promise<boolean>((resolve) => {
      const outStream = fs.createWriteStream(tmpFile);
      const proc = spawn(tool.cmd, tool.args);

      proc.stdout.pipe(outStream);

      proc.on('close', (code: number | null) => {
        outStream.close();
        // Verify the file has actual content (not empty / error output)
        try {
          const stat = fs.statSync(tmpFile);
          if (code === 0 && stat.size > 0) {
            resolve(true);
          } else {
            try {
              fs.unlinkSync(tmpFile);
            } catch {
              // Ignore cleanup failure
            }
            resolve(false);
          }
        } catch {
          resolve(false);
        }
      });

      proc.on('error', () => {
        outStream.close();
        try {
          fs.unlinkSync(tmpFile);
        } catch {
          // Ignore cleanup failure
        }
        resolve(false);
      });
    });

    if (result) {
      tempFiles.push(tmpFile);
      return tmpFile;
    }
  }

  return null;
}

/**
 * Windows: Use PowerShell to read clipboard image via System.Windows.Forms.
 * Saves the clipboard image as a PNG file.
 */
async function saveClipboardImageWindows(): Promise<string | null> {
  const tmpDir = path.join(os.tmpdir(), 'vscode-tmux-paste');
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }
  const tmpFile = path.join(
    tmpDir,
    `clipboard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`
  );

  return new Promise((resolve) => {
    const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($img) {
  $img.Save('${tmpFile.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output 'OK'
} else {
  Write-Output 'NO_IMAGE'
}
`;
    const proc = spawn('powershell', ['-NoProfile', '-Command', psScript]);
    let stdout = '';

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.on('close', (code: number | null) => {
      if (code === 0 && stdout.trim() === 'OK') {
        tempFiles.push(tmpFile);
        resolve(tmpFile);
      } else {
        try {
          fs.unlinkSync(tmpFile);
        } catch {
          // Ignore cleanup failure
        }
        resolve(null);
      }
    });

    proc.on('error', () => {
      resolve(null);
    });
  });
}

/**
 * Clean up temporary image files created during this session.
 * Called on extension deactivation.
 */
export function cleanupTempImages(): void {
  for (const file of tempFiles) {
    try {
      fs.unlinkSync(file);
    } catch {
      // File may already be deleted, ignore
    }
  }
  tempFiles.length = 0;

  // Also try to clean up the temp directory if empty
  const tmpDir = path.join(os.tmpdir(), 'vscode-tmux-paste');
  try {
    const remaining = fs.readdirSync(tmpDir);
    if (remaining.length === 0) {
      fs.rmdirSync(tmpDir);
    }
  } catch {
    // Directory may not exist, ignore
  }
}
