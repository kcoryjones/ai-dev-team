import type { TeamDatabase } from "@engineering-team/database";

interface WorkerController { stopTaskWorker(runId: string): Promise<void> }

export function createRunRecovery(database: TeamDatabase, controller: WorkerController | null, logger: Pick<Console, "info" | "warn"> = console) {
  let running: Promise<void> | undefined;
  async function recover(startup: boolean, now: string): Promise<void> {
    if (startup) database.reconcileInterruptedVoiceCommands();
    const tasks = database.reconcileInterruptedTaskRuns(now, startup);
    const agents = startup ? database.reconcileInterruptedAgentRuns(now) : [];
    if (tasks.length || agents.length) logger.info(`Recovered ${tasks.length} interrupted task workflows and ${agents.length} interrupted agent turns`);
    // Persisted alongside the terminal state, so controller outages and another
    // API restart cannot lose a worker that still needs to be stopped.
    const pending = database.listPendingWorkerCleanups();
    if (!controller) {
      if (pending.length) logger.warn(`${pending.length} interrupted workers await cleanup; the worker controller is not configured`);
      return;
    }
    for (const runId of pending) {
      try {
        await controller.stopTaskWorker(runId);
        database.completeWorkerCleanup(runId);
      } catch (error) {
        logger.warn(`Could not stop interrupted worker for run ${runId}; cleanup will retry: ${error instanceof Error ? error.message : "unknown controller error"}`);
      }
    }
  }
  return (startup = false, now = new Date().toISOString()): Promise<void> => {
    // A slow controller must not cause overlapping periodic cleanup requests.
    running ??= recover(startup, now).finally(() => { running = undefined; });
    return running;
  };
}
