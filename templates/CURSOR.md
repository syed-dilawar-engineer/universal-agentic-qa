# Cursor Agent Guidelines: Universal Agentic QA

These rules configure Cursor Composer, Agent, and Chat when interacting with the **Universal Agentic QA Engine**.

---

## 1. MCP Configuration for Cursor

Add the QA server to your Cursor workspace MCP configuration (`.cursor/mcp.json` or Global Cursor Settings):

```json
{
  "mcpServers": {
    "agentic-qa": {
      "command": "node",
      "args": ["${workspaceFolder}/apps/mcp-server/dist/index.js"]
    }
  }
}
```

---

## 2. Cursor Workflow Commands & Recipes

### Command: Run Pre-flight Discovery
Before running automated tests on a new repository:
```
Call qa_discover_capabilities to check which browser and mobile drivers are available.
```

### Command: Smoke Test Current Workspace
```
1. Call qa_inspect_target on http://localhost:3000 (or current dev server).
2. Call qa_create_plan with action="generate", planType="smoke".
3. Call qa_execute_test to execute the plan.
4. Report overallStatus and any detected findings.
```

### Command: Fix and Verify
When editing code to fix a bug detected by the engine:
```
1. Locate the finding ID from previous run (e.g. FIND-123).
2. Edit the relevant file in the codebase.
3. Call qa_verify_fix with findingId="FIND-123".
4. Check if newStatus is FIX_VERIFIED. If FIX_FAILED, do not declare victory—continue debugging.
```

---

## 3. Strict Coding & Verification Rules for Cursor

1. **Never Spoof Results**: Never edit test files or assertion parameters to artificially make a test pass. Fix the underlying application code instead.
2. **Deterministic Assertions**: Use typed assertions:
   - `status200`
   - `elementVisible` / `elementHidden`
   - `elementTextEquals` / `elementTextContains`
   - `noAccessibilityViolations`
   - `consoleClean`
3. **Evidence Integrity**: Trust score is reduced if findings lack evidence or if assertions cannot be cryptographically verified.
