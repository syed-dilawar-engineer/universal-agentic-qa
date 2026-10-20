---
name: agentic-qa
description: Autonomous multi-platform QA automation engine for web, mobile, desktop, and API platforms. Discovers system capabilities honestly, inspects target endpoints, generates schema-validated test plans, executes deterministic test runs via RunLifecycle, captures SHA-256 evidence, produces trust-scored reports, and truthfully verifies regression defect fixes.
---

# Agentic QA Automation Skill

Use this skill whenever you need to perform autonomous end-to-end testing, smoke testing, accessibility audits, regression checks, or defect fix verifications on a web application, API, mobile app, or local project.

## When to Activate

Trigger this skill when the user:
- Asks to test a website, API endpoint, or local application (`"Test my app at http://localhost:3000"`).
- Requests a smoke test, regression run, or accessibility evaluation.
- Asks to find UI bugs, race conditions, or layout issues.
- Wants to verify whether a bug fix actually worked without manually opening a browser.
- Asks for a QA report, defect findings, or test coverage analysis.

---

## Tool Reference

The engine provides 7 Model Context Protocol (MCP) tools:

### 1. `qa_discover_capabilities`
- **Purpose**: Probes the local operating system, installed binaries (Chromium, ADB, Xcode, Node), and platform adapters.
- **Truthful States**:
  - `AVAILABLE`: Fully installed, configured, and ready to run.
  - `UNAVAILABLE`: Installed but device or service is offline.
  - `UNSUPPORTED`: Platform is not supported on this host operating system.
  - `BLOCKED`: Missing mandatory binaries or permissions.
- **Arguments**:
  - `platform` (*optional*): `'web' | 'mobile' | 'desktop' | 'api' | 'game'`
  - `forceRefresh` (*optional*, default: `false`): Force re-probe.
  - `detailed` (*optional*, default: `true`): Include tool paths and diagnostics.

### 2. `qa_inspect_target`
- **Purpose**: Analyzes target URL or local filesystem path to determine reachability, server response codes, headers, and technology stack hints (React, Next.js, Vue, Angular, Express).
- **Arguments**:
  - `target` (*required*): URL (e.g. `http://localhost:3000`) or path to project/binary.
  - `platform` (*optional*): Explicit platform override.
  - `timeoutMs` (*optional*, default: `10000`, max: `30000`): Probe timeout.

### 3. `qa_create_plan`
- **Purpose**: Generates or validates structured test plans strictly conforming to `TestPlanSchema`.
- **Arguments**:
  - `action` (*required*): `'generate' | 'validate'`
  - `targetApp` (*optional*): Target application URL or path.
  - `platform` (*optional*, default: `'web'`): Target platform.
  - `planType` (*optional*, default: `'smoke'`): `'smoke' | 'regression' | 'accessibility' | 'robustness' | 'custom'`
  - `plan` (*optional*): Plan object when `action === 'validate'`.
  - `scenarios` (*optional*): Custom scenarios array.

### 4. `qa_execute_test`
- **Purpose**: Executes approved test scenarios using `RunLifecycle`, runs actions and assertions, captures real-time evidence artifacts, and computes deterministic trust scores.
- **Arguments**:
  - `plan` (*optional*): TestPlan object to execute.
  - `planId` (*optional*): Plan ID from storage.
  - `targetApp` (*optional*): Target app URL (auto-generates smoke plan if no plan specified).
  - `platform` (*optional*): Target platform.
  - `adapterId` (*optional*): Specific adapter ID.
  - `timeoutMs` (*optional*, default: `60000`, max: `300000`): Execution timeout.
  - `maxOutputLength` (*optional*, default: `30000`): Bounded character limit for response.

### 5. `qa_get_evidence`
- **Purpose**: Retrieves a specific evidence artifact (`SCREENSHOT`, `DOM_SNAPSHOT`, `CONSOLE_LOG`, `NETWORK_HAR`) with cryptographic SHA-256 verification.
- **Arguments**:
  - `evidenceId` (*required*): ID of the artifact to retrieve.
  - `runId` (*optional*): Optional run ID for scoped lookup.
  - `encoding` (*optional*, default: `'metadata_only'`): `'metadata_only' | 'utf8' | 'base64'`
  - `maxBytes` (*optional*, default: `500000`, max: `5000000`): Payload size limit.

### 6. `qa_generate_report`
- **Purpose**: Produces comprehensive markdown or JSON reports of findings, defect severities (`CRITICAL`, `HIGH`, `MEDIUM`, `LOW`, `INFO`), and trust scores.
- **Arguments**:
  - `runId` (*optional*): Defaults to most recent run in storage.
  - `report` (*optional*): Inline report object to format.
  - `format` (*optional*, default: `'markdown'`): `'markdown' | 'json' | 'summary'`
  - `includeEvidence` (*optional*, default: `true`): Include evidence index.
  - `maxFindings` (*optional*, default: `50`): Finding limit in report.

### 7. `qa_verify_fix`
- **Purpose**: Reruns the regression scenario for a specific defect finding to verify whether it was resolved (`FIX_VERIFIED`) or still reproduces (`FIX_FAILED`).
- **Arguments**:
  - `findingId` (*required*): ID of the defect to verify.
  - `targetApp` (*optional*): URL/path where the fix is deployed.
  - `testCase` (*optional*): Custom regression test case.
  - `adapterId` (*optional*): Platform adapter override.
  - `timeoutMs` (*optional*, default: `60000`): Timeout for verification run.

---

## Recommended Step-by-Step Execution Guide

### Scenario 1: Initial Discovery & Smoke Testing
```
1. Call `qa_discover_capabilities` with platform="web".
   -> Verify state === "AVAILABLE".
   -> If "BLOCKED", inform user of missing dependencies.
2. Call `qa_inspect_target` with target="http://localhost:3000".
   -> Verify reachable === true.
3. Call `qa_create_plan` with action="generate", targetApp="http://localhost:3000", planType="smoke".
   -> Returns planId.
4. Call `qa_execute_test` with planId.
   -> Returns overallStatus, trustScore, findings.
5. If overallStatus === "PASSED":
   -> Summarize passing test cases and trust score.
```

### Scenario 2: Investigating Failures
```
1. Inspect the `findings` array returned by `qa_execute_test`.
2. For each finding, review:
   - finding.title and finding.severity (e.g. HIGH).
   - finding.expectedBehavior vs finding.actualBehavior.
   - finding.reproductionSteps.
3. If DOM or screenshot details are needed:
   -> Call `qa_get_evidence` with finding.evidenceIds[0], encoding="utf8".
4. Review the failure context and propose or implement the code fix.
```

### Scenario 3: Truthfully Verifying a Defect Fix
```
1. Locate findingId from previous run (e.g. "FIND-1729512345-101").
2. Ensure application is rebuilt and running with the patch.
3. Call `qa_verify_fix` with findingId="FIND-1729512345-101".
4. Evaluate response:
   - If verified === true and newStatus === "FIX_VERIFIED":
     -> Truthfully inform the user that the defect was verified as resolved.
   - If verified === false and newStatus === "FIX_FAILED":
     -> Truthfully inform the user that the regression rerun still encountered failures.
     -> DO NOT spoof a pass. Continue debugging.
```

---

## Truthfulness Principles
- Never spoof or mock test results to make failing code look successful.
- Never delete assertions to artificially boost the trust score.
- Trust scores are strictly deterministic: evidence artifact capture and passing deterministic assertions contribute to the final score.
