import type { OrchestrationState } from "@engineering-team/contracts";

export function questionActivityContext(state: OrchestrationState): string {
  const openTasks = state.tasks.filter(task => task.status !== "completed");
  const tasks = [...openTasks.filter(task => task.status === "blocked"), ...openTasks.filter(task => task.status !== "blocked"), ...state.tasks.filter(task => task.status === "completed")].slice(0, 50);
  const snapshot = {
    capturedAt: new Date().toISOString(),
    note: "Recorded project state only. Working copies of running agents are not available to this separate read-only conversation. Do not claim to have inspected their live changes.",
    taskCount: state.tasks.length, omittedTasks: state.tasks.length - tasks.length,
    tasks: tasks.map(task => ({ id: task.id, title: task.title.slice(0, 160), status: task.status, assignedRole: task.assignedRole,
      dependencies: task.dependsOn.slice(0, 5).map(id => ({ id, status: state.tasks.find(candidate => candidate.id === id)?.status ?? "unknown" })) })),
    activeRunCount: state.activeRuns.length,
    activeRuns: state.activeRuns.slice(0, 50).map(run => ({ id: run.id, taskId: run.taskId, role: run.agentRole, purpose: run.spec.runPurpose,
      status: run.status, activity: state.runActivities[run.id]?.message?.slice(0, 200) })),
    pendingApprovalCount: state.approvals.filter(approval => approval.status === "pending").length,
    recoveryCount: state.recoveries.length,
    recoveries: state.recoveries.slice(0, 20).map(recovery => ({ taskId: recovery.taskId, stage: recovery.stage })),
  };
  while (JSON.stringify(snapshot).length > 28_000 && snapshot.tasks.length) {
    snapshot.tasks.pop(); snapshot.omittedTasks++;
  }
  while (JSON.stringify(snapshot).length > 28_000 && snapshot.activeRuns.length) snapshot.activeRuns.pop();
  return JSON.stringify(snapshot);
}
