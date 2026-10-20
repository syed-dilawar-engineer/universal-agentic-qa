/**
 * Agentic QA Fixture Demo App Script
 * Implements 4 deliberate defects with a deterministic FIX_DEFECTS toggle.
 */

// Global error tracking for headless/automation probes
window.__QA_ERRORS__ = [];
window.addEventListener('error', (event) => {
  window.__QA_ERRORS__.push({
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    error: event.error ? String(event.error) : event.message,
    timestamp: new Date().toISOString(),
  });
});

(function initFixtureApp() {
  const urlParams = new URLSearchParams(window.location.search);
  const isFixed =
    window.__FIX_DEFECTS__ === true ||
    urlParams.get('fix') === 'true' ||
    urlParams.get('FIX_DEFECTS') === 'true';

  // Apply fixed mode UI indicator and body class
  const fixStatusEl = document.getElementById('fix-status');
  if (isFixed) {
    document.body.classList.add('fixed-mode');
    if (fixStatusEl) {
      fixStatusEl.textContent = 'Mode: Fixed (FIX_DEFECTS=true)';
      fixStatusEl.className = 'badge badge-fixed';
      fixStatusEl.setAttribute('data-fixed', 'true');
    }
  } else {
    document.body.classList.remove('fixed-mode');
    if (fixStatusEl) {
      fixStatusEl.textContent = 'Mode: Defective (Bugs Present)';
      fixStatusEl.className = 'badge badge-defective';
      fixStatusEl.setAttribute('data-fixed', 'false');
    }
  }

  // --------------------------------------------------------------------------
  // Bug 1: Race Condition in Rapid Button Clicks
  // --------------------------------------------------------------------------
  const submitBtn = document.getElementById('submit-btn');
  const submissionCountEl = document.getElementById('submission-count');
  const alertEl = document.getElementById('submission-alert');
  let submissionCount = 0;

  function updateSubmissionUI(count) {
    if (submissionCountEl) {
      submissionCountEl.textContent = `Submissions: ${count}`;
      submissionCountEl.setAttribute('data-count', String(count));
    }
    if (count > 1 && alertEl) {
      alertEl.className = 'alert alert-warning';
      alertEl.textContent = `Warning: ${count} duplicate submissions detected due to race condition!`;
    }
  }

  if (submitBtn) {
    submitBtn.addEventListener('click', () => {
      if (isFixed) {
        // FIXED BEHAVIOR:
        // Synchronously check and lock disabled state on immediate invocation.
        if (submitBtn.disabled || submitBtn.getAttribute('aria-disabled') === 'true') {
          return;
        }
        submitBtn.disabled = true;
        submitBtn.setAttribute('disabled', 'true');
        submitBtn.setAttribute('aria-disabled', 'true');
        submissionCount += 1;
        updateSubmissionUI(submissionCount);
      } else {
        // DEFECTIVE BEHAVIOR (BUG 1):
        // Asynchronous/delayed disable allows rapid successive clicks to pass through!
        if (submitBtn.getAttribute('data-submitting') === 'done') {
          return;
        }
        setTimeout(() => {
          submitBtn.disabled = true;
          submitBtn.setAttribute('disabled', 'true');
          submitBtn.setAttribute('data-submitting', 'done');
        }, 150);

        submissionCount += 1;
        updateSubmissionUI(submissionCount);
      }
    });
  }

  window.resetSubmissions = function () {
    submissionCount = 0;
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.removeAttribute('disabled');
      submitBtn.removeAttribute('aria-disabled');
      submitBtn.removeAttribute('data-submitting');
    }
    if (alertEl) {
      alertEl.className = 'alert hidden';
      alertEl.textContent = '';
    }
    updateSubmissionUI(0);
  };

  // --------------------------------------------------------------------------
  // Bug 3: Unhandled Console Error on Click
  // --------------------------------------------------------------------------
  const brokenBtn = document.getElementById('broken-action-btn');
  const brokenStatusEl = document.getElementById('broken-action-status');

  if (brokenBtn) {
    brokenBtn.addEventListener('click', () => {
      if (isFixed) {
        // FIXED BEHAVIOR:
        // Safe, graceful handler that does not throw or emit unhandled console errors.
        if (brokenStatusEl) {
          brokenStatusEl.textContent = 'Status: Action completed safely (no errors)';
          brokenStatusEl.style.color = 'var(--success)';
        }
      } else {
        // DEFECTIVE BEHAVIOR (BUG 3):
        // Calls a method on an undefined object without try/catch,
        // causing an unhandled TypeError logged to console and window.onerror.
        if (brokenStatusEl) {
          brokenStatusEl.textContent = 'Status: Executing...';
        }
        const undefinedService = undefined;
        // Unhandled crash trigger
        undefinedService.invokeCrashHandler();
      }
    });
  }

  // --------------------------------------------------------------------------
  // Bug 4: Missing Accessible Label on Icon Button
  // --------------------------------------------------------------------------
  const iconBtn = document.getElementById('icon-search-btn');
  if (iconBtn) {
    if (isFixed) {
      // FIXED BEHAVIOR:
      // Provide accessible name via aria-label and title
      iconBtn.setAttribute('aria-label', 'Search catalog');
      iconBtn.setAttribute('title', 'Search catalog');
    } else {
      // DEFECTIVE BEHAVIOR (BUG 4):
      // Ensure no accessible name attributes exist
      iconBtn.removeAttribute('aria-label');
      iconBtn.removeAttribute('title');
      iconBtn.removeAttribute('aria-labelledby');
    }
  }

  // --------------------------------------------------------------------------
  // Mode Switcher Helper
  // --------------------------------------------------------------------------
  window.toggleFixMode = function () {
    const nextFix = !isFixed;
    const url = new URL(window.location.href);
    url.searchParams.set('fix', String(nextFix));
    window.location.href = url.toString();
  };
})();
