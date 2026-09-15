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

const DEBOUNCE=650;
const GRACE=1500;

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

 if(!Array.isArray(repaired.exams)||!repaired.exams.length){
  repaired.exams=clone(seed.exams);
 }

 repaired.exams.forEach(exam=>{
  exam.timerEnabled=boolSetting(exam.timerEnabled,false);

  exam.durationMinutes=Math.max(
   1,
   Math.round(Number(exam.durationMinutes)||60)
  );

  exam.antiCheat=
   exam.antiCheat===true ||
   exam.antiCheat==='true' ||
   exam.antiCheat===1 ||
   exam.antiCheat==='1' ||
   exam.antiCheat==='on';

  exam.maxViolations=Math.max(
   1,
   Math.round(Number(exam.maxViolations)||3)
  );

  exam.active=!(
   exam.active===false ||
   exam.active==='false' ||
   exam.active===0 ||
   exam.active==='0'
  );

  const username=String(exam.examinerUsername||'').trim();

  if(!username)return;

  const normalized=username.toLowerCase();

  let account=repaired.users.find(
   u=>String(u?.username||'').trim().toLowerCase()===normalized
  );

  if(!account){
   account={
    id:uid('user'),
    username:username,
    password:String(exam.examinerPassword||''),
    role:'examiner',
    name:username
   };

   repaired.users.push(account);
  }else if(account.role!=='admin'){
   account.username=username;
   account.password=String(
    exam.examinerPassword??account.password??''
   );
   account.role='examiner';
   account.name=account.name||username;
  }
 });

 safeSet(
  localStorage,
  KEY,
  JSON.stringify(repaired)
 );

 return repaired;
}

function saveDB(){
 safeSet(
  localStorage,
  KEY,
  JSON.stringify(db)
 );
}

function loadSession(){
 try{
  return JSON.parse(
   safeGet(sessionStorage,SESSION)||'null'
  );
 }catch(e){
  return null;
 }
}

function saveSession(){
 if(session){
  safeSet(
   sessionStorage,
   SESSION,
   JSON.stringify(session)
  );
 }else{
  safeRemove(sessionStorage,SESSION);
 }
}

function uid(prefix='id'){
 return prefix+'-'+
  Date.now().toString(36)+'-'+
  Math.random().toString(36).slice(2,8);
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
 Object.values(views).forEach(v=>{
  if(v)v.hidden=true;
 });

 if(views[name]){
  views[name].hidden=false;
 }

 window.scrollTo(0,0);
}

function toast(msg,type=''){
 const d=document.createElement('div');

 d.className='toast '+type;
 d.textContent=msg;

 const container=$('#toast-container');

 if(container){
  container.appendChild(d);
  setTimeout(()=>d.remove(),3000);
 }
}

function showLoading(message='Please wait...'){
 let o=document.getElementById('loading-overlay');

 if(!o){
  o=document.createElement('div');
  o.id='loading-overlay';

  o.innerHTML=
   '<div class="loading-card">'+
   '<div class="loading-spinner"></div>'+
   '<strong id="loading-text">Please wait...</strong>'+
   '</div>';

  document.body.appendChild(o);

  const st=document.createElement('style');

  st.textContent=
   '#loading-overlay{position:fixed;inset:0;z-index:99999;display:grid;place-items:center;background:rgba(5,10,20,.72);backdrop-filter:blur(5px)}'+
   '.loading-card{min-width:220px;padding:28px 30px;border:1px solid var(--line);border-radius:18px;background:var(--card);color:var(--text);display:flex;flex-direction:column;align-items:center;gap:14px;box-shadow:0 25px 70px rgba(0,0,0,.35)}'+
   '.loading-spinner{width:34px;height:34px;border:3px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:loadingSpin .75s linear infinite}'+
   '@keyframes loadingSpin{to{transform:rotate(360deg)}}';

  document.head.appendChild(st);
 }

 o.style.display='grid';

 const t=document.getElementById('loading-text');

 if(t){
  t.textContent=message;
 }
}

function hideLoading(){
 const o=document.getElementById('loading-overlay');

 if(o){
  o.style.display='none';
 }
}

function applyTheme(){
 const light=db.theme==='light';

 document.documentElement.dataset.theme=
  light?'light':'dark';

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
    light
     ?'Switch to dark mode'
     :'Switch to light mode'
   );

   b.title=light
    ?'Switch to dark mode'
    :'Switch to light mode';
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

