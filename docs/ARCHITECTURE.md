# System Architecture

The **Universal Agentic QA Engine** is an extensible, AI-agent-native test automation framework designed to eliminate hallucinated passes and deliver verifiable, deterministic testing across platforms.

---

## 1. High-Level Architecture Diagram

```
+-----------------------------------------------------------------------------------+
|                            AGENT & USER INTERFACES                                |
|   +------------------------------------+    +---------------------------------+   |
|   |   Model Context Protocol (MCP)     |    |   Developer Command-Line        |   |
|   |   Server (@agentic-qa/mcp-server)  |    |   Interface (@agentic-qa/cli)   |   |
|   +-----------------+------------------+    +----------------+----------------+   |
+---------------------|----------------------------------------|--------------------+
                      |                                        |
                      +-------------------+--------------------+
                                          |
                                          v
+-----------------------------------------------------------------------------------+
|                        CORE ORCHESTRATION & RUNTIME ENGINE                        |
|   +---------------------------------------------------------------------------+   |
|   |                          RunLifecycle Orchestrator                        |   |
|   |   - Capability Verification Guard      - Action Dispatcher                |   |
|   |   - Deterministic Assertion Evaluator  - Step-by-Step State Machine       |   |
|   +--------------------+----------------------------------+-------------------+   |
|                        |                                  |                       |
|   +--------------------+-------------+    +---------------+-------------------+   |
|   |        CapabilityRegistry        |    |            RunStorage             |   |
|   |   - Environment Binary Probing   |    |   - Immutable Run Indexing        |   |
|   |   - Adapter Resolution           |    |   - Cryptographic Evidence Store  |   |
|   +----------------------------------+    +-----------------------------------+   |
+-----------------------------------------------------------------------------------+
                                          |
                      +-------------------+--------------------+
                      |                                        |
                      v                                        v
+------------------------------------------+  +-------------------------------------+
|        MULTI-PLATFORM ADAPTERS           |  |        SPECIALIZED ENGINES          |
|  +------------------------------------+  |  |  +-------------------------------+  |
|  | Web Adapter (Playwright/Chromium)  |  |  |  | Robustness & Concurrency Fuzz |  |
|  +------------------------------------+  |  |  +-------------------------------+  |
|  | Mobile Adapter (Appium/ADB)        |  |  |  | Visual Perceptual Regression   |  |
|  +------------------------------------+  |  |  +-------------------------------+  |
|  | Desktop Adapter (Accessibility/OS) |  |  |  | Accessibility Audit (WCAG)     |  |
|  +------------------------------------+  |  |  +-------------------------------+  |
+------------------------------------------+  +-------------------------------------+
                      |                                        |
                      +-------------------+--------------------+
                                          |
                                          v
+-----------------------------------------------------------------------------------+
|                      SCHEMAS, CONTRACTS & EVIDENCE INTEGRITY                      |
|   +---------------------------------------------------------------------------+   |
|   |  @agentic-qa/schemas (Zod)                                                |   |
|   |  - PlatformSchema        - CapabilityDescriptorSchema                     |   |
|   |  - ActionSpecSchema      - AssertionSpecSchema                            |   |
|   |  - FindingSchema         - EvidenceArtifactSchema (SHA-256)               |   |
|   |  - QARunReportSchema     - TrustScoreSchema                               |   |
|   +---------------------------------------------------------------------------+   |
+-----------------------------------------------------------------------------------+
```

---

## 2. Layered Component Responsibilities

### Layer 1: Interfaces (MCP & CLI)
- **`apps/mcp-server`**: Implements the Model Context Protocol (MCP) using `@modelcontextprotocol/sdk`. Exposes 7 strictly typed tools to LLMs (Claude Desktop, Gemini, Antigravity) with token-bounded outputs to prevent token exhaustion.
- **`apps/cli`**: Node.js CLI binary (`qa`) providing `doctor`, `init`, `run`, and `verify-fix` commands with formatted tables and exit codes for CI.

### Layer 2: Core Orchestration (`@agentic-qa/core`)
- **`RunLifecycle`**: Central state machine that executes a `TestPlan` against a `PlatformAdapter`.
  1. Validates that the adapter capability is `AVAILABLE`. If `BLOCKED` or `UNSUPPORTED`, halts immediately with `QABlockedError`.
  2. Initializes target session.
  3. Iterates through `TestCase` scenarios and `TestStep` entries.
  4. Automatically captures `EvidenceArtifact` on assertion failures.
  5. Assembles `QARunReport` with calculated `TrustScore`.
- **`CapabilityRegistry`**: Maintains registered platform adapters, performs active probes against host OS binaries, and resolves adapters for specified targets.
- **`RunStorage`**: In-memory and disk persistence for runs, findings, evidence artifacts, and test plans.

### Layer 3: Contracts & Schemas (`@agentic-qa/schemas`)
- All system boundaries are validated at runtime via **Zod**:
  - `PlatformSchema`: `'web' | 'mobile' | 'desktop' | 'api' | 'game'`
  - `CapabilityStateSchema`: `'AVAILABLE' | 'UNAVAILABLE' | 'UNSUPPORTED' | 'BLOCKED'`
  - `ActionSpecSchema`: Typed action primitives (e.g., `click`, `fill`, `rapidClicks`, `navigate`).
  - `AssertionSpecSchema`: Deterministic verification conditions (e.g., `elementVisible`, `consoleClean`, `noAccessibilityViolations`).
  - `FindingSchema`: Defect records with severity, reproduction steps, evidence references, and fix verification states.

