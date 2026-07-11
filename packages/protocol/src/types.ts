// Cross-cutting seam shapes that are neither request DTOs nor the transport
// itself: the auth envelope carried on every call, the session-kind
// discriminator, and the terminal channel contract.

/**
 * Authentication carried on every transport call. In Fork A (loopback) this is
 * the per-launch bearer token; in Fork B it becomes an issued/rotated token.
 * `InProcessTransport` ignores it — but the parameter is present on every call
 * from day one so no call site changes when auth is hardened. See FINAL.md
 * §"Security posture".
 */
export interface AuthContext {
  token?: string;
}

/** Minimal unsubscribe handle, mirroring the shape used across @hydra/core. */
export interface Disposable {
  dispose(): void;
}

/** Every session is either a worker or a copilot. */
export type SessionKind = 'worker' | 'copilot';

/**
 * Terminal attach mode. `interactive` owns the tmux grid (one owner per
 * worker); `mirror` is a read-only observer. See FINAL.md §"Terminal
 * integration".
 */
export type TerminalMode = 'interactive' | 'mirror';

export interface TerminalAttachInput {
  session: string;
  mode?: TerminalMode;
  cols?: number;
  rows?: number;
  auth?: AuthContext;
}

/**
 * Bidirectional terminal channel returned by `attachTerminal` / the transport's
 * `openTerminal`. The concrete `node-pty` ⇄ `tmux attach` bridge lands in M3;
 * M0 fixes the shape so UI and transports can be written against it now.
 */
export interface TerminalChannel {
  readonly session: string;
  readonly mode: TerminalMode;
  /** Raw terminal output (already-encoded xterm bytes as a string). */
  onData(listener: (chunk: string) => void): Disposable;
  /** Fires once when the underlying PTY exits. */
  onExit(listener: (info: { code: number | null }) => void): Disposable;
  /** Structured terminal control error (for example, interactive-owner replacement). */
  onError(listener: (info: { message: string }) => void): Disposable;
  /** Forward keystrokes to the interactive owner (no-op for mirrors). */
  write(data: string): void;
  /** Resize the PTY / tmux client. */
  resize(cols: number, rows: number): void;
  /** Detach and release the channel. */
  close(): void;
}