async function handleLogin(e){
 if(e)e.preventDefault();

 const loginForm=$('#login-form');

 if(loginForm?.dataset.loggingIn==='1'){
  return false;
 }

 if(loginForm){
  loginForm.dataset.loggingIn='1';
 }

 showLoading('Signing in...');

 await new Promise(resolve=>setTimeout(resolve,350));

 clearLoginError();

 const usernameEl=$('#login-username');
 const passwordEl=$('#login-password');
 const form=$('#login-form');

 if(!usernameEl||!passwordEl){
  showLoginError(
   'Login form could not be loaded. Please refresh the page.'
  );

  hideLoading();

  if(loginForm){
   loginForm.dataset.loggingIn='';
  }

  return false;
 }

 const username=String(usernameEl.value||'').trim();
 const password=String(passwordEl.value||'');

 if(!username||!password){
  showLoginError(
   'Please enter both your username and password.'
  );

  (!username?usernameEl:passwordEl).focus();

  hideLoading();

  if(loginForm){
   loginForm.dataset.loggingIn='';
  }

  return false;
 }

 db=loadDB();

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
  String(u?.password??'')===password &&
  u?.role==='examiner'
 );

 if(!user){
  const assignedExam=db.exams.find(ex=>
   String(ex?.examinerUsername||'')
    .trim()
    .toLowerCase()===key &&
   String(ex?.examinerPassword??'')===password
  );

  if(assignedExam){
   const existing=db.users.find(u=>
    String(u?.username||'')
     .trim()
     .toLowerCase()===key &&
    u?.role!=='admin'
   );

   user=existing||{
    id:uid('user'),
    username:String(
     assignedExam.examinerUsername
    ).trim(),
    password:String(
     assignedExam.examinerPassword
    ),
    role:'examiner',
    name:String(
     assignedExam.examinerUsername
    ).trim()
   };

   if(!db.users.some(u=>u.id===user.id)){
    db.users.push(user);
   }

   saveDB();
  }
 }

 if(!user&&fallback[key]&&fallback[key].password===password){
  const f=fallback[key];

  user={
   id:f.id,
   username:key,
   password:f.password,
   role:f.role,
   name:f.name
  };
 }

 if(!user){
  showLoginError(
   'Incorrect username or password. Please check your credentials and try again.'
  );

  passwordEl.value='';
  passwordEl.focus();

  hideLoading();

  if(form){
   form.classList.remove('login-error-shake');

   void form.offsetWidth;

   form.classList.add('login-error-shake');
  }

  if(loginForm){
   loginForm.dataset.loggingIn='';
  }

  return false;
 }

 const stored=db.users.find(u=>
  u.id===user.id ||
  String(u.username||'').toLowerCase()===key
 );

 if(!stored){
  db.users.push(clone(user));
 }else{
  stored.username=user.username;
  stored.password=user.password;
  stored.role=user.role;
  stored.name=user.name;
 }

 saveDB();

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
 hideLoading();

 if(loginForm){
  loginForm.dataset.loggingIn='';
 }

 return false;
}

function initAuthentication(){
 const form=$('#login-form');

 if(form&&form.dataset.authBound!=='1'){
  form.addEventListener('submit',handleLogin);
  form.dataset.authBound='1';
 }
}

function currentUser(){
 if(!session)return null;

 return db.users.find(u=>
  u.id===session.userId ||
  String(u.username||'').toLowerCase()===
  String(session.username||'').toLowerCase()
 )||null;
}

function logout(){
 clearInterval(timer);

 timer=null;
 currentExam=null;
 examState=null;
 violationOverlayOpen=false;

 saveSession();

 session=null;

 exitFullscreen();

 document.body.classList.remove('lockdown-active');

 $('#exam-view')?.classList.remove(
  'lockdown-active'
 );

 syncViolationOverlay();

 showView('login');

 clearLoginError();
 hideLoading();
}

/* HELPERS */

function boolSetting(v,fallback=false){
 if(v===true||v===false)return v;

 if(v==='true'||v==='1'||v===1||v==='on'){
  return true;
 }

 if(v==='false'||v==='0'||v===0||v==='off'){
  return false;
 }

 return fallback;
}

function clearBrokenSession(){
 if(!session)return;

 const u=currentUser();

 if(!u){
  session=null;
  saveSession();
 }
}

function getAssignedExamsForUser(u){
 if(!u)return[];

 const username=String(u.username||'')
  .trim()
  .toLowerCase();

 return db.exams.filter(e=>
  String(e.examinerUsername||'')
   .trim()
   .toLowerCase()===username ||
  e.examinerUserId===u.id
 );
}

function getUserAttempts(u){
 if(!u)return[];

 return db.attempts.filter(a=>
  a.userId===u.id ||
  String(a.username||'').toLowerCase()===
  String(u.username||'').toLowerCase()
 );
}

function getExamAttempts(examId,u){
 const username=String(u?.username||'')
  .toLowerCase();

 return db.attempts.filter(a=>
  a.examId===examId &&
  (
   !u ||
   a.userId===u.id ||
   String(a.username||'').toLowerCase()===username
  )
 );
}

function getCompletedAttempt(examId,u){
 return getExamAttempts(examId,u).find(a=>
  a.status==='Completed'||
  a.status==='Time Expired'||
  a.status==='Terminated'
 );
}

