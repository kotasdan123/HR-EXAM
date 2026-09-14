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
    GOOGLE_FORM_URL: 'https://docs.google.com/forms/d/e/1FAIpQLSeK35oh4wlzl4-EFWxgU1H5BGgQu02UOhgK392l8CIY8Cho0A/viewform?usp=header',
    // Milliseconds to ignore blur/visibility/fullscreen events right after
    // the exam starts (or right after re-entering fullscreen from the
    // resume button). This exists because *entering fullscreen itself*
    // can fire a spurious `blur` event on some browsers/OSes during the
    // windowed->fullscreen transition — without this grace window that
    // transition was being counted as a violation before the student
    // ever saw the exam.
    GRACE_PERIOD_MS: 1200,
  };

  // -------------------------------------------------------------------
  // ADMIN / EXAMINER AUTH (placeholder — client-side only)
  // In production, replace this with a real authentication call to your
  // backend. Hardcoded credentials in shipped JS are NOT secure; this is
  // here purely so the login flow is demonstrable out of the box.
  // -------------------------------------------------------------------
  const ADMIN_CREDENTIALS = {
    username: 'admin',
    password: 'ChangeMe123!',
  };

  // -------------------------------------------------------------------
  // STATE
  // -------------------------------------------------------------------
  const state = {
    studentName: '',
    studentId: '',
    violationCount: 0,
    examActive: false,       // true once the student has started the exam
    timerRunning: false,     // true only while the countdown is actively ticking
    disqualified: false,
    timerInterval: null,
    secondsRemaining: CONFIG.EXAM_DURATION_SECONDS,
    // Guards against double-counting: e.g. blur firing alongside
    // visibilitychange for the same tab-switch event.
    overlayOpen: false,
    lastViolationTimestamp: 0,
    VIOLATION_DEBOUNCE_MS: 500,
    // Timestamp (ms) until which blur/visibility/fullscreen events are
    // ignored — see CONFIG.GRACE_PERIOD_MS above.
    graceUntil: 0,
    // In-memory log of every violation across all sessions, shown on the
    // admin dashboard. In production this should come from your backend.
    violationLog: [],
    adminLoggedIn: false,
  };

  // -------------------------------------------------------------------
  // DOM REFERENCES
  // -------------------------------------------------------------------
  const el = {
    homeScreen: document.getElementById('home-screen'),
    adminLoginScreen: document.getElementById('admin-login-screen'),
    adminDashboardScreen: document.getElementById('admin-dashboard-screen'),
    startScreen: document.getElementById('start-screen'),
    examScreen: document.getElementById('exam-screen'),
    disqualifiedScreen: document.getElementById('disqualified-screen'),

    getStartedBtn: document.getElementById('get-started-btn'),
    adminLoginLink: document.getElementById('admin-login-link'),
    adminBackBtn: document.getElementById('admin-back-btn'),
    studentBackBtn: document.getElementById('student-back-btn'),

    adminLoginForm: document.getElementById('admin-login-form'),
    adminUsername: document.getElementById('admin-username'),
    adminPassword: document.getElementById('admin-password'),
    adminLoginError: document.getElementById('admin-login-error'),
    adminLogoutBtn: document.getElementById('admin-logout-btn'),

    adminSettingsForm: document.getElementById('admin-settings-form'),
    settingDuration: document.getElementById('setting-duration'),
    settingMaxViolations: document.getElementById('setting-max-violations'),
    settingFormUrl: document.getElementById('setting-form-url'),
    adminSettingsSaved: document.getElementById('admin-settings-saved'),
    violationLogBody: document.getElementById('violation-log-body'),

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

  // =====================================================================
  // SCREEN MANAGEMENT HELPERS
  // =====================================================================
  function showScreen(screenEl) {
    [
      el.homeScreen,
      el.adminLoginScreen,
      el.adminDashboardScreen,
      el.startScreen,
      el.examScreen,
      el.disqualifiedScreen,
    ].forEach((s) => s.classList.remove('active'));
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

    state.violationLog.push(record);
    // Keep the admin table fresh if it happens to be open while an
    // exam is running (e.g. examiner monitoring in a second window).
    if (state.adminLoggedIn && el.adminDashboardScreen.classList.contains('active')) {
      renderViolationLog();
    }
  }

  // =====================================================================
  // NAVIGATION: HOME SCREEN
  // =====================================================================
  el.getStartedBtn.addEventListener('click', () => {
    showScreen(el.startScreen);
  });

  el.adminLoginLink.addEventListener('click', () => {
    el.adminLoginError.hidden = true;
    el.adminLoginForm.reset();
    showScreen(el.adminLoginScreen);
  });

  el.adminBackBtn.addEventListener('click', () => {
    showScreen(el.homeScreen);
  });

  el.studentBackBtn.addEventListener('click', () => {
    showScreen(el.homeScreen);
  });

  // =====================================================================
  // ADMIN / EXAMINER LOGIN
  // =====================================================================
  el.adminLoginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const username = el.adminUsername.value.trim();
    const password = el.adminPassword.value;

    // Placeholder check — replace with a real backend auth request.
    if (username === ADMIN_CREDENTIALS.username && password === ADMIN_CREDENTIALS.password) {
      state.adminLoggedIn = true;
      el.adminLoginError.hidden = true;
      openAdminDashboard();
    } else {
      el.adminLoginError.textContent = 'Invalid username or password.';
      el.adminLoginError.hidden = false;
    }
  });

  el.adminLogoutBtn.addEventListener('click', () => {
    state.adminLoggedIn = false;
    showScreen(el.homeScreen);
  });

  function openAdminDashboard() {
    // Pre-fill settings form with current CONFIG values.
    el.settingDuration.value = Math.round(CONFIG.EXAM_DURATION_SECONDS / 60);
    el.settingMaxViolations.value = CONFIG.MAX_VIOLATIONS;
    el.settingFormUrl.value = CONFIG.GOOGLE_FORM_URL;
    el.adminSettingsSaved.hidden = true;
    renderViolationLog();
    showScreen(el.adminDashboardScreen);
  }

  el.adminSettingsForm.addEventListener('submit', (e) => {
    e.preventDefault();

    const minutes = parseInt(el.settingDuration.value, 10);
    const maxViolations = parseInt(el.settingMaxViolations.value, 10);
    const formUrl = el.settingFormUrl.value.trim();

    if (!minutes || minutes < 1 || !maxViolations || maxViolations < 1 || !formUrl) {
      return;
    }

    CONFIG.EXAM_DURATION_SECONDS = minutes * 60;
    CONFIG.MAX_VIOLATIONS = maxViolations;
    CONFIG.GOOGLE_FORM_URL = formUrl;

    el.adminSettingsSaved.hidden = false;
  });

  function renderViolationLog() {
    if (state.violationLog.length === 0) {
      el.violationLogBody.innerHTML =
        '<tr><td colspan="5" class="empty-log">No violations logged yet.</td></tr>';
      return;
    }

    // Most recent first.
    const rows = [...state.violationLog]
      .reverse()
      .map((v) => {
        const time = new Date(v.timestamp).toLocaleTimeString();
        return `<tr>
          <td>${escapeHtml(time)}</td>
          <td>${escapeHtml(v.studentName)}</td>
          <td>${escapeHtml(v.studentId)}</td>
          <td>${escapeHtml(String(v.violationNumber))}</td>
          <td>${escapeHtml(v.reason)}</td>
        </tr>`;
      })
      .join('');

    el.violationLogBody.innerHTML = rows;
  }

  // Minimal HTML-escaping helper so student-provided name/ID (or any
  // free-text violation reason) can never inject markup into the
  // admin dashboard table.
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
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

    // Load the form fresh in case an admin updated CONFIG.GOOGLE_FORM_URL
    // via the dashboard since page load.
    if (el.iframe) {
      el.iframe.src = CONFIG.GOOGLE_FORM_URL;
    }

    showScreen(el.examScreen);
    document.body.classList.add('lockdown-active');

    // Start the grace period immediately so the fullscreen transition
    // itself can't be mistaken for a violation before the timer's
    // first tick even happens.
    state.graceUntil = Date.now() + CONFIG.GRACE_PERIOD_MS;

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
