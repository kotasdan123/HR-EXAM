/**
 * =====================================================================
 * SECURE EXAMINATION PORTAL — CORE APPLICATION LOGIC
 * =====================================================================
 *
 * ARCHITECTURE NOTE (read first):
 * This is a FRONTEND-ONLY PROTOTYPE. All data (users, exams, attempts,
 * violations) lives in the browser's localStorage. That means:
 *   - Anyone with DevTools access to this browser profile can read or
 *     edit every account, password, exam, and result.
 *   - There is no real server enforcing the 6-exam limit, the one-
 *     attempt lock, or anti-cheat — a sufficiently determined user with
 *     DevTools could edit localStorage directly and bypass all of it.
 *   - Passwords are stored in PLAIN TEXT here. Never do this in a real
 *     deployment.
 * For production you would replace loadState()/saveState() and
 * authenticateUser() with calls to a real backend (REST API + database
 * + hashed passwords + server-side session + server-side enforcement
 * of every rule in this file). Everything below is structured so that
 * swap is mostly a matter of replacing these specific functions.
 *
 * ANTI-CHEAT DISCLAIMER:
 * No client-side script can fully prevent someone from using a second
 * device, an external phone, OS-level screenshots, or another computer
 * entirely. What this app does — and all any browser-based system can
 * honestly do — is DETECT common in-browser cheating patterns (tab
 * switches, lost window focus, exiting fullscreen) and respond with
 * logging + escalating penalties. We call this "Anti-Cheat Monitoring",
 * not "cheat-proof".
 * =====================================================================
 */

