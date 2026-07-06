// Hooks that bind the diff view to the seam. They are the ONLY place the diff
// screen touches `useHydraClient()`; every render path below consumes their
// output plus the pure helpers in `diffModel.ts`.

import { useCallback, useEffect, useMemo, useState } from 'react';

import type { DiffSummary, FileSnapshot } from '@hydra/protocol';

import { useHydraClient } from '../HydraClientProvider';
import {
  basePathFor,
  computeLineDiff,
  currentPathFor,
  type ChangedFileView,
  type LineDiff,
} from './diffModel';

function toMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export interface DiffState {
  summary: DiffSummary | null;
  loading: boolean;
  error: string | null;
  /** Re-run getDiff (e.g. after the worker commits more work). */
  reload: () => void;
}

/** Fetch the changed-file summary for a session via `getDiff`. */
export function useDiff(session: string | undefined): DiffState {
  const client = useHydraClient();
  const [summary, setSummary] = useState<DiffSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    if (!session) {
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    client
      .getDiff(session)
      .then((next) => {
        if (active) {
          setSummary(next);
          setLoading(false);
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(toMessage(cause));
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [client, session, nonce]);

  return { summary, loading, error, reload };
}

export interface FileDiffState {
  base: FileSnapshot | null;
  current: FileSnapshot | null;
  lineDiff: LineDiff | null;
  loading: boolean;
  error: string | null;
}

const EMPTY_FILE_DIFF: FileDiffState = {
  base: null,
  current: null,
  lineDiff: null,
  loading: false,
  error: null,
};

/**
 * Fetch both sides of one changed file via `getFileSnapshot` and compute the
 * line diff. Renames read the base from the original path; adds/deletes skip the
 * missing side (an empty snapshot). Returns an inert state when no file is
 * selected.
 */
export function useFileDiff(
  session: string | undefined,
  file: ChangedFileView | null,
): FileDiffState {
  const client = useHydraClient();
  const [base, setBase] = useState<FileSnapshot | null>(null);
  const [current, setCurrent] = useState<FileSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const basePath = file ? basePathFor(file) : undefined;
  const currentPath = file ? currentPathFor(file) : undefined;

  useEffect(() => {
    if (!session || !file) {
      setBase(null);
      setCurrent(null);
      setError(null);
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    setBase(null);
    setCurrent(null);

    const baseRequest = basePath
      ? client.getFileSnapshot({ session, path: basePath, side: 'base' })
      : Promise.resolve(null);
    const currentRequest = currentPath
      ? client.getFileSnapshot({ session, path: currentPath, side: 'current' })
      : Promise.resolve(null);

    Promise.all([baseRequest, currentRequest])
      .then(([baseSnapshot, currentSnapshot]) => {
        if (active) {
          setBase(baseSnapshot);
          setCurrent(currentSnapshot);
          setLoading(false);
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(toMessage(cause));
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [client, session, file, basePath, currentPath]);

  const lineDiff = useMemo<LineDiff | null>(() => {
    if (loading || error || !file) {
      return null;
    }
    return computeLineDiff(base?.content ?? '', current?.content ?? '');
  }, [loading, error, file, base, current]);

  if (!session || !file) {
    return EMPTY_FILE_DIFF;
  }
  return { base, current, lineDiff, loading, error };
}