function getActiveAttempt(examId,u){
 return getExamAttempts(examId,u).find(a=>
  a.status==='In Progress'
 );
}

function isExamAvailable(e){
 const now=Date.now();

 if(!e.active)return false;

 if(e.startAt){
  const start=new Date(e.startAt).getTime();

  if(Number.isFinite(start)&&now<start){
   return false;
  }
 }

 if(e.endAt){
  const end=new Date(e.endAt).getTime();

  if(Number.isFinite(end)&&now>end){
   return false;
  }
 }

 return true;
}

function examAvailabilityStatus(e){
 const now=Date.now();

 if(!e.active){
  return 'Closed';
 }

 if(e.startAt){
  const start=new Date(e.startAt).getTime();

  if(Number.isFinite(start)&&now<start){
   return 'Upcoming';
  }
 }

 if(e.endAt){
  const end=new Date(e.endAt).getTime();

  if(Number.isFinite(end)&&now>end){
   return 'Expired';
  }
 }

 return 'Available';
}

/* PORTALS */

function openPortal(){
 const u=currentUser();

 if(!u){
  showView('login');
  return;
 }

 if(u.role==='admin'){
  openAdmin();
 }else{
  openExaminer();
 }
}

function openAdmin(){
 showView('admin');

 db=loadDB();

 renderAdminPage('dashboard');
}

function openExaminer(){
 showView('examiner');

 db=loadDB();

 renderExaminerDashboard();
}

/* ADMIN */

function adminPage(page){
 $$('.admin-page').forEach(p=>{
  p.classList.remove('active');
  p.hidden=true;
 });

 $$('.nav-item').forEach(n=>{
  n.classList.remove('active');
 });

 const target=$('#admin-'+page+'-page');

 if(target){
  target.classList.add('active');
  target.hidden=false;
 }

 const nav=$(`[data-admin-page="${page}"]`);

 if(nav){
  nav.classList.add('active');
 }

 renderAdminPage(page);
}

function renderAdminPage(page='dashboard'){
 db=loadDB();

 const title=$('#admin-page-title');

 if(title){
  const titles={
   dashboard:'Dashboard',
   exams:'Exam Management',
   submissions:'Submissions',
   settings:'Settings'
  };

  title.textContent=titles[page]||'Dashboard';
 }

 if(page==='dashboard'){
  renderAdminDashboard();
 }

 if(page==='exams'){
  renderAdminExams();
 }

 if(page==='submissions'){
  renderAdminSubmissions();
 }

 if(page==='settings'){
  renderSettings();
 }

 bindActions();
}

function renderAdminDashboard(){
 const target=$('#admin-dashboard-page');

 if(!target)return;

 const totalExams=db.exams.length;

 const activeExams=db.exams.filter(e=>
  e.active&&isExamAvailable(e)
 ).length;

 const totalAttempts=db.attempts.length;

 const completed=db.attempts.filter(a=>
  a.status==='Completed'
 ).length;

 const inProgress=db.attempts.filter(a=>
  a.status==='In Progress'
 ).length;

 const totalViolations=db.violations.length;

 target.innerHTML=`
  <div class="page-heading">
   <div>
    <span class="eyebrow">OVERVIEW</span>
    <h2>Dashboard</h2>
    <p>Monitor examinations, submissions and proctoring activity.</p>
   </div>
   <button class="primary-btn" data-action="new-exam">
    + Create Examination
   </button>
  </div>

  <div class="dashboard-stats">
   <div class="stat-card">
    <span>EXAMS</span>
    <strong>${totalExams}</strong>
    <small>Total examinations</small>
   </div>

   <div class="stat-card">
    <span>ACTIVE EXAMS</span>
    <strong>${activeExams}</strong>
    <small>Currently available</small>
   </div>

   <div class="stat-card">
    <span>SUBMISSIONS</span>
    <strong>${totalAttempts}</strong>
    <small>Total recorded sessions</small>
   </div>

   <div class="stat-card">
    <span>COMPLETED</span>
    <strong>${completed}</strong>
    <small>Completed examinations</small>
   </div>

   <div class="stat-card">
    <span>IN PROGRESS</span>
    <strong>${inProgress}</strong>
    <small>Active sessions</small>
   </div>

   <div class="stat-card">
    <span>VIOLATIONS</span>
    <strong>${totalViolations}</strong>
    <small>Logged security events</small>
   </div>
  </div>

  <div class="section-card">
   <div class="section-card-head">
    <div>
     <span class="eyebrow">RECENT ACTIVITY</span>
     <h3>Latest Submissions</h3>
    </div>
    <button class="secondary-btn"
     data-action="view-submissions">
     View All
    </button>
   </div>

   ${renderRecentSubmissions()}
  </div>
 `;
}

