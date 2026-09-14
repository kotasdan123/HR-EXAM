/**
 * =====================================================================
 * SECURE EXAM PROCTORING WRAPPER — CORE LOGIC
 * =====================================================================
 *
 * IMPORTANT HONEST DISCLAIMER (read before deploying):
 * Browsers deliberately sandbox JavaScript so that a web page can NEVER
 * truly *prevent* a user from opening a new tab, switching windows, or
 * opening DevTools (e.g. via a browser's own top-level menu, F12 is
 * technically an OS/browser-level shortcut). What this script does —
 * and all that any client-side script can honestly do — is:
 *   1. DETECT when those things happen (Page Visibility API, blur, etc.)
 *   2. RESPOND immediately with logging + a penalty + a blocking overlay
 *   3. Make casual/opportunistic cheating loud, logged, and costly
 * For real exam integrity you should pair this with server-side
 * timestamp logging (send violations to a backend) and/or a lockdown
 * browser. This script alone is a deterrent layer, not a guarantee.
 * =====================================================================
 */

(() => {
  'use strict';

  // -------------------------------------------------------------------
  // CONFIGURATION
  // -------------------------------------------------------------------
  const CONFIG = {
    MAX_VIOLATIONS: 3,
    EXAM_DURATION_SECONDS: 60 * 60, // 60 minutes — adjust as needed
    GOOGLE_FORM_URL: 'https://docs.google.com/forms/d/e/1FAIpQLSf_PLACEHOLDER_FORM_ID/viewform?embedded=true',
  };

  // -------------------------------------------------------------------
  // STATE
  // -------------------------------------------------------------------
  const state = {
    studentName: '',
    studentId: '',
    violationCount: 0,
    examActive: false,       // true once the student has started the exam
    disqualified: false,
    timerInterval: null,
    secondsRemaining: CONFIG.EXAM_DURATION_SECONDS,
    // Guards against double-counting: e.g. blur firing alongside
    // visibilitychange for the same tab-switch event.
    overlayOpen: false,
    lastViolationTimestamp: 0,
    VIOLATION_DEBOUNCE_MS: 500,
  };

  // -------------------------------------------------------------------
  // DOM REFERENCES
  // -------------------------------------------------------------------
  const el = {
    startScreen: document.getElementById('start-screen'),
    examScreen: document.getElementById('exam-screen'),
    disqualifiedScreen: document.getElementById('disqualified-screen'),
    startForm: document.getElementById('start-form'),
    nameInput: document.getElementById('student-name'),
    idInput: document.getElementById('student-id'),
    startError: document.getElementById('start-error'),

    displayName: document.getElementById('display-name'),
    displayId: document.getElementById('display-id'),
    timer: document.getElementById('timer'),
    violationTracker: document.getElementById('violation-tracker'),

    formContainer: document.getElementById('form-container'),
    iframe: document.getElementById('exam-iframe'),

    overlay: document.getElementById('violation-overlay'),
    violationReason: document.getElementById('violation-reason'),
    overlayViolationCount: document.getElementById('overlay-violation-count'),
    resumeBtn: document.getElementById('resume-btn'),

    dqName: document.getElementById('dq-name'),
    dqId: document.getElementById('dq-id'),
    dqCount: document.getElementById('dq-count'),
    dqTime: document.getElementById('dq-time'),
  };

  // Set the placeholder Google Form URL from config (single source of truth)
  el.iframe.src = CONFIG.GOOGLE_FORM_URL;

  // =====================================================================
  // SCREEN MANAGEMENT HELPERS
  // =====================================================================
  function showScreen(screenEl) {
    [el.startScreen, el.examScreen, el.disqualifiedScreen].forEach((s) => {
      s.classList.remove('active');
    });
    screenEl.classList.add('active');
  }

  // =====================================================================
  // VIOLATION LOGGING
  // In production, replace this with a fetch() POST to your backend so
  // violations are recorded server-side and cannot be erased by the
  // student clearing console/localStorage.
  // =====================================================================
  function logViolationToServer(reason) {
    const record = {
      studentName: state.studentName,
      studentId: state.studentId,
      reason,
      violationNumber: state.violationCount,
      timestamp: new Date().toISOString(),
    };
    // Placeholder: swap this console.log for a real network call, e.g.
    // fetch('/api/log-violation', { method: 'POST', body: JSON.stringify(record) });
    console.warn('[PROCTOR LOG]', record);
  }

  // =====================================================================
  // START SCREEN LOGIC
  // =====================================================================
  el.startForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    el.startError.hidden = true;

    const name = el.nameInput.value.trim();
    const id = el.idInput.value.trim();

    if (!name || !id) {
      el.startError.textContent = 'Please enter both your name and student ID.';
      el.startError.hidden = false;
      return;
    }

    state.studentName = name;
    state.studentId = id;

    try {
      await enterFullscreen(document.documentElement);
    } catch (err) {
      // Full-screen request was blocked or denied — do not start the exam.
      el.startError.textContent =
        'Full-screen mode is required to begin the exam. Please allow full-screen and try again.';
      el.startError.hidden = false;
      return;
    }

    beginExam();
  });

  function beginExam() {
    state.examActive = true;
    state.disqualified = false;
    state.violationCount = 0;

    el.displayName.textContent = state.studentName;
    el.displayId.textContent = state.studentId;
    updateViolationDisplay();

    showScreen(el.examScreen);
    document.body.classList.add('lockdown-active');

    startTimer();
  }

  // =====================================================================
  // FULLSCREEN HELPERS (cross-browser)
  // =====================================================================
  function enterFullscreen(elem) {
    const request =
      elem.requestFullscreen ||
      elem.webkitRequestFullscreen || // Safari
      elem.mozRequestFullScreen ||    // old Firefox
      elem.msRequestFullscreen;       // old Edge/IE
    if (!request) return Promise.reject(new Error('Fullscreen API not supported'));
    return request.call(elem);
  }

  function exitFullscreen() {
    const exit =
      document.exitFullscreen ||
      document.webkitExitFullscreen ||
      document.mozCancelFullScreen ||
      document.msExitFullscreen;
    if (exit && isCurrentlyFullscreen()) {
      exit.call(document).catch(() => {});
    }
  }

  function isCurrentlyFullscreen() {
    return !!(
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.mozFullScreenElement ||
      document.msFullscreenElement
    );
  }

  // Fires whenever full-screen state changes for ANY reason, including the
  // user pressing Escape — this is our cross-browser hook for that.
  ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange']
    .forEach((evt) => document.addEventListener(evt, handleFullscreenChange));

  function handleFullscreenChange() {
    if (!state.examActive || state.disqualified) return;

    if (!isCurrentlyFullscreen()) {
      // The student exited full-screen (Escape key, OS gesture, etc.)
      registerViolation('You exited full-screen mode.');
    }
  }

  // =====================================================================
  // TAB / WINDOW FOCUS TRACKING
  // =====================================================================

  // 1. Page Visibility API — fires the instant the tab is hidden
  //    (switched away from, minimized, or OS-level app-switched).
  document.addEventListener('visibilitychange', () => {
    if (!state.examActive || state.disqualified) return;
    if (document.hidden) {
      registerViolation('You switched tabs or minimized the window.');
    }
  });

  // 2. Window blur — catches cases visibilitychange sometimes misses,
  //    such as a native browser dropdown, OS task switcher, or a
  //    second monitor / application receiving focus while this tab
  //    technically stays "visible".
  window.addEventListener('blur', () => {
    if (!state.examActive || state.disqualified) return;
    // Debounced together with visibilitychange below to avoid double-counting
    // a single alt-tab event that triggers both listeners.
    registerViolation('The exam window lost focus.');
  });

  // =====================================================================
  // VIOLATION REGISTRATION (with debounce to avoid double counting)
  // =====================================================================
  function registerViolation(reason) {
    if (state.disqualified) return;

    const now = Date.now();
    if (now - state.lastViolationTimestamp < state.VIOLATION_DEBOUNCE_MS) {
      // Same physical event already triggered a violation (e.g. blur +
      // visibilitychange firing together) — ignore this duplicate.
      return;
    }
    state.lastViolationTimestamp = now;

    state.violationCount += 1;
    updateViolationDisplay();
    logViolationToServer(reason);

    if (state.violationCount >= CONFIG.MAX_VIOLATIONS) {
      disqualifyStudent();
      return;
    }

    showViolationOverlay(reason);
  }

  function updateViolationDisplay() {
    el.violationTracker.textContent = `${state.violationCount} / ${CONFIG.MAX_VIOLATIONS}`;
    el.violationTracker.classList.remove('warning', 'critical');
    if (state.violationCount === CONFIG.MAX_VIOLATIONS - 1) {
      el.violationTracker.classList.add('warning');
    } else if (state.violationCount >= CONFIG.MAX_VIOLATIONS) {
      el.violationTracker.classList.add('critical');
    }
  }

  // =====================================================================
  // VIOLATION OVERLAY (interruption modal)
  // =====================================================================
  function showViolationOverlay(reason) {
    state.overlayOpen = true;
    el.violationReason.textContent = reason;
    el.overlayViolationCount.textContent = String(state.violationCount);
    el.overlay.hidden = false;
    el.formContainer.classList.add('blurred');

    // Pause the timer while the student is dealing with the violation
    // screen so they can't "eat" the exam clock by refusing to resume —
    // actually we choose the opposite for integrity: keep the clock
    // running so leaving the exam always costs them time. (See timer code.)
  }

  el.resumeBtn.addEventListener('click', async () => {
    // Clicking resume logs their acknowledgment and re-locks full-screen.
    logViolationToServer('Student acknowledged violation and resumed.');

    el.overlay.hidden = true;
    el.formContainer.classList.remove('blurred');
    state.overlayOpen = false;

    // Re-enforce full-screen since exiting fullscreen is a common
    // side-effect of alt-tabbing on some browsers/OSes.
    if (!isCurrentlyFullscreen() && state.examActive && !state.disqualified) {
      try {
        await enterFullscreen(document.documentElement);
      } catch (err) {
        // If re-entering fullscreen fails, keep the student blocked
        // until they succeed — do not silently continue unlocked.
        registerViolation('Could not re-establish full-screen mode.');
      }
    }
  });

  // =====================================================================
  // TIMER
  // =====================================================================
  function startTimer() {
    state.secondsRemaining = CONFIG.EXAM_DURATION_SECONDS;
    renderTimer();

    state.timerInterval = setInterval(() => {
      if (state.disqualified) {
        clearInterval(state.timerInterval);
        return;
      }
      state.secondsRemaining -= 1;
      renderTimer();

      if (state.secondsRemaining <= 0) {
        clearInterval(state.timerInterval);
        // Time's up — treat as a normal (non-violation) exam end.
        // In production, auto-submit the Google Form or navigate away here.
        el.timer.textContent = '00:00';
      }
    }, 1000);
  }

  function renderTimer() {
    const minutes = Math.floor(state.secondsRemaining / 60)
      .toString()
      .padStart(2, '0');
    const seconds = (state.secondsRemaining % 60).toString().padStart(2, '0');
    el.timer.textContent = `${minutes}:${seconds}`;
  }

  // =====================================================================
  // DISQUALIFICATION (permanent, irreversible for this session)
  // =====================================================================
  function disqualifyStudent() {
    state.disqualified = true;
    state.examActive = false;

    clearInterval(state.timerInterval);

    // Permanently remove the Google Form iframe from the DOM so the
    // student cannot interact with it again, even via dev tools.
    if (el.iframe && el.iframe.parentNode) {
      el.iframe.parentNode.removeChild(el.iframe);
    }

    // Hide the violation overlay if it happened to be open.
    el.overlay.hidden = true;

    exitFullscreen();

    // Populate and show the disqualification screen.
    el.dqName.textContent = state.studentName;
    el.dqId.textContent = state.studentId;
    el.dqCount.textContent = String(state.violationCount);
    el.dqTime.textContent = new Date().toLocaleString();

    logViolationToServer('STUDENT DISQUALIFIED — max violations reached.');

    showScreen(el.disqualifiedScreen);
    document.body.classList.remove('lockdown-active');
  }

  // =====================================================================
  // GLOBAL INPUT LOCKOUT
  // Disabled: right-click, text selection, copy, cut, paste.
  // =====================================================================
  document.addEventListener('contextmenu', (e) => {
    if (state.examActive) e.preventDefault();
  });

  document.addEventListener('selectstart', (e) => {
    if (state.examActive) e.preventDefault();
  });

  ['copy', 'cut', 'paste'].forEach((evt) => {
    document.addEventListener(evt, (e) => {
      if (state.examActive) e.preventDefault();
    });
  });

  // =====================================================================
  // KEYBOARD SHORTCUT INTERCEPTION
  // Blocks the *page-level* handling of common DevTools / new-tab /
  // new-window shortcuts. NOTE: browsers reserve some of these
  // (like Ctrl+T / Cmd+T for new tab) at the OS/browser-chrome level,
  // meaning preventDefault() cannot actually stop them from firing —
  // this still catches and logs the *attempt* wherever the browser
  // does expose the keydown event to the page.
  // =====================================================================
  document.addEventListener('keydown', (e) => {
    if (!state.examActive) return;

    const key = e.key ? e.key.toLowerCase() : '';
    const ctrlOrCmd = e.ctrlKey || e.metaKey;

    const isDevToolsShortcut =
      key === 'f12' ||
      (ctrlOrCmd && e.shiftKey && ['i', 'c', 'j'].includes(key)) || // Ctrl/Cmd+Shift+I/C/J
      (e.metaKey && e.altKey && key === 'i'); // Cmd+Option+I (Mac Safari)

    const isNewTabOrWindowShortcut =
      (ctrlOrCmd && key === 't') || // Ctrl/Cmd+T
      (ctrlOrCmd && key === 'n') || // Ctrl/Cmd+N
      (ctrlOrCmd && key === 'w');   // Ctrl/Cmd+W (closing could dodge lockdown)

    const isViewSourceShortcut = ctrlOrCmd && key === 'u';

    if (isDevToolsShortcut || isNewTabOrWindowShortcut || isViewSourceShortcut) {
      e.preventDefault();
      e.stopPropagation();
      registerViolation(`Attempted restricted shortcut: ${describeShortcut(e)}`);
    }
  });

  function describeShortcut(e) {
    const parts = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.metaKey) parts.push('Cmd');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    parts.push(e.key.toUpperCase());
    return parts.join('+');
  }

  // =====================================================================
  // WARN BEFORE LEAVING / CLOSING THE TAB DURING AN ACTIVE EXAM
  // =====================================================================
  window.addEventListener('beforeunload', (e) => {
    if (state.examActive && !state.disqualified) {
      e.preventDefault();
      e.returnValue = ''; // Required for the native browser confirmation dialog
    }
  });
})();
