import { Fragment, type Dispatch, type FormEvent, type MouseEvent, type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  agentRoles,
  type AgentRuntimeAssignmentSummary,
  type AgentRole,
  type ApiError,
  type CodingHarnessAdapter,
  type CodingHarnessInstallationSummary,
  type CodingHarnessPreflightSummary,
  type CodingHarnessSummary,
  type ContextDocumentSummary,
  type ContextRevisionSummary,
  type CreatePlanResponse,
  type DiscoveredRepository,
  type OrchestrationState,
  type ModelBackendAuthMode,
  type ModelBackendProtocol,
  type ModelBackendProvider,
  type ModelBackendSummary,
  type SaveModelBackendInput,
  type SaveCodingHarnessInput,
  type HarnessCapability,
  type PlanningNetworkPolicy,
  type ProjectSettingsSummary,
  type ProjectSummary,
  type RepositoryDiscoveryResponse,
  type RepositorySummary,
  type TaskStatus,
  type TaskReviewSummary,
  type TaskSummary,
  type TaskWorkflowDetailResponse,
  type TaskWorkflowRunDetail,
  type TaskWorkflowRecoveryStage,
  type UpdateProjectSettingsInput,
} from "@engineering-team/contracts";

interface CreateProjectResponse {
  project: ProjectSummary;
}

interface ProjectSettingsResponse {
  settings: ProjectSettingsSummary;
}

interface ModelBackendsResponse {
  backends: ModelBackendSummary[];
}

interface CodingHarnessesResponse {
  harnesses: CodingHarnessSummary[];
}

interface CodingHarnessStatusesResponse {
  statuses: CodingHarnessInstallationSummary[];
}

interface CodingHarnessPreflightResponse {
  preflight: CodingHarnessPreflightSummary;
}

interface AgentRuntimeAssignmentsResponse {
  assignments: AgentRuntimeAssignmentSummary[];
}

interface DraftTask {
  key: string;
  title: string;
  description: string;
  assignedRole: AgentRole;
  repositoryId: string;
  acceptanceCriteria: string;
  requiredChecks: {
    qa: boolean;
    codeReview: boolean;
    security: boolean;
  };
  dependsOn: string;
}

type View = "live" | "tasks" | "settings" | "repository";

interface AppRoute {
  view: View;
  repositoryPath: string;
  agentRole: AgentRole | null;
  taskId: string | null;
}

function readAppRoute(): AppRoute {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  const params = new URLSearchParams(window.location.search);
  if (path === "/tasks") return { view: "tasks", repositoryPath: "", agentRole: null, taskId: params.get("task") };
  if (path === "/settings") return { view: "settings", repositoryPath: "", agentRole: null, taskId: null };
  if (path.startsWith("/repos/")) {
    try {
      return { view: "repository", repositoryPath: decodeURIComponent(path.slice(7)), agentRole: null, taskId: null };
    } catch {
      return { view: "live", repositoryPath: "", agentRole: null, taskId: null };
    }
  }
  const candidateRole = params.get("agent") as AgentRole | null;
  return {
    view: "live",
    repositoryPath: "",
    agentRole: candidateRole && agentRoles.includes(candidateRole) ? candidateRole : null,
    taskId: null,
  };
}

function appRouteUrl(view: View, repository?: RepositorySummary, agentRole?: AgentRole | null, taskId?: string | null): string {
  if (view === "tasks") return taskId ? `/tasks?task=${encodeURIComponent(taskId)}` : "/tasks";
  if (view === "settings") return "/settings";
  if (view === "repository" && repository) return `/repos/${encodeURIComponent(repository.relativePath)}`;
  return agentRole ? `/live?agent=${encodeURIComponent(agentRole)}` : "/live";
}

const roleLabels: Record<AgentRole, string> = {
  project_manager: "Project Manager",
  architect: "Architect",
  tech_lead: "Tech Lead",
  backend_developer: "Backend Developer",
  frontend_developer: "Frontend Developer",
  devops_database_engineer: "DevOps / DB Engineer",
  qa_engineer: "QA Engineer",
  code_reviewer: "Code Reviewer",
  security_reviewer: "Security",
  release_manager: "Release Manager",
};

const roleInitials: Record<AgentRole, string> = {
  project_manager: "PM",
  architect: "AR",
  tech_lead: "TL",
  backend_developer: "BE",
  frontend_developer: "FE",
  devops_database_engineer: "DO",
  qa_engineer: "QA",
  code_reviewer: "CR",
  security_reviewer: "SR",
  release_manager: "RM",
};

const teamRows: AgentRole[][] = [
  ["project_manager"],
  ["architect", "tech_lead"],
  ["backend_developer", "frontend_developer", "devops_database_engineer"],
  ["qa_engineer", "code_reviewer", "security_reviewer"],
  ["release_manager"],
];

const kanbanColumns: Array<{ status: TaskStatus; label: string }> = [
  { status: "draft", label: "Proposed" },
  { status: "ready", label: "Ready" },
  { status: "blocked", label: "Blocked" },
  { status: "in_progress", label: "In progress" },
  { status: "review", label: "Review" },
  { status: "completed", label: "Done" },
];

function newDraftTask(index: number): DraftTask {
  return {
    key: `task-${index}`,
    title: "",
    description: "",
    assignedRole: index === 1 ? "architect" : "backend_developer",
    repositoryId: "",
    acceptanceCriteria: "",
    requiredChecks: { qa: true, codeReview: true, security: true },
    dependsOn: index > 1 ? `task-${index - 1}` : "",
  };
}