function renderRecentSubmissions(){
 const rows=[...db.attempts]
  .sort((a,b)=>
   Number(b.startedAt||0)-Number(a.startedAt||0)
  )
  .slice(0,8);

 if(!rows.length){
  return '<div class="empty-state">No submissions yet.</div>';
 }

 return `
  <div class="table-wrap">
   <table>
    <thead>
     <tr>
      <th>Exam</th>
      <th>Examiner</th>
      <th>Status</th>
      <th>Violations</th>
      <th>Started</th>
     </tr>
    </thead>
    <tbody>
     ${rows.map(a=>`
      <tr>
       <td>${esc(a.examTitle||'—')}</td>
       <td>${esc(a.username||'—')}</td>
       <td>
        <span class="status-badge">
         ${esc(a.status||'—')}
        </span>
       </td>
       <td>${a.violations||0}</td>
       <td>${fmtDate(a.startedAt)}</td>
      </tr>
     `).join('')}
    </tbody>
   </table>
  </div>
 `;
}

function renderAdminExams(){
 const target=$('#admin-exams-page');

 if(!target)return;

 target.innerHTML=`
  <div class="page-heading">
   <div>
    <span class="eyebrow">MANAGEMENT</span>
    <h2>Exam Management</h2>
    <p>Create and manage examinations.</p>
   </div>

   <button class="primary-btn"
    data-action="new-exam">
    + Create Examination
   </button>
  </div>

  <div class="exam-admin-grid">
   ${db.exams.map(e=>renderAdminExamCard(e)).join('')}
  </div>
 `;
}

function renderAdminExamCard(e){
 const attempts=db.attempts.filter(a=>a.examId===e.id);

 const completed=attempts.filter(a=>
  a.status==='Completed'
 ).length;

 const active=attempts.filter(a=>
  a.status==='In Progress'
 ).length;

 const status=examAvailabilityStatus(e);

 return `
  <article class="exam-admin-card">
   <div class="exam-card-top">
    <div>
     <span class="eyebrow">${esc(status)}</span>
     <h3>${esc(e.title)}</h3>
    </div>

    <span class="status-badge">
     ${e.active?'ACTIVE':'INACTIVE'}
    </span>
   </div>

   <p>${esc(e.description||'No description provided.')}</p>

   <div class="exam-meta">
    <span>
     Duration:
     <strong>
      ${e.timerEnabled
       ?esc(e.durationMinutes)+' min'
       :'No Timer'}
     </strong>
    </span>

    <span>
     Anti-Cheat:
     <strong>${e.antiCheat?'ON':'OFF'}</strong>
    </span>

    <span>
     Submissions:
     <strong>${attempts.length}</strong>
    </span>

    <span>
     Active:
     <strong>${active}</strong>
    </span>

    <span>
     Completed:
     <strong>${completed}</strong>
    </span>
   </div>

   <div class="exam-actions">
    <button class="secondary-btn"
     data-action="edit-exam"
     data-id="${esc(e.id)}">
     Edit
    </button>

    <button class="danger-btn"
     data-action="delete-exam"
     data-id="${esc(e.id)}">
     Delete
    </button>
   </div>
  </article>
 `;
}

function renderAdminSubmissions(){
 const target=$('#admin-submissions-page');

 if(!target){
  const fallback=$('#admin-dashboard-page');

  if(fallback){
   fallback.innerHTML=`
    <div class="page-heading">
     <div>
      <span class="eyebrow">REPORTING</span>
      <h2>Submissions</h2>
      <p>All examination sessions.</p>
     </div>
    </div>

    ${renderSubmissionTable()}
   `;
  }

  return;
 }

 target.innerHTML=`
  <div class="page-heading">
   <div>
    <span class="eyebrow">REPORTING</span>
    <h2>Submissions</h2>
    <p>All examination sessions.</p>
   </div>
  </div>

  ${renderSubmissionTable()}
 `;
}

function renderSubmissionTable(){
 const rows=[...db.attempts]
  .sort((a,b)=>
   Number(b.startedAt||0)-Number(a.startedAt||0)
  );

 if(!rows.length){
  return '<div class="empty-state">No submissions yet.</div>';
 }

 return `
  <div class="section-card">
   <div class="table-wrap">
    <table>
     <thead>
      <tr>
       <th>Exam</th>
       <th>Username</th>
       <th>Status</th>
       <th>Violations</th>
       <th>Started</th>
       <th>Ended</th>
      </tr>
     </thead>

     <tbody>
      ${rows.map(a=>`
       <tr>
        <td>${esc(a.examTitle||'—')}</td>
        <td>${esc(a.username||'—')}</td>
        <td>${esc(a.status||'—')}</td>
        <td>${a.violations||0}</td>
        <td>${fmtDate(a.startedAt)}</td>
        <td>${fmtDate(a.endedAt)}</td>
       </tr>
      `).join('')}
     </tbody>
    </table>
   </div>
  </div>
 `;
}

