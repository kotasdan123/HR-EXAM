/*
 * ================================================================
 * PROCTOR+
 * Browser-Based Examination & Proctoring Portal
 *
 * IMPORTANT:
 * This is a frontend/localStorage prototype.
 * Production deployment should move authentication, room data,
 * examination sessions and security logs to a backend/database.
 * ================================================================
 */

(() => {
  'use strict';

  /* ================================================================
     CONFIGURATION
  ================================================================ */

  const DB_KEY = 'proctor_plus_portal_v4';
  const SESSION_KEY = 'proctor_plus_session_v4';

  const DEFAULT_FORM =
    'https://docs.google.com/forms/d/e/1FAIpQLSf_PLACEHOLDER_FORM_ID/viewform?embedded=true';

  const MAX_EXAMS = 6;

  const ADMIN_USERNAME = 'admin';
  const ADMIN_PASSWORD = '123admin';

  const DEFAULT_ROOM = {
    id: 'room-demo',
    roomNumber: '1001',
    passcode: '123456',
    title: 'Demo Examination',
    description:
      'This is a demonstration examination room. Replace the Google Form link with your official examination form.',
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
  };


  /* ================================================================
     STATE
  ================================================================ */

  let db = loadDB();
  let session = loadSession();

  let currentRoom = null;
  let currentAttempt = null;

  let timer = null;
  let examState = null;

  let violationOverlayOpen = false;
  let graceUntil = 0;
  let lastViolation = 0;

  const VIOLATION_DEBOUNCE = 650;
  const FULLSCREEN_GRACE = 1500;


  /* ================================================================
     DOM HELPERS
  ================================================================ */

  const $ = selector => document.querySelector(selector);

  const $$ = selector =>
    [...document.querySelectorAll(selector)];


  /* ================================================================
     VIEW ELEMENTS
  ================================================================ */

  const views = {
    login: $('#login-view'),
    admin: $('#admin-view'),
    examiner: $('#examiner-view'),
    exam: $('#exam-view'),
    result: $('#result-view')
  };


  /* ================================================================
     UTILITIES
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


  /* ================================================================
     STORAGE
  ================================================================ */

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


  function saveDB() {
    safeSet(localStorage, DB_KEY, JSON.stringify(db));
  }


  function loadSession() {
    try {
      return JSON.parse(
        safeGet(sessionStorage, SESSION_KEY) || 'null'
      );
    } catch {
      return null;
    }
  }


  function saveSession() {
    if (session) {
      safeSet(
        sessionStorage,
        SESSION_KEY,
        JSON.stringify(session)
      );
    } else {
      safeRemove(sessionStorage, SESSION_KEY);
    }
  }


  /* ================================================================
     DATABASE MIGRATION
  ================================================================ */

  function loadDB() {
    let stored = {};

    try {
      const raw = safeGet(localStorage, DB_KEY);

      if (raw) {
        stored = JSON.parse(raw) || {};
      }
    } catch {
      stored = {};
    }


    let rooms = Array.isArray(stored.rooms)
      ? stored.rooms
      : [];


    /*
     * Migrate old examiner-based exams into rooms.
     */
    if (
      rooms.length === 0 &&
      Array.isArray(stored.exams) &&
      stored.exams.length
    ) {
      rooms = stored.exams.map((exam, index) => ({
        id: exam.id || uid('room'),

        roomNumber:
          exam.roomNumber ||
          String(1001 + index),

        passcode:
          exam.passcode ||
          String(exam.examinerPassword || '123456'),

        title:
          exam.title ||
          `Examination Room ${index + 1}`,

        description:
          exam.description || '',

        formUrl:
          exam.formUrl || DEFAULT_FORM,

        antiCheat:
          boolSetting(exam.antiCheat, true),

        maxViolations:
          Math.max(
            1,
            Math.round(
              Number(exam.maxViolations) || 3
            )
          ),

        timerEnabled:
          boolSetting(exam.timerEnabled, true),

        durationMinutes:
          Math.max(
            1,
            Math.round(
              Number(exam.durationMinutes) || 60
            )
          ),

        startAt:
          exam.startAt || '',

        endAt:
          exam.endAt || '',

        active:
          exam.active !== false,

        createdAt:
          exam.createdAt || Date.now(),

        createdBy: 'u-admin'
      }));
    }


    if (!rooms.length) {
      rooms = [clone(DEFAULT_ROOM)];
    }


    rooms = rooms.map(room => ({
      ...room,

      roomNumber:
        String(room.roomNumber || '').trim(),

      passcode:
        String(room.passcode || '').trim(),

      title:
        String(room.title || 'Untitled Examination'),

      description:
        String(room.description || ''),

      formUrl:
        String(room.formUrl || DEFAULT_FORM),

      antiCheat:
        boolSetting(room.antiCheat, false),

      maxViolations:
        Math.max(
          1,
          Math.round(Number(room.maxViolations) || 3)
        ),

      timerEnabled:
        boolSetting(room.timerEnabled, false),

      durationMinutes:
        Math.max(
          1,
          Math.round(Number(room.durationMinutes) || 60)
        ),

      active:
        room.active !== false
    }));


    const result = {
      users: [
        {
          id: 'u-admin',
          username: ADMIN_USERNAME,
          password: ADMIN_PASSWORD,
          role: 'admin',
          name: 'Administrator'
        }
      ],

      rooms,

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
     * Make sure the administrator account always exists.
     */
    if (
      !result.users.some(
        user =>
          user.username === ADMIN_USERNAME &&
          user.role === 'admin'
      )
    ) {
      result.users.unshift({
        id: 'u-admin',
        username: ADMIN_USERNAME,
        password: ADMIN_PASSWORD,
        role: 'admin',
        name: 'Administrator'
      });
    }


    safeSet(
      localStorage,
      DB_KEY,
      JSON.stringify(result)
    );

    return result;
  }


  /* ================================================================
     VIEW MANAGEMENT
  ================================================================ */

  function showView(name) {
    Object.values(views).forEach(view => {
      if (view) {
        view.hidden = true;
        view.classList.remove('active');
      }
    });

    if (views[name]) {
      views[name].hidden = false;
      views[name].classList.add('active');
    }

    window.scrollTo(0, 0);
  }


  /* ================================================================
     TOAST
  ================================================================ */

  function toast(message, type = '') {
    const container = $('#toast-container');

    if (!container) return;

    const item = document.createElement('div');

    item.className =
      `toast ${type}`;

    item.textContent = message;

    container.appendChild(item);

    setTimeout(() => {
      item.remove();
    }, 3500);
  }


  /* ================================================================
     THEME
  ================================================================ */

  function applyTheme() {
    const light = db.theme === 'light';

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

      const button = $('#' + id);

      if (!button) return;

      button.textContent =
        light ? '☾' : '☼';

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


  /* ================================================================
     LOGIN
  ================================================================ */

  function showLoginError(message) {
    const error = $('#login-error');

    if (!error) return;

    error.textContent = message;
    error.hidden = false;
  }


  function clearLoginError() {
    const error = $('#login-error');

    if (!error) return;

    error.textContent = '';
    error.hidden = true;
  }


  function loginToRoom(event) {
    event.preventDefault();

    clearLoginError();

    const roomInput = $('#login-room');
    const passcodeInput = $('#login-passcode');

    const roomNumber =
      String(roomInput?.value || '').trim();

    const passcode =
      String(passcodeInput?.value || '').trim();


    if (!roomNumber || !passcode) {
      showLoginError(
        'Please enter both the room number and passcode.'
      );
      return;
    }


    db = loadDB();


    const room = db.rooms.find(
      item =>
        String(item.roomNumber).toLowerCase() ===
          roomNumber.toLowerCase() &&
        String(item.passcode) === passcode
    );


    if (!room) {
      showLoginError(
        'Invalid room number or passcode. Please verify the examination access details.'
      );

      passcodeInput.value = '';
      passcodeInput.focus();

      return;
    }


    if (!room.active) {
      showLoginError(
        'This examination room is currently disabled.'
      );

      return;
    }


    const availability =
      getAvailability(room);

    if (availability.status !== 'Available') {
      showLoginError(
        availability.message
      );

      return;
    }


    /*
     * Every browser/session gets its own participant ID.
     * There is intentionally NO attempt lock.
     */
    const participantId =
      uid('participant');


    session = {
      role: 'participant',
      participantId,
      roomId: room.id,
      roomNumber: room.roomNumber,
      loginAt: Date.now()
    };


    saveSession();


    currentRoom = clone(room);
    currentAttempt = null;
    examState = null;


    $('#login-form').reset();

    openParticipantDashboard();
  }


  /* ================================================================
     ADMIN LOGIN
  ================================================================ */

  function openAdminLogin() {
    $('#admin-login-modal').hidden = false;

    setTimeout(() => {
      $('#admin-username')?.focus();
    }, 50);
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
      error.hidden = true;
      error.textContent = '';
    }
  }


  function adminLogin(event) {
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


    if (
      username !== ADMIN_USERNAME ||
      password !== ADMIN_PASSWORD
    ) {
      error.textContent =
        'Invalid administrator credentials.';

      error.hidden = false;

      return;
    }


    closeAdminLogin();


    session = {
      role: 'admin',
      username: ADMIN_USERNAME,
      loginAt: Date.now()
    };


    saveSession();

    openAdmin();
  }


  /* ================================================================
     SESSION / LOGOUT
  ================================================================ */

  function logout() {
    clearInterval(timer);

    timer = null;

    examState = null;
    currentAttempt = null;
    currentRoom = null;

    violationOverlayOpen = false;

    $('#violation-overlay').hidden = true;

    document.body.classList.remove(
      'lockdown-active'
    );


    session = null;

    saveSession();

    showView('login');

    clearLoginError();
  }


  /* ================================================================
     CURRENT PARTICIPANT
  ================================================================ */

  function participantLabel() {
    if (!session?.participantId) {
      return 'Participant';
    }

    return (
      'Participant ' +
      session.participantId
        .split('-')
        .pop()
        .toUpperCase()
    );
  }


  /* ================================================================
     AVAILABILITY
  ================================================================ */

  function getAvailability(room) {
    if (!room || room.active === false) {
      return {
        status: 'Unavailable',
        message: 'This examination room is disabled.'
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
        status: 'Unavailable',
        message:
          `This room will become available on ${fmtDate(start)}.`
      };
    }


    if (
      Number.isFinite(end) &&
      now > end
    ) {
      return {
        status: 'Unavailable',
        message:
          'The availability period for this room has ended.'
      };
    }


    return {
      status: 'Available',
      message: 'Room is available.'
    };
  }


  /* ================================================================
     ADMIN PORTAL
  ================================================================ */

  function openAdmin() {
    const user =
      db.users.find(
        item => item.role === 'admin'
      );


    if (!user) {
      logout();
      return;
    }


    $('#admin-user-name').textContent =
      user.name;

    $('#admin-user-role').textContent =
      'Administrator';

    $('#admin-avatar').textContent =
      user.name.charAt(0).toUpperCase();


    showView('admin');

    adminPage('dashboard');
  }


  const ADMIN_PAGE_TITLES = {
    dashboard: 'Dashboard',
    exams: 'Exam Rooms',
    submissions: 'Submissions',
    violations: 'Security Logs',
    analytics: 'Analytics',
    settings: 'Settings'
  };


  function adminPage(page) {
    if (!ADMIN_PAGE_TITLES[page]) {
      page = 'dashboard';
    }


    $$('[data-admin-page]').forEach(
      button => {
        button.classList.toggle(
          'active',
          button.dataset.adminPage === page
        );
      }
    );


    $$('.admin-page').forEach(
      section => {
        section.classList.remove('active');
      }
    );


    const target =
      $('#admin-' + page + '-page');

    if (target) {
      target.classList.add('active');
    }


    $('#admin-page-title').textContent =
      ADMIN_PAGE_TITLES[page];


    $('#admin-sidebar')?.classList.remove(
      'open'
    );


    renderAdminPage(page);
  }


  function renderAdminPage(page) {
    const renderer = {
      dashboard: renderAdminDashboard,
      exams: renderAdminRooms,
      submissions: renderSubmissions,
      violations: renderViolations,
      analytics: renderAnalytics,
      settings: renderSettings
    }[page];


    if (renderer) {
      renderer();
    }
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
    const counts = attemptCounts();

    const activeRooms =
      db.rooms.filter(
        room =>
          getAvailability(room).status ===
          'Available'
      ).length;


    const completionRate =
      counts.total
        ? Math.round(
            counts.completed /
            counts.total *
            100
          )
        : 0;


    const recent =
      db.attempts
        .slice()
        .sort(
          (a, b) =>
            (b.startedAt || 0) -
            (a.startedAt || 0)
        )
        .slice(0, 7);


    $('#admin-dashboard-page').innerHTML = `

      <div class="page-head dashboard-hero">

        <div>

          <span class="eyebrow">
            CONTROL CENTER
          </span>

          <h3>
            Examination Overview
          </h3>

          <p>
            Monitor rooms, examination activity,
            completion and security events from one
            centralized workspace.
          </p>

        </div>

        <div class="actions">

          <button
            class="primary-btn compact"
            data-action="new-exam">
            + Create Exam Room
          </button>

        </div>

      </div>


      <div class="stat-grid admin-stats">

        ${stat(
          'Exam Rooms',
          db.rooms.length,
          'blue',
          'Configured rooms'
        )}

        ${stat(
          'Active Rooms',
          activeRooms,
          'green',
          'Currently available'
        )}

        ${stat(
          'Total Sessions',
          counts.total,
          'purple',
          'All participant sessions'
        )}

        ${stat(
          'In Progress',
          counts.inProgress,
          'blue',
          'Live examinations'
        )}

        ${stat(
          'Completed',
          counts.completed,
          'green',
          'Successfully submitted'
        )}

        ${stat(
          'Security Events',
          db.violations.length,
          'red',
          'Recorded events'
        )}

      </div>


      <div class="dashboard-grid">

        <div class="panel dashboard-panel">

          <div class="panel-heading">

            <div>
              <span class="eyebrow">
                ACTIVITY
              </span>

              <h3>
                Recent Examination Sessions
              </h3>
            </div>

            <button
              class="secondary-btn"
              data-action="view-submissions">
              View All
            </button>

          </div>

          ${submissionTable(recent)}

        </div>


        <div class="panel dashboard-panel">

          <div class="panel-heading">

            <div>
              <span class="eyebrow">
                ROOM STATUS
              </span>

              <h3>
                Examination Rooms
              </h3>

            </div>

          </div>


          <div class="room-status-list">

            ${
              db.rooms.length
                ? db.rooms
                    .slice(0, 6)
                    .map(roomStatusRow)
                    .join('')
                : `
                  <div class="empty">
                    No examination rooms configured.
                  </div>
                `
            }

          </div>

        </div>

      </div>


      <div class="panel overview-progress-panel">

        <div class="panel-heading">

          <div>
            <span class="eyebrow">
              COMPLETION
            </span>

            <h3>
              Overall Examination Completion
            </h3>
          </div>

          <strong class="large-number">
            ${completionRate}%
          </strong>

        </div>


        <div class="progress-bar large">
          <div
            class="progress-fill"
            style="width:${completionRate}%">
          </div>
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

    `;

    bindActions();
  }


  function stat(
    label,
    value,
    type = '',
    description = ''
  ) {
    return `
      <div class="stat-card ${type}">

        <div class="stat-card-top">
          <span class="stat-label">
            ${esc(label)}
          </span>

          <span class="stat-indicator"></span>
        </div>

        <strong class="stat-value">
          ${value}
        </strong>

        <span class="stat-description">
          ${esc(description)}
        </span>

      </div>
    `;
  }


  function roomStatusRow(room) {
    const availability =
      getAvailability(room);

    const sessions =
      db.attempts.filter(
        item => item.examId === room.id
      ).length;


    return `
      <div class="room-status-row">

        <div class="room-status-icon">
          +
        </div>

        <div class="room-status-info">

          <strong>
            ${esc(room.title)}
          </strong>

          <span>
            Room ${esc(room.roomNumber)}
            • ${sessions} session${sessions === 1 ? '' : 's'}
          </span>

        </div>

        <span class="status-pill ${
          availability.status === 'Available'
            ? 'success'
            : 'muted'
        }">
          ${
            availability.status === 'Available'
              ? 'AVAILABLE'
              : 'UNAVAILABLE'
          }
        </span>

      </div>
    `;
  }


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
              <th>Status</th>
              <th>Security</th>
            </tr>

          </thead>

          <tbody>

            ${rows.map(attempt => `
              <tr>

                <td>
                  <strong>
                    ${esc(
                      attempt.participantLabel ||
                      'Participant'
                    )}
                  </strong>
                </td>

                <td>
                  <span class="room-code">
                    ${esc(
                      attempt.roomNumber || '—'
                    )}
                  </span>
                </td>

                <td>
                  ${esc(
                    attempt.examTitle || '—'
                  )}
                </td>

                <td>
                  ${fmtDate(attempt.startedAt)}
                </td>

                <td>
                  ${badge(attempt.status)}
                </td>

                <td>
                  <span class="${
                    (attempt.violations || 0) > 0
                      ? 'security-count danger'
                      : 'security-count'
                  }">
                    ${attempt.violations || 0}
                  </span>
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
      'Completed': 'green',
      'Time Expired': 'yellow',
      'Terminated': 'red',
      'In Progress': 'blue',
      'Available': 'green',
      'Unavailable': 'gray'
    };

    return `
      <span class="badge ${
        colors[status] || 'gray'
      }">
        ${esc(status)}
      </span>
    `;
  }


  /* ================================================================
     EXAM ROOM MANAGEMENT
  ================================================================ */

  function renderAdminRooms() {
    const availableSlots =
      MAX_EXAMS - db.rooms.length;


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
            Create and manage room-based examinations.
            Multiple participants can use the same room
            simultaneously.
          </p>

          <div class="slot-note">
            ${db.rooms.length} / ${MAX_EXAMS}
            rooms configured
          </div>

        </div>


        <div class="actions">

          <button
            class="primary-btn compact"
            data-action="new-exam"
            ${availableSlots <= 0 ? 'disabled' : ''}>
            + Create Room
          </button>

        </div>

      </div>


      ${
        db.rooms.length
          ? `
            <div class="exam-grid">
              ${db.rooms
                .map(examCard)
                .join('')}
            </div>
          `
          : `
            <div class="panel empty-panel">
              <div class="empty">
                No examination rooms have been created.
              </div>
            </div>
          `
      }

    `;

    bindActions();
  }


  function examCard(room) {
    const availability =
      getAvailability(room);

    const attempts =
      db.attempts.filter(
        attempt =>
          attempt.examId === room.id
      );


    const activeSessions =
      attempts.filter(
        attempt =>
          attempt.status ===
          'In Progress'
      ).length;


    return `

      <article class="exam-card redesigned">

        <div class="exam-card-top">

          <div class="room-number-display">
            ROOM ${esc(room.roomNumber)}
          </div>

          <span class="status-pill ${
            availability.status === 'Available'
              ? 'success'
              : 'muted'
          }">
            ${
              availability.status === 'Available'
                ? 'ACTIVE'
                : 'UNAVAILABLE'
            }
          </span>

        </div>


        <div class="exam-card-title">

          <h3>
            ${esc(room.title)}
          </h3>

          <p>
            ${esc(
              room.description ||
              'No description provided.'
            )}
          </p>

        </div>


        <div class="room-access-display">

          <span>
            PASSCODE
          </span>

          <strong>
            ${esc(room.passcode)}
          </strong>

        </div>


        <div class="exam-meta">

          <div class="meta-box">
            <span>Timer</span>

            <strong>
              ${
                room.timerEnabled
                  ? `${room.durationMinutes} min`
                  : 'Off'
              }
            </strong>
          </div>


          <div class="meta-box">
            <span>Anti-cheat</span>

            <strong>
              ${
                room.antiCheat
                  ? 'Enabled'
                  : 'Disabled'
              }
            </strong>
          </div>


          <div class="meta-box">
            <span>Live</span>

            <strong>
              ${activeSessions}
            </strong>
          </div>


          <div class="meta-box">
            <span>Total Sessions</span>

            <strong>
              ${attempts.length}
            </strong>
          </div>

        </div>


        <div class="exam-card-actions">

          <button
            class="secondary-btn"
            data-action="edit-exam"
            data-id="${room.id}">
            Edit Room
          </button>

          <button
            class="danger-btn"
            data-action="delete-exam"
            data-id="${room.id}">
            Delete
          </button>

        </div>

      </article>

    `;
  }


  /* ================================================================
     EXAM EDITOR
  ================================================================ */

  function openExamModal(id = null) {

    const room =
      id
        ? db.rooms.find(
            item => item.id === id
          )
        : null;


    if (
      !room &&
      db.rooms.length >= MAX_EXAMS
    ) {
      toast(
        `Maximum of ${MAX_EXAMS} examination rooms reached.`,
        'error'
      );

      return;
    }


    const data =
      room || {
        roomNumber: '',
        passcode: '',
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


    const isoLocal = value => {
      if (!value) return '';

      try {
        return new Date(value)
          .toISOString()
          .slice(0, 16);
      } catch {
        return '';
      }
    };


    $('#modal-root').hidden = false;


    $('#modal-root').innerHTML = `

      <div
        class="modal modal-large"
        role="dialog"
        aria-modal="true">

        <div class="modal-head">

          <div>

            <span class="eyebrow">
              ${
                room
                  ? 'EDIT EXAMINATION ROOM'
                  : 'CREATE EXAMINATION ROOM'
              }
            </span>

            <h3>
              ${
                room
                  ? 'Update Examination Room'
                  : 'Create New Examination Room'
              }
            </h3>

            <p class="modal-head-description">
              Configure all examination access,
              scheduling and security settings.
            </p>

          </div>


          <!-- FIXED CLOSE BUTTON -->
          <button
            class="close-btn"
            type="button"
            data-action="close-modal"
            aria-label="Close editor">
            ×
          </button>

        </div>


        <!--
          IMPORTANT:
          modal-body is independently scrollable.
          This prevents the editor from being cut off on
          smaller displays.
        -->

        <form
          id="exam-form"
          class="modal-form">

          <div class="modal-body editor-scroll">

            <div class="editor-section">

              <div class="editor-section-title">
                <span>01</span>
                Room &amp; Examination
              </div>


              <div class="form-grid">

                <div class="field">

                  <label class="form-label">
                    Room Number
                  </label>

                  <input
                    name="roomNumber"
                    required
                    value="${esc(data.roomNumber)}"
                    placeholder="e.g. 1001">

                  <div class="helper">
                    Participants use this number to enter
                    the examination room.
                  </div>

                </div>


                <div class="field">

                  <label class="form-label">
                    Room Passcode
                  </label>

                  <input
                    name="passcode"
                    required
                    value="${esc(data.passcode)}"
                    placeholder="e.g. 123456">

                  <div class="helper">
                    Share this passcode only with authorized
                    examination participants.
                  </div>

                </div>


                <div class="field full-span">

                  <label class="form-label">
                    Examination Title
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
                    rows="4"
                    placeholder="Provide a short professional description of the examination.">${esc(data.description)}</textarea>

                </div>

              </div>

            </div>


            <div class="editor-section">

              <div class="editor-section-title">
                <span>02</span>
                Examination Form
              </div>


              <div class="form-grid">

                <div class="field full-span">

                  <label class="form-label">
                    Google Forms Link
                  </label>

                  <input
                    name="formUrl"
                    type="url"
                    required
                    value="${esc(data.formUrl)}"
                    placeholder="https://docs.google.com/forms/d/.../viewform?embedded=true">

                  <div class="helper">
                    Use the Google Form's embeddable
                    viewform URL.
                  </div>

                </div>

              </div>

            </div>


            <div class="editor-section">

              <div class="editor-section-title">
                <span>03</span>
                Examination Controls
              </div>


              <div class="form-grid">

                <div class="field">

                  <label class="form-label">
                    Maximum Security Events
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
                    Timer Duration
                  </label>

                  <input
                    name="durationMinutes"
                    type="number"
                    min="1"
                    max="1440"
                    required
                    value="${data.durationMinutes}">

                  <div class="helper">
                    Duration is used when the examination
                    timer is enabled.
                  </div>

                </div>


                <div class="field full-span">

                  <div class="setting-card">

                    <div class="setting-copy">

                      <strong>
                        Anti-cheat Monitoring
                      </strong>

                      <span>
                        Monitor common tab switching,
                        focus loss, fullscreen exits and
                        restricted shortcuts.
                      </span>

                    </div>

                    <label class="switch">

                      <input
                        id="antiCheat"
                        name="antiCheat"
                        type="checkbox"
                        ${data.antiCheat ? 'checked' : ''}>

                      <span class="switch-slider"></span>

                    </label>

                  </div>

                </div>


                <div class="field full-span">

                  <div class="setting-card">

                    <div class="setting-copy">

                      <strong>
                        Examination Timer
                      </strong>

                      <span id="timer-setting-status">
                        ${
                          data.timerEnabled
                            ? `Timer enabled • ${data.durationMinutes} minutes`
                            : 'Timer disabled'
                        }
                      </span>

                    </div>

                    <label class="switch">

                      <input
                        id="timerEnabled"
                        name="timerEnabled"
                        type="checkbox"
                        ${data.timerEnabled ? 'checked' : ''}>

                      <span class="switch-slider"></span>

                    </label>

                  </div>

                </div>

              </div>

            </div>


            <div class="editor-section">

              <div class="editor-section-title">
                <span>04</span>
                Availability Schedule
              </div>


              <div class="form-grid">

                <div class="field">

                  <label class="form-label">
                    Available From
                  </label>

                  <input
                    name="startAt"
                    type="datetime-local"
                    value="${isoLocal(data.startAt)}">

                  <div class="helper">
                    Leave blank to make the room available
                    immediately.
                  </div>

                </div>


                <div class="field">

                  <label class="form-label">
                    Available Until
                  </label>

                  <input
                    name="endAt"
                    type="datetime-local"
                    value="${isoLocal(data.endAt)}">

                  <div class="helper">
                    Leave blank for no expiration.
                  </div>

                </div>


                <div class="field full-span">

                  <div class="setting-card">

                    <div class="setting-copy">

                      <strong>
                        Room Availability
                      </strong>

                      <span>
                        Allow participants to enter this
                        examination room.
                      </span>

                    </div>

                    <label class="switch">

                      <input
                        id="active"
                        name="active"
                        type="checkbox"
                        ${data.active ? 'checked' : ''}>

                      <span class="switch-slider"></span>

                    </label>

                  </div>

                </div>

              </div>

            </div>


            <div class="editor-section editor-final-note">

              <div class="notice">

                <strong>
                  Room-Based Access
                </strong>

                <p>
                  Multiple participants may enter this
                  examination room at the same time.
                  Each participant receives an independent
                  session and can submit the examination
                  without affecting other participants.
                </p>

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
                room
                  ? 'Save Changes'
                  : 'Create Examination Room'
              }
            </button>

          </div>

        </form>

      </div>

    `;


    const timerToggle =
      $('#timerEnabled');

    const timerStatus =
      $('#timer-setting-status');

    const durationInput =
      $('#exam-form')
        ?.elements
        ?.namedItem('durationMinutes');


    timerToggle?.addEventListener(
      'change',
      () => {

        if (!timerStatus) return;

        if (timerToggle.checked) {

          const minutes =
            Math.max(
              1,
              Number(
                durationInput?.value
              ) || 60
            );

          timerStatus.textContent =
            `Timer enabled • ${minutes} minutes`;

        } else {

          timerStatus.textContent =
            'Timer disabled';

        }

      }
    );


    $('#exam-form')?.addEventListener(
      'submit',
      saveExamFromModal
    );


    /*
     * Scroll to the top when the editor opens.
     */
    setTimeout(() => {
      $('.editor-scroll')?.scrollTo({
        top: 0,
        behavior: 'instant'
      });
    }, 10);
  }


  function saveExamFromModal(event) {
    event.preventDefault();

    const form =
      event.currentTarget;

    const data =
      new FormData(form);


    const roomNumber =
      String(
        data.get('roomNumber') || ''
      ).trim();


    const passcode =
      String(
        data.get('passcode') || ''
      ).trim();


    const title =
      String(
        data.get('title') || ''
      ).trim();


    const description =
      String(
        data.get('description') || ''
      ).trim();


    const formUrl =
      String(
        data.get('formUrl') || ''
      ).trim();


    if (
      !roomNumber ||
      !passcode ||
      !title ||
      !formUrl
    ) {
      toast(
        'Please complete all required fields.',
        'error'
      );

      return;
    }


    if (
      !/^https:\/\/(docs\.google\.com|forms\.google\.com)\//i
        .test(formUrl)
    ) {
      toast(
        'Please enter a valid Google Forms URL.',
        'error'
      );

      return;
    }


    /*
     * Prevent duplicate room numbers.
     */
    const currentId =
      form.dataset.editingId || null;


    const duplicate =
      db.rooms.find(
        room =>
          room.roomNumber.toLowerCase() ===
            roomNumber.toLowerCase() &&
          room.id !== currentId
      );


    if (duplicate) {
      toast(
        'That room number is already in use.',
        'error'
      );

      return;
    }


    const durationMinutes =
      Math.max(
        1,
        Math.round(
          Number(
            data.get('durationMinutes')
          ) || 60
        )
      );


    const roomData = {

      roomNumber,

      passcode,

      title,

      description,

      formUrl,

      antiCheat:
        $('#antiCheat')?.checked === true,

      maxViolations:
        Math.max(
          1,
          Math.round(
            Number(
              data.get('maxViolations')
            ) || 3
          )
        ),

      timerEnabled:
        $('#timerEnabled')?.checked === true,

      durationMinutes,

      startAt:
        data.get('startAt')
          ? new Date(
              data.get('startAt')
            ).toISOString()
          : '',

      endAt:
        data.get('endAt')
          ? new Date(
              data.get('endAt')
            ).toISOString()
          : '',

      active:
        $('#active')?.checked === true
    };


    if (currentId) {

      const room =
        db.rooms.find(
          item => item.id === currentId
        );

      if (room) {
        Object.assign(
          room,
          roomData
        );
      }

    } else {

      db.rooms.push({
        id: uid('room'),
        ...roomData,
        createdAt: Date.now(),
        createdBy: 'u-admin'
      });

    }


    saveDB();

    closeModal();

    renderAdminRooms();

    toast(
      currentId
        ? 'Examination room updated successfully.'
        : 'Examination room created successfully.',
      'success'
    );
  }


  function deleteExam(id) {
    const room =
      db.rooms.find(
        item => item.id === id
      );

    if (!room) return;


    const sessions =
      db.attempts.filter(
        attempt =>
          attempt.examId === id
      ).length;


    if (
      !confirm(
        `Delete "${room.title}"?\n\n` +
        `Room ${room.roomNumber}\n\n` +
        `${sessions} historical session(s) will remain in reports.`
      )
    ) {
      return;
    }


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


  /* ================================================================
     MODALS
  ================================================================ */

  function closeModal() {
    const root =
      $('#modal-root');

    if (!root) return;

    root.hidden = true;
    root.innerHTML = '';
  }


  function closeAnyModal() {
    closeModal();
    closeAdminLogin();
  }


  /*
   * IMPORTANT:
   * One global delegated handler handles ALL dynamically generated
   * close/cancel buttons.
   *
   * This fixes the previous problem where newly generated buttons
   * were sometimes not bound.
   */
  function bindActions() {
    // No individual dynamic listeners are required.
  }


  document.addEventListener(
    'click',
    event => {

      const button =
        event.target.closest(
          '[data-action]'
        );


      if (!button) return;


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

        case 'close-admin-login':
          closeAdminLogin();
          break;

        case 'confirm-start':
          confirmStart(id);
          break;

        case 'start-exam':
          startExam(id);
          break;

        case 'view-submissions':
          adminPage('submissions');
          break;

        case 'refresh-admin':
          db = loadDB();
          renderAdminPage(
            Object.keys(ADMIN_PAGE_TITLES)
              .find(
                key =>
                  $(`#admin-${key}-page`)
                    ?.classList
                    .contains('active')
              ) || 'dashboard'
          );
          break;

        case 'toggle-theme':
          toggleTheme();
          break;

        case 'reset-demo':
          resetDemo();
          break;

        case 'delete-user':
          deleteUser(id);
          break;

      }

    }
  );


  /*
   * Close modal by clicking the dark backdrop.
   */
  document.addEventListener(
    'click',
    event => {

      if (
        event.target ===
        $('#modal-root')
      ) {
        closeModal();
      }


      if (
        event.target ===
        $('#admin-login-modal')
      ) {
        closeAdminLogin();
      }

    }
  );


  /*
   * Escape closes dialogs.
   */
  document.addEventListener(
    'keydown',
    event => {

      if (event.key !== 'Escape') return;

      closeModal();
      closeAdminLogin();

    }
  );


  /* ================================================================
     ADMIN SUBMISSIONS
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

          <h3>
            Examination Submissions
          </h3>

          <p>
            Every participant session is recorded
            independently, including multiple submissions
            from the same examination room.
          </p>

        </div>


        <div class="actions">

          <button
            class="secondary-btn"
            data-action="refresh-admin">
            ↻ Refresh
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
            b.timestamp - a.timestamp
        );


    $('#admin-violations-page').innerHTML = `

      <div class="page-head">

        <div>

          <span class="eyebrow">
            SECURITY
          </span>

          <h3>
            Security Activity
          </h3>

          <p>
            Review security events recorded during
            active examination sessions.
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
                      <th>Room</th>
                      <th>Examination</th>
                      <th>Participant</th>
                      <th>Event</th>
                      <th>Reason</th>
                    </tr>

                  </thead>

                  <tbody>

                    ${rows.map(v => `

                      <tr>

                        <td>
                          ${fmtDate(v.timestamp)}
                        </td>

                        <td>
                          ${esc(
                            v.roomNumber || '—'
                          )}
                        </td>

                        <td>
                          ${esc(
                            v.examTitle || '—'
                          )}
                        </td>

                        <td>
                          ${esc(
                            v.participantLabel ||
                            'Participant'
                          )}
                        </td>

                        <td>
                          <span class="security-count danger">
                            #${v.number}
                          </span>
                        </td>

                        <td>
                          ${esc(v.reason)}
                        </td>

                      </tr>

                    `).join('')}

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


  /* ================================================================
     ANALYTICS
  ================================================================ */

  function renderAnalytics() {
    const counts =
      attemptCounts();

    const total =
      counts.total || 1;


    const average =
      db.attempts.length
        ? (
            db.attempts.reduce(
              (sum, item) =>
                sum +
                (item.violations || 0),
              0
            ) /
            db.attempts.length
          ).toFixed(2)
        : '0.00';


    const completion =
      Math.round(
        counts.completed /
        total *
        100
      );


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
            High-level examination activity and
            security monitoring.
          </p>

        </div>

      </div>


      <div class="kpi-grid">

        ${kpi(
          'Completion Rate',
          completion + '%'
        )}

        ${kpi(
          'Sessions',
          counts.total
        )}

        ${kpi(
          'Active Sessions',
          counts.inProgress
        )}

        ${kpi(
          'Average Security Events',
          average
        )}

      </div>


      <div class="dashboard-grid">

        <div class="panel">

          <div class="panel-heading">

            <div>
              <span class="eyebrow">
                SESSION STATUS
              </span>

              <h3>
                Examination Outcomes
              </h3>
            </div>

          </div>


          ${chart(
            'Completed',
            counts.completed,
            counts.total
          )}

          ${chart(
            'In Progress',
            counts.inProgress,
            counts.total
          )}

          ${chart(
            'Time Expired',
            counts.expired,
            counts.total
          )}

          ${chart(
            'Terminated',
            counts.terminated,
            counts.total
          )}

        </div>


        <div class="panel">

          <div class="panel-heading">

            <div>
              <span class="eyebrow">
                ROOM ACTIVITY
              </span>

              <h3>
                Sessions by Room
              </h3>
            </div>

          </div>


          ${
            db.rooms.length
              ? db.rooms
                  .map(room => {

                    const count =
                      db.attempts.filter(
                        a =>
                          a.examId === room.id
                      ).length;

                    return chart(
                      `Room ${room.roomNumber}`,
                      count,
                      counts.total
                    );

                  })
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

    bindActions();
  }


  function kpi(label, value) {
    return `
      <div class="kpi">

        <span>
          ${esc(label)}
        </span>

        <strong>
          ${value}
        </strong>

      </div>
    `;
  }


  function chart(label, number, total) {
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

        <div class="chart-main">

          <div class="chart-label">
            ${esc(label)}
          </div>

          <div class="bar-track">

            <div
              class="bar-value"
              style="width:${percentage}%">
            </div>

          </div>

        </div>

        <div class="chart-number">
          ${number}
          <small>
            ${percentage}%
          </small>
        </div>

      </div>
    `;
  }


  /* ================================================================
     SETTINGS
  ================================================================ */

  function renderSettings() {

    $('#admin-settings-page').innerHTML = `

      <div class="page-head">

        <div>

          <span class="eyebrow">
            SYSTEM
          </span>

          <h3>
            Portal Settings
          </h3>

          <p>
            Configure the local prototype environment.
          </p>

        </div>

      </div>


      <div class="dashboard-grid">

        <div class="panel">

          <div class="panel-heading">

            <div>

              <span class="eyebrow">
                APPEARANCE
              </span>

              <h3>
                Theme
              </h3>

            </div>

          </div>


          <p class="muted">
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

          <div class="panel-heading">

            <div>

              <span class="eyebrow">
                DATA
              </span>

              <h3>
                Prototype Storage
              </h3>

            </div>

          </div>


          <p class="muted">
            Rooms, sessions and security logs are
            currently stored in this browser's
            localStorage.
          </p>


          <button
            class="danger-btn"
            data-action="reset-demo">
            Reset Prototype Data
          </button>

        </div>

      </div>


      <div class="panel production-panel">

        <span class="eyebrow">
          PRODUCTION NOTICE
        </span>

        <h3>
          Client-Side Prototype
        </h3>

        <div class="notice danger-notice">

          <strong>
            Important
          </strong>

          <p>
            This prototype stores examination data,
            room passcodes and security logs locally
            in the browser. For production deployment,
            authentication, examination access,
            participant sessions, timers and security
            records should be moved to a server-side
            application and database.
          </p>

        </div>

      </div>

    `;

    bindActions();
  }


  function deleteUser() {
    /*
     * Kept for compatibility with older saved data.
     * Room-based Proctor+ no longer uses participant
     * accounts.
     */
    toast(
      'Participant accounts are no longer required. Proctor+ uses room-based access.',
      'info'
    );
  }


  function resetDemo() {

    if (
      !confirm(
        'Reset all Proctor+ rooms, sessions and security logs?'
      )
    ) {
      return;
    }


    db = {
      users: [
        {
          id: 'u-admin',
          username: ADMIN_USERNAME,
          password: ADMIN_PASSWORD,
          role: 'admin',
          name: 'Administrator'
        }
      ],

      rooms: [
        clone(DEFAULT_ROOM)
      ],

      attempts: [],

      violations: [],

      theme: 'dark'
    };


    saveDB();

    toast(
      'Prototype data has been reset.',
      'success'
    );

    openAdmin();
  }


  /* ================================================================
     PARTICIPANT / ROOM DASHBOARD
  ================================================================ */

  function openParticipantDashboard() {

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


    $('#participant-room').textContent =
      room.roomNumber;


    $('#participant-room-status').textContent =
      getAvailability(room).status ===
      'Available'
        ? 'Room is available'
        : 'Room unavailable';


    $('#examiner-user-name').textContent =
      participantLabel();


    $('#examiner-avatar').textContent =
      'P';


    showView('examiner');

    renderParticipantDashboard();
  }


  function renderParticipantDashboard() {

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


    const availability =
      getAvailability(room);


    const myAttempts =
      db.attempts.filter(
        attempt =>
          attempt.participantId ===
          session.participantId
      );


    const completed =
      myAttempts.filter(
        attempt =>
          [
            'Completed',
            'Time Expired',
            'Terminated'
          ].includes(attempt.status)
      ).length;


    $('#examiner-dashboard-page').innerHTML = `

      <div class="room-dashboard-hero">

        <div>

          <div class="room-welcome">
            <span class="eyebrow">
              ROOM ${esc(room.roomNumber)}
            </span>

            <h3>
              Welcome to the Examination Room
            </h3>

            <p>
              You are connected to
              <strong>${esc(room.title)}</strong>.
              Review the examination information below
              before starting.
            </p>

          </div>

        </div>


        <div class="room-live-status">

          <span class="status-dot"></span>

          ${
            availability.status ===
            'Available'
              ? 'Room Available'
              : 'Room Unavailable'
          }

        </div>

      </div>


      <div class="participant-stat-grid">

        <div class="participant-stat">

          <span>
            EXAMINATION
          </span>

          <strong>
            ${esc(room.title)}
          </strong>

        </div>


        <div class="participant-stat">

          <span>
            DURATION
          </span>

          <strong>
            ${
              room.timerEnabled
                ? `${room.durationMinutes} minutes`
                : 'No Timer'
            }
          </strong>

        </div>


        <div class="participant-stat">

          <span>
            PROCTORING
          </span>

          <strong>
            ${
              room.antiCheat
                ? 'Enabled'
                : 'Standard'
            }
          </strong>

        </div>


        <div class="participant-stat">

          <span>
            YOUR SESSIONS
          </span>

          <strong>
            ${myAttempts.length}
          </strong>

        </div>

      </div>


      <div class="dashboard-grid participant-grid">

        <div class="panel examination-start-panel">

          <span class="eyebrow">
            EXAMINATION
          </span>

          <h3>
            ${esc(room.title)}
          </h3>

          <p>
            ${esc(
              room.description ||
              'Please review the examination instructions before starting.'
            )}
          </p>


          <div class="instruction-list">

            <div>
              <span>01</span>
              <p>
                Ensure you have a stable internet
                connection before beginning.
              </p>
            </div>

            <div>
              <span>02</span>
              <p>
                Complete the Google Form within the
                configured examination period.
              </p>
            </div>

            <div>
              <span>03</span>
              <p>
                Submit the Google Form first, then
                click <strong>Submit Exam</strong>
                in Proctor+.
              </p>
            </div>

            <div>
              <span>04</span>
              <p>
                If proctoring is enabled, tab switching,
                focus loss and fullscreen exits may
                generate security events.
              </p>
            </div>

          </div>


          ${
            room.antiCheat
              ? `
                <div class="notice danger-notice">

                  <strong>
                    Proctoring Enabled
                  </strong>

                  <p>
                    Security monitoring is enabled for
                    this examination. Browser limitations
                    mean Proctor+ provides detection and
                    deterrence rather than complete
                    browser lockdown.
                  </p>

                </div>
              `
              : ''
          }


          <button
            class="primary-btn"
            data-action="start-exam"
            data-id="${room.id}"
            ${
              availability.status !== 'Available'
                ? 'disabled'
                : ''
            }>

            ${
              availability.status === 'Available'
                ? 'Start Examination →'
                : 'Examination Unavailable'
            }

          </button>

        </div>


        <div class="panel">

          <span class="eyebrow">
            ROOM INFORMATION
          </span>

          <h3>
            Access Details
          </h3>


          <div class="room-detail-list">

            <div>
              <span>Room Number</span>
              <strong>
                ${esc(room.roomNumber)}
              </strong>
            </div>

            <div>
              <span>Availability</span>
              <strong>
                ${
                  availability.status
                }
              </strong>
            </div>

            <div>
              <span>Timer</span>
              <strong>
                ${
                  room.timerEnabled
                    ? `${room.durationMinutes} min`
                    : 'Disabled'
                }
              </strong>
            </div>

            <div>
              <span>Anti-cheat</span>
              <strong>
                ${
                  room.antiCheat
                    ? 'Enabled'
                    : 'Disabled'
                }
              </strong>
            </div>

            <div>
              <span>Your completed sessions</span>
              <strong>
                ${completed}
              </strong>
            </div>

          </div>


          <div class="participant-note">

            <span class="note-icon">
              i
            </span>

            <p>
              You may enter and submit this examination
              without affecting other participants using
              the same room.
            </p>

          </div>

        </div>

      </div>

    `;

    bindActions();
  }


  /* ================================================================
     START EXAM
  ================================================================ */

  function startExam(id) {

    const room =
      db.rooms.find(
        item =>
          item.id === id
      );


    if (!room) return;


    const availability =
      getAvailability(room);


    if (
      availability.status !==
      'Available'
    ) {
      toast(
        availability.message,
        'error'
      );

      return;
    }


    openStartInstructions(room);
  }


  function openStartInstructions(room) {

    $('#modal-root').hidden = false;


    $('#modal-root').innerHTML = `

      <div
        class="modal modal-medium"
        role="dialog"
        aria-modal="true">

        <div class="modal-head">

          <div>

            <span class="eyebrow">
              EXAMINATION INSTRUCTIONS
            </span>

            <h3>
              ${esc(room.title)}
            </h3>

          </div>

          <button
            class="close-btn"
            type="button"
            data-action="close-modal"
            aria-label="Close">
            ×
          </button>

        </div>


        <div class="modal-body">

          <div class="notice">

            <strong>
              Ready to begin?
            </strong>

            <p>
              This action starts a new independent
              examination session for this device.
            </p>

          </div>


          <div class="start-rule-list">

            <div>
              <span>01</span>

              <p>
                ${
                  room.timerEnabled
                    ? `You have <strong>${room.durationMinutes} minutes</strong> to complete the examination.`
                    : 'No countdown timer is configured for this examination.'
                }
              </p>

            </div>


            <div>
              <span>02</span>

              <p>
                ${
                  room.antiCheat
                    ? `Proctoring is enabled with a maximum of <strong>${room.maxViolations}</strong> security event(s) before the current session is terminated.`
                    : 'Proctoring monitoring is disabled for this examination.'
                }
              </p>

            </div>


            <div>
              <span>03</span>

              <p>
                Complete the Google Form and use the
                Proctor+ <strong>Submit Exam</strong>
                button after submission.
              </p>

            </div>


            <div>
              <span>04</span>

              <p>
                Each start creates a separate session.
                Other participants in this room are
                not affected.
              </p>

            </div>

          </div>


          ${
            room.antiCheat
              ? `
                <div class="notice danger-notice">

                  <strong>
                    Proctoring Notice
                  </strong>

                  <p>
                    Fullscreen, visibility and focus
                    events may be monitored. Browser
                    security limitations mean this is
                    a detection and deterrence system,
                    not a complete browser lockdown.
                  </p>

                </div>
              `
              : ''
          }

        </div>


        <div class="modal-footer">

          <button
            type="button"
            class="secondary-btn"
            data-action="close-modal">
            Cancel
          </button>

          <button
            type="button"
            class="primary-btn"
            data-action="confirm-start"
            data-id="${room.id}">
            Start Examination
          </button>

        </div>

      </div>

    `;
  }


  function confirmStart(id) {

    closeModal();


    const room =
      db.rooms.find(
        item =>
          item.id === id
      );


    if (!room || !session) {
      return;
    }


    const timerEnabled =
      boolSetting(
        room.timerEnabled,
        false
      );


    const durationMinutes =
      Math.max(
        1,
        Math.round(
          Number(
            room.durationMinutes
          ) || 60
        )
      );


    const antiCheat =
      boolSetting(
        room.antiCheat,
        false
      );


    const maxViolations =
      Math.max(
        1,
        Math.round(
          Number(
            room.maxViolations
          ) || 3
        )
      );


    currentRoom =
      clone(room);


    /*
     * IMPORTANT:
     * There is NO search for an existing completed attempt.
     * Every participant can start another session.
     */
    const attempt = {

      id: uid('attempt'),

      examId:
        room.id,

      examTitle:
        room.title,

      roomNumber:
        room.roomNumber,

      participantId:
        session.participantId,

      participantLabel:
        participantLabel(),

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


    currentAttempt =
      attempt;


    clearInterval(timer);


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
        Date.now(),

      active:
        true

    };


    $('#live-exam-title').textContent =
      room.title;


    $('#live-exam-examiner').textContent =
      `Room ${room.roomNumber} • ${participantLabel()}`;


    $('#exam-violations').textContent =
      `0 / ${maxViolations}`;


    $('#exam-iframe').src =
      addRefreshParam(
        room.formUrl
      );


    $('#exam-instructions').textContent =
      timerEnabled
        ? `Timer: ${durationMinutes} minutes • Proctoring: ${antiCheat ? 'Enabled' : 'Disabled'} • Submit the Google Form first, then click Submit Exam.`
        : `No timer • Proctoring: ${antiCheat ? 'Enabled' : 'Disabled'} • Submit the Google Form first, then click Submit Exam.`;


    showView('exam');


    document.body.classList.add(
      'lockdown-active'
    );


    $('#exam-view')
      ?.classList
      .add('lockdown-active');


    graceUntil =
      Date.now() +
      FULLSCREEN_GRACE;


    if (antiCheat) {
      requestFullscreen()
        .finally(() => {
          graceUntil =
            Date.now() +
            FULLSCREEN_GRACE;
        });
    }


    renderTimer();


    if (timerEnabled) {
      startTimer();
    }
  }


  /* ================================================================
     GOOGLE FORM REFRESH
  ================================================================ */

  function addRefreshParam(url) {

    if (!url) {
      return DEFAULT_FORM;
    }


    const separator =
      url.includes('?')
        ? '&'
        : '?';


    return (
      url +
      separator +
      '_proctor_refresh=' +
      Date.now()
    );
  }


  function refreshGoogleForm() {

    if (
      !currentRoom ||
      !examState?.active
    ) {
      return;
    }


    const iframe =
      $('#exam-iframe');


    if (!iframe) return;


    /*
     * Force the iframe to reload even if the browser
     * has cached the Google Forms response/submission page.
     */
    iframe.src =
      'about:blank';


    setTimeout(() => {

      if (!examState?.active) return;

      iframe.src =
        addRefreshParam(
          currentRoom.formUrl
        );

    }, 100);


    toast(
      'Google Form refreshed.',
      'success'
    );
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
      Promise
        .resolve(
          fn.call(document)
        )
        .catch(() => {});
    }
  }


  function isFullscreen() {

    return !!(
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


    const remainingSeconds =
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
          ? `${minutes}:${remainingSeconds}`
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
        (100 - percentage) +
        '%';
    }

  }


  /* ================================================================
     PROCTORING
  ================================================================ */

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
      now <
      graceUntil
    ) {
      return;
    }


    if (
      now -
      lastViolation <
      VIOLATION_DEBOUNCE
    ) {
      return;
    }


    if (
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
      (attempt.violations || 0) +
      1;


    attempt.violations =
      number;


    db.violations.push({

      id:
        uid('violation'),

      attemptId:
        attempt.id,

      examId:
        currentRoom.id,

      examTitle:
        currentRoom.title,

      roomNumber:
        currentRoom.roomNumber,

      participantId:
        attempt.participantId,

      participantLabel:
        attempt.participantLabel,

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
        'Examination Terminated',
        'This examination session was terminated after exceeding the maximum allowed security events.',
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


    $('#violation-reason')
      .textContent =
      reason;


    const attempt =
      db.attempts.find(
        item =>
          item.id ===
          examState.attemptId
      );


    $('#overlay-count')
      .textContent =
      attempt?.violations ||
      0;


    $('#overlay-max')
      .textContent =
      examState.maxViolations;


    $('#violation-overlay')
      .hidden = false;


    $('#exam-iframe')
      .style.filter =
      'blur(6px) brightness(.45)';
  }


  $('#resume-exam-btn')
    ?.addEventListener(
      'click',
      async () => {

        if (
          !examState?.active
        ) {
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
          FULLSCREEN_GRACE;


        await requestFullscreen();


        graceUntil =
          Date.now() +
          FULLSCREEN_GRACE;

      }
    );


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


  document.addEventListener(
    'visibilitychange',
    () => {

      if (
        examState?.active &&
        examState.antiCheat &&
        document.hidden
      ) {

        registerViolation(
          'You switched tabs or minimized the examination window.'
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


  document.addEventListener(
    'keydown',
    event => {

      if (!examState?.active) {
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
          ['i', 'j', 'c'].includes(key)
        ) ||
        (
          modifier &&
          ['t', 'n', 'w', 'u'].includes(key)
        );


      if (restricted) {

        event.preventDefault();


        registerViolation(
          `Restricted shortcut attempt: ${[
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
            .join('+')}`
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


  /* ================================================================
     SUBMIT EXAM
  ================================================================ */

  $('#exam-submit-btn')
    ?.addEventListener(
      'click',
      () => {

        if (
          !examState?.active
        ) {
          return;
        }


        const confirmed =
          confirm(
            'Confirm that you have submitted the Google Form.\n\nThis will end the current examination session.'
          );


        if (!confirmed) {
          return;
        }


        finishExam(
          'Completed',
          'Examination Submitted',
          'Your examination session has been submitted successfully.',
          '✓'
        );

      }
    );


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


    $('#violation-overlay')
      .hidden = true;


    violationOverlayOpen =
      false;


    document.body.classList.remove(
      'lockdown-active'
    );


    $('#exam-view')
      ?.classList
      .remove(
        'lockdown-active'
      );


    exitFullscreen();


    $('#result-icon')
      .textContent =
      icon;


    $('#result-icon')
      .classList.toggle(
        'danger',
        terminated
      );


    $('#result-icon')
      .classList.toggle(
        'success',
        !terminated
      );


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


    $('#result-room')
      .textContent =
      currentRoom?.roomNumber ||
      '—';


    $('#result-exam')
      .textContent =
      currentRoom?.title ||
      '—';


    $('#result-violations')
      .textContent =
      attempt?.violations ||
      0;


    $('#result-ended')
      .textContent =
      fmtDate(Date.now());


    showView('result');
  }


  $('#result-dashboard-btn')
    ?.addEventListener(
      'click',
      () => {

        currentAttempt =
          null;

        examState =
          null;

        currentRoom =
          db.rooms.find(
            item =>
              item.id ===
              session?.roomId
          ) || null;


        if (currentRoom) {
          openParticipantDashboard();
        } else {
          logout();
        }

      }
    );


  /* ================================================================
     SIDEBAR NAVIGATION
  ================================================================ */

  document.addEventListener(
    'click',
    event => {

      const adminButton =
        event.target.closest(
          '[data-admin-page]'
        );


      if (adminButton) {

        adminPage(
          adminButton.dataset.adminPage
        );

        return;
      }


      const participantButton =
        event.target.closest(
          '[data-examiner-page]'
        );


      if (participantButton) {

        renderParticipantDashboard();

        return;
      }


      const sidebarButton =
        event.target.closest(
          '[data-toggle-sidebar]'
        );


      if (sidebarButton) {

        const sidebar =
          $(
            '#' +
            sidebarButton.dataset
              .toggleSidebar
          );


        sidebar?.classList.toggle(
          'open'
        );

      }

    }
  );


  /* ================================================================
     STATIC EVENT BINDINGS
  ================================================================ */

  $('#login-form')
    ?.addEventListener(
      'submit',
      loginToRoom
    );


  $('#admin-login-open')
    ?.addEventListener(
      'click',
      openAdminLogin
    );


  $('#admin-login-form')
    ?.addEventListener(
      'submit',
      adminLogin
    );


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


  $('#theme-toggle-examiner')
    ?.addEventListener(
      'click',
      toggleTheme
    );


  $('#refresh-form-btn')
    ?.addEventListener(
      'click',
      refreshGoogleForm
    );


  $('#refresh-form-btn-secondary')
    ?.addEventListener(
      'click',
      refreshGoogleForm
    );


  /* ================================================================
     CLOCK
  ================================================================ */

  function updateClocks() {

    const now =
      new Date().toLocaleString(
        [],
        {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        }
      );


    if ($('#admin-clock')) {
      $('#admin-clock')
        .textContent = now;
    }


    if ($('#examiner-clock')) {
      $('#examiner-clock')
        .textContent = now;
    }

  }


  setInterval(
    updateClocks,
    1000
  );


  updateClocks();


  /* ================================================================
     STARTUP
  ================================================================ */

  function initializePortal() {

    db =
      loadDB();


    applyTheme();


    bindActions();


    /*
     * Restore an administrator session.
     */
    if (
      session?.role ===
      'admin'
    ) {

      openAdmin();

      return;
    }


    /*
     * Restore a participant's room session.
     */
    if (
      session?.role ===
      'participant'
    ) {

      const room =
        db.rooms.find(
          item =>
            item.id ===
            session.roomId
        );


      if (room) {

        currentRoom =
          clone(room);

        openParticipantDashboard();

        return;

      }

    }


    session = null;

    saveSession();

    showView('login');

  }


  if (
    document.readyState ===
    'loading'
  ) {

    document.addEventListener(
      'DOMContentLoaded',
      initializePortal,
      { once: true }
    );

  } else {

    initializePortal();

  }

})();
