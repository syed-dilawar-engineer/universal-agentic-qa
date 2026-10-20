# Claude Agent Instructions for Universal Agentic QA Engine

This file guides Anthropic Claude (Claude Code, Claude Desktop, and Claude 3.5/3.7 Sonnet agents) when operating as an autonomous QA engineer using the `@agentic-qa/mcp-server`.

---

## 1. MCP Server Configuration

Add the following configuration to your `claude_desktop_config.json` or project-level Claude MCP settings:

```json
{
  "mcpServers": {
    "agentic-qa": {
      "command": "node",
      "args": ["/absolute/path/to/universal-agentic-qa-engine/apps/mcp-server/dist/index.js"]
    }
  }
}
```

Or run via npx/pnpm if built locally:
```json
{
  "mcpServers": {
    "agentic-qa": {
      "command": "pnpm",
      "args": ["--filter", "@agentic-qa/mcp-server", "start"]
    }
  }
}
```

---

## 2. Recommended Claude Workflow Pattern

When a user asks: *"Test my web app"*, *"Find accessibility bugs"*, or *"Verify if my fix solved the issue"*, follow this structured thought process:

### Step 1: Probe Readiness
Always call `qa_discover_capabilities` first:
```json
{
  "name": "qa_discover_capabilities",
  "arguments": { "platform": "web" }
}
```
If Chromium or Playwright is missing, explain to the user:
> "Web testing is currently BLOCKED because Chromium is not installed on PATH. Run `npx playwright install chromium` to enable automated web test execution."

### Step 2: Inspect Target Endpoint
Check if the local server or deployed URL is up:
```json
{
  "name": "qa_inspect_target",
  "arguments": { "target": "http://localhost:3000" }
}
```
If `reachable: false`, advise the user to start the development server first.

### Step 3: Generate Structured Plan
Use standard plan types (`smoke`, `accessibility`, `robustness`, `regression`):
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

### Step 4: Execute Test Suite
Run the generated plan:
```json
{
  "name": "qa_execute_test",
  "arguments": {
    "planId": "<planId>"
  }
}
```

### Step 5: Handle Findings & Evidence
If `overallStatus: "FAILED"`, analyze the `findings` list. For each finding:
- Read `expectedBehavior` vs `actualBehavior`.
- Read the reproduction steps.
- If necessary, fetch evidence details via `qa_get_evidence` using `encoding: "metadata_only"` first to conserve tokens. Only request `"utf8"` or `"base64"` if you need to inspect raw DOM or logs.

### Step 6: Fix and Truthfully Verify
1. Edit the application code to fix the root cause.
2. Call `qa_verify_fix` with the specific `findingId`.
3. Report the result:
   - If `status: "FIX_VERIFIED"`: Defect confirmed fixed with proof.
   - If `status: "FIX_FAILED"`: Do NOT claim the bug is fixed. Re-examine the code and failure logs.

---

## 3. Claude Token Conservation Rules

1. **Avoid Inlining Massive Payloads**: Do not request full `base64` screenshots unless explicitly required. Rely on `DOM_SNAPSHOT` text or metadata first.
2. **Observe Truncation Notices**: The MCP server automatically truncates tool output strings longer than 30,000 characters with an indicator banner. When you see this banner, use targeted queries or `qa_get_evidence` for specific pieces.
3. **Deterministic Assertions**: When authoring custom test cases, prefer deterministic assertions (`elementVisible`, `status200`, `elementTextEquals`, `noAccessibilityViolations`) over ambiguous freeform evaluation.