function renderSettings(){
 const target=$('#admin-settings-page');

 if(!target)return;

 target.innerHTML=`
  <div class="page-heading">
   <div>
    <span class="eyebrow">SYSTEM</span>
    <h2>Settings</h2>
    <p>Manage portal configuration.</p>
   </div>
  </div>

  <div class="section-card">
   <div class="section-card-head">
    <div>
     <h3>Users</h3>
     <p class="muted">
      Existing portal accounts.
     </p>
    </div>
   </div>

   <div class="table-wrap">
    <table>
     <thead>
      <tr>
       <th>Username</th>
       <th>Role</th>
       <th>Name</th>
       <th></th>
      </tr>
     </thead>

     <tbody>
      ${db.users.map(u=>`
       <tr>
        <td>${esc(u.username)}</td>
        <td>${esc(u.role)}</td>
        <td>${esc(u.name||'—')}</td>
        <td>
         ${
          u.role==='admin'
          ?''
          :`
           <button class="danger-btn"
            data-action="delete-user"
            data-id="${esc(u.id)}">
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
 `;
}

/* EXAMINER */

function renderExaminerDashboard(){
 db=loadDB();

 const u=currentUser();

 if(!u){
  logout();
  return;
 }

 const exams=getAssignedExamsForUser(u);
 const attempts=getUserAttempts(u);

 const completed=attempts.filter(a=>
  a.status==='Completed'||
  a.status==='Time Expired'||
  a.status==='Terminated'
 ).length;

 const violations=attempts.reduce(
  (sum,a)=>sum+(Number(a.violations)||0),
  0
 );

 const timeSpent=attempts.reduce(
  (sum,a)=>sum+(Number(a.durationSeconds)||0),
  0
 );

 const progress=exams.length
  ?Math.min(100,Math.round(
   (completed/exams.length)*100
  ))
  :0;

 const target=$('#examiner-dashboard-page');

 if(!target)return;

 target.innerHTML=`
  <div class="page-heading">
   <div>
    <span class="eyebrow">EXAMINEE PORTAL</span>
    <h2>Available Examinations</h2>
    <p>
     Select an examination assigned to your account.
    </p>
   </div>
  </div>

  <div class="examiner-stats">
   <div class="metric-panel section-card">
    <span class="metric-label">TESTS TAKEN</span>
    <strong>${completed}</strong>
    <div class="progress-track">
     <div class="progress-fill"
      style="width:${progress}%"></div>
    </div>
    <span class="metric-sub">
     ${progress}% completion
    </span>
   </div>

   <div class="metric-panel section-card">
    <span class="metric-label">VIOLATIONS</span>
    <strong>${violations}</strong>
    <span class="metric-sub">
     Total logged security events
    </span>
   </div>

   <div class="metric-panel section-card">
    <span class="metric-label">TOTAL TIME SPENT</span>
    <strong>${formatDuration(timeSpent)}</strong>
    <span class="metric-sub">
     Across examination sessions
    </span>
   </div>
  </div>

  <div class="exam-list">
   ${
    exams.length
    ?exams.map(e=>
      renderExaminerExamCard(e,u)
     ).join('')
    :`
     <div class="empty-state">
      No examinations are currently assigned
      to your account.
     </div>
    `
   }
  </div>
 `;

 bindActions();
}

function renderExaminerExamCard(e,u){
 const completed=getCompletedAttempt(e.id,u);
 const active=getActiveAttempt(e.id,u);
 const status=examAvailabilityStatus(e);

 let action='';

 if(completed){
  action=`
   <button class="secondary-btn" disabled>
    Completed
   </button>
  `;
 }else if(active){
  action=`
   <button class="primary-btn"
    data-action="start-exam"
    data-id="${esc(e.id)}">
    Resume Exam
   </button>
  `;
 }else if(status==='Available'){
  action=`
   <button class="primary-btn"
    data-action="start-exam"
    data-id="${esc(e.id)}">
    Start Exam
   </button>
  `;
 }else{
  action=`
   <button class="secondary-btn" disabled>
    ${esc(status)}
   </button>
  `;
 }

 return `
  <article class="exam-card">
   <div class="exam-card-head">
    <div>
     <span class="eyebrow">${esc(status)}</span>
     <h3>${esc(e.title)}</h3>
    </div>

    <span class="status-badge">
     ${completed
      ?'COMPLETED'
      :active
       ?'IN PROGRESS'
       :esc(status.toUpperCase())}
    </span>
   </div>

   <p>${esc(e.description||'')}</p>

   <div class="exam-meta">
    <span>
     Duration:
     <strong>
      ${e.timerEnabled
       ?esc(e.durationMinutes)+' minutes'
       :'No Timer'}
     </strong>
    </span>

    <span>
     Anti-Cheat:
     <strong>${e.antiCheat?'Enabled':'Disabled'}</strong>
    </span>

    <span>
     Max Violations:
     <strong>${e.maxViolations}</strong>
    </span>
   </div>

   ${
    e.startAt||e.endAt
    ?`
     <div class="exam-date-range">
      <span>AVAILABILITY</span>
      <strong>
       ${fmtDate(e.startAt)}
       —
       ${fmtDate(e.endAt)}
      </strong>
     </div>
    `
    :''
   }

   <div class="exam-actions">
    ${action}
   </div>
  </article>
 `;
}

function formatDuration(seconds){
 const s=Math.max(0,Number(seconds)||0);

 const hours=Math.floor(s/3600);
 const minutes=Math.floor((s%3600)/60);
 const secs=Math.floor(s%60);

 if(hours){
  return `${hours}h ${minutes}m`;
 }

 if(minutes){
  return `${minutes}m`;
 }

 return `${secs}s`;
}

/* EXAM START */

function startExam(id){
 const e=db.exams.find(x=>x.id===id);

 if(!e)return;

 openStartInstructions(e,false);
}

function openStartInstructions(e,resume=false){
 const old=document.getElementById('start-modal');

 if(old)old.remove();

 const modal=document.createElement('div');

 modal.id='start-modal';
 modal.className='modal-backdrop';

 modal.innerHTML=`
  <div class="modal-card">
   <button class="modal-close"
    data-action="close-modal">
    ×
   </button>

   <span class="eyebrow">
    ${resume?'RESUME EXAMINATION':'EXAMINATION'}
   </span>

   <h2>${esc(e.title)}</h2>

   <p class="muted">
    ${esc(e.description||'')}
   </p>

   ${
    e.startAt||e.endAt
    ?`
     <div class="exam-date-range">
      <span>AVAILABILITY</span>
      <strong>
       ${fmtDate(e.startAt)}
       —
       ${fmtDate(e.endAt)}
      </strong>
     </div>
    `
    :''
   }

   <div class="instruction-list">
    ${
     e.timerEnabled
     ?`
      <div class="instruction-item">
       <strong>Timer</strong>
       <span>
        You have ${esc(e.durationMinutes)}
        minutes to complete the examination.
       </span>
      </div>
     `
     :`
      <div class="instruction-item">
       <strong>No Timer</strong>
       <span>
        This examination does not have
        a time limit.
       </span>
      </div>
     `
    }

    ${
     e.antiCheat
     ?`
      <div class="instruction-item">
       <strong>Anti-Cheat Enabled</strong>
       <span>
        Tab switching, focus loss,
        fullscreen exit and restricted
        shortcuts may be logged.
       </span>
      </div>
     `
     :`
      <div class="instruction-item">
       <strong>Anti-Cheat Disabled</strong>
       <span>
        Proctoring restrictions are disabled
        for this examination.
       </span>
      </div>
     `
    }

    <div class="instruction-item">
     <strong>Submission</strong>
     <span>
      Complete and submit the Google Form,
      then click Submit Exam in Proctor+.
     </span>
    </div>
   </div>

   ${
    resume
    ?`
     <div class="exam-notice">
      An unfinished examination session was
      found. You will resume that session.
     </div>
    `
    :''
   }

   <div class="modal-actions">
    <button class="secondary-btn"
     data-action="close-modal">
     Cancel
    </button>

    <button class="primary-btn"
     data-action="confirm-start"
     data-id="${esc(e.id)}">
     ${resume?'Resume Examination':'Start Examination'}
    </button>
   </div>
  </div>
 `;

 document.body.appendChild(modal);

 bindActions();
}

function closeModal(){
 const modal=document.getElementById('start-modal');

 if(modal){
  modal.remove();
 }
}

function confirmStart(id){
 db=loadDB();

 const u=currentUser();

 if(!u){
  logout();
  return;
 }

 const e=db.exams.find(x=>x.id===id);

 if(!e){
  toast('Examination not found.','error');
  return;
 }

 const assigned=getAssignedExamsForUser(u)
  .some(x=>x.id===e.id);

 if(!assigned){
  toast(
   'This examination is not assigned to your account.',
   'error'
  );
  return;
 }

 if(!isExamAvailable(e)){
  toast(
   'This examination is currently unavailable.',
   'error'
  );
  return;
 }

 const completed=getCompletedAttempt(e.id,u);

 if(completed){
  toast(
   'This examination has already been completed.',
   'error'
  );
  return;
 }

 closeModal();

 let attempt=getActiveAttempt(e.id,u);
 let resume=!!attempt;

 if(!attempt){
  attempt={
   id:uid('attempt'),
   examId:e.id,
   examTitle:e.title,
   userId:u.id,
   username:u.username,
   status:'In Progress',
   startedAt:Date.now(),
   endedAt:null,
   durationSeconds:0,
   violations:0
  };

  db.attempts.push(attempt);
  saveDB();
 }

 currentExam=e;

 const elapsed=Math.max(
  0,
  Math.floor(
   (Date.now()-Number(attempt.startedAt||Date.now()))/1000
  )
 );

 const totalSeconds=e.timerEnabled
  ?Math.max(
   60,
   Math.round(
    Number(e.durationMinutes)||60
   )*60
  )
  :0;

 const remaining=e.timerEnabled
  ?Math.max(0,totalSeconds-elapsed)
  :0;

 examState={
  attemptId:attempt.id,
  active:true,
  antiCheat:e.antiCheat===true,
  maxViolations:Math.max(
   1,
   Number(e.maxViolations)||3
  ),
  timerEnabled:e.timerEnabled===true,
  seconds:remaining,
  startedAt:attempt.startedAt
 };

 lastViolation=0;
 graceUntil=Date.now()+GRACE;

 const title=$('#live-exam-title');

 if(title){
  title.textContent=e.title;
 }

 const examiner=$('#live-exam-examiner');

 if(examiner){
  examiner.textContent=u.username;
 }

 const violation=$('#exam-violations');

 if(violation){
  violation.textContent=
   `${attempt.violations||0} / ${examState.maxViolations}`;
 }

 const instructions=$('#exam-instructions');

 if(instructions){
  instructions.innerHTML=
   e.antiCheat
   ?`
    <strong>Proctored Examination</strong>
    <span>
     Keep this examination in full screen.
     Tab switching, focus loss and restricted
     actions may be recorded.
    </span>
   `
   :`
    <strong>Examination</strong>
    <span>
     Complete the Google Form and use
     Submit Exam when finished.
    </span>
   `;
 }

 const iframe=$('#exam-iframe');

 if(iframe){
  loadGoogleForm(e.formUrl);
 }

 showView('exam');

 document.body.classList.add('lockdown-active');

 $('#exam-view')?.classList.add(
  'lockdown-active'
 );

 graceUntil=Date.now()+GRACE;

 if(e.antiCheat){
  requestFullscreen().finally(()=>{
   graceUntil=Date.now()+GRACE;
  });
 }

 renderTimer();

 if(e.timerEnabled){
  startTimer();
 }

 if(e.timerEnabled&&remaining<=0){
  finishExam(
   'Time Expired',
   'Time Expired',
   'Your allotted examination time has ended.',
   '⌛'
  );
 }
}

/* GOOGLE FORMS REFRESH */

function loadGoogleForm(url){
 const iframe=$('#exam-iframe');

 if(!iframe||!url)return;

 // Always clear the previous Google Form instance first.
 iframe.src='about:blank';

 iframe.removeAttribute('srcdoc');

 const base=String(url).trim();

 const separator=
  base.includes('?')
   ?'&'
   :'?';

 // Cache-busting parameter forces the browser to request
 // a fresh iframe instance for every examination session.
 const freshUrl=
  `${base}${separator}`+
  `proctor_refresh=${Date.now()}_`+
  `${Math.random().toString(36).slice(2,8)}`;

 window.setTimeout(()=>{
  if($('#exam-iframe')===iframe){
   iframe.src=freshUrl;
  }
 },100);
}

function reloadCurrentGoogleForm(){
 if(!currentExam?.formUrl)return;

 loadGoogleForm(currentExam.formUrl);
}

/* FULLSCREEN */

function requestFullscreen(){
 const el=document.documentElement;

 const fn=
  el.requestFullscreen||
  el.webkitRequestFullscreen||
  el.mozRequestFullScreen;

 return fn
  ?Promise.resolve(fn.call(el)).catch(()=>{})
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

/* TIMER */

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

 const duration=Math.max(
  1,
  Math.round(
   Number(currentExam?.durationMinutes)||60
  )
 );

 const pct=examState?.timerEnabled
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
 if(!examState?.active||
    !examState.antiCheat){
  return;
 }

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

 const violationEl=$('#exam-violations');

 if(violationEl){
  violationEl.textContent=
   `${n} / ${examState.maxViolations}`;
 }

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
 if(!examState?.active||
    !examState.antiCheat){
  return;
 }

 violationOverlayOpen=true;

 const reasonEl=$('#violation-reason');

 if(reasonEl){
  reasonEl.textContent=reason;
 }

 const a=db.attempts.find(
  x=>x.id===examState.attemptId
 );

 const countEl=$('#overlay-count');

 if(countEl){
  countEl.textContent=a?.violations||0;
 }

 const maxEl=$('#overlay-max');

 if(maxEl){
  maxEl.textContent=examState.maxViolations;
 }

 const overlay=$('#violation-overlay');

 if(overlay){
  overlay.hidden=false;
 }

 const iframe=$('#exam-iframe');

 if(iframe){
  iframe.style.filter=
   'blur(6px) brightness(.45)';
 }
}

$('#resume-exam-btn')?.addEventListener(
 'click',
 async()=>{
  if(!examState?.active)return;

  const overlay=$('#violation-overlay');

  if(overlay){
   overlay.hidden=true;
  }

  violationOverlayOpen=false;

  const iframe=$('#exam-iframe');

  if(iframe){
   iframe.style.filter='';
  }

  graceUntil=Date.now()+GRACE;

  await requestFullscreen();

  graceUntil=Date.now()+GRACE;
 }
);

[
 'fullscreenchange',
 'webkitfullscreenchange',
 'mozfullscreenchange'
].forEach(ev=>{
 document.addEventListener(ev,()=>{
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
 });
});

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
  if(examState?.active){
   e.preventDefault();
  }
 }
);