export function App() {
  const initialRoute = useMemo(readAppRoute, []);
  const [view, setView] = useState<View>(initialRoute.view);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [repositories, setRepositories] = useState<DiscoveredRepository[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedRepositoryId, setSelectedRepositoryId] = useState("");
  const [requestedRepositoryPath, setRequestedRepositoryPath] = useState(initialRoute.repositoryPath);
  const [selectedRole, setSelectedRole] = useState<AgentRole>(initialRoute.agentRole ?? "project_manager");
  const [openChatRole, setOpenChatRole] = useState<AgentRole | null>(initialRoute.agentRole);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(initialRoute.taskId);
  const [orchestration, setOrchestration] = useState<OrchestrationState | null>(null);
  const [taskReviews, setTaskReviews] = useState<TaskReviewSummary[]>([]);
  const [projectSettings, setProjectSettings] = useState<ProjectSettingsSummary | null>(null);
  const [modelBackends, setModelBackends] = useState<ModelBackendSummary[]>([]);
  const [codingHarnesses, setCodingHarnesses] = useState<CodingHarnessSummary[]>([]);
  const [codingHarnessStatuses, setCodingHarnessStatuses] = useState<CodingHarnessInstallationSummary[]>([]);
  const [agentRuntimeAssignments, setAgentRuntimeAssignments] = useState<AgentRuntimeAssignmentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [orchestrationLoading, setOrchestrationLoading] = useState(false);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [modelBackendsLoading, setModelBackendsLoading] = useState(false);
  const [codingHarnessesLoading, setCodingHarnessesLoading] = useState(false);
  const [codingHarnessStatusesLoading, setCodingHarnessStatusesLoading] = useState(false);
  const [agentRuntimesLoading, setAgentRuntimesLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renamingProject, setRenamingProject] = useState(false);
  const [projectNameDraft, setProjectNameDraft] = useState("");
  const [newRepositoryName, setNewRepositoryName] = useState("");
  const [showRepositoryAdder, setShowRepositoryAdder] = useState(false);
  const [objectiveTitle, setObjectiveTitle] = useState("");
  const [objectiveDescription, setObjectiveDescription] = useState("");
  const [draftTasks, setDraftTasks] = useState<DraftTask[]>([newDraftTask(1)]);
  const [decisionNotes, setDecisionNotes] = useState<Record<string, string>>({});
  const [chatDraft, setChatDraft] = useState("");

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );
  const selectedRepository = useMemo(
    () => selectedProject?.repositories.find((repository) => repository.id === selectedRepositoryId) ?? null,
    [selectedProject, selectedRepositoryId],
  );
  const pendingApprovals = orchestration?.approvals.filter((approval) => approval.status === "pending") ?? [];

  useEffect(() => {
    const canonicalUrl = initialRoute.view === "repository"
      ? `/repos/${encodeURIComponent(initialRoute.repositoryPath)}`
      : appRouteUrl(initialRoute.view, undefined, initialRoute.agentRole, initialRoute.taskId);
    window.history.replaceState(null, "", canonicalUrl);
    function restoreRoute() {
      const route = readAppRoute();
      setView(route.view);
      setRequestedRepositoryPath(route.repositoryPath);
      setOpenChatRole(route.agentRole);
      setSelectedTaskId(route.taskId);
      if (route.agentRole) setSelectedRole(route.agentRole);
    }
    window.addEventListener("popstate", restoreRoute);
    return () => window.removeEventListener("popstate", restoreRoute);
  }, [initialRoute.agentRole, initialRoute.view]);

  useEffect(() => {
    if (!selectedProject || !requestedRepositoryPath) return;
    const repository = selectedProject.repositories.find((candidate) => candidate.relativePath === requestedRepositoryPath);
    if (repository) {
      setSelectedRepositoryId(repository.id);
      return;
    }
    setRequestedRepositoryPath("");
    setView("live");
    window.history.replaceState(null, "", "/live");
  }, [requestedRepositoryPath, selectedProject]);

  function navigate(nextView: Exclude<View, "repository">): void;
  function navigate(nextView: "repository", repository: RepositorySummary): void;
  function navigate(nextView: View, repository?: RepositorySummary) {
    setRenamingProject(false);
    setView(nextView);
    setOpenChatRole(null);
    setSelectedTaskId(null);
    if (nextView === "repository" && repository) {
      setSelectedRepositoryId(repository.id);
      setRequestedRepositoryPath(repository.relativePath);
    } else {
      setRequestedRepositoryPath("");
    }
    window.history.pushState(null, "", appRouteUrl(nextView, repository));
  }

  function showAgentChat(role: AgentRole | null) {
    setOpenChatRole(role);
    if (role) setSelectedRole(role);
    window.history.replaceState(null, "", appRouteUrl("live", undefined, role));
  }

  function showTaskDetails(taskId: string | null) {
    setSelectedTaskId(taskId);
    window.history.pushState(null, "", appRouteUrl("tasks", undefined, null, taskId));
  }

  const loadProjects = useCallback(async () => {
    try {
      const workspaceResponse = await fetch("/api/projects/workspace", { method: "POST" });
      if (!workspaceResponse.ok) {
        throw new Error("The local orchestration service is unavailable");
      }
      const workspaceBody = await readResponse<CreateProjectResponse | ApiError>(workspaceResponse);
      if ("error" in workspaceBody) throw new Error(workspaceBody.message);
      const repositoriesResponse = await fetch("/api/repositories/discover");
      if (!repositoriesResponse.ok) throw new Error("Unable to discover sibling repositories");
      const repositoriesBody = await readResponse<RepositoryDiscoveryResponse>(repositoriesResponse);
      const loadedProjects = [(workspaceBody as CreateProjectResponse).project];
      setProjects(loadedProjects);
      setRepositories(repositoriesBody.repositories);
      setSelectedProjectId(loadedProjects[0]?.id ?? "");
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to load projects");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadOrchestration = useCallback(async (projectId: string) => {
    if (!projectId) {
      setOrchestration(null);
      setTaskReviews([]);
      return;
    }
    setOrchestrationLoading(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/orchestration`);
      const body = await readResponse<{ state: OrchestrationState; reviews: TaskReviewSummary[] } | ApiError>(response);
      if (!response.ok) throw new Error("message" in body ? body.message : "Unable to load workflow");
      const orchestrationBody = body as { state: OrchestrationState; reviews: TaskReviewSummary[] };
      setOrchestration(orchestrationBody.state);
      setTaskReviews(orchestrationBody.reviews);
      setError(null);
    } catch (requestError) {
      setTaskReviews([]);
      setError(requestError instanceof Error ? requestError.message : "Unable to load workflow");
    } finally {
      setOrchestrationLoading(false);
    }
  }, []);

  const loadSettings = useCallback(async (projectId: string) => {
    if (!projectId) {
      setProjectSettings(null);
      return;
    }
    setSettingsLoading(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/settings`);
      const body = await readResponse<ProjectSettingsResponse | ApiError>(response);
      if (!response.ok) throw new Error("message" in body ? body.message : "Unable to load settings");
      setProjectSettings((body as ProjectSettingsResponse).settings);
      setError(null);
    } catch (requestError) {
      setProjectSettings(null);
      setError(requestError instanceof Error ? requestError.message : "Unable to load settings");
    } finally {
      setSettingsLoading(false);
    }
  }, []);

  const loadModelBackends = useCallback(async (projectId: string) => {
    if (!projectId) {
      setModelBackends([]);
      return;
    }
    setModelBackendsLoading(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/model-backends`);
      const body = await readResponse<ModelBackendsResponse | ApiError>(response);
      if (!response.ok) throw new Error("message" in body ? body.message : "Unable to load model backends");
      setModelBackends((body as ModelBackendsResponse).backends);
      setError(null);
    } catch (requestError) {
      setModelBackends([]);
      setError(requestError instanceof Error ? requestError.message : "Unable to load model backends");
    } finally {
      setModelBackendsLoading(false);
    }
  }, []);

  const loadCodingHarnesses = useCallback(async (projectId: string) => {
    if (!projectId) {
      setCodingHarnesses([]);
      return;
    }
    setCodingHarnessesLoading(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/harnesses`);
      const body = await readResponse<CodingHarnessesResponse | ApiError>(response);
      if (!response.ok) throw new Error("message" in body ? body.message : "Unable to load coding harnesses");
      setCodingHarnesses((body as CodingHarnessesResponse).harnesses);
      setError(null);
    } catch (requestError) {
      setCodingHarnesses([]);
      setError(requestError instanceof Error ? requestError.message : "Unable to load coding harnesses");
    } finally {
      setCodingHarnessesLoading(false);
    }
  }, []);

  const loadCodingHarnessStatuses = useCallback(async (projectId: string) => {
    if (!projectId) {
      setCodingHarnessStatuses([]);
      return;
    }
    setCodingHarnessStatusesLoading(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/harnesses/status`);
      const body = await readResponse<CodingHarnessStatusesResponse | ApiError>(response);
      if (!response.ok) throw new Error("message" in body ? body.message : "Unable to inspect coding harnesses");
      setCodingHarnessStatuses((body as CodingHarnessStatusesResponse).statuses);
    } catch (requestError) {
      setCodingHarnessStatuses([]);
      setError(requestError instanceof Error ? requestError.message : "Unable to inspect coding harnesses");
    } finally {
      setCodingHarnessStatusesLoading(false);
    }
  }, []);

  const loadAgentRuntimeAssignments = useCallback(async (projectId: string) => {
    if (!projectId) {
      setAgentRuntimeAssignments([]);
      return;
    }
    setAgentRuntimesLoading(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/agent-runtime-assignments`);
      const body = await readResponse<AgentRuntimeAssignmentsResponse | ApiError>(response);
      if (!response.ok) throw new Error("message" in body ? body.message : "Unable to load team runtime assignments");
      setAgentRuntimeAssignments((body as AgentRuntimeAssignmentsResponse).assignments);
      setError(null);
    } catch (requestError) {
      setAgentRuntimeAssignments([]);
      setError(requestError instanceof Error ? requestError.message : "Unable to load team runtime assignments");
    } finally {
      setAgentRuntimesLoading(false);
    }
  }, []);

  useEffect(() => { void loadProjects(); }, [loadProjects]);
  useEffect(() => { void loadOrchestration(selectedProjectId); }, [loadOrchestration, selectedProjectId]);
  useEffect(() => { void loadSettings(selectedProjectId); }, [loadSettings, selectedProjectId]);
  useEffect(() => { void loadModelBackends(selectedProjectId); }, [loadModelBackends, selectedProjectId]);
  useEffect(() => { void loadCodingHarnesses(selectedProjectId); }, [loadCodingHarnesses, selectedProjectId]);
  useEffect(() => { void loadCodingHarnessStatuses(selectedProjectId); }, [loadCodingHarnessStatuses, selectedProjectId]);
  useEffect(() => { void loadAgentRuntimeAssignments(selectedProjectId); }, [loadAgentRuntimeAssignments, selectedProjectId]);
  useEffect(() => {
    const hasActiveRun = orchestration?.runs.some((run) => ["queued", "provisioning", "running"].includes(run.status)) ?? false;
    if (!selectedProjectId || !hasActiveRun) return;
    const timer = window.setInterval(() => { void loadOrchestration(selectedProjectId); }, 2_000);
    return () => window.clearInterval(timer);
  }, [loadOrchestration, orchestration?.runs, selectedProjectId]);

  async function attachRepository(repository: DiscoveredRepository): Promise<boolean> {
    if (!selectedProjectId) return false;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${selectedProjectId}/repositories`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ relativePath: repository.relativePath }),
      });
      const body = await readResponse<CreateProjectResponse | ApiError>(response);
      if (!response.ok) throw new Error("message" in body ? body.message : "Unable to add section");
      await loadProjects();
      await loadOrchestration(selectedProjectId);
      setShowRepositoryAdder(false);
      return true;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to add section");
      return false;
    } finally {
      setSubmitting(false);
    }
  }

  async function createRepository(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await createRepositoryNamed(newRepositoryName)) {
      setNewRepositoryName("");
      setShowRepositoryAdder(false);
    }
  }

  async function createRepositoryNamed(directoryName: string): Promise<boolean> {
    if (!selectedProjectId) return false;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${selectedProjectId}/repositories/new`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ directoryName }),
      });
      const body = await readResponse<CreateProjectResponse | ApiError>(response);
      if (!response.ok) throw new Error("message" in body ? body.message : "Unable to create repository");
      await loadProjects();
      await loadOrchestration(selectedProjectId);
      return true;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to create repository");
      return false;
    } finally {
      setSubmitting(false);
    }
  }

  async function renameProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await saveProjectName(projectNameDraft)) setRenamingProject(false);
  }

  async function saveProjectName(name: string): Promise<boolean> {
    if (!selectedProjectId || !name.trim()) return false;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${selectedProjectId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const body = await readResponse<CreateProjectResponse | ApiError>(response);
      if (!response.ok) throw new Error("message" in body ? body.message : "Unable to rename project");
      const updatedProject = (body as CreateProjectResponse).project;
      setProjects((current) => current.map((project) => project.id === updatedProject.id ? updatedProject : project));
      return true;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to rename project");
      return false;
    } finally {
      setSubmitting(false);
    }
  }

  async function updateProjectSettings(input: UpdateProjectSettingsInput): Promise<boolean> {
    if (!selectedProjectId) return false;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${selectedProjectId}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      const body = await readResponse<ProjectSettingsResponse | ApiError>(response);
      if (!response.ok) throw new Error("message" in body ? body.message : "Unable to update settings");
      setProjectSettings((body as ProjectSettingsResponse).settings);
      return true;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to update settings");
      return false;
    } finally {
      setSubmitting(false);
    }
  }

  async function updateRepository(input: { description?: string; enabled?: boolean }): Promise<boolean> {
    if (!selectedProjectId || !selectedRepositoryId) return false;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${selectedProjectId}/repositories/${selectedRepositoryId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      const body = await readResponse<CreateProjectResponse | ApiError>(response);
      if (!response.ok) throw new Error("message" in body ? body.message : "Unable to update repository");
      const updatedProject = (body as CreateProjectResponse).project;
      setProjects((current) => current.map((project) => project.id === updatedProject.id ? updatedProject : project));
      return true;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to update repository");
      return false;
    } finally {
      setSubmitting(false);
    }
  }

  async function saveContext(repositoryId: string | null, content: string): Promise<boolean> {
    if (!selectedProjectId) return false;
    setSubmitting(true);
    setError(null);
    try {
      const endpoint = repositoryId
        ? `/api/projects/${selectedProjectId}/repositories/${repositoryId}/context`
        : `/api/projects/${selectedProjectId}/context`;
      const response = await fetch(endpoint, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const body = await readResponse<ApiError>(response);
      if (!response.ok) throw new Error(body.message || "Unable to save context");
      await loadOrchestration(selectedProjectId);
      return true;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to save context");
      return false;
    } finally {
      setSubmitting(false);
    }
  }

  async function saveModelBackend(input: SaveModelBackendInput, backendId?: string): Promise<boolean> {
    if (!selectedProjectId) return false;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(
        backendId
          ? `/api/projects/${selectedProjectId}/model-backends/${backendId}`
          : `/api/projects/${selectedProjectId}/model-backends`,
        {
          method: backendId ? "PUT" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      const body = await readResponse<{ backend: ModelBackendSummary } | ApiError>(response);
      if (!response.ok) throw new Error("message" in body ? body.message : "Unable to save model backend");
      await loadModelBackends(selectedProjectId);
      return true;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to save model backend");
      return false;
    } finally {
      setSubmitting(false);
    }
  }

  async function deleteModelBackend(backendId: string): Promise<boolean> {
    if (!selectedProjectId) return false;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${selectedProjectId}/model-backends/${backendId}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const body = await readResponse<ApiError>(response);
        throw new Error(body.message || "Unable to delete model backend");
      }
      await loadModelBackends(selectedProjectId);
      await loadAgentRuntimeAssignments(selectedProjectId);
      return true;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to delete model backend");
      return false;
    } finally {
      setSubmitting(false);
    }
  }

  async function saveCodingHarness(input: SaveCodingHarnessInput, harnessId?: string): Promise<boolean> {
    if (!selectedProjectId) return false;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(
        harnessId
          ? `/api/projects/${selectedProjectId}/harnesses/${harnessId}`
          : `/api/projects/${selectedProjectId}/harnesses`,
        {
          method: harnessId ? "PUT" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      const body = await readResponse<{ harness: CodingHarnessSummary } | ApiError>(response);
      if (!response.ok) throw new Error("message" in body ? body.message : "Unable to save coding harness");
      await loadCodingHarnesses(selectedProjectId);
      await loadCodingHarnessStatuses(selectedProjectId);
      return true;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to save coding harness");
      return false;
    } finally {
      setSubmitting(false);
    }
  }

  async function deleteCodingHarness(harnessId: string): Promise<boolean> {
    if (!selectedProjectId) return false;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${selectedProjectId}/harnesses/${harnessId}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const body = await readResponse<ApiError>(response);
        throw new Error(body.message || "Unable to delete coding harness");
      }
      await loadCodingHarnesses(selectedProjectId);
      await loadCodingHarnessStatuses(selectedProjectId);
      await loadAgentRuntimeAssignments(selectedProjectId);
      return true;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to delete coding harness");
      return false;
    } finally {
      setSubmitting(false);
    }
  }

  async function preflightCodingHarness(harnessId: string): Promise<CodingHarnessPreflightSummary> {
    if (!selectedProjectId) throw new Error("Select a project before testing a harness");
    setError(null);
    const response = await fetch(`/api/projects/${selectedProjectId}/harnesses/${harnessId}/preflight`, {
      method: "POST",
    });
    const body = await readResponse<CodingHarnessPreflightResponse | ApiError>(response);
    if (!response.ok) throw new Error("message" in body ? body.message : "Unable to test coding harness");
    return (body as CodingHarnessPreflightResponse).preflight;
  }

  async function assignAgentRuntime(agentRole: AgentRole, codingHarnessId: string | null, modelBackendId: string | null, fallbackCodingHarnessId?: string | null, fallbackModelBackendId?: string | null): Promise<boolean> {
    if (!selectedProjectId) return false;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${selectedProjectId}/agents/${agentRole}/runtime`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ codingHarnessId, modelBackendId, ...(fallbackCodingHarnessId === undefined ? {} : { fallbackCodingHarnessId }), ...(fallbackModelBackendId === undefined ? {} : { fallbackModelBackendId }) }),
      });
      const body = await readResponse<{ assignment: AgentRuntimeAssignmentSummary | null } | ApiError>(response);
      if (!response.ok) throw new Error("message" in body ? body.message : "Unable to assign agent runtime");
      await loadAgentRuntimeAssignments(selectedProjectId);
      return true;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to assign agent runtime");
      return false;
    } finally {
      setSubmitting(false);
    }
  }

  function updateDraftTask(index: number, patch: Partial<DraftTask>) {
    setDraftTasks((current) => current.map((task, taskIndex) => taskIndex === index ? { ...task, ...patch } : task));
  }

  function addDraftTask() {
    setDraftTasks((current) => {
      const nextIndex = Math.max(0, ...current.map((task) => Number(task.key.replace("task-", "")) || 0)) + 1;
      return [...current, newDraftTask(nextIndex)];
    });
  }

  function removeDraftTask(index: number) {
    setDraftTasks((current) => {
      const removedKey = current[index]?.key;
      return current
        .filter((_, taskIndex) => taskIndex !== index)
        .map((task) => task.dependsOn === removedKey ? { ...task, dependsOn: "" } : task);
    });
  }

  async function createPlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProjectId) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${selectedProjectId}/plans`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          objective: { title: objectiveTitle, description: objectiveDescription },
          tasks: draftTasks.map((task) => ({
            key: task.key,
            title: task.title,
            description: task.description,
            assignedRole: task.assignedRole,
            repositoryIds: task.repositoryId ? [task.repositoryId] : [],
            acceptanceCriteria: task.acceptanceCriteria.split("\n").map((criterion) => criterion.trim()).filter(Boolean),
            requiredChecks: task.requiredChecks,
            dependsOn: task.dependsOn ? [task.dependsOn] : [],
          })),
        }),
      });
      const body = await readResponse<CreatePlanResponse | ApiError>(response);
      if (!response.ok) throw new Error("message" in body ? body.message : "Unable to create plan");
      setObjectiveTitle("");
      setObjectiveDescription("");
      setDraftTasks([newDraftTask(1)]);
      await loadOrchestration(selectedProjectId);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to create plan");
    } finally {
      setSubmitting(false);
    }
  }

  async function decideApproval(approvalId: string, decision: "approved" | "rejected") {
    if (!selectedProjectId) return;
    setSubmitting(true);
    try {
      const response = await fetch(`/api/projects/${selectedProjectId}/approvals/${approvalId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, note: decisionNotes[approvalId] || undefined }),
      });
      const body = await readResponse<ApiError>(response);
      if (!response.ok) throw new Error(body.message || "Unable to record decision");
      await loadOrchestration(selectedProjectId);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to record decision");
    } finally {
      setSubmitting(false);
    }
  }

  async function rerunTask(taskId: string) {
    if (!selectedProjectId) return;
    setSubmitting(true);
    setError(null);
    try {
      const requeueResponse = await fetch(`/api/projects/${selectedProjectId}/tasks/${taskId}/rerun`, { method: "POST" });
      const requeueBody = await readResponse<ApiError>(requeueResponse);
      if (!requeueResponse.ok) throw new Error(requeueBody.message || "Unable to requeue the stale task");
      const runResponse = await fetch(`/api/projects/${selectedProjectId}/tasks/${taskId}/runs`, { method: "POST" });
      const runBody = await readResponse<ApiError>(runResponse);
      if (!runResponse.ok) throw new Error(runBody.message || "Unable to start the replacement run");
      await loadOrchestration(selectedProjectId);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to re-run the task");
      await loadOrchestration(selectedProjectId);
    } finally {
      setSubmitting(false);
    }
  }

  async function startTask(taskId: string, runtime: "primary" | "fallback" = "primary") {
    if (!selectedProjectId) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${selectedProjectId}/tasks/${taskId}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runtime }),
      });
      const body = await readResponse<ApiError>(response);
      if (!response.ok) throw new Error(body.message || "Unable to start task agent");
      await loadOrchestration(selectedProjectId);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to start task agent");
    } finally {
      setSubmitting(false);
    }
  }

  async function resumeTask(taskId: string, stage: TaskWorkflowRecoveryStage) {
    if (!selectedProjectId) return;
    setSubmitting(true);
    setError(null);
    try {
      const endpoint = ["verification", "release"].includes(stage)
        ? `/api/projects/${selectedProjectId}/tasks/${taskId}/resume`
        : `/api/projects/${selectedProjectId}/tasks/${taskId}/runs`;
      const response = await fetch(endpoint, { method: "POST" });
      const body = await readResponse<ApiError>(response);
      if (!response.ok) throw new Error(body.message || "Unable to resume task workflow");
      await loadOrchestration(selectedProjectId);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to resume task workflow");
      await loadOrchestration(selectedProjectId);
    } finally {
      setSubmitting(false);
    }
  }

  async function cancelTask(taskId: string) {
    if (!selectedProjectId) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${selectedProjectId}/tasks/${taskId}/cancel`, { method: "POST" });
      const body = await readResponse<ApiError>(response);
      if (!response.ok) throw new Error(body.message || "Unable to cancel task run");
      await loadOrchestration(selectedProjectId);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to cancel task run");
      await loadOrchestration(selectedProjectId);
    } finally {
      setSubmitting(false);
    }
  }

  async function cancelAgentRun(agentRole: AgentRole, runId: string) {
    if (!selectedProjectId) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${selectedProjectId}/agents/${agentRole}/runs/${runId}/cancel`, { method: "POST" });
      const body = await readResponse<ApiError>(response);
      if (!response.ok) throw new Error(body.message || "Unable to cancel agent conversation");
      await loadOrchestration(selectedProjectId);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to cancel agent conversation");
      await loadOrchestration(selectedProjectId);
    } finally {
      setSubmitting(false);
    }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProjectId || !chatDraft.trim()) return;
    setSubmitting(true);
    try {
      const activeTaskRun = orchestration?.runs.find((run) => run.agentRole === selectedRole && run.taskId && ["queued", "provisioning", "running", "waiting"].includes(run.status));
      const response = await fetch(activeTaskRun?.taskId
        ? `/api/projects/${selectedProjectId}/tasks/${activeTaskRun.taskId}/redirect`
        : `/api/projects/${selectedProjectId}/agents/${selectedRole}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(activeTaskRun ? { guidance: chatDraft } : { body: chatDraft }),
      });
      const body = await readResponse<ApiError>(response);
      if (!response.ok) throw new Error(body.message || (activeTaskRun ? "Unable to redirect active task" : "Unable to send message"));
      setChatDraft("");
      await loadOrchestration(selectedProjectId);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to send message");
      await loadOrchestration(selectedProjectId);
    } finally {
      setSubmitting(false);
    }
  }

  async function removeAgentDirective(agentRole: AgentRole, directiveId: string) {
    if (!selectedProjectId) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${selectedProjectId}/agents/${agentRole}/directives/${directiveId}`, { method: "DELETE" });
      if (!response.ok) {
        const body = await readResponse<ApiError>(response);
        throw new Error(body.message || "Unable to remove directive");
      }
      await loadOrchestration(selectedProjectId);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to remove directive");
    } finally {
      setSubmitting(false);
    }
  }

  async function updateAgentRolePrompt(agentRole: AgentRole, rolePrompt: string, consultationRoles: AgentRole[]): Promise<boolean> {
    if (!selectedProjectId) return false;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${selectedProjectId}/agents/${agentRole}/configuration`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rolePrompt, consultationRoles }),
      });
      const body = await readResponse<ApiError>(response);
      if (!response.ok) throw new Error(body.message || "Unable to update role prompt");
      await loadOrchestration(selectedProjectId);
      return true;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to update role prompt");
      return false;
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-identity"><button className={`brand-mark settings-launch ${view === "settings" ? "active" : ""}`} type="button" title="Settings" aria-label="Open Settings" aria-current={view === "settings" ? "page" : undefined} onClick={() => navigate("settings")}><span className="mark-initials">ET</span><span className="mark-gear" aria-hidden="true">⚙</span></button><div><strong>Engineering Team</strong><small>Director console</small></div></div></div>
        <>
          <nav className="primary-nav" aria-label="Project views">
            <button className={view === "live" ? "active" : ""} onClick={() => navigate("live")}><span>◉</span><div><strong>Live team</strong><small>Agents and conversations</small></div></button>
            <button className={view === "tasks" ? "active" : ""} onClick={() => navigate("tasks")}><span>▦</span><div><strong>Tasks</strong><small>Kanban workflow</small></div></button>
          </nav>
          {selectedProject && <section className="sidebar-repositories" aria-label="Project repositories">
            <p>Repos</p>
            <div className="repository-shortcuts">
              {selectedProject.repositories.map((repository) => <div className={`repository-shortcut ${selectedRepositoryId === repository.id && view === "repository" ? "active" : ""}`} key={repository.id}><button className="repository-link" type="button" title={repository.available ? repository.relativePath : `${repository.relativePath} — folder unavailable`} disabled={!repository.enabled || !repository.available} onClick={() => navigate("tasks")}>{repository.name}{!repository.available ? " · missing" : ""}</button><button className="repository-settings-button" type="button" title={`Settings for ${repository.name}`} aria-label={`Open settings for ${repository.name}`} onClick={() => navigate("repository", repository)}>⚙</button></div>)}
            </div>
            <button className="add-repository-button" type="button" aria-expanded={showRepositoryAdder} onClick={() => setShowRepositoryAdder((current) => !current)}>＋ Add</button>
            {showRepositoryAdder && <div className="repository-adder">
              <div className="repository-adder-heading"><span>New repo</span><button type="button" onClick={() => setShowRepositoryAdder(false)} aria-label="Close new repository form">×</button></div>
              {repositories.some((repository) => !repository.registered) && <div className="detected-repositories"><span>Detected siblings</span>{repositories.filter((repository) => !repository.registered).map((repository) => <button type="button" disabled={submitting} title={repository.relativePath} onClick={() => void attachRepository(repository)} key={repository.relativePath}>＋ {repository.name}</button>)}</div>}
              <form onSubmit={(event) => void createRepository(event)}>
                <input value={newRepositoryName} onChange={(event) => setNewRepositoryName(slugify(event.target.value))} aria-label="New repository name" placeholder="task-runner" pattern="[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,62}[a-zA-Z0-9])?" autoFocus required/>
                <button type="submit" disabled={submitting}>Create</button>
              </form>
            </div>}
          </section>}
        </>
        <div className="sidebar-foot"><span className="status-dot"/>Local system online</div>
      </aside>

      <main className="main-stage">
        <header className="stage-header">
          <div><p className="eyebrow">{view === "live" ? "Operations room" : view === "tasks" ? "Delivery workflow" : view === "repository" ? "Repository configuration" : "Project configuration"}</p>{renamingProject && (view === "live" || view === "tasks") ? <form className="project-rename" onSubmit={(event) => void renameProject(event)}><input value={projectNameDraft} onChange={(event) => setProjectNameDraft(event.target.value)} autoFocus required/><button type="submit" disabled={submitting}>Save</button><button type="button" onClick={() => setRenamingProject(false)}>Cancel</button></form> : <div className="project-title"><h1>{view === "settings" ? "Settings" : view === "repository" ? selectedRepository?.name ?? "Repository" : selectedProject?.name ?? "Project"}</h1>{selectedProject && (view === "live" || view === "tasks") && <button type="button" title="Rename project" onClick={() => { setProjectNameDraft(selectedProject.name); setRenamingProject(true); }}>✎</button>}</div>}</div>
          {selectedProject && <div className="header-metrics"><span><strong>{selectedProject.repositories.length}</strong> repos</span><span><strong>{orchestration?.tasks.filter((task) => task.status === "in_progress").length ?? 0}</strong> active</span><span><strong>{pendingApprovals.length}</strong> approvals</span></div>}
        </header>

        {error && <div className="alert" role="alert">{error}</div>}

        {!selectedProject ? (
          <section className="welcome-state"><div className="empty-orbit">ET</div><h2>{loading ? "Opening project…" : "Unable to initialize project"}</h2><p>The workspace Project contains the sibling repositories used by the team.</p></section>
        ) : view === "settings" && (settingsLoading || !projectSettings) ? (
          <section className="welcome-state"><div className="empty-orbit">ET</div><h2>Loading project setup…</h2><p>Reading the workspace configuration and execution defaults.</p></section>
        ) : view === "live" ? (
          <LiveView orchestration={orchestration} runtimeAssignments={agentRuntimeAssignments} codingHarnesses={codingHarnesses} modelBackends={modelBackends} selectedRole={selectedRole} openChatRole={openChatRole} showAgentChat={showAgentChat} assignRuntime={assignAgentRuntime} cancelTask={cancelTask} cancelAgentRun={cancelAgentRun} chatDraft={chatDraft} setChatDraft={setChatDraft} sendMessage={sendMessage} removeDirective={removeAgentDirective} updateRolePrompt={updateAgentRolePrompt} submitting={submitting} loading={orchestrationLoading || agentRuntimesLoading} />
        ) : view === "tasks" ? (
          <TasksView project={selectedProject} orchestration={orchestration} runtimeAssignments={agentRuntimeAssignments} reviews={taskReviews} selectedTaskId={selectedTaskId} showTaskDetails={showTaskDetails} loading={orchestrationLoading} submitting={submitting} draftTasks={draftTasks} objectiveTitle={objectiveTitle} objectiveDescription={objectiveDescription} decisionNotes={decisionNotes} setObjectiveTitle={setObjectiveTitle} setObjectiveDescription={setObjectiveDescription} setDecisionNotes={setDecisionNotes} updateDraftTask={updateDraftTask} addDraftTask={addDraftTask} removeDraftTask={removeDraftTask} createPlan={createPlan} decideApproval={decideApproval} rerunTask={rerunTask} startTask={startTask} resumeTask={resumeTask} cancelTask={cancelTask} />
        ) : view === "repository" && selectedRepository ? (
          <RepositorySettingsView repository={selectedRepository} contextDocument={orchestration?.contexts.find((document) => document.repositoryId === selectedRepository.id) ?? null} revisions={orchestration?.contextRevisions.filter((revision) => revision.repositoryId === selectedRepository.id) ?? []} submitting={submitting} save={updateRepository} saveContext={(content) => saveContext(selectedRepository.id, content)} />
        ) : projectSettings ? (
          <SettingsView project={selectedProject} settings={projectSettings} contextDocument={orchestration?.contexts.find((document) => document.repositoryId === null) ?? null} revisions={orchestration?.contextRevisions.filter((revision) => revision.repositoryId === null) ?? []} saveContext={(content) => saveContext(null, content)} modelBackends={modelBackends} modelBackendsLoading={modelBackendsLoading} codingHarnesses={codingHarnesses} codingHarnessesLoading={codingHarnessesLoading} codingHarnessStatuses={codingHarnessStatuses} codingHarnessStatusesLoading={codingHarnessStatusesLoading} submitting={submitting} updateProjectSettings={updateProjectSettings} saveModelBackend={saveModelBackend} deleteModelBackend={deleteModelBackend} saveCodingHarness={saveCodingHarness} deleteCodingHarness={deleteCodingHarness} preflightCodingHarness={preflightCodingHarness} />
        ) : null}
      </main>
    </div>
  );
}

