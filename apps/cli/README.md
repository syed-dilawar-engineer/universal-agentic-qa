# Universal Agentic QA

[![GitHub Repository](https://img.shields.io/badge/GitHub-Repository-blue?logo=github)](https://github.com/syed-dilawar-engineer/universal-agentic-qa)
[![npm version](https://img.shields.io/npm/v/universal-agentic-qa.svg)](https://www.npmjs.com/package/universal-agentic-qa)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/syed-dilawar-engineer/universal-agentic-qa/blob/main/LICENSE)
[![Policy: Zero Hallucinated Passes](https://img.shields.io/badge/Policy-Zero%20Hallucinated%20Passes-red.svg)](https://github.com/syed-dilawar-engineer/universal-agentic-qa#why-agentic-qa)

A deterministic, open-source QA verification engine built specifically for **AI Coding Agents** (Claude, Cursor, Antigravity, Windsurf, Gemini). It equips AI agents with the cognitive testing heuristics, boundary fuzzing, and adversarial thinking of **top 1% QA engineers** across **Web**, **Mobile**, **Desktop**, **API**, and **Games**.

> 🔗 **Source code & active development**: [https://github.com/syed-dilawar-engineer/universal-agentic-qa](https://github.com/syed-dilawar-engineer/universal-agentic-qa)

---

## Quickstart for AI Coding Agents & Developers

You do not need to execute complicated manual CLI commands. Choose the integration that best matches your workflow:

### 🥇 Priority 1: Model Context Protocol (MCP) Server (Recommended)
Add this to your MCP configuration (`claude_desktop_config.json`, Cursor MCP settings, or Antigravity config):

```json
{
  "mcpServers": {
    "universal-agentic-qa": {
      "command": "npx",
      "args": ["-y", "universal-agentic-qa"]
    }
  }
}
```

Now, prompt your agent naturally:
> *"Test my project. Explore all flows, check for edge-case boundary errors and race conditions, and provide a full defect report with cryptographic evidence."*

---

### 🥈 Priority 2: Direct GitHub URL in Chat (Zero Setup)
Simply paste the repository link directly into your AI chat prompt:

> *"Use the testing engine and cognitive heuristics from https://github.com/syed-dilawar-engineer/universal-agentic-qa to audit and rigorously test my application."*

---

### 🥉 Priority 3: Automated One-Line Setup Wizard

```bash
npx universal-agentic-qa setup
```

---

## What Universal Agentic QA Verifies

* **Extreme Boundary Fuzzing**: Injects 5,000+ character strings, Unicode zalgo, RTL overrides, OS command injection (`| id`), and prototype pollution (`__proto__`) into form fields to catch unhandled server crashes and database truncation exceptions.
* **Race Conditions & Debouncing**: Dispatches sub-10ms burst interactions to catch duplicate payment submissions, broken debouncing, and UI thread locking.
* **Web & Framework Fragility**: Detects React 18/19 hydration mismatches (`Minified React error #418, #423`), element occlusion (buttons covered by floating headers), and layout overflow on small screens.
* **Accessibility (WCAG 2.2 AAA)**: Audits touch targets against the strict 44x44 CSS px requirement, color contrast ratios, and missing accessible labels.
* **Mobile & Desktop Lifecycles**: Tests Android Low Memory Killer (LMK) process death, iOS state restoration, native OS screenshot capture, and window resizing behavior.
* **Fix Verification Lifecycle**: Prevents AI agents from hallucinating fixes. A defect transitions to `FIX_VERIFIED` *only* when an automated regression re-run against the patched code truthfully passes.

---

## Links & Community

* **GitHub Repository:** [https://github.com/syed-dilawar-engineer/universal-agentic-qa](https://github.com/syed-dilawar-engineer/universal-agentic-qa)
* **Issue Tracker:** [https://github.com/syed-dilawar-engineer/universal-agentic-qa/issues](https://github.com/syed-dilawar-engineer/universal-agentic-qa/issues)
* **License:** [MIT License](https://github.com/syed-dilawar-engineer/universal-agentic-qa/blob/main/LICENSE)
