/* ============================================================
   PROCTOR+ ONLINE EXAM PORTAL
   Room-Based Examination System
   ============================================================

   IMPORTANT:
   This is a browser/localStorage prototype.

   Room login:
     Room Number + Passcode

   Admin:
     Username: admin
     Password: 123admin

   Multiple users may enter the same room.
   Multiple submissions are allowed.
   Every submission creates a separate attempt.

   For true multi-PC synchronization, authentication,
   rooms, submissions and violations must eventually
   be moved to a server/database.
============================================================ */

(() => {
'use strict';

/* ============================================================
   STORAGE
============================================================ */

const KEY = 'proctor_plus_v3';
const SESSION = 'proctor_plus_session_v3';

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
    }
  ],

  exams: [
    {
      id: 'exam-demo',
      title: 'Demo Examination',
      description: 'Sample Proctor+ examination room.',
      formUrl: DEFAULT_FORM,

      roomNumber: 'ROOM-001',
      passcode: '123456',

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

/* ============================================================
   STATE
============================================================ */

let db = loadDB();
let session = loadSession();

let currentExam = null;
let currentAttempt = null;
let examState = null;

let timer = null;

let violationOverlayOpen = false;
let graceUntil = 0;
let lastViolation = 0;

const DEBOUNCE = 650;
const GRACE = 1500;

/* ============================================================
   HELPERS
============================================================ */

const $ = selector =>
  document.querySelector(selector);

const $$ = selector =>
  [...document.querySelectorAll(selector)];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function safeGet(storage, key) {
  try {
    return storage.getItem(key);
  } catch (e) {
    console.warn('Storage read failed:', e);
    return null;
  }
}

function safeSet(storage, key, value) {
  try {
    storage.setItem(key, value);
    return true;
  } catch (e) {
    console.warn('Storage write failed:', e);
    return false;
  }
}

function safeRemove(storage, key) {
  try {
    storage.removeItem(key);
  } catch (e) {
    console.warn('Storage remove failed:', e);
  }
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
    c => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[c])
  );
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

function fmtTime(timestamp) {
  if (!timestamp) return '—';

  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  });
}

/* ============================================================
   DATABASE
============================================================ */

