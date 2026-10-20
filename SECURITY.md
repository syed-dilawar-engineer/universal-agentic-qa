# Security Policy

Universal Agentic QA Engine is an AI-agent-driven testing and verification platform designed for mission-critical enterprise and open-source applications. Security, environment isolation, and cryptographic integrity are core design pillars.

---

## Supported Versions

We actively maintain and provide security updates for the following versions:

| Version | Supported          | Security Maintenance Status |
| ------- | ------------------ | --------------------------- |
| `0.1.x` | :white_check_mark: | Current Active Release      |
| `< 0.1` | :x:                | Unsupported                 |

---

## Reporting a Vulnerability

We appreciate the security community's efforts in identifying vulnerabilities responsibly. If you discover a security vulnerability in Universal Agentic QA Engine, please **do not report it through public GitHub issues**.

### Disclosure Channels
- **GitHub Security Advisory**: Open a private draft security advisory directly through GitHub: `Security` > `Advisories` > `New draft advisory`.
- **Email**: Contact the security response team at `security@universal-agentic-qa.dev` (or team leads via encrypted email).

### Information to Include
To help us triage and patch the issue promptly, please include:
1. Vulnerability description and classification (e.g., Command Injection, Sandbox Escape, Secret Exposure).
2. Affected package or component (`@agentic-qa/core`, `@agentic-qa/mcp-server`, CLI, or specific Platform Adapters).
3. Step-by-step reproduction instructions or a minimal proof of concept (PoC).
4. Potential real-world impact on host environments or execution agents.

### Response SLAs
- **Initial Acknowledgment**: Within **24 hours**.
- **Triage Assessment & Severity Assignment**: Within **48 hours**.
- **Patch Release & Security Advisory**: Target within **7 business days** for Critical/High vulnerabilities.

---

## Security Boundaries & Scope

### In-Scope
- **Sandbox Escapes**: Arbitrary file access or host command execution via platform adapters (Web, Desktop, Mobile) beyond defined testing boundaries.
- **Credential & Secret Exposure**: Inadvertent logging, serialization, or report inclusion of API keys, authentication tokens, or private credentials.
- **Command & Parameter Injection**: Unsanitized input leading to unintended process execution in CLI tools or MCP server handlers.
- **Evidence Tampering**: Bypassing cryptographic SHA-256 verification of screenshots, traces, or DOM snapshots.
- **Prompt & Protocol Injection**: Adversarial manipulation of MCP tools leading to unauthorized execution states.

### Out-of-Scope
- **Deliberate Defects in Test Fixtures**: Vulnerabilities and bugs intentionally present in `fixtures/demo-app/` for QA verification testing.
- **Attacks Requiring Local Admin / Root**: Attacks where an adversary already has root or administrator privileges on the host system.
- **Social Engineering**: Phishing or social engineering targeting maintainers or users.
- **Denial of Service on Local Ephemeral Servers**: Intentional memory exhaust or CPU exhaustion on self-hosted mock targets without isolation boundaries configured.

---

## Sandboxing & Execution Safety

Because the QA engine executes autonomous actions on real browsers, emulators, and desktop environments, all users and operators must follow our [Sandboxing and Security Guidelines](docs/SECURITY.md).
