(() => {
  'use strict';

  const CONFIG = {
    MAX_VIOLATIONS: 3,
    EXAM_DURATION_SECONDS: 60 * 60,
    GOOGLE_FORM_URL: 'https://docs.google.com/forms/d/e/1FAIpQLSeK35oh4wlzl4-EFWxgU1H5BGgQu02UOhgK392l8CIY8Cho0A/viewform?usp=header'
  };

  // State Management
  const state = {
    currentUser: null,
    users: [
      { username: 'admin', password: '123admin', role: 'superadmin' } // Default User
    ],
    submissions: [
      { id: 'STU-101', name: 'Alice Smith', status: 'Submitted', score: '88%', violations: 0, time: '2026-03-15 09:15' },
      { id: 'STU-102', name: 'Bob Jones', status: 'Disqualified', score: 'N/A', violations: 3, time: '2026-03-15 09:40' }
    ],
    studentName: '',
    studentId: '',
    violationCount: 0,
    examActive: false, // Ensures detection occurs ONLY during active exam
    disqualified: false,
    timerInterval: null,
    secondsRemaining: CONFIG.EXAM_DURATION_SECONDS,
    lastViolationTimestamp: 0
  };

  // DOM Elements
  const el = {
    navLoginBtn: document.getElementById('nav-login-btn'),
    navLogoutBtn: document.getElementById('nav-logout-btn'),
    loginScreen: document.getElementById('login-screen'),
    startScreen: document.getElementById('start-screen'),
    examScreen: document.getElementById('exam-screen'),
    disqualifiedScreen: document.getElementById('disqualified-screen'),
    dashboardScreen: document.getElementById('dashboard-screen'),

    loginForm: document.getElementById('login-form'),
    loginUsername: document.getElementById('login-username'),
    loginPassword: document.getElementById('login-password'),
    loginError: document.getElementById('login-error'),
    loginBackBtn: document.getElementById('login-back-btn'),

    startForm: document.getElementById('start-form'),
    nameInput: document.getElementById('student-name'),
    idInput: document.getElementById('student-id'),
    startError: document.getElementById('start-error'),

    displayName: document.getElementById('display-name'),
    displayId: document.getElementById('display-id'),
    timer: document.getElementById('timer'),
    violationTracker: document.getElementById('violation-tracker'),
    iframe: document.getElementById('exam-iframe'),

    overlay: document.getElementById('violation-overlay'),
    violationReason: document.getElementById('violation-reason'),
    overlayViolationCount: document.getElementById('overlay-violation-count'),
    resumeBtn: document.getElementById('resume-btn'),

    dqName: document.getElementById('dq-name'),
    dqId: document.getElementById('dq-id'),
    dqCount: document.getElementById('dq-count'),
    dqTime: document.getElementById('dq-time'),

    userDisplayRole: document.userDisplayRole || document.getElementById('user-display-role'),
    tabOverviewBtn: document.getElementById('tab-overview-btn'),
    tabUsersBtn: document.getElementById('tab-users-btn'),
    tabOverview: document.getElementById('tab-overview'),
    tabUsers: document.getElementById('tab-users'),

    statTotal: document.getElementById('stat-total'),
    statAvgScore: document.getElementById('stat-avg-score'),
    statViolations: document.getElementById('stat-violations'),
    statDisqualified: document.getElementById('stat-disqualified'),
    submissionsTableBody: document.getElementById('submissions-table-body'),
    usersTableBody: document.getElementById('users-table-body'),

    addUserForm: document.getElementById('add-user-form'),
    newUsername: document.getElementById('new-username'),
    newPassword: document.getElementById('new-password'),
    newRole: document.getElementById('new-role'),
    addUserMsg: document.getElementById('add-user-msg')
  };

  el.iframe.src = CONFIG.GOOGLE_FORM_URL;

  // Navigation Logic
  function showScreen(screenEl) {
    [el.loginScreen, el.startScreen, el.examScreen, el.disqualifiedScreen, el.dashboardScreen].forEach(s => s.classList.remove('active'));
    screenEl.classList.add('active');
  }

  el.navLoginBtn.addEventListener('click', () => showScreen(el.loginScreen));
  el.loginBackBtn.addEventListener('click', () => showScreen(el.startScreen));

  // Authentication
  el.loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const username = el.loginUsername.value.trim();
    const password = el.loginPassword.value.trim();

    const user = state.users.find(u => u.username === username && u.password === password);
    if (user) {
      state.currentUser = user;
      el.loginError.hidden = true;
      el.loginForm.reset();
      setupDashboard();
      showScreen(el.dashboardScreen);
      el.navLoginBtn.hidden = true;
      el.navLogoutBtn.hidden = false;
    } else {
      el.loginError.textContent = 'Invalid credentials provided.';
      el.loginError.hidden = false;
    }
  });

  el.navLogoutBtn.addEventListener('click', () => {
    state.currentUser = null;
    el.navLoginBtn.hidden = false;
    el.navLogoutBtn.hidden = true;
    showScreen(el.startScreen);
  });

  // Start Exam Action ("Get Started")
  el.startForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    state.studentName = el.nameInput.value.trim();
    state.studentId = el.idInput.value.trim();

    try {
      await enterFullscreen(document.documentElement);
      beginExam();
    } catch (err) {
      el.startError.textContent = 'Fullscreen permission is required to start.';
      el.startError.hidden = false;
    }
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

  // Fullscreen Handlers
  function enterFullscreen(elem) {
    const req = elem.requestFullscreen || elem.webkitRequestFullscreen || elem.msRequestFullscreen;
    return req ? req.call(elem) : Promise.reject();
  }

  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement);
  }

  document.addEventListener('fullscreenchange', () => {
    if (state.examActive && !state.disqualified && !isFullscreen()) {
      registerViolation('Exited full-screen mode.');
    }
  });

  // Violation Monitoring (ACTIVE ONLY WHILE TIMER/EXAM IS ACTIVE)
  document.addEventListener('visibilitychange', () => {
    if (state.examActive && !state.disqualified && document.hidden) {
      registerViolation('Tab switched or application minimized.');
    }
  });

  window.addEventListener('blur', () => {
    if (state.examActive && !state.disqualified) {
      registerViolation('Exam window lost focus.');
    }
  });

  function registerViolation(reason) {
    const now = Date.now();
    if (now - state.lastViolationTimestamp < 500) return; // Debounce
    state.lastViolationTimestamp = now;

    state.violationCount++;
    updateViolationDisplay();

    if (state.violationCount >= CONFIG.MAX_VIOLATIONS) {
      disqualifyStudent();
    } else {
      el.violationReason.textContent = reason;
      el.overlayViolationCount.textContent = state.violationCount;
      el.overlay.hidden = false;
    }
  }

  function updateViolationDisplay() {
    el.violationTracker.textContent = `${state.violationCount} / ${CONFIG.MAX_VIOLATIONS}`;
    el.violationTracker.className = 'value violations ' + 
      (state.violationCount === 2 ? 'warning' : state.violationCount >= 3 ? 'critical' : '');
  }

  el.resumeBtn.addEventListener('click', async () => {
    el.overlay.hidden = true;
    if (!isFullscreen() && state.examActive) {
      try { await enterFullscreen(document.documentElement); } catch (e) {}
    }
  });

  // Timer & Disqualification
  function startTimer() {
    state.secondsRemaining = CONFIG.EXAM_DURATION_SECONDS;
    state.timerInterval = setInterval(() => {
      if (!state.examActive) return;
      state.secondsRemaining--;
      
      const m = String(Math.floor(state.secondsRemaining / 60)).padStart(2, '0');
      const s = String(state.secondsRemaining % 60).padStart(2, '0');
      el.timer.textContent = `${m}:${s}`;

      if (state.secondsRemaining <= 0) {
        clearInterval(state.timerInterval);
        completeExam('Submitted');
      }
    }, 1000);
  }

  function disqualifyStudent() {
    state.disqualified = true;
    state.examActive = false; // Stop tracking violations
    clearInterval(state.timerInterval);

    el.overlay.hidden = true;
    el.dqName.textContent = state.studentName;
    el.dqId.textContent = state.studentId;
    el.dqCount.textContent = state.violationCount;
    el.dqTime.textContent = new Date().toLocaleTimeString();

    completeExam('Disqualified');
    showScreen(el.disqualifiedScreen);
    document.body.classList.remove('lockdown-active');
  }

  function completeExam(status) {
    state.submissions.push({
      id: state.studentId,
      name: state.studentName,
      status: status,
      score: status === 'Disqualified' ? 'N/A' : 'Pending',
      violations: state.violationCount,
      time: new Date().toISOString().replace('T', ' ').substring(0, 16)
    });
  }

  // Dashboard & Analytics Engine
  function setupDashboard() {
    el.userDisplayRole.textContent = `${state.currentUser.username} (${state.currentUser.role})`;
    
    // Role-based visibility for Settings (Superadmin only)
    if (state.currentUser.role === 'superadmin') {
      el.tabUsersBtn.hidden = false;
    } else {
      el.tabUsersBtn.hidden = true;
      switchTab('overview');
    }

    renderAnalytics();
    renderSubmissionsTable();
    renderUsersTable();
  }

  function renderAnalytics() {
    const total = state.submissions.length;
    const totalViolations = state.submissions.reduce((acc, curr) => acc + curr.violations, 0);
    const disqualifiedCount = state.submissions.filter(s => s.status === 'Disqualified').length;

    el.statTotal.textContent = total;
    el.statViolations.textContent = totalViolations;
    el.statDisqualified.textContent = disqualifiedCount;
    el.statAvgScore.textContent = '85%'; // Default sample aggregate
  }

  function renderSubmissionsTable() {
    el.submissionsTableBody.innerHTML = state.submissions.map(s => `
      <tr>
        <td>${s.id}</td>
        <td>${s.name}</td>
        <td><strong style="color: ${s.status === 'Disqualified' ? 'var(--danger)' : 'var(--success)'}">${s.status}</strong></td>
        <td>${s.score}</td>
        <td>${s.violations}</td>
        <td>${s.time}</td>
      </tr>
    `).join('');
  }

  function renderUsersTable() {
    el.usersTableBody.innerHTML = state.users.map(u => `
      <tr>
        <td>${u.username}</td>
        <td>${u.role}</td>
      </tr>
    `).join('');
  }

  // Superadmin Add User Form
  el.addUserForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (state.currentUser.role !== 'superadmin') return;

    const username = el.newUsername.value.trim();
    const password = el.newPassword.value.trim();
    const role = el.newRole.value;

    if (state.users.some(u => u.username === username)) {
      el.addUserMsg.textContent = 'Username already exists.';
      el.addUserMsg.style.color = 'var(--danger)';
      el.addUserMsg.hidden = false;
      return;
    }

    state.users.push({ username, password, role });
    renderUsersTable();
    el.addUserForm.reset();
    el.addUserMsg.textContent = 'User added successfully!';
    el.addUserMsg.style.color = 'var(--success)';
    el.addUserMsg.hidden = false;
  });

  // Tab Navigation Controls
  el.tabOverviewBtn.addEventListener('click', () => switchTab('overview'));
  el.tabUsersBtn.addEventListener('click', () => switchTab('users'));

  function switchTab(tab) {
    if (tab === 'overview') {
      el.tabOverviewBtn.classList.add('active');
      el.tabUsersBtn.classList.remove('active');
      el.tabOverview.classList.add('active');
      el.tabUsers.classList.remove('active');
    } else {
      el.tabUsersBtn.classList.add('active');
      el.tabOverviewBtn.classList.remove('active');
      el.tabUsers.classList.add('active');
      el.tabOverview.classList.remove('active');
    }
  }
})();
