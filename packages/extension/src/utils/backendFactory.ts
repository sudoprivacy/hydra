import { MultiplexerBackend } from './multiplexer';
import { TmuxBackend } from './tmuxBackend';

export function createBackendFromConfig(): MultiplexerBackend {
  return new TmuxBackend();
}
