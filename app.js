/* =========================================================
   PROCTOR+ SECURE EXAM PORTAL
   app.js
   ========================================================= */

const DB_KEY = "secure_exam_portal_v2";
const SESSION_KEY = "secure_exam_session_v2";
const THEME_KEY = "secure_exam_theme";

const CONFIG = {
    MAX_EXAMS_PER_ADMIN: 6,
    DEFAULT_MAX_VIOLATIONS: 3,
    DEFAULT_EXAM_DURATION: 3600,
    GRACE_PERIOD_MS: 1200
};

/* =========================================================
   DEFAULT DATABASE
   ========================================================= */

const DEFAULT_DB = {
    users: [
        {
            id: "u-admin",
            username: "admin",
            password: "123admin",
            role: "admin",
            name: "Administrator"
        },
        {
            id: "u-test",
            username: "test",
            password: "test",
            role: "examiner",
            name: "Test Examiner"
        }
    ],

    exams: [
        {
            id: "exam-demo",
            title: "Demo Examination",
            description: "Demo online examination",
            formUrl: "https://docs.google.com/forms/d/e/FORM_ID/viewform",
            examinerUsername: "test",
            examinerPassword: "test",

            antiCheat: true,
            maxViolations: 3,

            timerEnabled: true,
            durationSeconds: 3600,

            availabilityStart: "",
            availabilityEnd: "",

            status: "active",

            createdAt: new Date().toISOString()
        }
    ],

    attempts: [],
    violations: []
};

/* =========================================================
   GLOBAL VARIABLES
   ========================================================= */

let db = loadDatabase();

let currentUser = null;
let currentExam = null;
let examState = null;

let focusTimer = null;
let violationOverlayOpen = false;

/* =========================================================
   DATABASE
   ========================================================= */

function loadDatabase() {
    try {
        const saved = localStorage.getItem(DB_KEY);

        if (!saved) {
            localStorage.setItem(
                DB_KEY,
                JSON.stringify(DEFAULT_DB)
            );

            return structuredClone(DEFAULT_DB);
        }

        const parsed = JSON.parse(saved);

        parsed.users ||= [];
        parsed.exams ||= [];
        parsed.attempts ||= [];
        parsed.violations ||= [];

        /*
         * SAFETY FIX:
         * Make sure the default accounts still exist.
         *
         * This prevents a previous/localStorage problem
         * from making the portal impossible to log into.
         */

        const adminExists = parsed.users.some(
            user =>
                user.username === "admin" &&
                user.role === "admin"
        );

        const examinerExists = parsed.users.some(
            user =>
                user.username === "test" &&
                user.role === "examiner"
        );

        if (!adminExists) {
            parsed.users.push({
                id: "u-admin",
                username: "admin",
                password: "123admin",
                role: "admin",
                name: "Administrator"
            });
        }

        if (!examinerExists) {
            parsed.users.push({
                id: "u-test",
                username: "test",
                password: "test",
                role: "examiner",
                name: "Test Examiner"
            });
        }

        localStorage.setItem(
            DB_KEY,
            JSON.stringify(parsed)
        );

        return parsed;

    } catch (error) {

        console.error(
            "Database loading error:",
            error
        );

        localStorage.setItem(
            DB_KEY,
            JSON.stringify(DEFAULT_DB)
        );

        return structuredClone(DEFAULT_DB);
    }
}

function saveDatabase() {
    localStorage.setItem(
        DB_KEY,
        JSON.stringify(db)
    );
}

/* =========================================================
   UTILITY
   ========================================================= */

function generateId(prefix = "id") {
    return `${prefix}-${Date.now()}-${Math.random()
        .toString(36)
        .substring(2, 9)}`;
}

function nowISO() {
    return new Date().toISOString();
}

function $(selector) {
    return document.querySelector(selector);
}

function $$(selector) {
    return [...document.querySelectorAll(selector)];
}

function setText(id, value) {
    const element =
        document.getElementById(id);

    if (element) {
        element.textContent =
            value ?? "";
    }
}