function loadDB() {
  let stored = {};

  try {
    const raw = safeGet(localStorage, KEY);

    if (raw) {
      try {
        stored = JSON.parse(raw) || {};
      } catch (e) {
        stored = {};
      }
    }
  } catch (e) {
    stored = {};
  }

  const users =
    Array.isArray(stored.users)
      ? stored.users
      : [];

  /*
    Always repair the default admin account.
  */

  const admin = users.find(
    u =>
      String(u?.username || '')
        .trim()
        .toLowerCase() === 'admin'
  );

  if (!admin) {
    users.push(clone(seed.users[0]));
  } else {
    admin.username = 'admin';
    admin.password = '123admin';
    admin.role = 'admin';
    admin.name = 'Administrator';
  }

  const repaired = {
    ...clone(seed),
    ...stored,

    users,

    exams:
      Array.isArray(stored.exams)
        ? stored.exams
        : clone(seed.exams),

    attempts:
      Array.isArray(stored.attempts)
        ? stored.attempts
        : [],

    violations:
      Array.isArray(stored.violations)
        ? stored.violations
        : [],

    theme:
      stored.theme === 'light'
        ? 'light'
        : 'dark'
  };

  /*
    If no exams exist, restore the demo exam.
  */

  if (!repaired.exams.length) {
    repaired.exams = clone(seed.exams);
  }

  /*
    Repair older exams that may still have examiner
    credentials instead of room credentials.
  */

  repaired.exams.forEach(exam => {

    if (!exam.roomNumber) {
      exam.roomNumber =
        exam.examinerUsername ||
        'ROOM-' +
        Math.floor(
          100 + Math.random() * 900
        );
    }

    if (!exam.passcode) {
      exam.passcode =
        exam.examinerPassword ||
        '123456';
    }

    delete exam.examinerUsername;
    delete exam.examinerPassword;
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

/* ============================================================
   SESSION
============================================================ */

function loadSession() {
  try {
    return JSON.parse(
      safeGet(sessionStorage, SESSION) || 'null'
    );
  } catch (e) {
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
    safeRemove(
      sessionStorage,
      SESSION
    );
  }
}

function currentUser() {
  if (!session) return null;

  return (
    db.users.find(
      u => u.id === session.userId
    ) ||
    db.users.find(
      u =>
        String(u.username || '')
          .toLowerCase() ===
        String(session.username || '')
          .toLowerCase()
    ) ||
    null
  );
}

/* ============================================================
   VIEWS
============================================================ */

const views = {
  login: $('#login-view'),
  admin: $('#admin-view'),
  examiner: $('#examiner-view'),
  exam: $('#exam-view'),
  result: $('#result-view')
};

function showView(name) {

  Object.values(views).forEach(view => {
    if (view) view.hidden = true;
  });

  if (views[name]) {
    views[name].hidden = false;
  }

  window.scrollTo(0, 0);
}

/* ============================================================
   TOAST
============================================================ */

function toast(message, type = '') {

  const container =
    $('#toast-container');

  if (!container) return;

  const item =
    document.createElement('div');

  item.className =
    'toast ' + type;

  item.textContent = message;

  container.appendChild(item);

  setTimeout(
    () => item.remove(),
    3000
  );
}

/* ============================================================
   THEME
============================================================ */

function applyTheme() {

  const light =
    db.theme === 'light';

  document.documentElement.dataset.theme =
    light ? 'light' : 'dark';

  document.body.classList.toggle(
    'light',
    light
  );

  document.body.classList.toggle(
    'dark',
    !light
  );

  [
    'theme-toggle-login',
    'theme-toggle-admin',
    'theme-toggle-examiner'
  ].forEach(id => {

    const button =
      $('#' + id);

    if (!button) return;

    button.textContent =
      light ? '☾' : '☼';

    button.setAttribute(
      'aria-label',
      light
        ? 'Switch to dark mode'
        : 'Switch to light mode'
    );
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

/* ============================================================
   LOGIN ERROR
============================================================ */

function showLoginError(message) {

  const error =
    $('#login-error');

  if (!error) return;

  error.textContent =
    message;

  error.hidden = false;
  error.style.display = 'block';
}

function clearLoginError() {

  const error =
    $('#login-error');

  if (!error) return;

  error.textContent = '';
  error.hidden = true;
  error.style.display = 'none';
}

/* ============================================================
   LOGIN
============================================================ */

function handleLogin(event) {

  event.preventDefault();

  clearLoginError();

  const roomInput =
    $('#login-room');

  const passInput =
    $('#login-passcode');

  const form =
    $('#login-form');

  if (!roomInput || !passInput) {

    showLoginError(
      'Room login form could not be loaded. Please refresh the page.'
    );

    return false;
  }

  const room =
    String(
      roomInput.value || ''
    ).trim();

  const passcode =
    String(
      passInput.value || ''
    ).trim();

  if (!room || !passcode) {

    showLoginError(
      'Please enter the Room Number and Passcode.'
    );

    if (!room) {
      roomInput.focus();
    } else {
      passInput.focus();
    }

    return false;
  }

  db = loadDB();

  const exam =
    db.exams.find(
      e =>
        String(e.roomNumber || '')
          .trim()
          .toLowerCase() ===
          room.toLowerCase() &&

        String(e.passcode || '') ===
          passcode
    );

  if (!exam) {

    showLoginError(
      'Invalid Room Number or Passcode.'
    );

    passInput.value = '';
    passInput.focus();

    if (form) {
      form.classList.remove(
        'login-error-shake'
      );

      void form.offsetWidth;

      form.classList.add(
        'login-error-shake'
      );
    }

    return false;
  }

  if (exam.active === false) {

    showLoginError(
      'This examination room is currently disabled.'
    );

    return false;
  }

  const availability =
    getAvailability(exam);

  if (availability.status !== 'Available') {

    showLoginError(
      'This examination room is not currently available.'
    );

    return false;
  }

  /*
    A room session does NOT represent one person.

    Each browser/device gets its own temporary
    participant ID so multiple people can use
    the same room.
  */

  const participantId =
    'P-' +
    Math.random()
      .toString(36)
      .slice(2, 10)
      .toUpperCase();

  session = {
    userId: participantId,
    username: participantId,
    role: 'examiner',
    roomNumber: exam.roomNumber,
    examId: exam.id,
    loginAt: Date.now()
  };

  saveSession();

  currentExam = null;
  currentAttempt = null;
  examState = null;

  syncViolationOverlay();

  openPortal();

  return false;
}

/* ============================================================
   ADMIN LOGIN
============================================================ */

function openAdminLogin() {

  const modalRoot =
    $('#modal-root');

  if (!modalRoot) return;

  modalRoot.hidden = false;

  modalRoot.innerHTML = `
    <div class="modal admin-login-modal">

      <div class="modal-head">

        <div>
          <span class="eyebrow">
            ADMINISTRATOR
          </span>

          <h3>
            Admin Login
          </h3>
        </div>

        <button
          type="button"
          class="close-btn"
          data-action="close-modal"
          aria-label="Close"
        >
          ×
        </button>

      </div>

      <form id="admin-login-form">

        <div class="modal-body">

          <div class="field">

            <label class="form-label">
              Username
            </label>

            <input
              id="admin-username"
              type="text"
              autocomplete="username"
              placeholder="Admin username"
              required
            >

          </div>

          <div class="field">

            <label class="form-label">
              Password
            </label>

            <input
              id="admin-password"
              type="password"
              autocomplete="current-password"
              placeholder="Admin password"
              required
            >

          </div>

          <div
            id="admin-login-error"
            class="error-text"
            hidden
          ></div>

        </div>

        <div class="modal-footer">

          <button
            type="button"
            class="secondary-btn"
            data-action="close-modal"
          >
            Cancel
          </button>

          <button
            type="submit"
            class="primary-btn"
          >
            Sign In
          </button>

        </div>

      </form>

    </div>
  `;

  $('#admin-login-form')
    ?.addEventListener(
      'submit',
      handleAdminLogin
    );
}

function handleAdminLogin(event) {

  event.preventDefault();

  const username =
    String(
      $('#admin-username')?.value || ''
    ).trim();

  const password =
    String(
      $('#admin-password')?.value || ''
    );

  const error =
    $('#admin-login-error');

  db = loadDB();

  const user =
    db.users.find(
      u =>
        String(u.username || '')
          .toLowerCase() ===
          username.toLowerCase() &&

        String(u.password || '') ===
          password &&

        u.role === 'admin'
    );

  if (!user) {

    if (error) {
      error.textContent =
        'Incorrect admin username or password.';

      error.hidden = false;
    }

    return;
  }

  session = {
    userId: user.id,
    username: user.username,
    role: 'admin',
    loginAt: Date.now()
  };

  saveSession();

  closeModal();

  openPortal();
}

/* ============================================================
   AUTH INITIALIZATION
============================================================ */

function initAuthentication() {

  const form =
    $('#login-form');

  if (
    form &&
    form.dataset.authBound !== '1'
  ) {

    form.addEventListener(
      'submit',
      handleLogin
    );

    form.dataset.authBound = '1';
  }

  const adminButton =
    $('#admin-login-link');

  if (
    adminButton &&
    adminButton.dataset.bound !== '1'
  ) {

    adminButton.addEventListener(
      'click',
      openAdminLogin
    );

    adminButton.dataset.bound = '1';
  }
}

/* ============================================================
   PORTAL
============================================================ */

function openPortal() {

  const user =
    currentUser();

  if (!user && session?.role !== 'examiner') {

    session = null;

    saveSession();

    showView('login');

    return;
  }

  if (
    session?.role === 'admin' ||
    user?.role === 'admin'
  ) {

    openAdmin();

    return;
  }

  if (
    session?.role === 'examiner'
  ) {

    openExaminer();

    return;
  }

  session = null;

  saveSession();

  showView('login');
}

/* ============================================================
   LOGOUT
============================================================ */

function logout() {

  session = null;

  saveSession();

  currentExam = null;
  currentAttempt = null;
  examState = null;

  clearInterval(timer);

  timer = null;

  violationOverlayOpen = false;

  document.body.classList.remove(
    'lockdown-active'
  );

  $('#exam-view')
    ?.classList.remove(
      'lockdown-active'
    );

  syncViolationOverlay();

  showView('login');

  $('#login-form')?.reset();

  clearLoginError();
}

/* ============================================================
   SIDEBAR
============================================================ */

$$('[data-toggle-sidebar]')
  .forEach(button => {

    button.addEventListener(
      'click',
      () => {

        const sidebar =
          $('#' + button.dataset.toggleSidebar);

        sidebar?.classList.toggle(
          'open'
        );
      }
    );
  });

$$('[data-admin-page]')
  .forEach(button => {

    button.addEventListener(
      'click',
      () =>
        adminPage(
          button.dataset.adminPage
        )
    );
  });

$$('[data-examiner-page]')
  .forEach(button => {

    button.addEventListener(
      'click',
      () =>
        examinerPage(
          button.dataset.examinerPage
        )
    );
  });

const pageTitles = {

  dashboard: 'Dashboard',
  exams: 'Exam Management',
  submissions: 'Submissions',
  violations: 'Violation Logs',
  analytics: 'Analytics',
  settings: 'Settings'
};

/* ============================================================
   ADMIN
============================================================ */

function openAdmin() {

  const user =
    currentUser();

  if (!user) {

    showView('login');

    return;
  }

  $('#admin-user-name').textContent =
    user.name ||
    user.username;

  $('#admin-user-role').textContent =
    'Administrator';

  $('#admin-avatar').textContent =
    (
      user.name ||
      user.username ||
      'A'
    )[0].toUpperCase();

  showView('admin');

  adminPage('dashboard');
}

function adminPage(page) {

  page =
    pageTitles[page]
      ? page
      : 'dashboard';

  $$('[data-admin-page]')
    .forEach(button => {

      button.classList.toggle(
        'active',
        button.dataset.adminPage === page
      );
    });

  $$('.admin-page')
    .forEach(pageElement => {

      pageElement.classList.remove(
        'active'
      );
    });

  const target =
    $('#admin-' + page + '-page');

  target?.classList.add(
    'active'
  );

  const title =
    $('#admin-page-title');

  if (title) {
    title.textContent =
      pageTitles[page];
  }

  $('#admin-sidebar')
    ?.classList.remove(
      'open'
    );

  renderAdminPage(page);
}

function renderAdminPage(page) {

  const renderer = {

    dashboard:
      renderAdminDashboard,

    exams:
      renderAdminExams,

    submissions:
      renderSubmissions,

    violations:
      renderViolations,

    analytics:
      renderAnalytics,

    settings:
      renderSettings

  }[page];

  if (renderer) {
    renderer();
  }
}

/* ============================================================
   ADMIN DASHBOARD
============================================================ */

function attemptCounts() {

  const attempts =
    db.attempts;

  return {

    total:
      attempts.length,

    inProgress:
      attempts.filter(
        x => x.status === 'In Progress'
      ).length,

    completed:
      attempts.filter(
        x => x.status === 'Completed'
      ).length,

    expired:
      attempts.filter(
        x => x.status === 'Time Expired'
      ).length,

    terminated:
      attempts.filter(
        x => x.status === 'Terminated'
      ).length
  };
}

function renderAdminDashboard() {

  const c =
    attemptCounts();

  const avg =
    db.attempts.length

      ? (
          db.attempts.reduce(
            (sum, attempt) =>
              sum +
              Number(
                attempt.violations || 0
              ),
            0
          ) /
          db.attempts.length
        ).toFixed(1)

      : '0.0';

  const completion =
    c.total
      ? Math.round(
          c.completed /
          c.total *
          100
        )
      : 0;

  const page =
    $('#admin-dashboard-page');

  if (!page) return;

  page.innerHTML = `

    <div class="page-head">

      <div>

        <span class="eyebrow">
          OVERVIEW
        </span>

        <h3>
          Exam Dashboard
        </h3>

        <p>
          Monitor examination rooms, submissions,
          completion and security events.
        </p>

      </div>

      <div class="actions">

        <button
          class="secondary-btn"
          data-action="new-exam"
        >
          + Add Exam
        </button>

      </div>

    </div>

    <div class="stat-grid">

      ${stat(
        'Total Submissions',
        c.total
      )}

      ${stat(
        'In Progress',
        c.inProgress
      )}

      ${stat(
        'Completed',
        c.completed,
        'success'
      )}

      ${stat(
        'Time Expired',
        c.expired,
        'warning'
      )}

      ${stat(
        'Terminated',
        c.terminated,
        'danger'
      )}

      ${stat(
        'Avg. Violations',
        avg
      )}

    </div>

    <div class="grid-2">

      <div class="panel">

        <h3>
          Overall Completion
        </h3>

        <div class="progress-bar">

          <div
            class="progress-fill"
            style="width:${completion}%"
          ></div>

        </div>

        <div class="progress-meta">

          <span>
            ${completion}% completed
          </span>

          <span>
            ${c.completed} of ${c.total}
          </span>

        </div>

      </div>

      <div class="panel">

        <h3>
          Exam Capacity
        </h3>

        <div class="quick-grid">

          <div class="quick-card">
            <strong>
              ${db.exams.length}
            </strong>
            <span>
              Active rooms
            </span>
          </div>

          <div class="quick-card">
            <strong>
              ${Math.max(
                0,
                MAX_EXAMS - db.exams.length
              )}
            </strong>
            <span>
              Slots available
            </span>
          </div>

          <div class="quick-card">
            <strong>
              ${db.violations.length}
            </strong>
            <span>
              Violations
            </span>
          </div>

        </div>

      </div>

    </div>

    <div
      class="panel"
      style="margin-top:18px"
    >

      <div
        class="page-head"
        style="margin-bottom:12px"
      >

        <div>

          <h3>
            Recent Submissions
          </h3>

          <p>
            Latest examination sessions.
          </p>

        </div>

        <button
          class="secondary-btn"
          data-action="view-submissions"
        >
          View All
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
          .slice(0, 10)
      )}

    </div>
  `;

  bindActions();
}

function stat(
  label,
  value,
  cls = ''
) {

  return `
    <div class="stat-card ${cls}">

      <span class="stat-label">
        ${label}
      </span>

      <span class="stat-value">
        ${value}
      </span>

    </div>
  `;
}

/* ============================================================
   SUBMISSION TABLE
============================================================ */

function submissionTable(rows) {

  if (!rows.length) {

    return `
      <div class="empty">
        No exam submissions yet.
      </div>
    `;
  }

  return `

    <div class="table-wrap">

      <table class="data-table">

        <thead>

          <tr>

            <th>Participant</th>
            <th>Room</th>
            <th>Exam</th>
            <th>Started</th>
            <th>Ended</th>
            <th>Status</th>
            <th>Violations</th>

          </tr>

        </thead>

        <tbody>

          ${rows.map(
            attempt => `

              <tr>

                <td>
                  ${esc(
                    attempt.participantId ||
                    attempt.username ||
                    'Participant'
                  )}
                </td>

                <td>
                  ${esc(
                    attempt.roomNumber ||
                    '—'
                  )}
                </td>

                <td>
                  ${esc(
                    attempt.examTitle
                  )}
                </td>

                <td>
                  ${fmtDate(
                    attempt.startedAt
                  )}
                </td>

                <td>
                  ${fmtDate(
                    attempt.endedAt
                  )}
                </td>

                <td>
                  ${badge(
                    attempt.status
                  )}
                </td>

                <td>
                  ${attempt.violations || 0}
                </td>

              </tr>
            `
          ).join('')}

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

/* ============================================================
   EXAM MANAGEMENT
============================================================ */

function renderAdminExams() {

  const slots =
    MAX_EXAMS - db.exams.length;

  $('#admin-exams-page').innerHTML = `

    <div class="page-head">

      <div>

        <span class="eyebrow">
          EXAM MANAGEMENT
        </span>

        <h3>
          Examination Rooms
        </h3>

        <p>
          Create examination rooms that can be
          accessed by multiple participants at the
          same time.
        </p>

        <div class="slot-note">
          ${db.exams.length}/${MAX_EXAMS}
          exam slots used
        </div>

      </div>

      <div class="actions">

        <button
          class="primary-btn"
          data-action="new-exam"
          ${slots <= 0 ? 'disabled' : ''}
        >
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
            <div class="panel">
              <div class="empty">
                No examination rooms created.
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
      a => a.examId === exam.id
    );

  return `

    <article class="exam-card">

      <div class="exam-card-top">

        <span
          class="badge ${
            exam.active
              ? 'green'
              : 'gray'
          }"
        >
          ${
            exam.active
              ? 'ACTIVE'
              : 'DISABLED'
          }
        </span>

        ${badge(
          availability.status
        )}

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

      <div class="room-code-box">

        <div>
          <span>
            Room Number
          </span>

          <strong>
            ${esc(
              exam.roomNumber
            )}
          </strong>
        </div>

        <div>
          <span>
            Passcode
          </span>

          <strong>
            ${esc(
              exam.passcode
            )}
          </strong>
        </div>

      </div>

      <div class="exam-meta">

        <div class="meta-box">

          <span>
            Timer
          </span>

          <strong>
            ${
              exam.timerEnabled
                ? exam.durationMinutes +
                  ' min'
                : 'Off'
            }
          </strong>

        </div>

        <div class="meta-box">

          <span>
            Anti-cheat
          </span>

          <strong>
            ${
              exam.antiCheat
                ? 'On'
                : 'Off'
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
            Submissions
          </span>

          <strong>
            ${attempts.length}
          </strong>

        </div>

      </div>

      <div class="exam-card-actions">

        <button
          class="secondary-btn"
          data-action="edit-exam"
          data-id="${exam.id}"
        >
          Edit
        </button>

        <button
          class="danger-btn"
          data-action="delete-exam"
          data-id="${exam.id}"
        >
          Delete
        </button>

      </div>

    </article>
  `;
}

/* ============================================================
   AVAILABILITY
============================================================ */

function getAvailability(exam) {

  if (
    !exam ||
    exam.active === false
  ) {
    return {
      status: 'Unavailable'
    };
  }

  const now =
    Date.now();

  const start =
    exam.startAt
      ? new Date(
          exam.startAt
        ).getTime()
      : null;

  const end =
    exam.endAt
      ? new Date(
          exam.endAt
        ).getTime()
      : null;

  if (
    Number.isFinite(start) &&
    now < start
  ) {
    return {
      status: 'Unavailable'
    };
  }

  if (
    Number.isFinite(end) &&
    now > end
  ) {
    return {
      status: 'Unavailable'
    };
  }

  return {
    status: 'Available'
  };
}

/* ============================================================
   EXAM MODAL
============================================================ */

function openExamModal(id = null) {

  const exam =
    id
      ? db.exams.find(
          x => x.id === id
        )
      : null;

  if (
    !exam &&
    db.exams.length >= MAX_EXAMS
  ) {

    toast(
      'Maximum of 6 exams reached. Delete an exam to free a slot.',
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

      roomNumber:
        'ROOM-' +
        Math.floor(
          100 + Math.random() * 900
        ),

      passcode:
        String(
          Math.floor(
            100000 +
            Math.random() * 900000
          )
        ),

      antiCheat: true,

      maxViolations: 3,

      timerEnabled: true,

      durationMinutes: 60,

      startAt: '',

      endAt: '',

      active: true
    };

  const isoLocal =
    value =>
      value
        ? new Date(value)
            .toISOString()
            .slice(0, 16)
        : '';

  const modalRoot =
    $('#modal-root');

  if (!modalRoot) return;

  modalRoot.hidden = false;

  modalRoot.innerHTML = `

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
                ? 'Update Examination'
                : 'Create Examination Room'
            }
          </h3>

        </div>

        <button
          type="button"
          class="close-btn"
          data-action="close-modal"
          aria-label="Close"
        >
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
                value="${esc(
                  data.title
                )}"
                placeholder="e.g. HR Certification Examination"
              >

            </div>

            <div class="field full-span">

              <label class="form-label">
                Description
              </label>

              <textarea
                name="description"
                rows="2"
                placeholder="Short description"
              >${esc(
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
                value="${esc(
                  data.formUrl
                )}"
                placeholder="https://docs.google.com/forms/..."
              >

              <div class="helper">
                Use the Google Form's viewform or embedded URL.
              </div>

            </div>

            <div class="field">

              <label class="form-label">
                Room Number
              </label>

              <input
                name="roomNumber"
                required
                value="${esc(
                  data.roomNumber
                )}"
                placeholder="ROOM-001"
              >

              <div class="helper">
                Participants use this number to enter the exam.
              </div>

            </div>

            <div class="field">

              <label class="form-label">
                Room Passcode
              </label>

              <input
                name="passcode"
                required
                value="${esc(
                  data.passcode
                )}"
                placeholder="123456"
              >

              <div class="helper">
                All participants assigned to this room use the same passcode.
              </div>

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
                value="${Number(
                  data.maxViolations || 3
                )}"
              >

            </div>

            <div class="field">

              <label class="form-label">
                Timer Duration
              </label>

              <input
                name="durationMinutes"
                type="number"
                min="1"
                max="1440"
                required
                value="${Number(
                  data.durationMinutes || 60
                )}"
              >

            </div>

            <div class="field full-span">

              <div class="checkbox-row">

                <input
                  id="antiCheat"
                  name="antiCheat"
                  type="checkbox"
                  ${
                    data.antiCheat
                      ? 'checked'
                      : ''
                  }
                >

                <label for="antiCheat">
                  Enable anti-cheat monitoring
                </label>

              </div>

              <div class="helper">
                Detects tab changes, focus loss, fullscreen exits and restricted shortcuts.
              </div>

            </div>

            <div class="field full-span">

              <div class="checkbox-row">

                <input
                  id="timerEnabled"
                  name="timerEnabled"
                  type="checkbox"
                  ${
                    data.timerEnabled
                      ? 'checked'
                      : ''
                  }
                >

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
                )}"
              >

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
                )}"
              >

            </div>

            <div class="field full-span">

              <div class="checkbox-row">

                <input
                  id="active"
                  name="active"
                  type="checkbox"
                  ${
                    data.active !== false
                      ? 'checked'
                      : ''
                  }
                >

                <label for="active">
                  Exam room is active
                </label>

              </div>

            </div>

          </div>

        </div>

        <div class="modal-footer">

          <button
            type="button"
            class="secondary-btn"
            data-action="close-modal"
          >
            Cancel
          </button>

          <button
            type="submit"
            class="primary-btn"
          >
            ${
              exam
                ? 'Save Changes'
                : 'Create Exam Room'
            }
          </button>

        </div>

      </form>

    </div>
  `;

  bindActions();

  $('#exam-form')
    ?.addEventListener(
      'submit',
      event => {

        event.preventDefault();

        const formData =
          new FormData(
            event.target
          );

        const formUrl =
          String(
            formData.get(
              'formUrl'
            ) || ''
          ).trim();

        if (
          !/^https:\/\/
            (docs\.google\.com|forms\.google\.com)
          /ix.test(formUrl)
        ) {

          toast(
            'Please enter a valid Google Forms URL.',
            'error'
          );

          return;
        }

        const roomNumber =
          String(
            formData.get(
              'roomNumber'
            ) || ''
          ).trim();

        const passcode =
          String(
            formData.get(
              'passcode'
            ) || ''
          ).trim();

        if (
          !roomNumber ||
          !passcode
        ) {

          toast(
            'Room Number and Passcode are required.',
            'error'
          );

          return;
        }

        /*
          Prevent duplicate room numbers
          across different exams.
        */

        const duplicate =
          db.exams.find(
            x =>
              x.id !== exam?.id &&
              String(
                x.roomNumber || ''
              )
                .trim()
                .toLowerCase() ===
              roomNumber.toLowerCase()
          );

        if (duplicate) {

          toast(
            'That Room Number is already assigned to another examination.',
            'error'
          );

          return;
        }

        const object = {

          title:
            String(
              formData.get(
                'title'
              ) || ''
            ).trim(),

          description:
            String(
              formData.get(
                'description'
              ) || ''
            ).trim(),

          formUrl,

          roomNumber,

          passcode,

          antiCheat:
            formData.has(
              'antiCheat'
            ),

          maxViolations:
            Math.max(
              1,
              Math.round(
                Number(
                  formData.get(
                    'maxViolations'
                  )
                ) || 3
              )
            ),

          timerEnabled:
            formData.has(
              'timerEnabled'
            ),

          durationMinutes:
            Math.max(
              1,
              Math.round(
                Number(
                  formData.get(
                    'durationMinutes'
                  )
                ) || 60
              )
            ),

          startAt:
            formData.get(
              'startAt'
            )
              ? new Date(
                  formData.get(
                    'startAt'
                  )
                ).toISOString()
              : '',

          endAt:
            formData.get(
              'endAt'
            )
              ? new Date(
                  formData.get(
                    'endAt'
                  )
                ).toISOString()
              : '',

          active:
            formData.has(
              'active'
            )
        };

        if (!object.title) {

          toast(
            'Exam Title is required.',
            'error'
          );

          return;
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

            createdAt:
              Date.now(),

            createdBy:
              currentUser()?.id ||
              'u-admin'
          });
        }

        saveDB();

        closeModal();

        renderAdminExams();

        toast(
          exam
            ? 'Exam room updated successfully.'
            : 'Exam room created successfully.',
          'success'
        );
      }
    );
}

/* ============================================================
   DELETE EXAM
============================================================ */

function deleteExam(id) {

  const exam =
    db.exams.find(
      x => x.id === id
    );

  if (!exam) return;

  const attempts =
    db.attempts.filter(
      x => x.examId === id
    ).length;

  const confirmed =
    confirm(
      `Delete "${exam.title}"?\n\n` +
      `${attempts} historical submission(s) will remain in the reports.`
    );

  if (!confirmed) return;

  db.exams =
    db.exams.filter(
      x => x.id !== id
    );

  saveDB();

  renderAdminExams();

  toast(
    'Exam deleted. The exam slot is now available.',
    'success'
  );
}

/* ============================================================
   SUBMISSIONS
============================================================ */

function renderSubmissions() {

  const rows =
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

        <h3>
          Submissions
        </h3>

        <p>
          Every examination submission is recorded separately.
          There is no submission limit.
        </p>

      </div>

      <div class="actions">

        <button
          class="secondary-btn"
          data-action="refresh-admin"
        >
          Refresh
        </button>

      </div>

    </div>

    <div class="panel">

      ${submissionTable(rows)}

    </div>
  `;

  bindActions();
}

/* ============================================================
   VIOLATIONS
============================================================ */

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

        <h3>
          Violation Logs
        </h3>

        <p>
          Security events recorded during examinations.
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

                    <th>
                      Time
                    </th>

                    <th>
                      Participant
                    </th>

                    <th>
                      Room
                    </th>

                    <th>
                      Exam
                    </th>

                    <th>
                      #
                    </th>

                    <th>
                      Reason
                    </th>

                  </tr>

                </thead>

                <tbody>

                  ${rows.map(
                    violation => `

                      <tr>

                        <td>
                          ${fmtDate(
                            violation.timestamp
                          )}
                        </td>

                        <td>
                          ${esc(
                            violation.participantId ||
                            violation.username
                          )}
                        </td>

                        <td>
                          ${esc(
                            violation.roomNumber ||
                            '—'
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
                  ).join('')}

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

/* ============================================================
   ANALYTICS
============================================================ */

function renderAnalytics() {

  const c =
    attemptCounts();

  const total =
    c.total || 1;

  const average =
    db.attempts.length

      ? (
          db.attempts.reduce(
            (sum, attempt) =>
              sum +
              Number(
                attempt.violations || 0
              ),
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
            a =>
              a.examId === exam.id
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

        <h3>
          Analytics
        </h3>

        <p>
          Examination activity and security overview.
        </p>

      </div>

    </div>

    <div class="kpi-grid">

      ${kpi(
        'Completion Rate',
        Math.round(
          c.completed /
          total *
          100
        ) + '%'
      )}

      ${kpi(
        'In Progress',
        c.inProgress
      )}

      ${kpi(
        'Termination Rate',
        Math.round(
          c.terminated /
          total *
          100
        ) + '%'
      )}

      ${kpi(
        'Avg. Violations',
        average
      )}

    </div>

    <div class="grid-2">

      <div class="panel">

        <h3>
          Session Status
        </h3>

        ${
          [
            [
              'Completed',
              c.completed
            ],
            [
              'In Progress',
              c.inProgress
            ],
            [
              'Time Expired',
              c.expired
            ],
            [
              'Terminated',
              c.terminated
            ]
          ]
            .map(
              ([label, count]) =>
                chart(
                  label,
                  count,
                  c.total
                )
            )
            .join('')
        }

      </div>

      <div class="panel">

        <h3>
          Sessions by Exam
        </h3>

        ${
          byExam.length

            ? byExam
                .map(
                  item =>
                    chart(
                      item.exam.title,
                      item.count,
                      c.total
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

  `;
}

function kpi(
  label,
  value
) {

  return `

    <div class="kpi">

      <span>
        ${label}
      </span>

      <strong>
        ${value}
      </strong>

    </div>
  `;
}

function chart(
  label,
  number,
  total
) {

  const percent =
    total
      ? Math.round(
          number /
          total *
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
            style="width:${percent}%"
          ></div>

        </div>

      </div>

      <div class="chart-number">

        ${number}
        (${percent}%)

      </div>

    </div>
  `;
}

/* ============================================================
   SETTINGS
============================================================ */

function renderSettings() {

  const user =
    currentUser();

  $('#admin-settings-page').innerHTML = `

    <div class="page-head">

      <div>

        <span class="eyebrow">
          SYSTEM
        </span>

        <h3>
          Settings
        </h3>

        <p>
          Proctor+ system settings.
        </p>

      </div>

    </div>

    <div class="grid-2">

      <div class="panel">

        <h3>
          Theme
        </h3>

        <p class="muted">

          Current theme:
          <strong>
            ${db.theme}
          </strong>

        </p>

        <button
          class="secondary-btn"
          data-action="toggle-theme"
        >
          Switch Theme
        </button>

      </div>

      <div class="panel">

        <h3>
          Prototype Data
        </h3>

        <p class="muted">

          Exam rooms, attempts and violation
          records are currently stored in this
          browser.

        </p>

        <button
          class="danger-btn"
          data-action="reset-demo"
        >
          Reset Demo Data
        </button>

      </div>

    </div>

    <div
      class="panel"
      style="margin-top:18px"
    >

      <h3>
        Administrator
      </h3>

      <div class="table-wrap">

        <table class="data-table">

          <thead>

            <tr>

              <th>
                Username
              </th>

              <th>
                Role
              </th>

              <th>
                Status
              </th>

            </tr>

          </thead>

          <tbody>

            <tr>

              <td>
                ${esc(
                  user?.username ||
                  'admin'
                )}
              </td>

              <td>
                Administrator
              </td>

              <td>
                ${badge('Available')}
              </td>

            </tr>

          </tbody>

        </table>

      </div>

    </div>

    <div
      class="panel"
      style="margin-top:18px"
    >

      <h3>
        Multi-PC Room Note
      </h3>

      <div class="notice">

        The Room Number + Passcode system allows
        multiple participants to enter the same room.
        This browser-only version stores data locally.
        For submissions from multiple PCs to appear
        together in one administrator dashboard,
        connect Proctor+ to a server/database.

      </div>

    </div>

  `;

  bindActions();
}

/* ============================================================
   EXAMINER / ROOM PARTICIPANT DASHBOARD
============================================================ */

function openExaminer() {

  const room =
    session?.roomNumber;

  const exam =
    db.exams.find(
      e =>
        String(
          e.roomNumber || ''
        ).toLowerCase() ===
        String(
          room || ''
        ).toLowerCase()
    );

  if (!exam) {

    logout();

    return;
  }

  currentExam =
    clone(exam);

  $('#examiner-user-name').textContent =
    'Room ' +
    exam.roomNumber;

  $('#examiner-avatar').textContent =
    String(
      exam.roomNumber ||
      'R'
    )[0].toUpperCase();

  showView('examiner');

  renderExaminerDashboard();
}

function examinerPage() {

  renderExaminerDashboard();

  $('#examiner-sidebar')
    ?.classList.remove(
      'open'
    );
}

function renderExaminerDashboard() {

  const room =
    session?.roomNumber;

  const exam =
    db.exams.find(
      e =>
        String(
          e.roomNumber || ''
        ).toLowerCase() ===
        String(
          room || ''
        ).toLowerCase()
    );

  if (!exam) {

    logout();

    return;
  }

  currentExam =
    clone(exam);

  const myAttempts =
    db.attempts.filter(
      attempt =>
        attempt.participantId ===
        session.username &&
        attempt.examId ===
        exam.id
    );

  const inProgress =
    myAttempts.find(
      attempt =>
        attempt.status ===
        'In Progress'
    );

  const completed =
    myAttempts.filter(
      attempt =>
        attempt.status ===
        'Completed'
    ).length;

  $('#examiner-dashboard-page').innerHTML = `

    <div class="page-head">

      <div>

        <span class="eyebrow">
          PROCTOR+ EXAM ROOM
        </span>

        <h3>
          ${esc(exam.title)}
        </h3>

        <p>
          Room:
          <strong>
            ${esc(exam.roomNumber)}
          </strong>
        </p>

      </div>

    </div>

    <div class="stat-grid">

      ${stat(
        'My Submissions',
        myAttempts.length
      )}

      ${stat(
        'Completed',
        completed,
        'success'
      )}

      ${stat(
        'Violations',
        myAttempts.reduce(
          (sum, attempt) =>
            sum +
            Number(
              attempt.violations || 0
            ),
          0
        )
      )}

      ${stat(
        'Active Session',
        inProgress
          ? 'Yes'
          : 'No'
      )}

    </div>

    <div
      class="panel"
      style="margin-top:18px"
    >

      <div class="page-head">

        <div>

          <span class="eyebrow">
            EXAMINATION
          </span>

          <h3>
            ${esc(exam.title)}
          </h3>

          <p>
            ${esc(
              exam.description ||
              'No description provided.'
            )}
          </p>

        </div>

        <div class="actions">

          <button
            class="primary-btn"
            data-action="start-exam"
            data-id="${exam.id}"
          >
            Start Examination
          </button>

        </div>

      </div>

      <div class="exam-meta">

        <div class="meta-box">

          <span>
            Duration
          </span>

          <strong>
            ${
              exam.timerEnabled
                ? exam.durationMinutes +
                  ' min'
                : 'No Timer'
            }
          </strong>

        </div>

        <div class="meta-box">

          <span>
            Anti-cheat
          </span>

          <strong>
            ${
              exam.antiCheat
                ? 'Enabled'
                : 'Disabled'
            }
          </strong>

        </div>

        <div class="meta-box">

          <span>
            Maximum Violations
          </span>

          <strong>
            ${exam.maxViolations}
          </strong>

        </div>

        <div class="meta-box">

          <span>
            Submissions
          </span>

          <strong>
            Unlimited
          </strong>

        </div>

      </div>

    </div>

    <div
      class="panel"
      style="margin-top:18px"
    >

      <h3>
        My Recent Sessions
      </h3>

      ${
        myAttempts.length
          ? submissionTable(
              myAttempts
                .slice()
                .sort(
                  (a, b) =>
                    (b.startedAt || 0) -
                    (a.startedAt || 0)
                )
                .slice(0, 10)
            )
          : `
            <div class="empty">
              No previous submissions.
            </div>
          `
      }

    </div>
  `;

  bindActions();
}

/* ============================================================
   START EXAM
============================================================ */

function startExam(id) {

  const exam =
    db.exams.find(
      x => x.id === id
    );

  if (!exam) return;

  if (
    String(
      exam.roomNumber || ''
    ).toLowerCase() !==
    String(
      session?.roomNumber || ''
    ).toLowerCase()
  ) {

    toast(
      'This examination does not belong to your room.',
      'error'
    );

    return;
  }

  if (
    getAvailability(exam)
      .status !== 'Available'
  ) {

    toast(
      'This examination room is not currently available.',
      'error'
    );

    return;
  }

  /*
    IMPORTANT:
    There is deliberately NO completed-attempt
    lock here.

    Every time Start Examination is clicked,
    a new attempt may be created.
  */

  openStartInstructions(exam);
}

/* ============================================================
   START INSTRUCTIONS
============================================================ */

function openStartInstructions(exam) {

  const modalRoot =
    $('#modal-root');

  if (!modalRoot) return;

  modalRoot.hidden = false;

  modalRoot.innerHTML = `

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
          type="button"
          class="close-btn"
          data-action="close-modal"
          aria-label="Close"
        >
          ×
        </button>

      </div>

      <div class="modal-body">

        <div class="notice">

          Room:
          <strong>
            ${esc(exam.roomNumber)}
          </strong>

        </div>

        <ul
          class="instruction-list"
        >

          <li>
            ${
              exam.timerEnabled
                ? `
                  You have
                  <strong>
                    ${exam.durationMinutes} minutes
                  </strong>
                  to complete this session.
                `
                : `
                  No countdown timer is configured.
                `
            }
          </li>

          <li>
            ${
              exam.antiCheat
                ? `
                  Anti-cheat monitoring is enabled.
                  Up to
                  <strong>
                    ${exam.maxViolations}
                  </strong>
                  violations are allowed.
                `
                : `
                  Anti-cheat monitoring is disabled.
                `
            }
          </li>

          <li>
            Submit the Google Form first,
            then click
            <strong>
              Submit Exam
            </strong>
            in Proctor+.
          </li>

          <li>
            You may take the examination again
            if another submission is required.
          </li>

        </ul>

        ${
          exam.antiCheat
            ? `
              <div class="notice danger-notice">

                Fullscreen, tab visibility and
                focus events may be monitored.

                Browser-based proctoring is a
                detection and deterrence layer.

              </div>
            `
            : ''
        }

      </div>

      <div class="modal-footer">

        <button
          type="button"
          class="secondary-btn"
          data-action="close-modal"
        >
          Cancel
        </button>

        <button
          type="button"
          class="primary-btn"
          data-action="confirm-start"
          data-id="${exam.id}"
        >
          Start Examination
        </button>

      </div>

    </div>
  `;

  bindActions();
}

/* ============================================================
   CONFIRM START
============================================================ */

function confirmStart(id) {

  const exam =
    db.exams.find(
      x => x.id === id
    );

  if (!exam) return;

  closeModal();

  const participantId =
    session.username;

  /*
    Every Start Examination creates
    a NEW submission.

    No attempt locking.
  */

  const attempt = {

    id:
      uid('attempt'),

    examId:
      exam.id,

    examTitle:
      exam.title,

    roomNumber:
      exam.roomNumber,

    participantId,

    username:
      participantId,

    startedAt:
      Date.now(),

    endedAt:
      null,

    status:
      'In Progress',

    violations:
      0
  };

  db.attempts.push(
    attempt
  );

  saveDB();

  currentExam =
    clone(exam);

  currentAttempt =
    attempt;

  const timerEnabled =
    exam.timerEnabled === true ||
    exam.timerEnabled === 'true' ||
    exam.timerEnabled === 1 ||
    exam.timerEnabled === '1';

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
    exam.antiCheat === true ||
    exam.antiCheat === 'true' ||
    exam.antiCheat === 1 ||
    exam.antiCheat === '1';

  examState = {

    attemptId:
      attempt.id,

    seconds:
      timerEnabled
        ? durationMinutes * 60
        : 0,

    timerEnabled,

    antiCheat,

    maxViolations:
      Math.max(
        1,
        Number(
          exam.maxViolations
        ) || 3
      ),

    startedAt:
      Date.now(),

    active:
      true
  };

  $('#live-exam-title').textContent =
    exam.title;

  $('#live-exam-examiner').textContent =
    'Room ' +
    exam.roomNumber;

  $('#exam-violations').textContent =
    `0 / ${exam.maxViolations}`;

  $('#exam-iframe').src =
    addCacheBuster(
      exam.formUrl
    );

  $('#exam-instructions').textContent =
    timerEnabled

      ? `Timer: ${durationMinutes} minutes • Anti-cheat: ${
          antiCheat
            ? 'Enabled'
            : 'Disabled'
        }`

      : `No timer • Anti-cheat: ${
          antiCheat
            ? 'Enabled'
            : 'Disabled'
        }`;

  showView('exam');

  document.body.classList.add(
    'lockdown-active'
  );

  $('#exam-view')
    ?.classList.add(
      'lockdown-active'
    );

  graceUntil =
    Date.now() + GRACE;

  if (antiCheat) {

    requestFullscreen()
      .finally(() => {

        graceUntil =
          Date.now() + GRACE;
      });
  }

  if (timerEnabled) {

    startTimer();

  } else {

    renderTimer();
  }
}

/* ============================================================
   GOOGLE FORM REFRESH
============================================================ */

function addCacheBuster(url) {

  if (!url) return '';

  const separator =
    url.includes('?')
      ? '&'
      : '?';

  return (
    url +
    separator +
    'proctor_refresh=' +
    Date.now()
  );
}

function refreshGoogleForm() {

  if (
    !currentExam ||
    !examState?.active
  ) {
    return;
  }

  const iframe =
    $('#exam-iframe');

  if (!iframe) return;

  /*
    Reassigning the iframe source with
    a unique query parameter forces the
    Google Form page to reload.

    This does not create a new Proctor+
    attempt and does not reset the timer.
  */

  iframe.src =
    addCacheBuster(
      currentExam.formUrl
    );

  toast(
    'Google Form refreshed.',
    'success'
  );
}

/* ============================================================
   FULLSCREEN
============================================================ */

function requestFullscreen() {

  const element =
    document.documentElement;

  const fn =
    element.requestFullscreen ||
    element.webkitRequestFullscreen ||
    element.mozRequestFullScreen;

  return fn
    ? Promise.resolve(
        fn.call(element)
      ).catch(() => {})
    : Promise.resolve();
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

    Promise.resolve(
      fn.call(document)
    ).catch(() => {});
  }
}

function isFullscreen() {

  return !!(
    document.fullscreenElement ||
    document.webkitFullscreenElement ||
    document.mozFullScreenElement
  );
}

/* ============================================================
   TIMER
============================================================ */

function startTimer() {

  clearInterval(timer);

  renderTimer();

  timer =
    setInterval(
      () => {

        if (
          !examState?.active
        ) {
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

      },
      1000
    );
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

  const sec =
    (seconds % 60)
      .toString()
      .padStart(2, '0');

  const timerElement =
    $('#exam-timer');

  if (timerElement) {

    timerElement.textContent =
      examState?.timerEnabled
        ? `${minutes}:${sec}`
        : 'No Timer';

    timerElement.classList.toggle(
      'warning',
      seconds <= 300 &&
      seconds > 60
    );

    timerElement.classList.toggle(
      'danger',
      seconds <= 60 &&
      !!examState?.timerEnabled
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

  const percent =
    examState?.timerEnabled

      ? Math.max(
          0,
          Math.min(
            100,
            seconds /
              (duration * 60) *
              100
          )
        )

      : 0;

  const progress =
    $('#exam-progress');

  if (progress) {

    progress.style.width =
      (100 - percent) + '%';
  }
}

/* ============================================================
   PROCTORING
============================================================ */

function registerViolation(reason) {

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
      x =>
        x.id ===
        examState.attemptId
    );

  if (!attempt) return;

  const number =
    Number(
      attempt.violations || 0
    ) + 1;

  attempt.violations =
    number;

  db.violations.push({

    id:
      uid('vio'),

    attemptId:
      attempt.id,

    examId:
      currentExam.id,

    examTitle:
      currentExam.title,

    roomNumber:
      currentExam.roomNumber,

    participantId:
      attempt.participantId,

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

  showViolationOverlay(reason);
}

/* ============================================================
   VIOLATION OVERLAY
============================================================ */

function showViolationOverlay(reason) {

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
      x =>
        x.id ===
        examState.attemptId
    );

  $('#overlay-count').textContent =
    attempt?.violations || 0;

  $('#overlay-max').textContent =
    examState.maxViolations;

  $('#violation-overlay').hidden =
    false;

  const iframe =
    $('#exam-iframe');

  if (iframe) {

    iframe.style.filter =
      'blur(6px) brightness(.45)';
  }
}

async function resumeExam() {

  if (
    !examState?.active
  ) {
    return;
  }

  $('#violation-overlay').hidden =
    true;

  violationOverlayOpen =
    false;

  const iframe =
    $('#exam-iframe');

  if (iframe) {
    iframe.style.filter = '';
  }

  graceUntil =
    Date.now() + GRACE;

  await requestFullscreen();

  graceUntil =
    Date.now() + GRACE;
}

/* ============================================================
   PROCTORING EVENT LISTENERS
============================================================ */

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
        Date.now() > graceUntil
      ) {

        registerViolation(
          'You exited full-screen mode.'
        );
      }

    }
  );
});

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

document.addEventListener(
  'contextmenu',
  event => {

    if (
      examState?.active
    ) {
      event.preventDefault();
    }
  }
);

document.addEventListener(
  'copy',
  event => {

    if (
      examState?.active
    ) {
      event.preventDefault();
    }
  }
);

document.addEventListener(
  'cut',
  event => {

    if (
      examState?.active
    ) {
      event.preventDefault();
    }
  }
);

document.addEventListener(
  'paste',
  event => {

    if (
      examState?.active
    ) {
      event.preventDefault();
    }
  }
);

document.addEventListener(
  'keydown',
  event => {

    if (
      !examState?.active
    ) {
      return;
    }

    const key =
      (
        event.key || ''
      ).toLowerCase();

    const modifier =
      event.ctrlKey ||
      event.metaKey;

    const restricted =

      key === 'f12' ||

      (
        modifier &&
        event.shiftKey &&
        ['i', 'j', 'c']
          .includes(key)
      ) ||

      (
        modifier &&
        ['t', 'n', 'w', 'u']
          .includes(key)
      );

    if (restricted) {

      event.preventDefault();

      registerViolation(
        `Restricted shortcut attempt: ${
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
            .join('+')
        }`
      );
    }
  }
);

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

/* ============================================================
   SUBMIT EXAM
============================================================ */

function submitExam() {

  if (
    !examState?.active
  ) {
    return;
  }

  const confirmed =
    confirm(
      'Confirm that you have submitted the Google Form.\n\n' +
      'This will end this examination session. ' +
      'You may start another submission later if needed.'
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

/* ============================================================
   FINISH EXAM
============================================================ */

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
      x =>
        x.id ===
        examState.attemptId
    );

  if (attempt) {

    attempt.status =
      status;

    attempt.endedAt =
      Date.now();

    attempt.timeSpentSeconds =
      Math.max(
        0,
        Math.round(
          (
            Date.now() -
            attempt.startedAt
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

  $('#exam-view')
    ?.classList.remove(
      'lockdown-active'
    );

  exitFullscreen();

  $('#result-icon').textContent =
    icon;

  $('#result-icon').style.color =
    terminated
      ? 'var(--danger)'
      : 'var(--success)';

  $('#result-eyebrow').textContent =
    terminated
      ? 'EXAM TERMINATED'
      : status === 'Time Expired'
        ? 'TIME EXPIRED'
        : 'EXAM COMPLETE';

  $('#result-title').textContent =
    title;

  $('#result-message').textContent =
    message;

  $('#result-exam').textContent =
    currentExam?.title ||
    '—';

  $('#result-user').textContent =
    currentExam?.roomNumber
      ? 'Room ' +
        currentExam.roomNumber
      : '—';

  $('#result-violations').textContent =
    attempt?.violations ||
    0;

  $('#result-ended').textContent =
    fmtDate(
      Date.now()
    );

  showView('result');
}

/* ============================================================
   RESULT -> ROOM DASHBOARD
============================================================ */

function returnToDashboard() {

  currentExam = null;
  currentAttempt = null;
  examState = null;

  openPortal();
}

/* ============================================================
   MODAL CONTROL
============================================================ */

function closeModal() {

  const modalRoot =
    $('#modal-root');

  if (!modalRoot) return;

  modalRoot.hidden = true;

  modalRoot.innerHTML = '';
}

/*
  This delegated event handler fixes the previous
  issue where dynamically generated Close/Cancel
  buttons were not responding correctly.
*/

function bindActions() {

  $$('[data-action]')
    .forEach(button => {

      if (
        button.dataset.bound === '1'
      ) {
        return;
      }

      button.dataset.bound =
        '1';

      button.addEventListener(
        'click',
        event => {

          event.preventDefault();
          event.stopPropagation();

          const action =
            button.dataset.action;

          const id =
            button.dataset.id;

          switch (action) {

            case 'new-exam':

              openExamModal();

              break;

            case 'edit-exam':

              openExamModal(id);

              break;

            case 'delete-exam':

              deleteExam(id);

              break;

            case 'close-modal':

              closeModal();

              break;

            case 'confirm-start':

              confirmStart(id);

              break;

            case 'start-exam':

              startExam(id);

              break;

            case 'view-submissions':

              adminPage(
                'submissions'
              );

              break;

            case 'refresh-admin':

              db = loadDB();

              renderAdminPage(
                getCurrentAdminPage()
              );

              break;

            case 'toggle-theme':

              toggleTheme();

              break;

            case 'reset-demo':

              resetDemo();

              break;

            case 'refresh-form':

              refreshGoogleForm();

              break;

            case 'resume-exam':

              resumeExam();

              break;

            case 'submit-exam':

              submitExam();

              break;

            default:

              break;
          }
        }
      );
    });
}

function getCurrentAdminPage() {

  const title =
    $('#admin-page-title')
      ?.textContent ||
    'Dashboard';

  const found =
    Object.entries(
      pageTitles
    ).find(
      ([key, value]) =>
        value === title
    );

  return found
    ? found[0]
    : 'dashboard';
}

/* ============================================================
   MODAL BACKDROP CLOSE
============================================================ */

document.addEventListener(
  'click',
  event => {

    const root =
      $('#modal-root');

    if (
      !root ||
      root.hidden
    ) {
      return;
    }

    if (
      event.target === root
    ) {
      closeModal();
    }
  }
);

/* ============================================================
   RESET
============================================================ */

function resetDemo() {

  const confirmed =
    confirm(
      'Reset all Proctor+ demo data, rooms, submissions and violation logs?'
    );

  if (!confirmed) {
    return;
  }

  db =
    clone(seed);

  saveDB();

  toast(
    'Proctor+ demo data reset.',
    'success'
  );

  openAdmin();
}

/* ============================================================
   VIOLATION OVERLAY SYNC
============================================================ */

function syncViolationOverlay() {

  const overlay =
    $('#violation-overlay');

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

/* ============================================================
   CLOCKS
============================================================ */

setInterval(
  () => {

    const adminClock =
      $('#admin-clock');

    const examinerClock =
      $('#examiner-clock');

    const now =
      new Date()
        .toLocaleString();

    if (adminClock) {
      adminClock.textContent =
        now;
    }

    if (examinerClock) {
      examinerClock.textContent =
        now;
    }

  },
  1000
);

/* ============================================================
   STARTUP
============================================================ */

function initializePortal() {

  db =
    loadDB();

  initAuthentication();

  /*
    Theme buttons
  */

  [
    'theme-toggle-login',
    'theme-toggle-admin',
    'theme-toggle-examiner'
  ].forEach(id => {

    const button =
      $('#' + id);

    if (
      button &&
      button.dataset.themeBound !== '1'
    ) {

      button.addEventListener(
        'click',
        toggleTheme
      );

      button.dataset.themeBound =
        '1';
    }
  });

  /*
    Logout
  */

  $('#admin-logout')
    ?.addEventListener(
      'click',
      logout
    );

  $('#examiner-logout')
    ?.addEventListener(
      'click',
      logout
    );

  /*
    Exam controls
  */

  $('#exam-submit-btn')
    ?.addEventListener(
      'click',
      submitExam
    );

  $('#refresh-form-btn')
    ?.addEventListener(
      'click',
      refreshGoogleForm
    );

  $('#resume-exam-btn')
    ?.addEventListener(
      'click',
      resumeExam
    );

  $('#result-dashboard-btn')
    ?.addEventListener(
      'click',
      returnToDashboard
    );

  /*
    Apply theme
  */

  applyTheme();

  /*
    Check session
  */

  if (
    session &&
    (
      session.role === 'admin' ||
      session.role === 'examiner'
    )
  ) {

    openPortal();

  } else {

    session = null;

    saveSession();

    showView('login');
  }

  /*
    Initial action binding
  */

  bindActions();

  syncViolationOverlay();
}

if (
  document.readyState ===
  'loading'
) {

  document.addEventListener(
    'DOMContentLoaded',
    initializePortal,
    {
      once: true
    }
  );

} else {

  initializePortal();
}

})();
