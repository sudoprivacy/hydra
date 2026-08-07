// Resolve the OS host pid nexus should record for a run — the session's agent
// pane pid. Shared by the worker (WorkerLifecycleService) and copilot lifecycles
// so the "read pane pid, validate" step lives in one place.
//
// Returns null when there is no usable pane pid (session gone / not started yet /
// resolve failed); tracking is best-effort, so a null just means "don't report
// this run in", never an error.

/** The slice of the multiplexer backend this needs — just the pane-pid lookup. */
export interface PanePidSource {
  getSessionPanePids(sessionName: string): Promise<Array<string | number>>;
}

export async function resolveHostPid(
  backend: PanePidSource,
  sessionName: string,
): Promise<number | null> {
  try {
    const panePids = await backend.getSessionPanePids(sessionName);
    // TODO(multi-pane): resolve the @hydra-agent-pane pid; [0] is the agent for single-pane sessions.
    const hostPid = Number(panePids[0]);
    return Number.isInteger(hostPid) && hostPid > 0 ? hostPid : null;
  } catch {
    return null;
  }
}