function escapeHTML(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function formatDate(date) {

    if (!date) return "—";

    const d = new Date(date);

    if (Number.isNaN(d.getTime())) {
        return "—";
    }

    return d.toLocaleString();
}

function formatDuration(seconds) {

    seconds =
        Math.max(
            0,
            Number(seconds) || 0
        );

    const hours =
        Math.floor(seconds / 3600);

    const minutes =
        Math.floor(
            (seconds % 3600) / 60
        );

    const secs =
        seconds % 60;

    if (hours > 0) {

        return (
            String(hours).padStart(2, "0") +
            ":" +
            String(minutes).padStart(2, "0") +
            ":" +
            String(secs).padStart(2, "0")
        );
    }

    return (
        String(minutes).padStart(2, "0") +
        ":" +
        String(secs).padStart(2, "0")
    );
}

/* =========================================================
   SESSION
   ========================================================= */

function saveSession() {

    if (!currentUser) return;

    sessionStorage.setItem(
        SESSION_KEY,
        JSON.stringify({
            userId: currentUser.id,
            username: currentUser.username,
            role: currentUser.role
        })
    );
}

function clearSession() {
    sessionStorage.removeItem(
        SESSION_KEY
    );
}

function restoreSession() {

    try {

        const raw =
            sessionStorage.getItem(
                SESSION_KEY
            );

        if (!raw) {
            return false;
        }

        const session =
            JSON.parse(raw);

        if (!session.userId) {
            return false;
        }

        const user =
            db.users.find(
                item =>
                    item.id === session.userId
            );

        if (!user) {
            clearSession();
            return false;
        }

        currentUser = user;

        return true;

    } catch (error) {

        clearSession();

        return false;
    }
}

/* =========================================================
   INITIALIZATION
   ========================================================= */

document.addEventListener(
    "DOMContentLoaded",
    initializeApplication
);

function initializeApplication() {

    setupEventListeners();

    setupTheme();

    /*
     * IMPORTANT:
     *
     * Anti-cheat monitoring is NOT started here.
     *
     * It only starts after an actual exam begins.
     */

    if (restoreSession()) {

        if (currentUser.role === "admin") {
            showAdminDashboard();
        } else {
            showExaminerDashboard();
        }

    } else {

        showLogin();
    }

    syncViolationOverlay();
}

/* =========================================================
   EVENT LISTENERS
   ========================================================= */

function setupEventListeners() {

    /* LOGIN */

    const loginForm =
        $("#login-form");

    if (loginForm) {

        loginForm.addEventListener(
            "submit",
            handleLogin
        );
    }

    /* LOGOUT */

    $$("[data-action='logout']")
        .forEach(button => {

            button.addEventListener(
                "click",
                logout
            );
        });

    /* THEME */

    $$("[data-action='toggle-theme']")
        .forEach(button => {

            button.addEventListener(
                "click",
                toggleTheme
            );
        });

    /* ADMIN NAVIGATION */

    $$(".admin-nav button")
        .forEach(button => {

            button.addEventListener(
                "click",
                () => {

                    const page =
                        button.dataset.page;

                    if (page) {
                        showAdminPage(page);
                    }
                }
            );
        });

    /* EXAM SUBMIT */

    const submitButton =
        $("#submit-exam");

    if (submitButton) {

        submitButton.addEventListener(
            "click",
            () => {

                if (!examState?.active) {
                    return;
                }

                submitCurrentExam();
            }
        );
    }

    /* VIOLATION CONTINUE */

    const violationContinue =
        $("#violation-continue");

    if (violationContinue) {

        violationContinue.addEventListener(
            "click",
            hideViolationOverlay
        );
    }

    /* RESET DEMO */

    const resetDemo =
        $("#reset-demo");

    if (resetDemo) {

        resetDemo.addEventListener(
            "click",
            resetDemoData
        );
    }

    /*
     * Generic action delegation.
     */

    document.addEventListener(
        "click",
        handleActionClick
    );
}

/* =========================================================
   LOGIN
   ========================================================= */

function handleLogin(event) {

    event.preventDefault();

    const usernameInput =
        $("#username");

    const passwordInput =
        $("#password");

    if (!usernameInput ||
        !passwordInput) {

        return;
    }

    const username =
        usernameInput.value.trim();

    const password =
        passwordInput.value;

    /*
     * Clear previous error.
     */

    const error =
        $("#login-error");

    if (error) {
        error.hidden = true;
        error.textContent = "";
    }

    /*
     * Find account.
     */

    const user =
        db.users.find(
            item =>
                item.username.toLowerCase() ===
                    username.toLowerCase() &&
                item.password === password
        );

    /*
     * INVALID LOGIN
     */

    if (!user) {

        if (error) {

            error.textContent =
                "Incorrect username or password. Please check your credentials and try again.";

            error.hidden = false;
        }

        /*
         * Add a small visual shake
         * to the login form.
         */

        const form =
            $("#login-form");

        if (form) {

            form.classList.remove(
                "login-error-shake"
            );

            void form.offsetWidth;

            form.classList.add(
                "login-error-shake"
            );
        }

        passwordInput.value = "";

        passwordInput.focus();

        return;
    }

    /*
     * Successful login.
     */

    if (error) {
        error.hidden = true;
    }

    currentUser = user;

    saveSession();

    /*
     * NEVER start anti-cheat here.
     */

    stopExamMonitoring();

    examState = null;

    currentExam = null;

    if (user.role === "admin") {

        showAdminDashboard();

    } else {

        showExaminerDashboard();
    }
}

/* =========================================================
   LOGOUT
   ========================================================= */

function logout() {

    /*
     * Stop exam monitoring before leaving.
     */

    stopExamMonitoring();

    stopExamTimer();

    examState = null;
    currentExam = null;

    currentUser = null;

    clearSession();

    showLogin();
}

/* =========================================================
   VIEW MANAGEMENT
   ========================================================= */

function hideAllViews() {

    $$(".view").forEach(view => {

        view.hidden = true;

        view.classList.remove(
            "active"
        );
    });

    $$(".admin-page")
        .forEach(page => {

            page.classList.remove(
                "active"
            );
        });
}

function showLogin() {

    /*
     * VERY IMPORTANT:
     *
     * Login page never has
     * violation monitoring.
     */

    stopExamMonitoring();

    stopExamTimer();

    examState = null;

    currentExam = null;

    hideAllViews();

    const loginView =
        $("#login-view");

    if (loginView) {

        loginView.hidden = false;

        loginView.classList.add(
            "active"
        );
    }

    syncViolationOverlay();
}

function showAdminDashboard() {

    stopExamMonitoring();

    stopExamTimer();

    examState = null;
    currentExam = null;

    hideAllViews();

    const adminView =
        $("#admin-view");

    if (adminView) {

        adminView.hidden = false;

        adminView.classList.add(
            "active"
        );
    }

    showAdminPage("dashboard");
}

function showExaminerDashboard() {

    stopExamMonitoring();

    stopExamTimer();

    examState = null;
    currentExam = null;

    hideAllViews();

    const examinerView =
        $("#examiner-view");

    if (examinerView) {

        examinerView.hidden = false;

        examinerView.classList.add(
            "active"
        );
    }

    renderExaminerDashboard();

    syncViolationOverlay();
}

function showExamView() {

    hideAllViews();

    const examView =
        $("#exam-view");

    if (examView) {

        examView.hidden = false;

        examView.classList.add(
            "active"
        );
    }
}

/* =========================================================
   GENERIC ACTIONS
   ========================================================= */

function handleActionClick(event) {

    const button =
        event.target.closest(
            "[data-action]"
        );

    if (!button) return;

    const action =
        button.dataset.action;

    switch (action) {

        case "logout":
            logout();
            break;

        case "start-exam":
            startExam(
                button.dataset.examId
            );
            break;

        case "delete-exam":
            deleteExam(
                button.dataset.examId
            );
            break;

        case "edit-exam":
            openExamModal(
                button.dataset.examId
            );
            break;

        case "new-exam":
            openExamModal();
            break;

        case "close-modal":
            closeModal();
            break;

        case "save-exam":
            saveExamFromModal();
            break;

        case "show-page":
            showAdminPage(
                button.dataset.page
            );
            break;

        case "refresh-admin":
            renderAdminPage();
            break;
    }
}

/* =========================================================
   ADMIN NAVIGATION
   ========================================================= */

function showAdminPage(pageName) {

    $$(".admin-page")
        .forEach(page => {

            page.classList.remove(
                "active"
            );
        });

    const target =
        document.getElementById(
            `admin-page-${pageName}`
        );

    if (target) {

        target.classList.add(
            "active"
        );
    }

    $$(".admin-nav button")
        .forEach(button => {

            button.classList.toggle(
                "active",
                button.dataset.page ===
                    pageName
            );
        });

    renderAdminPage(pageName);
}

function renderAdminPage(pageName) {

    switch (pageName) {

        case "dashboard":
            renderAdminDashboard();
            break;

        case "exams":
            renderAdminExams();
            break;

        case "submissions":
            renderSubmissions();
            break;

        case "violations":
            renderViolationLogs();
            break;

        case "analytics":
            renderAnalytics();
            break;

        case "settings":
            renderSettings();
            break;
    }
}

/* =========================================================
   ADMIN DASHBOARD
   ========================================================= */

function renderAdminDashboard() {

    const totalExams =
        db.exams.length;

    const totalAttempts =
        db.attempts.length;

    const completed =
        db.attempts.filter(
            attempt =>
                attempt.status ===
                "Completed"
        ).length;

    const terminated =
        db.attempts.filter(
            attempt =>
                attempt.status ===
                "Terminated"
        ).length;

    setText(
        "admin-total-exams",
        totalExams
    );

    setText(
        "admin-total-submissions",
        totalAttempts
    );

    setText(
        "admin-completed",
        completed
    );

    setText(
        "admin-terminated",
        terminated
    );

    const recentContainer =
        $("#recent-submissions");

    if (!recentContainer) return;

    const recent =
        [...db.attempts]
            .sort(
                (a, b) =>
                    new Date(b.startedAt) -
                    new Date(a.startedAt)
            )
            .slice(0, 10);

    if (!recent.length) {

        recentContainer.innerHTML =
            `<div class="empty-state">
                No submissions yet.
            </div>`;

        return;
    }

    recentContainer.innerHTML =
        recent.map(
            attempt => `
                <div class="submission-row">

                    <div>
                        <strong>
                            ${escapeHTML(
                                attempt.examTitle
                            )}
                        </strong>

                        <small>
                            ${escapeHTML(
                                attempt.username
                            )}
                        </small>
                    </div>

                    <span class="status-badge">
                        ${escapeHTML(
                            attempt.status
                        )}
                    </span>

                    <small>
                        ${formatDate(
                            attempt.startedAt
                        )}
                    </small>

                </div>
            `
        ).join("");
}

/* =========================================================
   EXAM MANAGEMENT
   ========================================================= */

function renderAdminExams() {

    const container =
        $("#admin-exams-list");

    if (!container) return;

    if (!db.exams.length) {

        container.innerHTML = `
            <div class="empty-state">
                No exams have been created.
            </div>
        `;

        return;
    }

    container.innerHTML =
        db.exams.map(exam => {

            const attempts =
                db.attempts.filter(
                    attempt =>
                        attempt.examId ===
                        exam.id
                );

            return `
                <div class="exam-admin-card">

                    <div class="exam-admin-info">

                        <h3>
                            ${escapeHTML(
                                exam.title
                            )}
                        </h3>

                        <p>
                            ${escapeHTML(
                                exam.description ||
                                "No description."
                            )}
                        </p>

                        <div class="exam-meta">

                            <span>
                                Examiner:
                                <strong>
                                    ${escapeHTML(
                                        exam.examinerUsername
                                    )}
                                </strong>
                            </span>

                            <span>
                                Attempts:
                                <strong>
                                    ${attempts.length}
                                </strong>
                            </span>

                            <span>
                                Anti-Cheat:
                                <strong>
                                    ${
                                        exam.antiCheat
                                            ? "ON"
                                            : "OFF"
                                    }
                                </strong>
                            </span>

                            <span>
                                Timer:
                                <strong>
                                    ${
                                        exam.timerEnabled
                                            ? formatDuration(
                                                exam.durationSeconds
                                            )
                                            : "OFF"
                                    }
                                </strong>
                            </span>

                        </div>

                    </div>

                    <div class="exam-admin-actions">

                        <button
                            class="btn btn-secondary"
                            data-action="edit-exam"
                            data-exam-id="${exam.id}">
                            Edit
                        </button>

                        <button
                            class="btn btn-danger"
                            data-action="delete-exam"
                            data-exam-id="${exam.id}">
                            Delete
                        </button>

                    </div>

                </div>
            `;

        }).join("");
}

/* =========================================================
   EXAM MODAL
   ========================================================= */

function openExamModal(examId = null) {

    const modal =
        $("#modal-root");

    if (!modal) return;

    const exam =
        examId
            ? db.exams.find(
                item =>
                    item.id === examId
            )
            : null;

    if (examId && !exam) return;

    modal.innerHTML = `

        <div class="modal-backdrop">

            <div class="modal">

                <div class="modal-header">

                    <h2>
                        ${
                            exam
                                ? "Edit Examination"
                                : "Create Examination"
                        }
                    </h2>

                    <button
                        class="icon-button"
                        data-action="close-modal">
                        ×
                    </button>

                </div>

                <div class="modal-body">

                    <input
                        type="hidden"
                        id="exam-id"
                        value="${exam?.id || ""}"
                    >

                    <label>
                        Exam Title

                        <input
                            id="exam-title"
                            type="text"
                            value="${escapeHTML(
                                exam?.title || ""
                            )}"
                            required
                        >
                    </label>

                    <label>
                        Description

                        <textarea
                            id="exam-description"
                        >${escapeHTML(
                            exam?.description || ""
                        )}</textarea>
                    </label>

                    <label>
                        Google Forms Link

                        <input
                            id="exam-form-url"
                            type="url"
                            placeholder="https://docs.google.com/forms/..."
                            value="${escapeHTML(
                                exam?.formUrl || ""
                            )}"
                            required
                        >
                    </label>

                    <label>
                        Examiner Username

                        <input
                            id="exam-examiner"
                            type="text"
                            value="${escapeHTML(
                                exam?.examinerUsername || ""
                            )}"
                            required
                        >
                    </label>

                    <label>
                        Examiner Password

                        <input
                            id="exam-password"
                            type="text"
                            value="${escapeHTML(
                                exam?.examinerPassword || ""
                            )}"
                        >
                    </label>

                    <label class="checkbox-row">

                        <input
                            id="exam-anticheat"
                            type="checkbox"
                            ${
                                exam?.antiCheat !== false
                                    ? "checked"
                                    : ""
                            }
                        >

                        Enable Anti-Cheat

                    </label>

                    <label>
                        Maximum Violations

                        <input
                            id="exam-max-violations"
                            type="number"
                            min="1"
                            max="20"
                            value="${
                                exam?.maxViolations ||
                                CONFIG.DEFAULT_MAX_VIOLATIONS
                            }"
                        >
                    </label>

                    <label class="checkbox-row">

                        <input
                            id="exam-timer"
                            type="checkbox"
                            ${
                                exam?.timerEnabled !== false
                                    ? "checked"
                                    : ""
                            }
                        >

                        Enable Timer

                    </label>

                    <label>
                        Duration in Minutes

                        <input
                            id="exam-duration"
                            type="number"
                            min="1"
                            value="${
                                exam
                                    ? Math.round(
                                        exam.durationSeconds /
                                        60
                                    )
                                    : 60
                            }"
                        >
                    </label>

                    <label>
                        Availability Start

                        <input
                            id="exam-start"
                            type="datetime-local"
                            value="${toDatetimeLocal(
                                exam?.availabilityStart
                            )}"
                        >
                    </label>

                    <label>
                        Availability End

                        <input
                            id="exam-end"
                            type="datetime-local"
                            value="${toDatetimeLocal(
                                exam?.availabilityEnd
                            )}"
                        >
                    </label>

                    <label>
                        Status

                        <select id="exam-status">

                            <option
                                value="active"
                                ${
                                    exam?.status !==
                                    "inactive"
                                        ? "selected"
                                        : ""
                                }>
                                Active
                            </option>

                            <option
                                value="inactive"
                                ${
                                    exam?.status ===
                                    "inactive"
                                        ? "selected"
                                        : ""
                                }>
                                Inactive
                            </option>

                        </select>

                    </label>

                </div>

                <div class="modal-footer">

                    <button
                        class="btn btn-secondary"
                        data-action="close-modal">
                        Cancel
                    </button>

                    <button
                        class="btn btn-primary"
                        data-action="save-exam">
                        Save Examination
                    </button>

                </div>

            </div>

        </div>
    `;

    modal.hidden = false;
}

function saveExamFromModal() {

    const id =
        $("#exam-id")?.value;

    const title =
        $("#exam-title")?.value.trim();

    const description =
        $("#exam-description")?.value.trim();

    const formUrl =
        $("#exam-form-url")?.value.trim();

    const examinerUsername =
        $("#exam-examiner")?.value.trim();

    const examinerPassword =
        $("#exam-password")?.value;

    const antiCheat =
        $("#exam-anticheat")?.checked;

    const maxViolations =
        Number(
            $("#exam-max-violations")?.value
        ) ||
        CONFIG.DEFAULT_MAX_VIOLATIONS;

    const timerEnabled =
        $("#exam-timer")?.checked;

    const durationMinutes =
        Number(
            $("#exam-duration")?.value
        ) || 60;

    const availabilityStart =
        $("#exam-start")?.value;

    const availabilityEnd =
        $("#exam-end")?.value;

    const status =
        $("#exam-status")?.value ||
        "active";

    if (
        !title ||
        !formUrl ||
        !examinerUsername
    ) {

        alert(
            "Please complete all required fields."
        );

        return;
    }

    if (
        !formUrl.startsWith(
            "https://docs.google.com/"
        ) &&
        !formUrl.startsWith(
            "https://forms.google.com/"
        )
    ) {

        alert(
            "Please enter a valid Google Forms URL."
        );

        return;
    }

    if (
        !id &&
        db.exams.length >=
            CONFIG.MAX_EXAMS_PER_ADMIN
    ) {

        alert(
            `You can only create a maximum of ${CONFIG.MAX_EXAMS_PER_ADMIN} exams.`
        );

        return;
    }

    if (id) {

        const exam =
            db.exams.find(
                item =>
                    item.id === id
            );

        if (!exam) return;

        exam.title =
            title;

        exam.description =
            description;

        exam.formUrl =
            formUrl;

        exam.examinerUsername =
            examinerUsername;

        exam.examinerPassword =
            examinerPassword;

        exam.antiCheat =
            antiCheat;

        exam.maxViolations =
            maxViolations;

        exam.timerEnabled =
            timerEnabled;

        exam.durationSeconds =
            durationMinutes * 60;

        exam.availabilityStart =
            availabilityStart;

        exam.availabilityEnd =
            availabilityEnd;

        exam.status =
            status;

    } else {

        db.exams.push({

            id:
                generateId("exam"),

            title,
            description,
            formUrl,

            examinerUsername,
            examinerPassword,

            antiCheat,
            maxViolations,

            timerEnabled,

            durationSeconds:
                durationMinutes * 60,

            availabilityStart,
            availabilityEnd,

            status,

            createdAt:
                nowISO()
        });
    }

    saveDatabase();

    closeModal();

    renderAdminExams();
}

/* =========================================================
   DELETE EXAM
   ========================================================= */

function deleteExam(examId) {

    const exam =
        db.exams.find(
            item =>
                item.id === examId
        );

    if (!exam) return;

    const confirmed =
        confirm(
            `Delete "${exam.title}"?`
        );

    if (!confirmed) return;

    db.exams =
        db.exams.filter(
            item =>
                item.id !== examId
        );

    saveDatabase();

    renderAdminExams();
}

/* =========================================================
   CLOSE MODAL
   ========================================================= */

function closeModal() {

    const modal =
        $("#modal-root");

    if (!modal) return;

    modal.hidden = true;

    modal.innerHTML = "";
}

/* =========================================================
   EXAMINER DASHBOARD
   ========================================================= */

function renderExaminerDashboard() {

    const container =
        $("#examiner-exams");

    if (!container ||
        !currentUser) {

        return;
    }

    const assignedExams =
        db.exams.filter(
            exam =>
                exam.examinerUsername
                    .toLowerCase() ===
                currentUser.username
                    .toLowerCase()
        );

    if (!assignedExams.length) {

        container.innerHTML = `
            <div class="empty-state">
                No exams are assigned to your account.
            </div>
        `;

        return;
    }

    container.innerHTML =
        assignedExams.map(
            exam => {

                const attempt =
                    getLatestAttempt(
                        exam.id
                    );

                const available =
                    isExamAvailable(
                        exam
                    );

                const completed =
                    hasCompletedAttempt(
                        exam.id
                    );

                let buttonText =
                    "Start Exam";

                let disabled = false;

                if (completed) {

                    buttonText =
                        "Already Taken";

                    disabled = true;

                } else if (!available) {

                    buttonText =
                        "Not Available";

                    disabled = true;

                } else if (
                    attempt &&
                    attempt.status ===
                        "In Progress"
                ) {

                    buttonText =
                        "Exam In Progress";

                    disabled = true;
                }

                return `
                    <div class="exam-card">

                        <div class="exam-card-body">

                            <h3>
                                ${escapeHTML(
                                    exam.title
                                )}
                            </h3>

                            <p>
                                ${escapeHTML(
                                    exam.description ||
                                    "No description available."
                                )}
                            </p>

                            <div class="exam-card-meta">

                                <span>
                                    ${
                                        exam.timerEnabled
                                            ? `Timer: ${formatDuration(
                                                exam.durationSeconds
                                            )}`
                                            : "No Timer"
                                    }
                                </span>

                                <span>
                                    ${
                                        exam.antiCheat
                                            ? "Anti-Cheat Enabled"
                                            : "Anti-Cheat Disabled"
                                    }
                                </span>

                            </div>

                        </div>

                        <div class="exam-card-footer">

                            <button
                                class="btn btn-primary"
                                ${
                                    disabled
                                        ? "disabled"
                                        : ""
                                }
                                data-action="start-exam"
                                data-exam-id="${exam.id}">
                                ${buttonText}
                            </button>

                        </div>

                    </div>
                `;
            }
        ).join("");
}

/* =========================================================
   EXAM AVAILABILITY
   ========================================================= */

function isExamAvailable(exam) {

    if (!exam) return false;

    if (exam.status !== "active") {
        return false;
    }

    const now =
        new Date();

    if (exam.availabilityStart) {

        const start =
            new Date(
                exam.availabilityStart
            );

        if (
            !Number.isNaN(
                start.getTime()
            ) &&
            now < start
        ) {

            return false;
        }
    }

    if (exam.availabilityEnd) {

        const end =
            new Date(
                exam.availabilityEnd
            );

        if (
            !Number.isNaN(
                end.getTime()
            ) &&
            now > end
        ) {

            return false;
        }
    }

    return true;
}

/* =========================================================
   ATTEMPTS
   ========================================================= */

function getUserAttempts(examId) {

    if (!currentUser) {
        return [];
    }

    return db.attempts.filter(
        attempt =>
            attempt.examId === examId &&
            attempt.userId === currentUser.id
    );
}

function getLatestAttempt(examId) {

    const attempts =
        getUserAttempts(
            examId
        );

    if (!attempts.length) {
        return null;
    }

    return [...attempts].sort(
        (a, b) =>
            new Date(b.startedAt) -
            new Date(a.startedAt)
    )[0];
}

function hasCompletedAttempt(examId) {

    return getUserAttempts(
        examId
    ).some(
        attempt =>
            attempt.status ===
                "Completed" ||
            attempt.status ===
                "Time Expired" ||
            attempt.status ===
                "Terminated"
    );
}

/* =========================================================
   START EXAM
   ========================================================= */

function startExam(examId) {

    if (!currentUser) {
        return;
    }

    const exam =
        db.exams.find(
            item =>
                item.id === examId
        );

    if (!exam) {

        alert(
            "Exam not found."
        );

        return;
    }

    if (!isExamAvailable(exam)) {

        alert(
            "This exam is currently unavailable."
        );

        return;
    }

    if (hasCompletedAttempt(exam.id)) {

        alert(
            "You have already taken this examination."
        );

        return;
    }

    const existingAttempt =
        getLatestAttempt(
            exam.id
        );

    if (
        existingAttempt &&
        existingAttempt.status ===
            "In Progress"
    ) {

        alert(
            "You already have an active attempt for this examination."
        );

        return;
    }

    currentExam =
        exam;

    showExamInstructions(
        exam
    );
}

/* =========================================================
   EXAM INSTRUCTIONS
   ========================================================= */

function showExamInstructions(exam) {

    const modal =
        $("#modal-root");

    if (!modal) return;

    modal.innerHTML = `

        <div class="modal-backdrop">

            <div class="modal">

                <div class="modal-header">

                    <h2>
                        ${escapeHTML(
                            exam.title
                        )}
                    </h2>

                </div>

                <div class="modal-body">

                    <p>
                        ${escapeHTML(
                            exam.description ||
                            "Please read the instructions before starting."
                        )}
                    </p>

                    <hr>

                    <h4>
                        Examination Rules
                    </h4>

                    <ul>

                        <li>
                            Do not leave the examination page.
                        </li>

                        <li>
                            Do not switch browser tabs during the exam.
                        </li>

                        <li>
                            Keep the examination window active.
                        </li>

                        ${
                            exam.antiCheat
                                ? `
                                    <li>
                                        Anti-cheat monitoring is enabled.
                                    </li>
                                `
                                : ""
                        }

                        ${
                            exam.timerEnabled
                                ? `
                                    <li>
                                        Time limit:
                                        <strong>
                                            ${formatDuration(
                                                exam.durationSeconds
                                            )}
                                        </strong>
                                    </li>
                                `
                                : ""
                        }

                    </ul>

                </div>

                <div class="modal-footer">

                    <button
                        class="btn btn-secondary"
                        data-action="close-modal">
                        Cancel
                    </button>

                    <button
                        class="btn btn-primary"
                        id="confirm-start-exam">
                        Start Examination
                    </button>

                </div>

            </div>

        </div>
    `;

    modal.hidden = false;

    $("#confirm-start-exam")
        ?.addEventListener(
            "click",
            () => {

                closeModal();

                beginExam(exam);
            }
        );
}

/* =========================================================
   BEGIN EXAM
   ========================================================= */

function beginExam(exam) {

    if (!currentUser ||
        !exam) {

        return;
    }

    /*
     * Clear previous monitoring.
     */

    stopExamMonitoring();

    stopExamTimer();

    const attempt = {

        id:
            generateId("attempt"),

        examId:
            exam.id,

        examTitle:
            exam.title,

        userId:
            currentUser.id,

        username:
            currentUser.username,

        startedAt:
            nowISO(),

        submittedAt:
            null,

        status:
            "In Progress",

        violations:
            0
    };

    db.attempts.push(
        attempt
    );

    saveDatabase();

    currentExam =
        exam;

    examState = {

        active:
            true,

        attemptId:
            attempt.id,

        examId:
            exam.id,

        antiCheat:
            Boolean(
                exam.antiCheat
            ),

        maxViolations:
            Number(
                exam.maxViolations
            ) ||
            CONFIG.DEFAULT_MAX_VIOLATIONS,

        timerEnabled:
            Boolean(
                exam.timerEnabled
            ),

        durationSeconds:
            Number(
                exam.durationSeconds
            ) ||
            CONFIG.DEFAULT_EXAM_DURATION,

        remainingSeconds:
            Number(
                exam.durationSeconds
            ) ||
            CONFIG.DEFAULT_EXAM_DURATION,

        violations:
            0,

        startedAt:
            Date.now(),

        lastViolationAt:
            0,

        timerInterval:
            null
    };

    showExamView();

    renderExamHeader(
        exam
    );

    loadGoogleForm(
        exam.formUrl
    );

    /*
     * ANTI-CHEAT STARTS ONLY HERE.
     */

    if (examState.antiCheat) {

        startExamMonitoring();
    }

    /*
     * TIMER STARTS ONLY HERE.
     */

    if (examState.timerEnabled) {

        startExamTimer();
    }

    updateExamProgress();

    syncViolationOverlay();
}

/* =========================================================
   EXAM HEADER
   ========================================================= */

function renderExamHeader(exam) {

    setText(
        "exam-title-display",
        exam.title
    );

    setText(
        "exam-timer",
        exam.timerEnabled
            ? formatDuration(
                exam.durationSeconds
            )
            : "No Timer"
    );

    setText(
        "exam-violations",
        `0 / ${exam.maxViolations}`
    );

    const progress =
        $("#exam-progress");

    if (progress) {

        progress.style.width =
            "0%";
    }
}

/* =========================================================
   GOOGLE FORM
   ========================================================= */

function loadGoogleForm(url) {

    const iframe =
        $("#exam-form-frame");

    if (!iframe) return;

    iframe.src =
        url;
}

/* =========================================================
   TIMER
   ========================================================= */

function startExamTimer() {

    stopExamTimer();

    if (!examState?.active) {
        return;
    }

    if (!examState.timerEnabled) {
        return;
    }

    examState.timerInterval =
        setInterval(
            () => {

                if (!examState?.active) {

                    stopExamTimer();

                    return;
                }

                examState.remainingSeconds--;

                if (
                    examState.remainingSeconds <=
                    0
                ) {

                    examState.remainingSeconds =
                        0;

                    renderTimer();

                    stopExamTimer();

                    finishExam(
                        "Time Expired",
                        "The examination time has expired."
                    );

                    return;
                }

                renderTimer();

            },
            1000
        );

    renderTimer();
}

function stopExamTimer() {

    if (
        examState?.timerInterval
    ) {

        clearInterval(
            examState.timerInterval
        );

        examState.timerInterval =
            null;
    }
}

function renderTimer() {

    if (!examState?.active) {
        return;
    }

    const timer =
        $("#exam-timer");

    if (timer) {

        timer.textContent =
            formatDuration(
                examState.remainingSeconds
            );
    }

    updateExamProgress();
}

/* =========================================================
   PROGRESS
   ========================================================= */

function updateExamProgress() {

    if (!examState?.active) {
        return;
    }

    const progress =
        $("#exam-progress");

    if (!progress) return;

    if (!examState.timerEnabled) {

        progress.style.width =
            "0%";

        return;
    }

    const total =
        Math.max(
            1,
            examState.durationSeconds
        );

    const remaining =
        Math.max(
            0,
            examState.remainingSeconds
        );

    const elapsedPercent =
        (
            (total - remaining) /
            total
        ) * 100;

    progress.style.width =
        `${Math.min(
            100,
            elapsedPercent
        )}%`;
}

/* =========================================================
   ANTI-CHEAT MONITORING
   ========================================================= */

function startExamMonitoring() {

    /*
     * Always remove old listeners first.
     */

    stopExamMonitoring();

    /*
     * HARD SAFETY CHECK.
     */

    if (!examState?.active) {
        return;
    }

    if (!examState.antiCheat) {
        return;
    }

    document.addEventListener(
        "visibilitychange",
        handleVisibilityChange
    );

    window.addEventListener(
        "blur",
        handleWindowBlur
    );

    window.addEventListener(
        "focus",
        handleWindowFocus
    );

    document.addEventListener(
        "fullscreenchange",
        handleFullscreenChange
    );

    document.addEventListener(
        "keydown",
        handleAntiCheatKeyboard
    );

    document.addEventListener(
        "contextmenu",
        preventContextMenu
    );

    document.addEventListener(
        "copy",
        preventClipboard
    );

    document.addEventListener(
        "cut",
        preventClipboard
    );

    document.addEventListener(
        "paste",
        preventClipboard
    );

    document.addEventListener(
        "selectstart",
        preventSelection
    );

    window.addEventListener(
        "beforeunload",
        handleBeforeUnload
    );
}

function stopExamMonitoring() {

    if (focusTimer) {

        clearTimeout(
            focusTimer
        );

        focusTimer = null;
    }

    document.removeEventListener(
        "visibilitychange",
        handleVisibilityChange
    );

    window.removeEventListener(
        "blur",
        handleWindowBlur
    );

    window.removeEventListener(
        "focus",
        handleWindowFocus
    );

    document.removeEventListener(
        "fullscreenchange",
        handleFullscreenChange
    );

    document.removeEventListener(
        "keydown",
        handleAntiCheatKeyboard
    );

    document.removeEventListener(
        "contextmenu",
        preventContextMenu
    );

    document.removeEventListener(
        "copy",
        preventClipboard
    );

    document.removeEventListener(
        "cut",
        preventClipboard
    );

    document.removeEventListener(
        "paste",
        preventClipboard
    );

    document.removeEventListener(
        "selectstart",
        preventSelection
    );

    window.removeEventListener(
        "beforeunload",
        handleBeforeUnload
    );

    hideViolationOverlay();
}

/* =========================================================
   TAB SWITCHING
   ========================================================= */

function handleVisibilityChange() {

    /*
     * VIOLATION DETECTION ONLY DURING EXAM.
     */

    if (!examState?.active) {
        return;
    }

    if (!examState.antiCheat) {
        return;
    }

    if (document.hidden) {

        registerViolation(
            "Browser tab or window was left."
        );
    }
}

/* =========================================================
   WINDOW FOCUS
   ========================================================= */

function handleWindowBlur() {

    if (!examState?.active) {
        return;
    }

    if (!examState.antiCheat) {
        return;
    }

    if (focusTimer) {

        clearTimeout(
            focusTimer
        );
    }

    focusTimer =
        setTimeout(
            () => {

                if (!examState?.active) {
                    return;
                }

                if (!examState.antiCheat) {
                    return;
                }

                if (!document.hasFocus()) {

                    registerViolation(
                        "Examination window lost focus."
                    );
                }

            },
            CONFIG.GRACE_PERIOD_MS
        );
}

function handleWindowFocus() {

    if (focusTimer) {

        clearTimeout(
            focusTimer
        );

        focusTimer = null;
    }
}

/* =========================================================
   FULLSCREEN
   ========================================================= */

function handleFullscreenChange() {

    if (!examState?.active) {
        return;
    }

    if (!examState.antiCheat) {
        return;
    }

    if (!document.fullscreenElement) {

        registerViolation(
            "Fullscreen mode was exited."
        );
    }
}

/* =========================================================
   KEYBOARD
   ========================================================= */

function handleAntiCheatKeyboard(event) {

    if (!examState?.active) {
        return;
    }

    if (!examState.antiCheat) {
        return;
    }

    const key =
        event.key.toLowerCase();

    const blocked =
        event.key === "F12" ||

        (
            event.ctrlKey &&
            event.shiftKey &&
            key === "i"
        ) ||

        (
            event.ctrlKey &&
            event.shiftKey &&
            key === "j"
        ) ||

        (
            event.ctrlKey &&
            event.shiftKey &&
            key === "c"
        ) ||

        (
            event.ctrlKey &&
            key === "u"
        ) ||

        (
            event.ctrlKey &&
            key === "s"
        ) ||

        (
            event.ctrlKey &&
            key === "p"
        );

    if (blocked) {

        event.preventDefault();

        registerViolation(
            "Restricted keyboard shortcut detected."
        );
    }
}

/* =========================================================
   CONTEXT MENU / CLIPBOARD
   ========================================================= */

function preventContextMenu(event) {

    if (!examState?.active) {
        return;
    }

    if (!examState.antiCheat) {
        return;
    }

    event.preventDefault();
}

function preventClipboard(event) {

    if (!examState?.active) {
        return;
    }

    if (!examState.antiCheat) {
        return;
    }

    event.preventDefault();
}

function preventSelection(event) {

    if (!examState?.active) {
        return;
    }

    if (!examState.antiCheat) {
        return;
    }

    event.preventDefault();
}

/* =========================================================
   BEFORE UNLOAD
   ========================================================= */

function handleBeforeUnload(event) {

    if (!examState?.active) {
        return;
    }

    if (!examState.antiCheat) {
        return;
    }

    event.preventDefault();

    event.returnValue =
        "Your examination is still in progress.";
}

/* =========================================================
   REGISTER VIOLATION
   ========================================================= */

function registerViolation(reason) {

    /*
     * CRITICAL SAFETY CHECK #1
     *
     * No active exam = no violation.
     */

    if (!examState?.active) {
        return;
    }

    /*
     * CRITICAL SAFETY CHECK #2
     *
     * Anti-cheat disabled = no violation.
     */

    if (!examState.antiCheat) {
        return;
    }

    /*
     * Prevent duplicate violations caused by
     * multiple browser events firing together.
     */

    const now =
        Date.now();

    if (
        examState.lastViolationAt &&
        now -
            examState.lastViolationAt <
            1000
    ) {

        return;
    }

    examState.lastViolationAt =
        now;

    examState.violations++;

    const attempt =
        db.attempts.find(
            item =>
                item.id ===
                examState.attemptId
        );

    if (attempt) {

        attempt.violations =
            examState.violations;
    }

    const violation = {

        id:
            generateId(
                "violation"
            ),

        attemptId:
            examState.attemptId,

        examId:
            examState.examId,

        examTitle:
            currentExam?.title || "",

        userId:
            currentUser?.id || "",

        username:
            currentUser?.username || "",

        violationNumber:
            examState.violations,

        reason,

        timestamp:
            nowISO()
    };

    db.violations.push(
        violation
    );

    saveDatabase();

    updateViolationDisplay();

    showViolationOverlay(
        reason
    );

    /*
     * Automatic termination.
     */

    if (
        examState.violations >=
        examState.maxViolations
    ) {

        finishExam(
            "Terminated",
            "The maximum number of violations has been reached."
        );
    }
}

/* =========================================================
   VIOLATION COUNTER
   ========================================================= */

function updateViolationDisplay() {

    if (!examState?.active) {
        return;
    }

    const counter =
        $("#exam-violations");

    if (counter) {

        counter.textContent =
            `${examState.violations} / ${examState.maxViolations}`;
    }
}

/* =========================================================
   VIOLATION OVERLAY
   ========================================================= */

function showViolationOverlay(reason) {

    /*
     * CRITICAL:
     *
     * The modal is allowed ONLY when:
     *
     * 1. An exam is active
     * 2. Anti-cheat is enabled
     */

    if (!examState?.active) {
        return;
    }

    if (!examState.antiCheat) {
        return;
    }

    const overlay =
        $("#violation-overlay");

    if (!overlay) {
        return;
    }

    const reasonElement =
        $("#violation-reason");

    const countElement =
        $("#violation-count");

    if (reasonElement) {

        reasonElement.textContent =
            reason;
    }

    if (countElement) {

        countElement.textContent =
            `${examState.violations} / ${examState.maxViolations}`;
    }

    violationOverlayOpen =
        true;

    overlay.hidden =
        false;
}

function hideViolationOverlay() {

    violationOverlayOpen =
        false;

    const overlay =
        $("#violation-overlay");

    if (overlay) {

        overlay.hidden =
            true;
    }
}

/* =========================================================
   VIOLATION OVERLAY SAFETY
   ========================================================= */

function syncViolationOverlay() {

    const overlay =
        $("#violation-overlay");

    if (!overlay) {
        return;
    }

    /*
     * The violation modal MUST be hidden
     * outside an active proctored exam.
     */

    if (
        !examState?.active ||
        !examState?.antiCheat
    ) {

        violationOverlayOpen =
            false;

        overlay.hidden =
            true;
    }
}

/* =========================================================
   SUBMIT EXAM
   ========================================================= */

function submitCurrentExam() {

    if (!examState?.active) {
        return;
    }

    const confirmed =
        confirm(
            "Are you sure you want to submit your examination?"
        );

    if (!confirmed) {
        return;
    }

    finishExam(
        "Completed",
        "Thank you for taking the exam!"
    );
}

/* =========================================================
   FINISH EXAM
   ========================================================= */

function finishExam(
    status,
    message
) {

    if (!examState?.active) {
        return;
    }

    const attempt =
        db.attempts.find(
            item =>
                item.id ===
                examState.attemptId
        );

    if (attempt) {

        attempt.status =
            status;

        attempt.submittedAt =
            nowISO();

        attempt.violations =
            examState.violations;
    }

    saveDatabase();

    /*
     * STOP ANTI-CHEAT FIRST.
     */

    stopExamMonitoring();

    stopExamTimer();

    /*
     * Mark exam inactive.
     */

    examState.active =
        false;

    hideViolationOverlay();

    const finishedExam =
        currentExam;

    const violationCount =
        examState.violations;

    currentExam =
        null;

    showResultView(
        status,
        message,
        finishedExam,
        violationCount
    );

    syncViolationOverlay();
}

/* =========================================================
   RESULT VIEW
   ========================================================= */

function showResultView(
    status,
    message,
    exam,
    violationCount = 0
) {

    hideAllViews();

    const resultView =
        $("#result-view");

    if (!resultView) {
        return;
    }

    resultView.hidden =
        false;

    resultView.classList.add(
        "active"
    );

    setText(
        "result-title",
        status === "Completed"
            ? "Exam Submitted"
            : status
    );

    setText(
        "result-message",
        message
    );

    setText(
        "result-exam-name",
        exam?.title || ""
    );

    setText(
        "result-violation-count",
        violationCount
    );

    const returnButton =
        $("#return-dashboard");

    if (returnButton) {

        returnButton.onclick =
            () => {

                if (
                    currentUser?.role ===
                    "admin"
                ) {

                    showAdminDashboard();

                } else {

                    showExaminerDashboard();
                }
            };
    }

    syncViolationOverlay();
}

/* =========================================================
   SUBMISSIONS
   ========================================================= */

function renderSubmissions() {

    const container =
        $("#submissions-table-body");

    if (!container) {
        return;
    }

    if (!db.attempts.length) {

        container.innerHTML = `
            <tr>
                <td colspan="7">
                    No submissions found.
                </td>
            </tr>
        `;

        return;
    }

    const attempts =
        [...db.attempts].sort(
            (a, b) =>
                new Date(b.startedAt) -
                new Date(a.startedAt)
        );

    container.innerHTML =
        attempts.map(
            attempt => `
                <tr>

                    <td>
                        ${escapeHTML(
                            attempt.examTitle
                        )}
                    </td>

                    <td>
                        ${escapeHTML(
                            attempt.username
                        )}
                    </td>

                    <td>
                        ${escapeHTML(
                            attempt.status
                        )}
                    </td>

                    <td>
                        ${attempt.violations}
                    </td>

                    <td>
                        ${formatDate(
                            attempt.startedAt
                        )}
                    </td>

                    <td>
                        ${
                            attempt.submittedAt
                                ? formatDate(
                                    attempt.submittedAt
                                )
                                : "—"
                        }
                    </td>

                </tr>
            `
        ).join("");
}

/* =========================================================
   VIOLATION LOGS
   ========================================================= */

function renderViolationLogs() {

    const container =
        $("#violations-table-body");

    if (!container) {
        return;
    }

    if (!db.violations.length) {

        container.innerHTML = `
            <tr>
                <td colspan="6">
                    No violations recorded.
                </td>
            </tr>
        `;

        return;
    }

    const violations =
        [...db.violations].sort(
            (a, b) =>
                new Date(b.timestamp) -
                new Date(a.timestamp)
        );

    container.innerHTML =
        violations.map(
            violation => `
                <tr>

                    <td>
                        ${escapeHTML(
                            violation.examTitle
                        )}
                    </td>

                    <td>
                        ${escapeHTML(
                            violation.username
                        )}
                    </td>

                    <td>
                        ${violation.violationNumber}
                    </td>

                    <td>
                        ${escapeHTML(
                            violation.reason
                        )}
                    </td>

                    <td>
                        ${formatDate(
                            violation.timestamp
                        )}
                    </td>

                </tr>
            `
        ).join("");
}

/* =========================================================
   ANALYTICS
   ========================================================= */

function renderAnalytics() {

    const total =
        db.attempts.length;

    const completed =
        db.attempts.filter(
            attempt =>
                attempt.status ===
                "Completed"
        ).length;

    const terminated =
        db.attempts.filter(
            attempt =>
                attempt.status ===
                "Terminated"
        ).length;

    const expired =
        db.attempts.filter(
            attempt =>
                attempt.status ===
                "Time Expired"
        ).length;

    const inProgress =
        db.attempts.filter(
            attempt =>
                attempt.status ===
                "In Progress"
        ).length;

    setText(
        "analytics-total",
        total
    );

    setText(
        "analytics-completed",
        completed
    );

    setText(
        "analytics-terminated",
        terminated
    );

    setText(
        "analytics-expired",
        expired
    );

    setText(
        "analytics-in-progress",
        inProgress
    );
}

/* =========================================================
   SETTINGS
   ========================================================= */

function renderSettings() {

    setText(
        "settings-exam-limit",
        CONFIG.MAX_EXAMS_PER_ADMIN
    );

    setText(
        "settings-user-count",
        db.users.length
    );

    setText(
        "settings-exam-count",
        db.exams.length
    );
}

/* =========================================================
   THEME
   ========================================================= */

function setupTheme() {

    const savedTheme =
        localStorage.getItem(
            THEME_KEY
        );

    if (savedTheme === "dark") {

        document.body.classList.add(
            "dark"
        );
    }

    updateThemeButton();
}

function toggleTheme() {

    document.body.classList.toggle(
        "dark"
    );

    const dark =
        document.body.classList.contains(
            "dark"
        );

    localStorage.setItem(
        THEME_KEY,
        dark
            ? "dark"
            : "light"
    );

    updateThemeButton();
}

function updateThemeButton() {

    const dark =
        document.body.classList.contains(
            "dark"
        );

    $$("[data-action='toggle-theme']")
        .forEach(button => {

            button.textContent =
                dark
                    ? "☀️"
                    : "🌙";
        });
}

/* =========================================================
   RESET DEMO DATA
   ========================================================= */

function resetDemoData() {

    const confirmed =
        confirm(
            "Reset all demo data? This will delete exams, submissions and violation logs."
        );

    if (!confirmed) {
        return;
    }

    stopExamMonitoring();

    stopExamTimer();

    localStorage.setItem(
        DB_KEY,
        JSON.stringify(
            DEFAULT_DB
        )
    );

    db =
        structuredClone(
            DEFAULT_DB
        );

    examState =
        null;

    currentExam =
        null;

    alert(
        "Demo data has been reset."
    );

    if (
        currentUser?.role ===
        "admin"
    ) {

        showAdminDashboard();

    } else {

        showExaminerDashboard();
    }
}

/* =========================================================
   DATETIME
   ========================================================= */

function toDatetimeLocal(value) {

    if (!value) {
        return "";
    }

    const date =
        new Date(value);

    if (
        Number.isNaN(
            date.getTime()
        )
    ) {

        return "";
    }

    const offset =
        date.getTimezoneOffset();

    const local =
        new Date(
            date.getTime() -
            offset * 60000
        );

    return local
        .toISOString()
        .slice(0, 16);
}

/* =========================================================
   SECURITY LIMITATION
   ========================================================= */

/*
 * This application runs inside the browser.
 *
 * Browser JavaScript cannot guarantee:
 *
 * - Blocking every new browser window.
 * - Blocking another device.
 * - Detecting every possible developer-tools method.
 * - Reading the Submit button inside a cross-origin
 *   Google Form.
 *
 * The anti-cheat system therefore detects common:
 *
 * - Tab switching
 * - Window focus loss
 * - Fullscreen exits
 * - Restricted keyboard shortcuts
 * - Copy
 * - Cut
 * - Paste
 * - Context menu
 * - Text selection
 *
 * ONLY while an examination is actively running.
 *
 * For production deployment, use a server-side backend
 * for authentication, attempts, exam state and submission
 * validation.
 */

/* =========================================================
   FINAL SAFETY CHECK
   ========================================================= */

syncViolationOverlay();
