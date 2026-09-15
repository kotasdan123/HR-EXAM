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
  // backend, and never ship hardcoded/default credentials as-is — change
  // this password before deploying.
  // -------------------------------------------------------------------
  // state.adminUsers below seeds the default superadmin account:
  //   username: admin   password: 123admin
  // Additional admin/examiner accounts can be added from the dashboard
  // by anyone logged in with the "superadmin" role.

  // -------------------------------------------------------------------
  // STATE
  // -------------------------------------------------------------------
  const state = {
    studentName: '',
    violationCount: 0,
    examActive: false,       // true only while a student's exam session is live
    timerRunning: false,     // true only while the countdown is actively ticking
    disqualified: false,
    timerInterval: null,
    secondsRemaining: CONFIG.EXAM_DURATION_SECONDS,
    // Guards against double-counting: e.g. blur firing alongside
    // visibilitychange for the same tab-switch event.
    overlayOpen: false,
    lastViolationTimestamp: 0,
    VIOLATION_DEBOUNCE_MS: 500,
    // Timestamp (ms) until which blur/visibility/fullscreen-exit events
    // are ignored — see CONFIG.GRACE_PERIOD_MS above. This is what fixes
    // the "violation prompt fires before the exam even starts / before
    // any real violation happened" bug: entering fullscreen can itself
    // cause a transient blur on some browsers, so we ignore events for
    // a short window right after every fullscreen transition.
    graceUntil: 0,

    // In-memory log of every violation across all sessions, shown on the
    // admin dashboard. In production this should come from your backend.
    violationLog: [],

    // Admin/examiner accounts. Seeded with a default superadmin.
    // CHANGE THIS PASSWORD before deploying to a real environment.
    adminUsers: [{ username: 'admin', password: '123admin', role: 'superadmin' }],
    adminLoggedIn: false,
    currentAdminUser: null,

    // One record per exam attempt, used for the Submissions Monitoring
    // table and the Analytics panel on the admin dashboard.
    submissions: [],
    currentSubmissionIndex: -1,
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
    sessionEndedScreen: document.getElementById('session-ended-screen'),

    getStartedBtn: document.getElementById('get-started-btn'),
    adminLoginLink: document.getElementById('admin-login-link'),
    adminBackBtn: document.getElementById('admin-back-btn'),
    studentBackBtn: document.getElementById('student-back-btn'),

    adminLoginForm: document.getElementById('admin-login-form'),
    adminUsername: document.getElementById('admin-username'),
    adminPassword: document.getElementById('admin-password'),
    adminLoginError: document.getElementById('admin-login-error'),
    adminLogoutBtn: document.getElementById('admin-logout-btn'),
    adminWelcome: document.getElementById('admin-welcome'),

    adminSettingsForm: document.getElementById('admin-settings-form'),
    settingDuration: document.getElementById('setting-duration'),
    settingMaxViolations: document.getElementById('setting-max-violations'),
    settingFormUrl: document.getElementById('setting-form-url'),
    adminSettingsSaved: document.getElementById('admin-settings-saved'),
    violationLogBody: document.getElementById('violation-log-body'),

    // Analytics
    statTotal: document.getElementById('stat-total'),
    statProgress: document.getElementById('stat-progress'),
    statCompleted: document.getElementById('stat-completed'),
    statExpired: document.getElementById('stat-expired'),
    statDisqualified: document.getElementById('stat-disqualified'),
    statAvgViolations: document.getElementById('stat-avg-violations'),
    barCompleted: document.getElementById('bar-completed'),
    barExpired: document.getElementById('bar-expired'),
    barDisqualified: document.getElementById('bar-disqualified'),
    barProgress: document.getElementById('bar-progress'),

    // Submissions
    submissionsBody: document.getElementById('submissions-body'),

    // User management
    userManagementSection: document.getElementById('user-management-section'),
    addUserForm: document.getElementById('add-user-form'),
    newUserUsername: document.getElementById('new-user-username'),
    newUserPassword: document.getElementById('new-user-password'),
    newUserRole: document.getElementById('new-user-role'),
    addUserError: document.getElementById('add-user-error'),
    addUserSuccess: document.getElementById('add-user-success'),
    userListBody: document.getElementById('user-list-body'),

    startForm: document.getElementById('start-form'),
    nameInput: document.getElementById('student-name'),
    startError: document.getElementById('start-error'),

    displayName: document.getElementById('display-name'),
    timer: document.getElementById('timer'),
    violationTracker: document.getElementById('violation-tracker'),
    submitExamBtn: document.getElementById('submit-exam-btn'),

    formContainer: document.getElementById('form-container'),
    iframe: document.getElementById('exam-iframe'),

    overlay: document.getElementById('violation-overlay'),
    violationReason: document.getElementById('violation-reason'),
    overlayViolationCount: document.getElementById('overlay-violation-count'),
    resumeBtn: document.getElementById('resume-btn'),

    dqName: document.getElementById('dq-name'),
    dqCount: document.getElementById('dq-count'),
    dqTime: document.getElementById('dq-time'),

    seIcon: document.getElementById('session-ended-icon'),
    seTitle: document.getElementById('session-ended-title'),
    seSubtitle: document.getElementById('session-ended-subtitle'),
    seName: document.getElementById('se-name'),
    seCount: document.getElementById('se-count'),
    seTime: document.getElementById('se-time'),
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
      el.sessionEndedScreen,
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
      reason,
      violationNumber: state.violationCount,
      timestamp: new Date().toISOString(),
    };
    // Placeholder: swap this console.log for a real network call, e.g.
    // fetch('/api/log-violation', { method: 'POST', body: JSON.stringify(record) });
    console.warn('[PROCTOR LOG]', record);

    state.violationLog.push(record);
    refreshAdminLiveViews();
  }

  // Re-renders the admin dashboard's live panels (violation log,
  // submissions table, analytics) if — and only if — the dashboard is
  // currently the visible screen. This is what makes the dashboard
  // "auto-update" as new violations/sessions happen elsewhere in the
  // app without requiring a manual refresh or re-login.
  function refreshAdminLiveViews() {
    if (state.adminLoggedIn && el.adminDashboardScreen.classList.contains('active')) {
      renderViolationLog();
      renderSubmissions();
      renderAnalytics();
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

    // Placeholder auth — replace with a real backend auth request in
    // production. Passwords should never be stored or compared in
    // plaintext client-side JS outside of a demo like this.
    const user = state.adminUsers.find(
      (u) => u.username === username && u.password === password
    );

    if (user) {
      state.adminLoggedIn = true;
      state.currentAdminUser = user;
      el.adminLoginError.hidden = true;
      openAdminDashboard();
    } else {
      el.adminLoginError.textContent = 'Invalid username or password.';
      el.adminLoginError.hidden = false;
    }
  });

  el.adminLogoutBtn.addEventListener('click', () => {
    state.adminLoggedIn = false;
    state.currentAdminUser = null;
    showScreen(el.homeScreen);
  });

  function openAdminDashboard() {
    el.adminWelcome.textContent = `Signed in as ${state.currentAdminUser.username} (${state.currentAdminUser.role})`;

    // Only superadmin accounts can create/remove other admin/examiner
    // accounts. Everyone else (admin, examiner) sees monitoring +
    // settings but not the user management section.
    el.userManagementSection.hidden = state.currentAdminUser.role !== 'superadmin';

    // Pre-fill settings form with current CONFIG values.
    el.settingDuration.value = Math.round(CONFIG.EXAM_DURATION_SECONDS / 60);
    el.settingMaxViolations.value = CONFIG.MAX_VIOLATIONS;
    el.settingFormUrl.value = CONFIG.GOOGLE_FORM_URL;
    el.adminSettingsSaved.hidden = true;

    el.addUserError.hidden = true;
    el.addUserSuccess.hidden = true;
    el.addUserForm.reset();

    renderSubmissions();
    renderAnalytics();
    renderUserList();
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

  // ---------------------------------------------------------------------
  // USER MANAGEMENT (superadmin only)
  // ---------------------------------------------------------------------
  el.addUserForm.addEventListener('submit', (e) => {
    e.preventDefault();
    el.addUserError.hidden = true;
    el.addUserSuccess.hidden = true;

    // Defence in depth: even though the section is hidden in the UI for
    // non-superadmins, never trust the UI alone to enforce a permission.
    if (!state.currentAdminUser || state.currentAdminUser.role !== 'superadmin') {
      el.addUserError.textContent = 'Only a superadmin can add users.';
      el.addUserError.hidden = false;
      return;
    }

    const username = el.newUserUsername.value.trim();
    const password = el.newUserPassword.value;
    const role = el.newUserRole.value;

    if (!username || !password) {
      el.addUserError.textContent = 'Username and password are required.';
      el.addUserError.hidden = false;
      return;
    }

    const exists = state.adminUsers.some(
      (u) => u.username.toLowerCase() === username.toLowerCase()
    );
    if (exists) {
      el.addUserError.textContent = 'That username already exists.';
      el.addUserError.hidden = false;
      return;
    }

    state.adminUsers.push({ username, password, role });
    el.addUserForm.reset();
    el.addUserSuccess.hidden = false;
    renderUserList();
  });

  function renderUserList() {
    el.userListBody.innerHTML = state.adminUsers
      .map((u) => {
        const isSelf = state.currentAdminUser && u.username === state.currentAdminUser.username;
        const removeBtn = isSelf
          ? '<span class="text-dim-inline">Current user</span>'
          : `<button type="button" class="remove-user-btn" data-username="${escapeHtml(u.username)}">Remove</button>`;
        return `<tr>
          <td>${escapeHtml(u.username)}</td>
          <td>${escapeHtml(u.role)}</td>
          <td>${removeBtn}</td>
        </tr>`;
      })
      .join('');

    el.userListBody.querySelectorAll('.remove-user-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const username = btn.getAttribute('data-username');
        const target = state.adminUsers.find((u) => u.username === username);
        const remainingSuperadmins = state.adminUsers.filter((u) => u.role === 'superadmin').length;

        if (target && target.role === 'superadmin' && remainingSuperadmins <= 1) {
          window.alert('Cannot remove the last remaining superadmin account.');
          return;
        }

        state.adminUsers = state.adminUsers.filter((u) => u.username !== username);
        renderUserList();
      });
    });
  }

  // ---------------------------------------------------------------------
  // SUBMISSIONS MONITORING + ANALYTICS
  // ---------------------------------------------------------------------
  // NOTE ON WHAT "SUBMISSION" MEANS HERE: because the Google Form is
  // embedded cross-origin in an <iframe>, this page has no way to
  // detect the actual "form submitted" event inside it — cross-origin
  // iframes are sandboxed from each other by design. What we CAN track
  // reliably is the *session* around it: when a student started, how
  // long they took, how many violations they racked up, and how the
  // session ended (they explicitly told us they submitted, time ran
  // out, or they were disqualified). That's what populates this table.

  function startSubmissionRecord(name) {
    state.submissions.push({
      name,
      startTime: Date.now(),
      endTime: null,
      status: 'In Progress',
      violations: 0,
    });
    state.currentSubmissionIndex = state.submissions.length - 1;
    refreshAdminLiveViews();
  }

  function updateSubmissionRecord(patch) {
    if (state.currentSubmissionIndex < 0) return;
    const record = state.submissions[state.currentSubmissionIndex];
    if (!record) return;
    Object.assign(record, patch);
    refreshAdminLiveViews();
  }

  function statusBadgeClass(status) {
    switch (status) {
      case 'In Progress': return 'in-progress';
      case 'Completed': return 'completed';
      case 'Time Expired': return 'time-expired';
      case 'Disqualified': return 'disqualified';
      default: return '';
    }
  }

  function formatTimeOrDash(ts) {
    return ts ? new Date(ts).toLocaleTimeString() : '—';
  }

  function renderSubmissions() {
    if (state.submissions.length === 0) {
      el.submissionsBody.innerHTML =
        '<tr><td colspan="5" class="empty-log">No exam sessions yet.</td></tr>';
      return;
    }

    el.submissionsBody.innerHTML = [...state.submissions]
      .reverse()
      .map((s) => `<tr>
        <td>${escapeHtml(s.name)}</td>
        <td>${formatTimeOrDash(s.startTime)}</td>
        <td>${formatTimeOrDash(s.endTime)}</td>
        <td><span class="status-badge ${statusBadgeClass(s.status)}">${escapeHtml(s.status)}</span></td>
        <td>${s.violations}</td>
      </tr>`)
      .join('');
  }

  function renderAnalytics() {
    const total = state.submissions.length;
    const inProgress = state.submissions.filter((s) => s.status === 'In Progress').length;
    const completed = state.submissions.filter((s) => s.status === 'Completed').length;
    const expired = state.submissions.filter((s) => s.status === 'Time Expired').length;
    const disqualified = state.submissions.filter((s) => s.status === 'Disqualified').length;
    const avgViolations = total
      ? (state.submissions.reduce((sum, s) => sum + s.violations, 0) / total).toFixed(1)
      : '0.0';

    el.statTotal.textContent = String(total);
    el.statProgress.textContent = String(inProgress);
    el.statCompleted.textContent = String(completed);
    el.statExpired.textContent = String(expired);
    el.statDisqualified.textContent = String(disqualified);
    el.statAvgViolations.textContent = avgViolations;

    const pct = (n) => (total ? (n / total) * 100 : 0);
    el.barCompleted.style.width = `${pct(completed)}%`;
    el.barExpired.style.width = `${pct(expired)}%`;
    el.barDisqualified.style.width = `${pct(disqualified)}%`;
    el.barProgress.style.width = `${pct(inProgress)}%`;
  }

  function renderViolationLog() {
    if (state.violationLog.length === 0) {
      el.violationLogBody.innerHTML =
        '<tr><td colspan="4" class="empty-log">No violations logged yet.</td></tr>';
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

    if (!name) {
      el.startError.textContent = 'Please enter your full name.';
      el.startError.hidden = false;
      return;
    }

    state.studentName = name;

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
    updateViolationDisplay();
    startSubmissionRecord(state.studentName);

    // Load the form fresh in case an admin updated CONFIG.GOOGLE_FORM_URL
    // via the dashboard since page load.
    if (el.iframe) {
      el.iframe.src = CONFIG.GOOGLE_FORM_URL;
    }

    showScreen(el.examScreen);
    document.body.classList.add('lockdown-active');

    // Start the grace period immediately so the fullscreen transition
    // itself can't be mistaken for a violation before the timer's
    // first tick even happens. See CONFIG.GRACE_PERIOD_MS for why.
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

    if (isCurrentlyFullscreen()) {
      // We just (re-)entered fullscreen — either the initial exam start
      // or a re-lock after the resume button. The transition itself can
      // trigger a spurious blur/visibilitychange on some browser/OS
      // combinations, which is exactly what was causing the violation
      // overlay to appear before the student had actually done anything
      // wrong. Extend the grace window so those are ignored.
      state.graceUntil = Date.now() + CONFIG.GRACE_PERIOD_MS;
      return;
    }

    // Otherwise the student exited full-screen (Escape key, OS gesture,
    // taskbar interaction, etc.) — this is a real violation.
    registerViolation('You exited full-screen mode.');
  }

  // =====================================================================
  // TAB / WINDOW FOCUS TRACKING
  // =====================================================================

  // 1. Page Visibility API — fires the instant the tab is hidden
  //    (switched away from, minimized, or OS-level app-switched).
  document.addEventListener('visibilitychange', () => {
    if (!state.examActive || !state.timerRunning || state.disqualified) return;
    if (document.hidden) {
      registerViolation('You switched tabs or minimized the window.');
    }
  });

  // 2. Window blur — catches cases visibilitychange sometimes misses,
  //    such as a native browser dropdown, OS task switcher, or a
  //    second monitor / application receiving focus while this tab
  //    technically stays "visible".
  window.addEventListener('blur', () => {
    if (!state.examActive || !state.timerRunning || state.disqualified) return;
    registerViolation('The exam window lost focus.');
  });

  // =====================================================================
  // VIOLATION REGISTRATION (with debounce + grace period to avoid
  // double-counting and to avoid counting non-cheating fullscreen noise)
  // =====================================================================
  function registerViolation(reason) {
    if (state.disqualified) return;
    if (!state.examActive || !state.timerRunning) return;

    const now = Date.now();

    // Ignore anything that happens right after a fullscreen transition —
    // this is the fix for violations firing before the exam has really
    // started, or before the student did anything wrong.
    if (now < state.graceUntil) return;

    if (now - state.lastViolationTimestamp < state.VIOLATION_DEBOUNCE_MS) {
      // Same physical event already triggered a violation (e.g. blur +
      // visibilitychange firing together) — ignore this duplicate.
      return;
    }
    state.lastViolationTimestamp = now;

    state.violationCount += 1;
    updateViolationDisplay();
    logViolationToServer(reason);
    updateSubmissionRecord({ violations: state.violationCount });

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
        // handleFullscreenChange will also refresh this, but set it here
        // too as a safety net in case that event is ever delayed.
        state.graceUntil = Date.now() + CONFIG.GRACE_PERIOD_MS;
      } catch (err) {
        // If re-entering fullscreen fails, keep the student blocked
        // until they succeed — do not silently continue unlocked.
        registerViolation('Could not re-establish full-screen mode.');
      }
    } else {
      // Already fullscreen — still grant a short grace window so the
      // click/focus-return itself isn't mistaken for another violation.
      state.graceUntil = Date.now() + CONFIG.GRACE_PERIOD_MS;
    }
  });

  // =====================================================================
  // TIMER
  // =====================================================================
  function startTimer() {
    state.secondsRemaining = CONFIG.EXAM_DURATION_SECONDS;
    state.timerRunning = true;
    renderTimer();

    state.timerInterval = setInterval(() => {
      if (state.disqualified) {
        clearInterval(state.timerInterval);
        state.timerRunning = false;
        return;
      }
      state.secondsRemaining -= 1;
      renderTimer();

      if (state.secondsRemaining <= 0) {
        clearInterval(state.timerInterval);
        state.timerRunning = false;
        finalizeSession(
          'Time Expired',
          "Time's Up",
          'Your allotted exam time has ended.',
          '&#9203;'
        );
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
  // SESSION ENDINGS: COMPLETED (student-confirmed) / TIME EXPIRED
  // Shares logic with disqualifyStudent() below but is a non-punitive
  // ending — used for the two ways a session can end honestly.
  // =====================================================================
  function finalizeSession(status, title, subtitle, iconHtml) {
    if (state.disqualified || !state.examActive) return;

    state.examActive = false;
    state.timerRunning = false;
    clearInterval(state.timerInterval);

    updateSubmissionRecord({ status, endTime: Date.now(), violations: state.violationCount });

    if (el.iframe && el.iframe.parentNode) {
      el.iframe.parentNode.removeChild(el.iframe);
    }
    el.overlay.hidden = true;
    exitFullscreen();
    document.body.classList.remove('lockdown-active');

    el.seIcon.innerHTML = iconHtml;
    el.seTitle.textContent = title;
    el.seSubtitle.textContent = subtitle;
    el.seName.textContent = state.studentName;
    el.seCount.textContent = String(state.violationCount);
    el.seTime.textContent = new Date().toLocaleString();

    showScreen(el.sessionEndedScreen);
  }

  // The only way this app can know a student believes they've submitted
  // the Google Form — since the form lives in a cross-origin iframe, we
  // cannot detect the real submission event from here (see note above
  // SUBMISSIONS MONITORING). This button captures the student's explicit
  // claim instead, which is at least an honest, auditable signal.
  el.submitExamBtn.addEventListener('click', () => {
    if (!state.examActive || state.disqualified) return;
    const confirmed = window.confirm(
      "Confirm you've submitted the Google Form. This will end your proctored session and cannot be undone."
    );
    if (!confirmed) return;
    finalizeSession('Completed', 'Exam Submitted', 'Your exam session has ended. Thank you.', '&#9989;');
  });

  // =====================================================================
  // DISQUALIFICATION (permanent, irreversible for this session)
  // =====================================================================
  function disqualifyStudent() {
    state.disqualified = true;
    state.examActive = false;
    state.timerRunning = false;

    clearInterval(state.timerInterval);

    updateSubmissionRecord({
      status: 'Disqualified',
      endTime: Date.now(),
      violations: state.violationCount,
    });

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