function RepositorySettingsView({ repository, contextDocument, revisions, submitting, save, saveContext }: {
  repository: RepositorySummary;
  contextDocument: ContextDocumentSummary | null;
  revisions: ContextRevisionSummary[];
  submitting: boolean;
  save: (input: { description?: string; enabled?: boolean }) => Promise<boolean>;
  saveContext: (content: string) => Promise<boolean>;
}) {
  const [description, setDescription] = useState(repository.description);
  const [enabled, setEnabled] = useState(repository.enabled);

  useEffect(() => {
    setDescription(repository.description);
    setEnabled(repository.enabled);
  }, [repository.id, repository.description, repository.enabled]);

  const unchanged = description.trim() === repository.description && enabled === repository.enabled;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await save({ description: description.trim(), enabled });
  }

  return <section className="repository-settings-view">
    <div className="settings-intro"><div><p className="eyebrow">Repository</p><h2>{repository.name}</h2><p>Context and availability used when assigning tasks and preparing agent workspaces.</p></div><span className={`repository-availability ${repository.available ? "available" : "missing"}`}>{repository.available ? "✓ Available" : "× Folder missing"}</span></div>
    <form className="settings-card" onSubmit={(event) => void submit(event)}>
      <div className="repository-details">
        <div><span>Workspace path</span><strong>{repository.relativePath}</strong></div>
        <div><span>Default branch</span><strong>{repository.defaultBranch ?? "Not detected"}</strong></div>
        <div className="repository-detail-wide"><span>Git remote</span><strong>{repository.remoteUrl ?? "Local repository — no remote configured"}</strong></div>
      </div>
      <label>Repository description<textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={2000} placeholder="What does this repository contain?"/></label>
      <label className="repository-enabled"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)}/><span><strong>Include in agent work</strong><small>Enabled repositories can be selected for tasks and mounted into agent workspaces.</small></span></label>
      {!repository.available && <div className="repository-warning"><span>!</span><div><strong>Repository folder not found</strong><p>Restore the folder at this workspace path or attach a replacement before assigning new work.</p></div></div>}
      <div className="settings-card-actions end"><button className="primary-button" type="submit" disabled={submitting || unchanged}>Save repository</button></div>
    </form>
    <ContextEditor title="Repository context" description="Durable knowledge about this repository’s boundaries, structure, commands, interfaces, and conventions." document={contextDocument} revisions={revisions} submitting={submitting} save={saveContext} />
  </section>;
}