document.addEventListener(
 'copy',
 e=>{
  if(examState?.active){
   e.preventDefault();
  }
 }
);

document.addEventListener(
 'cut',
 e=>{
  if(examState?.active){
   e.preventDefault();
  }
 }
);

document.addEventListener(
 'paste',
 e=>{
  if(examState?.active){
   e.preventDefault();
  }
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
     ].filter(Boolean).join('+')
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

$('#exam-submit-btn')?.addEventListener(
 'click',
 ()=>{
  if(!examState?.active)return;

  const ok=confirm(
   'Confirm that you have submitted the Google Form. '+
   'This will permanently end this exam attempt '+
   'and cannot be undone.'
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

 timer=null;

 const a=db.attempts.find(
  x=>x.id===examState.attemptId
 );

 if(a){
  a.status=status;
  a.endedAt=Date.now();

  a.durationSeconds=Math.max(
   0,
   Math.floor(
    (
     Number(a.endedAt)-
     Number(a.startedAt||a.endedAt)
    )/1000
   )
  );
 }

 saveDB();

 const overlay=$('#violation-overlay');

 if(overlay){
  overlay.hidden=true;
 }

 violationOverlayOpen=false;

 document.body.classList.remove(
  'lockdown-active'
 );

 $('#exam-view')?.classList.remove(
  'lockdown-active'
 );

 exitFullscreen();

 const resultIcon=$('#result-icon');

 if(resultIcon){
  resultIcon.textContent=icon;

  resultIcon.style.color=
   terminated
   ?'var(--danger)'
   :'var(--success)';

  resultIcon.style.background=
   terminated
   ?'rgba(239,91,103,.12)'
   :'rgba(49,196,141,.12)';
 }

 const eyebrow=$('#result-eyebrow');

 if(eyebrow){
  eyebrow.textContent=
   terminated
   ?'EXAM TERMINATED'
   :status==='Time Expired'
    ?'TIME EXPIRED'
    :'EXAM COMPLETE';
 }

 const resultTitle=$('#result-title');

 if(resultTitle){
  resultTitle.textContent=title;
 }

 const resultMessage=$('#result-message');

 if(resultMessage){
  resultMessage.textContent=message;
 }

 const resultExam=$('#result-exam');

 if(resultExam){
  resultExam.textContent=
   currentExam?.title||'—';
 }

 const resultUser=$('#result-user');

 if(resultUser){
  resultUser.textContent=
   currentUser()?.username||'—';
 }

 const resultViolations=$('#result-violations');

 if(resultViolations){
  resultViolations.textContent=
   a?.violations||0;
 }

 const resultEnded=$('#result-ended');

 if(resultEnded){
  resultEnded.textContent=
   fmtDate(Date.now());
 }

 const resultTime=$('#result-time');

 if(resultTime){
  resultTime.textContent=
   formatDuration(
    a?.durationSeconds||0
   );
 }

 showView('result');
}

$('#result-dashboard-btn')?.addEventListener(
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
       ?.textContent
       .toLowerCase()
       .replace(' ','-')||
      'dashboard'
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

 const u=db.users.find(x=>x.id===id);

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
 if(!confirm(
  'Reset all demo data, exams, attempts and violation logs?'
 ))return;

 db=clone(seed);

 saveDB();

 toast(
  'Demo data reset.',
  'success'
 );

 openAdmin();
}

/* CLOCKS */

setInterval(()=>{
 const now=new Date().toLocaleString();

 const adminClock=$('#admin-clock');
 const examinerClock=$('#examiner-clock');

 if(adminClock){
  adminClock.textContent=now;
 }

 if(examinerClock){
  examinerClock.textContent=now;
 }
},1000);

/* SAFE STARTUP */

function initializePortal(){
 const required=[
  'login-view',
  'admin-view',
  'admin-dashboard-page',
  'examiner-view',
  'examiner-dashboard-page',
  'exam-view',
  'exam-iframe',
  'result-view'
 ];

 const missing=required.filter(
  id=>!document.getElementById(id)
 );

 if(missing.length){
  console.error(
   'Secure Exam Portal is missing required UI elements:',
   missing
  );
 }

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

 if(session&&currentUser()){
  openPortal();
 }else{
  session=null;

  saveSession();

  showView('login');

  hideLoading();
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
