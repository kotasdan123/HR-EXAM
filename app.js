/* =========================================================
   PROCTOR+ ONLINE EXAMINATION PORTAL
   Room-Based Examination System
   =========================================================

   IMPORTANT:
   This is a browser/localStorage prototype.

   Authentication, room credentials, attempts and violation
   records are stored in localStorage and are NOT secure enough
   for production use.

   A production version should use:
   - Server-side authentication
   - Database
   - Server-side room/session management
   - Server-side attempt records
   - Server-side violation logging

   Google Forms are cross-origin. The portal cannot directly
   detect the actual Google Forms "Submit" event.

   The portal's "Submit Exam" button is therefore the official
   session completion signal.
*/

(() => {
'use strict';

/* =========================================================
   STORAGE
   ========================================================= */

const KEY = 'proctor_plus_room_portal_v3';
const SESSION = 'proctor_plus_session_v3';

const DEFAULT_FORM =
  'https://docs.google.com/forms/d/e/1FAIpQLSf_PLACEHOLDER_FORM_ID/viewform?embedded=true';

/* =========================================================
   SEED DATA
   ========================================================= */

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

  rooms: [
    {
      id: 'room-demo',
      roomNumber: 'ROOM-001',
      passcode: '123456',
      title: 'Demo Examination',
      description:
        'Replace this Google Form with your actual examination link.',
      formUrl: DEFAULT_FORM,
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

/* =========================================================
   STATE
   ========================================================= */

let db = loadDB();
let session = loadSession();

let currentRoom = null;
let examState = null;
let timer = null;

let violationOverlayOpen = false;
let graceUntil = 0;
let lastViolation = 0;

const DEBOUNCE = 650;
const GRACE = 1500;

/* =========================================================
   HELPERS
   ========================================================= */

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
    character => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[character])
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

/* =========================================================
   DATABASE
   ========================================================= */

function loadDB() {
  let stored = {};

  try {
    const raw = safeGet(localStorage, KEY);

    if (raw) {
      try {
        stored = JSON.parse(raw) || {};
      } catch {
        stored = {};
      }
    }
  } catch {
    stored = {};
  }

  const users =
    Array.isArray(stored.users)
      ? stored.users
      : [];

  /* Always maintain the admin account */

  const admin = users.find(
    user =>
      String(user.username || '')
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

    rooms:
      Array.isArray(stored.rooms) && stored.rooms.length
        ? stored.rooms
        : clone(seed.rooms),

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

  if (
    !Array.isArray(repaired.rooms) ||
    !repaired.rooms.length
  ) {
    repaired.rooms = clone(seed.rooms);
  }

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

/* =========================================================
   SESSION
   ========================================================= */

function loadSession() {
  try {
    return JSON.parse(
      safeGet(sessionStorage, SESSION) || 'null'
    );
  } catch {
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
      user => user.id === session.userId
    ) ||
    db.users.find(
      user =>
        String(user.username || '')
          .toLowerCase() ===
        String(session.username || '')
          .toLowerCase()
    ) ||
    null
  );
}

/* =========================================================
   VIEWS
   ========================================================= */

const views = {
  login: $('#login-view'),
  admin: $('#admin-view'),
  room: $('#room-view'),
  exam: $('#exam-view'),
  result: $('#result-view')
};

function showView(name) {
  Object.values(views).forEach(view => {
    if (view) {
      view.hidden = true;
    }
  });

  if (views[name]) {
    views[name].hidden = false;
  }

  window.scrollTo(0, 0);
}

/* =========================================================
   TOAST
   ========================================================= */

function toast(message, type = '') {
  const container =
    $('#toast-container');

  if (!container) return;

  const element =
    document.createElement('div');

  element.className =
    'toast ' + type;

  element.textContent = message;

  container.appendChild(element);

  setTimeout(() => {
    element.remove();
  }, 3500);
}

/* =========================================================
   THEME
   ========================================================= */

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
    'theme-toggle-room'
  ].forEach(id => {
    const button = $('#' + id);

    if (!button) return;

    button.textContent =
      light ? '☾' : '☼';

    button.setAttribute(
      'aria-label',
      light
        ? 'Switch to dark mode'
        : 'Switch to light mode'
    );

    button.title =
      light
        ? 'Switch to dark mode'
        : 'Switch to light mode';
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

/* =========================================================
   LOGIN
   ========================================================= */

function showLoginError(message) {
  const error =
    $('#login-error');

  if (!error) return;

  error.textContent = message;
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

/* =========================================================
   ADMIN LOGIN
   ========================================================= */

function openAdminLogin() {
  const modal =
    $('#admin-login-modal');

  if (!modal) return;

  modal.hidden = false;

  $('#admin-username')?.focus();
}

function closeAdminLogin() {
  const modal =
    $('#admin-login-modal');

  if (!modal) return;

  modal.hidden = true;

  $('#admin-login-form')?.reset();

  const error =
    $('#admin-login-error');

  if (error) {
    error.textContent = '';
    error.hidden = true;
  }
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

  if (!username || !password) {
    if (error) {
      error.textContent =
        'Please enter your username and password.';
      error.hidden = false;
    }

    return;
  }

  db = loadDB();

  const user =
    db.users.find(
      item =>
        String(item.username || '')
          .trim()
          .toLowerCase() ===
          username.toLowerCase() &&
        String(item.password || '') ===
          password &&
        item.role === 'admin'
    );

  if (!user) {
    if (error) {
      error.textContent =
        'Incorrect administrator username or password.';
      error.hidden = false;
    }

    $('#admin-password').value = '';

    return;
  }

  session = {
    userId: user.id,
    username: user.username,
    role: 'admin',
    loginAt: Date.now()
  };

  saveSession();

  closeAdminLogin();

  openPortal();
}

/* =========================================================
   ROOM LOGIN
   ========================================================= */

function handleRoomLogin(event) {
  event.preventDefault();

  clearLoginError();

  const roomNumber =
    String(
      $('#login-room')?.value || ''
    ).trim();

  const passcode =
    String(
      $('#login-passcode')?.value || ''
    ).trim();

  if (!roomNumber || !passcode) {
    showLoginError(
      'Please enter the Room Number and Passcode.'
    );

    return;
  }

  db = loadDB();

  const room =
    db.rooms.find(
      item =>
        String(item.roomNumber || '')
          .trim()
          .toLowerCase() ===
          roomNumber.toLowerCase() &&
        String(item.passcode || '') ===
          passcode
    );

  if (!room) {
    showLoginError(
      'Invalid Room Number or Passcode.'
    );

    $('#login-passcode').value = '';

    return;
  }

  if (room.active === false) {
    showLoginError(
      'This examination room is currently disabled.'
    );

    return;
  }

  const availability =
    getAvailability(room);

  if (availability.status !== 'Available') {
    showLoginError(
      'This examination room is not currently available.'
    );

    return;
  }

  /*
    Every browser/PC gets its own unique session ID.

    This is important because multiple users can enter the
    same room simultaneously.
  */

  session = {
    userId: null,
    username: 'Room Participant',
    role: 'participant',

    roomId: room.id,
    roomNumber: room.roomNumber,

    participantId: uid('participant'),

    loginAt: Date.now()
  };

  saveSession();

  currentRoom = clone(room);

  openRoomDashboard();
}

/* =========================================================
   AUTH INITIALIZATION
   ========================================================= */

function initAuthentication() {
  const roomForm =
    $('#room-login-form');

  if (
    roomForm &&
    roomForm.dataset.bound !== '1'
  ) {
    roomForm.addEventListener(
      'submit',
      handleRoomLogin
    );

    roomForm.dataset.bound = '1';
  }

  const adminForm =
    $('#admin-login-form');

  if (
    adminForm &&
    adminForm.dataset.bound !== '1'
  ) {
    adminForm.addEventListener(
      'submit',
      handleAdminLogin
    );

    adminForm.dataset.bound = '1';
  }

  $('#admin-login-open')
    ?.addEventListener(
      'click',
      openAdminLogin
    );

  $('#admin-login-close')
    ?.addEventListener(
      'click',
      closeAdminLogin
    );

  $('#admin-login-cancel')
    ?.addEventListener(
      'click',
      closeAdminLogin
    );
}

/* =========================================================
   PORTAL ROUTING
   ========================================================= */

function openPortal() {
  const user =
    currentUser();

  if (
    user &&
    user.role === 'admin'
  ) {
    openAdmin();
    return;
  }

  if (
    session &&
    session.role === 'participant' &&
    session.roomId
  ) {
    const room =
      db.rooms.find(
        item =>
          item.id === session.roomId
      );

    if (!room) {
      logout();
      return;
    }

    currentRoom = clone(room);

    openRoomDashboard();
    return;
  }

  session = null;
  saveSession();

  showView('login');
}

function logout() {
  clearInterval(timer);

  timer = null;

  currentRoom = null;
  examState = null;

  violationOverlayOpen = false;

  exitFullscreen();

  document.body.classList.remove(
    'lockdown-active'
  );

  $('#exam-view')
    ?.classList.remove(
      'lockdown-active'
    );

  session = null;

  saveSession();

  syncViolationOverlay();

  showView('login');

  $('#room-login-form')
    ?.reset();

  clearLoginError();
}

/* =========================================================
   AVAILABILITY
   ========================================================= */

function getAvailability(room) {
  if (!room || room.active === false) {
    return {
      status: 'Unavailable'
    };
  }

  const now = Date.now();

  const start =
    room.startAt
      ? new Date(room.startAt).getTime()
      : null;

  const end =
    room.endAt
      ? new Date(room.endAt).getTime()
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

/* =========================================================
   ADMIN SIDEBAR
   ========================================================= */

const pageTitles = {
  dashboard: 'Dashboard',
  rooms: 'Exam Rooms',
  submissions: 'Submissions',
  violations: 'Violation Logs',
  analytics: 'Analytics',
  settings: 'Settings'
};

function openAdmin() {
  const user =
    currentUser();

  if (!user) {
    showView('login');
    return;
  }

  $('#admin-user-name').textContent =
    user.name || user.username;

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
    .forEach(element => {
      element.classList.remove(
        'active'
      );
    });

  const target =
    $('#admin-' + page + '-page');

  if (target) {
    target.classList.add('active');
  }

  const title =
    $('#admin-page-title');

  if (title) {
    title.textContent =
      pageTitles[page];
  }

  $('#admin-sidebar')
    ?.classList.remove('open');

  renderAdminPage(page);
}

function renderAdminPage(page) {
  const renderers = {
    dashboard: renderAdminDashboard,
    rooms: renderAdminRooms,
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

/* =========================================================
   ADMIN DASHBOARD
   ========================================================= */

function attemptCounts() {
  const attempts =
    db.attempts;

  return {
    total: attempts.length,

    inProgress:
      attempts.filter(
        item =>
          item.status === 'In Progress'
      ).length,

    completed:
      attempts.filter(
        item =>
          item.status === 'Completed'
      ).length,

    expired:
      attempts.filter(
        item =>
          item.status === 'Time Expired'
      ).length,

    terminated:
      attempts.filter(
        item =>
          item.status === 'Terminated'
      ).length
  };
}

function renderAdminDashboard() {
  const counts =
    attemptCounts();

  const total =
    counts.total || 1;

  const averageViolations =
    db.attempts.length
      ? (
          db.attempts.reduce(
            (sum, attempt) =>
              sum +
              (attempt.violations || 0),
            0
          ) /
          db.attempts.length
        ).toFixed(1)
      : '0.0';

  const completion =
    counts.total
      ? Math.round(
          counts.completed /
          counts.total *
          100
        )
      : 0;

  $('#admin-dashboard-page').innerHTML = `
    <div class="page-head">
      <div>
        <span class="eyebrow">
          OVERVIEW
        </span>

        <h3>
          Exam Dashboard
        </h3>

        <p>
          Monitor rooms, active sessions, submissions and security events.
        </p>
      </div>

      <div class="actions">
        <button
          class="primary-btn"
          data-action="new-room"
        >
          + Create Exam Room
        </button>
      </div>
    </div>

    <div class="stat-grid">
      ${stat('Exam Rooms', db.rooms.length)}
      ${stat('Total Sessions', counts.total)}
      ${stat('In Progress', counts.inProgress)}
      ${stat('Completed', counts.completed, 'success')}
      ${stat('Terminated', counts.terminated, 'danger')}
      ${stat('Avg. Violations', averageViolations)}
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
            ${counts.completed} of ${counts.total} sessions
          </span>
        </div>
      </div>

      <div class="panel">
        <h3>
          Room Capacity
        </h3>

        <div class="quick-grid">

          <div class="quick-card">
            <strong>
              ${db.rooms.length}
            </strong>

            <span>
              Active rooms
            </span>
          </div>

          <div class="quick-card">
            <strong>
              ${Math.max(
                0,
                6 - db.rooms.length
              )}
            </strong>

            <span>
              Slots available
            </span>
          </div>

          <div class="quick-card">
            <strong>
              ${db.attempts.filter(
                attempt =>
                  attempt.status ===
                  'In Progress'
              ).length}
            </strong>

            <span>
              Active sessions
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
          .slice(0, 8)
      )}

    </div>
  `;

  bindActions();
}

/* =========================================================
   ADMIN ROOMS
   ========================================================= */

function stat(
  label,
  value,
  className = ''
) {
  return `
    <div class="stat-card ${className}">
      <span class="stat-label">
        ${label}
      </span>

      <span class="stat-value">
        ${value}
      </span>
    </div>
  `;
}

function badge(status) {
  const colors = {
    Completed: 'green',
    'Time Expired': 'yellow',
    Terminated: 'red',
    'In Progress': 'blue',
    Locked: 'gray',
    Available: 'green',
    Unavailable: 'gray'
  };

  return `
    <span class="badge ${colors[status] || 'gray'}">
      ${esc(status)}
    </span>
  `;
}

function renderAdminRooms() {
  const slots =
    6 - db.rooms.length;

  $('#admin-rooms-page').innerHTML = `
    <div class="page-head">

      <div>
        <span class="eyebrow">
          EXAM ROOM MANAGEMENT
        </span>

        <h3>
          Examination Rooms
        </h3>

        <p>
          Each room can be accessed by multiple participants at the same time.
          There is no participant submission limit.
        </p>

        <div class="slot-note">
          ${db.rooms.length}/6 rooms used
        </div>
      </div>

      <div class="actions">
        <button
          class="primary-btn"
          data-action="new-room"
          ${slots <= 0 ? 'disabled' : ''}
        >
          + Create Room
        </button>
      </div>

    </div>

    <div class="exam-grid">
      ${
        db.rooms.length
          ? db.rooms
              .map(roomCard)
              .join('')
          : `
            <div
              class="panel"
              style="grid-column:1/-1"
            >
              <div class="empty">
                No examination rooms have been created.
              </div>
            </div>
          `
      }
    </div>
  `;

  bindActions();
}

function roomCard(room) {
  const availability =
    getAvailability(room);

  const attempts =
    db.attempts.filter(
      attempt =>
        attempt.roomId === room.id
    );

  const activeSessions =
    attempts.filter(
      attempt =>
        attempt.status === 'In Progress'
    ).length;

  return `
    <article class="exam-card">

      <div class="exam-card-top">

        <span class="badge ${
          room.active
            ? 'green'
            : 'gray'
        }">
          ${
            room.active
              ? 'ACTIVE'
              : 'DISABLED'
          }
        </span>

        ${badge(
          availability.status
        )}

      </div>

      <div class="room-number-display">
        ${esc(room.roomNumber)}
      </div>

      <h3>
        ${esc(room.title)}
      </h3>

      <p>
        ${esc(
          room.description ||
          'No description provided.'
        )}
      </p>

      <div class="exam-meta">

        <div class="meta-box">
          <span>
            Timer
          </span>

          <strong>
            ${
              room.timerEnabled
                ? room.durationMinutes +
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
              room.antiCheat
                ? 'On'
                : 'Off'
            }
          </strong>
        </div>

        <div class="meta-box">
          <span>
            Sessions
          </span>

          <strong>
            ${attempts.length}
          </strong>
        </div>

        <div class="meta-box">
          <span>
            Active Now
          </span>

          <strong>
            ${activeSessions}
          </strong>
        </div>

      </div>

      <div class="exam-card-actions">

        <button
          class="secondary-btn"
          data-action="edit-room"
          data-id="${room.id}"
        >
          Edit
        </button>

        <button
          class="danger-btn"
          data-action="delete-room"
          data-id="${room.id}"
        >
          Delete
        </button>

      </div>

    </article>
  `;
}

/* =========================================================
   ROOM MODAL
   ========================================================= */

function openRoomModal(id = null) {
  const room =
    id
      ? db.rooms.find(
          item => item.id === id
        )
      : null;

  if (
    !room &&
    db.rooms.length >= 6
  ) {
    toast(
      'Maximum of 6 examination rooms reached.',
      'error'
    );

    return;
  }

  const data =
    room ||
    {
      roomNumber:
        'ROOM-' +
        String(
          db.rooms.length + 1
        ).padStart(3, '0'),

      passcode:
        String(
          Math.floor(
            100000 +
            Math.random() * 900000
          )
        ),

      title: '',
      description: '',
      formUrl: '',
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

  const modal =
    $('#modal-root');

  if (!modal) return;

  modal.hidden = false;

  modal.innerHTML = `
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
    >

      <div class="modal-head">

        <div>
          <span class="eyebrow">
            ${
              room
                ? 'EDIT EXAM ROOM'
                : 'NEW EXAM ROOM'
            }
          </span>

          <h3>
            ${
              room
                ? 'Update Examination Room'
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

      <form id="room-form">

        <div class="modal-body">

          <div class="form-grid">

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

            </div>

            <div class="field">

              <label class="form-label">
                Passcode
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
                Participants will use this Room Number and Passcode to enter.
              </div>

            </div>

            <div class="field full-span">

              <label class="form-label">
                Examination Title
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
                rows="3"
                placeholder="Short examination description"
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
                placeholder="https://docs.google.com/forms/d/e/.../viewform"
              >

              <div class="helper">
                The Google Form will be displayed inside the examination portal.
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
                value="${data.maxViolations}"
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
                value="${data.durationMinutes}"
              >

              <div class="helper">
                Duration in minutes.
              </div>

            </div>

            <div class="field full-span">

              <div class="checkbox-row">

                <input
                  id="roomAntiCheat"
                  name="antiCheat"
                  type="checkbox"
                  ${
                    data.antiCheat
                      ? 'checked'
                      : ''
                  }
                >

                <label for="roomAntiCheat">
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
                  id="roomTimer"
                  name="timerEnabled"
                  type="checkbox"
                  ${
                    data.timerEnabled
                      ? 'checked'
                      : ''
                  }
                >

                <label for="roomTimer">
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

              <div class="helper">
                Leave blank for immediate availability.
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
                )}"
              >

              <div class="helper">
                Leave blank for no end date.
              </div>

            </div>

            <div class="field full-span">

              <div class="checkbox-row">

                <input
                  id="roomActive"
                  name="active"
                  type="checkbox"
                  ${
                    data.active
                      ? 'checked'
                      : ''
                  }
                >

                <label for="roomActive">
                  Examination room is active
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
              room
                ? 'Save Changes'
                : 'Create Room'
            }
          </button>

        </div>

      </form>

    </div>
  `;

  const form =
    $('#room-form');

  if (!form) return;

  form.addEventListener(
    'submit',
    event => {
      event.preventDefault();

      const formData =
        new FormData(
          event.target
        );

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

      const formUrl =
        String(
          formData.get(
            'formUrl'
          ) || ''
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
        Prevent duplicate room numbers.
      */

      const duplicate =
        db.rooms.find(
          item =>
            item.id !== room?.id &&
            String(
              item.roomNumber || ''
            )
              .trim()
              .toLowerCase() ===
            roomNumber.toLowerCase()
        );

      if (duplicate) {
        toast(
          'That Room Number already exists.',
          'error'
        );

        return;
      }

      const durationMinutes =
        Math.max(
          1,
          Math.round(
            Number(
              formData.get(
                'durationMinutes'
              )
            ) || 60
          )
        );

      const obj = {
        roomNumber,
        passcode,

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

        durationMinutes,

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

      if (!obj.title) {
        toast(
          'Please enter an examination title.',
          'error'
        );

        return;
      }

      if (room) {
        Object.assign(
          room,
          obj
        );

        toast(
          'Examination room updated successfully.',
          'success'
        );
      } else {
        db.rooms.push({
          id: uid('room'),
          ...obj,
          createdAt: Date.now(),
          createdBy:
            currentUser()?.id ||
            'u-admin'
        });

        toast(
          'Examination room created successfully.',
          'success'
        );
      }

      saveDB();

      closeModal();

      renderAdminRooms();
    }
  );
}

/* =========================================================
   DELETE ROOM
   ========================================================= */

function deleteRoom(id) {
  const room =
    db.rooms.find(
      item => item.id === id
    );

  if (!room) return;

  const attemptCount =
    db.attempts.filter(
      attempt =>
        attempt.roomId === id
    ).length;

  const confirmed =
    confirm(
      `Delete "${room.title}"?\n\n` +
      `The room will be removed from the active room list.\n` +
      `${attemptCount} historical submission(s) will remain in the reports.\n\n` +
      `Continue?`
    );

  if (!confirmed) return;

  db.rooms =
    db.rooms.filter(
      item => item.id !== id
    );

  saveDB();

  renderAdminRooms();

  toast(
    'Examination room deleted.',
    'success'
  );
}

/* =========================================================
   MODAL
   ========================================================= */

function closeModal() {
  const modal =
    $('#modal-root');

  if (!modal) return;

  modal.hidden = true;
  modal.innerHTML = '';
}

/*
  This event listener ensures clicking the dark backdrop
  also closes the modal.
*/

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

/* =========================================================
   SUBMISSION TABLE
   ========================================================= */

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

          ${rows
            .map(
              attempt => `
                <tr>

                  <td>
                    ${esc(
                      attempt.participantId ||
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
                      attempt.examTitle ||
                      '—'
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
            )
            .join('')}

        </tbody>

      </table>

    </div>
  `;
}

/* =========================================================
   SUBMISSIONS
   ========================================================= */

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
          Every participant submission is recorded independently.
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

/* =========================================================
   VIOLATIONS
   ========================================================= */

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
          Security events recorded by individual participant sessions.
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
                    <th>Participant</th>
                    <th>Room</th>
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
                              violation.participantId ||
                              'Participant'
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
                              violation.examTitle ||
                              '—'
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

/* =========================================================
   ANALYTICS
   ========================================================= */

function renderAnalytics() {
  const counts =
    attemptCounts();

  const total =
    counts.total || 1;

  const average =
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

  const roomStats =
    db.rooms
      .map(room => ({
        room,

        count:
          db.attempts.filter(
            attempt =>
              attempt.roomId ===
              room.id
          ).length
      }))
      .sort(
        (a, b) =>
          b.count - a.count
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
          Overall examination activity and security statistics.
        </p>
      </div>

    </div>

    <div class="kpi-grid">

      ${kpi(
        'Completion Rate',
        Math.round(
          counts.completed /
          total *
          100
        ) + '%'
      )}

      ${kpi(
        'Active Sessions',
        counts.inProgress
      )}

      ${kpi(
        'Termination Rate',
        Math.round(
          counts.terminated /
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

        ${[
          ['Completed', counts.completed],
          ['In Progress', counts.inProgress],
          ['Time Expired', counts.expired],
          ['Terminated', counts.terminated]
        ]
          .map(
            ([label, number]) =>
              chart(
                label,
                number,
                counts.total
              )
          )
          .join('')}

      </div>

      <div class="panel">

        <h3>
          Sessions by Room
        </h3>

        ${
          roomStats.length
            ? roomStats
                .map(
                  item =>
                    chart(
                      item.room.roomNumber,
                      item.count,
                      counts.total
                    )
                )
                .join('')
            : `
              <div class="empty">
                No rooms available.
              </div>
            `
        }

      </div>

    </div>

    <div
      class="panel"
      style="margin-top:18px"
    >

      <h3>
        Violation Activity
      </h3>

      <p
        class="muted"
        style="font-size:12px"
      >
        ${
          db.violations.length
        }
        security events recorded across
        ${
          db.attempts.length
        }
        participant sessions.
      </p>

      <div class="progress-bar">

        <div
          class="progress-fill"
          style="width:${Math.min(
            100,
            db.violations.length * 5
          )}%"
        ></div>

      </div>

    </div>
  `;
}

function kpi(label, value) {
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
  const percentage =
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
            style="width:${percentage}%"
          ></div>

        </div>

      </div>

      <div class="chart-number">
        ${number}
        (${percentage}%)
      </div>

    </div>
  `;
}

/* =========================================================
   SETTINGS
   ========================================================= */

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
          Portal configuration and prototype data.
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
          style="font-size:12px"
        >
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

        <p
          class="muted"
          style="font-size:12px"
        >
          Rooms, submissions and violation records are stored in this browser.
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
        Administrator Account
      </h3>

      <div class="table-wrap">

        <table class="data-table">

          <thead>
            <tr>
              <th>
                Username
              </th>

              <th>
                Name
              </th>

              <th>
                Role
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
                ${esc(
                  user?.name ||
                  'Administrator'
                )}
              </td>

              <td>
                Administrator
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
        Production Note
      </h3>

      <div class="notice danger-notice">

        Do not use client-side passwords,
        localStorage authentication or
        client-side attempt records as a
        production authentication system.

        Move credentials, rooms,
        availability, sessions, timers and
        violation logs to a server-side
        database/API.

      </div>

    </div>
  `;

  bindActions();
}

/* =========================================================
   PARTICIPANT / ROOM DASHBOARD
   ========================================================= */

function openRoomDashboard() {
  const room =
    db.rooms.find(
      item =>
        item.id ===
        session?.roomId
    );

  if (!room) {
    logout();
    return;
  }

  currentRoom =
    clone(room);

  showView('room');

  renderRoomDashboard();
}

function renderRoomDashboard() {
  const room =
    currentRoom;

  if (!room) {
    logout();
    return;
  }

  const availability =
    getAvailability(room);

  const myAttempts =
    db.attempts.filter(
      attempt =>
        attempt.participantId ===
        session.participantId
    );

  const activeAttempt =
    myAttempts.find(
      attempt =>
        attempt.status ===
        'In Progress'
    );

  const completedCount =
    myAttempts.filter(
      attempt =>
        [
          'Completed',
          'Time Expired',
          'Terminated'
        ].includes(
          attempt.status
        )
    ).length;

  $('#room-user-name').textContent =
    'Participant';

  $('#room-avatar').textContent =
    'P';

  $('#room-number-display').textContent =
    room.roomNumber;

  $('#room-exam-title').textContent =
    room.title;

  $('#room-exam-description').textContent =
    room.description ||
    'Online examination';

  $('#room-status').innerHTML =
    badge(
      availability.status
    );

  $('#room-duration').textContent =
    room.timerEnabled
      ? `${room.durationMinutes} minutes`
      : 'No timer';

  $('#room-anticheat').textContent =
    room.antiCheat
      ? 'Enabled'
      : 'Disabled';

  $('#room-submissions-count').textContent =
    completedCount;

  $('#room-session-id').textContent =
    session.participantId;

  const action =
    $('#room-exam-action');

  if (!action) return;

  if (
    activeAttempt &&
    availability.status === 'Available'
  ) {
    action.innerHTML = `
      <button
        class="primary-btn"
        data-action="resume-exam"
      >
        Resume Exam
      </button>
    `;
  } else if (
    availability.status === 'Available'
  ) {
    action.innerHTML = `
      <button
        class="primary-btn"
        data-action="start-room-exam"
      >
        Start Exam
      </button>
    `;
  } else {
    action.innerHTML = `
      <button
        class="secondary-btn"
        disabled
      >
        Exam Not Available
      </button>
    `;
  }

  bindActions();
}

/* =========================================================
   START ROOM EXAM
   ========================================================= */

function startRoomExam() {
  if (!currentRoom) return;

  const availability =
    getAvailability(
      currentRoom
    );

  if (
    availability.status !==
    'Available'
  ) {
    toast(
      'This examination is not currently available.',
      'error'
    );

    return;
  }

  openStartInstructions(
    currentRoom
  );
}

function resumeExistingExam() {
  if (!currentRoom) return;

  const attempt =
    db.attempts.find(
      item =>
        item.roomId ===
          currentRoom.id &&
        item.participantId ===
          session.participantId &&
        item.status ===
          'In Progress'
    );

  if (!attempt) {
    startRoomExam();
    return;
  }

  beginExamSession(
    currentRoom,
    attempt,
    true
  );
}

/* =========================================================
   START INSTRUCTIONS
   ========================================================= */

function openStartInstructions(room) {
  const modal =
    $('#modal-root');

  if (!modal) return;

  modal.hidden = false;

  modal.innerHTML = `
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
    >

      <div class="modal-head">

        <div>

          <span class="eyebrow">
            EXAM INSTRUCTIONS
          </span>

          <h3>
            ${esc(room.title)}
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
          You may submit this examination
          independently from other participants
          in the same room.
        </div>

        <ul
          class="instruction-list"
        >

          <li>
            ${
              room.timerEnabled
                ? `
                  You have
                  <strong>
                    ${room.durationMinutes} minutes
                  </strong>
                  to complete the examination.
                `
                : `
                  No countdown timer is configured for this examination.
                `
            }
          </li>

          <li>
            ${
              room.antiCheat
                ? `
                  Anti-cheat is enabled.
                  Up to
                  <strong>
                    ${room.maxViolations}
                  </strong>
                  violations are allowed for this individual session.
                `
                : `
                  Anti-cheat monitoring is disabled.
                `
            }
          </li>

          <li>
            Complete the Google Form first.
          </li>

          <li>
            If the Google Form becomes unavailable
            after submission, use the
            <strong>
              Refresh Form
            </strong>
            button.
          </li>

          <li>
            When finished, click
            <strong>
              Submit Exam
            </strong>
            in the portal.
          </li>

        </ul>

        ${
          room.antiCheat
            ? `
              <div class="notice danger-notice">
                Fullscreen, tab/window focus and
                visibility events may be monitored.
                Browser limitations mean this is a
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
          data-action="confirm-room-start"
          data-id="${room.id}"
        >
          Start Examination
        </button>

      </div>

    </div>
  `;

  bindActions();
}

/* =========================================================
   CREATE / RESUME ATTEMPT
   ========================================================= */

function beginExamSession(
  room,
  existingAttempt = null,
  isResume = false
) {
  closeModal();

  if (!room) return;

  let attempt =
    existingAttempt;

  if (!attempt) {
    attempt = {
      id: uid('attempt'),

      roomId: room.id,

      roomNumber:
        room.roomNumber,

      examTitle:
        room.title,

      participantId:
        session.participantId,

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
  }

  currentRoom =
    clone(room);

  const timerEnabled =
    room.timerEnabled === true ||
    room.timerEnabled === 'true' ||
    room.timerEnabled === 1 ||
    room.timerEnabled === '1';

  const antiCheat =
    room.antiCheat === true ||
    room.antiCheat === 'true' ||
    room.antiCheat === 1 ||
    room.antiCheat === '1';

  const durationMinutes =
    Math.max(
      1,
      Math.round(
        Number(
          room.durationMinutes
        ) || 60
      )
    );

  /*
    On resume, calculate the remaining time
    from the original attempt start time.
  */

  let seconds =
    timerEnabled
      ? durationMinutes * 60
      : 0;

  if (
    isResume &&
    timerEnabled &&
    attempt.startedAt
  ) {
    const elapsed =
      Math.floor(
        (
          Date.now() -
          attempt.startedAt
        ) / 1000
      );

    seconds =
      Math.max(
        0,
        durationMinutes * 60 -
        elapsed
      );
  }

  examState = {
    attemptId:
      attempt.id,

    seconds,

    timerEnabled,

    antiCheat,

    maxViolations:
      Math.max(
        1,
        Number(
          room.maxViolations
        ) || 3
      ),

    startedAt:
      attempt.startedAt,

    active:
      true
  };

  $('#live-exam-title').textContent =
    room.title;

  $('#live-exam-examiner').textContent =
    `Room ${room.roomNumber} • Participant ${session.participantId}`;

  $('#exam-violations').textContent =
    `${attempt.violations || 0} / ${room.maxViolations}`;

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

  /*
    Load Google Form.
  */

  loadGoogleForm();

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
    requestFullscreen().finally(
      () => {
        graceUntil =
          Date.now() + GRACE;
      }
    );
  }

  if (
    timerEnabled &&
    seconds <= 0
  ) {
    finishExam(
      'Time Expired',
      'Time Expired',
      'Your allotted examination time has ended.',
      '⌛'
    );

    return;
  }

  if (timerEnabled) {
    startTimer();
  } else {
    renderTimer();
  }
}

/* =========================================================
   GOOGLE FORM
   ========================================================= */

function loadGoogleForm() {
  if (!currentRoom) return;

  const iframe =
    $('#exam-iframe');

  if (!iframe) return;

  /*
    Add a cache-busting parameter.

    This helps when the Google Form page becomes stale
    inside an iframe after a previous submission.
  */

  let url =
    String(
      currentRoom.formUrl || ''
    ).trim();

  if (!url) return;

  try {
    const parsed =
      new URL(url);

    parsed.searchParams.set(
      'embedded',
      'true'
    );

    parsed.searchParams.set(
      'proctorRefresh',
      Date.now()
    );

    url =
      parsed.toString();
  } catch {
    if (
      url.includes('?')
    ) {
      url +=
        '&proctorRefresh=' +
        Date.now();
    } else {
      url +=
        '?proctorRefresh=' +
        Date.now();
    }
  }

  iframe.src =
    'about:blank';

  setTimeout(() => {
    if (
      examState?.active
    ) {
      iframe.src = url;
    }
  }, 100);
}

function refreshGoogleForm() {
  if (!examState?.active) {
    return;
  }

  const button =
    $('#refresh-form-btn');

  if (button) {
    button.disabled = true;
    button.textContent =
      'Refreshing...';
  }

  const iframe =
    $('#exam-iframe');

  if (iframe) {
    iframe.style.opacity = '0.45';
  }

  loadGoogleForm();

  setTimeout(() => {
    if (button) {
      button.disabled = false;
      button.textContent =
        '↻ Refresh Form';
    }

    if (iframe) {
      iframe.style.opacity = '1';
    }
  }, 900);
}

/* =========================================================
   FULLSCREEN
   ========================================================= */

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

/* =========================================================
   TIMER
   ========================================================= */

function startTimer() {
  clearInterval(timer);

  renderTimer();

  timer =
    setInterval(() => {
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
      !!examState?.timerEnabled
    );
  }

  const duration =
    Math.max(
      1,
      Math.round(
        Number(
          currentRoom?.durationMinutes
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
              (
                duration *
                60
              )
            ) *
              100
          )
        )
      : 0;

  const progress =
    $('#exam-progress');

  if (progress) {
    progress.style.width =
      (
        100 -
        percentage
      ) + '%';
  }
}

/* =========================================================
   PROCTORING
   ========================================================= */

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
      item =>
        item.id ===
        examState.attemptId
    );

  if (!attempt) {
    return;
  }

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

    roomId:
      currentRoom.id,

    roomNumber:
      currentRoom.roomNumber,

    examTitle:
      currentRoom.title,

    participantId:
      session.participantId,

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

  $('#exam-iframe').style.filter =
    'blur(6px) brightness(.45)';
}

function closeViolationOverlay() {
  if (!examState?.active) {
    return;
  }

  $('#violation-overlay').hidden =
    true;

  violationOverlayOpen =
    false;

  $('#exam-iframe').style.filter =
    '';

  graceUntil =
    Date.now() + GRACE;

  requestFullscreen().finally(
    () => {
      graceUntil =
        Date.now() + GRACE;
    }
  );
}

$('#resume-exam-btn')
  ?.addEventListener(
    'click',
    closeViolationOverlay
  );

/* =========================================================
   PROCTORING EVENTS
   ========================================================= */

[
  'fullscreenchange',
  'webkitfullscreenchange',
  'mozfullscreenchange'
].forEach(
  eventName => {
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
  }
);

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
        'The examination window lost focus.'
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

/* =========================================================
   SUBMIT EXAM
   ========================================================= */

function submitExam() {
  if (
    !examState?.active
  ) {
    return;
  }

  const confirmed =
    confirm(
      'Confirm that you have submitted the Google Form.\n\n' +
      'This will permanently end this examination session.\n\n' +
      'Continue?'
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

  if (attempt) {
    attempt.status =
      status;

    attempt.endedAt =
      Date.now();
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

  $('#result-icon').style.background =
    terminated
      ? 'rgba(239,91,103,.12)'
      : 'rgba(49,196,141,.12)';

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
    currentRoom?.title ||
    '—';

  $('#result-user').textContent =
    session?.participantId ||
    '—';

  $('#result-violations').textContent =
    attempt?.violations ||
    0;

  $('#result-ended').textContent =
    fmtDate(Date.now());

  showView('result');
}

/* =========================================================
   RESULT DASHBOARD
   ========================================================= */

function returnToRoomDashboard() {
  currentRoom = null;
  examState = null;

  openRoomDashboard();
}

/* =========================================================
   ACTION BINDING
   ========================================================= */

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
        () => {
          const action =
            button.dataset.action;

          const id =
            button.dataset.id;

          switch (action) {
            case 'new-room':
              openRoomModal();
              break;

            case 'edit-room':
              openRoomModal(id);
              break;

            case 'delete-room':
              deleteRoom(id);
              break;

            case 'close-modal':
              closeModal();
              break;

            case 'confirm-room-start': {
              const room =
                db.rooms.find(
                  item =>
                    item.id === id
                );

              if (
                room &&
                getAvailability(
                  room
                ).status ===
                  'Available'
              ) {
                beginExamSession(
                  room
                );
              } else {
                toast(
                  'This examination room is not currently available.',
                  'error'
                );
              }

              break;
            }

            case 'start-room-exam':
              startRoomExam();
              break;

            case 'resume-exam':
              resumeExistingExam();
              break;

            case 'view-submissions':
              adminPage(
                'submissions'
              );
              break;

            case 'refresh-admin':
              db = loadDB();

              renderAdminPage(
                $('#admin-page-title')
                  ?.textContent
                  ?.toLowerCase()
                  ?.replace(
                    ' ',
                    '-'
                  ) || 'dashboard'
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

            case 'close-violation':
              closeViolationOverlay();
              break;
          }
        }
      );
    });
}

/* =========================================================
   RESET
   ========================================================= */

function resetDemo() {
  const confirmed =
    confirm(
      'Reset all rooms, submissions and violation logs?\n\nThis cannot be undone.'
    );

  if (!confirmed) {
    return;
  }

  db = clone(seed);

  saveDB();

  toast(
    'Demo data has been reset.',
    'success'
  );

  openAdmin();
}

/* =========================================================
   CLOCK
   ========================================================= */

setInterval(
  () => {
    const now =
      new Date().toLocaleString();

    $('#admin-clock').textContent =
      now;

    $('#room-clock').textContent =
      now;
  },
  1000
);

/* =========================================================
   SIDEBAR
   ========================================================= */

$$('[data-toggle-sidebar]')
  .forEach(button => {
    button.addEventListener(
      'click',
      () => {
        const target =
          $('#' +
            button.dataset
              .toggleSidebar);

        target?.classList.toggle(
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

/* =========================================================
   LOGOUT
   ========================================================= */

$('#admin-logout')
  ?.addEventListener(
    'click',
    logout
  );

$('#room-logout')
  ?.addEventListener(
    'click',
    logout
  );

/* =========================================================
   EXAM CONTROLS
   ========================================================= */

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

$('#result-dashboard-btn')
  ?.addEventListener(
    'click',
    returnToRoomDashboard
  );

$('#theme-toggle-login')
  ?.addEventListener(
    'click',
    toggleTheme
  );

$('#theme-toggle-admin')
  ?.addEventListener(
    'click',
    toggleTheme
  );

$('#theme-toggle-room')
  ?.addEventListener(
    'click',
    toggleTheme
  );

/* =========================================================
   VIOLATION OVERLAY
   ========================================================= */

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

/* =========================================================
   INITIALIZATION
   ========================================================= */

function initializePortal() {
  db = loadDB();

  initAuthentication();

  applyTheme();

  syncViolationOverlay();

  if (
    session &&
    (
      session.role === 'admin' ||
      (
        session.role ===
          'participant' &&
        session.roomId
      )
    )
  ) {
    openPortal();
  } else {
    session = null;

    saveSession();

    showView('login');
  }

  bindActions();
}

/* =========================================================
   DOM READY
   ========================================================= */

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