function SettingsView({ project, settings, contextDocument, revisions, saveContext, modelBackends, modelBackendsLoading, codingHarnesses, codingHarnessesLoading, codingHarnessStatuses, codingHarnessStatusesLoading, submitting, updateProjectSettings, saveModelBackend, deleteModelBackend, saveCodingHarness, deleteCodingHarness, preflightCodingHarness }: {
  project: ProjectSummary;
  settings: ProjectSettingsSummary;
  contextDocument: ContextDocumentSummary | null;
  revisions: ContextRevisionSummary[];
  saveContext: (content: string) => Promise<boolean>;
  modelBackends: ModelBackendSummary[];
  modelBackendsLoading: boolean;
  codingHarnesses: CodingHarnessSummary[];
  codingHarnessesLoading: boolean;
  codingHarnessStatuses: CodingHarnessInstallationSummary[];
  codingHarnessStatusesLoading: boolean;
  submitting: boolean;
  updateProjectSettings: (input: UpdateProjectSettingsInput) => Promise<boolean>;
  saveModelBackend: (input: SaveModelBackendInput, backendId?: string) => Promise<boolean>;
  deleteModelBackend: (backendId: string) => Promise<boolean>;
  saveCodingHarness: (input: SaveCodingHarnessInput, harnessId?: string) => Promise<boolean>;
  deleteCodingHarness: (harnessId: string) => Promise<boolean>;
  preflightCodingHarness: (harnessId: string) => Promise<CodingHarnessPreflightSummary>;
}) {
  const [timeoutMinutes, setTimeoutMinutes] = useState(String(settings.defaultRunTimeoutSeconds / 60));
  const [retries, setRetries] = useState(String(settings.defaultRunRetries));
  const [tokenBudget, setTokenBudget] = useState(settings.defaultTokenBudget === null ? "" : String(settings.defaultTokenBudget));
  const [costBudget, setCostBudget] = useState(settings.defaultCostBudgetCents === null ? "" : String(settings.defaultCostBudgetCents));
  const [networkPolicy, setNetworkPolicy] = useState<PlanningNetworkPolicy>(settings.planningNetworkPolicy);
  useEffect(() => {
    setTimeoutMinutes(String(settings.defaultRunTimeoutSeconds / 60));
    setRetries(String(settings.defaultRunRetries));
    setTokenBudget(settings.defaultTokenBudget === null ? "" : String(settings.defaultTokenBudget));
    setCostBudget(settings.defaultCostBudgetCents === null ? "" : String(settings.defaultCostBudgetCents));
    setNetworkPolicy(settings.planningNetworkPolicy);
  }, [settings]);

  async function saveExecutionDefaults(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await updateProjectSettings({
      defaultRunTimeoutSeconds: Math.round(Number(timeoutMinutes) * 60),
      defaultRunRetries: Number(retries),
      defaultTokenBudget: tokenBudget.trim() ? Number(tokenBudget) : null,
      defaultCostBudgetCents: costBudget.trim() ? Number(costBudget) : null,
      planningNetworkPolicy: networkPolicy,
    });
  }

  return <section className="settings-view">
    <div className="settings-intro"><div><p className="eyebrow">Workspace controls</p><h2>Configure {project.name}</h2><p>Manage the Project boundary and defaults that future model-backed agent runs will inherit.</p></div><span className="settings-status">✓ Project ready</span></div>
    <div className="settings-grid">
      <ContextEditor title="Project context" description="Shared knowledge about the product, architecture, repository relationships, conventions, deployment, and constraints." document={contextDocument} revisions={revisions} submitting={submitting} save={saveContext} />
      <form className="settings-card settings-card-wide" onSubmit={(event) => void saveExecutionDefaults(event)}>
        <div className="settings-card-heading"><span>E</span><div><h3>Execution defaults</h3><p>Optional limits future agent runs will inherit unless a task provides tighter values.</p></div></div>
        <div className="setup-field-grid"><label>Run timeout (minutes)<input type="number" min="0.5" max="1440" step="0.5" value={timeoutMinutes} onChange={(event) => setTimeoutMinutes(event.target.value)} required/></label><label>Retry attempts<select value={retries} onChange={(event) => setRetries(event.target.value)}><option value="0">No retries</option><option value="1">1 retry</option><option value="2">2 retries</option><option value="3">3 retries</option></select></label><label>Token budget <span>Optional</span><input type="number" min="1" max="10000000" value={tokenBudget} onChange={(event) => setTokenBudget(event.target.value)} placeholder="No project default"/></label><label>Cost budget in cents <span>Optional</span><input type="number" min="0.01" max="1000000" step="0.01" value={costBudget} onChange={(event) => setCostBudget(event.target.value)} placeholder="No project default"/></label></div>
        <label>Planning network policy<select value={networkPolicy} onChange={(event) => setNetworkPolicy(event.target.value as PlanningNetworkPolicy)}><option value="model-provider-only">Model provider only — recommended</option><option value="restricted">Restricted allowlist</option><option value="offline">Offline</option></select></label>
        <div className="settings-lock"><span>✓</span><div><strong>Director plan approval required</strong><small>This safeguard remains enforced for every proposed plan.</small></div></div>
        <div className="settings-card-actions end"><button className="primary-button" type="submit" disabled={submitting}>Save defaults</button></div>
      </form>

      <CodingHarnessesCard harnesses={codingHarnesses} statuses={codingHarnessStatuses} loading={codingHarnessesLoading || codingHarnessStatusesLoading} submitting={submitting} save={saveCodingHarness} remove={deleteCodingHarness} preflight={preflightCodingHarness} />
      <ModelBackendsCard backends={modelBackends} loading={modelBackendsLoading} submitting={submitting} save={saveModelBackend} remove={deleteModelBackend} />
    </div>
  </section>;
}

