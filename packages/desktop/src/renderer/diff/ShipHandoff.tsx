// The minimal "ship" handoff: a collapsible panel with the exact push + PR
// commands for the worker's branch, each with a copy button. There is no
// push/PR verb on HydraControlClient (v1 is review + handoff, not an IDE —
// FINAL.md risk #3), so we hand the developer the commands rather than shelling
// out from the renderer.

import { useState } from 'react';

import { buildShipCommands, type ShipCommand } from './diffModel';

function CopyButton({ command }: { command: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    // navigator.clipboard is available in the Electron renderer; degrade quietly.
    void navigator.clipboard?.writeText(command).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => setCopied(false),
    );
  };
  return (
    <button type="button" className="hydra-diff__button" onClick={copy}>
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

interface ShipHandoffProps {
  branch: string;
  workdir: string;
}

export function ShipHandoff({ branch, workdir }: ShipHandoffProps): JSX.Element | null {
  const commands: ShipCommand[] = buildShipCommands({ branch, workdir });
  if (commands.length === 0) {
    return null;
  }
  return (
    <details className="hydra-diff__ship">
      <summary>Ship — push &amp; open a PR</summary>
      {commands.map((cmd) => (
        <div key={cmd.command} className="hydra-diff__cmd-block">
          <div className="hydra-diff__cmd-title">{cmd.title}</div>
          <div className="hydra-diff__cmd">
            <code>{cmd.command}</code>
            <CopyButton command={cmd.command} />
          </div>
        </div>
      ))}
    </details>
  );
}