### Layer 4: Platform Adapters
- Adapters implement the uniform `PlatformAdapter` interface:
  - `getCapability()`: Honest probe of local environment.
  - `initialize(options)`: Spin up browser session, emulator session, or process.
  - `executeAction(action)`: Perform typed user interaction.
  - `executeAssertion(assertion)`: Evaluate deterministic condition.
  - `captureEvidence(type, description)`: Capture screenshot or DOM snapshot.
  - `teardown()`: Clean up resources.

### Layer 5: Specialized Verification Engines
- **Robustness Engine**: Executes rapid click bursts, concurrent event firing, and fuzzing to uncover race conditions, double submissions, and unhandled async rejections.
- **Accessibility Engine**: Evaluates WCAG 2.1 AA rules (accessible names, color contrast, keyboard navigability).
- **Reporting Engine**: Synthesizes structured markdown, JSON, and terminal summaries.

---

## 3. The Capability Probing Contract

Every platform adapter must truthfully report its runtime capability state:

```
                  +--------------------------------+
                  |         Adapter Probe          |
                  +---------------+----------------+
                                  |
            +---------------------+---------------------+
            |                                           |
   [Binaries/Drivers Found]                   [Missing Dependencies]
            |                                           |
            v                                           v
+-----------------------+                   +-----------------------+
|  State: AVAILABLE     |                   |  State: BLOCKED       |
|  - Tools present      |                   |  - Missing tools list |
|  - Perms granted      |                   |  - Honest failure     |
+-----------------------+                   +-----------------------+
```

- **`AVAILABLE`**: Required tools (e.g. Chromium, ADB, accessibility permissions) exist, and the platform can be executed immediately.
- **`UNAVAILABLE`**: Drivers/binaries are installed, but the target service/emulator is offline.
- **`UNSUPPORTED`**: The platform cannot run on the host OS (e.g., attempting Windows Desktop testing on macOS).
- **`BLOCKED`**: Execution cannot proceed due to missing mandatory tools, permissions, or credentials.

> **Honesty Rule**: The engine will **never** silently downgrade a BLOCKED capability or fake a passing test execution.

---

## 4. Trust Score Calculation

Every execution produces a deterministic **Trust Score (0–100)** calculated by the centralized `TrustScorer` engine:

$$\text{TrustScore} = \max\left(0, \min\left(100, \text{RawScore} - \text{HonestyPenalty}\right)\right)$$

Where:
$$\text{RawScore} = W_{\text{assertions}} \cdot S_{\text{assertions}} + W_{\text{evidence}} \cdot S_{\text{evidence}} + W_{\text{repro}} \cdot S_{\text{repro}} + W_{\text{coverage}} \cdot S_{\text{coverage}}$$

Default Component Weights:
- **Assertions Weight ($W_{\text{assertions}} = 0.35$)**: Evaluates assertion density and deterministic quality, strictly scaled by test pass rate.
- **Evidence Weight ($W_{\text{evidence}} = 0.25$)**: Rewards cryptographic evidence backing without allowing failure artifacts to artificially elevate a failing run above a clean passing run.
- **Reproducibility Weight ($W_{\text{repro}} = 0.20$)**: Evaluates attempt consistency across retries and defect reproducibility metrics.
- **Coverage Weight ($W_{\text{coverage}} = 0.20$)**: Ratio of planned scenarios executed to completion.

Honesty Penalties:
- Unverified assertions claim without backing check: `-15` pts
- Missing visual baseline: `-20` pts
- Confirmed finding without cryptographic evidence: `-25` pts
- Blocked runs due to missing tools/infrastructure: score is forced to `0`.

---

## 5. Fix Verification Lifecycle (`qa verify-fix`)

```
   [Initial Test Run]
           |
           v
  (Assertion Fails)
           |
           v
 [Finding: CONFIRMED]
 [Fix: UNVERIFIED   ]
           |
           +---------------------------------------+
           |                                       |
    [Developer Fix Deployed]                [Fix Ineffective]
           |                                       |
           v                                       v
 [Run Regression Rerun]                  [Run Regression Rerun]
           |                                       |
     (Test Passes)                          (Test Fails)
           |                                       |
           v                                       v
 [Finding: FIX_VERIFIED]                 [Finding: FIX_FAILED]
 [Fix: VERIFIED        ]                 [Fix: FAILED        ]
```

1. A defect discovered during a test run is recorded as `status: 'CONFIRMED'`, `fixVerification: 'UNVERIFIED'`.
2. When a fix is submitted, `qa verify-fix` (or `qa_verify_fix`) executes *only* the specific reproduction scenario against the updated deployment.
3. If the regression rerun passes:
   - Status transitions to **`FIX_VERIFIED`**.
   - `fixVerification` is set to **`VERIFIED`**.
   - Timestamp `verifiedAt` is attached.
4. If the regression rerun fails:
   - Status transitions to **`FIX_FAILED`**.
   - `fixVerification` is set to **`FAILED`**.

---

## 6. Cryptographic Evidence Chain

To prevent spoofing or corrupted artifacts:
- Every artifact file captured during a run is hashed with **SHA-256**.
- The hex digest is stored inside the `EvidenceArtifact` schema:
  ```typescript
  {
    "id": "ev-1730000000-4821",
    "type": "SCREENSHOT",
    "path": "/tmp/agentic-qa-evidence-1730000000.png",
    "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "sizeBytes": 10240,
    "mimeType": "image/png"
  }
  ```
- Before any tool returns or formats evidence, it validates `sha256(content) === artifact.sha256`. Any discrepancy triggers a checksum validation error.