function ContextEditor({ title, description, document, revisions, submitting, save }: {
  title: string;
  description: string;
  document: ContextDocumentSummary | null;
  revisions: ContextRevisionSummary[];
  submitting: boolean;
  save: (content: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(document?.content ?? "");
  useEffect(() => { setDraft(document?.content ?? ""); }, [document?.id, document?.content]);
  const unchanged = draft === (document?.content ?? "");
  return <form className="settings-card settings-card-wide context-editor" onSubmit={(event) => { event.preventDefault(); void save(draft); }}>
    <div className="settings-card-heading"><span>◎</span><div><h3>{title}</h3><p>{description}</p></div></div>
    <label>Markdown<textarea value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={30000} placeholder="# Purpose\n\nDescribe how this works and the durable decisions agents should understand."/></label>
    <div className="context-editor-footer"><small>{document ? `Version ${document.version} · updated by ${roleLabels[document.updatedBy as AgentRole] ?? document.updatedBy}` : "No context saved yet"}</small><button className="primary-button" type="submit" disabled={submitting || unchanged}>Save context</button></div>
    {revisions.length > 0 && <details className="context-revisions"><summary>Revision history ({revisions.length})</summary><div>{revisions.slice(0, 8).map((revision) => <article key={revision.id}><strong>Version {revision.version}</strong><span>{roleLabels[revision.updatedBy as AgentRole] ?? revision.updatedBy} · {new Date(revision.createdAt).toLocaleString()}</span></article>)}</div></details>}
  </form>;
}

function ModelBackendsCard({ backends, loading, submitting, save, remove }: {
  backends: ModelBackendSummary[];
  loading: boolean;
  submitting: boolean;
  save: (input: SaveModelBackendInput, backendId?: string) => Promise<boolean>;
  remove: (backendId: string) => Promise<boolean>;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<ModelBackendProvider>("openai");
  const [protocol, setProtocol] = useState<ModelBackendProtocol>("openai-responses");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [authMode, setAuthMode] = useState<ModelBackendAuthMode>("chatgpt");
  const [credentialRef, setCredentialRef] = useState("");
  const [enabled, setEnabled] = useState(true);

  function resetEditor() {
    setEditingId(null);
    setName("");
    setProvider("openai");
    setProtocol("openai-responses");
    setModel("");
    setBaseUrl("");
    setAuthMode("chatgpt");
    setCredentialRef("");
    setEnabled(true);
  }

  function edit(backend: ModelBackendSummary) {
    setEditingId(backend.id);
    setName(backend.name);
    setProvider(backend.provider);
    setProtocol(backend.protocol);
    setModel(backend.model ?? "");
    setBaseUrl(backend.baseUrl ?? "");
    setAuthMode(backend.authMode);
    setCredentialRef(backend.credentialRef ?? "");
    setEnabled(backend.enabled);
  }

  function changeProvider(nextProvider: ModelBackendProvider) {
    const defaults = modelBackendDefaults(nextProvider);
    setProvider(nextProvider);
    setProtocol(defaults.protocol);
    setAuthMode(defaults.authMode);
    setCredentialRef(defaults.credentialRef);
    setBaseUrl(defaults.baseUrl);
  }

  function changeAuthMode(nextMode: ModelBackendAuthMode) {
    setAuthMode(nextMode);
    if (nextMode !== "api-key") setCredentialRef("");
    if (nextMode === "api-key" && !credentialRef) {
      setCredentialRef(modelBackendDefaults(provider).credentialRef || "MODEL_API_KEY");
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const saved = await save({
      name: name.trim(),
      provider,
      protocol,
      ...(model.trim() ? { model: model.trim() } : {}),
      ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
      authMode,
      ...(authMode === "api-key" && credentialRef.trim() ? { credentialRef: credentialRef.trim() } : {}),
      enabled,
    }, editingId ?? undefined);
    if (saved) resetEditor();
  }

  async function deleteBackend(backend: ModelBackendSummary) {
    if (!window.confirm(`Delete the model backend “${backend.name}”?`)) return;
    if (await remove(backend.id) && editingId === backend.id) resetEditor();
  }

  return <section className="settings-card settings-card-wide model-backends-card">
    <div className="brain-heading"><div className="settings-card-heading"><span>M</span><div><h3>Model backends</h3><p>Save the model endpoints and account connections that coding harnesses can use later.</p></div></div><span className={`brain-state ${backends.length ? "configured" : ""}`}>{loading ? "Loading…" : `${backends.length} configured`}</span></div>
    <div className="model-backend-layout">
      <div className="model-backend-list" aria-label="Configured model backends">
        <div className="setup-section-label"><span>Saved backends</span><small>{backends.length}</small></div>
        {backends.length === 0 ? <p className="setup-empty">No model backends yet. Add your ChatGPT Business login, RunPod endpoint, or another model service.</p> : backends.map((backend) => <button type="button" className={`model-backend-row ${editingId === backend.id ? "selected" : ""}`} onClick={() => edit(backend)} key={backend.id}>
          <span className={`backend-status ${backend.enabled ? "enabled" : ""}`}/>
          <span><strong>{backend.name}</strong><small>{modelBackendProviderLabel(backend.provider)} · {backend.model ?? "Provider default"}</small></span>
          <em>{protocolLabel(backend.protocol)}</em>
        </button>)}
      </div>
      <form className="model-backend-editor" onSubmit={(event) => void submit(event)}>
        <div className="setup-section-label"><span>{editingId ? "Edit backend" : "Add backend"}</span>{editingId && <button type="button" onClick={resetEditor}>New instead</button>}</div>
        <div className="brain-fields">
          <label>Display name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="RunPod DeepSeek" maxLength={120} required/></label>
          <label>Provider<select value={provider} onChange={(event) => changeProvider(event.target.value as ModelBackendProvider)}><option value="openai">OpenAI / ChatGPT</option><option value="anthropic">Anthropic</option><option value="runpod">RunPod</option><option value="openrouter">OpenRouter</option><option value="ollama">Ollama</option><option value="custom">Custom endpoint</option></select></label>
          <label>API protocol<select value={protocol} onChange={(event) => setProtocol(event.target.value as ModelBackendProtocol)}><option value="openai-responses">OpenAI Responses</option><option value="openai-chat-completions">OpenAI Chat Completions</option><option value="anthropic-messages">Anthropic Messages</option><option value="ollama">Ollama</option></select></label>
          <label>Model ID <span>Optional</span><input value={model} onChange={(event) => setModel(event.target.value)} placeholder={provider === "runpod" ? "deepseek-v3" : "Provider default"} maxLength={160}/></label>
          <label>Authentication<select value={authMode} onChange={(event) => changeAuthMode(event.target.value as ModelBackendAuthMode)}><option value="chatgpt" disabled={provider !== "openai"}>ChatGPT account</option><option value="api-key">API key reference</option><option value="none">No authentication</option></select></label>
          {authMode === "api-key" && <label>Credential environment variable<input value={credentialRef} onChange={(event) => setCredentialRef(event.target.value.toUpperCase())} placeholder="RUNPOD_API_KEY" pattern="[A-Z][A-Z0-9_]*" required/></label>}
          <label className="brain-base-url">Endpoint URL <span>{["runpod", "ollama", "custom"].includes(provider) ? "Required" : "Optional override"}</span><input type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder={provider === "ollama" ? "http://localhost:11434" : provider === "runpod" ? "https://api.runpod.ai/v2/.../openai/v1" : "Use provider default"} required={["runpod", "ollama", "custom"].includes(provider)}/></label>
        </div>
        <label className="backend-enabled"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)}/><span><strong>Enabled for runtime profiles</strong><small>Disabled backends remain saved but cannot be selected for new profiles.</small></span></label>
        <div className="credential-notice"><span>⌁</span><div><strong>Only credential references are stored</strong><p>API key values and ChatGPT session tokens remain outside the Project database.</p></div></div>
        <div className="settings-card-actions"><span>{editingId ? "Changes affect future runtime profiles." : "Harness compatibility is configured in the next layer."}</span><div>{editingId && <button className="text-button danger" type="button" disabled={submitting} onClick={() => { const backend = backends.find((candidate) => candidate.id === editingId); if (backend) void deleteBackend(backend); }}>Delete</button>}<button className="primary-button" type="submit" disabled={submitting || loading || !name.trim()}>{editingId ? "Save backend" : "Add backend"}</button></div></div>
      </form>
    </div>
  </section>;
}

function modelBackendDefaults(provider: ModelBackendProvider): {
  protocol: ModelBackendProtocol;
  authMode: ModelBackendAuthMode;
  credentialRef: string;
  baseUrl: string;
} {
  if (provider === "anthropic") return { protocol: "anthropic-messages", authMode: "api-key", credentialRef: "ANTHROPIC_API_KEY", baseUrl: "" };
  if (provider === "runpod") return { protocol: "openai-chat-completions", authMode: "api-key", credentialRef: "RUNPOD_API_KEY", baseUrl: "" };
  if (provider === "openrouter") return { protocol: "openai-chat-completions", authMode: "api-key", credentialRef: "OPENROUTER_API_KEY", baseUrl: "https://openrouter.ai/api/v1" };
  if (provider === "ollama") return { protocol: "ollama", authMode: "none", credentialRef: "", baseUrl: "http://localhost:11434" };
  if (provider === "custom") return { protocol: "openai-responses", authMode: "api-key", credentialRef: "MODEL_API_KEY", baseUrl: "" };
  return { protocol: "openai-responses", authMode: "chatgpt", credentialRef: "", baseUrl: "" };
}

function modelBackendProviderLabel(provider: ModelBackendProvider): string {
  if (provider === "openai") return "OpenAI / ChatGPT";
  if (provider === "openrouter") return "OpenRouter";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function protocolLabel(protocol: ModelBackendProtocol): string {
  if (protocol === "openai-responses") return "Responses";
  if (protocol === "openai-chat-completions") return "Chat Completions";
  if (protocol === "anthropic-messages") return "Messages";
  return "Ollama";
}

function CodingHarnessesCard({ harnesses, statuses, loading, submitting, save, remove, preflight }: {
  harnesses: CodingHarnessSummary[];
  statuses: CodingHarnessInstallationSummary[];
  loading: boolean;
  submitting: boolean;
  save: (input: SaveCodingHarnessInput, harnessId?: string) => Promise<boolean>;
  remove: (harnessId: string) => Promise<boolean>;
  preflight: (harnessId: string) => Promise<CodingHarnessPreflightSummary>;
}) {
  const initial = codingHarnessDefaults("codex");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState(initial.name);
  const [adapter, setAdapter] = useState<CodingHarnessAdapter>("codex");
  const [executable, setExecutable] = useState(initial.executable);
  const [containerImage, setContainerImage] = useState("");
  const [supportedProtocols, setSupportedProtocols] = useState<ModelBackendProtocol[]>(initial.protocols);
  const [capabilities, setCapabilities] = useState<HarnessCapability[]>(initial.capabilities);
  const [enabled, setEnabled] = useState(true);
  const [preflightResult, setPreflightResult] = useState<CodingHarnessPreflightSummary | null>(null);
  const [preflightRunning, setPreflightRunning] = useState(false);
  const selectedStatus = editingId
    ? statuses.find((status) => status.harnessId === editingId) ?? null
    : null;

  function resetEditor() {
    const defaults = codingHarnessDefaults("codex");
    setEditingId(null);
    setName(defaults.name);
    setAdapter("codex");
    setExecutable(defaults.executable);
    setContainerImage("");
    setSupportedProtocols(defaults.protocols);
    setCapabilities(defaults.capabilities);
    setEnabled(true);
    setPreflightResult(null);
  }

  function edit(harness: CodingHarnessSummary) {
    setEditingId(harness.id);
    setName(harness.name);
    setAdapter(harness.adapter);
    setExecutable(harness.executable);
    setContainerImage(harness.containerImage ?? "");
    setSupportedProtocols(harness.supportedProtocols);
    setCapabilities(harness.capabilities);
    setEnabled(harness.enabled);
    setPreflightResult(null);
  }

  function changeAdapter(nextAdapter: CodingHarnessAdapter) {
    const defaults = codingHarnessDefaults(nextAdapter);
    setAdapter(nextAdapter);
    setName(defaults.name);
    setExecutable(defaults.executable);
    setSupportedProtocols(defaults.protocols);
    setCapabilities(defaults.capabilities);
  }

  function toggleProtocol(protocol: ModelBackendProtocol) {
    setSupportedProtocols((current) => current.includes(protocol)
      ? current.filter((candidate) => candidate !== protocol)
      : [...current, protocol]);
  }

  function toggleCapability(capability: HarnessCapability) {
    setCapabilities((current) => current.includes(capability)
      ? current.filter((candidate) => candidate !== capability)
      : [...current, capability]);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const saved = await save({
      name: name.trim(),
      adapter,
      executable: executable.trim(),
      ...(containerImage.trim() ? { containerImage: containerImage.trim() } : {}),
      supportedProtocols,
      capabilities,
      enabled,
    }, editingId ?? undefined);
    if (saved) resetEditor();
  }

  async function deleteHarness(harness: CodingHarnessSummary) {
    if (!window.confirm(`Delete the coding harness “${harness.name}”?`)) return;
    if (await remove(harness.id) && editingId === harness.id) resetEditor();
  }

  async function runPreflight() {
    if (!editingId) return;
    setPreflightRunning(true);
    setPreflightResult(null);
    try {
      setPreflightResult(await preflight(editingId));
    } catch (error) {
      setPreflightResult({
        harnessId: editingId,
        state: "failed",
        version: null,
        workerImage: null,
        message: error instanceof Error ? error.message : "Unable to test Codex",
      });
    } finally {
      setPreflightRunning(false);
    }
  }

  const protocols: ModelBackendProtocol[] = ["openai-responses", "openai-chat-completions", "anthropic-messages", "ollama"];
  const availableCapabilities: HarnessCapability[] = ["planning", "coding", "review", "testing", "release"];

  return <section className="settings-card settings-card-wide coding-harnesses-card">
    <div className="brain-heading"><div className="settings-card-heading"><span>H</span><div><h3>Coding harnesses</h3><p>Register the agent CLIs that can operate repositories and declare which model protocols they understand.</p></div></div><span className={`brain-state ${statuses.some((status) => status.state === "installed") ? "configured" : ""}`}>{loading ? "Inspecting…" : `${statuses.filter((status) => status.state === "installed").length} installed`}</span></div>
    <div className="model-backend-layout">
      <div className="model-backend-list" aria-label="Configured coding harnesses">
        <div className="setup-section-label"><span>Saved harnesses</span><small>{harnesses.length}</small></div>
        {harnesses.length === 0 ? <p className="setup-empty">No harnesses yet. Register Codex, Claude Code, OpenCode, Pi, or another agent CLI.</p> : harnesses.map((harness) => { const status = statuses.find((candidate) => candidate.harnessId === harness.id); return <button type="button" className={`model-backend-row ${editingId === harness.id ? "selected" : ""}`} onClick={() => edit(harness)} key={harness.id}>
          <span className={`backend-status ${status?.state === "installed" ? "enabled" : status?.state === "controller-unavailable" ? "warning" : ""}`}/>
          <span><strong>{harness.name}</strong><small>{codingHarnessAdapterLabel(harness.adapter)} · {harness.executable}</small></span>
          <em>{status?.state === "installed" ? "Installed" : status?.state === "controller-unavailable" ? "Unknown" : "Missing"}</em>
        </button>; })}
      </div>
      <form className="model-backend-editor harness-editor" onSubmit={(event) => void submit(event)}>
        <div className="setup-section-label"><span>{editingId ? "Edit harness" : "Add harness"}</span>{editingId && <button type="button" onClick={resetEditor}>New instead</button>}</div>
        <div className="brain-fields">
          <label>Display name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Codex CLI" maxLength={120} required/></label>
          <label>Adapter<select value={adapter} onChange={(event) => changeAdapter(event.target.value as CodingHarnessAdapter)}><option value="codex">Codex</option><option value="claude-code">Claude Code</option><option value="opencode">OpenCode</option><option value="pi">Pi</option><option value="deepseek-harness">DeepSeek Harness</option><option value="grok-build">Grok Build</option><option value="custom">Custom CLI</option></select></label>
          <label>Executable<input value={executable} onChange={(event) => setExecutable(event.target.value)} placeholder="codex" pattern="[a-zA-Z0-9_./-]+" required/></label>
          <label className="brain-base-url">Container image <span>Optional until execution</span><input value={containerImage} onChange={(event) => setContainerImage(event.target.value)} placeholder="local/engineering-team-codex:latest" pattern="[a-zA-Z0-9][a-zA-Z0-9._/@:-]*"/></label>
        </div>
        <fieldset className="harness-options"><legend>Supported model protocols</legend><div className="harness-chip-grid">{protocols.map((candidate) => <label className={supportedProtocols.includes(candidate) ? "selected" : ""} key={candidate}><input type="checkbox" checked={supportedProtocols.includes(candidate)} onChange={() => toggleProtocol(candidate)}/><span>{protocolLabel(candidate)}</span></label>)}</div><small>Runtime profiles will only offer backends with at least one matching protocol.</small></fieldset>
        <fieldset className="harness-options"><legend>Capabilities</legend><div className="harness-chip-grid capabilities">{availableCapabilities.map((capability) => <label className={capabilities.includes(capability) ? "selected" : ""} key={capability}><input type="checkbox" checked={capabilities.includes(capability)} onChange={() => toggleCapability(capability)}/><span>{capability}</span></label>)}</div></fieldset>
        <label className="backend-enabled"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)}/><span><strong>Enabled for runtime profiles</strong><small>Registration does not install or execute the harness. The runtime adapter will verify it before use.</small></span></label>
        {editingId && <div className={`harness-installation ${selectedStatus?.state ?? "missing"}`}><span>{selectedStatus?.state === "installed" ? "✓" : selectedStatus?.state === "controller-unavailable" ? "?" : "↓"}</span><div><strong>{selectedStatus?.state === "installed" ? selectedStatus.version ?? "Codex installed" : selectedStatus?.state === "controller-unavailable" ? "Controller unavailable" : "Harness missing"}</strong><p>{selectedStatus?.message ?? "The worker controller has not reported this harness."}</p></div>{adapter === "codex" && <button className="text-button" type="button" disabled={preflightRunning || selectedStatus?.state !== "installed"} onClick={() => void runPreflight()}>{preflightRunning ? "Testing…" : "Test Codex"}</button>}</div>}
        {preflightResult && <div className={`harness-preflight ${preflightResult.state}`}><strong>{preflightResult.state === "ready" ? "✓ Ready" : preflightResult.state === "not-configured" ? "Authentication not configured" : preflightResult.state === "unsupported" ? "Not supported" : "Test failed"}</strong><p>{preflightResult.message}</p></div>}
        <div className="settings-card-actions"><span>Executable fields accept a binary name or path, never shell arguments.</span><div>{editingId && <button className="text-button danger" type="button" disabled={submitting} onClick={() => { const harness = harnesses.find((candidate) => candidate.id === editingId); if (harness) void deleteHarness(harness); }}>Delete</button>}<button className="primary-button" type="submit" disabled={submitting || loading || !name.trim() || !executable.trim() || supportedProtocols.length === 0 || capabilities.length === 0}>{editingId ? "Save harness" : "Add harness"}</button></div></div>
      </form>
    </div>
  </section>;
}

function codingHarnessDefaults(adapter: CodingHarnessAdapter): {
  name: string;
  executable: string;
  protocols: ModelBackendProtocol[];
  capabilities: HarnessCapability[];
} {
  const standardCapabilities: HarnessCapability[] = ["planning", "coding", "review", "testing"];
  if (adapter === "claude-code") return { name: "Claude Code", executable: "claude", protocols: ["anthropic-messages"], capabilities: standardCapabilities };
  if (adapter === "opencode") return { name: "OpenCode", executable: "opencode", protocols: ["openai-responses", "openai-chat-completions", "anthropic-messages", "ollama"], capabilities: standardCapabilities };
  if (adapter === "pi") return { name: "Pi", executable: "pi", protocols: ["openai-responses", "openai-chat-completions", "anthropic-messages"], capabilities: standardCapabilities };
  if (adapter === "deepseek-harness") return { name: "DeepSeek Harness", executable: "deepseek", protocols: ["openai-chat-completions"], capabilities: standardCapabilities };
  if (adapter === "grok-build") return { name: "Grok Build", executable: "grok", protocols: ["openai-responses", "openai-chat-completions"], capabilities: standardCapabilities };
  if (adapter === "custom") return { name: "Custom CLI", executable: "agent", protocols: ["openai-responses"], capabilities: ["coding"] };
  return { name: "Codex CLI", executable: "codex", protocols: ["openai-responses"], capabilities: standardCapabilities };
}

function codingHarnessAdapterLabel(adapter: CodingHarnessAdapter): string {
  if (adapter === "claude-code") return "Claude Code";
  if (adapter === "deepseek-harness") return "DeepSeek Harness";
  if (adapter === "grok-build") return "Grok Build";
  if (adapter === "opencode") return "OpenCode";
  if (adapter === "custom") return "Custom CLI";
  return adapter.charAt(0).toUpperCase() + adapter.slice(1);
}

function LiveView({ orchestration, runtimeAssignments, codingHarnesses, modelBackends, selectedRole, openChatRole, showAgentChat, assignRuntime, cancelTask, cancelAgentRun, chatDraft, setChatDraft, sendMessage, removeDirective, updateRolePrompt, submitting, loading }: {
  orchestration: OrchestrationState | null;
  runtimeAssignments: AgentRuntimeAssignmentSummary[];
  codingHarnesses: CodingHarnessSummary[];
  modelBackends: ModelBackendSummary[];
  selectedRole: AgentRole;
  openChatRole: AgentRole | null;
  showAgentChat: (role: AgentRole | null) => void;
  assignRuntime: (agentRole: AgentRole, codingHarnessId: string | null, modelBackendId: string | null, fallbackCodingHarnessId?: string | null, fallbackModelBackendId?: string | null) => Promise<boolean>;
  cancelTask: (taskId: string) => Promise<void>;
  cancelAgentRun: (agentRole: AgentRole, runId: string) => Promise<void>;
  chatDraft: string;
  setChatDraft: (value: string) => void;
  sendMessage: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  removeDirective: (agentRole: AgentRole, directiveId: string) => Promise<void>;
  updateRolePrompt: (agentRole: AgentRole, rolePrompt: string, consultationRoles: AgentRole[]) => Promise<boolean>;
  submitting: boolean;
  loading: boolean;
}) {
  const [editingRuntimeRole, setEditingRuntimeRole] = useState<AgentRole | null>(null);
  const [agentPanel, setAgentPanel] = useState<"role" | "directives" | "memory" | "chat">("chat");
  const [rolePromptDraft, setRolePromptDraft] = useState("");
  const [consultationRolesDraft, setConsultationRolesDraft] = useState<AgentRole[]>([]);
  const chatPanelRef = useRef<HTMLElement | null>(null);
  const messages = orchestration?.messages.filter((message) => message.agentRole === selectedRole) ?? [];
  const directives = orchestration?.directives.filter((directive) => directive.agentRole === selectedRole) ?? [];
  const agentConfiguration = orchestration?.agentConfigurations.find((configuration) => configuration.agentRole === selectedRole);
  const activeRun = orchestration?.runs.find((run) => run.agentRole === selectedRole && ["queued", "provisioning", "running", "waiting"].includes(run.status));
  const activeTaskRun = activeRun?.taskId ? activeRun : undefined;
  const assignmentByRole = new Map(runtimeAssignments.map((assignment) => [assignment.agentRole, assignment]));
  const selectedAssignment = assignmentByRole.get(selectedRole);
  const selectedHarness = codingHarnesses.find((candidate) => candidate.id === selectedAssignment?.codingHarnessId);
  const selectedBackend = modelBackends.find((candidate) => candidate.id === selectedAssignment?.modelBackendId);
  const selectedRuntimeReady = Boolean(
    selectedHarness?.enabled
    && selectedHarness.adapter === "codex"
    && selectedHarness.capabilities.includes("planning")
    && selectedBackend?.enabled
    && selectedBackend.provider === "openai"
    && selectedBackend.protocol === "openai-responses",
  );
  const selectedRuntimeAssigned = Boolean(selectedAssignment?.codingHarnessId && selectedAssignment.modelBackendId);

  useEffect(() => {
    setRolePromptDraft(agentConfiguration?.rolePrompt ?? "");
    setConsultationRolesDraft(agentConfiguration?.consultationRoles ?? []);
  }, [agentConfiguration?.rolePrompt, agentConfiguration?.consultationRoles, selectedRole]);

  function openRuntimeMenu(role: AgentRole) {
    showAgentChat(null);
    setEditingRuntimeRole(role);
  }

  function openAgentChat(role: AgentRole) {
    setEditingRuntimeRole(null);
    if (openChatRole === role) return;
    setAgentPanel("chat");
    showAgentChat(role);
  }

  useEffect(() => {
    if (!openChatRole) return;
    function closeChatOnOutsideClick(event: PointerEvent) {
      if (event.target instanceof Node && chatPanelRef.current?.contains(event.target)) return;
      if (event.target instanceof Element && event.target.closest(".agent-card.chat-open")) return;
      showAgentChat(null);
    }
    document.addEventListener("pointerdown", closeChatOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeChatOnOutsideClick);
  }, [openChatRole, showAgentChat]);

  async function chooseHarness(role: AgentRole, harnessId: string | null) {
    const assignment = assignmentByRole.get(role);
    const backend = modelBackends.find((candidate) => candidate.id === assignment?.modelBackendId);
    const harness = codingHarnesses.find((candidate) => candidate.id === harnessId);
    const backendId = harness && backend && !harness.supportedProtocols.includes(backend.protocol)
      ? null
      : assignment?.modelBackendId ?? null;
    await assignRuntime(role, harnessId, backendId, assignment?.fallbackCodingHarnessId ?? null, assignment?.fallbackModelBackendId ?? null);
  }

  async function chooseModel(role: AgentRole, backendId: string | null) {
    const assignment = assignmentByRole.get(role);
    await assignRuntime(role, assignment?.codingHarnessId ?? null, backendId, assignment?.fallbackCodingHarnessId ?? null, assignment?.fallbackModelBackendId ?? null);
  }

  async function chooseFallbackHarness(role: AgentRole, harnessId: string | null) {
    const assignment = assignmentByRole.get(role);
    const backend = modelBackends.find((candidate) => candidate.id === assignment?.fallbackModelBackendId);
    const harness = codingHarnesses.find((candidate) => candidate.id === harnessId);
    const backendId = harness && backend && !harness.supportedProtocols.includes(backend.protocol)
      ? null
      : assignment?.fallbackModelBackendId ?? null;
    await assignRuntime(role, assignment?.codingHarnessId ?? null, assignment?.modelBackendId ?? null, harnessId, backendId);
  }

  async function chooseFallbackModel(role: AgentRole, backendId: string | null) {
    const assignment = assignmentByRole.get(role);
    await assignRuntime(role, assignment?.codingHarnessId ?? null, assignment?.modelBackendId ?? null, assignment?.fallbackCodingHarnessId ?? null, backendId);
  }
  return <section className="live-layout">
    <div className="team-column">
      <div className="view-title"><div><p className="eyebrow">Team presence</p><h2>Your engineering organization</h2></div><span>{loading ? "Refreshing…" : `${agentRoles.length + 1} team members`}</span></div>
      <div className="agent-grid">
        <div className="agent-row agents-1 director-row"><div className="agent-card director-card"><div className="agent-card-main"><span className="agent-avatar presence-director">ED</span><span className="agent-copy"><span className="agent-name-row"><strong>Engineering Director</strong><small>live</small></span><span className="agent-task">You</span></span></div></div></div>
        {teamRows.map((row, rowIndex) => <Fragment key={rowIndex}><div className={`agent-row agents-${row.length}`}>{row.map((role) => {
        const roleRun = orchestration?.runs.find((run) => run.agentRole === role && ["queued", "provisioning", "running"].includes(run.status));
        const activeTask = roleRun?.taskId
          ? orchestration?.tasks.find((task) => task.id === roleRun.taskId)
          : taskForRole(orchestration?.tasks ?? [], role);
        const activity = roleRun ? orchestration?.runActivities[roleRun.id] : undefined;
        const presence = roleRun ? "working" : activeTask ? presenceForTask(activeTask) : "available";
        const assignment = assignmentByRole.get(role);
        const harness = codingHarnesses.find((candidate) => candidate.id === assignment?.codingHarnessId);
        const backend = modelBackends.find((candidate) => candidate.id === assignment?.modelBackendId);
        const fallbackHarness = codingHarnesses.find((candidate) => candidate.id === assignment?.fallbackCodingHarnessId);
        const fallbackBackend = modelBackends.find((candidate) => candidate.id === assignment?.fallbackModelBackendId);
        const editingRuntime = editingRuntimeRole === role;
        const chatOpen = openChatRole === role;
        return <div className={`agent-card ${chatOpen ? "selected chat-open" : ""} ${editingRuntime ? "runtime-open" : ""}`} key={role}>
          <button className="agent-card-main" type="button" onClick={() => openAgentChat(role)}>
            <span className={`agent-avatar presence-${presence}`}>{roleInitials[role]}</span>
            <span className="agent-copy"><span className="agent-name-row"><strong>{roleLabels[role]}</strong><small>{presence}</small></span><span className="agent-task">{roleRun ? roleRun.taskId ? activeTask?.title ?? "Working" : roleRun.spec.upstreamArtifacts.some((artifact) => artifact.startsWith("director-message:")) ? "Chatting with you" : role === "project_manager" ? "Planning" : "Consulting on project plan" : activeTask?.title ?? "Waiting"}</span></span>
          </button>
          <div className="agent-runtime-summary" aria-label={`${roleLabels[role]} runtime`}>
              <button type="button" disabled={submitting || loading || Boolean(roleRun)} onClick={() => openRuntimeMenu(role)}>{harness?.name ?? "No harness"}</button>
              <span>·</span>
              <button type="button" disabled={submitting || loading || Boolean(roleRun)} onClick={() => openRuntimeMenu(role)}>{backend?.model ?? backend?.name ?? "No Model"}</button>
              {fallbackHarness && fallbackBackend && <small title={`Fallback: ${fallbackHarness.name} · ${fallbackBackend.model ?? fallbackBackend.name}`}>↳ {fallbackBackend.model ?? fallbackBackend.name}</small>}
          </div>
          {roleRun && <div className="agent-live-activity"><span>{activity?.message ?? "Starting isolated worker…"}</span><button type="button" disabled={submitting} onClick={(event) => { event.stopPropagation(); void (roleRun.taskId ? cancelTask(roleRun.taskId) : cancelAgentRun(role, roleRun.id)); }}>Cancel</button></div>}
          {editingRuntime && <div className="agent-runtime-menu">
            <div className="agent-runtime-menu-heading"><strong>Primary runtime</strong><button type="button" onClick={() => setEditingRuntimeRole(null)} aria-label="Close runtime selector">×</button></div>
            <div className="agent-runtime-lists">
              <section><h4>Harnesses</h4><div className="agent-runtime-options"><button type="button" className={!assignment?.codingHarnessId ? "selected" : ""} disabled={submitting} onClick={() => void chooseHarness(role, null)}>No harness</button>{codingHarnesses.map((candidate) => <button type="button" className={assignment?.codingHarnessId === candidate.id ? "selected" : ""} disabled={submitting || !candidate.enabled} onClick={() => void chooseHarness(role, candidate.id)} key={candidate.id}>{candidate.name}</button>)}</div></section>
              <section><h4>Models</h4><div className="agent-runtime-options"><button type="button" className={!assignment?.modelBackendId ? "selected" : ""} disabled={submitting} onClick={() => void chooseModel(role, null)}>No Model</button>{modelBackends.map((candidate) => {
                const compatible = !harness || harness.supportedProtocols.includes(candidate.protocol);
                return <button type="button" className={assignment?.modelBackendId === candidate.id ? "selected" : ""} disabled={submitting || !candidate.enabled || !compatible} onClick={() => void chooseModel(role, candidate.id)} key={candidate.id}>{candidate.model ?? candidate.name}</button>;
              })}</div></section>
            </div>
            <div className="agent-runtime-menu-heading fallback-heading"><strong>Fallback runtime</strong><small>Used for quota and provider failures</small></div>
            <div className="agent-runtime-lists">
              <section><h4>Harnesses</h4><div className="agent-runtime-options"><button type="button" className={!assignment?.fallbackCodingHarnessId ? "selected" : ""} disabled={submitting} onClick={() => void chooseFallbackHarness(role, null)}>No fallback</button>{codingHarnesses.map((candidate) => <button type="button" className={assignment?.fallbackCodingHarnessId === candidate.id ? "selected" : ""} disabled={submitting || !candidate.enabled} onClick={() => void chooseFallbackHarness(role, candidate.id)} key={candidate.id}>{candidate.name}</button>)}</div></section>
              <section><h4>Models</h4><div className="agent-runtime-options"><button type="button" className={!assignment?.fallbackModelBackendId ? "selected" : ""} disabled={submitting} onClick={() => void chooseFallbackModel(role, null)}>No fallback</button>{modelBackends.map((candidate) => {
                const compatible = !fallbackHarness || fallbackHarness.supportedProtocols.includes(candidate.protocol);
                return <button type="button" className={assignment?.fallbackModelBackendId === candidate.id ? "selected" : ""} disabled={submitting || !candidate.enabled || !compatible} onClick={() => void chooseFallbackModel(role, candidate.id)} key={candidate.id}>{candidate.model ?? candidate.name}</button>;
              })}</div></section>
            </div>
          </div>}
        </div>;
      })}</div>{openChatRole && row.includes(openChatRole) && <article className="chat-panel agent-chat-popover" ref={chatPanelRef}>
          <header><nav className="agent-panel-tabs" aria-label={`${roleLabels[selectedRole]} details`}><button className={agentPanel === "role" ? "active" : ""} type="button" onClick={() => setAgentPanel("role")}>Role</button><button className={agentPanel === "directives" ? "active" : ""} type="button" onClick={() => setAgentPanel("directives")}>Directives</button><button className={agentPanel === "memory" ? "active" : ""} type="button" onClick={() => setAgentPanel("memory")}>Memory</button><button className={agentPanel === "chat" ? "active" : ""} type="button" onClick={() => setAgentPanel("chat")}>Chat</button></nav><button className="chat-close" type="button" onClick={() => showAgentChat(null)} aria-label="Close agent panel">×</button></header>
          {agentPanel === "role" && <form className="role-prompt-panel" onSubmit={(event) => { event.preventDefault(); void updateRolePrompt(selectedRole, rolePromptDraft, consultationRolesDraft); }}><div><strong>Role prompt</strong><small>{agentConfiguration?.customized ? "Customized for this project" : "Default role definition"}</small></div><textarea value={rolePromptDraft} onChange={(event) => setRolePromptDraft(event.target.value)} maxLength={8000} required/><p>This guides the agent’s behavior. Fixed container and safety rules remain separate.</p><fieldset className="consultation-role-picker"><legend>Planning collaborators</legend><small>When this role leads planning, it can ask these agents for focused advice before finalizing the plan.</small><div>{agentRoles.filter((role) => role !== selectedRole).map((role) => <label key={role}><input type="checkbox" checked={consultationRolesDraft.includes(role)} onChange={(event) => setConsultationRolesDraft((current) => event.target.checked ? [...current, role] : current.filter((candidate) => candidate !== role))}/>{roleLabels[role]}</label>)}</div></fieldset><button type="submit" disabled={submitting || !rolePromptDraft.trim() || (rolePromptDraft.trim() === agentConfiguration?.rolePrompt && JSON.stringify(consultationRolesDraft) === JSON.stringify(agentConfiguration?.consultationRoles ?? []))}>Save role</button></form>}
          {agentPanel === "directives" && <section className="directive-panel"><p>Standing instructions remembered by {roleLabels[selectedRole]}.</p>{directives.length === 0 ? <small>No standing directives yet. Tell this agent “From now on…” to add one.</small> : <div>{directives.map((directive) => <article key={directive.id}><span>{directive.content}</span><button type="button" disabled={submitting} onClick={() => void removeDirective(selectedRole, directive.id)} aria-label="Remove directive">×</button></article>)}</div>}</section>}
          {agentPanel === "memory" && <section className="agent-memory-panel"><p>Long-term agent memory will appear here.</p><small>No memories have been stored yet.</small></section>}
          {agentPanel === "chat" && <><div className={`runtime-notice ${activeRun ? "runtime-active" : ""}`}>{activeTaskRun ? `${roleLabels[selectedRole]} is working on an active task. Sending guidance will preserve the current run, stop its container, and restart the interrupted stage with your instruction.` : activeRun ? `${roleLabels[selectedRole]} is considering your message in an isolated read-only worker.` : selectedRuntimeReady ? selectedRole === "project_manager" ? "Talk naturally, set standing directives, or describe a goal you want planned." : "Send a message to start a read-only conversation using this agent’s role, directives, and project context." : selectedRuntimeAssigned ? `The selected harness and model are not connected to ${roleLabels[selectedRole]} conversation yet. Choose an enabled Codex planning harness and OpenAI Responses model.` : `Choose a harness and model on the ${roleLabels[selectedRole]} card before starting a conversation.`}</div>
          <div className="message-list">{messages.length === 0 ? <div className="chat-empty"><span>⌁</span><p>Start a conversation with the {roleLabels[selectedRole]}.</p></div> : messages.map((message) => <div className={`message message-${message.author}`} key={message.id}><small>{message.author === "director" ? "You" : roleLabels[selectedRole]}</small><p>{message.body}</p><time>{new Date(message.createdAt).toLocaleString()}</time></div>)}</div>
          <form className="chat-composer" onSubmit={(event) => void sendMessage(event)}><textarea value={chatDraft} onChange={(event) => setChatDraft(event.target.value)} placeholder={activeTaskRun ? "Give guidance for the active task…" : selectedRole === "project_manager" ? "Talk to the Project Manager…" : `Message the ${roleLabels[selectedRole]}…`} required/><button type="submit" disabled={submitting || Boolean(activeRun && !activeTaskRun) || (!activeRun && !selectedRuntimeReady) || !chatDraft.trim()}>{activeTaskRun ? "Send guidance" : activeRun ? "Thinking…" : !selectedRuntimeReady ? "Assign runtime first" : "Send"}</button></form></>}
        </article>}</Fragment>)}</div>
    </div>
  </section>;
}

function TasksView({ project, orchestration, runtimeAssignments, reviews, selectedTaskId, showTaskDetails, loading, submitting, draftTasks, objectiveTitle, objectiveDescription, decisionNotes, setObjectiveTitle, setObjectiveDescription, setDecisionNotes, updateDraftTask, addDraftTask, removeDraftTask, createPlan, decideApproval, rerunTask, startTask, resumeTask, cancelTask }: {
  project: ProjectSummary;
  orchestration: OrchestrationState | null;
  runtimeAssignments: AgentRuntimeAssignmentSummary[];
  reviews: TaskReviewSummary[];
  selectedTaskId: string | null;
  showTaskDetails: (taskId: string | null) => void;
  loading: boolean;
  submitting: boolean;
  draftTasks: DraftTask[];
  objectiveTitle: string;
  objectiveDescription: string;
  decisionNotes: Record<string, string>;
  setObjectiveTitle: (value: string) => void;
  setObjectiveDescription: (value: string) => void;
  setDecisionNotes: Dispatch<SetStateAction<Record<string, string>>>;
  updateDraftTask: (index: number, patch: Partial<DraftTask>) => void;
  addDraftTask: () => void;
  removeDraftTask: (index: number) => void;
  createPlan: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  decideApproval: (approvalId: string, decision: "approved" | "rejected") => Promise<void>;
  rerunTask: (taskId: string) => Promise<void>;
  startTask: (taskId: string, runtime?: "primary" | "fallback") => Promise<void>;
  resumeTask: (taskId: string, stage: TaskWorkflowRecoveryStage) => Promise<void>;
  cancelTask: (taskId: string) => Promise<void>;
}) {
  const pendingApprovals = orchestration?.approvals.filter((approval) => approval.status === "pending") ?? [];
  const selectedTask = orchestration?.tasks.find((task) => task.id === selectedTaskId);
  return <section className="tasks-view">
    <div className="tasks-toolbar"><div><p className="eyebrow">Project board</p><h2>Work from idea to release</h2></div><details className="plan-popover"><summary>＋ Add Task</summary><form onSubmit={(event) => void createPlan(event)}><label>Objective<input value={objectiveTitle} onChange={(event) => setObjectiveTitle(event.target.value)} required/></label><label>Description<textarea value={objectiveDescription} onChange={(event) => setObjectiveDescription(event.target.value)} required/></label><div className="draft-list">{draftTasks.map((task, index) => <fieldset key={task.key}><legend>{task.key}</legend><label>Title<input value={task.title} onChange={(event) => updateDraftTask(index, { title: event.target.value })} required/></label><div className="field-row"><label>Agent<select value={task.assignedRole} onChange={(event) => updateDraftTask(index, { assignedRole: event.target.value as AgentRole })}>{agentRoles.map((role) => <option value={role} key={role}>{roleLabels[role]}</option>)}</select></label><label>Repository<select value={task.repositoryId} onChange={(event) => updateDraftTask(index, { repositoryId: event.target.value })}><option value="">Project-wide</option>{project.repositories.filter((repository) => repository.enabled && repository.available).map((repository) => <option value={repository.id} key={repository.id}>{repository.name}</option>)}</select></label></div><label>Acceptance criteria<textarea value={task.acceptanceCriteria} onChange={(event) => updateDraftTask(index, { acceptanceCriteria: event.target.value })} placeholder="One criterion per line" required/></label><div className="required-check-fields"><span>Required checks</span><label><input type="checkbox" checked={task.requiredChecks.qa} onChange={(event) => updateDraftTask(index, { requiredChecks: { ...task.requiredChecks, qa: event.target.checked } })}/> QA</label><label><input type="checkbox" checked={task.requiredChecks.codeReview} onChange={(event) => updateDraftTask(index, { requiredChecks: { ...task.requiredChecks, codeReview: event.target.checked } })}/> Code review</label><label><input type="checkbox" checked={task.requiredChecks.security} onChange={(event) => updateDraftTask(index, { requiredChecks: { ...task.requiredChecks, security: event.target.checked } })}/> Security</label></div><label>Depends on<select value={task.dependsOn} onChange={(event) => updateDraftTask(index, { dependsOn: event.target.value })}><option value="">No dependency</option>{draftTasks.slice(0, index).map((candidate) => <option value={candidate.key} key={candidate.key}>{candidate.key}: {candidate.title || "Untitled"}</option>)}</select></label>{draftTasks.length > 1 && <button className="text-button danger" type="button" onClick={() => removeDraftTask(index)}>Remove</button>}</fieldset>)}</div><div className="form-actions"><button className="text-button" type="button" onClick={addDraftTask}>Add task</button><button className="primary-button" type="submit" disabled={submitting}>Submit for approval</button></div></form></details></div>
    {pendingApprovals.length > 0 && <div className="approval-strip">{pendingApprovals.map((approval) => {
      const contextUpdates = orchestration?.proposedContextUpdates.filter((update) => update.approvalId === approval.id) ?? [];
      return <div className="approval-item" key={approval.id}><div><span>{approval.type === "integration" ? "Release Manager · integration approval" : "Director approval"}</span><strong>{approval.title}</strong><p>{approval.details}</p>{contextUpdates.length > 0 && <div className="proposed-context-updates"><b>Knowledge updates</b>{contextUpdates.map((update) => <article key={update.id}><strong>{update.repositoryId === null ? "Project context" : `${project.repositories.find((repository) => repository.id === update.repositoryId)?.name ?? "Repository"} context`}</strong><p>{update.reason}</p><details><summary>Review proposed Markdown</summary><pre>{update.content}</pre></details></article>)}</div>}</div><textarea value={decisionNotes[approval.id] ?? ""} onChange={(event) => setDecisionNotes((current) => ({ ...current, [approval.id]: event.target.value }))} placeholder={approval.type === "integration" ? "Optional integration note" : "Optional note"}/><button className="reject" disabled={submitting} onClick={() => void decideApproval(approval.id, "rejected")}>{approval.type === "integration" ? "Reject" : "Reject"}</button><button className="approve" disabled={submitting} onClick={() => void decideApproval(approval.id, "approved")}>{approval.type === "integration" ? "Approve & apply" : "Approve"}</button></div>;
    })}</div>}
    <div className="kanban" aria-busy={loading}>{kanbanColumns.map((column) => {
      const tasks = orchestration?.tasks.filter((task) => task.status === column.status) ?? [];
      return <section className={`kanban-column column-${column.status}`} key={column.status}><header><span>{column.label}</span><small>{tasks.length}</small></header><div className="kanban-cards">{tasks.length === 0 ? <p className="column-empty">No tasks</p> : tasks.map((task) => <TaskCard task={task} project={project} runs={orchestration?.runs ?? []} runActivities={orchestration?.runActivities ?? {}} runtimeAssignment={runtimeAssignments.find((assignment) => assignment.agentRole === task.assignedRole)} review={reviews.find((candidate) => candidate.taskId === task.id)} recovery={orchestration?.recoveries.find((candidate) => candidate.taskId === task.id)} integrationProposal={orchestration?.integrationProposals.find((candidate) => candidate.taskId === task.id)} selected={selectedTaskId === task.id} openDetails={() => showTaskDetails(task.id)} submitting={submitting} rerunTask={rerunTask} startTask={startTask} resumeTask={resumeTask} cancelTask={cancelTask} key={task.id}/>)}</div></section>;
    })}</div>
    {selectedTask && <TaskWorkflowPanel project={project} task={selectedTask} review={reviews.find((candidate) => candidate.taskId === selectedTask.id)} recovery={orchestration?.recoveries.find((candidate) => candidate.taskId === selectedTask.id)} integrationProposal={orchestration?.integrationProposals.find((candidate) => candidate.taskId === selectedTask.id)} integrationApproval={orchestration?.approvals.find((candidate) => candidate.id === orchestration?.integrationProposals.find((proposal) => proposal.taskId === selectedTask.id)?.approvalId)} submitting={submitting} resumeTask={resumeTask} close={() => showTaskDetails(null)} />}
  </section>;
}

function TaskCard({ task, project, runs, runActivities, runtimeAssignment, review, recovery, integrationProposal, selected, openDetails, submitting, rerunTask, startTask, resumeTask, cancelTask }: { task: TaskSummary; project: ProjectSummary; runs: OrchestrationState["runs"]; runActivities: OrchestrationState["runActivities"]; runtimeAssignment: AgentRuntimeAssignmentSummary | undefined; review: TaskReviewSummary | undefined; recovery: OrchestrationState["recoveries"][number] | undefined; integrationProposal: OrchestrationState["integrationProposals"][number] | undefined; selected: boolean; openDetails: () => void; submitting: boolean; rerunTask: (taskId: string) => Promise<void>; startTask: (taskId: string, runtime?: "primary" | "fallback") => Promise<void>; resumeTask: (taskId: string, stage: TaskWorkflowRecoveryStage) => Promise<void>; cancelTask: (taskId: string) => Promise<void> }) {
  const taskRuns = runs.filter((run) => run.taskId === task.id);
  const activeRun = taskRuns.find((run) => ["queued", "provisioning", "running"].includes(run.status));
  const latestRun = taskRuns[0];
  const implementationRun = taskRuns.find((run) => ["implementation", "repair"].includes(run.spec.runPurpose ?? "implementation") && (run.result?.commits.length ?? 0) > 0);
  const repositoryNames = task.repositoryIds.map((id) => project.repositories.find((repository) => repository.id === id)?.name).filter(Boolean);
  const branches = review?.branches ?? [...new Set(implementationRun?.result?.artifacts.filter((artifact) => artifact.startsWith("git:")).map((artifact) => artifact.slice(4)) ?? [])];
  const requiredChecks = [
    { key: "qa", label: "QA", required: task.requiredChecks.qa },
    { key: "code_review", label: "Review", required: task.requiredChecks.codeReview },
    { key: "security", label: "Security", required: task.requiredChecks.security },
  ].filter((check) => check.required).map((check) => {
    const checkRuns = taskRuns.filter((run) => run.spec.runPurpose === "verification" && run.spec.verificationCheck === check.key && (!implementationRun || run.spec.upstreamArtifacts.includes(`implementation-run:${implementationRun.id}`)));
    const run = checkRuns[0];
    const status = run && ["queued", "provisioning", "running"].includes(run.status)
      ? "running"
      : run?.status === "completed" && run.result?.status === "completed"
        ? "passed"
        : run
          ? "failed"
          : "pending";
    return { ...check, status, summary: run?.result?.summary };
  });
  const hasFailedCheck = requiredChecks.some((check) => check.status === "failed");
  const hasFallbackRuntime = Boolean(runtimeAssignment?.fallbackCodingHarnessId && runtimeAssignment.fallbackModelBackendId);
  const displayedResult = implementationRun?.result ?? latestRun?.result;
  const liveActivity = activeRun ? runActivities[activeRun.id] : undefined;
  const handleAction = (event: MouseEvent<HTMLButtonElement>, action: () => Promise<void>) => { event.stopPropagation(); void action(); };
  const integrationLabel = integrationProposal?.status === "pending" ? "Awaiting Director approval" : integrationProposal?.status === "rejected" ? "Integration rejected" : integrationProposal?.status === "applied" ? "Applied" : review?.state === "stale" ? "Stale branch" : review?.state === "applicable" ? "Release assessment pending" : review?.state === "applied" ? "Applied" : "Evidence report";
  return <article className={`kanban-card task-card-clickable ${selected ? "selected" : ""}`} role="button" tabIndex={0} aria-expanded={selected} onClick={openDetails} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openDetails(); } }}><div className="card-tags"><span>{repositoryNames.length ? repositoryNames.join(" · ") : "Project-wide"}</span><small>View details</small></div><h3>{task.title}</h3><p>{task.description || task.acceptanceCriteria[0]}</p>{recovery && <div className="task-recovery-notice"><strong>Workflow interrupted</strong><span>{recovery.stage.replaceAll("_", " ")} can resume without discarding completed evidence.</span></div>}{activeRun && <small className="task-live-activity">{liveActivity?.message ?? "Starting isolated worker…"}</small>}{requiredChecks.length > 0 && <div className="task-required-checks" aria-label="Required checks">{requiredChecks.map((check) => <span className={check.status} title={check.summary} key={check.key}>{check.label} · {check.status}</span>)}</div>}{displayedResult && <small className={`task-run-result ${displayedResult.status}`}>{displayedResult.summary}</small>}{review && <small className={`task-review-status ${integrationProposal?.status ?? review.state}`}><strong>{integrationLabel}</strong><span>{integrationProposal?.status === "pending" ? "The Release Manager proposal is ready in Director approvals." : review.message}</span></small>}{branches.length > 0 && <div className="task-branches"><span>{review?.state === "applied" ? "Applied branch" : "Branch"}</span>{branches.map((branch) => <code className={review?.state === "applied" ? "applied" : ""} key={branch}>{branch}</code>)}</div>}<footer><span className="mini-avatar">{roleInitials[task.assignedRole]}</span><small>{roleLabels[task.assignedRole]}</small></footer>{recovery && <button className="task-action recovery" disabled={submitting} onClick={(event) => handleAction(event, () => resumeTask(task.id, recovery.stage))}>Resume workflow</button>}{!recovery && task.status === "ready" && <button className="task-action" disabled={submitting} onClick={(event) => handleAction(event, () => startTask(task.id))}>Start</button>}{!recovery && task.status === "in_progress" && (activeRun ? <button className="task-action cancel" disabled={submitting} onClick={(event) => handleAction(event, () => cancelTask(task.id))}>Cancel run</button> : <><button className="task-action" disabled={submitting} onClick={(event) => handleAction(event, () => startTask(task.id))}>{hasFailedCheck ? "Repair and re-check" : latestRun?.status === "failed" ? "Retry primary" : "Run agent"}</button>{latestRun?.status === "failed" && hasFallbackRuntime && <button className="task-action fallback" disabled={submitting} onClick={(event) => handleAction(event, () => startTask(task.id, "fallback"))}>Retry with fallback</button>}</>)}{integrationProposal?.status === "rejected" && <button className="task-action rerun" disabled={submitting} onClick={(event) => handleAction(event, () => rerunTask(task.id))}>Revise and re-check</button>}{integrationProposal?.status !== "rejected" && ["review", "completed"].includes(task.status) && review?.state === "stale" && <button className="task-action rerun" disabled={submitting} onClick={(event) => handleAction(event, () => rerunTask(task.id))}>Re-run on current</button>}</article>;
}

