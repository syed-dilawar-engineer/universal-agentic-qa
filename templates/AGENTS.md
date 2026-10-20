# Universal Agent Instructions for Agentic QA Engine

This document provides definitive guidance for AI agents interacting with the **Universal Agentic QA Engine** via the Model Context Protocol (MCP) server or CLI.

---

## 1. Core Philosophy & Prime Directives

1. **Truthfulness Over Optimism**: Never fabricate a `PASSED` result. If an assertion fails, an environment binary is missing, or a target is unreachable, report it honestly as `FAILED`, `BLOCKED`, or `UNAVAILABLE`.
2. **Deterministic Proof**: Every finding must be backed by concrete evidence artifacts (`SCREENSHOT`, `DOM_SNAPSHOT`, `CONSOLE_LOG`, `NETWORK_HAR`) with verified SHA-256 cryptographic hashes.
3. **Respect Capability States**:
   - `AVAILABLE`: Safe to execute test actions and assertions.
   - `UNAVAILABLE`: Runtime, driver, or device is currently offline or stopped.
   - `UNSUPPORTED`: Platform is fundamentally not supported on the host OS.
   - `BLOCKED`: Missing mandatory system binaries, tools, or permissions. You MUST NOT spoof test execution when a capability is `BLOCKED`.
4. **Bounded Output Awareness**: To protect client context windows, test execution and evidence retrieval tools enforce bounded payloads. Use metadata queries first, then retrieve specific slices or artifacts as needed.

---

## 2. MCP Tool Suite Reference

The engine exposes 7 standard MCP tools:

| Tool | Purpose | Key Inputs |
| :--- | :--- | :--- |
| `qa_discover_capabilities` | Probes host system & platform adapters for honest readiness | `platform`, `forceRefresh`, `detailed` |
| `qa_inspect_target` | Analyzes target URL or local filesystem path | `target`, `platform`, `timeoutMs` |
| `qa_create_plan` | Generates or validates structured test plans against schemas | `action`, `targetApp`, `platform`, `planType`, `plan` |
| `qa_execute_test` | Runs test plans via `RunLifecycle` and returns bounded reports | `plan`, `planId`, `targetApp`, `timeoutMs`, `maxOutputLength` |
| `qa_get_evidence` | Retrieves artifact with SHA-256 verification | `evidenceId`, `encoding`, `maxBytes` |
| `qa_generate_report` | Generates formatted markdown, JSON, or summary reports | `runId`, `report`, `format`, `includeEvidence` |
| `qa_verify_fix` | Reruns regression scenario to verify defect resolution | `findingId`, `targetApp`, `testCase`, `timeoutMs` |

---

## 3. Standard Agent Workflow

### Phase 1: Preflight & Capability Discovery
Always probe capabilities before generating or attempting to run test plans:
```json
{
  "name": "qa_discover_capabilities",
  "arguments": {
    "platform": "web",
    "detailed": true
  }
}
```
- If state is `BLOCKED`, check `missingTools` and follow `recommendations` (e.g., install chromium or configure adb).
- Do not attempt test execution on blocked platforms.

### Phase 2: Target Inspection
Analyze the target URL or application folder to detect technology stack and reachability:
```json
{
  "name": "qa_inspect_target",
  "arguments": {
    "target": "http://localhost:3000",
    "timeoutMs": 10000
  }
}
```
- Verify `reachable: true`. If unreachable, alert user or start local development server.
- Note `frameworkHints` and `recommendations` to choose appropriate test types.

### Phase 3: Test Plan Generation & Validation
Generate a strictly-typed test plan using standard templates (`smoke`, `accessibility`, `robustness`, `regression`):
```json
{
  "name": "qa_create_plan",
  "arguments": {
    "action": "generate",
    "targetApp": "http://localhost:3000",
    "platform": "web",
    "planType": "smoke"
  }
}
```
You can also validate custom test plans before execution by calling `qa_create_plan` with `action: "validate"`.

### Phase 4: Test Execution & Monitoring
Execute the approved test plan:
```json
{
  "name": "qa_execute_test",
  "arguments": {
    "planId": "<plan-id-from-create-plan>"
  }
}
```
Inspect the returned `overallStatus` (`PASSED`, `FAILED`, `BLOCKED`), `trustScore`, and `findings`.

### Phase 5: Evidence Inspection
When a finding is produced, retrieve the associated evidence artifact for root-cause diagnosis:
```json
{
  "name": "qa_get_evidence",
  "arguments": {
    "evidenceId": "<evidence-id>",
    "encoding": "utf8"
  }
}
```
Checksum verification (`verifiedChecksum: true`) proves the artifact was not tampered with.

### Phase 6: Report Generation
Generate an executive or technical report for stakeholders:
```json
{
  "name": "qa_generate_report",
  "arguments": {
    "format": "markdown",
    "includeEvidence": true
  }
}
```

### Phase 7: Defect Remediation & Fix Verification
After implementing code modifications to resolve a bug:
1. Rebuild or redeploy the target application.
2. Call `qa_verify_fix` with the specific `findingId`:
```json
{
  "name": "qa_verify_fix",
  "arguments": {
    "findingId": "FIND-1729512345-101",
    "targetApp": "http://localhost:3000"
  }
}
```
3. Verify that `newStatus` transitions to `FIX_VERIFIED`. If it returns `FIX_FAILED`, the bug persists and further debugging is required.

---

## 4. Trust Score Guidelines

The engine calculates a deterministic **Trust Score** (0–100) based on:
- **Pass Rate**: Ratio of passed assertions to total assertions.
- **Evidence Count**: Bonus for capturing reproducible proof (screenshots, DOM logs).
- **Honesty Penalty**: Deductions if assertions are bypassed or falsely marked passed.

Never attempt to inflate trust scores by deleting assertions or marking failing assertions as `critical: false` without engineering justification.
