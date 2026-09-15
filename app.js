/* Secure Exam Portal - frontend prototype
   Builds on the original client-side proctoring approach. Because this is a
   browser-only app, authentication, passwords, attempt locks and logs are
   stored in localStorage and are NOT secure enough for production. A real
   deployment should move auth, exam data, attempts and violation records to
   a server/database. Google Forms remain cross-origin, so this app cannot
   detect the actual Google Forms Submit click; the portal Submit button is
   the auditable end-of-session signal.
*/
(() => {
'use strict';

const KEY='secure_exam_portal_v2';
const SESSION='secure_exam_session_v2';
const DEFAULT_FORM='https://docs.google.com/forms/d/e/1FAIpQLSf_PLACEHOLDER_FORM_ID/viewform?embedded=true';

const seed={
 users:[
  {id:'u-admin',username:'admin',password:'123admin',role:'admin',name:'Administrator'},
  {id:'u-test',username:'test',password:'test',role:'examiner',name:'Test Examiner'}
 ],
 exams:[
  {
   id:'exam-demo',
   title:'Demo Examination',
   description:'Replace this Google Form with your actual examination link.',
   formUrl:DEFAULT_FORM,
   examinerUsername:'test',
   examinerPassword:'test',
   antiCheat:true,
   maxViolations:3,
   timerEnabled:true,
   durationMinutes:60,
   startAt:'',
   endAt:'',
   active:true,
   createdAt:Date.now(),
   createdBy:'u-admin'
  }
 ],
 attempts:[],
 violations:[],
 theme:'dark'
};

let db=loadDB();
let session=loadSession();
let currentExam=null;
let timer=null;
let examState=null;
let violationOverlayOpen=false;
let graceUntil=0;
let lastViolation=0;

const DEBOUNCE=650, GRACE=1500;

const $=s=>document.querySelector(s);
const $$=s=>[...document.querySelectorAll(s)];

const views={
 login:$('#login-view'),
 admin:$('#admin-view'),
 examiner:$('#examiner-view'),
 exam:$('#exam-view'),
 result:$('#result-view')
};

function clone(x){
 return JSON.parse(JSON.stringify(x));
}

function safeGet(storage,key){
 try{
  return storage.getItem(key);
 }catch(e){
  console.warn('Storage read failed:',e);
  return null;
 }
}

function safeSet(storage,key,value){
 try{
  storage.setItem(key,value);
  return true;
 }catch(e){
  console.warn('Storage write failed:',e);
  return false;
 }
}

function safeRemove(storage,key){
 try{
  storage.removeItem(key);
 }catch(e){
  console.warn('Storage remove failed:',e);
 }
}

function loadDB(){
 let x={};

 try{
  const raw=safeGet(localStorage,KEY);

  if(raw){
   try{
    x=JSON.parse(raw)||{};
   }catch(e){
    x={};
   }
  }
 }catch(e){
  x={};
 }

 const users=Array.isArray(x.users)?x.users:[];

 seed.users.forEach(su=>{
  const existing=users.find(
   u=>String(u?.username||'').trim().toLowerCase()===su.username.toLowerCase()
  );

  if(!existing){
   users.push(clone(su));
  }else if(su.username==='admin'||su.username==='test'){
   existing.username=su.username;
   existing.password=su.password;
   existing.role=su.role;
   existing.name=su.name;
  }
 });

 const repaired={
  ...clone(seed),
  ...x,
  users,
  exams:Array.isArray(x.exams)&&x.exams.length?x.exams:clone(seed.exams),
  attempts:Array.isArray(x.attempts)?x.attempts:[],
  violations:Array.isArray(x.violations)?x.violations:[],
  theme:x.theme==='light'?'light':'dark'
 };

 // Always keep a valid demo exam available.
 if(!Array.isArray(repaired.exams)||!repaired.exams.length){
  repaired.exams=clone(seed.exams);
 }

 // Repair examiner accounts for exams created before account synchronization
 // was added. Every assigned examiner must have a matching portal login.
 repaired.exams.forEach(exam=>{
  const username=String(exam.examinerUsername||'').trim();

  if(!username)return;

  const normalized=username.toLowerCase();

  let account=repaired.users.find(
   u=>String(u.username||'').trim().toLowerCase()===normalized
  );

  if(!account){
   account={
    id:uid('user'),
    username,
    password:String(exam.examinerPassword||''),
    role:'examiner',
    name:username
   };

   repaired.users.push(account);
  }else if(account.role!=='admin'){
   account.username=username;
   account.password=String(exam.examinerPassword||account.password||'');
   account.role='examiner';

   if(!account.name)account.name=username;
  }
 });

 safeSet(localStorage,KEY,JSON.stringify(repaired));

 return repaired;
}

function saveDB(){
 safeSet(localStorage,KEY,JSON.stringify(db));
}

function loadSession(){
 try{
  return JSON.parse(safeGet(sessionStorage,SESSION)||'null');
 }catch(e){
  return null;
 }
}

function saveSession(){
 if(session){
  safeSet(sessionStorage,SESSION,JSON.stringify(session));
 }else{
  safeRemove(sessionStorage,SESSION);
 }
}

function uid(prefix='id'){
 return prefix+'-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8);
}

function esc(v=''){
 return String(v).replace(
  /[&<>'"]/g,
  c=>({
   '&':'&amp;',
   '<':'&lt;',
   '>':'&gt;',
   "'":'&#39;',
   '"':'&quot;'
  }[c])
 );
}

function fmtDate(ts){
 return ts
  ?new Date(ts).toLocaleString([],{
    year:'numeric',
    month:'short',
    day:'numeric',
    hour:'2-digit',
    minute:'2-digit'
   })
  :'—';
}

function fmtTime(ts){
 return ts
  ?new Date(ts).toLocaleTimeString([],{
    hour:'2-digit',
    minute:'2-digit'
   })
  :'—';
}

function showView(name){
 Object.values(views).forEach(v=>v.hidden=true);
 views[name].hidden=false;
 window.scrollTo(0,0);
}

function toast(msg,type=''){
 const d=document.createElement('div');

 d.className='toast '+type;
 d.textContent=msg;

 $('#toast-container').appendChild(d);

 setTimeout(()=>d.remove(),3000);
}

function applyTheme(){
 const light=db.theme==='light';

 document.documentElement.dataset.theme=light?'light':'dark';

 document.body.classList.toggle('light',light);
 document.body.classList.toggle('dark',!light);

 [
  'theme-toggle-login',
  'theme-toggle-admin',
  'theme-toggle-examiner'
 ].forEach(id=>{
  const b=$('#'+id);

  if(b){
   b.textContent=light?'☾':'☼';
   b.setAttribute(
    'aria-label',
    light?'Switch to dark mode':'Switch to light mode'
   );
   b.title=light?'Switch to dark mode':'Switch to light mode';
  }
 });
}

function toggleTheme(){
 db.theme=db.theme==='light'?'dark':'light';

 saveDB();
 applyTheme();
}

/* AUTH */

function showLoginError(message){
 const err=$('#login-error');

 if(!err)return;

 err.textContent=message;
 err.hidden=false;
 err.style.display='block';
}

function clearLoginError(){
 const err=$('#login-error');

 if(!err)return;

 err.textContent='';
 err.hidden=true;
 err.style.display='none';
}

function handleLogin(e){
 if(e)e.preventDefault();

 clearLoginError();

 const usernameEl=$('#login-username');
 const passwordEl=$('#login-password');
 const form=$('#login-form');

 if(!usernameEl||!passwordEl){
  showLoginError('Login form could not be loaded. Please refresh the page.');
  return false;
 }

 const username=String(usernameEl.value||'').trim();
 const password=String(passwordEl.value||'');

 if(!username||!password){
  showLoginError('Please enter both your username and password.');

  (!username?usernameEl:passwordEl).focus();

  return false;
 }

 // Refresh the saved database before checking credentials.
 db=loadDB();

 // Built-in credentials are also checked directly as a final fallback.
 const fallback={
  admin:{
   password:'123admin',
   role:'admin',
   name:'Administrator',
   id:'u-admin'
  },
  test:{
   password:'test',
   role:'examiner',
   name:'Test Examiner',
   id:'u-test'
  }
 };

 const key=username.toLowerCase();

 let user=db.users.find(u=>
  String(u?.username||'').trim().toLowerCase()===key &&
  String(u?.password??'')===password
 );

 if(!user&&fallback[key]&&fallback[key].password===password){
  user={
   id:fallback[key].id,
   username:key,
   password:password,
   role:fallback[key].role,
   name:fallback[key].name
  };

  if(!db.users.some(u=>u.id===user.id)){
   db.users.push(clone(user));
  }

  saveDB();
 }

 if(!user){
  showLoginError(
   'Incorrect username or password. Please check your credentials and try again.'
  );

  passwordEl.value='';
  passwordEl.focus();

  if(form){
   form.classList.remove('login-error-shake');
   void form.offsetWidth;
   form.classList.add('login-error-shake');
  }

  return false;
 }

 session={
  userId:user.id,
  username:user.username,
  role:user.role,
  loginAt:Date.now()
 };

 saveSession();

 currentExam=null;
 examState=null;
 violationOverlayOpen=false;

 syncViolationOverlay();

 openPortal();

 return false;
}

function initAuthentication(){
 const form=$('#login-form');

 if(!form)return;
 if(form.dataset.authBound==='1')return;

 form.addEventListener('submit',handleLogin);

 form.dataset.authBound='1';
}

function currentUser(){
 if(!session)return null;

 return db.users.find(u=>u.id===session.userId) ||
  db.users.find(
   u=>String(u.username||'').toLowerCase()===
      String(session.username||'').toLowerCase()
  ) ||
  null;
}

function openPortal(){
 const u=currentUser();

 if(!u){
  session=null;
  saveSession();
  showView('login');
  return;
 }

 if(u.role==='admin'){
  openAdmin();
 }else if(u.role==='examiner'){
  openExaminer();
 }else{
  session=null;
  saveSession();
  showView('login');

  showLoginError(
   'This account does not have a valid portal role.'
  );
 }
}

function logout(){
 session=null;
 saveSession();

 currentExam=null;
 examState=null;

 clearInterval(timer);
 timer=null;

 violationOverlayOpen=false;

 document.body.classList.remove('lockdown-active');
 $('#exam-view')?.classList.remove('lockdown-active');

 syncViolationOverlay();

 showView('login');

 $('#login-form')?.reset();

 clearLoginError();
}

function clearBrokenSession(){
 if(session&&!currentUser()){
  session=null;
  saveSession();
 }
}

/* SIDEBAR */

$$('[data-toggle-sidebar]').forEach(
 b=>b.addEventListener(
  'click',
  ()=>$('#'+b.dataset.toggleSidebar)?.classList.toggle('open')
 )
);

$$('[data-admin-page]').forEach(
 b=>b.addEventListener(
  'click',
  ()=>adminPage(b.dataset.adminPage)
 )
);

$$('[data-examiner-page]').forEach(
 b=>b.addEventListener(
  'click',
  ()=>examinerPage(b.dataset.examinerPage)
 )
);

const pageTitles={
 dashboard:'Dashboard',
 exams:'Exam Management',
 submissions:'Submissions',
 violations:'Violation Logs',
 analytics:'Analytics',
 settings:'Settings'
};

function openAdmin(){
 const u=currentUser();

 if(!u){
  showView('login');
  return;
 }

 $('#admin-user-name').textContent=u.name||u.username;
 $('#admin-user-role').textContent='Administrator';
 $('#admin-avatar').textContent=(u.name||u.username)[0].toUpperCase();

 showView('admin');

 adminPage('dashboard');
}

function adminPage(page){
 page=pageTitles[page]?page:'dashboard';

 $$('[data-admin-page]').forEach(
  b=>b.classList.toggle(
   'active',
   b.dataset.adminPage===page
  )
 );

 $$('.admin-page').forEach(
  p=>p.classList.remove('active')
 );

 const target=$('#admin-'+page+'-page');

 if(target){
  target.classList.add('active');
 }

 const title=$('#admin-page-title');

 if(title){
  title.textContent=pageTitles[page]||'Dashboard';
 }

 $('#admin-sidebar')?.classList.remove('open');

 renderAdminPage(page);
}

function renderAdminPage(page){
 ({
  dashboard:renderAdminDashboard,
  exams:renderAdminExams,
  submissions:renderSubmissions,
  violations:renderViolations,
  analytics:renderAnalytics,
  settings:renderSettings
 }[page]||renderAdminDashboard)();
}

function openExaminer(){
 const u=currentUser();

 if(!u){
  showView('login');
  return;
 }

 $('#examiner-user-name').textContent=u.name||u.username;
 $('#examiner-avatar').textContent=(u.name||u.username)[0].toUpperCase();

 showView('examiner');

 renderExaminerDashboard();
}

function examinerPage(){
 renderExaminerDashboard();

 $('#examiner-sidebar')?.classList.remove('open');
}

/* ADMIN DASHBOARD */

function attemptCounts(){
 const a=db.attempts;

 return{
  total:a.length,
  inProgress:a.filter(x=>x.status==='In Progress').length,
  completed:a.filter(x=>x.status==='Completed').length,
  expired:a.filter(x=>x.status==='Time Expired').length,
  terminated:a.filter(x=>x.status==='Terminated').length
 };
}

function renderAdminDashboard(){
 const c=attemptCounts();

 const avg=db.attempts.length
  ?(
    db.attempts.reduce(
     (s,a)=>s+(a.violations||0),
     0
    )/db.attempts.length
   ).toFixed(1)
  :'0.0';

 const total=c.total||1;

 const completion=c.total
  ?Math.round(c.completed/c.total*100)
  :0;

 $('#admin-dashboard-page').innerHTML=`
  <div class="page-head">
   <div>
    <span class="eyebrow">OVERVIEW</span>
    <h3>Exam Dashboard</h3>
    <p>Monitor current activity, completion and security events.</p>
   </div>

   <div class="actions">
    <button class="secondary-btn" data-action="new-exam">
     + Add Exam
    </button>
   </div>
  </div>

  <div class="stat-grid">
   ${stat('Total Sessions',c.total)}
   ${stat('In Progress',c.inProgress)}
   ${stat('Completed',c.completed,'success')}
   ${stat('Time Expired',c.expired,'warning')}
   ${stat('Terminated',c.terminated,'danger')}
   ${stat('Avg. Violations',avg)}
  </div>

  <div class="grid-2">
   <div class="panel">
    <h3>Overall Completion</h3>

    <div class="progress-bar">
     <div class="progress-fill" style="width:${completion}%"></div>
    </div>

    <div class="progress-meta">
     <span>${completion}% completed</span>
     <span>${c.completed} of ${c.total} sessions</span>
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
      <strong>${Math.max(0,6-db.exams.length)}</strong>
      <span>Slots available</span>
     </div>

     <div class="quick-card">
      <strong>${db.users.length}</strong>
      <span>Total users</span>
     </div>
    </div>
   </div>
  </div>

  <div class="panel" style="margin-top:18px">
   <div class="page-head" style="margin-bottom:12px">
    <div>
     <h3>Recent Submissions</h3>
     <p>Latest exam sessions across all examiners.</p>
    </div>

    <button class="secondary-btn" data-action="view-submissions">
     View all
    </button>
   </div>

   ${submissionTable(
    db.attempts
     .slice()
     .sort((a,b)=>(b.startedAt||0)-(a.startedAt||0))
     .slice(0,8)
   )}
  </div>
 `;

 bindActions();
}

function stat(label,value,cls=''){
 return `
  <div class="stat-card ${cls}">
   <span class="stat-label">${label}</span>
   <span class="stat-value">${value}</span>
  </div>
 `;
}

function submissionTable(rows){
 if(!rows.length){
  return '<div class="empty">No exam sessions yet.</div>';
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
     </tr>
    </thead>

    <tbody>
     ${rows.map(a=>`
      <tr>
       <td>${esc(a.username)}</td>
       <td>${esc(a.examTitle)}</td>
       <td>${fmtDate(a.startedAt)}</td>
       <td>${fmtDate(a.endedAt)}</td>
       <td>${badge(a.status)}</td>
       <td>${a.violations||0}</td>
      </tr>
     `).join('')}
    </tbody>
   </table>
  </div>
 `;
}

function badge(status){
 const map={
  'Completed':'green',
  'Time Expired':'yellow',
  'Terminated':'red',
  'In Progress':'blue',
  'Locked':'gray',
  'Available':'green',
  'Unavailable':'gray'
 };

 return `
  <span class="badge ${map[status]||'gray'}">
   ${esc(status)}
  </span>
 `;
}

/* EXAM CRUD */

function renderAdminExams(){
 const slots=6-db.exams.length;

 $('#admin-exams-page').innerHTML=`
  <div class="page-head">
   <div>
    <span class="eyebrow">EXAM MANAGEMENT</span>
    <h3>Exams</h3>
    <p>Create up to 6 exams per admin account. Deleting an exam releases its slot.</p>
    <div class="slot-note">
     ${db.exams.length}/6 slots used
    </div>
   </div>

   <div class="actions">
    <button
     class="primary-btn"
     data-action="new-exam"
     ${slots<=0?'disabled':''}
    >
     + Add New Exam
    </button>
   </div>
  </div>

  <div class="exam-grid">
   ${db.exams.map(examCard).join('')}
  </div>
 `;

 bindActions();
}

function examCard(e){
 const availability=getAvailability(e);

 const attempts=db.attempts.filter(
  a=>a.examId===e.id
 );

 return `
  <article class="exam-card">

   <div class="exam-card-top">
    <span class="badge ${e.active?'green':'gray'}">
     ${e.active?'ACTIVE':'DISABLED'}
    </span>

    ${badge(availability.status)}
   </div>

   <h3>${esc(e.title)}</h3>

   <p>${esc(e.description||'No description provided.')}</p>

   <div class="exam-meta">

    <div class="meta-box">
     <span>Timer</span>
     <strong>
      ${e.timerEnabled?e.durationMinutes+' min':'Off'}
     </strong>
    </div>

    <div class="meta-box">
     <span>Anti-cheat</span>
     <strong>
      ${e.antiCheat?'On':'Off'}
     </strong>
    </div>

    <div class="meta-box">
     <span>Violations</span>
     <strong>${e.maxViolations}</strong>
    </div>

    <div class="meta-box">
     <span>Attempts</span>
     <strong>${attempts.length}</strong>
    </div>

   </div>

   <div class="exam-card-actions">
    <button
     class="secondary-btn"
     data-action="edit-exam"
     data-id="${e.id}"
    >
     Edit
    </button>

    <button
     class="danger-btn"
     data-action="delete-exam"
     data-id="${e.id}"
    >
     Delete
    </button>
   </div>

  </article>
 `;
}

function getAvailability(e){
 if(!e||e.active===false){
  return{status:'Unavailable'};
 }

 const now=Date.now();

 const start=e.startAt
  ?new Date(e.startAt).getTime()
  :null;

 const end=e.endAt
  ?new Date(e.endAt).getTime()
  :null;

 if(Number.isFinite(start)&&now<start){
  return{status:'Unavailable'};
 }

 if(Number.isFinite(end)&&now>end){
  return{status:'Unavailable'};
 }

 return{status:'Available'};
}

function openExamModal(id=null){
 const e=id
  ?db.exams.find(x=>x.id===id)
  :null;

 if(!e&&db.exams.length>=6){
  toast(
   'Maximum of 6 exams reached. Delete an exam to free a slot.',
   'error'
  );

  return;
 }

 const x=e||{
  title:'',
  description:'',
  formUrl:'',
  examinerUsername:'test',
  examinerPassword:'test',
  antiCheat:true,
  maxViolations:3,
  timerEnabled:true,
  durationMinutes:60,
  startAt:'',
  endAt:'',
  active:true
 };

 const isoLocal=v=>
  v
   ?new Date(v).toISOString().slice(0,16)
   :'';

 $('#modal-root').hidden=false;

 $('#modal-root').innerHTML=`
  <div class="modal">

   <div class="modal-head">
    <div>
     <span class="eyebrow">
      ${e?'EDIT EXAM':'NEW EXAM'}
     </span>

     <h3>
      ${e?'Update examination':'Create examination'}
     </h3>
    </div>

    <button
     class="close-btn"
     data-action="close-modal"
    >
     ×
    </button>
   </div>

   <form id="exam-form">

    <div class="modal-body">

     <div class="form-grid">

      <div class="field full-span">
       <label class="form-label">Exam Title</label>

       <input
        name="title"
        required
        value="${esc(x.title)}"
        placeholder="e.g. HR Certification Examination"
       >
      </div>

      <div class="field full-span">
       <label class="form-label">Description</label>

       <textarea
        name="description"
        rows="2"
        placeholder="Short description"
       >${esc(x.description)}</textarea>
      </div>

      <div class="field full-span">
       <label class="form-label">
        Google Forms Link
       </label>

       <input
        name="formUrl"
        type="url"
        required
        value="${esc(x.formUrl)}"
        placeholder="https://docs.google.com/forms/d/e/.../viewform?embedded=true"
       >

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
        value="${esc(x.examinerUsername)}"
       >
      </div>

      <div class="field">
       <label class="form-label">
        Examiner Password
       </label>

       <input
        name="examinerPassword"
        required
        value="${esc(x.examinerPassword)}"
       >
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
        value="${x.maxViolations}"
       >
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
        value="${x.durationMinutes}"
       >
      </div>

      <div class="field full-span">

       <div class="checkbox-row">

        <input
         id="antiCheat"
         name="antiCheat"
         type="checkbox"
         ${x.antiCheat?'checked':''}
        >

        <label for="antiCheat">
         Enable anti-cheat monitoring
        </label>

       </div>

       <div class="helper">
        Detects tab visibility changes, window focus loss and fullscreen exits.
        Browser security prevents a web page from completely blocking OS/browser shortcuts.
       </div>

      </div>

      <div class="field full-span">

       <div class="checkbox-row">

        <input
         id="timerEnabled"
         name="timerEnabled"
         type="checkbox"
         ${x.timerEnabled?'checked':''}
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
        value="${isoLocal(x.startAt)}"
       >

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
        value="${isoLocal(x.endAt)}"
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
         ${x.active?'checked':''}
        >

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
      data-action="close-modal"
     >
      Cancel
     </button>

     <button
      type="submit"
      class="primary-btn"
     >
      ${e?'Save Changes':'Create Exam'}
     </button>

    </div>

   </form>

  </div>
 `;

 $('#exam-form').addEventListener('submit',ev=>{
  ev.preventDefault();

  const f=new FormData(ev.target);

  const url=String(f.get('formUrl')||'').trim();

  if(!/^https:\/\/(docs\.google\.com|forms\.google\.com)\//i.test(url)){
   toast(
    'Please enter a valid Google Forms URL.',
    'error'
   );

   return;
  }

  const examinerUsername=
   String(f.get('examinerUsername')||'').trim();

  const examinerPassword=
   String(f.get('examinerPassword')||'');

  const durationMinutes=
   Math.max(
    1,
    Math.round(
     Number(f.get('durationMinutes'))||60
    )
   );

  const timerEnabled=f.has('timerEnabled');

  const obj={
   title:String(f.get('title')||'').trim(),
   description:String(f.get('description')||'').trim(),
   formUrl:url,
   examinerUsername,
   examinerPassword,
   antiCheat:f.has('antiCheat'),
   maxViolations:Math.max(
    1,
    Math.round(
     Number(f.get('maxViolations'))||3
    )
   ),
   timerEnabled,
   durationMinutes,
   startAt:f.get('startAt')
    ?new Date(f.get('startAt')).toISOString()
    :'',
   endAt:f.get('endAt')
    ?new Date(f.get('endAt')).toISOString()
    :'',
   active:f.has('active')
  };

  if(
   !obj.title||
   !obj.examinerUsername||
   !obj.examinerPassword
  ){
   toast(
    'Complete all required fields.',
    'error'
   );

   return;
  }

  // Keep the portal login account synchronized with the exam credentials.
  const normalizedUsername=
   obj.examinerUsername.toLowerCase();

  let account=db.users.find(
   u=>String(u.username||'').trim().toLowerCase()===
      normalizedUsername
  );

  if(account&&account.role==='admin'){
   toast(
    'That username belongs to an administrator. Please use another examiner username.',
    'error'
   );

   return;
  }

  if(!account){
   account={
    id:uid('user'),
    username:obj.examinerUsername,
    password:obj.examinerPassword,
    role:'examiner',
    name:obj.examinerUsername
   };

   db.users.push(account);
  }else{
   account.username=obj.examinerUsername;
   account.password=obj.examinerPassword;
   account.role='examiner';

   if(!account.name){
    account.name=obj.examinerUsername;
   }
  }

  if(e){
   Object.assign(e,obj);
  }else{
   db.exams.push({
    id:uid('exam'),
    ...obj,
    createdAt:Date.now(),
    createdBy:currentUser()?.id||'u-admin'
   });
  }

  saveDB();

  closeModal();
  renderAdminExams();

  toast(
   e
    ?'Exam updated. Examiner login updated successfully.'
    :'Exam created. Examiner account created successfully.',
   'success'
  );
 });
}

function deleteExam(id){
 const e=db.exams.find(x=>x.id===id);

 if(!e)return;

 const count=db.attempts.filter(
  a=>a.examId===id
 ).length;

 const ok=confirm(
  `Delete "${e.title}"?\n\nThis releases an exam slot. ${count} historical attempt(s) will remain in the reports.`
 );

 if(!ok)return;

 db.exams=db.exams.filter(
  x=>x.id!==id
 );

 saveDB();

 renderAdminExams();

 toast(
  'Exam deleted. The slot is now available.',
  'success'
 );
}

function closeModal(){
 $('#modal-root').hidden=true;
 $('#modal-root').innerHTML='';
}

/* SUBMISSIONS / VIOLATIONS / ANALYTICS */

function renderSubmissions(){
 const sorted=db.attempts
  .slice()
  .sort(
   (a,b)=>(b.startedAt||0)-(a.startedAt||0)
  );

 $('#admin-submissions-page').innerHTML=`
  <div class="page-head">
   <div>
    <span class="eyebrow">MONITORING</span>
    <h3>Submissions</h3>
    <p>Current and completed examination sessions.</p>
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
   ${submissionTable(sorted)}
  </div>
 `;

 bindActions();
}

function renderViolations(){
 const rows=db.violations
  .slice()
  .sort((a,b)=>b.timestamp-a.timestamp);

 $('#admin-violations-page').innerHTML=`
  <div class="page-head">
   <div>
    <span class="eyebrow">SECURITY</span>
    <h3>Violation Logs</h3>
    <p>Every detected event is recorded for review.</p>
   </div>
  </div>

  <div class="panel">
   ${
    rows.length
     ?`
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
         ${rows.map(v=>`
          <tr>
           <td>${fmtDate(v.timestamp)}</td>
           <td>${esc(v.username)}</td>
           <td>${esc(v.examTitle)}</td>
           <td>${v.number}</td>
           <td>${esc(v.reason)}</td>
          </tr>
         `).join('')}
        </tbody>

       </table>
      </div>
     `
     :'<div class="empty">No violations logged yet.</div>'
   }
  </div>
 `;
}

function renderAnalytics(){
 const c=attemptCounts();

 const total=c.total||1;

 const avg=db.attempts.length
  ?(
    db.attempts.reduce(
     (s,a)=>s+(a.violations||0),
     0
    )/db.attempts.length
   ).toFixed(2)
  :'0.00';

 const byExam=db.exams
  .map(e=>({
   e,
   n:db.attempts.filter(
    a=>a.examId===e.id
   ).length
  }))
  .sort((a,b)=>b.n-a.n);

 $('#admin-analytics-page').innerHTML=`
  <div class="page-head">
   <div>
    <span class="eyebrow">REPORTING</span>
    <h3>Analytics</h3>
    <p>Performance and security overview.</p>
   </div>
  </div>

  <div class="kpi-grid">
   ${kpi(
    'Completion Rate',
    Math.round(c.completed/total*100)+'%'
   )}

   ${kpi(
    'In Progress',
    c.inProgress
   )}

   ${kpi(
    'Termination Rate',
    Math.round(c.terminated/total*100)+'%'
   )}

   ${kpi(
    'Avg. Violations',
    avg
   )}
  </div>

  <div class="grid-2">

   <div class="panel">
    <h3>Session Status</h3>

    ${
     [
      ['Completed',c.completed],
      ['In Progress',c.inProgress],
      ['Time Expired',c.expired],
      ['Terminated',c.terminated]
     ]
     .map(
      ([l,n])=>chart(l,n,c.total)
     )
     .join('')
    }
   </div>

   <div class="panel">
    <h3>Sessions by Exam</h3>

    ${
     byExam.length
      ?byExam
       .map(
        x=>chart(
         x.e.title,
         x.n,
         c.total
        )
       )
       .join('')
      :'<div class="empty">No exams.</div>'
    }
   </div>

  </div>

  <div
   class="panel"
   style="margin-top:18px"
  >
   <h3>Violation Activity</h3>

   <p
    class="muted"
    style="font-size:12px"
   >
    ${db.violations.length}
    security events have been recorded across
    ${db.attempts.length}
    session(s).
   </p>

   <div class="progress-bar">
    <div
     class="progress-fill"
     style="width:${Math.min(100,db.violations.length*5)}%"
    ></div>
   </div>
  </div>
 `;
}

function kpi(l,v){
 return `
  <div class="kpi">
   <span>${l}</span>
   <strong>${v}</strong>
  </div>
 `;
}

function chart(l,n,total){
 const p=total
  ?Math.round(n/total*100)
  :0;

 return `
  <div class="chart-row">

   <div>
    <div class="chart-label">
     ${esc(l)}
    </div>

    <div class="bar-track">
     <div
      class="bar-value"
      style="width:${p}%"
     ></div>
    </div>
   </div>

   <div class="chart-number">
    ${n} (${p}%)
   </div>

  </div>
 `;
}

function renderSettings(){
 const u=currentUser();

 $('#admin-settings-page').innerHTML=`
  <div class="page-head">
   <div>
    <span class="eyebrow">SYSTEM</span>
    <h3>Settings</h3>
    <p>Frontend prototype settings and account management.</p>
   </div>
  </div>

  <div class="grid-2">

   <div class="panel">
    <h3>Theme</h3>

    <p
     class="muted"
     style="font-size:12px"
    >
     Current theme:
     <strong>${db.theme}</strong>
    </p>

    <button
     class="secondary-btn"
     data-action="toggle-theme"
    >
     Switch Theme
    </button>
   </div>

   <div class="panel">
    <h3>Prototype Data</h3>

    <p
     class="muted"
     style="font-size:12px"
    >
     Users, exams, attempts and violation logs are stored in this browser's localStorage.
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
   <h3>Accounts</h3>

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
      ${db.users.map(x=>`
       <tr>
        <td>${esc(x.username)}</td>
        <td>${esc(x.name)}</td>
        <td>${esc(x.role)}</td>

        <td>
         ${
          x.id===u.id
           ?'<span class="muted">Current user</span>'
           :`
            <button
             class="danger-btn"
             data-action="delete-user"
             data-id="${x.id}"
            >
             Delete
            </button>
           `
         }
        </td>
       </tr>
      `).join('')}
     </tbody>

    </table>

   </div>
  </div>

  <div
   class="panel"
   style="margin-top:18px"
  >
   <h3>Production Note</h3>

   <div class="notice danger-notice">
    Do not use client-side passwords/localStorage as a production authentication system.
    Move credentials, role permissions, exam availability, attempt locking, timers and
    violation logs to a server-side database/API.
   </div>
  </div>
 `;

 bindActions();
}

/* EXAMINER */

function renderExaminerDashboard(){
 const u=currentUser();

 const assigned=db.exams.filter(
  e=>String(e.examinerUsername||'').trim().toLowerCase()===
     String(u.username||'').trim().toLowerCase()
 );

 const available=assigned.filter(
  e=>getAvailability(e).status==='Available'
 );

 const doneIds=new Set(
  db.attempts
   .filter(
    a=>a.username===u.username&&
       ['Completed','Time Expired','Terminated'].includes(a.status)
   )
   .map(a=>a.examId)
 );

 const completed=assigned.filter(
  e=>doneIds.has(e.id)
 ).length;

 const pct=assigned.length
  ?Math.round(completed/assigned.length*100)
  :0;

 $('#examiner-dashboard-page').innerHTML=`
  <div class="page-head">

   <div>
    <span class="eyebrow">
     YOUR EXAMINATION QUEUE
    </span>

    <h3>
     Welcome, ${esc(u.name||u.username)}
    </h3>

    <p>
     Only exams assigned to your examiner account and currently available are shown as startable.
    </p>
   </div>

  </div>

  <div
   class="panel"
   style="margin-bottom:18px"
  >

   <div class="progress-meta">
    <strong>Exam Progress</strong>
    <span>${completed}/${assigned.length} completed</span>
   </div>

   <div
    class="progress-bar"
    style="margin-top:8px"
   >
    <div
     class="progress-fill"
     style="width:${pct}%"
    ></div>
   </div>

  </div>

  <div class="exam-grid">
   ${
    assigned.length
     ?assigned
      .map(
       e=>examinerExamCard(
        e,
        doneIds.has(e.id)
       )
      )
      .join('')
     :`
      <div
       class="panel"
       style="grid-column:1/-1"
      >
       <div class="empty">
        No exams have been assigned to this examiner account.
       </div>
      </div>
     `
   }
  </div>
 `;

 bindActions();
}

function examinerExamCard(e,done){
 const av=getAvailability(e);

 const canStart=
  av.status==='Available'&&!done;

 const last=db.attempts
  .filter(
   a=>a.examId===e.id&&
      a.username===currentUser().username
  )
  .sort(
   (a,b)=>b.startedAt-a.startedAt
  )[0];

 return `
  <article class="exam-card">

   <div class="exam-card-top">
    ${
     done
      ?'<span class="badge green">COMPLETED</span>'
      :badge(av.status)
    }
   </div>

   <h3>${esc(e.title)}</h3>

   <p>
    ${esc(e.description||'No description provided.')}
   </p>

   <div class="exam-meta">

    <div class="meta-box">
     <span>Duration</span>
     <strong>
      ${e.timerEnabled?e.durationMinutes+' min':'No timer'}
     </strong>
    </div>

    <div class="meta-box">
     <span>Anti-cheat</span>
     <strong>
      ${e.antiCheat?'Enabled':'Disabled'}
     </strong>
    </div>

    <div class="meta-box">
     <span>Max violations</span>
     <strong>${e.maxViolations}</strong>
    </div>

    <div class="meta-box">
     <span>Attempts</span>
     <strong>
      ${done?'1 / 1':'0 / 1'}
     </strong>
    </div>

   </div>

   <div class="exam-card-actions">
    ${
     done
      ?`
       <button
        class="secondary-btn"
        disabled
       >
        Exam Locked
       </button>
      `
      :canStart
       ?`
        <button
         class="primary-btn"
         data-action="start-exam"
         data-id="${e.id}"
        >
         Start Exam
        </button>
       `
       :`
        <button
         class="secondary-btn"
         disabled
        >
         Not Available
        </button>
       `
    }
   </div>

   ${
    last&&last.status==='In Progress'
     ?`
      <div class="helper">
       A previous session is still marked in progress.
       Refreshing the page cannot create a second attempt.
      </div>
     `
     :''
   }

  </article>
 `;
}

/* START EXAM */

function startExam(id){
 const e=db.exams.find(x=>x.id===id);
 const u=currentUser();

 if(!e||!u)return;

 if(
  String(e.examinerUsername||'').trim().toLowerCase()!==
  String(u.username||'').trim().toLowerCase()
 ){
  toast(
   'This exam is not assigned to your account.',
   'error'
  );

  return;
 }

 if(getAvailability(e).status!=='Available'){
  toast(
   'This exam is not currently available.',
   'error'
  );

  return;
 }

 if(
  db.attempts.some(
   a=>a.examId===id&&
      a.username===u.username&&
      ['Completed','Time Expired','Terminated'].includes(a.status)
  )
 ){
  toast(
   'This exam is locked because it has already been taken.',
   'error'
  );

  return;
 }

 const inProg=db.attempts.find(
  a=>a.examId===id&&
     a.username===u.username&&
     a.status==='In Progress'
 );

 if(inProg){
  toast(
   'An active attempt already exists.',
   'error'
  );

  return;
 }

 openStartInstructions(e);
}

function openStartInstructions(e){
 $('#modal-root').hidden=false;

 $('#modal-root').innerHTML=`
  <div class="modal">

   <div class="modal-head">
    <div>
     <span class="eyebrow">
      EXAM INSTRUCTIONS
     </span>

     <h3>${esc(e.title)}</h3>
    </div>

    <button
     class="close-btn"
     data-action="close-modal"
    >
     ×
    </button>
   </div>

   <div class="modal-body">

    <div class="notice">
     You can take this examination only once.
     Once submitted, expired or terminated, it cannot be retaken.
    </div>

    <ul
     style="color:var(--muted);font-size:13px;line-height:1.8;padding-left:20px"
    >

     <li>
      ${
       e.timerEnabled
        ?`You have <strong>${e.durationMinutes} minutes</strong> to complete the examination.`
        :'No countdown timer is configured for this exam.'
      }
     </li>

     <li>
      ${
       e.antiCheat
        ?`Anti-cheat is enabled. Up to <strong>${e.maxViolations}</strong> violation(s) are allowed before automatic termination.`
        :'Anti-cheat monitoring is disabled for this examination.'
      }
     </li>

     <li>
      Submit the Google Form first, then use the portal's
      <strong>Submit Exam</strong> button.
     </li>

     <li>
      Do not refresh or close the page while the exam is active.
     </li>

    </ul>

    ${
     e.antiCheat
      ?`
       <div class="notice danger-notice">
        Fullscreen, tab/window focus and visibility events may be monitored.
        Browser limitations mean this is a detection/deterrence layer,
        not a guarantee against cheating.
       </div>
      `
      :''
    }

   </div>

   <div class="modal-footer">

    <button
     class="secondary-btn"
     data-action="close-modal"
    >
     Cancel
    </button>

    <button
     class="primary-btn"
     data-action="confirm-start"
     data-id="${e.id}"
    >
     Start Examination
    </button>

   </div>

  </div>
 `;
}

function confirmStart(id){
 closeModal();

 const e=db.exams.find(x=>x.id===id);
 const u=currentUser();

 currentExam=clone(e);

 const attempt={
  id:uid('attempt'),
  examId:e.id,
  examTitle:e.title,
  username:u.username,
  userId:u.id,
  startedAt:Date.now(),
  endedAt:null,
  status:'In Progress',
  violations:0
 };

 db.attempts.push(attempt);

 saveDB();

 const timerEnabled=
  e.timerEnabled===true||
  e.timerEnabled==='true'||
  e.timerEnabled===1||
  e.timerEnabled==='1';

 const durationMinutes=
  Math.max(
   1,
   Math.round(
    Number(e.durationMinutes)||60
   )
  );

 const antiCheat=
  e.antiCheat===true||
  e.antiCheat==='true'||
  e.antiCheat===1||
  e.antiCheat==='1';

 examState={
  attemptId:attempt.id,
  seconds:timerEnabled
   ?durationMinutes*60
   :0,
  timerEnabled,
  antiCheat,
  maxViolations:Math.max(
   1,
   Number(e.maxViolations)||3
  ),
  startedAt:Date.now(),
  active:true
 };

 $('#live-exam-title').textContent=e.title;

 $('#live-exam-examiner').textContent=
  'Assigned to '+u.username;

 $('#exam-violations').textContent=
  `0 / ${e.maxViolations}`;

 $('#exam-iframe').src=e.formUrl;

 $('#exam-instructions').textContent=
  timerEnabled
   ?`Timer: ${durationMinutes} minutes • Anti-cheat: ${antiCheat?'Enabled':'Disabled'} • Submit the Google Form, then click Submit Exam.`
   :`No timer • Anti-cheat: ${antiCheat?'Enabled':'Disabled'} • Submit the Google Form, then click Submit Exam.`;

 showView('exam');

 document.body.classList.add('lockdown-active');
 $('#exam-view').classList.add('lockdown-active');

 graceUntil=Date.now()+GRACE;

 if(e.antiCheat){
  requestFullscreen().finally(()=>{
   graceUntil=Date.now()+GRACE;
  });
 }

 if(timerEnabled){
  startTimer();
 }else{
  renderTimer();
 }
}

function requestFullscreen(){
 const el=document.documentElement;

 const fn=
  el.requestFullscreen||
  el.webkitRequestFullscreen||
  el.mozRequestFullScreen;

 return fn
  ?Promise.resolve(
    fn.call(el)
   ).catch(()=>{})
  :Promise.resolve();
}

function exitFullscreen(){
 const fn=
  document.exitFullscreen||
  document.webkitExitFullscreen||
  document.mozCancelFullScreen;

 if(fn&&isFullscreen()){
  Promise.resolve(
   fn.call(document)
  ).catch(()=>{});
 }
}

function isFullscreen(){
 return !!(
  document.fullscreenElement||
  document.webkitFullscreenElement||
  document.mozFullScreenElement
 );
}

function startTimer(){
 clearInterval(timer);

 renderTimer();

 timer=setInterval(()=>{
  if(!examState?.active)return;

  examState.seconds--;

  renderTimer();

  if(examState.seconds<=0){
   clearInterval(timer);

   finishExam(
    'Time Expired',
    'Time Expired',
    'Your allotted examination time has ended.',
    '⌛'
   );
  }
 },1000);
}

function renderTimer(){
 const t=Math.max(
  0,
  Number(examState?.seconds)||0
 );

 const m=Math.floor(t/60)
  .toString()
  .padStart(2,'0');

 const sec=(t%60)
  .toString()
  .padStart(2,'0');

 const timerEl=$('#exam-timer');

 if(timerEl){
  timerEl.textContent=
   examState?.timerEnabled
    ?`${m}:${sec}`
    :'No Timer';

  timerEl.classList.toggle(
   'warning',
   t<=300&&t>60
  );

  timerEl.classList.toggle(
   'danger',
   t<=60&&!!examState?.timerEnabled
  );
 }

 const duration=
  Math.max(
   1,
   Math.round(
    Number(currentExam?.durationMinutes)||60
   )
  );

 const pct=
  examState?.timerEnabled
   ?Math.max(
    0,
    Math.min(
     100,
     (t/(duration*60))*100
    )
   )
   :0;

 const progress=$('#exam-progress');

 if(progress){
  progress.style.width=(100-pct)+'%';
 }
}

/* PROCTORING */

function registerViolation(reason){
 if(!examState?.active||!examState.antiCheat)return;

 const now=Date.now();

 if(
  now<graceUntil||
  now-lastViolation<DEBOUNCE||
  violationOverlayOpen
 ){
  return;
 }

 lastViolation=now;

 const a=db.attempts.find(
  x=>x.id===examState.attemptId
 );

 if(!a)return;

 const n=(a.violations||0)+1;

 a.violations=n;

 db.violations.push({
  id:uid('vio'),
  attemptId:a.id,
  examId:currentExam.id,
  examTitle:currentExam.title,
  username:a.username,
  number:n,
  reason,
  timestamp:now
 });

 saveDB();

 $('#exam-violations').textContent=
  `${n} / ${examState.maxViolations}`;

 if(n>=examState.maxViolations){
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

function showViolationOverlay(reason){
 if(!examState?.active||!examState.antiCheat)return;

 violationOverlayOpen=true;

 $('#violation-reason').textContent=reason;

 const a=db.attempts.find(
  x=>x.id===examState.attemptId
 );

 $('#overlay-count').textContent=
  a?.violations||0;

 $('#overlay-max').textContent=
  examState.maxViolations;

 $('#violation-overlay').hidden=false;

 $('#exam-iframe').style.filter=
  'blur(6px) brightness(.45)';
}

$('#resume-exam-btn').addEventListener(
 'click',
 async()=>{
  if(!examState?.active)return;

  $('#violation-overlay').hidden=true;

  violationOverlayOpen=false;

  $('#exam-iframe').style.filter='';

  graceUntil=Date.now()+GRACE;

  await requestFullscreen();

  graceUntil=Date.now()+GRACE;
 }
);

[
 'fullscreenchange',
 'webkitfullscreenchange',
 'mozfullscreenchange'
].forEach(
 ev=>document.addEventListener(
  ev,
  ()=>{
   if(
    examState?.active&&
    examState.antiCheat&&
    !isFullscreen()&&
    Date.now()>graceUntil
   ){
    registerViolation(
     'You exited full-screen mode.'
    );
   }
  }
 )
);

document.addEventListener(
 'visibilitychange',
 ()=>{
  if(
   examState?.active&&
   examState.antiCheat&&
   document.hidden
  ){
   registerViolation(
    'You switched tabs or minimized the window.'
   );
  }
 }
);

window.addEventListener(
 'blur',
 ()=>{
  if(
   examState?.active&&
   examState.antiCheat
  ){
   registerViolation(
    'The exam window lost focus.'
   );
  }
 }
);

document.addEventListener(
 'contextmenu',
 e=>{
  if(examState?.active)e.preventDefault();
 }
);

document.addEventListener(
 'copy',
 e=>{
  if(examState?.active)e.preventDefault();
 }
);

document.addEventListener(
 'cut',
 e=>{
  if(examState?.active)e.preventDefault();
 }
);

document.addEventListener(
 'paste',
 e=>{
  if(examState?.active)e.preventDefault();
 }
);

document.addEventListener(
 'keydown',
 e=>{
  if(!examState?.active)return;

  const k=(e.key||'').toLowerCase();
  const mod=e.ctrlKey||e.metaKey;

  const restricted=
   k==='f12'||
   (
    mod&&
    e.shiftKey&&
    ['i','j','c'].includes(k)
   )||
   (
    mod&&
    ['t','n','w','u'].includes(k)
   );

  if(restricted){
   e.preventDefault();

   registerViolation(
    `Restricted shortcut attempt: ${
     [
      e.ctrlKey?'Ctrl':'',
      e.metaKey?'Cmd':'',
      e.altKey?'Alt':'',
      e.shiftKey?'Shift':'',
      e.key
     ]
     .filter(Boolean)
     .join('+')
    }`
   );
  }
});

window.addEventListener(
 'beforeunload',
 e=>{
  if(examState?.active){
   e.preventDefault();
   e.returnValue='';
  }
 }
);

// SECURITY UI GUARD: violation prompts are shown only during an active exam.
function syncViolationOverlay(){
 const overlay=
  document.getElementById(
   'violation-overlay'
  );

 if(!overlay)return;

 if(!examState?.active){
  violationOverlayOpen=false;
  overlay.hidden=true;
 }
}

syncViolationOverlay();

/* SUBMIT / RESULT */

$('#exam-submit-btn').addEventListener(
 'click',
 ()=>{
  if(!examState?.active)return;

  const ok=confirm(
   'Confirm that you have submitted the Google Form. This will permanently end this exam attempt and cannot be undone.'
  );

  if(ok){
   finishExam(
    'Completed',
    'Thank you for taking the exam!',
    'Your examination session has been submitted successfully.',
    '✓',
    false
   );
  }
 }
);

function finishExam(
 status,
 title,
 message,
 icon,
 terminated=false
){
 if(!examState?.active)return;

 examState.active=false;

 clearInterval(timer);

 const a=db.attempts.find(
  x=>x.id===examState.attemptId
 );

 if(a){
  a.status=status;
  a.endedAt=Date.now();
 }

 saveDB();

 $('#violation-overlay').hidden=true;

 violationOverlayOpen=false;

 document.body.classList.remove(
  'lockdown-active'
 );

 $('#exam-view').classList.remove(
  'lockdown-active'
 );

 exitFullscreen();

 $('#result-icon').textContent=icon;

 $('#result-icon').style.color=
  terminated
   ?'var(--danger)'
   :'var(--success)';

 $('#result-icon').style.background=
  terminated
   ?'rgba(239,91,103,.12)'
   :'rgba(49,196,141,.12)';

 $('#result-eyebrow').textContent=
  terminated
   ?'EXAM TERMINATED'
   :status==='Time Expired'
    ?'TIME EXPIRED'
    :'EXAM COMPLETE';

 $('#result-title').textContent=title;

 $('#result-message').textContent=message;

 $('#result-exam').textContent=
  currentExam?.title||'—';

 $('#result-user').textContent=
  currentUser()?.username||'—';

 $('#result-violations').textContent=
  a?.violations||0;

 $('#result-ended').textContent=
  fmtDate(Date.now());

 showView('result');
}

$('#result-dashboard-btn').addEventListener(
 'click',
 ()=>{
  currentExam=null;
  examState=null;
  openPortal();
 }
);

/* ACTION BINDING */

function bindActions(){
 $$('[data-action]').forEach(b=>{
  if(b.dataset.bound)return;

  b.dataset.bound='1';

  b.addEventListener(
   'click',
   ()=>{
    const a=b.dataset.action;
    const id=b.dataset.id;

    if(a==='new-exam'){
     openExamModal();
    }

    if(a==='edit-exam'){
     openExamModal(id);
    }

    if(a==='delete-exam'){
     deleteExam(id);
    }

    if(a==='close-modal'){
     closeModal();
    }

    if(a==='confirm-start'){
     confirmStart(id);
    }

    if(a==='start-exam'){
     startExam(id);
    }

    if(a==='view-submissions'){
     adminPage('submissions');
    }

    if(a==='refresh-admin'){
     db=loadDB();

     renderAdminPage(
      $('#admin-page-title')
       .textContent
       .toLowerCase()
       .replace(' ','-')
     );
    }

    if(a==='toggle-theme'){
     toggleTheme();
    }

    if(a==='reset-demo'){
     resetDemo();
    }

    if(a==='delete-user'){
     deleteUser(id);
    }
   }
  );
 });
}

function deleteUser(id){
 if(db.users.length<=1)return;

 const u=db.users.find(
  x=>x.id===id
 );

 if(!u)return;

 if(confirm(`Delete user "${u.username}"?`)){
  db.users=db.users.filter(
   x=>x.id!==id
  );

  saveDB();

  renderSettings();

  toast(
   'User deleted.',
   'success'
  );
 }
}

function resetDemo(){
 if(
  !confirm(
   'Reset all demo data, exams, attempts and violation logs?'
  )
 ){
  return;
 }

 db=clone(seed);

 saveDB();

 toast(
  'Demo data reset.',
  'success'
 );

 openAdmin();
}

/* CLOCKS */

setInterval(
 ()=>{
  $('#admin-clock').textContent=
   new Date().toLocaleString();

  $('#examiner-clock').textContent=
   new Date().toLocaleString();
 },
 1000
);

/* SAFE STARTUP: initialize only after the DOM is ready. */

function initializePortal(){

 // Rebuild/repair data before doing anything else.
 db=loadDB();

 initAuthentication();

 [
  'theme-toggle-login',
  'theme-toggle-admin',
  'theme-toggle-examiner'
 ].forEach(id=>{
  const b=$('#'+id);

  if(
   b&&
   b.dataset.themeBound!=='1'
  ){
   b.addEventListener(
    'click',
    toggleTheme
   );

   b.dataset.themeBound='1';
  }
 });

 $('#admin-logout')?.addEventListener(
  'click',
  logout
 );

 $('#examiner-logout')?.addEventListener(
  'click',
  logout
 );

 applyTheme();

 clearBrokenSession();

 syncViolationOverlay();

 // Always have a real dashboard available after successful login.
 if(session&&currentUser()){
  openPortal();
 }else{
  session=null;
  saveSession();
  showView('login');
 }
}

if(document.readyState==='loading'){
 document.addEventListener(
  'DOMContentLoaded',
  initializePortal,
  {once:true}
 );
}else{
 initializePortal();
}

})();