function TaskWorkflowPanel({ project, task, review, recovery, integrationProposal, integrationApproval, submitting, resumeTask, close }: { project: ProjectSummary; task: TaskSummary; review: TaskReviewSummary | undefined; recovery: OrchestrationState["recoveries"][number] | undefined; integrationProposal: OrchestrationState["integrationProposals"][number] | undefined; integrationApproval: OrchestrationState["approvals"][number] | undefined; submitting: boolean; resumeTask: (taskId: string, stage: TaskWorkflowRecoveryStage) => Promise<void>; close: () => void }) {
  const [detail, setDetail] = useState<TaskWorkflowDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) { if (event.key === "Escape") close(); }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [close]);
  useEffect(() => {
    let cancelled = false;
    async function loadDetail() {
      try {
        const response = await fetch(`/api/projects/${project.id}/tasks/${task.id}/workflow`);
        const body = await readResponse<TaskWorkflowDetailResponse | ApiError>(response);
        if (!response.ok) throw new Error("message" in body ? body.message : "Unable to load task workflow");
        if (!cancelled) {
          setDetail(body as TaskWorkflowDetailResponse);
          setError(null);
          setLoading(false);
        }
      } catch (requestError) {
        if (!cancelled) {
          setError(requestError instanceof Error ? requestError.message : "Unable to load task workflow");
          setLoading(false);
        }
      }
    }
    void loadDetail();
    const timer = task.status === "in_progress" ? window.setInterval(() => { void loadDetail(); }, 2_000) : null;
    return () => {
      cancelled = true;
      if (timer !== null) window.clearInterval(timer);
    };
  }, [project.id, task.id, task.status]);

  const runs = detail ? [...detail.runs].reverse() : [];
  const usage = detail?.runs.flatMap((item) => item.usage) ?? [];
  const totalInputTokens = usage.reduce((total, item) => total + item.inputTokens, 0);
  const totalOutputTokens = usage.reduce((total, item) => total + item.outputTokens, 0);
  const totalDuration = usage.reduce((total, item) => total + (item.durationMs ?? 0), 0);
  const repositoryNames = task.repositoryIds.map((id) => project.repositories.find((repository) => repository.id === id)?.name).filter(Boolean);
  return <div className="task-detail-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <article className="task-workflow-panel" role="dialog" aria-modal="true" aria-labelledby="task-detail-title">
      <header className="task-detail-header"><div><p className="eyebrow">Task workflow</p><h2 id="task-detail-title">{task.title}</h2><div className="task-detail-meta"><span className={`workflow-status ${task.status}`}>{task.status.replaceAll("_", " ")}</span><span>{repositoryNames.length ? repositoryNames.join(" · ") : "Project-wide"}</span><span>{roleLabels[task.assignedRole]}</span></div></div><div className="task-detail-header-actions">{recovery && <button className="resume-workflow" type="button" disabled={submitting} onClick={() => void resumeTask(task.id, recovery.stage)}>Resume workflow</button>}<button className="task-detail-close" type="button" onClick={close} aria-label="Close task details">×</button></div></header>
      <div className="task-detail-body">
        {recovery && <section className="task-recovery-banner"><div><strong>Workflow interrupted during {recovery.stage.replaceAll("_", " ")}</strong><p>{recovery.reason}</p></div><span>Completed checks and artifacts are preserved. Resume continues from the last durable stage.</span></section>}
        {integrationProposal && <section className={`task-integration-proposal ${integrationProposal.status}`}><div><strong>Release Manager · {integrationProposal.status}</strong><p>{integrationApproval?.title ?? "Integration proposal"}</p></div><span>{integrationProposal.status === "pending" ? "Review this proposal in Director approvals above the board. Nothing is applied until you approve it." : integrationProposal.status === "rejected" ? "The repositories were not changed." : integrationProposal.status === "applied" ? "The approved commits were applied to the target branches." : "Integration is approved."}</span>{integrationApproval?.details && <pre>{integrationApproval.details}</pre>}</section>}
        <section className="task-detail-summary"><div><h3>Objective</h3><p>{task.description || "No additional task description."}</p></div><div><h3>Acceptance criteria</h3><ul>{task.acceptanceCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul></div></section>
        <section className="task-detail-metrics"><div><strong>{runs.length}</strong><span>agent runs</span></div><div><strong>{formatCompactNumber(totalInputTokens + totalOutputTokens)}</strong><span>tokens</span></div><div><strong>{formatDuration(totalDuration)}</strong><span>model time</span></div><div><strong>{integrationProposal?.status === "pending" ? "Approval" : integrationProposal?.status === "applied" ? "Applied" : review?.state === "stale" ? "Stale" : task.status === "in_progress" ? "Active" : "—"}</strong><span>integration</span></div></section>
        {review && <div className={`task-detail-review ${integrationProposal?.status ?? review.state}`}><strong>{integrationProposal?.status === "pending" ? "Release proposal awaiting Director approval" : integrationProposal?.status === "rejected" ? "Integration rejected" : integrationProposal?.status === "applied" ? "Approved changes applied" : review.state === "stale" ? "Integration branch is stale" : review.state === "applicable" ? "Verified; Release Manager assessment required" : "Evidence-only result"}</strong><span>{review.message}</span></div>}
        {loading && <div className="task-detail-empty">Loading workflow…</div>}
        {error && <div className="task-detail-error">{error}</div>}
        {!loading && !error && runs.length === 0 && <div className="task-detail-empty"><strong>No agent runs yet</strong><span>The workflow timeline will appear after this task starts.</span></div>}
        {runs.length > 0 && <section className="workflow-timeline" aria-label="Agent run timeline"><h3>Workflow activity</h3>{runs.map((item, index) => <WorkflowRunCard item={item} project={project} sequence={index + 1} key={item.run.id}/>)}</section>}
      </div>
    </article>
  </div>;
}