(() => {
  'use strict';

  // ===================================================================
  // CONSTANTS
  // ===================================================================
  const DB_KEY = 'sep_db_v2';
  const THEME_KEY = 'sep_theme';
  const SESSION_KEY = 'sep_session';
  const MAX_EXAMS_PER_ADMIN = 6;
  const VIOLATION_DEBOUNCE_MS = 500;
  const GRACE_PERIOD_MS = 1200; // see registerViolation() for why

  // ===================================================================
  // DATA MODEL / PERSISTENCE
  // ===================================================================
  function seedDefaultDB() {
    return {
      users: [
        // Default seeded accounts — CHANGE OR REMOVE before deploying.
        { id: 1, username: 'admin', password: '123admin', role: 'admin' },
        { id: 2, username: 'test', password: 'test', role: 'examiner' },
      ],
      exams: [],
      attempts: [],
      violations: [],
      settings: {
        theme: 'dark',
        defaultAntiCheat: true,
        sessionTimeoutMinutes: 60,
        portalName: 'Secure Examination Portal',
      },
      nextIds: { user: 3, exam: 1, attempt: 1, violation: 1 },
    };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(DB_KEY);
      if (!raw) return seedDefaultDB();
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.users)) return seedDefaultDB();

      // Defensive repair in case of partial/corrupted data from an
      // earlier version of this app.
      parsed.exams = Array.isArray(parsed.exams) ? parsed.exams : [];
      parsed.attempts = Array.isArray(parsed.attempts) ? parsed.attempts : [];
      parsed.violations = Array.isArray(parsed.violations) ? parsed.violations : [];
      parsed.settings = parsed.settings || seedDefaultDB().settings;
      parsed.nextIds = parsed.nextIds || seedDefaultDB().nextIds;
      if (!parsed.users.some((u) => u.username === 'admin')) {
        parsed.users.push({ id: parsed.nextIds.user++, username: 'admin', password: '123admin', role: 'admin' });
      }
      if (!parsed.users.some((u) => u.username === 'test')) {
        parsed.users.push({ id: parsed.nextIds.user++, username: 'test', password: 'test', role: 'examiner' });
      }
      return parsed;
    } catch (err) {
      console.error('Failed to load state, reseeding.', err);
      return seedDefaultDB();
    }
  }

  function saveState() {
    try {
      localStorage.setItem(DB_KEY, JSON.stringify(db));
    } catch (err) {
      console.error('Failed to save state', err);
      toast('Warning: could not save data locally (storage full or blocked).');
    }
  }

  const db = loadState();

  // ===================================================================
  // SESSION (in-memory runtime state — not the same as auth session)
  // ===================================================================
  const session = {
    currentUser: null, // { username, role }
    adminPage: 'dashboard',
    editingExamId: null,
    filters: { search: '', exam: '', status: '', date: '' },

    // Active exam-taking runtime state
    exam: null,
    attemptId: null,
    violationCount: 0,
    examActive: false,
    timerRunning: false,
    disqualified: false,
    timerInterval: null,
    secondsRemaining: 0,
    graceUntil: 0,
    lastViolationTimestamp: 0,
  };

  // ===================================================================
  // UTILITIES
  // ===================================================================
  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
  function escapeAttr(str) {
    return escapeHtml(str).replace(/"/g, '&quot;');
  }
  function formatDateTime(ts) {
    return ts ? new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
  }
  function formatDateOnly(iso) {
    return iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
  }
  function formatDateRange(from, until) {
    if (!from && !until) return 'Always available';
    return `${formatDateOnly(from)} – ${formatDateOnly(until)}`;
  }
  function toLocalDateTimeInput(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function toast(msg) {
    const container = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => {
      el.classList.add('fade-out');
      setTimeout(() => el.remove(), 250);
    }, 3200);
  }
  function statusBadgeClass(status) {
    const map = {
      Active: 'completed', Available: 'completed', Completed: 'completed',
      Inactive: '', Scheduled: 'in-progress', Upcoming: 'in-progress', 'In Progress': 'in-progress',
      Expired: 'time-expired', 'Time Expired': 'time-expired', Disqualified: 'disqualified',
    };
    return map[status] || '';
  }
  function statusBadge(status) {
    return `<span class="status-badge ${statusBadgeClass(status)}">${escapeHtml(status)}</span>`;
  }

  // ===================================================================
  // AUTH
  // In production: replace with a real API call; never compare
  // plaintext passwords client-side.
  // ===================================================================
  function authenticateUser(username, password) {
    return db.users.find((u) => u.username === username && u.password === password) || null;
  }

  function login(user, remember) {
    session.currentUser = { username: user.username, role: user.role };
    const payload = JSON.stringify(session.currentUser);
    if (remember) {
      localStorage.setItem(SESSION_KEY, payload);
      sessionStorage.removeItem(SESSION_KEY);
    } else {
      sessionStorage.setItem(SESSION_KEY, payload);
      localStorage.removeItem(SESSION_KEY);
    }
    routeAfterLogin();
  }

  function logout() {
    session.currentUser = null;
    localStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(SESSION_KEY);
    document.getElementById('login-form').reset();
    document.getElementById('login-error').hidden = true;
    showScreen('login-screen');
  }

  function restoreSession() {
    const raw = sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY);
    if (!raw) return false;
    try {
      const parsed = JSON.parse(raw);
      const user = db.users.find((u) => u.username === parsed.username && u.role === parsed.role);
      if (!user) return false;
      session.currentUser = { username: user.username, role: user.role };
      return true;
    } catch (err) {
      return false;
    }
  }

  // Defensive role guard. In a real multi-page app this would be a
  // server-checked route guard; here it just prevents an internal
  // render function from ever being shown to the wrong role.
  function requireRole(role) {
    if (!session.currentUser || session.currentUser.role !== role) {
      logout();
      return false;
    }
    return true;
  }

  // ===================================================================
  // EXAM CRUD
  // ===================================================================
  function isValidGoogleFormUrl(url) {
    return typeof url === 'string' && /docs\.google\.com\/forms/i.test(url);
  }

  function normalizeGoogleFormUrl(url) {
    try {
      const u = new URL(url.trim());
      u.searchParams.set('embedded', 'true');
      return u.toString();
    } catch (err) {
      return url.trim();
    }
  }

  function upsertExaminerAccount(username, password) {
    let user = db.users.find((u) => u.username === username);
    if (user) {
      user.password = password;
      user.role = 'examiner';
    } else {
      db.users.push({ id: db.nextIds.user++, username, password, role: 'examiner' });
    }
  }

  function getExamById(id) {
    return db.exams.find((e) => e.id === id);
  }
  function getExamsByAdmin(adminUsername) {
    return db.exams.filter((e) => e.adminUsername === adminUsername);
  }

  function validateExamData(data) {
    if (!data.name || !data.name.trim()) return 'Exam name is required.';
    if (!data.googleFormUrl || !data.googleFormUrl.trim()) return 'Google Forms URL is required.';
    if (!isValidGoogleFormUrl(data.googleFormUrl)) return 'Invalid Google Forms URL.';
    if (!data.examinerUsername || !data.examinerUsername.trim()) return 'Examiner username is required.';
    if (!data.examinerPassword) return 'Examiner credentials are required.';
    if (data.timerEnabled && (!data.duration || parseInt(data.duration, 10) < 1)) return 'Please enter a valid duration.';
    if (data.antiCheatEnabled && (!data.maxViolations || parseInt(data.maxViolations, 10) < 1)) return 'Please enter a valid maximum violations value.';
    return null;
  }

  function createExam(data) {
    const adminUsername = session.currentUser.username;
    if (getExamsByAdmin(adminUsername).length >= MAX_EXAMS_PER_ADMIN) {
      return { ok: false, error: `You have reached the maximum limit of ${MAX_EXAMS_PER_ADMIN} exams for this admin account.` };
    }
    const error = validateExamData(data);
    if (error) return { ok: false, error };

    upsertExaminerAccount(data.examinerUsername.trim(), data.examinerPassword);

    const exam = {
      id: db.nextIds.exam++,
      adminUsername,
      name: data.name.trim(),
      description: (data.description || '').trim(),
      googleFormUrl: normalizeGoogleFormUrl(data.googleFormUrl),
      examinerUsername: data.examinerUsername.trim(),
      examinerPassword: data.examinerPassword,
      timerEnabled: !!data.timerEnabled,
      duration: data.timerEnabled ? Math.max(1, parseInt(data.duration, 10) || 60) : null,
      antiCheatEnabled: !!data.antiCheatEnabled,
      maxViolations: data.antiCheatEnabled ? Math.max(1, parseInt(data.maxViolations, 10) || 3) : null,
      availableFrom: data.availableFrom || null,
      availableUntil: data.availableUntil || null,
      active: true,
      createdAt: Date.now(),
    };
    db.exams.push(exam);
    saveState();
    return { ok: true, exam };
  }

  function updateExam(id, data) {
    const exam = getExamById(id);
    if (!exam) return { ok: false, error: 'Exam not found.' };
    const error = validateExamData(data);
    if (error) return { ok: false, error };

    upsertExaminerAccount(data.examinerUsername.trim(), data.examinerPassword);

    exam.name = data.name.trim();
    exam.description = (data.description || '').trim();
    exam.googleFormUrl = normalizeGoogleFormUrl(data.googleFormUrl);
    exam.examinerUsername = data.examinerUsername.trim();
    exam.examinerPassword = data.examinerPassword;
    exam.timerEnabled = !!data.timerEnabled;
    exam.duration = data.timerEnabled ? Math.max(1, parseInt(data.duration, 10) || 60) : null;
    exam.antiCheatEnabled = !!data.antiCheatEnabled;
    exam.maxViolations = data.antiCheatEnabled ? Math.max(1, parseInt(data.maxViolations, 10) || 3) : null;
    exam.availableFrom = data.availableFrom || null;
    exam.availableUntil = data.availableUntil || null;
    if (typeof data.active === 'boolean') exam.active = data.active;
    // Note: we intentionally never touch exam.id, adminUsername, createdAt,
    // or any existing attempts/violations — editing an exam must not
    // corrupt historical submission records (per spec section 11).
    saveState();
    return { ok: true, exam };
  }

  function deleteExam(id) {
    db.exams = db.exams.filter((e) => e.id !== id);
    // Historical attempts/violations are kept for audit purposes even
    // after the exam is deleted; tables fall back to "(deleted exam)".
    saveState();
  }

  function toggleExamActive(id) {
    const exam = getExamById(id);
    if (!exam) return;
    exam.active = !exam.active;
    saveState();
  }

  function computeAdminExamStatus(exam) {
    if (!exam.active) return 'Inactive';
    const now = Date.now();
    const from = exam.availableFrom ? new Date(exam.availableFrom).getTime() : null;
    const until = exam.availableUntil ? new Date(exam.availableUntil).getTime() : null;
    if (from && now < from) return 'Scheduled';
    if (until && now > until) return 'Expired';
    return 'Active';
  }

  // ===================================================================
  // ATTEMPTS
  // ===================================================================
  function getAttemptById(id) {
    return db.attempts.find((a) => a.id === id);
  }
  function getAttemptsForExam(examId) {
    return db.attempts.filter((a) => a.examId === examId);
  }
  function getAttemptsForExamAndUser(examId, username) {
    return db.attempts.filter((a) => a.examId === examId && a.examinerUsername === username);
  }

  function startAttemptRecord(examId, username) {
    const attempt = {
      id: db.nextIds.attempt++,
      examId,
      examinerUsername: username,
      startedAt: Date.now(),
      submittedAt: null,
      status: 'In Progress',
      violations: 0,
      violationLogs: [],
    };
    db.attempts.push(attempt);
    saveState();
    return attempt;
  }

  function updateAttemptRecord(id, patch) {
    const a = getAttemptById(id);
    if (!a) return;
    Object.assign(a, patch);
    saveState();
  }

  // Combines exam config + attempt history into what the examiner should
  // see/be allowed to do for a given exam.
  function computeExaminerExamView(exam, username) {
    const attempts = getAttemptsForExamAndUser(exam.id, username);
    const finalAttempt = attempts.find((a) => a.status !== 'In Progress');
    if (finalAttempt) return { status: finalAttempt.status, locked: true, attempt: finalAttempt };

    const inProgress = attempts.find((a) => a.status === 'In Progress');
    if (inProgress) {
      // A frontend-only limitation: we don't support resuming an
      // in-progress attempt after a refresh/close in this prototype.
      // A production build would restore full exam state from the
      // backend session instead of blocking the exam here.
      return { status: 'In Progress', locked: true, attempt: inProgress };
    }

    const adminStatus = computeAdminExamStatus(exam);
    if (adminStatus === 'Inactive') return { status: 'Inactive', locked: true };
    if (adminStatus === 'Scheduled') return { status: 'Upcoming', locked: true };
    if (adminStatus === 'Expired') return { status: 'Expired', locked: true };
    return { status: 'Available', locked: false };
  }

  // ===================================================================
  // VIOLATIONS + ANTI-CHEAT
  // ===================================================================
  function examLockdownActive() {
    return session.examActive && !!session.exam && session.exam.antiCheatEnabled;
  }

  function registerViolation(reason) {
    if (session.disqualified || !session.examActive) return;
    if (!session.exam || !session.exam.antiCheatEnabled) return;

    const now = Date.now();

    // GRACE PERIOD: ignore anything right after a fullscreen transition.
    // Entering/re-entering fullscreen can itself trigger a spurious
    // blur/visibilitychange on some browser/OS combinations — without
    // this, that transition gets mistaken for a real violation before
    // the examinee has done anything wrong.
    if (now < session.graceUntil) return;

    // DEBOUNCE: a single tab-switch can fire both `blur` and
    // `visibilitychange` — only count it once.
    if (now - session.lastViolationTimestamp < VIOLATION_DEBOUNCE_MS) return;
    session.lastViolationTimestamp = now;

    session.violationCount += 1;

    const attempt = getAttemptById(session.attemptId);
    const entry = { reason, timestamp: Date.now(), violationNumber: session.violationCount };
    if (attempt) {
      attempt.violationLogs.push(entry);
      attempt.violations = session.violationCount;
    }
    db.violations.push({
      id: db.nextIds.violation++,
      attemptId: session.attemptId,
      examId: session.exam.id,
      examinerUsername: session.currentUser.username,
      reason,
      timestamp: Date.now(),
      violationNumber: session.violationCount,
    });
    saveState();
    updateExamHeaderViolationUI();

    if (session.violationCount >= session.exam.maxViolations) {
      session.disqualified = true;
      endExamSession('Disqualified', 'Exam Terminated', 'You have exceeded the maximum number of allowed violations.', '&#9940;');
      return;
    }
    showViolationOverlay(reason);
  }

  function enterFullscreen(elem) {
    const request = elem.requestFullscreen || elem.webkitRequestFullscreen || elem.mozRequestFullScreen || elem.msRequestFullscreen;
    if (!request) return Promise.reject(new Error('Fullscreen API not supported'));
    return request.call(elem);
  }
  function exitFullscreen() {
    const exit = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen;
    if (exit && isCurrentlyFullscreen()) exit.call(document).catch(() => {});
  }
  function isCurrentlyFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
  }

  ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'].forEach((evt) =>
    document.addEventListener(evt, handleFullscreenChange)
  );

  function handleFullscreenChange() {
    if (!examLockdownActive()) return;
    if (isCurrentlyFullscreen()) {
      session.graceUntil = Date.now() + GRACE_PERIOD_MS;
      return;
    }
    registerViolation('Fullscreen exited');
  }

  document.addEventListener('visibilitychange', () => {
    if (!examLockdownActive()) return;
    if (document.hidden) registerViolation('Tab switched or window minimized');
  });

  window.addEventListener('blur', () => {
    if (!examLockdownActive()) return;
    registerViolation('Window lost focus');
  });

  document.addEventListener('contextmenu', (e) => { if (examLockdownActive()) e.preventDefault(); });
  document.addEventListener('selectstart', (e) => { if (examLockdownActive()) e.preventDefault(); });
  ['copy', 'cut', 'paste'].forEach((evt) => document.addEventListener(evt, (e) => { if (examLockdownActive()) e.preventDefault(); }));

  document.addEventListener('keydown', (e) => {
    if (!examLockdownActive()) return;
    const key = e.key ? e.key.toLowerCase() : '';
    const ctrlOrCmd = e.ctrlKey || e.metaKey;
    const isDevTools = key === 'f12' || (ctrlOrCmd && e.shiftKey && ['i', 'c', 'j'].includes(key)) || (e.metaKey && e.altKey && key === 'i');
    const isNewTabOrWindow = (ctrlOrCmd && key === 't') || (ctrlOrCmd && key === 'n') || (ctrlOrCmd && key === 'w');
    const isViewSource = ctrlOrCmd && key === 'u';
    if (isDevTools || isNewTabOrWindow || isViewSource) {
      e.preventDefault();
      e.stopPropagation();
      registerViolation(`Attempted restricted shortcut (${key.toUpperCase()})`);
    }
  });

  window.addEventListener('beforeunload', (e) => {
    // NOTE: this can prompt the browser's native "leave site?" dialog,
    // but it cannot actually stop the tab from closing — browsers
    // deliberately don't let pages block navigation outright.
    if (session.examActive && !session.disqualified) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // ===================================================================
  // TIMER
  // ===================================================================
  function startTimer() {
    const timerBlock = document.getElementById('taking-timer-block');
    if (!session.exam.timerEnabled) {
      timerBlock.querySelector('.value').textContent = 'No Time Limit';
      session.timerRunning = false;
      return;
    }
    session.secondsRemaining = session.exam.duration * 60;
    session.timerRunning = true;
    renderTimer();
    session.timerInterval = setInterval(() => {
      if (session.disqualified || !session.examActive) {
        clearInterval(session.timerInterval);
        session.timerRunning = false;
        return;
      }
      session.secondsRemaining -= 1;
      renderTimer();
      if (session.secondsRemaining <= 0) {
        clearInterval(session.timerInterval);
        session.timerRunning = false;
        endExamSession('Time Expired', "Time's Up", 'Your allotted exam time has ended and your attempt has been recorded.', '&#9203;');
      }
    }, 1000);
  }
  function stopTimer() {
    clearInterval(session.timerInterval);
    session.timerRunning = false;
  }
  function renderTimer() {
    const minutes = Math.floor(session.secondsRemaining / 60).toString().padStart(2, '0');
    const seconds = (session.secondsRemaining % 60).toString().padStart(2, '0');
    document.querySelector('#taking-timer-block .value').textContent = `${minutes}:${seconds}`;
  }

  // ===================================================================
  // EXAM TAKING FLOW
  // ===================================================================
  function requestStartExam(examId) {
    const exam = getExamById(examId);
    const user = session.currentUser;
    if (!exam || exam.examinerUsername !== user.username) {
      toast('Unable to start exam.');
      return;
    }
    const view = computeExaminerExamView(exam, user.username);
    if (view.locked) {
      if (view.status === 'Completed' || view.status === 'Time Expired' || view.status === 'Disqualified') {
        toast('This exam has already been completed.');
      } else {
        toast('Exam is not currently available.');
      }
      return;
    }
    openInstructionsModal(exam);
  }

  async function confirmStartExam(examId) {
    const exam = getExamById(examId);
    if (!exam) { closeModal(); return; }
    closeModal();

    if (exam.antiCheatEnabled) {
      try {
        await enterFullscreen(document.documentElement);
      } catch (err) {
        toast('Full-screen mode is required to begin this exam. Please allow full-screen and try again.');
        return;
      }
    }
    beginExam(exam);
  }

  function beginExam(exam) {
    const attempt = startAttemptRecord(exam.id, session.currentUser.username);
    session.exam = exam;
    session.attemptId = attempt.id;
    session.violationCount = 0;
    session.examActive = true;
    session.disqualified = false;
    // Grace period starts immediately — the fullscreen transition that
    // may have *just* happened shouldn't count as a violation either.
    session.graceUntil = Date.now() + GRACE_PERIOD_MS;

    renderExamTakingScreen(exam);
    document.body.classList.toggle('lockdown-active', exam.antiCheatEnabled);
    startTimer();
    showScreen('exam-taking-screen');
  }

  function renderExamTakingScreen(exam) {
    document.getElementById('taking-exam-name').textContent = exam.name;
    document.getElementById('taking-violations-block').style.display = exam.antiCheatEnabled ? '' : 'none';
    const tracker = document.getElementById('taking-violation-tracker');
    tracker.textContent = `0 / ${exam.maxViolations}`;
    tracker.classList.remove('warning', 'critical');
    document.getElementById('exam-iframe').src = exam.googleFormUrl;
  }

  function updateExamHeaderViolationUI() {
    const el = document.getElementById('taking-violation-tracker');
    el.textContent = `${session.violationCount} / ${session.exam.maxViolations}`;
    el.classList.remove('warning', 'critical');
    if (session.violationCount === session.exam.maxViolations - 1) el.classList.add('warning');
    else if (session.violationCount >= session.exam.maxViolations) el.classList.add('critical');
  }

  function showViolationOverlay(reason) {
    document.getElementById('violation-reason').textContent = reason;
    document.getElementById('overlay-violation-count').textContent = String(session.violationCount);
    document.getElementById('overlay-max-violations').textContent = String(session.exam.maxViolations);
    document.getElementById('violation-overlay').hidden = false;
    document.getElementById('form-container').classList.add('blurred');
  }
  function hideViolationOverlay() {
    document.getElementById('violation-overlay').hidden = true;
    document.getElementById('form-container').classList.remove('blurred');
  }

  async function resumeFromViolation() {
    hideViolationOverlay();
    if (!session.examActive || session.disqualified) return;
    if (session.exam.antiCheatEnabled && !isCurrentlyFullscreen()) {
      try {
        await enterFullscreen(document.documentElement);
        session.graceUntil = Date.now() + GRACE_PERIOD_MS;
      } catch (err) {
        registerViolation('Could not re-establish full-screen mode');
      }
    } else {
      session.graceUntil = Date.now() + GRACE_PERIOD_MS;
    }
  }

  // GOOGLE FORMS LIMITATION: this iframe is cross-origin, so we cannot
  // detect the real "form submitted" event inside it. The Submit Exam
  // button is the examinee's explicit, auditable claim that they're done
  // — it's the strongest signal a browser-only app can honestly capture.
  function openSubmitConfirmModal() {
    openModal('Submit Exam?', `
      <p>Please make sure you have already submitted your Google Form.</p>
      <div class="modal-actions">
        <button type="button" class="secondary-btn" data-action="close-modal">Cancel</button>
        <button type="button" class="primary-btn" data-action="confirm-submit-exam">Submit Exam</button>
      </div>
    `);
  }

  function endExamSession(status, title, subtitle, iconHtml) {
    if (!session.examActive) return;
    session.examActive = false;
    stopTimer();

    updateAttemptRecord(session.attemptId, { status, submittedAt: Date.now(), violations: session.violationCount });

    const iframe = document.getElementById('exam-iframe');
    if (iframe) iframe.src = 'about:blank';

    hideViolationOverlay();
    exitFullscreen();
    document.body.classList.remove('lockdown-active');

    renderSessionResultScreen(status, title, subtitle, iconHtml);
    showScreen('session-result-screen');
  }

  function renderSessionResultScreen(status, title, subtitle, iconHtml) {
    document.getElementById('sr-icon').innerHTML = iconHtml;
    document.getElementById('sr-title').textContent = title;
    document.getElementById('sr-subtitle').textContent = subtitle;
    document.getElementById('sr-exam-name').textContent = session.exam ? session.exam.name : '—';
    document.getElementById('sr-status').innerHTML = statusBadge(status);
    document.getElementById('sr-violations').textContent = String(session.violationCount);
    document.getElementById('sr-time').textContent = new Date().toLocaleString();
    document.getElementById('session-result-screen').classList.toggle('terminated', status === 'Disqualified');
  }

  // ===================================================================
  // MODALS
  // ===================================================================
  function openModal(title, bodyHtml) {
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').innerHTML = bodyHtml;
    document.getElementById('modal-root').hidden = false;
  }
  function closeModal() {
    document.getElementById('modal-root').hidden = true;
    document.getElementById('modal-body').innerHTML = '';
    session.editingExamId = null;
  }

  function openInstructionsModal(exam) {
    const rules = [
      'Make sure you have a stable internet connection.',
      exam.antiCheatEnabled ? 'The exam will run in fullscreen mode.' : null,
      exam.antiCheatEnabled ? 'Switching tabs may count as a violation.' : null,
      exam.antiCheatEnabled ? 'Exiting fullscreen may count as a violation.' : null,
      'You have only one attempt.',
      exam.timerEnabled ? 'The exam will automatically end when the timer expires.' : 'This exam has no time limit.',
      'Make sure you submit your Google Form before ending the exam.',
    ].filter(Boolean);

    openModal('Before You Begin', `
      <ul class="rules-list">${rules.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
      <div class="modal-actions">
        <button type="button" class="secondary-btn" data-action="close-modal">Cancel</button>
        <button type="button" class="primary-btn" data-action="confirm-start-exam" data-id="${exam.id}">Start Exam</button>
      </div>
    `);
  }

  function openDeleteConfirmModal(examId) {
    const exam = getExamById(examId);
    if (!exam) return;
    openModal('Delete Exam', `
      <p>Are you sure you want to delete <strong>${escapeHtml(exam.name)}</strong>?</p>
      <p class="text-dim-inline">This action cannot be undone.</p>
      <div class="modal-actions">
        <button type="button" class="secondary-btn" data-action="close-modal">Cancel</button>
        <button type="button" class="danger-btn" data-action="confirm-delete-exam" data-id="${examId}">Delete Exam</button>
      </div>
    `);
  }

  function openExamFormModal(examId) {
    session.editingExamId = examId || null;
    const exam = examId ? getExamById(examId) : null;
    const title = exam ? 'Edit Exam' : 'Add Exam';

    const body = `
      <form id="exam-form">
        <label for="ef-name">Exam Name</label>
        <input type="text" id="ef-name" value="${exam ? escapeAttr(exam.name) : ''}" placeholder="e.g. HR Certification Examination" required />

        <label for="ef-description">Exam Description (optional)</label>
        <textarea id="ef-description" rows="2" placeholder="Optional description">${exam ? escapeHtml(exam.description || '') : ''}</textarea>

        <label for="ef-form-url">Google Forms URL</label>
        <input type="text" id="ef-form-url" placeholder="https://docs.google.com/forms/d/e/FORM_ID/viewform" value="${exam ? escapeAttr(exam.googleFormUrl) : ''}" required />

        <div class="form-grid-2">
          <div>
            <label for="ef-examiner-username">Examiner Username</label>
            <input type="text" id="ef-examiner-username" value="${exam ? escapeAttr(exam.examinerUsername) : ''}" required />
          </div>
          <div>
            <label for="ef-examiner-password">Examiner Password</label>
            <input type="text" id="ef-examiner-password" value="${exam ? escapeAttr(exam.examinerPassword) : ''}" required />
          </div>
        </div>
        <p class="field-hint">Demo only: shown in plain text so you can hand it to the examiner. Never do this in production.</p>

        <label class="checkbox-label"><input type="checkbox" id="ef-timer-enabled" ${!exam || exam.timerEnabled ? 'checked' : ''} /> Enable Timer</label>
        <div id="ef-duration-wrap">
          <label for="ef-duration">Duration (minutes)</label>
          <input type="number" id="ef-duration" min="1" value="${exam && exam.duration ? exam.duration : 60}" />
        </div>

        <label class="checkbox-label"><input type="checkbox" id="ef-anticheat-enabled" ${!exam || exam.antiCheatEnabled ? 'checked' : ''} /> Enable Anti-Cheat</label>
        <div id="ef-maxviol-wrap">
          <label for="ef-max-violations">Maximum Violations Allowed</label>
          <input type="number" id="ef-max-violations" min="1" value="${exam && exam.maxViolations ? exam.maxViolations : 3}" />
          <p class="field-hint">The exam will be automatically terminated when the examiner reaches this violation limit.</p>
        </div>

        <div class="form-grid-2">
          <div>
            <label for="ef-available-from">Available From</label>
            <input type="datetime-local" id="ef-available-from" value="${exam ? toLocalDateTimeInput(exam.availableFrom) : ''}" />
          </div>
          <div>
            <label for="ef-available-until">Available Until</label>
            <input type="datetime-local" id="ef-available-until" value="${exam ? toLocalDateTimeInput(exam.availableUntil) : ''}" />
          </div>
        </div>
        <p class="field-hint">Leave both blank to make the exam available with no date restriction.</p>

        ${exam ? `<label class="checkbox-label"><input type="checkbox" id="ef-active" ${exam.active ? 'checked' : ''} /> Active</label>` : ''}

        <p id="exam-form-error" class="error-text" hidden></p>
        <div class="modal-actions">
          <button type="button" class="secondary-btn" data-action="close-modal">Cancel</button>
          <button type="submit" class="primary-btn">${exam ? 'Save Changes' : 'Create Exam'}</button>
        </div>
      </form>
    `;
    openModal(title, body);

    const updateConditional = () => {
      document.getElementById('ef-duration-wrap').style.display = document.getElementById('ef-timer-enabled').checked ? '' : 'none';
      document.getElementById('ef-maxviol-wrap').style.display = document.getElementById('ef-anticheat-enabled').checked ? '' : 'none';
    };
    document.getElementById('ef-timer-enabled').addEventListener('change', updateConditional);
    document.getElementById('ef-anticheat-enabled').addEventListener('change', updateConditional);
    updateConditional();
  }

  function handleExamFormSubmit() {
    const data = {
      name: document.getElementById('ef-name').value,
      description: document.getElementById('ef-description').value,
      googleFormUrl: document.getElementById('ef-form-url').value,
      examinerUsername: document.getElementById('ef-examiner-username').value,
      examinerPassword: document.getElementById('ef-examiner-password').value,
      timerEnabled: document.getElementById('ef-timer-enabled').checked,
      duration: document.getElementById('ef-duration').value,
      antiCheatEnabled: document.getElementById('ef-anticheat-enabled').checked,
      maxViolations: document.getElementById('ef-max-violations').value,
      availableFrom: document.getElementById('ef-available-from').value ? new Date(document.getElementById('ef-available-from').value).toISOString() : null,
      availableUntil: document.getElementById('ef-available-until').value ? new Date(document.getElementById('ef-available-until').value).toISOString() : null,
    };
    const activeCheckbox = document.getElementById('ef-active');
    if (activeCheckbox) data.active = activeCheckbox.checked;

    const result = session.editingExamId ? updateExam(session.editingExamId, data) : createExam(data);
    if (!result.ok) {
      const errEl = document.getElementById('exam-form-error');
      errEl.textContent = result.error;
      errEl.hidden = false;
      return;
    }
    const wasEditing = !!session.editingExamId;
    closeModal();
    renderAdminPage('exams');
    toast(wasEditing ? 'Exam updated successfully.' : 'Exam created successfully.');
  }

  // ===================================================================
  // RENDERING: SHARED
  // ===================================================================
  function showScreen(id) {
    document.querySelectorAll('.app-screen').forEach((s) => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
  }

  function statCard(label, value, variant) {
    return `<div class="stat-card"><span class="stat-value ${variant || ''}">${escapeHtml(value)}</span><span class="stat-label">${escapeHtml(label)}</span></div>`;
  }
  function progressRow(label, pct, cls) {
    return `<div class="progress-row"><span class="progress-label">${escapeHtml(label)} (${pct}%)</span><div class="progress-track"><div class="progress-fill fill-${cls}" style="width:${pct}%"></div></div></div>`;
  }
  function buildSubmissionsTable(attempts) {
    if (attempts.length === 0) return '<p class="empty-state">No exam submissions yet.</p>';
    const rows = attempts.map((a) => {
      const exam = getExamById(a.examId);
      return `<tr>
        <td>${escapeHtml(a.examinerUsername)}</td>
        <td>${escapeHtml(exam ? exam.name : '(deleted exam)')}</td>
        <td>${formatDateTime(a.startedAt)}</td>
        <td>${a.submittedAt ? formatDateTime(a.submittedAt) : '—'}</td>
        <td>${statusBadge(a.status)}</td>
        <td>${a.violations}</td>
      </tr>`;
    }).join('');
    return `<div class="table-wrapper"><table class="data-table">
      <thead><tr><th>Examiner</th><th>Exam</th><th>Started</th><th>Submitted</th><th>Status</th><th>Violations</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  }

  function applyPortalName() {
    const name = (db.settings && db.settings.portalName) || 'Secure Examination Portal';
    document.querySelectorAll('.portal-name').forEach((el) => { el.textContent = name; });
  }

  // ===================================================================
  // ROUTING
  // ===================================================================
  function routeAfterLogin() {
    const user = session.currentUser;
    if (!user) { showScreen('login-screen'); return; }

    showScreen('app-shell');
    document.getElementById('topbar-username').textContent = user.username;
    document.getElementById('topbar-role').textContent = user.role;
    document.getElementById('app-shell').classList.toggle('no-sidebar', user.role !== 'admin');
    document.getElementById('sidebar').hidden = user.role !== 'admin';

    if (user.role === 'admin') {
      renderAdminPage('dashboard');
    } else {
      renderExaminerDashboard();
    }
  }

  // ===================================================================
  // RENDERING: ADMIN
  // ===================================================================
  function renderAdminPage(page) {
    if (!requireRole('admin')) return;
    session.adminPage = page;
    document.querySelectorAll('#sidebar [data-page]').forEach((el) => el.classList.toggle('active', el.dataset.page === page));
    document.getElementById('sidebar').classList.remove('open'); // close mobile sidebar on nav

    const root = document.getElementById('page-content');
    if (page === 'dashboard') root.innerHTML = buildAdminDashboardHtml();
    else if (page === 'exams') root.innerHTML = buildAdminExamsHtml();
    else if (page === 'submissions') { root.innerHTML = buildAdminSubmissionsHtml(); attachSubmissionsFilterHandlers(); }
    else if (page === 'analytics') root.innerHTML = buildAdminAnalyticsHtml();
    else if (page === 'violations') root.innerHTML = buildAdminViolationsHtml();
    else if (page === 'settings') { root.innerHTML = buildAdminSettingsHtml(); attachSettingsHandlers(); }
  }

  function buildAdminDashboardHtml() {
    const adminUsername = session.currentUser.username;
    const exams = getExamsByAdmin(adminUsername);
    const examIds = exams.map((e) => e.id);
    const attempts = db.attempts.filter((a) => examIds.includes(a.examId));

    const totalExams = exams.length;
    const activeExams = exams.filter((e) => computeAdminExamStatus(e) === 'Active').length;
    const totalExaminers = new Set(exams.map((e) => e.examinerUsername)).size;
    const totalAttempts = attempts.length;
    const completed = attempts.filter((a) => a.status === 'Completed').length;
    const inProgress = attempts.filter((a) => a.status === 'In Progress').length;
    const disqualified = attempts.filter((a) => a.status === 'Disqualified').length;
    const expired = attempts.filter((a) => a.status === 'Time Expired').length;
    const totalViolations = attempts.reduce((s, a) => s + a.violations, 0);
    const pct = (n) => (totalAttempts ? Math.round((n / totalAttempts) * 100) : 0);
    const recent = [...attempts].sort((a, b) => b.startedAt - a.startedAt).slice(0, 8);

    if (totalExams === 0) {
      return `
        <h2>Dashboard</h2>
        <p class="empty-state">No exams have been created yet.</p>
        <button class="primary-btn inline-btn" data-action="open-add-exam">Create Your First Exam</button>
      `;
    }

    return `
      <h2>Dashboard</h2>
      <div class="stat-grid">
        ${statCard('Total Exams', totalExams)}
        ${statCard('Active Exams', activeExams)}
        ${statCard('Total Examiners', totalExaminers)}
        ${statCard('Total Submissions', totalAttempts)}
        ${statCard('Completed', completed, 'success')}
        ${statCard('In Progress', inProgress)}
        ${statCard('Disqualified', disqualified, 'danger')}
        ${statCard('Time Expired', expired, 'warning')}
        ${statCard('Total Violations', totalViolations)}
      </div>

      <h3>Exam Progress</h3>
      ${progressRow('Completed', pct(completed), 'completed')}
      ${progressRow('In Progress', pct(inProgress), 'progress')}
      ${progressRow('Disqualified', pct(disqualified), 'disqualified')}
      ${progressRow('Time Expired', pct(expired), 'expired')}

      <h3>Recent Submissions</h3>
      ${buildSubmissionsTable(recent)}
    `;
  }

  function buildExamCardAdmin(exam) {
    const status = computeAdminExamStatus(exam);
    const attempts = getAttemptsForExam(exam.id);
    const completedCount = attempts.filter((a) => a.status !== 'In Progress').length;
    return `
      <div class="exam-card">
        <div class="exam-card-header">
          <h3>${escapeHtml(exam.name)}</h3>
          ${statusBadge(status)}
        </div>
        ${exam.description ? `<p class="exam-desc">${escapeHtml(exam.description)}</p>` : ''}
        <ul class="exam-meta">
          <li>Duration: ${exam.timerEnabled ? `${exam.duration} minutes` : 'No time limit'}</li>
          <li>Anti-Cheat: ${exam.antiCheatEnabled ? 'Enabled' : 'Disabled'}</li>
          ${exam.antiCheatEnabled ? `<li>Max Violations: ${exam.maxViolations}</li>` : ''}
          <li>Available: ${formatDateRange(exam.availableFrom, exam.availableUntil)}</li>
          <li>Examiner: ${escapeHtml(exam.examinerUsername)}</li>
          <li>Submissions: ${completedCount} / ${attempts.length}</li>
        </ul>
        <div class="exam-card-actions">
          <button type="button" class="text-link" data-action="edit-exam" data-id="${exam.id}">Edit</button>
          <button type="button" class="text-link" data-action="toggle-active-exam" data-id="${exam.id}">${exam.active ? 'Deactivate' : 'Activate'}</button>
          <button type="button" class="text-link danger-link" data-action="delete-exam" data-id="${exam.id}">Delete</button>
        </div>
      </div>
    `;
  }

  function buildAdminExamsHtml() {
    const adminUsername = session.currentUser.username;
    const exams = getExamsByAdmin(adminUsername);
    const atLimit = exams.length >= MAX_EXAMS_PER_ADMIN;
    const cards = exams.length ? exams.map(buildExamCardAdmin).join('') : '<p class="empty-state">No exams have been created yet.</p>';
    return `
      <div class="page-header-row">
        <h2>Exams (${exams.length}/${MAX_EXAMS_PER_ADMIN})</h2>
        <button type="button" class="primary-btn inline-btn" data-action="open-add-exam" ${atLimit ? 'disabled' : ''}>+ Add Exam</button>
      </div>
      ${atLimit ? `<p class="limit-note">You have reached the maximum limit of ${MAX_EXAMS_PER_ADMIN} exams for this admin account.</p>` : ''}
      <div class="exam-grid">${cards}</div>
    `;
  }

  function buildAdminSubmissionsHtml() {
    const adminUsername = session.currentUser.username;
    const exams = getExamsByAdmin(adminUsername);
    const examIds = exams.map((e) => e.id);
    const allAttempts = db.attempts.filter((a) => examIds.includes(a.examId));
    return `
      <h2>Submissions</h2>
      <div class="filters-row">
        <input type="text" id="filter-search" placeholder="Search examiner..." value="${escapeAttr(session.filters.search)}" />
        <select id="filter-exam">
          <option value="">All Exams</option>
          ${exams.map((e) => `<option value="${e.id}" ${session.filters.exam === String(e.id) ? 'selected' : ''}>${escapeHtml(e.name)}</option>`).join('')}
        </select>
        <select id="filter-status">
          <option value="">All Statuses</option>
          ${['In Progress', 'Completed', 'Time Expired', 'Disqualified'].map((s) => `<option value="${s}" ${session.filters.status === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
        <input type="date" id="filter-date" value="${escapeAttr(session.filters.date)}" />
      </div>
      <div id="submissions-table-wrap">${buildSubmissionsTable(filterAttempts(allAttempts))}</div>
    `;
  }

  function filterAttempts(list) {
    return list.filter((a) => {
      if (session.filters.search && !a.examinerUsername.toLowerCase().includes(session.filters.search.toLowerCase())) return false;
      if (session.filters.exam && String(a.examId) !== session.filters.exam) return false;
      if (session.filters.status && a.status !== session.filters.status) return false;
      if (session.filters.date) {
        const d = new Date(a.startedAt).toISOString().slice(0, 10);
        if (d !== session.filters.date) return false;
      }
      return true;
    }).sort((a, b) => b.startedAt - a.startedAt);
  }

  function attachSubmissionsFilterHandlers() {
    const rerender = () => {
      session.filters.search = document.getElementById('filter-search').value;
      session.filters.exam = document.getElementById('filter-exam').value;
      session.filters.status = document.getElementById('filter-status').value;
      session.filters.date = document.getElementById('filter-date').value;
      const examIds = getExamsByAdmin(session.currentUser.username).map((e) => e.id);
      const allAttempts = db.attempts.filter((a) => examIds.includes(a.examId));
      document.getElementById('submissions-table-wrap').innerHTML = buildSubmissionsTable(filterAttempts(allAttempts));
    };
    ['filter-search', 'filter-exam', 'filter-status', 'filter-date'].forEach((id) => {
      document.getElementById(id).addEventListener('input', rerender);
      document.getElementById(id).addEventListener('change', rerender);
    });
  }

  function buildAdminAnalyticsHtml() {
    const adminUsername = session.currentUser.username;
    const exams = getExamsByAdmin(adminUsername);
    const examIds = exams.map((e) => e.id);
    const attempts = db.attempts.filter((a) => examIds.includes(a.examId));
    const total = attempts.length;
    const completed = attempts.filter((a) => a.status === 'Completed').length;
    const inProgress = attempts.filter((a) => a.status === 'In Progress').length;
    const expired = attempts.filter((a) => a.status === 'Time Expired').length;
    const disqualified = attempts.filter((a) => a.status === 'Disqualified').length;
    const totalViolations = attempts.reduce((s, a) => s + a.violations, 0);
    const avgViolations = total ? (totalViolations / total).toFixed(1) : '0.0';
    const pct = (n) => (total ? Math.round((n / total) * 100) : 0);

    const examPerfRows = exams.map((e) => {
      const eAttempts = attempts.filter((a) => a.examId === e.id);
      const c = eAttempts.filter((a) => a.status === 'Completed').length;
      const d = eAttempts.filter((a) => a.status === 'Disqualified').length;
      const av = eAttempts.length ? (eAttempts.reduce((s, a) => s + a.violations, 0) / eAttempts.length).toFixed(1) : '0.0';
      return `<tr><td>${escapeHtml(e.name)}</td><td>${eAttempts.length}</td><td>${c}</td><td>${d}</td><td>${av}</td></tr>`;
    }).join('');

    return `
      <h2>Analytics</h2>
      <div class="stat-grid">
        ${statCard('Total Exams', exams.length)}
        ${statCard('Total Attempts', total)}
        ${statCard('Completed', completed, 'success')}
        ${statCard('In Progress', inProgress)}
        ${statCard('Time Expired', expired, 'warning')}
        ${statCard('Disqualified', disqualified, 'danger')}
        ${statCard('Total Violations', totalViolations)}
        ${statCard('Avg. Violations/Attempt', avgViolations)}
      </div>
      <h3>Completion Rate</h3>
      ${progressRow('Completed', pct(completed), 'completed')}
      ${progressRow('Time Expired', pct(expired), 'expired')}
      ${progressRow('Disqualified', pct(disqualified), 'disqualified')}
      ${progressRow('In Progress', pct(inProgress), 'progress')}

      <h3>Exam Performance</h3>
      <div class="table-wrapper"><table class="data-table">
        <thead><tr><th>Exam Name</th><th>Attempts</th><th>Completed</th><th>Disqualified</th><th>Avg Violations</th></tr></thead>
        <tbody>${examPerfRows || '<tr><td colspan="5" class="empty-log">No data yet.</td></tr>'}</tbody>
      </table></div>
    `;
  }

  function buildAdminViolationsHtml() {
    const adminUsername = session.currentUser.username;
    const examIds = getExamsByAdmin(adminUsername).map((e) => e.id);
    const violations = db.violations.filter((v) => examIds.includes(v.examId)).sort((a, b) => b.timestamp - a.timestamp);
    if (violations.length === 0) return '<h2>Violation Logs</h2><p class="empty-state">No violations recorded.</p>';

    const rows = violations.map((v) => {
      const exam = getExamById(v.examId);
      const d = new Date(v.timestamp);
      const terminated = exam && v.violationNumber >= exam.maxViolations;
      return `<tr>
        <td>${d.toLocaleDateString()}</td>
        <td>${d.toLocaleTimeString()}</td>
        <td>${escapeHtml(v.examinerUsername)}</td>
        <td>${escapeHtml(exam ? exam.name : '(deleted exam)')}</td>
        <td>${v.violationNumber}</td>
        <td>${escapeHtml(v.reason)}</td>
        <td>${terminated ? '<span class="status-badge disqualified">Terminated</span>' : '<span class="status-badge time-expired">Warning</span>'}</td>
      </tr>`;
    }).join('');

    return `<h2>Violation Logs</h2><div class="table-wrapper"><table class="data-table">
      <thead><tr><th>Date</th><th>Time</th><th>Examiner</th><th>Exam</th><th>#</th><th>Reason</th><th>Action</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  }

  function buildAdminSettingsHtml() {
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
    return `
      <h2>Settings</h2>
      <h3>Appearance</h3>
      <label class="checkbox-label"><input type="radio" name="theme-setting" id="theme-dark" ${currentTheme === 'dark' ? 'checked' : ''} /> Dark Mode</label>
      <label class="checkbox-label"><input type="radio" name="theme-setting" id="theme-light" ${currentTheme === 'light' ? 'checked' : ''} /> Light Mode</label>

      <h3>Security</h3>
      <label class="checkbox-label"><input type="checkbox" id="setting-default-anticheat" ${db.settings.defaultAntiCheat ? 'checked' : ''} /> Default Anti-Cheat for new exams</label>
      <p class="field-hint">This only affects the default checkbox state when creating a new exam — it does not change exams you've already created.</p>

      <h3>Session</h3>
      <label for="setting-session-timeout">Session timeout (minutes)</label>
      <input type="number" id="setting-session-timeout" min="5" value="${db.settings.sessionTimeoutMinutes || 60}" />
      <p class="field-hint">Informational only in this frontend prototype — real session expiry requires a backend.</p>

      <h3>Application</h3>
      <label for="setting-portal-name">Portal Name</label>
      <input type="text" id="setting-portal-name" value="${escapeAttr(db.settings.portalName || 'Secure Examination Portal')}" />

      <button type="button" class="primary-btn inline-btn" id="save-settings-btn">Save Settings</button>
      <p id="settings-saved" class="success-text" hidden>Settings saved.</p>
    `;
  }

  function attachSettingsHandlers() {
    document.getElementById('save-settings-btn').addEventListener('click', () => {
      const theme = document.getElementById('theme-dark').checked ? 'dark' : 'light';
      db.settings.theme = theme;
      db.settings.defaultAntiCheat = document.getElementById('setting-default-anticheat').checked;
      db.settings.sessionTimeoutMinutes = parseInt(document.getElementById('setting-session-timeout').value, 10) || 60;
      db.settings.portalName = document.getElementById('setting-portal-name').value.trim() || 'Secure Examination Portal';
      saveState();
      applyTheme(theme);
      applyPortalName();
      document.getElementById('settings-saved').hidden = false;
      toast('Settings saved successfully.');
    });
  }

  // ===================================================================
  // RENDERING: EXAMINER
  // ===================================================================
  function renderExaminerDashboard() {
    if (!requireRole('examiner')) return;
    const username = session.currentUser.username;
    const myExams = db.exams.filter((e) => e.examinerUsername === username);
    const myAttempts = db.attempts.filter((a) => a.examinerUsername === username);
    const completed = myAttempts.filter((a) => a.status !== 'In Progress').length;
    const totalAssigned = myExams.length;
    const violationsTotal = myAttempts.reduce((s, a) => s + a.violations, 0);
    const pct = totalAssigned ? Math.round((completed / totalAssigned) * 100) : 0;
    const cards = myExams.length ? myExams.map((e) => buildExamCardExaminer(e, username)).join('') : '<p class="empty-state">No exams have been assigned to you yet.</p>';

    document.getElementById('page-content').innerHTML = `
      <h2>Welcome, ${escapeHtml(username)}</h2>
      <h3>Your Examination Progress</h3>
      <p>${completed} / ${totalAssigned} Completed</p>
      <div class="progress-track"><div class="progress-fill fill-completed" style="width:${pct}%"></div></div>
      <div class="stat-grid" style="margin-top:16px;">
        ${statCard('Completed', completed, 'success')}
        ${statCard('Remaining', Math.max(0, totalAssigned - completed))}
        ${statCard('Violations', violationsTotal, violationsTotal > 0 ? 'danger' : '')}
      </div>
      <h3 style="margin-top:32px;">Available Examinations</h3>
      <div class="exam-grid">${cards}</div>
    `;
  }

  function buildExamCardExaminer(exam, username) {
    const view = computeExaminerExamView(exam, username);
    let actionHtml;
    if (['Completed', 'Time Expired', 'Disqualified'].includes(view.status)) {
      actionHtml = '<button type="button" class="secondary-btn" disabled>Locked</button>';
    } else if (view.status === 'In Progress') {
      actionHtml = '<button type="button" class="secondary-btn" disabled>In Progress</button>';
    } else if (view.status === 'Available') {
      actionHtml = `<button type="button" class="primary-btn inline-btn" data-action="start-exam" data-id="${exam.id}">Start Exam</button>`;
    } else {
      actionHtml = `<button type="button" class="secondary-btn" disabled>${escapeHtml(view.status)}</button>`;
    }
    const doneMark = view.status === 'Completed' ? '<p class="done-mark">&#10003; Exam already taken</p>' : '';

    return `
      <div class="exam-card">
        <div class="exam-card-header">
          <h3>${escapeHtml(exam.name)}</h3>
          ${statusBadge(view.status)}
        </div>
        ${exam.description ? `<p class="exam-desc">${escapeHtml(exam.description)}</p>` : ''}
        <ul class="exam-meta">
          <li>Duration: ${exam.timerEnabled ? `${exam.duration} minutes` : 'No time limit'}</li>
          <li>Anti-Cheat: ${exam.antiCheatEnabled ? 'Enabled' : 'Disabled'}</li>
          <li>Available: ${formatDateRange(exam.availableFrom, exam.availableUntil)}</li>
        </ul>
        ${doneMark}
        <div class="exam-card-actions">${actionHtml}</div>
      </div>
    `;
  }

  // ===================================================================
  // THEME
  // ===================================================================
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(THEME_KEY, theme);
    document.querySelectorAll('.theme-toggle-label').forEach((el) => {
      el.textContent = theme === 'dark' ? '\u{1F319} Dark' : '\u2600\uFE0F Light';
    });
  }
  function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    applyTheme(current === 'dark' ? 'light' : 'dark');
  }
  function loadThemePreference() {
    const saved = localStorage.getItem(THEME_KEY) || (db.settings && db.settings.theme) || 'dark';
    applyTheme(saved);
  }

  // ===================================================================
  // EVENT DELEGATION
  // ===================================================================
  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('[data-action]');
    if (!trigger) return;
    const action = trigger.dataset.action;
    const id = trigger.dataset.id ? Number(trigger.dataset.id) : null;

    switch (action) {
      case 'nav': renderAdminPage(trigger.dataset.page); break;
      case 'logout': logout(); break;
      case 'toggle-theme': toggleTheme(); break;
      case 'toggle-sidebar': document.getElementById('sidebar').classList.toggle('open'); break;
      case 'open-add-exam': openExamFormModal(null); break;
      case 'edit-exam': openExamFormModal(id); break;
      case 'delete-exam': openDeleteConfirmModal(id); break;
      case 'confirm-delete-exam':
        deleteExam(id);
        closeModal();
        renderAdminPage('exams');
        toast('Exam deleted successfully.');
        break;
      case 'toggle-active-exam': toggleExamActive(id); renderAdminPage('exams'); break;
      case 'close-modal': closeModal(); break;
      case 'start-exam': requestStartExam(id); break;
      case 'confirm-start-exam': confirmStartExam(id); break;
      case 'open-submit-confirm': openSubmitConfirmModal(); break;
      case 'confirm-submit-exam':
        closeModal();
        endExamSession('Completed', 'Thank you for taking the exam!', 'Your examination has been successfully recorded.', '&#9989;');
        break;
      case 'back-to-dashboard': routeAfterLogin(); break;
      case 'resume-exam': resumeFromViolation(); break;
      case 'toggle-password': {
        const targetId = trigger.dataset.target;
        const input = document.getElementById(targetId);
        if (input) {
          input.type = input.type === 'password' ? 'text' : 'password';
          trigger.textContent = input.type === 'password' ? 'Show' : 'Hide';
        }
        break;
      }
      default: break;
    }
  });

  document.addEventListener('submit', (e) => {
    if (e.target.id === 'login-form') {
      e.preventDefault();
      handleLoginSubmit();
    } else if (e.target.id === 'exam-form') {
      e.preventDefault();
      handleExamFormSubmit();
    }
  });

  function handleLoginSubmit() {
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    const remember = document.getElementById('login-remember').checked;
    const errEl = document.getElementById('login-error');
    errEl.hidden = true;

    const user = authenticateUser(username, password);
    if (!user) {
      errEl.textContent = 'Invalid login credentials.';
      errEl.hidden = false;
      return;
    }
    login(user, remember);
  }

  // ===================================================================
  // INIT
  // ===================================================================
  loadThemePreference();
  applyPortalName();
  if (restoreSession()) {
    routeAfterLogin();
  } else {
    showScreen('login-screen');
  }
})();
