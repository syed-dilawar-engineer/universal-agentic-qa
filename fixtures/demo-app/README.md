# Agentic QA Fixture Demo Application

A controlled HTML5/JavaScript application with deterministic, deliberate defects designed for end-to-end integration and fix verification testing within the Universal Agentic QA Engine.

---

## Deliberate Defects Catalog

| Defect ID | Category | Description | Unfixed State | Fixed State (`FIX_DEFECTS=true`) |
|-----------|----------|-------------|---------------|----------------------------------|
| **Bug 1** | Robustness / Concurrency | Button claims to disable on click, but allows rapid double/triple submission if clicked fast (race condition). | Handler sets `disabled` asynchronously in `setTimeout(..., 150)`, accepting multiple clicks within that window. | Handler locks and sets `button.disabled = true` synchronously on the immediate event, rejecting further clicks. |
| **Bug 2** | Responsive Layout | Mobile layout horizontal overflow on narrow viewports (`< 380px`). | Container `#overflow-container` has a fixed `min-width: 420px; width: 420px;`, overflowing screen width. | Container is fluid: `max-width: 100%; width: 100%; box-sizing: border-box;`, fitting viewports down to 320px. |
| **Bug 3** | Runtime Stability | Unhandled console error when a broken button is clicked. | Click handler invokes method on `undefined` reference, emitting an unhandled `TypeError` to `console.error` and `window.onerror`. | Click handler safely executes with error guards, updating status cleanly without console errors. |
| **Bug 4** | Accessibility (a11y) | Missing accessible label on an icon button. | `<button id="icon-search-btn">` has no `aria-label`, no `title`, and no inner text, failing WCAG 2.1 AA 4.1.2. | Button includes explicit `aria-label="Search catalog"` and `title="Search catalog"`. |

---

## Fix Toggle Modes

The fixture can be toggled between defective and fixed states via multiple mechanisms:

1. **Query Parameter**: Add `?fix=true` to any URL (e.g. `http://localhost:3456/?fix=true`).
2. **Environment Variable**: Start the server with `FIX_DEFECTS=true node server.js`.
3. **HTTP Header**: Send `X-Fix-Defects: true` with any request.
4. **Interactive UI**: Click the "Toggle Fix Mode" button in the header.

---

## Running the Fixture Server

### Defective Mode (Default)
```bash
node server.js
# Starts at http://127.0.0.1:3456
```

### Fixed Mode
```bash
FIX_DEFECTS=true node server.js
# Starts at http://127.0.0.1:3456 with all defects resolved
```

### Programmatic Usage in Tests
```typescript
import { startFixtureServer } from '../../fixtures/demo-app/server.js';

const fixture = await startFixtureServer({ fixDefects: false });
console.log(`Server running at ${fixture.url}`);
// Run tests...
await fixture.close();
```