function WorkflowRunCard({ item, project, sequence }: { item: TaskWorkflowRunDetail; project: ProjectSummary; sequence: number }) {
  const { run } = item;
  const active = ["queued", "provisioning", "running"].includes(run.status);
  const usage = item.usage[0];
  const attempt = item.attempts.at(-1);
  const elapsed = usage?.durationMs ?? elapsedMilliseconds(run.startedAt ?? run.createdAt, run.completedAt);
  const purpose = runPurposeLabel(item);
  return <details className={`workflow-run ${run.status}`} open={active || run.status === "failed"}>
    <summary><span className="workflow-step-number">{sequence}</span><span className={`workflow-step-dot ${run.status}`}/><span className="workflow-run-heading"><strong>{purpose}</strong><small>{roleLabels[run.agentRole]} · {run.spec.brainProfile.harness} · {run.spec.brainProfile.model ?? run.spec.brainProfile.provider}</small></span><span className="workflow-run-state">{active ? "Running" : run.status}<small>{formatDuration(elapsed)}</small></span></summary>
    <div className="workflow-run-body">
      {run.result?.summary && <p className="workflow-run-summary">{run.result.summary}</p>}
      <div className="workflow-run-columns">
        <section><h4>Checks</h4>{run.result?.checks.length ? <ul className="workflow-check-list">{run.result.checks.map((check, index) => <li className={check.status} key={`${check.command}-${index}`}><span>{check.status === "passed" ? "✓" : check.status === "failed" ? "×" : "–"}</span><code>{check.command}</code></li>)}</ul> : <p>No check results yet.</p>}</section>
        <section><h4>Acceptance evidence</h4>{run.result?.acceptanceCriteria.length ? <ul className="workflow-evidence-list">{run.result.acceptanceCriteria.map((criterion, index) => <li className={criterion.satisfied ? "passed" : "failed"} key={index}><strong>{criterion.satisfied ? "Satisfied" : "Blocked"}</strong><span>{criterion.criterion}</span><small>{criterion.evidence}</small></li>)}</ul> : <p>No acceptance evidence yet.</p>}</section>
      </div>
      {((run.result?.risks.length ?? 0) > 0 || (run.result?.questions.length ?? 0) > 0) && <section className="workflow-findings"><h4>Findings</h4>{run.result?.risks.map((risk) => <p className="risk" key={risk}>{risk}</p>)}{run.result?.questions.map((question) => <p key={question}>{question}</p>)}</section>}
      {(run.result?.changedFiles.length ?? 0) > 0 && <section className="workflow-files"><h4>Changed files</h4><div>{run.result?.changedFiles.map((file) => <code key={file}>{file}</code>)}</div></section>}
      {(run.result?.commits.length ?? 0) > 0 && <section className="workflow-commits"><h4>Commits</h4>{run.result?.commits.map((commit) => <div key={`${commit.repositoryId}-${commit.sha}`}><span>{project.repositories.find((repository) => repository.id === commit.repositoryId)?.name ?? commit.repositoryId}</span><code>{commit.sha}</code></div>)}</section>}
      <section className="workflow-run-facts"><span><b>Round</b>{run.spec.verificationRound ?? 0}</span><span><b>Started</b>{new Date(run.startedAt ?? run.createdAt).toLocaleString()}</span><span><b>Attempts</b>{item.attempts.length}</span>{attempt?.workerId && <span><b>Container</b>{attempt.workerId}</span>}{attempt?.imageDigest && <span><b>Image</b>{shortIdentifier(attempt.imageDigest)}</span>}{usage && <><span><b>Input</b>{formatCompactNumber(usage.inputTokens)}</span><span><b>Output</b>{formatCompactNumber(usage.outputTokens)}</span></>}</section>
      {item.events.length > 0 && <details className="workflow-events"><summary>Run events ({item.events.length})</summary><ol>{item.events.map((event) => <li key={event.id}><time>{new Date(event.createdAt).toLocaleTimeString()}</time><span className={event.type.endsWith("failed") ? "failed" : ""}>{event.message ?? event.type.replaceAll(".", " ")}</span></li>)}</ol></details>}
    </div>
  </details>;
}

