/* ================================================================
   PROCTOR+ SECURE EXAM PORTAL
   Complete app.js
   ================================================================

   IMPORTANT:
   This is a browser-only prototype.

   Client-side JavaScript cannot completely prevent:
   - Opening another browser tab
   - Switching applications/windows
   - Opening browser DevTools
   - Browser-level shortcuts

   This application detects and logs these events while an exam
   session is active and applies the configured violation limit.

   For production deployment, authentication, exam records,
   attempts, timers and violation logs should be moved to a
   server/database.

   Google Forms are cross-origin, so this portal cannot detect the
   actual Google Forms Submit button. The portal's "Submit Exam"
   button is the auditable end-of-session signal.
================================================================ */

(() => {
  'use strict';

  /* ================================================================
     CONFIGURATION
  ================================================================ */

  const KEY = 'secure_exam_portal_v2';
  const SESSION = 'secure_exam_session_v2';

  const DEFAULT_FORM =
    'https://docs.google.com/forms/d/e/1FAIpQLSf_PLACEHOLDER_FORM_ID/viewform?embedded=true';

  const MAX_EXAMS = 6;

  const seed = {
    users: [
      {
        id: 'u-admin',
        username: 'admin',
        password: '123admin',
        role: 'admin',
        name: 'Administrator'
      },
      {
        id: 'u-test',
        username: 'test',
        password: 'test',
        role: 'examiner',
        name: 'Test Examiner'
      }
    ],

    exams: [
      {
        id: 'exam-demo',
        title: 'Demo Examination',
        description:
          'Replace this Google Form with your actual examination link.',
        formUrl: DEFAULT_FORM,
        examinerUsername: 'test',
        examinerPassword: 'test',

        antiCheat: true,
        maxViolations: 3,

        timerEnabled: true,
        durationMinutes: 60,

        startAt: '',
        endAt: '',
        active: true,

        createdAt: Date.now(),
        createdBy: 'u-admin'
      }
    ],

    attempts: [],
    violations: [],
    theme: 'dark'
  };

  /* ================================================================
     STATE
  ================================================================ */

  let db = loadDB();
  let session = loadSession();

  let currentExam = null;
  let timer = null;
  let examState = null;

  let violationOverlayOpen = false;
  let graceUntil = 0;
  let lastViolation = 0;

  const DEBOUNCE = 650;
  const GRACE = 1800;

  /* ================================================================
     DOM HELPERS
  ================================================================ */

  const $ = selector => document.querySelector(selector);

  const $$ = selector => [...document.querySelectorAll(selector)];

  const views = {
    login: $('#login-view'),
    admin: $('#admin-view'),
    examiner: $('#examiner-view'),
    exam: $('#exam-view'),
    result: $('#result-view')
  };

  /* ================================================================
     GENERAL HELPERS
  ================================================================ */

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function uid(prefix = 'id') {
    return (
      prefix +
      '-' +
      Date.now().toString(36) +
      '-' +
      Math.random().toString(36).slice(2, 8)
    );
  }

  function esc(value = '') {
    return String(value).replace(
      /[&<>'"]/g,
      char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;'
      })[char]
    );
  }

  function boolSetting(value, fallback = false) {
    if (
      value === true ||
      value === 1 ||
      value === '1' ||
      value === 'true' ||
      value === 'on' ||
      value === 'yes'
    ) {
      return true;
    }

    if (
      value === false ||
      value === 0 ||
      value === '0' ||
      value === 'false' ||
      value === 'off' ||
      value === 'no' ||
      value === '' ||
      value == null
    ) {
      return false;
    }

    return fallback;
  }

  function fmtDate(timestamp) {
    if (!timestamp) return '—';

    return new Date(timestamp).toLocaleString([], {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function fmtDateOnly(timestamp) {
    if (!timestamp) return '—';

    return new Date(timestamp).toLocaleDateString([], {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  }

  function fmtTime(timestamp) {
    if (!timestamp) return '—';

    return new Date(timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function formatDuration(seconds) {
    seconds = Math.max(0, Math.round(Number(seconds) || 0));

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 0) {
      return (
        hours +
        'h ' +
        String(minutes).padStart(2, '0') +
        'm'
      );
    }

    if (minutes > 0) {
      return (
        minutes +
        'm ' +
        String(secs).padStart(2, '0') +
        's'
      );
    }

    return secs + 's';
  }

  function safeGet(storage, key) {
    try {
      return storage.getItem(key);
    } catch (error) {
      console.warn('Storage read failed:', error);
      return null;
    }
  }

  function safeSet(storage, key, value) {
    try {
      storage.setItem(key, value);
      return true;
    } catch (error) {
      console.warn('Storage write failed:', error);
      return false;
    }
  }

  function safeRemove(storage, key) {
    try {
      storage.removeItem(key);
    } catch (error) {
      console.warn('Storage remove failed:', error);
    }
  }

  /* ================================================================
     DATABASE
  ================================================================ */

  function loadDB() {
    let stored = {};

    try {
      const raw = safeGet(localStorage, KEY);

      if (raw) {
        try {
          stored = JSON.parse(raw) || {};
        } catch (error) {
          stored = {};
        }
      }
    } catch (error) {
      stored = {};
    }

    const users = Array.isArray(stored.users)
      ? stored.users
      : [];

    /* Always repair built-in accounts */
    seed.users.forEach(seedUser => {
      const existing = users.find(
        user =>
          String(user?.username || '')
            .trim()
            .toLowerCase() ===
          seedUser.username.toLowerCase()
      );

      if (!existing) {
        users.push(clone(seedUser));
      } else if (
        seedUser.username === 'admin' ||
        seedUser.username === 'test'
      ) {
        existing.username = seedUser.username;
        existing.password = seedUser.password;
        existing.role = seedUser.role;
        existing.name = seedUser.name;
      }
    });

    const repaired = {
      ...clone(seed),
      ...stored,

      users,

      exams:
        Array.isArray(stored.exams) && stored.exams.length
          ? stored.exams
          : clone(seed.exams),

      attempts: Array.isArray(stored.attempts)
        ? stored.attempts
        : [],

      violations: Array.isArray(stored.violations)
        ? stored.violations
        : [],

      theme: stored.theme === 'light'
        ? 'light'
        : 'dark'
    };

    if (!Array.isArray(repaired.exams) || !repaired.exams.length) {
      repaired.exams = clone(seed.exams);
    }

    /*
      Automatically create/repair examiner accounts for exams.
    */
    repaired.exams.forEach(exam => {
      const username = String(
        exam.examinerUsername || ''
      ).trim();

      if (!username) return;

      const normalized = username.toLowerCase();

      let account = repaired.users.find(
        user =>
          String(user.username || '')
            .trim()
            .toLowerCase() === normalized
      );

      if (!account) {
        account = {
          id: uid('user'),
          username,
          password: String(exam.examinerPassword || ''),
          role: 'examiner',
          name: username
        };

        repaired.users.push(account);
      } else if (account.role !== 'admin') {
        account.username = username;

        if (exam.examinerPassword !== undefined) {
          account.password = String(
            exam.examinerPassword || ''
          );
        }

        account.role = 'examiner';

        if (!account.name) {
          account.name = username;
        }
      }
    });

    safeSet(
      localStorage,
      KEY,
      JSON.stringify(repaired)
    );

    return repaired;
  }

  function saveDB() {
    safeSet(
      localStorage,
      KEY,
      JSON.stringify(db)
    );
  }

  function loadSession() {
    try {
      return JSON.parse(
        safeGet(sessionStorage, SESSION) || 'null'
      );
    } catch (error) {
      return null;
    }
  }

  function saveSession() {
    if (session) {
      safeSet(
        sessionStorage,
        SESSION,
        JSON.stringify(session)
      );
    } else {
      safeRemove(sessionStorage, SESSION);
    }
  }

  /* ================================================================
     VIEW MANAGEMENT
  ================================================================ */

  function showView(name) {
    Object.values(views).forEach(view => {
      if (view) view.hidden = true;
    });

    if (views[name]) {
      views[name].hidden = false;
    }

    window.scrollTo(0, 0);
  }

  function toast(message, type = '') {
    const container = $('#toast-container');

    if (!container) return;

    const item = document.createElement('div');

    item.className = 'toast ' + type;
    item.textContent = message;

    container.appendChild(item);

    setTimeout(() => {
      item.remove();
    }, 3000);
  }

  /* ================================================================
     THEME
  ================================================================ */

  function applyTheme() {
    document.body.classList.toggle(
      'light',
      db.theme === 'light'
    );

    [
      'theme-toggle-login',
      'theme-toggle-admin',
      'theme-toggle-examiner'
    ].forEach(id => {
      const button = $('#' + id);

      if (button) {
        button.textContent =
          db.theme === 'light'
            ? '☾'
            : '☼';
      }
    });
  }

  function toggleTheme() {
    db.theme =
      db.theme === 'light'
        ? 'dark'
        : 'light';

    saveDB();
    applyTheme();
  }

  [
    'theme-toggle-login',
    'theme-toggle-admin',
    'theme-toggle-examiner'
  ].forEach(id => {
    $('#' + id)?.addEventListener(
      'click',
      toggleTheme
    );
  });

  applyTheme();

  /* ================================================================
     AUTHENTICATION
  ================================================================ */

  const loginForm = $('#login-form');

  if (loginForm) {
    loginForm.addEventListener(
      'submit',
      async event => {
        event.preventDefault();

        const username =
          $('#login-username')?.value.trim() || '';

        const password =
          $('#login-password')?.value || '';

        const errorBox = $('#login-error');

        if (!username || !password) {
          if (errorBox) {
            errorBox.textContent =
              'Please enter your username and password.';
            errorBox.hidden = false;
          }

          return;
        }

        const submitButton =
          loginForm.querySelector(
            'button[type="submit"]'
          );

        if (submitButton) {
          submitButton.disabled = true;
          submitButton.dataset.originalText =
            submitButton.innerHTML;

          submitButton.innerHTML =
            'Signing in...';
        }

        await new Promise(
          resolve => setTimeout(resolve, 250)
        );

        /*
          Re-load database so newly created examiner
          accounts are immediately available.
        */
        db = loadDB();

        let user = db.users.find(
          item =>
            String(item.username || '')
              .trim()
              .toLowerCase() ===
              username.toLowerCase() &&
            String(item.password || '') ===
              password
        );

        /*
          Examiner fallback:
          If an examiner account was created through
          an exam but was not present in the users list,
          rebuild it from the assigned exam.
        */
        if (!user) {
          const assignedExam = db.exams.find(
            exam =>
              String(exam.examinerUsername || '')
                .trim()
                .toLowerCase() ===
                username.toLowerCase() &&
              String(exam.examinerPassword || '') ===
                password
          );

          if (assignedExam) {
            user = {
              id: uid('user'),
              username: username,
              password: password,
              role: 'examiner',
              name: username
            };

            db.users.push(user);
            saveDB();
          }
        }

        if (!user) {
          if (errorBox) {
            errorBox.textContent =
              'Invalid username or password.';
            errorBox.hidden = false;
            errorBox.classList.remove(
              'login-error-shake'
            );

            void errorBox.offsetWidth;

            errorBox.classList.add(
              'login-error-shake'
            );
          }

          if (submitButton) {
            submitButton.disabled = false;
            submitButton.innerHTML =
              submitButton.dataset.originalText ||
              'Sign In →';
          }

          return;
        }

        if (errorBox) {
          errorBox.hidden = true;
        }

        session = {
          userId: user.id,
          username: user.username,
          role: user.role,
          loginAt: Date.now()
        };

        saveSession();

        if (submitButton) {
          submitButton.disabled = false;
          submitButton.innerHTML =
            submitButton.dataset.originalText ||
            'Sign In →';
        }

        openPortal();
      }
    );
  }

  function currentUser() {
    if (!session) return null;

    return db.users.find(
      user => user.id === session.userId
    );
  }

  function openPortal() {
    const user = currentUser();

    if (!user) {
      session = null;
      saveSession();
      showView('login');
      return;
    }

    if (user.role === 'admin') {
      openAdmin();
    } else {
      openExaminer();
    }
  }

  function logout() {
    if (examState?.active) {
      toast(
        'You cannot log out while an exam is active.',
        'error'
      );

      return;
    }

    session = null;
    saveSession();

    currentExam = null;
    examState = null;

    showView('login');

    $('#login-form')?.reset();
  }

  $('#admin-logout')?.addEventListener(
    'click',
    logout
  );

  $('#examiner-logout')?.addEventListener(
    'click',
    logout
  );

  /* ================================================================
     SIDEBAR
  ================================================================ */

  $$('[data-toggle-sidebar]').forEach(button => {
    button.addEventListener('click', () => {
      const target =
        $('#' + button.dataset.toggleSidebar);

      target?.classList.toggle('open');
    });
  });

  $$('[data-admin-page]').forEach(button => {
    button.addEventListener('click', () => {
      adminPage(button.dataset.adminPage);
    });
  });

  $$('[data-examiner-page]').forEach(button => {
    button.addEventListener('click', () => {
      examinerPage(button.dataset.examinerPage);
    });
  });

  const pageTitles = {
    dashboard: 'Dashboard',
    exams: 'Exam Management',
    submissions: 'Submissions',
    violations: 'Violation Logs',
    analytics: 'Analytics',
    settings: 'Settings'
  };

  function openAdmin() {
    const user = currentUser();

    if (!user) return;

    if ($('#admin-user-name')) {
      $('#admin-user-name').textContent =
        user.name || user.username;
    }

    if ($('#admin-user-role')) {
      $('#admin-user-role').textContent =
        'Administrator';
    }

    if ($('#admin-avatar')) {
      $('#admin-avatar').textContent =
        (user.name || user.username)[0]
          .toUpperCase();
    }

    showView('admin');
    adminPage('dashboard');
  }

  function adminPage(page) {
    $$('[data-admin-page]').forEach(button => {
      button.classList.toggle(
        'active',
        button.dataset.adminPage === page
      );
    });

    $$('.admin-page').forEach(panel => {
      panel.classList.remove('active');
    });

    const pageElement =
      $('#admin-' + page + '-page');

    if (pageElement) {
      pageElement.classList.add('active');
    }

    if ($('#admin-page-title')) {
      $('#admin-page-title').textContent =
        pageTitles[page] || page;
    }

    $('#admin-sidebar')?.classList.remove('open');

    renderAdminPage(page);
  }

  function renderAdminPage(page) {
    const renderers = {
      dashboard: renderAdminDashboard,
      exams: renderAdminExams,
      submissions: renderSubmissions,
      violations: renderViolations,
      analytics: renderAnalytics,
      settings: renderSettings
    };

    (
      renderers[page] ||
      renderAdminDashboard
    )();
  }

  function openExaminer() {
    const user = currentUser();

    if (!user) return;

    if ($('#examiner-user-name')) {
      $('#examiner-user-name').textContent =
        user.name || user.username;
    }

    if ($('#examiner-avatar')) {
      $('#examiner-avatar').textContent =
        (user.name || user.username)[0]
          .toUpperCase();
    }

    showView('examiner');
    renderExaminerDashboard();
  }

  function examinerPage() {
    renderExaminerDashboard();

    $('#examiner-sidebar')?.classList.remove(
      'open'
    );
  }

  /* ================================================================
     ADMIN DASHBOARD
  ================================================================ */

  function attemptCounts() {
    const attempts = db.attempts;

    return {
      total: attempts.length,

      inProgress:
        attempts.filter(
          item => item.status === 'In Progress'
        ).length,

      completed:
        attempts.filter(
          item => item.status === 'Completed'
        ).length,

      expired:
        attempts.filter(
          item => item.status === 'Time Expired'
        ).length,

      terminated:
        attempts.filter(
          item => item.status === 'Terminated'
        ).length
    };
  }

  function renderAdminDashboard() {
    const counts = attemptCounts();

    const avg =
      db.attempts.length
        ? (
            db.attempts.reduce(
              (sum, attempt) =>
                sum + (attempt.violations || 0),
              0
            ) / db.attempts.length
          ).toFixed(1)
        : '0.0';

    const completion =
      counts.total
        ? Math.round(
            (counts.completed /
              counts.total) *
              100
          )
        : 0;

    $('#admin-dashboard-page').innerHTML = `
      <div class="page-head">
        <div>
          <span class="eyebrow">OVERVIEW</span>
          <h3>Exam Dashboard</h3>
          <p>
            Monitor current activity, completion and security events.
          </p>
        </div>

        <div class="actions">
          <button
            class="secondary-btn"
            data-action="new-exam">
            + Add Exam
          </button>
        </div>
      </div>

      <div class="stat-grid">
        ${stat('Total Sessions', counts.total)}
        ${stat('In Progress', counts.inProgress)}
        ${stat('Completed', counts.completed, 'success')}
        ${stat('Time Expired', counts.expired, 'warning')}
        ${stat('Terminated', counts.terminated, 'danger')}
        ${stat('Avg. Violations', avg)}
      </div>

      <div class="grid-2">

        <div class="panel">
          <h3>Overall Completion</h3>

          <div class="progress-bar">
            <div
              class="progress-fill"
              style="width:${completion}%">
            </div>
          </div>

          <div class="progress-meta">
            <span>${completion}% completed</span>
            <span>
              ${counts.completed} of
              ${counts.total} sessions
            </span>
          </div>
        </div>

        <div class="panel">
          <h3>Exam Capacity</h3>

          <div class="quick-grid">
            <div class="quick-card">
              <strong>${db.exams.length}</strong>
              <span>Active exams</span>
            </div>

            <div class="quick-card">
              <strong>
                ${Math.max(
                  0,
                  MAX_EXAMS - db.exams.length
                )}
              </strong>
              <span>Slots available</span>
            </div>

            <div class="quick-card">
              <strong>${db.users.length}</strong>
              <span>Total users</span>
            </div>
          </div>
        </div>

      </div>

      <div
        class="panel"
        style="margin-top:18px">

        <div
          class="page-head"
          style="margin-bottom:12px">

          <div>
            <h3>Recent Submissions</h3>
            <p>
              Latest exam sessions across all examiners.
            </p>
          </div>

          <button
            class="secondary-btn"
            data-action="view-submissions">
            View all
          </button>
        </div>

        ${submissionTable(
          db.attempts
            .slice()
            .sort(
              (a, b) =>
                (b.startedAt || 0) -
                (a.startedAt || 0)
            )
            .slice(0, 8)
        )}

      </div>
    `;

    bindActions();
  }

  function stat(label, value, className = '') {
    return `
      <div class="stat-card ${className}">
        <span class="stat-label">
          ${esc(label)}
        </span>

        <span class="stat-value">
          ${esc(value)}
        </span>
      </div>
    `;
  }

  function submissionTable(rows) {
    if (!rows.length) {
      return `
        <div class="empty">
          No exam sessions yet.
        </div>
      `;
    }

    return `
      <div class="table-wrap">
        <table class="data-table">

          <thead>
            <tr>
              <th>Examiner</th>
              <th>Exam</th>
              <th>Started</th>
              <th>Ended</th>
              <th>Status</th>
              <th>Violations</th>
              <th>Time Spent</th>
            </tr>
          </thead>

          <tbody>

            ${rows
              .map(
                attempt => `
                <tr>

                  <td>
                    ${esc(attempt.username)}
                  </td>

                  <td>
                    ${esc(attempt.examTitle)}
                  </td>

                  <td>
                    ${fmtDate(attempt.startedAt)}
                  </td>

                  <td>
                    ${fmtDate(attempt.endedAt)}
                  </td>

                  <td>
                    ${badge(attempt.status)}
                  </td>

                  <td>
                    ${attempt.violations || 0}
                  </td>

                  <td>
                    ${formatDuration(
                      attempt.durationSeconds || 0
                    )}
                  </td>

                </tr>
              `
              )
              .join('')}

          </tbody>

        </table>
      </div>
    `;
  }

  function badge(status) {
    const map = {
      Completed: 'green',
      'Time Expired': 'yellow',
      Terminated: 'red',
      'In Progress': 'blue',
      Locked: 'gray',
      Available: 'green',
      Unavailable: 'gray'
    };

    return `
      <span class="badge ${
        map[status] || 'gray'
      }">
        ${esc(status)}
      </span>
    `;
  }

  /* ================================================================
     EXAM MANAGEMENT
  ================================================================ */

  function renderAdminExams() {
    const slots =
      MAX_EXAMS - db.exams.length;

    $('#admin-exams-page').innerHTML = `
      <div class="page-head">

        <div>
          <span class="eyebrow">
            EXAM MANAGEMENT
          </span>

          <h3>Exams</h3>

          <p>
            Create up to ${MAX_EXAMS} exams.
            Deleting an exam releases its slot.
          </p>

          <div class="slot-note">
            ${db.exams.length}/${MAX_EXAMS}
            slots used
          </div>
        </div>

        <div class="actions">
          <button
            class="primary-btn"
            data-action="new-exam"
            ${slots <= 0 ? 'disabled' : ''}>
            + Add New Exam
          </button>
        </div>

      </div>

      <div class="exam-grid">
        ${
          db.exams.length
            ? db.exams
                .map(examCard)
                .join('')
            : `
              <div
                class="panel"
                style="grid-column:1/-1">
                <div class="empty">
                  No exams created yet.
                </div>
              </div>
            `
        }
      </div>
    `;

    bindActions();
  }

  function examCard(exam) {
    const availability =
      getAvailability(exam);

    const attempts =
      db.attempts.filter(
        attempt =>
          attempt.examId === exam.id
      );

    return `
      <article class="exam-card">

        <div class="exam-card-top">

          <span class="badge ${
            exam.active
              ? 'green'
              : 'gray'
          }">
            ${exam.active
              ? 'ACTIVE'
              : 'DISABLED'}
          </span>

          ${badge(availability.status)}

        </div>

        <h3>
          ${esc(exam.title)}
        </h3>

        <p>
          ${esc(
            exam.description ||
              'No description provided.'
          )}
        </p>

        <div class="exam-meta">

          <div class="meta-box">
            <span>Timer</span>
            <strong>
              ${
                boolSetting(
                  exam.timerEnabled
                )
                  ? `${exam.durationMinutes} min`
                  : 'Off'
              }
            </strong>
          </div>

          <div class="meta-box">
            <span>Anti-cheat</span>
            <strong>
              ${
                boolSetting(
                  exam.antiCheat
                )
                  ? 'On'
                  : 'Off'
              }
            </strong>
          </div>

          <div class="meta-box">
            <span>Violations</span>
            <strong>
              ${exam.maxViolations}
            </strong>
          </div>

          <div class="meta-box">
            <span>Attempts</span>
            <strong>
              ${attempts.length}
            </strong>
          </div>

        </div>

        <div class="exam-card-actions">

          <button
            class="secondary-btn"
            data-action="edit-exam"
            data-id="${exam.id}">
            Edit
          </button>

          <button
            class="danger-btn"
            data-action="delete-exam"
            data-id="${exam.id}">
            Delete
          </button>

        </div>

      </article>
    `;
  }

  function getAvailability(exam) {
    if (!exam.active) {
      return {
        status: 'Unavailable'
      };
    }

    const now = Date.now();

    const start =
      exam.startAt
        ? new Date(exam.startAt).getTime()
        : null;

    const end =
      exam.endAt
        ? new Date(exam.endAt).getTime()
        : null;

    if (start && now < start) {
      return {
        status: 'Unavailable'
      };
    }

    if (end && now > end) {
      return {
        status: 'Unavailable'
      };
    }

    return {
      status: 'Available'
    };
  }

  function openExamModal(id = null) {
    const exam = id
      ? db.exams.find(
          item => item.id === id
        )
      : null;

    if (
      !exam &&
      db.exams.length >= MAX_EXAMS
    ) {
      toast(
        `Maximum of ${MAX_EXAMS} exams reached. Delete an exam to free a slot.`,
        'error'
      );

      return;
    }

    const data =
      exam ||
      {
        title: '',
        description: '',
        formUrl: '',
        examinerUsername: 'test',
        examinerPassword: 'test',
        antiCheat: true,
        maxViolations: 3,
        timerEnabled: true,
        durationMinutes: 60,
        startAt: '',
        endAt: '',
        active: true
      };

    const isoLocal = value => {
      if (!value) return '';

      const date = new Date(value);

      if (Number.isNaN(date.getTime())) {
        return '';
      }

      return date
        .toISOString()
        .slice(0, 16);
    };

    $('#modal-root').hidden = false;

    $('#modal-root').innerHTML = `
      <div class="modal">

        <div class="modal-head">

          <div>
            <span class="eyebrow">
              ${
                exam
                  ? 'EDIT EXAM'
                  : 'NEW EXAM'
              }
            </span>

            <h3>
              ${
                exam
                  ? 'Update examination'
                  : 'Create examination'
              }
            </h3>
          </div>

          <button
            class="close-btn"
            data-action="close-modal">
            ×
          </button>

        </div>

        <form id="exam-form">

          <div class="modal-body">

            <div class="form-grid">

              <div class="field full-span">
                <label class="form-label">
                  Exam Title
                </label>

                <input
                  name="title"
                  required
                  value="${esc(data.title)}"
                  placeholder="e.g. HR Certification Examination">
              </div>

              <div class="field full-span">

                <label class="form-label">
                  Description
                </label>

                <textarea
                  name="description"
                  rows="2"
                  placeholder="Short description">${esc(
                    data.description
                  )}</textarea>

              </div>

              <div class="field full-span">

                <label class="form-label">
                  Google Forms Link
                </label>

                <input
                  name="formUrl"
                  type="url"
                  required
                  value="${esc(data.formUrl)}"
                  placeholder="https://docs.google.com/forms/d/e/.../viewform?embedded=true">

                <div class="helper">
                  Use the Google Form's embeddable/viewform URL.
                </div>

              </div>

              <div class="field">

                <label class="form-label">
                  Examiner Username
                </label>

                <input
                  name="examinerUsername"
                  required
                  value="${esc(
                    data.examinerUsername
                  )}">

              </div>

              <div class="field">

                <label class="form-label">
                  Examiner Password
                </label>

                <input
                  name="examinerPassword"
                  required
                  value="${esc(
                    data.examinerPassword
                  )}">

              </div>

              <div class="field">

                <label class="form-label">
                  Maximum Violations
                </label>

                <input
                  name="maxViolations"
                  type="number"
                  min="1"
                  max="99"
                  required
                  value="${data.maxViolations}">

              </div>

              <div class="field">

                <label class="form-label">
                  Timer Duration (minutes)
                </label>

                <input
                  name="durationMinutes"
                  type="number"
                  min="1"
                  max="1440"
                  required
                  value="${data.durationMinutes}">

              </div>

              <div class="field full-span">

                <div class="checkbox-row">

                  <input
                    id="antiCheat"
                    name="antiCheat"
                    type="checkbox"
                    ${
                      boolSetting(
                        data.antiCheat
                      )
                        ? 'checked'
                        : ''
                    }>

                  <label for="antiCheat">
                    Enable anti-cheat monitoring
                  </label>

                </div>

                <div class="helper">
                  Detects tab visibility changes,
                  focus loss, fullscreen exits and
                  restricted shortcuts.
                </div>

              </div>

              <div class="field full-span">

                <div class="checkbox-row">

                  <input
                    id="timerEnabled"
                    name="timerEnabled"
                    type="checkbox"
                    ${
                      boolSetting(
                        data.timerEnabled
                      )
                        ? 'checked'
                        : ''
                    }>

                  <label for="timerEnabled">
                    Enable examination timer
                  </label>

                </div>

              </div>

              <div class="field">

                <label class="form-label">
                  Available From
                </label>

                <input
                  name="startAt"
                  type="datetime-local"
                  value="${isoLocal(
                    data.startAt
                  )}">

                <div class="helper">
                  Leave blank for immediately available.
                </div>

              </div>

              <div class="field">

                <label class="form-label">
                  Available Until
                </label>

                <input
                  name="endAt"
                  type="datetime-local"
                  value="${isoLocal(
                    data.endAt
                  )}">

                <div class="helper">
                  Leave blank for no end date.
                </div>

              </div>

              <div class="field full-span">

                <div class="checkbox-row">

                  <input
                    id="active"
                    name="active"
                    type="checkbox"
                    ${
                      data.active
                        ? 'checked'
                        : ''
                    }>

                  <label for="active">
                    Exam is active
                  </label>

                </div>

              </div>

            </div>

          </div>

          <div class="modal-footer">

            <button
              type="button"
              class="secondary-btn"
              data-action="close-modal">
              Cancel
            </button>

            <button
              type="submit"
              class="primary-btn">
              ${
                exam
                  ? 'Save Changes'
                  : 'Create Exam'
              }
            </button>

          </div>

        </form>

      </div>
    `;

    $('#exam-form').addEventListener(
      'submit',
      event => {
        event.preventDefault();

        const formData =
          new FormData(event.target);

        const formUrl =
          String(
            formData.get('formUrl') || ''
          ).trim();

        if (
          !/^https:\/\/(docs\.google\.com|forms\.google\.com)\//i.test(
            formUrl
          )
        ) {
          toast(
            'Please enter a valid Google Forms URL.',
            'error'
          );

          return;
        }

        const title =
          String(
            formData.get('title') || ''
          ).trim();

        const examinerUsername =
          String(
            formData.get(
              'examinerUsername'
            ) || ''
          ).trim();

        const examinerPassword =
          String(
            formData.get(
              'examinerPassword'
            ) || ''
          );

        if (
          !title ||
          !examinerUsername ||
          !examinerPassword
        ) {
          toast(
            'Complete all required fields.',
            'error'
          );

          return;
        }

        const startInput =
          formData.get('startAt');

        const endInput =
          formData.get('endAt');

        const object = {
          title,

          description:
            String(
              formData.get(
                'description'
              ) || ''
            ).trim(),

          formUrl,

          examinerUsername,
          examinerPassword,

          antiCheat:
            formData.has('antiCheat'),

          maxViolations:
            Math.max(
              1,
              Number(
                formData.get(
                  'maxViolations'
                )
              ) || 3
            ),

          timerEnabled:
            formData.has('timerEnabled'),

          durationMinutes:
            Math.max(
              1,
              Number(
                formData.get(
                  'durationMinutes'
                )
              ) || 60
            ),

          startAt:
            startInput
              ? new Date(
                  startInput
                ).toISOString()
              : '',

          endAt:
            endInput
              ? new Date(
                  endInput
                ).toISOString()
              : '',

          active:
            formData.has('active')
        };

        if (object.endAt && object.startAt) {
          if (
            new Date(
              object.endAt
            ).getTime() <
            new Date(
              object.startAt
            ).getTime()
          ) {
            toast(
              'The end date must be after the start date.',
              'error'
            );

            return;
          }
        }

        if (exam) {
          Object.assign(
            exam,
            object
          );
        } else {
          db.exams.push({
            id: uid('exam'),
            ...object,
            createdAt: Date.now(),
            createdBy:
              currentUser()?.id ||
              'u-admin'
          });
        }

        /*
          Create/update examiner account.
        */
        const existingUser =
          db.users.find(
            user =>
              String(
                user.username || ''
              )
                .trim()
                .toLowerCase() ===
              examinerUsername.toLowerCase()
          );

        if (existingUser) {
          if (
            existingUser.role !==
            'admin'
          ) {
            existingUser.username =
              examinerUsername;

            existingUser.password =
              examinerPassword;

            existingUser.role =
              'examiner';

            if (!existingUser.name) {
              existingUser.name =
                examinerUsername;
            }
          }
        } else {
          db.users.push({
            id: uid('user'),
            username:
              examinerUsername,
            password:
              examinerPassword,
            role: 'examiner',
            name:
              examinerUsername
          });
        }

        saveDB();

        closeModal();

        renderAdminExams();

        toast(
          exam
            ? 'Exam updated successfully.'
            : 'Exam created successfully.',
          'success'
        );
      }
    );

    bindActions();
  }

  function deleteExam(id) {
    const exam =
      db.exams.find(
        item => item.id === id
      );

    if (!exam) return;

    const count =
      db.attempts.filter(
        attempt =>
          attempt.examId === id
      ).length;

    const confirmed = confirm(
      `Delete "${exam.title}"?\n\n` +
      `This releases an exam slot. ` +
      `${count} historical attempt(s) will remain in the reports.`
    );

    if (!confirmed) return;

    db.exams =
      db.exams.filter(
        item => item.id !== id
      );

    saveDB();

    renderAdminExams();

    toast(
      'Exam deleted. The slot is now available.',
      'success'
    );
  }

  function closeModal() {
    const modal = $('#modal-root');

    if (!modal) return;

    modal.hidden = true;
    modal.innerHTML = '';
  }

  /* ================================================================
     SUBMISSIONS
  ================================================================ */

  function renderSubmissions() {
    const sorted =
      db.attempts
        .slice()
        .sort(
          (a, b) =>
            (b.startedAt || 0) -
            (a.startedAt || 0)
        );

    $('#admin-submissions-page').innerHTML = `
      <div class="page-head">

        <div>
          <span class="eyebrow">
            MONITORING
          </span>

          <h3>Submissions</h3>

          <p>
            Current and completed examination sessions.
          </p>
        </div>

        <div class="actions">

          <button
            class="secondary-btn"
            data-action="refresh-admin">
            Refresh
          </button>

        </div>

      </div>

      <div class="panel">
        ${submissionTable(sorted)}
      </div>
    `;

    bindActions();
  }

  /* ================================================================
     VIOLATIONS
  ================================================================ */

  function renderViolations() {
    const rows =
      db.violations
        .slice()
        .sort(
          (a, b) =>
            b.timestamp -
            a.timestamp
        );

    $('#admin-violations-page').innerHTML = `
      <div class="page-head">

        <div>
          <span class="eyebrow">
            SECURITY
          </span>

          <h3>Violation Logs</h3>

          <p>
            Every detected event is recorded for review.
          </p>
        </div>

      </div>

      <div class="panel">

        ${
          rows.length
            ? `
              <div class="table-wrap">

                <table class="data-table">

                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Examiner</th>
                      <th>Exam</th>
                      <th>#</th>
                      <th>Reason</th>
                    </tr>
                  </thead>

                  <tbody>

                    ${rows
                      .map(
                        violation => `
                        <tr>

                          <td>
                            ${fmtDate(
                              violation.timestamp
                            )}
                          </td>

                          <td>
                            ${esc(
                              violation.username
                            )}
                          </td>

                          <td>
                            ${esc(
                              violation.examTitle
                            )}
                          </td>

                          <td>
                            ${violation.number}
                          </td>

                          <td>
                            ${esc(
                              violation.reason
                            )}
                          </td>

                        </tr>
                      `
                      )
                      .join('')}

                  </tbody>

                </table>

              </div>
            `
            : `
              <div class="empty">
                No violations logged yet.
              </div>
            `
        }

      </div>
    `;
  }

  /* ================================================================
     ANALYTICS
  ================================================================ */

  function renderAnalytics() {
    const counts =
      attemptCounts();

    const total =
      counts.total || 1;

    const avg =
      db.attempts.length
        ? (
            db.attempts.reduce(
              (sum, attempt) =>
                sum +
                (attempt.violations || 0),
              0
            ) /
            db.attempts.length
          ).toFixed(2)
        : '0.00';

    const byExam =
      db.exams
        .map(exam => ({
          exam,
          count:
            db.attempts.filter(
              attempt =>
                attempt.examId ===
                exam.id
            ).length
        }))
        .sort(
          (a, b) =>
            b.count -
            a.count
        );

    $('#admin-analytics-page').innerHTML = `
      <div class="page-head">

        <div>
          <span class="eyebrow">
            REPORTING
          </span>

          <h3>Analytics</h3>

          <p>
            Performance and security overview.
          </p>
        </div>

      </div>

      <div class="kpi-grid">

        ${kpi(
          'Completion Rate',
          Math.round(
            (counts.completed /
              total) *
              100
          ) + '%'
        )}

        ${kpi(
          'In Progress',
          counts.inProgress
        )}

        ${kpi(
          'Termination Rate',
          Math.round(
            (counts.terminated /
              total) *
              100
          ) + '%'
        )}

        ${kpi(
          'Avg. Violations',
          avg
        )}

      </div>

      <div class="grid-2">

        <div class="panel">

          <h3>
            Session Status
          </h3>

          ${[
            [
              'Completed',
              counts.completed
            ],
            [
              'In Progress',
              counts.inProgress
            ],
            [
              'Time Expired',
              counts.expired
            ],
            [
              'Terminated',
              counts.terminated
            ]
          ]
            .map(
              ([label, count]) =>
                chart(
                  label,
                  count,
                  counts.total
                )
            )
            .join('')}

        </div>

        <div class="panel">

          <h3>
            Sessions by Exam
          </h3>

          ${
            byExam.length
              ? byExam
                  .map(item =>
                    chart(
                      item.exam.title,
                      item.count,
                      counts.total
                    )
                  )
                  .join('')
              : `
                <div class="empty">
                  No exams.
                </div>
              `
          }

        </div>

      </div>

      <div
        class="panel"
        style="margin-top:18px">

        <h3>
          Violation Activity
        </h3>

        <p
          class="muted"
          style="font-size:12px">

          ${db.violations.length}
          security events have been recorded
          across
          ${db.attempts.length}
          session(s).

        </p>

        <div class="progress-bar">

          <div
            class="progress-fill"
            style="
              width:${Math.min(
                100,
                db.violations.length * 5
              )}%
            ">
          </div>

        </div>

      </div>
    `;
  }

  function kpi(label, value) {
    return `
      <div class="kpi">
        <span>${esc(label)}</span>
        <strong>${esc(value)}</strong>
      </div>
    `;
  }

  function chart(label, number, total) {
    const percent =
      total
        ? Math.round(
            (number / total) *
              100
          )
        : 0;

    return `
      <div class="chart-row">

        <div>

          <div class="chart-label">
            ${esc(label)}
          </div>

          <div class="bar-track">

            <div
              class="bar-value"
              style="width:${percent}%">
            </div>

          </div>

        </div>

        <div class="chart-number">
          ${number}
          (${percent}%)
        </div>

      </div>
    `;
  }

  /* ================================================================
     SETTINGS
  ================================================================ */

  function renderSettings() {
    const user =
      currentUser();

    $('#admin-settings-page').innerHTML = `
      <div class="page-head">

        <div>
          <span class="eyebrow">
            SYSTEM
          </span>

          <h3>Settings</h3>

          <p>
            Frontend prototype settings and account management.
          </p>
        </div>

      </div>

      <div class="grid-2">

        <div class="panel">

          <h3>
            Theme
          </h3>

          <p
            class="muted"
            style="font-size:12px">

            Current theme:
            <strong>
              ${db.theme}
            </strong>

          </p>

          <button
            class="secondary-btn"
            data-action="toggle-theme">
            Switch Theme
          </button>

        </div>

        <div class="panel">

          <h3>
            Prototype Data
          </h3>

          <p
            class="muted"
            style="font-size:12px">

            Users, exams, attempts and
            violation logs are stored in
            this browser's localStorage.

          </p>

          <button
            class="danger-btn"
            data-action="reset-demo">
            Reset Demo Data
          </button>

        </div>

      </div>

      <div
        class="panel"
        style="margin-top:18px">

        <h3>
          Accounts
        </h3>

        <div class="table-wrap">

          <table class="data-table">

            <thead>

              <tr>
                <th>Username</th>
                <th>Name</th>
                <th>Role</th>
                <th>Action</th>
              </tr>

            </thead>

            <tbody>

              ${db.users
                .map(
                  account => `
                  <tr>

                    <td>
                      ${esc(
                        account.username
                      )}
                    </td>

                    <td>
                      ${esc(
                        account.name
                      )}
                    </td>

                    <td>
                      ${esc(
                        account.role
                      )}
                    </td>

                    <td>

                      ${
                        account.id ===
                        user?.id
                          ? `
                            <span class="muted">
                              Current user
                            </span>
                          `
                          : `
                            <button
                              class="danger-btn"
                              data-action="delete-user"
                              data-id="${account.id}">
                              Delete
                            </button>
                          `
                      }

                    </td>

                  </tr>
                `
                )
                .join('')}

            </tbody>

          </table>

        </div>

      </div>

      <div
        class="panel"
        style="margin-top:18px">

        <h3>
          Production Note
        </h3>

        <div class="notice danger-notice">

          Do not use client-side passwords
          and localStorage as a production
          authentication system.

          Move credentials, role permissions,
          exam availability, attempt locking,
          timers and violation logs to a
          server-side database/API.

        </div>

      </div>
    `;

    bindActions();
  }

  /* ================================================================
     EXAMINER DASHBOARD
  ================================================================ */

  function getAssignedExams(username) {
    const normalized =
      String(username || '')
        .trim()
        .toLowerCase();

    return db.exams.filter(
      exam =>
        String(
          exam.examinerUsername || ''
        )
          .trim()
          .toLowerCase() ===
        normalized
    );
  }

  function getUserAttempts(username) {
    return db.attempts.filter(
      attempt =>
        String(
          attempt.username || ''
        )
          .trim()
          .toLowerCase() ===
        String(username || '')
          .trim()
          .toLowerCase()
    );
  }

  function getCompletedAttempts(username) {
    return getUserAttempts(
      username
    ).filter(
      attempt =>
        [
          'Completed',
          'Time Expired',
          'Terminated'
        ].includes(
          attempt.status
        )
    );
  }

  function getTotalViolations(username) {
    return getUserAttempts(
      username
    ).reduce(
      (total, attempt) =>
        total +
        Number(
          attempt.violations || 0
        ),
      0
    );
  }

  function getTotalTimeSpent(username) {
    return getCompletedAttempts(
      username
    ).reduce(
      (total, attempt) =>
        total +
        Number(
          attempt.durationSeconds || 0
        ),
      0
    );
  }

  function getAttemptForExam(
    examId,
    username
  ) {
    return getUserAttempts(
      username
    )
      .filter(
        attempt =>
          attempt.examId ===
          examId
      )
      .sort(
        (a, b) =>
          (b.startedAt || 0) -
          (a.startedAt || 0)
      )[0];
  }

  function renderExaminerDashboard() {
    const user =
      currentUser();

    if (!user) return;

    const assigned =
      getAssignedExams(
        user.username
      );

    const completed =
      getCompletedAttempts(
        user.username
      );

    const completedExamIds =
      new Set(
        completed.map(
          attempt =>
            attempt.examId
        )
      );

    const takenCount =
      completedExamIds.size;

    const progress =
      assigned.length
        ? Math.round(
            (takenCount /
              assigned.length) *
              100
          )
        : 0;

    const violations =
      getTotalViolations(
        user.username
      );

    const totalTime =
      getTotalTimeSpent(
        user.username
      );

    const available =
      assigned.filter(
        exam =>
          getAvailability(
            exam
          ).status ===
          'Available'
      ).length;

    $('#examiner-dashboard-page').innerHTML = `

      <div class="page-head">

        <div>

          <span class="eyebrow">
            YOUR EXAMINATION QUEUE
          </span>

          <h3>
            Welcome,
            ${esc(
              user.name ||
              user.username
            )}
          </h3>

          <p>
            View your assigned examinations,
            availability, progress and
            proctoring activity.
          </p>

        </div>

      </div>

      <!-- EXAMINER STATISTICS -->

      <div
        class="examiner-stats">

        <div class="panel metric-panel">

          <span class="metric-label">
            EXAM PROGRESS
          </span>

          <strong>
            ${takenCount}/${assigned.length}
          </strong>

          <div class="progress-bar">

            <div
              class="progress-fill"
              style="
                width:${progress}%
              ">
            </div>

          </div>

          <span class="metric-sub">
            ${progress}% of assigned exams completed
          </span>

        </div>

        <div class="panel metric-panel">

          <span class="metric-label">
            VIOLATIONS
          </span>

          <strong>
            ${violations}
          </strong>

          <div class="progress-bar">

            <div
              class="progress-fill danger-fill"
              style="
                width:${Math.min(
                  100,
                  violations * 10
                )}%
              ">
            </div>

          </div>

          <span class="metric-sub">
            Total detected security violations
          </span>

        </div>

        <div class="panel metric-panel">

          <span class="metric-label">
            TOTAL TIME SPENT
          </span>

          <strong>
            ${formatDuration(
              totalTime
            )}
          </strong>

          <span class="metric-sub">
            Across completed examination sessions
          </span>

        </div>

      </div>

      <!-- EXAM SUMMARY -->

      <div
        class="panel"
        style="margin-bottom:18px">

        <div class="progress-meta">

          <strong>
            Examination Progress
          </strong>

          <span>
            ${takenCount}
            of
            ${assigned.length}
            taken
          </span>

        </div>

        <div
          class="progress-bar"
          style="margin-top:8px">

          <div
            class="progress-fill"
            style="
              width:${progress}%
            ">
          </div>

        </div>

        <div
          class="progress-meta">

          <span>
            ${available}
            currently available
          </span>

          <span>
            ${assigned.length}
            assigned
          </span>

        </div>

      </div>

      <!-- ASSIGNED EXAMS -->

      <div
        class="exam-grid">

        ${
          assigned.length
            ? assigned
                .map(
                  exam =>
                    examinerExamCard(
                      exam,
                      completedExamIds.has(
                        exam.id
                      )
                    )
                )
                .join('')
            : `
              <div
                class="panel"
                style="grid-column:1/-1">

                <div class="empty">
                  No exams have been assigned
                  to this examiner account.
                </div>

              </div>
            `
        }

      </div>

    `;

    bindActions();
  }

  function examinerExamCard(
    exam,
    completed
  ) {
    const availability =
      getAvailability(
        exam
      );

    const canStart =
      availability.status ===
        'Available' &&
      !completed;

    const user =
      currentUser();

    const last =
      getAttemptForExam(
        exam.id,
        user?.username
      );

    const timerEnabled =
      boolSetting(
        exam.timerEnabled
      );

    const antiCheat =
      boolSetting(
        exam.antiCheat
      );

    const startDate =
      exam.startAt
        ? fmtDate(exam.startAt)
        : 'Immediately available';

    const endDate =
      exam.endAt
        ? fmtDate(exam.endAt)
        : 'No end date';

    const statusText =
      completed
        ? 'COMPLETED'
        : availability.status;

    const statusClass =
      completed
        ? 'green'
        : availability.status ===
          'Available'
        ? 'green'
        : 'gray';

    return `
      <article class="exam-card">

        <div class="exam-card-top">

          <span class="badge ${statusClass}">
            ${statusText}
          </span>

          ${
            antiCheat
              ? `
                <span class="badge blue">
                  PROCTORED
                </span>
              `
              : ''
          }

        </div>

        <h3>
          ${esc(exam.title)}
        </h3>

        <p>
          ${esc(
            exam.description ||
              'No description provided.'
          )}
        </p>

        <!-- EXAM DATES -->

        <div
          class="exam-date-range">

          <span>
            START DATE
          </span>

          <strong>
            ${esc(startDate)}
          </strong>

        </div>

        <div
          class="exam-date-range">

          <span>
            END DATE
          </span>

          <strong>
            ${esc(endDate)}
          </strong>

        </div>

        <!-- EXAM DETAILS -->

        <div class="exam-meta">

          <div class="meta-box">

            <span>
              Duration
            </span>

            <strong>
              ${
                timerEnabled
                  ? `${exam.durationMinutes} min`
                  : 'No timer'
              }
            </strong>

          </div>

          <div class="meta-box">

            <span>
              Anti-cheat
            </span>

            <strong>
              ${
                antiCheat
                  ? 'Enabled'
                  : 'Disabled'
              }
            </strong>

          </div>

          <div class="meta-box">

            <span>
              Max Violations
            </span>

            <strong>
              ${exam.maxViolations}
            </strong>

          </div>

          <div class="meta-box">

            <span>
              Attempts
            </span>

            <strong>
              ${
                completed
                  ? '1 / 1'
                  : '0 / 1'
              }
            </strong>

          </div>

        </div>

        <!-- PREVIOUS SESSION DATA -->

        ${
          completed && last
            ? `
              <div
                class="exam-date-range">

                <span>
                  SESSION SUMMARY
                </span>

                <strong>
                  Violations:
                  ${last.violations || 0}
                  <br>

                  Time Spent:
                  ${formatDuration(
                    last.durationSeconds ||
                      0
                  )}

                  ${
                    last.endedAt
                      ? `
                        <br>
                        Completed:
                        ${fmtDate(
                          last.endedAt
                        )}
                      `
                      : ''
                  }

                </strong>

              </div>
            `
            : ''
        }

        <!-- ACTION -->

        <div
          class="exam-card-actions">

          ${
            completed
              ? `
                <button
                  class="secondary-btn"
                  disabled>
                  Exam Locked
                </button>
              `
              : canStart
              ? `
                <button
                  class="primary-btn"
                  data-action="start-exam"
                  data-id="${exam.id}">
                  Start Exam
                </button>
              `
              : `
                <button
                  class="secondary-btn"
                  disabled>
                  Not Available
                </button>
              `
          }

        </div>

        ${
          last &&
          last.status ===
            'In Progress'
            ? `
              <div class="helper">
                An active session is already
                associated with this exam.
                Refreshing the page will not
                create a second attempt.
              </div>
            `
            : ''
        }

      </article>
    `;
  }

  /* ================================================================
     START EXAM
  ================================================================ */

  function startExam(id) {
    const exam =
      db.exams.find(
        item => item.id === id
      );

    const user =
      currentUser();

    if (!exam || !user) {
      return;
    }

    const assignedUsername =
      String(
        exam.examinerUsername || ''
      )
        .trim()
        .toLowerCase();

    if (
      assignedUsername !==
      String(
        user.username || ''
      )
        .trim()
        .toLowerCase()
    ) {
      toast(
        'This exam is not assigned to your account.',
        'error'
      );

      return;
    }

    if (
      getAvailability(
        exam
      ).status !== 'Available'
    ) {
      toast(
        'This exam is not currently available.',
        'error'
      );

      return;
    }

    const alreadyCompleted =
      db.attempts.some(
        attempt =>
          attempt.examId === id &&
          attempt.username ===
            user.username &&
          [
            'Completed',
            'Time Expired',
            'Terminated'
          ].includes(
            attempt.status
          )
      );

    if (alreadyCompleted) {
      toast(
        'This exam is locked because it has already been taken.',
        'error'
      );

      return;
    }

    const inProgress =
      db.attempts.find(
        attempt =>
          attempt.examId === id &&
          attempt.username ===
            user.username &&
          attempt.status ===
            'In Progress'
      );

    /*
      If a session already exists, offer to resume it.
    */
    if (inProgress) {
      const resume =
        confirm(
          'An active examination session already exists.\n\n' +
          'Click OK to resume the existing session.'
        );

      if (resume) {
        resumeExam(
          exam,
          inProgress
        );
      }

      return;
    }

    openStartInstructions(
      exam
    );
  }

  function openStartInstructions(
    exam
  ) {
    const timerEnabled =
      boolSetting(
        exam.timerEnabled
      );

    const antiCheat =
      boolSetting(
        exam.antiCheat
      );

    $('#modal-root').hidden = false;

    $('#modal-root').innerHTML = `
      <div class="modal">

        <div class="modal-head">

          <div>

            <span class="eyebrow">
              EXAM INSTRUCTIONS
            </span>

            <h3>
              ${esc(exam.title)}
            </h3>

          </div>

          <button
            class="close-btn"
            data-action="close-modal">
            ×
          </button>

        </div>

        <div class="modal-body">

          <div class="notice">

            You can take this examination
            only once.

            Once submitted, expired or
            terminated, it cannot be retaken.

          </div>

          <ul
            style="
              color:var(--muted);
              font-size:13px;
              line-height:1.8;
              padding-left:20px
            ">

            <li>
              ${
                timerEnabled
                  ? `
                    You have
                    <strong>
                      ${exam.durationMinutes}
                      minutes
                    </strong>
                    to complete the examination.
                  `
                  : `
                    No countdown timer is
                    configured for this exam.
                  `
              }
            </li>

            <li>
              ${
                antiCheat
                  ? `
                    Anti-cheat is enabled.
                    Up to
                    <strong>
                      ${exam.maxViolations}
                    </strong>
                    violation(s) are allowed
                    before automatic termination.
                  `
                  : `
                    Anti-cheat monitoring is
                    disabled for this examination.
                  `
              }
            </li>

            <li>
              The examination will attempt
              to enter fullscreen mode.
            </li>

            <li>
              Do not switch tabs, minimize
              the browser or leave the
              examination window.
            </li>

            <li>
              Submit the Google Form first,
              then click the portal's
              <strong>
                Submit Exam
              </strong>
              button.
            </li>

            <li>
              Do not refresh or close the
              page while the exam is active.
            </li>

          </ul>

          ${
            antiCheat
              ? `
                <div
                  class="notice danger-notice">

                  Fullscreen, tab visibility,
                  window focus and restricted
                  shortcuts may be monitored.

                  Browser limitations mean
                  this is a detection and
                  deterrence layer, not a
                  guarantee against cheating.

                </div>
              `
              : ''
          }

        </div>

        <div class="modal-footer">

          <button
            class="secondary-btn"
            data-action="close-modal">
            Cancel
          </button>

          <button
            class="primary-btn"
            data-action="confirm-start"
            data-id="${exam.id}">
            Start Examination
          </button>

        </div>

      </div>
    `;

    bindActions();
  }

  /* ================================================================
     CREATE EXAM SESSION
  ================================================================ */

  function confirmStart(id) {
    closeModal();

    const exam =
      db.exams.find(
        item => item.id === id
      );

    const user =
      currentUser();

    if (!exam || !user) return;

    const timerEnabled =
      boolSetting(
        exam.timerEnabled,
        false
      );

    const durationMinutes =
      Math.max(
        1,
        Math.round(
          Number(
            exam.durationMinutes
          ) || 60
        )
      );

    const antiCheat =
      boolSetting(
        exam.antiCheat,
        false
      );

    const maxViolations =
      Math.max(
        1,
        Math.round(
          Number(
            exam.maxViolations
          ) || 3
        )
      );

    /*
      Normalize exam settings.
    */
    exam.timerEnabled =
      timerEnabled;

    exam.durationMinutes =
      durationMinutes;

    exam.antiCheat =
      antiCheat;

    exam.maxViolations =
      maxViolations;

    saveDB();

    const now =
      Date.now();

    const attempt = {
      id: uid('attempt'),

      examId:
        exam.id,

      examTitle:
        exam.title,

      username:
        user.username,

      userId:
        user.id,

      startedAt:
        now,

      endedAt:
        null,

      status:
        'In Progress',

      violations:
        0,

      durationSeconds:
        0
    };

    db.attempts.push(
      attempt
    );

    saveDB();

    currentExam =
      clone(exam);

    examState = {
      attemptId:
        attempt.id,

      seconds:
        timerEnabled
          ? durationMinutes * 60
          : 0,

      timerEnabled,

      antiCheat,

      maxViolations,

      startedAt:
        now,

      active:
        true
    };

    prepareExamInterface();

    showView('exam');

    document.body.classList.add(
      'lockdown-active'
    );

    $('#exam-view')?.classList.add(
      'lockdown-active'
    );

    graceUntil =
      Date.now() + GRACE;

    /*
      Always request fullscreen during an
      examination session.

      Browsers only allow this after a
      user interaction, which is why this
      happens immediately after clicking
      Start Examination.
    */
    requestFullscreen().finally(() => {
      graceUntil =
        Date.now() + GRACE;
    });

    renderTimer();

    if (timerEnabled) {
      startTimer();
    }
  }

  function resumeExam(
    exam,
    attempt
  ) {
    closeModal();

    const timerEnabled =
      boolSetting(
        exam.timerEnabled,
        false
      );

    const durationMinutes =
      Math.max(
        1,
        Math.round(
          Number(
            exam.durationMinutes
          ) || 60
        )
      );

    const antiCheat =
      boolSetting(
        exam.antiCheat,
        false
      );

    const maxViolations =
      Math.max(
        1,
        Math.round(
          Number(
            exam.maxViolations
          ) || 3
        )
      );

    const elapsedSeconds =
      Math.floor(
        (
          Date.now() -
          Number(
            attempt.startedAt
          )
        ) / 1000
      );

    const remainingSeconds =
      Math.max(
        0,
        durationMinutes * 60 -
          elapsedSeconds
      );

    currentExam =
      clone(exam);

    examState = {
      attemptId:
        attempt.id,

      seconds:
        timerEnabled
          ? remainingSeconds
          : 0,

      timerEnabled,

      antiCheat,

      maxViolations,

      startedAt:
        Number(
          attempt.startedAt
        ),

      active:
        true
    };

    /*
      If the timer expired while the
      browser was closed, terminate it.
    */
    if (
      timerEnabled &&
      remainingSeconds <= 0
    ) {
      finishExam(
        'Time Expired',
        'Time Expired',
        'Your allotted examination time has ended.',
        '⌛'
      );

      return;
    }

    prepareExamInterface();

    showView('exam');

    document.body.classList.add(
      'lockdown-active'
    );

    $('#exam-view')?.classList.add(
      'lockdown-active'
    );

    graceUntil =
      Date.now() + GRACE;

    requestFullscreen().finally(() => {
      graceUntil =
        Date.now() + GRACE;
    });

    renderTimer();

    if (timerEnabled) {
      startTimer();
    }
  }

  function prepareExamInterface() {
    const attempt =
      db.attempts.find(
        item =>
          item.id ===
          examState.attemptId
      );

    $('#live-exam-title').textContent =
      currentExam?.title ||
      'Examination';

    $('#live-exam-examiner').textContent =
      'Assigned to ' +
      (
        currentUser()?.username ||
        'Examiner'
      );

    $('#exam-violations').textContent =
      `${attempt?.violations || 0} / ${examState.maxViolations}`;

    $('#exam-iframe').src =
      currentExam?.formUrl ||
      DEFAULT_FORM;

    $('#exam-instructions').textContent =
      examState.timerEnabled
        ? `Timer: ${currentExam.durationMinutes} minutes • Anti-cheat: ${
            examState.antiCheat
              ? 'Enabled'
              : 'Disabled'
          } • Submit the Google Form, then click Submit Exam.`
        : `No timer • Anti-cheat: ${
            examState.antiCheat
              ? 'Enabled'
              : 'Disabled'
          } • Submit the Google Form, then click Submit Exam.`;

    if ($('#exam-submit-btn')) {
      $('#exam-submit-btn').disabled =
        false;
    }

    $('#violation-overlay').hidden =
      true;

    violationOverlayOpen =
      false;

    if ($('#exam-iframe')) {
      $('#exam-iframe').style.filter =
        '';
    }
  }

  /* ================================================================
     FULLSCREEN
  ================================================================ */

  function requestFullscreen() {
    const element =
      document.documentElement;

    const fn =
      element.requestFullscreen ||
      element.webkitRequestFullscreen ||
      element.mozRequestFullScreen;

    if (!fn) {
      return Promise.resolve();
    }

    try {
      return Promise.resolve(
        fn.call(element)
      ).catch(() => {});
    } catch (error) {
      return Promise.resolve();
    }
  }

  function exitFullscreen() {
    const fn =
      document.exitFullscreen ||
      document.webkitExitFullscreen ||
      document.mozCancelFullScreen;

    if (
      fn &&
      isFullscreen()
    ) {
      try {
        Promise.resolve(
          fn.call(document)
        ).catch(() => {});
      } catch (error) {}
    }
  }

  function isFullscreen() {
    return Boolean(
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.mozFullScreenElement
    );
  }

  /* ================================================================
     TIMER
  ================================================================ */

  function startTimer() {
    clearInterval(timer);

    renderTimer();

    timer = setInterval(() => {
      if (
        !examState?.active
      ) {
        clearInterval(timer);
        return;
      }

      examState.seconds--;

      renderTimer();

      if (
        examState.seconds <= 0
      ) {
        clearInterval(timer);

        finishExam(
          'Time Expired',
          'Time Expired',
          'Your allotted examination time has ended.',
          '⌛'
        );
      }
    }, 1000);
  }

  function renderTimer() {
    const seconds =
      Math.max(
        0,
        Number(
          examState?.seconds
        ) || 0
      );

    const minutes =
      Math.floor(
        seconds / 60
      )
        .toString()
        .padStart(2, '0');

    const remaining =
      (
        seconds % 60
      )
        .toString()
        .padStart(2, '0');

    const timerElement =
      $('#exam-timer');

    if (timerElement) {
      timerElement.textContent =
        examState?.timerEnabled
          ? `${minutes}:${remaining}`
          : 'No Timer';

      timerElement.classList.toggle(
        'warning',
        seconds <= 300 &&
          seconds > 60
      );

      timerElement.classList.toggle(
        'danger',
        seconds <= 60 &&
          Boolean(
            examState?.timerEnabled
          )
      );
    }

    const duration =
      Math.max(
        1,
        Math.round(
          Number(
            currentExam?.durationMinutes
          ) || 60
        )
      );

    const percentage =
      examState?.timerEnabled
        ? Math.max(
            0,
            Math.min(
              100,
              (
                seconds /
                (duration * 60)
              ) *
                100
            )
          )
        : 0;

    const progress =
      $('#exam-progress');

    if (progress) {
      progress.style.width =
        100 - percentage + '%';
    }
  }

  /* ================================================================
     PROCTORING / ANTI-CHEAT
  ================================================================ */

  function registerViolation(
    reason
  ) {
    if (
      !examState?.active ||
      !examState.antiCheat
    ) {
      return;
    }

    const now =
      Date.now();

    if (
      now < graceUntil ||
      now - lastViolation <
        DEBOUNCE ||
      violationOverlayOpen
    ) {
      return;
    }

    lastViolation =
      now;

    const attempt =
      db.attempts.find(
        item =>
          item.id ===
          examState.attemptId
      );

    if (!attempt) return;

    const number =
      (
        attempt.violations ||
        0
      ) + 1;

    attempt.violations =
      number;

    db.violations.push({
      id: uid('vio'),

      attemptId:
        attempt.id,

      examId:
        currentExam.id,

      examTitle:
        currentExam.title,

      username:
        attempt.username,

      number,

      reason,

      timestamp:
        now
    });

    saveDB();

    $('#exam-violations').textContent =
      `${number} / ${examState.maxViolations}`;

    /*
      Maximum violations reached:
      immediately terminate the exam.
    */
    if (
      number >=
      examState.maxViolations
    ) {
      finishExam(
        'Terminated',
        'Exam Terminated',
        'You have been disqualified for exceeding the maximum allowed violations.',
        '×',
        true
      );

      return;
    }

    showViolationOverlay(
      reason
    );
  }

  function showViolationOverlay(
    reason
  ) {
    if (
      !examState?.active ||
      !examState.antiCheat
    ) {
      return;
    }

    violationOverlayOpen =
      true;

    $('#violation-reason').textContent =
      reason;

    const attempt =
      db.attempts.find(
        item =>
          item.id ===
          examState.attemptId
      );

    $('#overlay-count').textContent =
      attempt?.violations ||
      0;

    $('#overlay-max').textContent =
      examState.maxViolations;

    $('#violation-overlay').hidden =
      false;

    if ($('#exam-iframe')) {
      $('#exam-iframe').style.filter =
        'blur(6px) brightness(.45)';
    }
  }

  /* ================================================================
     RESUME AFTER VIOLATION
  ================================================================ */

  $('#resume-exam-btn')?.addEventListener(
    'click',
    async () => {
      if (
        !examState?.active
      ) {
        return;
      }

      $('#violation-overlay').hidden =
        true;

      violationOverlayOpen =
        false;

      if ($('#exam-iframe')) {
        $('#exam-iframe').style.filter =
          '';
      }

      graceUntil =
        Date.now() + GRACE;

      await requestFullscreen();

      graceUntil =
        Date.now() + GRACE;
    }
  );

  /* ================================================================
     FULLSCREEN MONITOR
  ================================================================ */

  [
    'fullscreenchange',
    'webkitfullscreenchange',
    'mozfullscreenchange'
  ].forEach(eventName => {
    document.addEventListener(
      eventName,
      () => {
        if (
          examState?.active &&
          examState.antiCheat &&
          !isFullscreen() &&
          Date.now() >
            graceUntil
        ) {
          registerViolation(
            'You exited full-screen mode.'
          );
        }
      }
    );
  });

  /* ================================================================
     TAB / WINDOW MONITOR
  ================================================================ */

  document.addEventListener(
    'visibilitychange',
    () => {
      if (
        examState?.active &&
        examState.antiCheat &&
        document.hidden
      ) {
        registerViolation(
          'You switched tabs or minimized the window.'
        );
      }
    }
  );

  window.addEventListener(
    'blur',
    () => {
      if (
        examState?.active &&
        examState.antiCheat
      ) {
        registerViolation(
          'The exam window lost focus.'
        );
      }
    }
  );

  /* ================================================================
     BLOCK COMMON COPY / CONTEXT ACTIONS
  ================================================================ */

  document.addEventListener(
    'contextmenu',
    event => {
      if (
        examState?.active &&
        examState.antiCheat
      ) {
        event.preventDefault();
      }
    }
  );

  document.addEventListener(
    'copy',
    event => {
      if (
        examState?.active &&
        examState.antiCheat
      ) {
        event.preventDefault();
      }
    }
  );

  document.addEventListener(
    'cut',
    event => {
      if (
        examState?.active &&
        examState.antiCheat
      ) {
        event.preventDefault();
      }
    }
  );

  document.addEventListener(
    'paste',
    event => {
      if (
        examState?.active &&
        examState.antiCheat
      ) {
        event.preventDefault();
      }
    }
  );

  /* ================================================================
     RESTRICTED KEYBOARD SHORTCUTS
  ================================================================ */

  document.addEventListener(
    'keydown',
    event => {
      if (
        !examState?.active ||
        !examState.antiCheat
      ) {
        return;
      }

      const key =
        (
          event.key ||
          ''
        ).toLowerCase();

      const modifier =
        event.ctrlKey ||
        event.metaKey;

      const restricted =
        key === 'f12' ||

        (
          modifier &&
          event.shiftKey &&
          ['i', 'j', 'c'].includes(
            key
          )
        ) ||

        (
          modifier &&
          ['t', 'n', 'w', 'u'].includes(
            key
          )
        ) ||

        (
          event.altKey &&
          key === 'tab'
        );

      if (restricted) {
        event.preventDefault();

        const shortcut =
          [
            event.ctrlKey
              ? 'Ctrl'
              : '',

            event.metaKey
              ? 'Cmd'
              : '',

            event.altKey
              ? 'Alt'
              : '',

            event.shiftKey
              ? 'Shift'
              : '',

            event.key
          ]
            .filter(Boolean)
            .join('+');

        registerViolation(
          `Restricted shortcut attempt: ${shortcut}`
        );
      }
    }
  );

  /* ================================================================
     BEFORE UNLOAD
  ================================================================ */

  window.addEventListener(
    'beforeunload',
    event => {
      if (
        examState?.active
      ) {
        event.preventDefault();
        event.returnValue = '';
      }
    }
  );

  /* ================================================================
     SUBMIT EXAM
  ================================================================ */

  $('#exam-submit-btn')?.addEventListener(
    'click',
    () => {
      if (
        !examState?.active
      ) {
        return;
      }

      const confirmed =
        confirm(
          'Confirm that you have submitted the Google Form.\n\n' +
          'This will permanently end this exam attempt and cannot be undone.'
        );

      if (!confirmed) {
        return;
      }

      finishExam(
        'Completed',
        'Thank you for taking the exam!',
        'Your examination session has been submitted successfully.',
        '✓',
        false
      );
    }
  );

  /* ================================================================
     FINISH EXAM
  ================================================================ */

  function finishExam(
    status,
    title,
    message,
    icon,
    terminated = false
  ) {
    if (
      !examState?.active
    ) {
      return;
    }

    examState.active =
      false;

    clearInterval(timer);

    timer = null;

    const attempt =
      db.attempts.find(
        item =>
          item.id ===
          examState.attemptId
      );

    const endedAt =
      Date.now();

    if (attempt) {
      attempt.status =
        status;

      attempt.endedAt =
        endedAt;

      attempt.durationSeconds =
        Math.max(
          0,
          Math.floor(
            (
              endedAt -
              (
                attempt.startedAt ||
                endedAt
              )
            ) / 1000
          )
        );
    }

    saveDB();

    $('#violation-overlay').hidden =
      true;

    violationOverlayOpen =
      false;

    document.body.classList.remove(
      'lockdown-active'
    );

    $('#exam-view')?.classList.remove(
      'lockdown-active'
    );

    /*
      Exit fullscreen only after the
      exam session has been finalized.
    */
    exitFullscreen();

    if ($('#result-icon')) {
      $('#result-icon').textContent =
        icon;

      $('#result-icon').style.color =
        terminated
          ? 'var(--danger)'
          : 'var(--success)';

      $('#result-icon').style.background =
        terminated
          ? 'rgba(239,91,103,.12)'
          : 'rgba(49,196,141,.12)';
    }

    if ($('#result-eyebrow')) {
      $('#result-eyebrow').textContent =
        terminated
          ? 'EXAM TERMINATED'
          : status === 'Time Expired'
          ? 'TIME EXPIRED'
          : 'EXAM COMPLETE';
    }

    if ($('#result-title')) {
      $('#result-title').textContent =
        title;
    }

    if ($('#result-message')) {
      $('#result-message').textContent =
        message;
    }

    if ($('#result-exam')) {
      $('#result-exam').textContent =
        currentExam?.title ||
        '—';
    }

    if ($('#result-user')) {
      $('#result-user').textContent =
        currentUser()?.username ||
        '—';
    }

    if ($('#result-violations')) {
      $('#result-violations').textContent =
        attempt?.violations ||
        0;
    }

    if ($('#result-ended')) {
      $('#result-ended').textContent =
        fmtDate(endedAt);
    }

    /*
      If result-time exists in index.html,
      populate it automatically.
    */
    if ($('#result-time')) {
      $('#result-time').textContent =
        formatDuration(
          attempt?.durationSeconds ||
            0
        );
    }

    showView('result');
  }

  /* ================================================================
     RESULT DASHBOARD BUTTON
  ================================================================ */

  $('#result-dashboard-btn')?.addEventListener(
    'click',
    () => {
      currentExam = null;
      examState = null;

      openPortal();
    }
  );

  /* ================================================================
     VIOLATION UI GUARD
  ================================================================ */

  function syncViolationOverlay() {
    const overlay =
      document.getElementById(
        'violation-overlay'
      );

    if (!overlay) return;

    if (
      !examState?.active
    ) {
      violationOverlayOpen =
        false;

      overlay.hidden =
        true;
    }
  }

  syncViolationOverlay();

  /* ================================================================
     ACTION BINDING
  ================================================================ */

  function bindActions() {
    $$('[data-action]').forEach(
      button => {
        if (
          button.dataset.bound
        ) {
          return;
        }

        button.dataset.bound =
          '1';

        button.addEventListener(
          'click',
          () => {
            const action =
              button.dataset.action;

            const id =
              button.dataset.id;

            if (
              action ===
              'new-exam'
            ) {
              openExamModal();
            }

            if (
              action ===
              'edit-exam'
            ) {
              openExamModal(id);
            }

            if (
              action ===
              'delete-exam'
            ) {
              deleteExam(id);
            }

            if (
              action ===
              'close-modal'
            ) {
              closeModal();
            }

            if (
              action ===
              'confirm-start'
            ) {
              confirmStart(id);
            }

            if (
              action ===
              'start-exam'
            ) {
              startExam(id);
            }

            if (
              action ===
              'view-submissions'
            ) {
              adminPage(
                'submissions'
              );
            }

            if (
              action ===
              'refresh-admin'
            ) {
              db = loadDB();

              const title =
                $(
                  '#admin-page-title'
                )?.textContent ||
                'Dashboard';

              const page =
                Object.keys(
                  pageTitles
                ).find(
                  key =>
                    pageTitles[key] ===
                    title
                ) ||
                'dashboard';

              renderAdminPage(
                page
              );
            }

            if (
              action ===
              'toggle-theme'
            ) {
              toggleTheme();
            }

            if (
              action ===
              'reset-demo'
            ) {
              resetDemo();
            }

            if (
              action ===
              'delete-user'
            ) {
              deleteUser(id);
            }
          }
        );
      }
    );
  }

  /* ================================================================
     USER MANAGEMENT
  ================================================================ */

  function deleteUser(id) {
    if (
      db.users.length <= 1
    ) {
      return;
    }

    const user =
      db.users.find(
        item =>
          item.id === id
      );

    if (!user) return;

    /*
      Do not allow deletion of
      the built-in admin account.
    */
    if (
      user.username ===
      'admin'
    ) {
      toast(
        'The built-in admin account cannot be deleted.',
        'error'
      );

      return;
    }

    const confirmed =
      confirm(
        `Delete user "${user.username}"?`
      );

    if (!confirmed) return;

    db.users =
      db.users.filter(
        item =>
          item.id !== id
      );

    saveDB();

    renderSettings();

    toast(
      'User deleted.',
      'success'
    );
  }

  /* ================================================================
     RESET DEMO
  ================================================================ */

  function resetDemo() {
    const confirmed =
      confirm(
        'Reset all demo data, exams, attempts and violation logs?'
      );

    if (!confirmed) {
      return;
    }

    db = clone(seed);

    saveDB();

    applyTheme();

    toast(
      'Demo data reset successfully.',
      'success'
    );

    openAdmin();
  }

  /* ================================================================
     CLOCKS
  ================================================================ */

  setInterval(() => {
    const now =
      new Date().toLocaleString();

    if ($('#admin-clock')) {
      $('#admin-clock').textContent =
        now;
    }

    if ($('#examiner-clock')) {
      $('#examiner-clock').textContent =
        now;
    }

    /*
      Refresh examiner availability
      while they remain on the dashboard.
    */
    if (
      views.examiner &&
      !views.examiner.hidden &&
      !examState?.active
    ) {
      /*
        Do not continuously rerender
        every second. Availability is
        refreshed when the dashboard is
        opened/refreshed.
      */
    }
  }, 1000);

  /* ================================================================
     INITIALIZE
  ================================================================ */

  function initializePortal() {
    const required = [
      '#login-view',
      '#admin-view',
      '#examiner-view',
      '#exam-view',
      '#result-view',
      '#login-form',
      '#examiner-dashboard-page',
      '#exam-iframe',
      '#exam-submit-btn'
    ];

    const missing =
      required.filter(
        selector =>
          !$(selector)
      );

    if (missing.length) {
      console.warn(
        'Proctor+ missing UI elements:',
        missing
      );
    }

    syncViolationOverlay();

    /*
      If a previous login session exists,
      restore the portal.
    */
    if (
      session &&
      currentUser()
    ) {
      openPortal();
    } else {
      session = null;
      saveSession();
      showView('login');
    }
  }

  initializePortal();

})();
