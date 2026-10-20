# Sandboxing & Execution Security Guidelines

Universal Agentic QA Engine grants AI agents and automated pipelines the capability to interact with applications across Web, Desktop, Mobile, API, and Game platforms. Because testing involves interacting with untrusted applications, external URLs, and dynamic code, **defense-in-depth isolation and strict execution sandboxing are mandatory**.

---

## 1. Threat Model for Autonomous QA Execution

When executing agentic QA automation, three primary threat vectors must be addressed:

```
+-------------------------------------------------------------------------------+
|                             THREAT VECTORS                                   |
+-------------------------------------------------------------------------------+
|  1. Untrusted Targets   |  2. Agent/LLM Deviations   |  3. Host & Data Egress |
|  - Malicious scripts    |  - Hallucinated commands   |  - Secret exfiltration |
|  - Drive-by downloads   |  - Infinite action loops   |  - Metadata SSRF       |
|  - OS command injection |  - Resource exhaustion     |  - Host FS tampering   |
+-------------------------------------------------------------------------------+
```

1. **Untrusted Target Applications**: An evaluated website or binary may contain malicious JavaScript, binary exploits, or attempt host breakouts.
2. **Autonomous Agent Deviations**: An LLM agent may generate excessive requests, invalid inputs, or attempt unintended high-privilege interactions.
3. **Data Exfiltration & Secret Leaks**: Test logs, screenshots, and network HAR recordings might inadvertently capture production tokens, passwords, or internal network topology.

---

## 2. Platform Isolation Architecture

### 2.1 Web Adapter Sandboxing (Playwright / Chromium)
- **Ephemeral Browser Contexts**: Every test run **MUST** execute in an isolated, incognito browser context. Browser storage (`localStorage`, `sessionStorage`, cookies, IndexedDB) is destroyed immediately upon teardown.
- **Strict Chromium Flags**:
  - Never run with `--no-sandbox` unless inside a hardened Docker container with user namespace remapping (`userns-remap`).
  - Never disable web security (`--disable-web-security` is prohibited).
  - Explicitly disable file protocol access (`--allow-file-access-from-files=false`).
- **Download Prevention**: Automated downloads are directed to an ephemeral sandbox directory or blocked completely:
  ```json
  {
    "acceptDownloads": false
  }
  ```

### 2.2 Mobile Adapter Sandboxing (Android / iOS)
- **Dedicated Emulators & Simulators**: Never run autonomous mobile QA against personal or shared physical devices containing sensitive user data.
- **Ephemeral User Data**: Android Virtual Devices (AVD) should be launched with `-wipe-data` or restored to a clean golden snapshot after each test suite.
- **ADB Permission Boundaries**:
  - Restrict `adb` server access to loopback (`127.0.0.1:5037`).
  - Deny `root` permissions inside the guest OS during untrusted APK testing (`adb root` prohibited on external applications).
  - Use `run-as <package_name>` for sandboxed data inspection rather than global root shell access.

### 2.3 Desktop Adapter Sandboxing (macOS / Linux / Windows)
- **Unprivileged User Execution**: The QA engine process must run under a non-root, restricted user account.
- **OS-Level Containment**:
  - **Linux**: Execute desktop sessions inside an isolated display server (e.g., `Xvfb`) bounded by `seccomp` and `AppArmor` profiles.
  - **macOS**: Isolate accessibility scripting via standard macOS Privacy & Security entitlements; use dedicated test user accounts or lightweight virtual machines (Lima / UTM).
  - **Windows**: Utilize Windows Sandbox or Hyper-V isolated VMs for untrusted binary execution.

---

## 3. Network Sandboxing & Egress Controls

Uncontrolled network egress can lead to SSRF (Server-Side Request Forgery) attacks against local cloud metadata endpoints or unauthorized lateral movement within internal networks.

### Mandatory Egress Rules:
1. **Cloud Metadata IP Blocking**:
   Platform adapters and test runners must block all outbound requests to:
   - `169.254.169.254` (AWS, GCP, Azure, OpenStack instance metadata)
   - `100.100.100.200` (Alibaba Cloud)
   - `metadata.google.internal`
2. **Loopback Scope Restriction**:
   When testing local fixture applications (e.g. `fixtures/demo-app`), traffic is strictly restricted to `127.0.0.1` and `localhost`.
3. **Proxy Inspection & Egress Logging**:
   In enterprise environments, all outbound HTTP/S traffic generated during testing should route through a forward proxy with domain whitelisting and TLS inspection.

---

## 4. Secret & Credential Redaction

Sensitive data must never be captured in test reports or stored in unencrypted artifacts.

### 4.1 Automatic Masking Engine
The engine enforces regex-based sanitization across all logs, DOM snapshots, and console outputs:
- **Authorization Headers**: `Bearer [A-Za-z0-9_\-\.]{20,}` -> `Bearer [REDACTED]`
- **API Keys**: Patterns matching AWS keys (`AKIA[0-9A-Z]{16}`), GitHub PATs (`ghp_[A-Za-z0-9]{36}`), Stripe tokens (`sk_live_[0-9a-zA-Z]{24}`), etc. are automatically masked.
- **Password Form Fields**: Inputs with `type="password"` or `name="password"` have their values sanitized prior to DOM serialization.

### 4.2 Ephemeral Test Credentials
- Always use synthetic, short-lived test credentials generated specifically for the test run.
- Production credentials or long-lived API tokens must never be configured in `qa.config.json`.

---

## 5. Cryptographic Evidence Integrity

To prevent evidence tampering or false test results:
1. **SHA-256 Checksumming**: Every captured artifact (screenshot, DOM snapshot, network HAR, failure log) is hashed at the moment of capture:
   ```typescript
   const hash = crypto.createHash('sha256').update(artifactContent).digest('hex');
   ```
2. **Report Binding**: The SHA-256 hash is immutably recorded in the `QARunReport` under `evidence[i].sha256`.
3. **Tamper Verification**: MCP tools (`qa_get_evidence`) and CLI verification utilities verify the SHA-256 checksum against disk content before returning any payload. Any mismatch is flagged as an integrity violation (`verifiedChecksum: false`).

---

## 6. Execution Guardrails & Bounded Limits

Autonomous testing loops are bounded by strict configuration controls in `qa.config.json` to prevent runaway processes:

```json
{
  "limits": {
    "maxTestDurationMs": 120000,
    "maxActionsPerTest": 1000,
    "maxReproductionAttempts": 5
  }
}
```

- **Execution Timeout**: Any test case exceeding `maxTestDurationMs` is forcefully halted with `QATimeoutError`.
- **Action Caps**: Any test attempting more than `maxActionsPerTest` triggers an immediate circuit breaker to protect system resources.
- **Strict Action Primitives**: The `ActionTypeSchema` strictly restricts actions to typed primitives (`click`, `fill`, `navigate`, `wait`, `rapidClicks`). Arbitrary shell execution or eval commands are forbidden by design.