function runPurposeLabel(item: TaskWorkflowRunDetail): string {
  if (item.run.spec.runPurpose === "verification") return `${item.run.spec.verificationCheck?.replaceAll("_", " ") ?? "Verification"} check`;
  if (item.run.spec.runPurpose === "repair") return `Repair pass ${item.run.spec.verificationRound ?? 1}`;
  if (item.run.spec.runPurpose === "implementation") return "Implementation";
  if (item.run.spec.runPurpose) return item.run.spec.runPurpose.replaceAll("_", " ");
  if (["qa_engineer", "code_reviewer", "security_reviewer"].includes(item.run.agentRole)) return "Independent verification";
  return "Implementation";
}

function elapsedMilliseconds(start: string, end: string | null): number {
  return Math.max(0, new Date(end ?? Date.now()).getTime() - new Date(start).getTime());
}

function formatDuration(milliseconds: number): string {
  if (!milliseconds) return "—";
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function formatCompactNumber(value: number): string {
  return value ? new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value) : "—";
}

function shortIdentifier(value: string): string {
  return value.length > 20 ? `${value.slice(0, 12)}…${value.slice(-7)}` : value;
}

function taskForRole(tasks: TaskSummary[], role: AgentRole): TaskSummary | undefined {
  const priority: TaskStatus[] = ["in_progress", "review", "ready", "blocked", "draft"];
  return [...tasks]
    .filter((task) => task.assignedRole === role && priority.includes(task.status))
    .sort((a, b) => priority.indexOf(a.status) - priority.indexOf(b.status))[0];
}

function presenceForTask(task: TaskSummary): "working" | "reviewing" | "queued" {
  if (task.status === "in_progress") return "working";
  if (task.status === "review") return "reviewing";
  return "queued";
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "").slice(0, 64);
}

async function readResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) {
    if (!response.ok) throw new Error(`Request failed with status ${response.status}`);
    return {} as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    const summary = text.trim().slice(0, 240);
    throw new Error(summary || `The server returned an invalid response (${response.status})`);
  }
}
