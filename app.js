/*
  Proctor+
  Shared Room Examination Portal

  IMPORTANT:
  - Firebase Realtime Database is the shared source of truth.
  - Every computer must use the SAME Firebase configuration below.
  - Anonymous Firebase Authentication must be enabled.
  - Realtime Database rules must allow the required read/write access.
  - There is NO room-level submission limit.
  - There is NO participant-level submission limit.
  - Each browser/computer receives an independent participant session.
*/

(() => {
  'use strict';

  /* ============================================================
     FIREBASE CONFIGURATION
     ============================================================

     IMPORTANT:
     Copy the EXACT SAME Firebase configuration to EVERY COMPUTER.

     Firebase Console:
     Project Settings
       → Your apps
       → Web app
       → SDK setup and configuration

     ============================================================ */

  const FIREBASE_CONFIG = {
    apiKey: 'PASTE_YOUR_FIREBASE_API_KEY',
    authDomain: 'PASTE_YOUR_PROJECT.firebaseapp.com',
    databaseURL: 'https://PASTE_YOUR_PROJECT-default-rtdb.firebaseio.com',
    projectId: 'PASTE_YOUR_PROJECT',
    storageBucket: 'PASTE_YOUR_PROJECT.firebasestorage.app',
    messagingSenderId: 'PASTE_YOUR_SENDER_ID',
    appId: 'PASTE_YOUR_APP_ID'
  };

  /* ============================================================
     SYSTEM DEFAULTS
     ============================================================ */

  const DEFAULT_ADMIN = {
    username: 'admin',
    password: '123admin',
    name: 'Administrator'
  };

  const DEFAULT_FORM =
    'https://docs.google.com/forms/d/e/1FAIpQLSf_PLACEHOLDER_FORM_ID/viewform?embedded=true';

  const THEME_KEY = 'proctor_plus_theme';
  const SESSION_KEY = 'proctor_plus_session_v4';

  const DEBOUNCE = 650;
  const GRACE_PERIOD = 1800;

  /* ============================================================
     HELPERS
     ============================================================ */

  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];

  const esc = (value = '') =>
    String(value).replace(/[&<>'"]/g, char => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[char]));

  const clone = value => JSON.parse(JSON.stringify(value));

  const uid = (prefix = 'id') =>
    `${prefix}-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 10)}`;

  const fmtDate = timestamp =>
    timestamp
      ? new Date(timestamp).toLocaleString([], {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        })
      : '—';

  const fmtTime = seconds => {
    const total = Math.max(0, Number(seconds) || 0);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;

    if (hours > 0) {
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }

    return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  /* ============================================================
     STATE
     ============================================================ */

  let firebaseReady = false;
  let dbRef = null;
  let authUser = null;

  let data = {
    exams: {},
    attempts: {},
    violations: {},
    admin: clone(DEFAULT_ADMIN)
  };

  let session = loadSession();

  let currentExam = null;
  let examState = null;
  let timer = null;

  let violationOverlayOpen = false;
  let graceUntil = 0;
  let lastViolation = 0;

  const views = {
    login: $('#login-view'),
    admin: $('#admin-view'),
    room: $('#examiner-view'),
    exam: $('#exam-view'),
    result: $('#result-view')
  };

  /* ============================================================
     SESSION
     ============================================================ */

  function loadSession() {
    try {
      return JSON.parse(
        sessionStorage.getItem(SESSION_KEY) || 'null'
      );
    } catch (_) {
      return null;
    }
  }

  function saveSession() {
    if (session) {
      sessionStorage.setItem(
        SESSION_KEY,
        JSON.stringify(session)
      );
    } else {
      sessionStorage.removeItem(SESSION_KEY);
    }
  }

  function clearSession() {
    session = null;
    saveSession();
  }

  /* ============================================================
     FIREBASE
     ============================================================ */

  function firebaseConfigured() {
    return Object.values(FIREBASE_CONFIG).every(value =>
      value &&
      !String(value).includes('PASTE_YOUR_')
    );
  }

  async function initFirebase() {
    if (!firebaseConfigured()) {
      showConnectionState(
        false,
        'Firebase is not configured. Use the same Firebase configuration on every computer.'
      );
      return false;
    }

    try {
      if (!firebase.apps.length) {
        firebase.initializeApp(FIREBASE_CONFIG);
      }

      await firebase.auth().signInAnonymously();

      authUser = firebase.auth().currentUser;

      dbRef = firebase.database().ref('proctorPlus');

      firebaseReady = true;

      /*
        Real-time listener.

        This is the important part:
        whenever the administrator creates/updates/deletes a room,
        every connected computer receives the updated data.
      */
      dbRef.on(
        'value',
        snapshot => {
          const incoming = snapshot.val() || {};

          data = {
            exams: incoming.exams || {},
            attempts: incoming.attempts || {},
            violations: incoming.violations || {},
            admin: incoming.admin || clone(DEFAULT_ADMIN)
          };

          /*
            Keep the administrator account consistent.
            The default credentials are shared across computers.
          */
          if (!incoming.admin) {
            dbRef.child('admin').set(DEFAULT_ADMIN);
          }

          showConnectionState(
            true,
            'Connected to shared Proctor+ examination system'
          );

          renderCurrentScreen();
        },
        error => {
          console.error('Firebase listener error:', error);

          showConnectionState(
            false,
            'Unable to synchronize with the shared examination database.'
          );

          toast(
            'Shared database connection failed.',
            'error'
          );
        }
      );

      /*
        Create the shared administrator account if it does not exist.
      */
      const snapshot = await dbRef.child('admin').once('value');

      if (!snapshot.exists()) {
        await dbRef.child('admin').set(DEFAULT_ADMIN);
      }

      showConnectionState(
        true,
        'Connected to shared Proctor+ examination system'
      );

      return true;

    } catch (error) {
      console.error('Firebase initialization error:', error);

      showConnectionState(
        false,
        'Firebase connection failed. Check your configuration and Firebase settings.'
      );

      return false;
    }
  }

  function showConnectionState(connected, message) {
    const el = $('#connection-status');

    if (!el) return;

    el.className =
      `connection-status ${connected ? 'online' : 'offline'}`;

    const text = el.querySelector('span:last-child');

    if (text) {
      text.textContent = message;
    }
  }

  function requireFirebase() {
    if (!firebaseReady || !dbRef) {
      toast(
        'The shared examination database is not connected.',
        'error'
      );

      return false;
    }

    return true;
  }

  async function setPath(path, value) {
    if (!requireFirebase()) return false;

    try {
      await dbRef.child(path).set(value);
      return true;
    } catch (error) {
      console.error(error);

      toast(
        'Unable to save shared data.',
        'error'
      );

      return false;
    }
  }

  async function updatePath(path, value) {
    if (!requireFirebase()) return false;

    try {
      await dbRef.child(path).update(value);
      return true;
    } catch (error) {
      console.error(error);

      toast(
        'Unable to update shared data.',
        'error'
      );

      return false;
    }
  }

  /* ============================================================
     DATA HELPERS
     ============================================================ */

  function examList() {
    return Object.values(data.exams || {})
      .sort(
        (a, b) =>
          (b.createdAt || 0) -
          (a.createdAt || 0)
      );
  }

  function attemptList() {
    return Object.values(data.attempts || {})
      .sort(
        (a, b) =>
          (b.startedAt || 0) -
          (a.startedAt || 0)
      );
  }

  function violationList() {
    return Object.values(data.violations || {})
      .sort(
        (a, b) =>
          (b.timestamp || 0) -
          (a.timestamp || 0)
      );
  }

  /* ============================================================
     UI
     ============================================================ */

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
    const host = $('#toast-container');

    if (!host) return;

    const element = document.createElement('div');

    element.className = `toast ${type}`;
    element.textContent = message;

    host.appendChild(element);

    setTimeout(() => {
      element.remove();
    }, 3500);
  }

  function applyTheme() {
    const theme =
      localStorage.getItem(THEME_KEY) || 'dark';

    document.body.classList.toggle(
      'light',
      theme === 'light'
    );

    document.documentElement.dataset.theme = theme;

    [
      'theme-toggle-login',
      'theme-toggle-admin',
      'theme-toggle-examiner'
    ].forEach(id => {
      const button = $('#' + id);

      if (button) {
        button.textContent =
          theme === 'light' ? '☾' : '☼';
      }
    });
  }

  function toggleTheme() {
    const current =
      localStorage.getItem(THEME_KEY) || 'dark';

    localStorage.setItem(
      THEME_KEY,
      current === 'dark' ? 'light' : 'dark'
    );

    applyTheme();
  }

  /* ============================================================
     MODALS
     ============================================================ */

  function openModal(html) {
    const root = $('#modal-root');

    if (!root) return;

    root.innerHTML = html;
    root.hidden = false;

    document.body.classList.add('modal-open');

    /*
      Make sure the modal starts at the top.
    */
    const body = root.querySelector('.modal-scroll');

    if (body) {
      body.scrollTop = 0;
    }
  }

  function closeModal() {
    const root = $('#modal-root');

    if (!root) return;

    root.hidden = true;
    root.innerHTML = '';

    document.body.classList.remove('modal-open');
  }

  /* ============================================================
     LOGIN
     ============================================================ */

  $('#room-login-form')?.addEventListener(
    'submit',
    async event => {
      event.preventDefault();

      const roomNumber =
        $('#login-room').value.trim();

      const passcode =
        $('#login-passcode').value.trim();

      const error =
        $('#login-error');

      error.hidden = true;

      if (!requireFirebase()) return;

      /*
        IMPORTANT:
        Search the shared Firebase data, NOT localStorage.
      */
      const exam = examList().find(room =>
        String(room.roomNumber || '')
          .trim()
          .toLowerCase() ===
          roomNumber.toLowerCase() &&
        String(room.passcode || '') ===
          passcode
      );

      if (!exam) {
        error.textContent =
          'Room Number or Passcode is incorrect. Make sure this computer is connected to the same Proctor+ Firebase project.';

        error.hidden = false;

        $('#login-room').focus();

        return;
      }

      const availability =
        getAvailability(exam);

      if (availability.status !== 'Available') {
        error.textContent =
          availability.message;

        error.hidden = false;

        return;
      }

      /*
        Every computer gets a NEW participant session.

        There is deliberately no shared participant lock.
      */
      session = {
        role: 'room',
        roomId: exam.id,
        roomNumber: exam.roomNumber,
        participantId: uid('candidate')
      };

      saveSession();

      $('#room-login-form').reset();

      openRoomDashboard();
    }
  );

  /* ============================================================
     ADMIN LOGIN
     ============================================================ */

  function openAdminLogin() {
    openModal(`
      <div class="modal modal-compact">

        <div class="modal-head">
          <div>
            <span class="eyebrow">ADMINISTRATION</span>
            <h3>Administrator Login</h3>
          </div>

          <button
            type="button"
            class="close-btn"
            data-action="close-modal"
            aria-label="Close"
          >×</button>
        </div>

        <form id="admin-login-form">

          <div class="modal-body">

            <div class="field">
              <label class="form-label">
                Admin Username
              </label>

              <input
                id="admin-username"
                type="text"
                autocomplete="username"
                value="admin"
                required
              >
            </div>

            <div class="field">
              <label class="form-label">
                Admin Password
              </label>

              <input
                id="admin-password"
                type="password"
                autocomplete="current-password"
                required
              >
            </div>

            <p
              id="admin-login-error"
              class="form-error"
              hidden
            ></p>

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
    `);
  }

  async function adminLogin(event) {
    event.preventDefault();

    const username =
      $('#admin-username').value.trim();

    const password =
      $('#admin-password').value;

    const error =
      $('#admin-login-error');

    /*
      Use the SHARED Firebase administrator record.

      This prevents one computer from having a completely
      different locally stored administrator account.
    */
    const admin =
      data.admin || DEFAULT_ADMIN;

    const valid =
      username.toLowerCase() ===
        String(admin.username || DEFAULT_ADMIN.username)
          .toLowerCase() &&
      password ===
        String(admin.password || DEFAULT_ADMIN.password);

    if (!valid) {
      error.textContent =
        'Incorrect administrator credentials.';

      error.hidden = false;

      return;
    }

    session = {
      role: 'admin',
      adminUsername:
        admin.username || DEFAULT_ADMIN.username
    };

    saveSession();

    closeModal();

    openAdmin();
  }

  /* ============================================================
     LOGOUT
     ============================================================ */

  function logout() {
    if (examState?.active) {
      toast(
        'Submit or finish the current examination before logging out.',
        'error'
      );

      return;
    }

    clearSession();

    currentExam = null;
    examState = null;

    showView('login');
  }

  /* ============================================================
     ADMIN
     ============================================================ */

  const pageTitles = {
    dashboard: 'Dashboard',
    exams: 'Rooms & Examinations',
    submissions: 'Submissions',
    violations: 'Security Events',
    analytics: 'Analytics',
    settings: 'Settings'
  };

  function openAdmin() {
    $('#admin-user-name').textContent =
      data.admin?.name ||
      DEFAULT_ADMIN.name;

    $('#admin-user-role').textContent =
      'System Administrator';

    $('#admin-avatar').textContent =
      (
        data.admin?.name ||
        DEFAULT_ADMIN.name
      )[0].toUpperCase();

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

    $$('.admin-page').forEach(element => {
      element.classList.remove('active');
    });

    $('#admin-' + page + '-page')
      ?.classList.add('active');

    $('#admin-page-title').textContent =
      pageTitles[page] || page;

    renderAdminPage(page);

    $('#admin-sidebar')?.classList.remove('open');
  }

  function renderAdminPage(page) {
    const pages = {
      dashboard: renderAdminDashboard,
      exams: renderAdminExams,
      submissions: renderSubmissions,
      violations: renderViolations,
      analytics: renderAnalytics,
      settings: renderSettings
    };

    if (pages[page]) {
      pages[page]();
    }
  }

  function attemptCounts() {
    const attempts = attemptList();

    return {
      total: attempts.length,

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

  function stat(label, value, cls = '') {
    return `
      <div class="stat-card ${cls}">
        <span class="stat-label">
          ${esc(label)}
        </span>

        <span class="stat-value">
          ${esc(value)}
        </span>
      </div>
    `;
  }

  /* ============================================================
     ADMIN DASHBOARD
     ============================================================ */

  function renderAdminDashboard() {
    const counts = attemptCounts();

    const rooms =
      examList().filter(
        exam => exam.active
      ).length;

    const completion =
      counts.total
        ? Math.round(
            counts.completed /
            counts.total *
            100
          )
        : 0;

    $('#admin-dashboard-page').innerHTML = `

      <div class="hero-banner">

        <div>
          <span class="eyebrow">
            PROCTOR+ CONTROL CENTER
          </span>

          <h1>
            Examination Operations
          </h1>

          <p>
            Manage shared examination rooms,
            monitor active sessions and review
            examination activity from one
            centralized workspace.
          </p>
        </div>

        <button
          class="primary-btn hero-action"
          data-action="new-exam"
        >
          + Create Examination Room
        </button>

      </div>

      <div class="stat-grid">

        ${stat(
          'Active Rooms',
          rooms,
          'success'
        )}

        ${stat(
          'Live Sessions',
          counts.inProgress,
          'blue'
        )}

        ${stat(
          'Completed',
          counts.completed,
          'success'
        )}

        ${stat(
          'Time Expired',
          counts.expired,
          'warning'
        )}

        ${stat(
          'Terminated',
          counts.terminated,
          'danger'
        )}

        ${stat(
          'Total Sessions',
          counts.total
        )}

      </div>

      <div class="dashboard-grid">

        <div class="panel">

          <div class="panel-heading">

            <div>
              <span class="eyebrow">
                PERFORMANCE
              </span>

              <h3>
                Completion Overview
              </h3>
            </div>

            <strong class="large-number">
              ${completion}%
            </strong>

          </div>

          <div class="progress-bar">
            <div
              class="progress-fill"
              style="width:${completion}%"
            ></div>
          </div>

          <div class="progress-meta">
            <span>
              ${counts.completed} completed
            </span>

            <span>
              ${counts.total} total sessions
            </span>
          </div>

        </div>

        <div class="panel">

          <span class="eyebrow">
            SHARED ROOM MODEL
          </span>

          <h3>
            Multi-Computer Access
          </h3>

          <p class="muted">
            Rooms are synchronized through the
            shared database. Multiple computers
            can enter the same room at the same
            time.
          </p>

          <div class="feature-grid">

            <div>
              <strong>∞</strong>
              <span>Submission Limit</span>
            </div>

            <div>
              <strong>${examList().length}</strong>
              <span>Configured Rooms</span>
            </div>

            <div>
              <strong>LIVE</strong>
              <span>Shared Synchronization</span>
            </div>

          </div>

        </div>

      </div>

      <div class="panel">

        <div class="panel-heading">

          <div>
            <span class="eyebrow">
              RECENT ACTIVITY
            </span>

            <h3>
              Latest Examination Sessions
            </h3>

            <p class="muted">
              Activity from every room and
              participating computer.
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
          attemptList().slice(0, 10)
        )}

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
          No examination sessions recorded yet.
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
              <th>Examination</th>
              <th>Started</th>
              <th>Ended</th>
              <th>Status</th>
              <th>Violations</th>
            </tr>
          </thead>

          <tbody>

            ${rows.map(attempt => `
              <tr>

                <td>
                  ${esc(
                    attempt.participantId ||
                    'Participant'
                  )}
                </td>

                <td>
                  <strong>
                    ${esc(
                      attempt.roomNumber || '—'
                    )}
                  </strong>
                </td>

                <td>
                  ${esc(
                    attempt.examTitle || '—'
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
                  ${badge(attempt.status)}
                </td>

                <td>
                  ${attempt.violations || 0}
                </td>

              </tr>
            `).join('')}

          </tbody>

        </table>

      </div>
    `;
  }

  function badge(status) {
    const colors = {
      Completed: 'green',
      'Time Expired': 'yellow',
      Terminated: 'red',
      'In Progress': 'blue',
      Available: 'green',
      Unavailable: 'gray',
      ACTIVE: 'green',
      DISABLED: 'gray'
    };

    return `
      <span class="badge ${colors[status] || 'gray'}">
        ${esc(status)}
      </span>
    `;
  }

  /* ============================================================
     ROOMS
     ============================================================ */

  function renderAdminExams() {
    const rooms = examList();

    $('#admin-exams-page').innerHTML = `

      <div class="hero-banner compact">

        <div>

          <span class="eyebrow">
            ROOM MANAGEMENT
          </span>

          <h1>
            Examination Rooms
          </h1>

          <p>
            Create and manage shared examination
            rooms. Each room can be accessed by
            multiple computers simultaneously.
          </p>

        </div>

        <button
          class="primary-btn"
          data-action="new-exam"
        >
          + Create Room
        </button>

      </div>

      <div class="room-grid">

        ${
          rooms.length
            ? rooms.map(examCard).join('')
            : `
              <div class="panel empty-panel">
                <div class="empty">
                  No examination rooms have been
                  created yet.
                </div>
              </div>
            `
        }

      </div>
    `;
  }

  function examCard(exam) {
    const attempts =
      attemptList().filter(
        attempt =>
          attempt.examId === exam.id
      );

    const live =
      attempts.filter(
        attempt =>
          attempt.status === 'In Progress'
      ).length;

    const availability =
      getAvailability(exam);

    return `
      <article class="room-card">

        <div class="room-card-top">

          <div>
            <span class="room-label">
              ROOM
            </span>

            <strong class="room-number">
              ${esc(exam.roomNumber)}
            </strong>
          </div>

          <div class="room-statuses">
            <span class="badge ${
              exam.active
                ? 'green'
                : 'gray'
            }">
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

        </div>

        <div class="room-passcode">
          Passcode:
          <strong>
            ${esc(exam.passcode)}
          </strong>
        </div>

        <h3>
          ${esc(exam.title)}
        </h3>

        <p>
          ${esc(
            exam.description ||
            'No examination description provided.'
          )}
        </p>

        <div class="room-metrics">

          <div>
            <span>Timer</span>
            <strong>
              ${
                exam.timerEnabled
                  ? `${exam.durationMinutes} min`
                  : 'Off'
              }
            </strong>
          </div>

          <div>
            <span>Anti-Cheat</span>
            <strong>
              ${
                exam.antiCheat
                  ? 'Enabled'
                  : 'Disabled'
              }
            </strong>
          </div>

          <div>
            <span>Live</span>
            <strong>
              ${live}
            </strong>
          </div>

          <div>
            <span>Sessions</span>
            <strong>
              ${attempts.length}
            </strong>
          </div>

        </div>

        <div class="room-card-actions">

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
    if (!exam.active) {
      return {
        status: 'Unavailable',
        message:
          'This examination room is currently disabled.'
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
        status: 'Unavailable',
        message:
          `This room opens on ${fmtDate(start)}.`
      };
    }

    if (end && now > end) {
      return {
        status: 'Unavailable',
        message:
          'This examination room is no longer available.'
      };
    }

    return {
      status: 'Available',
      message:
        'The examination room is available.'
    };
  }

  function isoLocal(value) {
    if (!value) return '';

    const date = new Date(value);

    const pad =
      number =>
        String(number).padStart(2, '0');

    return `${date.getFullYear()}-${pad(
      date.getMonth() + 1
    )}-${pad(
      date.getDate()
    )}T${pad(
      date.getHours()
    )}:${pad(
      date.getMinutes()
    )}`;
  }

  /* ============================================================
     EXAM EDITOR
     ============================================================ */

  function openExamModal(id = null) {
    const exam =
      id ? data.exams[id] : null;

    const values =
      exam || {
        roomNumber: '',
        passcode: '',
        title: '',
        description: '',
        formUrl: DEFAULT_FORM,
        antiCheat: true,
        maxViolations: 3,
        timerEnabled: true,
        durationMinutes: 60,
        startAt: '',
        endAt: '',
        active: true
      };

    openModal(`

      <div class="modal modal-editor">

        <div class="modal-head">

          <div>
            <span class="eyebrow">
              ${
                exam
                  ? 'EDIT EXAMINATION'
                  : 'NEW EXAMINATION'
              }
            </span>

            <h3>
              ${
                exam
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

        <!-- IMPORTANT:
             This area is scrollable so all editor
             fields remain accessible. -->

        <form
          id="exam-form"
          data-editing-id="${exam ? exam.id : ''}"
        >

          <div class="modal-body modal-scroll">

            <div class="editor-notice">

              <div class="editor-notice-icon">
                ✓
              </div>

              <div>

                <strong>
                  Shared Examination Room
                </strong>

                <span>
                  Participants on different computers
                  can use the same Room Number and
                  Passcode simultaneously. Every
                  examination session is tracked
                  independently and there is no
                  submission limit.
                </span>

              </div>

            </div>

            <div class="form-grid">

              <div class="field">

                <label class="form-label">
                  Room Number
                </label>

                <input
                  name="roomNumber"
                  required
                  value="${esc(values.roomNumber)}"
                  placeholder="e.g. HR-2026-01"
                >

              </div>

              <div class="field">

                <label class="form-label">
                  Room Passcode
                </label>

                <input
                  name="passcode"
                  required
                  value="${esc(values.passcode)}"
                  placeholder="Enter room passcode"
                >

              </div>

              <div class="field full-span">

                <label class="form-label">
                  Examination Title
                </label>

                <input
                  name="title"
                  required
                  value="${esc(values.title)}"
                  placeholder="e.g. HR Certification Examination"
                >

              </div>

              <div class="field full-span">

                <label class="form-label">
                  Description
                </label>

                <textarea
                  name="description"
                  rows="5"
                  placeholder="Describe the purpose, scope and instructions for this examination."
                >${esc(values.description)}</textarea>

              </div>

              <div class="field full-span">

                <label class="form-label">
                  Google Forms Link
                </label>

                <input
                  name="formUrl"
                  type="url"
                  required
                  value="${esc(values.formUrl)}"
                  placeholder="https://docs.google.com/forms/d/e/.../viewform?embedded=true"
                >

                <div class="helper">
                  Participants can refresh the embedded
                  Google Form during an active session.
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
                  value="${Number(values.maxViolations) || 3}"
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
                  value="${Number(values.durationMinutes) || 60}"
                >

                <div class="helper">
                  Duration is in minutes.
                </div>

              </div>

              <div class="field full-span">

                <div class="checkbox-row">

                  <input
                    id="antiCheat"
                    name="antiCheat"
                    type="checkbox"
                    ${values.antiCheat ? 'checked' : ''}
                  >

                  <label for="antiCheat">
                    Enable anti-cheat monitoring
                  </label>

                </div>

                <div class="helper">
                  Detects common tab switching,
                  focus loss, fullscreen exit and
                  restricted keyboard shortcuts.
                </div>

              </div>

              <div class="field full-span">

                <div class="checkbox-row">

                  <input
                    id="timerEnabled"
                    name="timerEnabled"
                    type="checkbox"
                    ${values.timerEnabled ? 'checked' : ''}
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
                  value="${isoLocal(values.startAt)}"
                >

                <div class="helper">
                  Leave blank for immediate access.
                </div>

              </div>

              <div class="field">

                <label class="form-label">
                  Available Until
                </label>

                <input
                  name="endAt"
                  type="datetime-local"
                  value="${isoLocal(values.endAt)}"
                >

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
                    ${values.active ? 'checked' : ''}
                  >

                  <label for="active">
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
                exam
                  ? 'Save Changes'
                  : 'Create Examination Room'
              }
            </button>

          </div>

        </form>

      </div>
    `);
  }

  async function saveExam(event) {
    event.preventDefault();

    const form = event.currentTarget;

    const formData =
      new FormData(form);

    const roomNumber =
      String(
        formData.get('roomNumber') || ''
      ).trim();

    const passcode =
      String(
        formData.get('passcode') || ''
      ).trim();

    const title =
      String(
        formData.get('title') || ''
      ).trim();

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

    if (
      !roomNumber ||
      !passcode ||
      !title
    ) {
      toast(
        'Room Number, Passcode and Examination Title are required.',
        'error'
      );

      return;
    }

    if (!requireFirebase()) return;

    const editingId =
      form.dataset.editingId || '';

    /*
      Room numbers must remain unique so participants
      cannot accidentally enter the wrong examination.
    */
    const duplicate =
      examList().find(exam =>
        String(exam.roomNumber)
          .trim()
          .toLowerCase() ===
          roomNumber.toLowerCase() &&
        exam.id !== editingId
      );

    if (duplicate) {
      toast(
        'That Room Number is already in use.',
        'error'
      );

      return;
    }

    const existing =
      editingId
        ? data.exams[editingId]
        : null;

    const exam = {
      id:
        editingId ||
        uid('exam'),

      roomNumber,

      passcode,

      title,

      description:
        String(
          formData.get('description') || ''
        ).trim(),

      formUrl,

      antiCheat:
        formData.has('antiCheat'),

      maxViolations:
        Math.max(
          1,
          Number(
            formData.get('maxViolations')
          ) || 3
        ),

      timerEnabled:
        formData.has('timerEnabled'),

      durationMinutes:
        Math.max(
          1,
          Number(
            formData.get('durationMinutes')
          ) || 60
        ),

      startAt:
        formData.get('startAt')
          ? new Date(
              formData.get('startAt')
            ).toISOString()
          : '',

      endAt:
        formData.get('endAt')
          ? new Date(
              formData.get('endAt')
            ).toISOString()
          : '',

      active:
        formData.has('active'),

      createdAt:
        existing?.createdAt ||
        Date.now(),

      createdBy:
        'admin'
    };

    const saved =
      await setPath(
        `exams/${exam.id}`,
        exam
      );

    if (!saved) return;

    closeModal();

    toast(
      editingId
        ? 'Examination room updated and synchronized.'
        : 'Examination room created and synchronized.',
      'success'
    );

    adminPage('exams');
  }

  async function deleteExam(id) {
    const exam =
      data.exams[id];

    if (
      !exam ||
      !requireFirebase()
    ) {
      return;
    }

    const confirmed =
      confirm(
        `Delete room "${exam.roomNumber} — ${exam.title}"?\n\nHistorical submissions will remain available in reports, but new participants will no longer be able to enter this room.`
      );

    if (!confirmed) return;

    await dbRef
      .child(`exams/${id}`)
      .remove();

    toast(
      'Examination room deleted.',
      'success'
    );

    adminPage('exams');
  }

  /* ============================================================
     SUBMISSIONS
     ============================================================ */

  function renderSubmissions() {
    $('#admin-submissions-page').innerHTML = `

      <div class="page-head">

        <div>

          <span class="eyebrow">
            MONITORING
          </span>

          <h3>
            Examination Submissions
          </h3>

          <p>
            Every participant session is recorded
            independently. There is no submission
            cap.
          </p>

        </div>

        <button
          class="secondary-btn"
          data-action="refresh-admin"
        >
          ↻ Refresh
        </button>

      </div>

      <div class="panel">

        ${submissionTable(
          attemptList()
        )}

      </div>
    `;
  }

  /* ============================================================
     SECURITY EVENTS
     ============================================================ */

  function renderViolations() {
    const violations =
      violationList();

    $('#admin-violations-page').innerHTML = `

      <div class="page-head">

        <div>

          <span class="eyebrow">
            SECURITY
          </span>

          <h3>
            Security Events
          </h3>

          <p>
            Events are recorded against individual
            examination sessions.
          </p>

        </div>

      </div>

      <div class="panel">

        ${
          violations.length
            ? `
              <div class="table-wrap">

                <table class="data-table">

                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Participant</th>
                      <th>Room</th>
                      <th>Examination</th>
                      <th>Event</th>
                      <th>Reason</th>
                    </tr>
                  </thead>

                  <tbody>

                    ${violations.map(
                      violation => `
                        <tr>

                          <td>
                            ${fmtDate(
                              violation.timestamp
                            )}
                          </td>

                          <td>
                            ${esc(
                              violation.participantId
                            )}
                          </td>

                          <td>
                            ${esc(
                              violation.roomNumber
                            )}
                          </td>

                          <td>
                            ${esc(
                              violation.examTitle
                            )}
                          </td>

                          <td>
                            #${violation.number}
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
                No security events have been recorded.
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
    const counts =
      attemptCounts();

    const total =
      counts.total || 1;

    const rooms =
      examList();

    $('#admin-analytics-page').innerHTML = `

      <div class="page-head">

        <div>

          <span class="eyebrow">
            REPORTING
          </span>

          <h3>
            Examination Analytics
          </h3>

          <p>
            Shared-room examination activity.
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
          'Live Sessions',
          counts.inProgress
        )}

        ${kpi(
          'Rooms',
          rooms.length
        )}

        ${kpi(
          'Security Events',
          violationList().length
        )}

      </div>

      <div class="dashboard-grid">

        <div class="panel">

          <span class="eyebrow">
            SESSION STATUS
          </span>

          <h3>
            Examination Progress
          </h3>

          ${
            [
              ['Completed', counts.completed],
              ['In Progress', counts.inProgress],
              ['Time Expired', counts.expired],
              ['Terminated', counts.terminated]
            ]
              .map(
                ([label, value]) =>
                  chart(
                    label,
                    value,
                    counts.total
                  )
              )
              .join('')
          }

        </div>

        <div class="panel">

          <span class="eyebrow">
            ROOM ACTIVITY
          </span>

          <h3>
            Sessions by Room
          </h3>

          ${
            rooms.length
              ? rooms
                  .map(
                    exam =>
                      chart(
                        `${exam.roomNumber} — ${exam.title}`,
                        attemptList().filter(
                          attempt =>
                            attempt.examId ===
                            exam.id
                        ).length,
                        counts.total
                      )
                  )
                  .join('')
              : `
                <div class="empty">
                  No examination rooms.
                </div>
              `
          }

        </div>

      </div>
    `;
  }

  function kpi(label, value) {
    return `
      <div class="kpi">
        <span>
          ${esc(label)}
        </span>

        <strong>
          ${esc(value)}
        </strong>
      </div>
    `;
  }

  function chart(label, value, total) {
    const percentage =
      total
        ? Math.round(
            value /
            total *
            100
          )
        : 0;

    return `
      <div class="chart-row">

        <div class="chart-info">

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
          ${value}
          (${percentage}%)
        </div>

      </div>
    `;
  }

  /* ============================================================
     SETTINGS
     ============================================================ */

  function renderSettings() {
    $('#admin-settings-page').innerHTML = `

      <div class="page-head">

        <div>

          <span class="eyebrow">
            SYSTEM
          </span>

          <h3>
            Proctor+ Settings
          </h3>

          <p>
            Shared examination environment
            configuration.
          </p>

        </div>

      </div>

      <div class="dashboard-grid">

        <div class="panel">

          <span class="eyebrow">
            APPEARANCE
          </span>

          <h3>
            Interface Theme
          </h3>

          <p class="muted">
            Change the interface theme for
            this computer.
          </p>

          <button
            class="secondary-btn"
            data-action="toggle-theme"
          >
            Switch Theme
          </button>

        </div>

        <div class="panel">

          <span class="eyebrow">
            ADMINISTRATOR
          </span>

          <h3>
            Shared Administrator Account
          </h3>

          <p class="muted">
            The administrator identity is stored
            in the shared Firebase database.
          </p>

          <div class="notice">
            <strong>
              ${esc(
                data.admin?.username ||
                DEFAULT_ADMIN.username
              )}
            </strong>

            <br>

            ${esc(
              data.admin?.name ||
              DEFAULT_ADMIN.name
            )}
          </div>

        </div>

      </div>

      <div class="panel">

        <span class="eyebrow">
          ROOM ACCESS MODEL
        </span>

        <h3>
          Shared Multi-Computer Access
        </h3>

        <div class="notice">

          <strong>
            Unlimited examination sessions
          </strong>

          <br>

          Multiple computers may enter the
          same Room Number simultaneously.
          Each computer receives an independent
          examination session.

        </div>

      </div>

      <div class="panel danger-panel">

        <span class="eyebrow">
          IMPORTANT
        </span>

        <h3>
          Prototype Security Notice
        </h3>

        <p class="muted">
          This browser application uses Firebase
          for shared synchronization. For a
          production deployment, use Firebase
          Authentication, role-based security
          rules and secure credential management.
        </p>

      </div>
    `;
  }

  /* ============================================================
     ROOM DASHBOARD
     ============================================================ */

  function openRoomDashboard() {
    const exam =
      data.exams[
        session?.roomId
      ];

    if (!exam) {
      clearSession();

      showView('login');

      toast(
        'This examination room is no longer available.',
        'error'
      );

      return;
    }

    $('#examiner-user-name').textContent =
      `Room ${exam.roomNumber}`;

    $('#examiner-user-role').textContent =
      'Participant Access';

    $('#examiner-avatar').textContent =
      String(
        exam.roomNumber || 'R'
      )[0].toUpperCase();

    showView('room');

    renderRoomDashboard();
  }

  function renderRoomDashboard() {
    const exam =
      data.exams[
        session?.roomId
      ];

    if (!exam) return;

    const availability =
      getAvailability(exam);

    const ownAttempts =
      attemptList().filter(
        attempt =>
          attempt.examId === exam.id &&
          attempt.participantId ===
            session.participantId
      );

    const live =
      attemptList().filter(
        attempt =>
          attempt.examId === exam.id &&
          attempt.status === 'In Progress'
      ).length;

    const roomTotal =
      attemptList().filter(
        attempt =>
          attempt.examId === exam.id
      ).length;

    $('#examiner-dashboard-page').innerHTML = `

      <div class="room-welcome">

        <div>

          <span class="eyebrow">
            EXAMINATION ROOM
          </span>

          <h1>
            ${esc(exam.title)}
          </h1>

          <p>
            ${esc(
              exam.description ||
              'Welcome to your examination room.'
            )}
          </p>

        </div>

        ${badge(
          availability.status
        )}

      </div>

      <div class="participant-room-card">

        <div>

          <span class="room-label">
            ROOM NUMBER
          </span>

          <strong>
            ${esc(exam.roomNumber)}
          </strong>

          <p>
            This room supports multiple computers
            simultaneously.
          </p>

        </div>

        <div class="live-counter">

          <strong>
            ${live}
          </strong>

          <span>
            Participants currently active
          </span>

        </div>

      </div>

      <div class="stat-grid">

        ${stat(
          'Your Sessions',
          ownAttempts.length
        )}

        ${stat(
          'Room Sessions',
          roomTotal
        )}

        ${stat(
          'Timer',
          exam.timerEnabled
            ? `${exam.durationMinutes} min`
            : 'Off'
        )}

        ${stat(
          'Anti-Cheat',
          exam.antiCheat
            ? 'Enabled'
            : 'Disabled'
        )}

      </div>

      <div class="panel start-panel">

        <div>

          <span class="eyebrow">
            READY TO BEGIN?
          </span>

          <h3>
            Start Your Examination
          </h3>

          <p>
            You may start another session after
            completing a previous session. There
            is no submission limit.
          </p>

        </div>

        <button
          class="primary-btn"
          data-action="start-exam"
          data-id="${exam.id}"
          ${
            availability.status !==
            'Available'
              ? 'disabled'
              : ''
          }
        >
          Start Examination →
        </button>

      </div>

      <div class="panel">

        <div class="panel-heading">

          <div>

            <span class="eyebrow">
              YOUR ACTIVITY
            </span>

            <h3>
              Recent Sessions
            </h3>

          </div>

        </div>

        ${submissionTable(
          ownAttempts.slice(0, 10)
        )}

      </div>
    `;
  }

  /* ============================================================
     START EXAM
     ============================================================ */

  function startExam(id) {
    const exam =
      data.exams[id];

    if (
      !exam ||
      !session ||
      session.role !== 'room'
    ) {
      return;
    }

    if (
      getAvailability(exam).status !==
      'Available'
    ) {
      toast(
        'This examination room is not currently available.',
        'error'
      );

      return;
    }

    openStartInstructions(exam);
  }

  function openStartInstructions(exam) {
    openModal(`

      <div class="modal modal-compact">

        <div class="modal-head">

          <div>

            <span class="eyebrow">
              READY TO START
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

            <strong>
              Shared Room Access
            </strong>

            <br>

            Other computers can take the
            examination in this same room
            simultaneously.

            Each participant receives an
            independent session.

          </div>

          <ul class="instruction-list">

            <li>
              ${
                exam.timerEnabled
                  ? `You have <strong>${exam.durationMinutes} minutes</strong> to complete this attempt.`
                  : 'No countdown timer is configured.'
              }
            </li>

            <li>
              ${
                exam.antiCheat
                  ? `Anti-cheat monitoring is enabled with ${exam.maxViolations} allowed violation(s) per session.`
                  : 'Anti-cheat monitoring is disabled.'
              }
            </li>

            <li>
              Complete the Google Form first.
            </li>

            <li>
              Click
              <strong>
                Submit Exam
              </strong>
              in Proctor+ after completing
              the form.
            </li>

            <li>
              You may start another session
              later. There is no submission cap.
            </li>

          </ul>

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
    `);
  }

  async function confirmStart(id) {
    closeModal();

    const exam =
      data.exams[id];

    if (
      !exam ||
      !requireFirebase()
    ) {
      return;
    }

    /*
      IMPORTANT:
      Always generate a NEW attempt ID.

      No check is made against previous
      completed attempts.
    */
    const attemptId =
      uid('attempt');

    const attempt = {
      id: attemptId,

      examId: exam.id,

      examTitle:
        exam.title,

      roomNumber:
        exam.roomNumber,

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

    const saved =
      await setPath(
        `attempts/${attemptId}`,
        attempt
      );

    if (!saved) return;

    currentExam =
      clone(exam);

    examState = {
      attemptId,

      startedAt:
        attempt.startedAt,

      durationSeconds:
        exam.timerEnabled
          ? Math.max(
              1,
              Number(
                exam.durationMinutes
              ) || 60
            ) * 60
          : 0,

      timerEnabled:
        !!exam.timerEnabled,

      antiCheat:
        !!exam.antiCheat,

      maxViolations:
        Math.max(
          1,
          Number(
            exam.maxViolations
          ) || 3
        ),

      active:
        true
    };

    session.activeAttemptId =
      attemptId;

    saveSession();

    $('#live-exam-title').textContent =
      exam.title;

    $('#live-exam-examiner').textContent =
      `Room ${exam.roomNumber} • Participant ${session.participantId
        .slice(-6)
        .toUpperCase()}`;

    $('#exam-violations').textContent =
      `0 / ${examState.maxViolations}`;

    loadGoogleForm();

    $('#exam-instructions').textContent =
      exam.timerEnabled
        ? `Timer: ${exam.durationMinutes} minutes • Anti-cheat: ${
            exam.antiCheat
              ? 'Enabled'
              : 'Disabled'
          } • Complete the Google Form, then click Submit Exam.`
        : `No timer • Anti-cheat: ${
            exam.antiCheat
              ? 'Enabled'
              : 'Disabled'
          } • Complete the Google Form, then click Submit Exam.`;

    showView('exam');

    document.body.classList.add(
      'lockdown-active'
    );

    $('#exam-view')
      .classList.add(
        'lockdown-active'
      );

    graceUntil =
      Date.now() + GRACE_PERIOD;

    if (exam.antiCheat) {
      requestFullscreen().finally(() => {
        graceUntil =
          Date.now() +
          GRACE_PERIOD;
      });
    }

    if (exam.timerEnabled) {
      startTimer();
    } else {
      renderTimer();
    }
  }

  /* ============================================================
     GOOGLE FORM
     ============================================================ */

  function loadGoogleForm() {
    if (!currentExam) return;

    const iframe =
      $('#exam-iframe');

    if (!iframe) return;

    iframe.src =
      currentExam.formUrl;
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

    const base =
      currentExam.formUrl;

    const separator =
      base.includes('?')
        ? '&'
        : '?';

    iframe.src =
      'about:blank';

    setTimeout(() => {
      if (
        examState?.active
      ) {
        iframe.src =
          `${base}${separator}_proctorRefresh=${Date.now()}`;
      }
    }, 100);

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

    if (!fn) {
      return Promise.resolve();
    }

    return Promise
      .resolve(
        fn.call(element)
      )
      .catch(() => {});
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
      return Promise
        .resolve(
          fn.call(document)
        )
        .catch(() => {});
    }

    return Promise.resolve();
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
      setInterval(() => {

        if (!examState?.active) {
          return;
        }

        renderTimer();

        if (
          remainingSeconds() <= 0
        ) {
          clearInterval(timer);

          finishExam(
            'Time Expired',
            'Time Expired',
            'Your allotted examination time has ended.',
            '⌛'
          );
        }

      }, 500);
  }

  function remainingSeconds() {
    if (
      !examState?.timerEnabled
    ) {
      return 0;
    }

    return Math.max(
      0,
      examState.durationSeconds -
        Math.floor(
          (
            Date.now() -
            examState.startedAt
          ) / 1000
        )
    );
  }

  function renderTimer() {
    const element =
      $('#exam-timer');

    if (!element) return;

    if (
      !examState?.timerEnabled
    ) {
      element.textContent =
        'No Timer';

      return;
    }

    const seconds =
      remainingSeconds();

    element.textContent =
      fmtTime(seconds);

    element.classList.toggle(
      'warning',
      seconds <= 300 &&
      seconds > 60
    );

    element.classList.toggle(
      'danger',
      seconds <= 60
    );

    const progress =
      examState.durationSeconds
        ? Math.max(
            0,
            Math.min(
              100,
              seconds /
                examState.durationSeconds *
                100
            )
          )
        : 0;

    const progressElement =
      $('#exam-progress');

    if (progressElement) {
      progressElement.style.width =
        `${100 - progress}%`;
    }
  }

  /* ============================================================
     ANTI-CHEAT
     ============================================================ */

  async function registerViolation(reason) {
    if (
      !examState?.active ||
      !examState.antiCheat ||
      !requireFirebase()
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
      data.attempts[
        examState.attemptId
      ];

    if (
      !attempt ||
      attempt.status !==
        'In Progress'
    ) {
      return;
    }

    const number =
      (attempt.violations || 0) + 1;

    const violation = {
      id: uid('vio'),

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

      number,

      reason,

      timestamp:
        now
    };

    await setPath(
      `violations/${violation.id}`,
      violation
    );

    await updatePath(
      `attempts/${attempt.id}`,
      {
        violations:
          number
      }
    );

    $('#exam-violations').textContent =
      `${number} / ${examState.maxViolations}`;

    /*
      The violation limit applies ONLY to
      this particular examination session.

      It does NOT lock the room.
      It does NOT block another computer.
      It does NOT block future submissions.
    */
    if (
      number >=
      examState.maxViolations
    ) {
      await finishExam(
        'Terminated',
        'Exam Terminated',
        'This examination session exceeded the maximum allowed violations.',
        '×',
        true
      );

      return;
    }

    showViolationOverlay(
      reason,
      number
    );
  }

  function showViolationOverlay(
    reason,
    number
  ) {
    violationOverlayOpen =
      true;

    $('#violation-reason')
      .textContent =
      reason;

    $('#overlay-count')
      .textContent =
      number;

    $('#overlay-max')
      .textContent =
      examState.maxViolations;

    $('#violation-overlay')
      .hidden = false;

    $('#exam-iframe')
      .style.filter =
      'blur(6px) brightness(.45)';
  }

  async function resumeExam() {
    if (!examState?.active) {
      return;
    }

    $('#violation-overlay')
      .hidden = true;

    violationOverlayOpen =
      false;

    $('#exam-iframe')
      .style.filter = '';

    graceUntil =
      Date.now() +
      GRACE_PERIOD;

    await requestFullscreen();

    graceUntil =
      Date.now() +
      GRACE_PERIOD;
  }

  /* ============================================================
     FINISH EXAM
     ============================================================ */

  async function finishExam(
    status,
    title,
    message,
    icon,
    terminated = false
  ) {
    if (
      !examState?.active ||
      !requireFirebase()
    ) {
      return;
    }

    examState.active =
      false;

    clearInterval(timer);

    const attempt =
      data.attempts[
        examState.attemptId
      ];

    if (attempt) {
      await updatePath(
        `attempts/${examState.attemptId}`,
        {
          status,
          endedAt:
            Date.now()
        }
      );
    }

    $('#violation-overlay')
      .hidden = true;

    violationOverlayOpen =
      false;

    document.body.classList.remove(
      'lockdown-active'
    );

    $('#exam-view')
      .classList.remove(
        'lockdown-active'
      );

    await exitFullscreen();

    if (session) {
      delete session.activeAttemptId;

      saveSession();
    }

    $('#result-icon')
      .textContent =
      icon;

    $('#result-eyebrow')
      .textContent =
      terminated
        ? 'EXAM TERMINATED'
        : status === 'Time Expired'
          ? 'TIME EXPIRED'
          : 'EXAM COMPLETE';

    $('#result-title')
      .textContent =
      title;

    $('#result-message')
      .textContent =
      message;

    $('#result-exam')
      .textContent =
      currentExam?.title ||
      '—';

    $('#result-user')
      .textContent =
      `Room ${
        currentExam?.roomNumber ||
        '—'
      }`;

    $('#result-violations')
      .textContent =
      attempt?.violations ||
      0;

    $('#result-ended')
      .textContent =
      fmtDate(Date.now());

    showView('result');
  }

  /* ============================================================
     EVENT DELEGATION
     ============================================================

     This fixes the X and Cancel problem.

     Dynamic modal buttons are NOT individually bound.
     One document-level handler manages every
     [data-action] button, including newly created modals.
     ============================================================ */

  document.addEventListener(
    'click',
    async event => {

      const button =
        event.target.closest(
          '[data-action]'
        );

      if (!button) return;

      const action =
        button.dataset.action;

      const id =
        button.dataset.id;

      if (
        action ===
        'close-modal'
      ) {
        event.preventDefault();
        event.stopPropagation();

        closeModal();

        return;
      }

      if (
        action ===
        'admin-login'
      ) {
        openAdminLogin();
        return;
      }

      if (
        action ===
        'new-exam'
      ) {
        openExamModal();
        return;
      }

      if (
        action ===
        'edit-exam'
      ) {
        openExamModal(id);
        return;
      }

      if (
        action ===
        'delete-exam'
      ) {
        await deleteExam(id);
        return;
      }

      if (
        action ===
        'confirm-start'
      ) {
        await confirmStart(id);
        return;
      }

      if (
        action ===
        'start-exam'
      ) {
        startExam(id);
        return;
      }

      if (
        action ===
        'view-submissions'
      ) {
        adminPage('submissions');
        return;
      }

      if (
        action ===
        'refresh-admin'
      ) {
        renderAdminPage('submissions');
        return;
      }

      if (
        action ===
        'toggle-theme'
      ) {
        toggleTheme();
        return;
      }

      if (
        action ===
        'logout'
      ) {
        logout();
        return;
      }

      if (
        action ===
        'refresh-form'
      ) {
        refreshGoogleForm();
        return;
      }
    }
  );

  /* ============================================================
     MODAL BACKDROP
     ============================================================ */

  $('#modal-root')?.addEventListener(
    'click',
    event => {

      if (
        event.target ===
        $('#modal-root')
      ) {
        closeModal();
      }

    }
  );

  /* ============================================================
     MODAL FORMS
     ============================================================ */

  $('#modal-root')?.addEventListener(
    'submit',
    async event => {

      if (
        event.target.id ===
        'admin-login-form'
      ) {
        await adminLogin(event);
        return;
      }

      if (
        event.target.id ===
        'exam-form'
      ) {
        await saveExam(event);
      }

    }
  );

  /* ============================================================
     ESCAPE KEY
     ============================================================ */

  document.addEventListener(
    'keydown',
    event => {

      const modal =
        $('#modal-root');

      if (
        event.key === 'Escape' &&
        modal &&
        !modal.hidden
      ) {
        closeModal();
        return;
      }

      if (!examState?.active) {
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
          `Restricted shortcut attempt: ${event.key}`
        );
      }
    }
  );

  /* ============================================================
     EXAM CONTROLS
     ============================================================ */

  $('#resume-exam-btn')
    ?.addEventListener(
      'click',
      resumeExam
    );

  $('#exam-submit-btn')
    ?.addEventListener(
      'click',
      async () => {

        if (!examState?.active) {
          return;
        }

        const confirmed =
          confirm(
            'Confirm that you have submitted the Google Form. This will end this Proctor+ session. You can start another session later.'
          );

        if (!confirmed) {
          return;
        }

        await finishExam(
          'Completed',
          'Thank you for taking the exam!',
          'Your examination session has been submitted successfully.',
          '✓'
        );

      }
    );

  /* ============================================================
     FULLSCREEN MONITORING
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
          'The examination window lost focus.'
        );
      }

    }
  );

  document.addEventListener(
    'contextmenu',
    event => {

      if (examState?.active) {
        event.preventDefault();
      }

    }
  );

  document.addEventListener(
    'copy',
    event => {

      if (examState?.active) {
        event.preventDefault();
      }

    }
  );

  document.addEventListener(
    'cut',
    event => {

      if (examState?.active) {
        event.preventDefault();
      }

    }
  );

  document.addEventListener(
    'paste',
    event => {

      if (examState?.active) {
        event.preventDefault();
      }

    }
  );

  window.addEventListener(
    'beforeunload',
    event => {

      if (examState?.active) {
        event.preventDefault();
        event.returnValue = '';
      }

    }
  );

  /* ============================================================
     NAVIGATION
     ============================================================ */

  $$('[data-toggle-sidebar]')
    .forEach(button => {

      button.addEventListener(
        'click',
        () => {

          const sidebar =
            $('#' +
              button.dataset.toggleSidebar
            );

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
        () => {
          adminPage(
            button.dataset.adminPage
          );
        }
      );

    });

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

  $('#admin-login-top')
    ?.addEventListener(
      'click',
      openAdminLogin
    );

  $('#result-dashboard-btn')
    ?.addEventListener(
      'click',
      () => {

        currentExam = null;
        examState = null;

        if (
          session?.role ===
          'room'
        ) {
          openRoomDashboard();
        } else {
          openAdmin();
        }

      }
    );

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

  /* ============================================================
     SCREEN REFRESH
     ============================================================ */

  function renderCurrentScreen() {

    if (
      session?.role ===
        'admin'
    ) {
      openAdmin();
      return;
    }

    if (
      session?.role ===
        'room'
    ) {

      if (
        session.activeAttemptId &&
        data.attempts[
          session.activeAttemptId
        ] &&
        !examState?.active
      ) {

        const attempt =
          data.attempts[
            session.activeAttemptId
          ];

        const exam =
          data.exams[
            attempt.examId
          ];

        if (
          attempt.status ===
            'In Progress' &&
          exam
        ) {
          restoreExamAttempt(
            attempt,
            exam
          );

          return;
        }
      }

      if (!examState?.active) {
        openRoomDashboard();
      }
    }
  }

  /* ============================================================
     CLOCK
     ============================================================ */

  setInterval(
    () => {

      const now =
        new Date().toLocaleString();

      if ($('#admin-clock')) {
        $('#admin-clock')
          .textContent = now;
      }

      if ($('#examiner-clock')) {
        $('#examiner-clock')
          .textContent = now;
      }

    },
    1000
  );

  /* ============================================================
     RESTORE ACTIVE EXAM
     ============================================================ */

  function restoreExamAttempt(
    attempt,
    exam
  ) {

    currentExam =
      clone(exam);

    examState = {
      attemptId:
        attempt.id,

      startedAt:
        attempt.startedAt,

      durationSeconds:
        exam.timerEnabled
          ? Math.max(
              1,
              Number(
                exam.durationMinutes
              ) || 60
            ) * 60
          : 0,

      timerEnabled:
        !!exam.timerEnabled,

      antiCheat:
        !!exam.antiCheat,

      maxViolations:
        Math.max(
          1,
          Number(
            exam.maxViolations
          ) || 3
        ),

      active:
        true
    };

    $('#live-exam-title')
      .textContent =
      exam.title;

    $('#live-exam-examiner')
      .textContent =
      `Room ${exam.roomNumber} • Participant ${session.participantId
        .slice(-6)
        .toUpperCase()}`;

    $('#exam-violations')
      .textContent =
      `${attempt.violations || 0} / ${examState.maxViolations}`;

    loadGoogleForm();

    $('#exam-instructions')
      .textContent =
      exam.timerEnabled
        ? `Timer: ${exam.durationMinutes} minutes • Anti-cheat: ${
            exam.antiCheat
              ? 'Enabled'
              : 'Disabled'
          } • Complete the Google Form, then click Submit Exam.`
        : `No timer • Anti-cheat: ${
            exam.antiCheat
              ? 'Enabled'
              : 'Disabled'
          } • Complete the Google Form, then click Submit Exam.`;

    showView('exam');

    document.body.classList.add(
      'lockdown-active'
    );

    if (exam.timerEnabled) {
      startTimer();
    } else {
      renderTimer();
    }

    graceUntil =
      Date.now() +
      GRACE_PERIOD;
  }

  /* ============================================================
     START APPLICATION
     ============================================================ */

  initFirebase().then(
    connected => {

      if (!connected) {
        showView('login');
        return;
      }

      if (
        session?.role ===
        'admin'
      ) {
        openAdmin();
        return;
      }

      if (
        session?.role ===
        'room'
      ) {
        renderCurrentScreen();
        return;
      }

      showView('login');
    }
  );

})();
