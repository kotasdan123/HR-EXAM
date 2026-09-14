(() => {
  'use strict';

  const CONFIG = {
    MAX_VIOLATIONS: 3,
    EXAM_DURATION_SECONDS: 60 * 60,
    GOOGLE_FORM_URL: 'https://docs.google.com/forms/d/e/1FAIpQLSeK35oh4wlzl4-EFWxgU1H5BGgQu02UOhgK392l8CIY8Cho0A/viewform?embedded=true'
  };

  // State Management
  const state = {
    currentUser: null,
    users: [
      { username: 'admin', password: '123admin', role: 'superadmin' } // Default Superadmin Account
    ],
    submissions: [
      { name: 'Alice Smith', status: 'Submitted', score: '88%', violations: 0, time: '2026-03-15 09:15' },
      { name: 'Bob Jones', status: 'Disqualified', score: 'N/A', violations: 3, time: '2026-03-15 09:40' },
      { name: 'Charlie Brown', status: 'Submitted', score: '92%', violations: 1, time: '2026-03-15 10:20' }
    ],
    studentName: '',
    violationCount: 0,
    examActive: false, // Strict flag: True ONLY while in active exam view
    disqualified: false,
    timerInterval: null,
    secondsRemaining: CONFIG.EXAM_DURATION_SECONDS,
    lastViolationTimestamp: 0
  };

  // DOM References
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
    startError: document.getElementById('start-error'),

    displayName: document.getElementById('display-name'),
    timer: document.getElementById('timer'),
    violationTracker: document.getElementById('violation-tracker'),
    iframe: document.getElementById('exam-iframe'),

    overlay: document.getElementById('violation-overlay'),
    violationReason: document.getElementById('violation-reason'),
    overlayViolationCount: document.getElementById('overlay-violation-count'),
    resumeBtn: document.getElementById('resume-btn'),

    dqName: document.getElementById('dq-name'),
    dqCount: document.getElementById('dq-count'),
    dqTime: document.getElementById('dq-time'),

    userDisplayRole: document.getElementById('user-display-role'),
    tabOverviewBtn: document.getElementById('tab-overview-btn'),
    tabUsersBtn: document.getElementById('tab-users-btn'),
    tabOverview: document.getElementById('tab-overview'),
    tabUsers: document.getElementById('tab-users'),

    statTotal: document.getElementById('stat-total'),
    statPassRate: document.getElementById('stat-pass-rate'),
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

  // Initialize Default State
  if (el.overlay) el.overlay.hidden = true;
  if (el.iframe) el.iframe.src = CONFIG.GOOGLE_FORM_URL;

  // Screen Switcher Helper
  function showScreen(screenEl) {
    // Disable active exam status if leaving exam screen
    if (screenEl !== el.examScreen) {
      state.examActive = false;
    }

    const allScreens = [el.loginScreen, el.startScreen, el.examScreen, el.disqualifiedScreen, el.dashboardScreen];
    allScreens.forEach(s => {
      if (s) {
        s.classList.remove('active');
        s.style.display = 'none'; // Ensure CSS override doesn't leave elements hidden
      }
    });

    if (screenEl) {
      screenEl.classList.add('active');
      screenEl.style.display = 'flex';
    }

    if (el.overlay) el.overlay.hidden = true;
  }

  // Initial Screen State
  showScreen(el.startScreen);

  // Strict Validator: Ensures violations are tracked ONLY during the exam
  function isExamInSession() {
    return state.examActive === true && 
           state.disqualified === false && 
           el.examScreen && 
           el.examScreen.classList.contains('active');
  }

  // Navigation Handlers
  if (el.navLoginBtn) el.navLoginBtn.addEventListener('click', () => showScreen(el.loginScreen));
  if (el.loginBackBtn) el.loginBackBtn.addEventListener('click', () => showScreen(el.startScreen));

  // Staff Portal Login
  if (el.loginForm) {
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
        el.loginError.textContent = 'Invalid username or password.';
        el.loginError.hidden = false;
      }
    });
  }

  if (el.navLogoutBtn) {
    el.navLogoutBtn.addEventListener('click', () => {
      state.currentUser = null;
      el.navLoginBtn.hidden = false;
      el.navLogoutBtn.hidden = true;
      showScreen(el.startScreen);
    });
  }

  // Student Starts Exam ("Get Started")
  if (el.startForm) {
    el.startForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      state.studentName = el.nameInput.value.trim();

      try {
        await enterFullscreen(document.documentElement);
      } catch (err) {
        console.warn('Fullscreen request skipped.');
      }
      beginExam();
    });
  }

  function beginExam() {
    state.disqualified = false;
    state.violationCount = 0;

    if (el.displayName) el.displayName.textContent = state.studentName;
    updateViolationDisplay();

    showScreen(el.examScreen);
    state.examActive = true; // Tracking unlocked ONLY here

    document.body.classList.add('lockdown-active');
    startTimer();
  }

  // Cross-browser Fullscreen Helpers
  function enterFullscreen(elem) {
    const req = elem.requestFullscreen || elem.webkitRequestFullscreen || elem.msRequestFullscreen || elem.mozRequestFullScreen;
    if (req) return req.call(elem).catch(() => {});
    return Promise.resolve();
  }

  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement || document.mozFullScreenElement);
  }

  // =========================================================================
  // VIOLATION DETECTORS (Strictly guarded by isExamInSession)
  // =========================================================================
  document.addEventListener('fullscreenchange', () => {
    if (isExamInSession() && !isFullscreen()) {
      registerViolation('Exited full-screen mode.');
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (isExamInSession() && document.hidden) {
      registerViolation('Tab switched or application minimized.');
    }
  });

  window.addEventListener('blur', () => {
    if (isExamInSession()) {
      registerViolation('Exam window lost focus.');
    }
  });

  function registerViolation(reason) {
    if (!isExamInSession()) return; // Absolute protection against non-exam screens

    const now = Date.now();
    if (now - state.lastViolationTimestamp < 800) return; // Debounce triggers
    state.lastViolationTimestamp = now;

    state.violationCount++;
    updateViolationDisplay();

    if (state.violationCount >= CONFIG.MAX_VIOLATIONS) {
      disqualifyStudent();
    } else {
      if (el.violationReason) el.violationReason.textContent = reason;
      if (el.overlayViolationCount) el.overlayViolationCount.textContent = state.violationCount;
      if (el.overlay) el.overlay.hidden = false;
    }
  }

  function updateViolationDisplay() {
    if (!el.violationTracker) return;
    el.violationTracker.textContent = `${state.violationCount} / ${CONFIG.MAX_VIOLATIONS}`;
    el.violationTracker.className = 'value violations ' + 
      (state.violationCount === 2 ? 'warning' : state.violationCount >= 3 ? 'critical' : '');
  }

  // Resume Action Button Handler
  if (el.resumeBtn) {
    el.resumeBtn.addEventListener('click', async () => {
      if (el.overlay) el.overlay.hidden = true;

      if (isExamInSession() && !isFullscreen()) {
        try {
          await enterFullscreen(document.documentElement);
        } catch (err) {
          console.warn('Could not re-enter fullscreen:', err);
        }
      }
    });
  }

  // Timer & Disqualification
  function startTimer() {
    state.secondsRemaining = CONFIG.EXAM_DURATION_SECONDS;
    if (state.timerInterval) clearInterval(state.timerInterval);

    state.timerInterval = setInterval(() => {
      if (!isExamInSession()) return;
      state.secondsRemaining--;
      
      const m = String(Math.floor(state.secondsRemaining / 60)).padStart(2, '0');
      const s = String(state.secondsRemaining % 60).padStart(2, '0');
      if (el.timer) el.timer.textContent = `${m}:${s}`;

      if (state.secondsRemaining <= 0) {
        clearInterval(state.timerInterval);
        completeExam('Submitted');
      }
    }, 1000);
  }

  function disqualifyStudent() {
    state.disqualified = true;
    state.examActive = false; 
    clearInterval(state.timerInterval);

    if (el.overlay) el.overlay.hidden = true;
    if (el.dqName) el.dqName.textContent = state.studentName;
    if (el.dqCount) el.dqCount.textContent = state.violationCount;
    if (el.dqTime) el.dqTime.textContent = new Date().toLocaleTimeString();

    completeExam('Disqualified');
    showScreen(el.disqualifiedScreen);
    document.body.classList.remove('lockdown-active');
  }

  function completeExam(status) {
    state.submissions.push({
      name: state.studentName,
      status: status,
      score: status === 'Disqualified' ? 'N/A' : 'Pending',
      violations: state.violationCount,
      time: new Date().toISOString().replace('T', ' ').substring(0, 16)
    });
  }

  // =========================================================================
  // DASHBOARD & ANALYTICS ENGINE
  // =========================================================================
  function setupDashboard() {
    if (el.userDisplayRole) {
      el.userDisplayRole.textContent = `${state.currentUser.username} (${state.currentUser.role.toUpperCase()})`;
    }
    
    // Role Permission Controls
    if (state.currentUser.role === 'superadmin') {
      if (el.tabUsersBtn) el.tabUsersBtn.hidden = false;
    } else {
      if (el.tabUsersBtn) el.tabUsersBtn.hidden = true;
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
    const submittedCount = total - disqualifiedCount;
    const passRate = total > 0 ? Math.round((submittedCount / total) * 100) : 0;

    if (el.statTotal) el.statTotal.textContent = total;
    if (el.statPassRate) el.statPassRate.textContent = `${passRate}%`;
    if (el.statViolations) el.statViolations.textContent = totalViolations;
    if (el.statDisqualified) el.statDisqualified.textContent = disqualifiedCount;
  }

  function renderSubmissionsTable() {
    if (!el.submissionsTableBody) return;
    el.submissionsTableBody.innerHTML = state.submissions.map(s => `
      <tr>
        <td><strong>${s.name}</strong></td>
        <td><span style="color: ${s.status === 'Disqualified' ? 'var(--danger)' : 'var(--success)'}; font-weight:600;">${s.status}</span></td>
        <td>${s.score}</td>
        <td>${s.violations}</td>
        <td>${s.time}</td>
      </tr>
    `).join('');
  }

  function renderUsersTable() {
    if (!el.usersTableBody) return;
    el.usersTableBody.innerHTML = state.users.map(u => `
      <tr>
        <td><strong>${u.username}</strong></td>
        <td><span class="badge">${u.role.toUpperCase()}</span></td>
      </tr>
    `).join('');
  }

  // Superadmin Form Logic
  if (el.addUserForm) {
    el.addUserForm.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!state.currentUser || state.currentUser.role !== 'superadmin') return;

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
  }

  // Tab Switching
  if (el.tabOverviewBtn) el.tabOverviewBtn.addEventListener('click', () => switchTab('overview'));
  if (el.tabUsersBtn) el.tabUsersBtn.addEventListener('click', () => switchTab('users'));

  function switchTab(tab) {
    if (tab === 'overview') {
      if (el.tabOverviewBtn) el.tabOverviewBtn.classList.add('active');
      if (el.tabUsersBtn) el.tabUsersBtn.classList.remove('active');
      if (el.tabOverview) el.tabOverview.classList.add('active');
      if (el.tabUsers) el.tabUsers.classList.remove('active');
    } else {
      if (el.tabUsersBtn) el.tabUsersBtn.classList.add('active');
      if (el.tabOverviewBtn) el.tabOverviewBtn.classList.remove('active');
      if (el.tabUsers) el.tabUsers.classList.add('active');
      if (el.tabOverview) el.tabOverview.classList.remove('active');
    }
  }
})();
