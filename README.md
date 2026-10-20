# Universal Agentic QA Engine

[![CI](https://github.com/agentic-qa/universal-agentic-qa-engine/actions/workflows/ci.yml/badge.svg)](https://github.com/agentic-qa/universal-agentic-qa-engine/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Node: >=20](https://img.shields.io/badge/Node-%3E%3D20.0.0-brightgreen.svg)](package.json)
[![TypeScript: Strict](https://img.shields.io/badge/TypeScript-Strict-blue.svg)](tsconfig.json)

A production-oriented, open-source, AI-agent-driven QA automation platform designed for autonomous software verification across **Web**, **Mobile**, **Desktop**, **API**, and **Game** environments.

---

## Core Philosophy: Honest & Deterministic Verification

Most AI test generators suffer from **hallucinated test passes**—claiming an application works when in reality tests were skipped, assertions were vacuous, or execution environments were unavailable.

The Universal Agentic QA Engine is built on the **Honest Truth Reporting Contract**:

1. **Zero Hallucinated Passes**: If a mandatory binary, device, or permission is missing, status is truthfully reported as **`BLOCKED`**—never spoofed as passing.
2. **Deterministic Assertions**: Autonomous LLM exploration is grounded by rigorous, typed assertions (`elementVisible`, `consoleClean`, `noAccessibilityViolations`, `elementTextEquals`).
3. **Cryptographic Evidence Integrity**: Every screenshot, DOM snapshot, and network trace is hashed with **SHA-256** at capture time, preventing tampering and proving reproduction.
4. **Trust Scoring**: Every test run receives a deterministic **Trust Score (0–100)** incorporating assertion density, evidence capture, and honesty penalties.
5. **Fix Verification Lifecycle**: Defect findings transition to **`FIX_VERIFIED`** *only* when an automated regression run against the patched target truthfully passes.

---

## Monorepo Architecture

```
universal-agentic-qa-engine/
├── packages/
│   ├── schemas/              # Zod schemas, types, and contracts (@agentic-qa/schemas)
│   ├── core/                 # Lifecycle orchestration & capability registry (@agentic-qa/core)
│   ├── adapters/
│   │   ├── web/              # Playwright & browser automation (@agentic-qa/adapter-web)
│   │   ├── mobile/           # Appium & ADB mobile automation (@agentic-qa/adapter-mobile)
│   │   └── desktop/          # OS-level desktop automation (@agentic-qa/adapter-desktop)
│   ├── engines/
│   │   └── robustness/       # Rapid clicks, race condition fuzzing (@agentic-qa/engine-robustness)
│   └── reporting/            # Trust score calculation & report generation (@agentic-qa/reporting)
├── apps/
│   ├── cli/                  # Developer CLI interface `qa` (@agentic-qa/cli)
│   └── mcp-server/           # Model Context Protocol server (@agentic-qa/mcp-server)
├── fixtures/
│   └── demo-app/             # Controlled fixture web app with 4 deliberate defects
├── tests/
│   └── acceptance/           # End-to-end integration & fix-verification acceptance tests
├── docs/
│   ├── ARCHITECTURE.md       # Comprehensive architectural deep-dive
│   └── SECURITY.md           # Sandboxing & isolation guidelines
├── .github/workflows/ci.yml  # Multi-platform CI workflow (Node 20/22 on Ubuntu & macOS)
├── SECURITY.md               # Vulnerability reporting policy
└── LICENSE                   # Apache-2.0
```

---

## Quickstart

### Prerequisites
- **Node.js**: `>= 20.0.0`
- **pnpm**: `>= 10.0.0`

### 1. Installation
Clone the repository and install workspace dependencies:
```bash
git clone https://github.com/agentic-qa/universal-agentic-qa-engine.git
cd universal-agentic-qa-engine
pnpm install
```

### 2. Build All Packages
```bash
pnpm run build
```

### 3. Run Test Suites
Run unit and integration tests across the monorepo:
```bash
pnpm test
```

Run end-to-end acceptance tests:
```bash
pnpm vitest run tests/acceptance/e2e.test.ts
```

---

## Fixture Demo Application & Verification Harness

The repository includes a controlled web application in `fixtures/demo-app/` with **4 deliberate defects**:

| Defect ID | Category | Description | Fixed State (`FIX_DEFECTS=true`) |
|-----------|----------|-------------|----------------------------------|
| **Bug 1** | Race Condition | Button allows rapid double/triple submission if clicked fast. | Synchronous disable on click #1 rejects duplicate submissions. |
| **Bug 2** | Responsive Layout | Horizontal scroll overflow on viewports `< 380px`. | Responsive fluid container fits viewports down to 320px. |
| **Bug 3** | Runtime Crash | Unhandled `TypeError` logged to console on broken action click. | Safe exception-guarded handler executes cleanly. |
| **Bug 4** | Accessibility | Icon button without accessible name violating WCAG 2.1 AA 4.1.2. | Explicit `aria-label="Search catalog"` and `title`. |

### Starting the Fixture App

#### Defective Mode (Default)
```bash
cd fixtures/demo-app
node server.js
# Access at http://127.0.0.1:3456
```

#### Fixed Mode
```bash
cd fixtures/demo-app
FIX_DEFECTS=true node server.js
# Or append ?fix=true in browser: http://127.0.0.1:3456/?fix=true
```

---

## Model Context Protocol (MCP) Server

Universal Agentic QA Engine exposes a full MCP server conforming to the MCP Specification, allowing AI coding agents (Claude Desktop, Gemini, Antigravity, Cursor) to autonomously inspect, plan, execute, and verify fixes.

### Available Tools

1. **`qa_discover_capabilities`**: Honestly probes host OS binaries, drivers, and permissions.
2. **`qa_inspect_target`**: Probes a target URL or filesystem path, detecting frameworks and platform types.
3. **`qa_create_plan`**: Generates or validates strictly-typed test plans conforming to `TestPlanSchema`.
4. **`qa_execute_test`**: Runs test scenarios, captures SHA-256 evidence, and computes trust scores.
5. **`qa_get_evidence`**: Retrieves evidence artifacts (screenshots, logs) with cryptographic verification.
6. **`qa_generate_report`**: Generates Markdown, JSON, or summary reports.
7. **`qa_verify_fix`**: Re-runs failing test scenarios against a patched application and transitions finding status.

### Configuring Claude Desktop / Antigravity Agent
Add to your `claude_desktop_config.json` or agent MCP configuration:
```json
{
  "mcpServers": {
    "agentic-qa": {
      "command": "node",
      "args": [
        "/path/to/universal-agentic-qa-engine/apps/mcp-server/dist/index.js"
      ]
    }
  }
}
```

---

## Developer CLI (`qa`)

The CLI provides command-line workflows for QA engineers and CI pipelines:

```bash
# Audit host platform capabilities and missing tools
pnpm qa doctor

# Initialize a qa.config.json for your project
pnpm qa init

# Execute tests against a configured target
pnpm qa run --target https://example.com

# Verify a defect fix
pnpm qa verify-fix --finding-id FIND-12345 --target https://staging.example.com
```

---

## Security & Sandboxing

Because autonomous testing executes actions across real environments, strict isolation boundaries are enforced:
- Web sessions execute in ephemeral, incognito contexts without `--no-sandbox`.
- Outbound requests to cloud metadata endpoints (`169.254.169.254`) are blocked.
- Sensitive credentials and authorization tokens are automatically masked from all logs and evidence.
- Every artifact is cryptographically hashed with SHA-256 to ensure tamper-proof reports.

For complete guidelines, see [SECURITY.md](SECURITY.md) and [Sandboxing Guidelines](docs/SECURITY.md).

---

## License

Universal Agentic QA Engine is open-source software licensed under the [Apache License 2.0](LICENSE).
