# Review findings

Open findings from the October 23, 2026 review of the current working tree, including uncommitted changes. Check off an item after its fix is verified, or remove the entire entry. Keep the remaining IDs unchanged so references in discussions and commits stay useful. Delete this file when all findings are resolved.

**Priority:** P1 means an urgent security or core workflow defect. P2 means a reliability, evidence-validation, or execution-limit defect.

**Original review baseline:** All 37 then-existing tests, typechecking, and the production build passed. Targeted probes reproduced R03–R11 below using temporary fixtures and simulated executors where needed. R02 and R12 were identified by code inspection. Full Docker/provider execution was not tested end to end.

- [ ] **R12 · P2 · Token and cost budgets are stored but not enforced**

  Worker request schemas accept token and cost budgets, but execution never enforces them. The Settings UI presents these values as execution limits.

  **References:** [controller-main.ts](apps/server/src/controller-main.ts), request limit schemas and `runDocker`; [App.tsx](apps/web/src/App.tsx), execution defaults in `SettingsView`.

  **Fix and verify:** Enforce supported limits across execution and fallback, or clearly disable/label unsupported limits. Use a deterministic provider fixture to verify budget handling and termination, including retries, and ensure the UI accurately describes the guarantee.

The main prevention work is to share runtime schemas and test the actual API-to-controller boundary. Separate controller startup from its handlers so tests can exercise serialization, validation, Git persistence, cancellation, and recovery with a simulated provider. Existing fake-executor tests should remain useful for workflow logic, alongside these boundary tests.
