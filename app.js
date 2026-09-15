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

const DEFAULT_FORM=
  'https://docs.google.com/forms/d/e/1FAIpQLSf_PLACEHOLDER_FORM_ID/viewform?embedded=true';

const seed={
 users:[
  {
   id:'u-admin',
   username:'admin',
   password:'123admin',
   role:'admin',
   name:'Administrator'
  },
  {
   id:'u-test',
   username:'test',
   password:'test',
   role:'examiner',
   name:'Test Examiner'
  }
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


/* =========================================================
   GENERAL HELPERS
========================================================= */

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
 Object.values(views).forEach(v=>{
  if(v)v.hidden=true;
 });

 if(views[name]){
  views[name].hidden=false;
 }

 window.scrollTo(0,0);
}

function toast(msg,type=''){
 const container=$('#toast-container');

 if(!container){
  console.log(msg);
  return;
 }

 const d=document.createElement('div');

 d.className='toast '+type;
 d.textContent=msg;

 container.appendChild(d);

 setTimeout(()=>{
  d.remove();
 },3000);
}


/* =========================================================
   DATABASE
========================================================= */

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


 /*
  Always repair the built-in demo accounts.
  This prevents the default credentials from disappearing
  after localStorage is modified or partially corrupted.
 */

 seed.users.forEach(su=>{

  const existing=users.find(
   u=>String(u?.username||'')
    .trim()
    .toLowerCase()===su.username.toLowerCase()
  );

  if(!existing){

   users.push(clone(su));

  }else if(
   su.username==='admin' ||
   su.username==='test'
  ){

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

  exams:
   Array.isArray(x.exams)&&x.exams.length
    ?x.exams
    :clone(seed.exams),

  attempts:
   Array.isArray(x.attempts)
    ?x.attempts
    :[],

  violations:
   Array.isArray(x.violations)
    ?x.violations
    :[],

  theme:
   x.theme==='light'
    ?'light'
    :'dark'
 };


 /*
  Always keep at least one valid exam.
 */
 if(
  !Array.isArray(repaired.exams) ||
  !repaired.exams.length
 ){
  repaired.exams=clone(seed.exams);
 }


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

  safeRemove(
   sessionStorage,
   SESSION
  );

 }

}


/* =========================================================
   THEME
========================================================= */

function applyTheme(){

 const light=db.theme==='light';

 document.documentElement.dataset.theme=
  light?'light':'dark';

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
 ].forEach(id=>{

  const b=$('#'+id);

  if(b){

   b.textContent=
    light
     ?'☾'
     :'☼';

   b.setAttribute(
    'aria-label',
    light
     ?'Switch to dark mode'
     :'Switch to light mode'
   );

   b.title=
    light
     ?'Switch to dark mode'
     :'Switch to light mode';

  }

 });

}

function toggleTheme(){

 db.theme=
  db.theme==='light'
   ?'dark'
   :'light';

 saveDB();

 applyTheme();

}


/* =========================================================
   AUTHENTICATION
========================================================= */

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

  showLoginError(
   'Login form could not be loaded. Please refresh the page.'
  );

  return false;

 }


 const username=
  String(usernameEl.value||'').trim();

 const password=
  String(passwordEl.value||'');


 if(!username||!password){

  showLoginError(
   'Please enter both your username and password.'
  );

  (!username?usernameEl:passwordEl).focus();

  return false;

 }


 /*
  Refresh database before checking credentials.
 */
 db=loadDB();


 /*
  Built-in credentials.
 */
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

  String(u?.username||'')
   .trim()
   .toLowerCase()===key &&

  String(u?.password??'')===password

 );


 /*
  Final fallback if localStorage is somehow damaged.
 */
 if(
  !user &&
  fallback[key] &&
  fallback[key].password===password
 ){

  user={
   id:fallback[key].id,
   username:key,
   password:password,
   role:fallback[key].role,
   name:fallback[key].name
  };


  if(!db.users.some(u=>u.id===user.id)){

   db.users.push(
    clone(user)
   );

   saveDB();

  }

 }


 if(!user){

  showLoginError(
   'Incorrect username or password. Please check your credentials and try again.'
  );

  passwordEl.value='';
  passwordEl.focus();


  if(form){

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

 form.addEventListener(
  'submit',
  handleLogin
 );

 form.dataset.authBound='1';

}

function currentUser(){

 if(!session)return null;

 return db.users.find(
  u=>u.id===session.userId
 ) ||

 db.users.find(
  u=>
   String(u.username||'')
    .toLowerCase()===
   String(session.username||'')
    .toLowerCase()
 );

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

 document.body.classList.remove(
  'lockdown-active'
 );

 $('#exam-view')?.classList.remove(
  'lockdown-active'
 );

 syncViolationOverlay();

 showView('login');

 $('#login-form')?.reset();

 clearLoginError();

}

function clearBrokenSession(){

 if(
  session &&
  !currentUser()
 ){

  session=null;

  saveSession();

 }

}


/* =========================================================
   SIDEBAR / PAGE NAVIGATION
========================================================= */

$$('[data-toggle-sidebar]').forEach(b=>{

 b.addEventListener(
  'click',
  ()=>{
   $('#'+b.dataset.toggleSidebar)
    ?.classList.toggle('open');
  }
 );

});


$$('[data-admin-page]').forEach(b=>{

 b.addEventListener(
  'click',
  ()=>adminPage(
   b.dataset.adminPage
  )
 );

});


$$('[data-examiner-page]').forEach(b=>{

 b.addEventListener(
  'click',
  ()=>examinerPage(
   b.dataset.examinerPage
  )
 );

});


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


 $('#admin-user-name').textContent=
  u.name||u.username;

 $('#admin-user-role').textContent=
  'Administrator';

 $('#admin-avatar').textContent=
  (u.name||u.username)[0].toUpperCase();


 showView('admin');

 adminPage('dashboard');

}


function adminPage(page){

 page=
  pageTitles[page]
   ?page
   :'dashboard';


 $$('[data-admin-page]').forEach(b=>{

  b.classList.toggle(
   'active',
   b.dataset.adminPage===page
  );

 });


 $$('.admin-page').forEach(p=>{
  p.classList.remove('active');
 });


 const target=$(
  '#admin-'+page+'-page'
 );


 if(target){

  target.classList.add('active');

 }


 const title=$('#admin-page-title');

 if(title){

  title.textContent=
   pageTitles[page]||'Dashboard';

 }


 $('#admin-sidebar')
  ?.classList.remove('open');


 renderAdminPage(page);

}


function renderAdminPage(page){

 const renderers={

  dashboard:renderAdminDashboard,
  exams:renderAdminExams,
  submissions:renderSubmissions,
  violations:renderViolations,
  analytics:renderAnalytics,
  settings:renderSettings

 };

 if(renderers[page]){

  renderers[page]();

 }

}


/* =========================================================
   ADMIN DASHBOARD
========================================================= */

function renderAdminDashboard(){

 const el=$('#admin-dashboard-page');

 if(!el)return;


 const totalExams=db.exams.length;

 const totalAttempts=db.attempts.length;

 const completed=db.attempts.filter(
  a=>a.status==='Completed'
 ).length;

 const inProgress=db.attempts.filter(
  a=>a.status==='In Progress'
 ).length;

 const terminated=db.attempts.filter(
  a=>
   a.status==='Terminated' ||
   a.status==='Time Expired'
 ).length;

 const totalViolations=db.violations.length;


 const completedPct=
  totalAttempts
   ?Math.round(
     (completed/totalAttempts)*100
    )
   :0;


 const violationPct=
  totalAttempts
   ?Math.min(
     100,
     Math.round(
      (totalViolations/totalAttempts)*100
     )
    )
   :0;


 const recent=db.attempts
  .slice()
  .sort(
   (a,b)=>
    (b.startedAt||0)-
    (a.startedAt||0)
  )
  .slice(0,6);


 el.innerHTML=`

 <div class="stats-grid">

  <div class="stat-card">
   <span class="stat-label">Total Exams</span>
   <strong>${totalExams}</strong>
   <small>Configured examinations</small>
  </div>

  <div class="stat-card">
   <span class="stat-label">Total Submissions</span>
   <strong>${totalAttempts}</strong>
   <small>All recorded attempts</small>
  </div>

  <div class="stat-card">
   <span class="stat-label">Completed</span>
   <strong>${completed}</strong>
   <small>${completedPct}% completion rate</small>
  </div>

  <div class="stat-card">
   <span class="stat-label">Violations</span>
   <strong>${totalViolations}</strong>
   <small>${violationPct}% per recorded attempt</small>
  </div>

 </div>


 <div class="dashboard-grid">

  <section class="panel">

   <div class="panel-header">
    <div>
     <h3>Submission Progress</h3>
     <p>Current examination activity.</p>
    </div>
   </div>

   <div class="progress-summary">

    <div class="progress-item">
     <div class="progress-meta">
      <span>Completed</span>
      <strong>${completed}</strong>
     </div>

     <div class="progress-track">
      <span style="width:${completedPct}%"></span>
     </div>
    </div>


    <div class="progress-item">
     <div class="progress-meta">
      <span>In Progress</span>
      <strong>${inProgress}</strong>
     </div>

     <div class="progress-track">
      <span style="width:${
       totalAttempts
        ?Math.round(
          (inProgress/totalAttempts)*100
         )
        :0
      }%"></span>
     </div>
    </div>


    <div class="progress-item">
     <div class="progress-meta">
      <span>Terminated / Expired</span>
      <strong>${terminated}</strong>
     </div>

     <div class="progress-track">
      <span style="width:${
       totalAttempts
        ?Math.round(
          (terminated/totalAttempts)*100
         )
        :0
      }%"></span>
     </div>
    </div>

   </div>

  </section>


  <section class="panel">

   <div class="panel-header">
    <div>
     <h3>Recent Submissions</h3>
     <p>Latest examiner activity.</p>
    </div>

    <button
     class="secondary-btn"
     data-action="view-submissions">
     View All
    </button>
   </div>


   <div class="table-wrap">

    <table>

     <thead>
      <tr>
       <th>Exam</th>
       <th>Examiner</th>
       <th>Status</th>
       <th>Date</th>
      </tr>
     </thead>

     <tbody>

      ${
       recent.length
       ?recent.map(a=>`

        <tr>

         <td>${esc(a.examTitle)}</td>

         <td>${esc(a.username)}</td>

         <td>
          <span class="status-pill ${statusClass(a.status)}">
           ${esc(a.status)}
          </span>
         </td>

         <td>${fmtDate(a.startedAt)}</td>

        </tr>

       `).join('')
       :`
        <tr>
         <td colspan="4" class="empty-cell">
          No submissions yet.
         </td>
        </tr>
       `
      }

     </tbody>

    </table>

   </div>

  </section>

 </div>


 <section class="panel">

  <div class="panel-header">

   <div>
    <h3>Exam Overview</h3>
    <p>Current exam configuration.</p>
   </div>

   <button
    class="primary-btn"
    data-action="new-exam">
    + Add Exam
   </button>

  </div>


  <div class="exam-overview-grid">

   ${
    db.exams.length
    ?db.exams.map(e=>`

     <div class="exam-mini-card">

      <div class="exam-mini-top">

       <div>
        <span class="eyebrow">EXAM</span>
        <h4>${esc(e.title)}</h4>
       </div>

       <span class="status-pill ${
        e.active?'status-success':'status-muted'
       }">
        ${e.active?'Active':'Inactive'}
       </span>

      </div>

      <p>${esc(e.description||'No description.')}</p>

      <div class="mini-meta">
       <span>
        ${e.timerEnabled
         ?`${e.durationMinutes} min`
         :'No Timer'}
       </span>

       <span>
        ${e.antiCheat
         ?'Anti-cheat On'
         :'Anti-cheat Off'}
       </span>

       <span>
        ${esc(e.examinerUsername||'—')}
       </span>
      </div>

     </div>

    `).join('')
    :`
     <div class="empty-state">
      No examinations configured.
     </div>
    `
   }

  </div>

 </section>

 `;

 bindActions();

}


/* =========================================================
   EXAM MANAGEMENT
========================================================= */

function renderAdminExams(){

 const el=$('#admin-exams-page');

 if(!el)return;


 const maxExams=6;

 el.innerHTML=`

 <div class="page-heading-row">

  <div>
   <h2>Exam Management</h2>
   <p>
    Create and manage examinations, Google Forms,
    examiner access, timers and anti-cheat settings.
   </p>
  </div>

  <button
   class="primary-btn"
   data-action="new-exam"
   ${db.exams.length>=maxExams?'disabled':''}>
   + Add Examination
  </button>

 </div>


 <div class="capacity-note">
  ${db.exams.length} / ${maxExams} examination slots used.
  Deleted exams free a slot.
 </div>


 <div class="exam-management-grid">

 ${
  db.exams.length
  ?db.exams.map(e=>{

   const attemptCount=
    db.attempts.filter(
     a=>a.examId===e.id
    ).length;

   return `

    <article class="exam-management-card">

     <div class="exam-card-header">

      <div>

       <span class="eyebrow">EXAMINATION</span>

       <h3>${esc(e.title)}</h3>

      </div>

      <span class="status-pill ${
       e.active
        ?'status-success'
        :'status-muted'
      }">
       ${e.active?'Active':'Inactive'}
      </span>

     </div>


     <p class="exam-description">
      ${esc(
       e.description||
       'No description provided.'
      )}
     </p>


     <div class="exam-detail-grid">

      <div>
       <span>Examiner</span>
       <strong>${esc(e.examinerUsername||'—')}</strong>
      </div>

      <div>
       <span>Attempts</span>
       <strong>${attemptCount}</strong>
      </div>

      <div>
       <span>Timer</span>
       <strong>
        ${
         e.timerEnabled
          ?`${e.durationMinutes} min`
          :'Off'
        }
       </strong>
      </div>

      <div>
       <span>Anti-Cheat</span>
       <strong>
        ${e.antiCheat?'Enabled':'Disabled'}
       </strong>
      </div>

     </div>


     <div class="exam-schedule">

      <div>
       <span>Available From</span>
       <strong>
        ${e.startAt
         ?fmtDate(e.startAt)
         :'Immediately'}
       </strong>
      </div>

      <div>
       <span>Available Until</span>
       <strong>
        ${e.endAt
         ?fmtDate(e.endAt)
         :'No End Date'}
       </strong>
      </div>

     </div>


     <div class="exam-card-actions">

      <button
       class="secondary-btn"
       data-action="edit-exam"
       data-id="${e.id}">
       Edit
      </button>

      <button
       class="danger-btn"
       data-action="delete-exam"
       data-id="${e.id}">
       Delete
      </button>

     </div>

    </article>

   `;

  }).join('')
  :`
   <div class="empty-state">
    No examinations available.
   </div>
  `
 }

 </div>

 `;

 bindActions();

}


/* =========================================================
   EXAM MODAL
========================================================= */

function openExamModal(id=''){

 const existing=
  id
   ?db.exams.find(e=>e.id===id)
   :null;

 const isEdit=!!existing;

 if(
  !isEdit &&
  db.exams.length>=6
 ){

  toast(
   'Maximum of 6 examinations allowed.',
   'error'
  );

  return;

 }


 const e=existing||{

  id:'',
  title:'',
  description:'',
  formUrl:'',
  examinerUsername:'',
  examinerPassword:'',
  antiCheat:true,
  maxViolations:3,
  timerEnabled:true,
  durationMinutes:60,
  startAt:'',
  endAt:'',
  active:true

 };


 const root=$('#modal-root');

 if(!root)return;


 root.hidden=false;


 root.innerHTML=`

 <div class="modal-backdrop">

  <div class="modal-card large-modal">

   <div class="modal-header">

    <div>
     <span class="eyebrow">
      ${isEdit?'EDIT EXAMINATION':'NEW EXAMINATION'}
     </span>

     <h2>
      ${isEdit
       ?'Edit Examination'
       :'Create Examination'}
     </h2>
    </div>

    <button
     class="icon-btn"
     data-action="close-modal"
     type="button">
     ×
    </button>

   </div>


   <form
    id="exam-form"
    class="modal-form">

    <div class="form-grid">

     <div class="field-full">

      <label>Exam Title</label>

      <input
       id="exam-title"
       type="text"
       required
       value="${esc(e.title)}"
       placeholder="e.g. HR Certification Examination">

     </div>


     <div class="field-full">

      <label>Description</label>

      <textarea
       id="exam-description"
       rows="3"
       placeholder="Brief description of the examination.">${esc(e.description||'')}</textarea>

     </div>


     <div class="field-full">

      <label>Google Form URL</label>

      <input
       id="exam-form-url"
       type="url"
       required
       value="${esc(e.formUrl||'')}"
       placeholder="https://docs.google.com/forms/...">

      <small>
       The Google Form will be displayed inside the examination portal.
      </small>

     </div>


     <div>

      <label>Examiner Username</label>

      <input
       id="examiner-username"
       type="text"
       required
       value="${esc(e.examinerUsername||'')}"
       placeholder="test">

     </div>


     <div>

      <label>Examiner Password</label>

      <input
       id="examiner-password"
       type="text"
       required
       value="${esc(e.examinerPassword||'')}"
       placeholder="test">

     </div>


     <div>

      <label>Availability Start</label>

      <input
       id="exam-start"
       type="datetime-local"
       value="${toLocalDateTime(e.startAt)}">

     </div>


     <div>

      <label>Availability End</label>

      <input
       id="exam-end"
       type="datetime-local"
       value="${toLocalDateTime(e.endAt)}">

     </div>


     <div>

      <label class="checkbox-row">

       <input
        id="exam-active"
        type="checkbox"
        ${e.active!==false?'checked':''}>

       <span>Exam is Active</span>

      </label>

     </div>


     <div>

      <label class="checkbox-row">

       <input
        id="exam-timer"
        type="checkbox"
        ${e.timerEnabled?'checked':''}>

       <span>Enable Timer</span>

      </label>

     </div>


     <div>

      <label>Duration in Minutes</label>

      <input
       id="exam-duration"
       type="number"
       min="1"
       max="600"
       value="${Number(e.durationMinutes)||60}">

     </div>


     <div>

      <label class="checkbox-row">

       <input
        id="exam-anticheat"
        type="checkbox"
        ${e.antiCheat?'checked':''}>

       <span>Enable Anti-Cheat</span>

      </label>

     </div>


     <div>

      <label>Maximum Violations</label>

      <input
       id="exam-max-violations"
       type="number"
       min="1"
       max="20"
       value="${Number(e.maxViolations)||3}">

     </div>

    </div>


    <div
     id="exam-form-error"
     class="form-error"
     hidden>
    </div>


    <div class="modal-footer">

     <button
      class="secondary-btn"
      data-action="close-modal"
      type="button">
      Cancel
     </button>

     <button
      class="primary-btn"
      type="submit">
      ${isEdit?'Save Changes':'Create Examination'}
     </button>

    </div>

   </form>

  </div>

 </div>

 `;


 $('#exam-form')?.addEventListener(
  'submit',
  event=>{
   event.preventDefault();
   saveExam(isEdit?e.id:null);
  }
 );


 bindActions();

}


function toLocalDateTime(value){

 if(!value)return '';

 const d=new Date(value);

 if(Number.isNaN(d.getTime()))return '';

 const pad=n=>String(n).padStart(2,'0');

 return d.getFullYear()+
  '-'+pad(d.getMonth()+1)+
  '-'+pad(d.getDate())+
  'T'+pad(d.getHours())+
  ':'+pad(d.getMinutes());

}


function saveExam(id){

 const title=
  String($('#exam-title')?.value||'').trim();

 const description=
  String($('#exam-description')?.value||'').trim();

 const formUrl=
  String($('#exam-form-url')?.value||'').trim();

 const examinerUsername=
  String($('#examiner-username')?.value||'').trim();

 const examinerPassword=
  String($('#examiner-password')?.value||'').trim();

 const startRaw=
  String($('#exam-start')?.value||'').trim();

 const endRaw=
  String($('#exam-end')?.value||'').trim();

 const active=
  !!$('#exam-active')?.checked;

 const timerEnabled=
  !!$('#exam-timer')?.checked;

 const antiCheat=
  !!$('#exam-anticheat')?.checked;

 const durationMinutes=
  Math.max(
   1,
   Number($('#exam-duration')?.value)||60
  );

 const maxViolations=
  Math.max(
   1,
   Number($('#exam-max-violations')?.value)||3
  );


 const error=$('#exam-form-error');


 if(
  !title||
  !formUrl||
  !examinerUsername||
  !examinerPassword
 ){

  if(error){

   error.textContent=
    'Please complete all required fields.';

   error.hidden=false;

  }

  return;

 }


 let startAt='';
 let endAt='';

 if(startRaw){

  const d=new Date(startRaw);

  if(!Number.isNaN(d.getTime())){

   startAt=d.toISOString();

  }

 }

 if(endRaw){

  const d=new Date(endRaw);

  if(!Number.isNaN(d.getTime())){

   endAt=d.toISOString();

  }

 }


 if(
  startAt &&
  endAt &&
  new Date(endAt)<=new Date(startAt)
 ){

  if(error){

   error.textContent=
    'The end date/time must be later than the start date/time.';

   error.hidden=false;

  }

  return;

 }


 /*
  Create or update examiner account.
 */
 let examiner=db.users.find(
  u=>
   String(u.username||'').toLowerCase()===
   examinerUsername.toLowerCase()
 );


 if(examiner){

  if(examiner.role!=='admin'){

   examiner.password=examinerPassword;
   examiner.role='examiner';

  }

 }else{

  examiner={
   id:uid('user'),
   username:examinerUsername,
   password:examinerPassword,
   role:'examiner',
   name:examinerUsername
  };

  db.users.push(examiner);

 }


 if(id){

  const existing=db.exams.find(
   x=>x.id===id
  );

  if(existing){

   existing.title=title;
   existing.description=description;
   existing.formUrl=formUrl;
   existing.examinerUsername=examinerUsername;
   existing.examinerPassword=examinerPassword;
   existing.antiCheat=antiCheat;
   existing.maxViolations=maxViolations;
   existing.timerEnabled=timerEnabled;
   existing.durationMinutes=durationMinutes;
   existing.startAt=startAt;
   existing.endAt=endAt;
   existing.active=active;

  }

  toast(
   'Examination updated successfully.',
   'success'
  );

 }else{

  db.exams.push({

   id:uid('exam'),
   title,
   description,
   formUrl,
   examinerUsername,
   examinerPassword,
   antiCheat,
   maxViolations,
   timerEnabled,
   durationMinutes,
   startAt,
   endAt,
   active,
   createdAt:Date.now(),
   createdBy:currentUser()?.id||'u-admin'

  });

  toast(
   'Examination created successfully.',
   'success'
  );

 }


 saveDB();

 closeModal();

 renderAdminExams();

}


function deleteExam(id){

 const exam=
  db.exams.find(
   e=>e.id===id
  );

 if(!exam)return;


 if(
  !confirm(
   `Delete "${exam.title}"?\n\nThis will remove the examination configuration. Existing submission records will remain.`
  )
 )return;


 db.exams=
  db.exams.filter(
   e=>e.id!==id
  );


 saveDB();

 toast(
  'Examination deleted.',
  'success'
 );

 renderAdminExams();

}


function closeModal(){

 const root=$('#modal-root');

 if(root){

  root.hidden=true;
  root.innerHTML='';

 }

}


/* =========================================================
   SUBMISSIONS
========================================================= */

function renderSubmissions(){

 const el=$('#admin-submissions-page');

 if(!el)return;


 const attempts=db.attempts
  .slice()
  .sort(
   (a,b)=>
    (b.startedAt||0)-
    (a.startedAt||0)
  );


 el.innerHTML=`

 <div class="page-heading-row">

  <div>
   <h2>Submissions</h2>
   <p>Monitor all examination attempts.</p>
  </div>

 </div>


 <section class="panel">

  <div class="table-wrap">

   <table>

    <thead>

     <tr>
      <th>Exam</th>
      <th>Examiner</th>
      <th>Status</th>
      <th>Violations</th>
      <th>Started</th>
      <th>Ended</th>
     </tr>

    </thead>


    <tbody>

     ${
      attempts.length
      ?attempts.map(a=>`

       <tr>

        <td>${esc(a.examTitle)}</td>

        <td>${esc(a.username)}</td>

        <td>
         <span class="status-pill ${statusClass(a.status)}">
          ${esc(a.status)}
         </span>
        </td>

        <td>
         ${a.violations||0}
        </td>

        <td>
         ${fmtDate(a.startedAt)}
        </td>

        <td>
         ${fmtDate(a.endedAt)}
        </td>

       </tr>

      `).join('')
      :`
       <tr>
        <td colspan="6" class="empty-cell">
         No examination submissions recorded.
        </td>
       </tr>
      `
     }

    </tbody>

   </table>

  </div>

 </section>

 `;

}


/* =========================================================
   VIOLATIONS
========================================================= */

function renderViolations(){

 const el=$('#admin-violations-page');

 if(!el)return;


 const logs=db.violations
  .slice()
  .sort(
   (a,b)=>
    (b.timestamp||0)-
    (a.timestamp||0)
  );


 el.innerHTML=`

 <div class="page-heading-row">

  <div>
   <h2>Violation Logs</h2>
   <p>Recorded anti-cheat events during examinations.</p>
  </div>

 </div>


 <section class="panel">

  <div class="table-wrap">

   <table>

    <thead>

     <tr>
      <th>Date</th>
      <th>Exam</th>
      <th>Examiner</th>
      <th>Violation #</th>
      <th>Reason</th>
     </tr>

    </thead>


    <tbody>

     ${
      logs.length
      ?logs.map(v=>`

       <tr>

        <td>
         ${fmtDate(v.timestamp)}
        </td>

        <td>
         ${esc(v.examTitle)}
        </td>

        <td>
         ${esc(v.username)}
        </td>

        <td>
         ${v.number||0}
        </td>

        <td>
         ${esc(v.reason)}
        </td>

       </tr>

      `).join('')
      :`
       <tr>
        <td colspan="5" class="empty-cell">
         No violations recorded.
        </td>
       </tr>
      `
     }

    </tbody>

   </table>

  </div>

 </section>

 `;

}


/* =========================================================
   ANALYTICS
========================================================= */

function renderAnalytics(){

 const el=$('#admin-analytics-page');

 if(!el)return;


 const total=db.attempts.length;

 const completed=db.attempts.filter(
  a=>a.status==='Completed'
 ).length;

 const violations=db.violations.length;

 const terminated=db.attempts.filter(
  a=>
   a.status==='Terminated'||
   a.status==='Time Expired'
 ).length;


 const completedPct=
  total
   ?Math.round(completed/total*100)
   :0;

 const violationRate=
  total
   ?Math.round(violations/total*100)
   :0;

 const terminatedPct=
  total
   ?Math.round(terminated/total*100)
   :0;


 el.innerHTML=`

 <div class="page-heading-row">

  <div>
   <h2>Analytics</h2>
   <p>Overview of examination performance and security activity.</p>
  </div>

 </div>


 <div class="stats-grid">

  <div class="stat-card">
   <span class="stat-label">Completion Rate</span>
   <strong>${completedPct}%</strong>
   <small>${completed} completed of ${total} attempts</small>
  </div>

  <div class="stat-card">
   <span class="stat-label">Violation Rate</span>
   <strong>${violationRate}%</strong>
   <small>${violations} total violations</small>
  </div>

  <div class="stat-card">
   <span class="stat-label">Terminated / Expired</span>
   <strong>${terminatedPct}%</strong>
   <small>${terminated} attempts</small>
  </div>

  <div class="stat-card">
   <span class="stat-label">Active Exams</span>
   <strong>
    ${db.exams.filter(e=>e.active).length}
   </strong>
   <small>Currently configured</small>
  </div>

 </div>


 <section class="panel">

  <div class="panel-header">

   <div>
    <h3>Completion Progress</h3>
    <p>Percentage of recorded examination attempts.</p>
   </div>

  </div>


  <div class="progress-summary">

   <div class="progress-item">

    <div class="progress-meta">
     <span>Completed</span>
     <strong>${completedPct}%</strong>
    </div>

    <div class="progress-track">
     <span style="width:${completedPct}%"></span>
    </div>

   </div>


   <div class="progress-item">

    <div class="progress-meta">
     <span>Terminated / Expired</span>
     <strong>${terminatedPct}%</strong>
    </div>

    <div class="progress-track">
     <span style="width:${terminatedPct}%"></span>
    </div>

   </div>


   <div class="progress-item">

    <div class="progress-meta">
     <span>Violation Activity</span>
     <strong>${violationRate}%</strong>
    </div>

    <div class="progress-track">
     <span style="width:${Math.min(100,violationRate)}%"></span>
    </div>

   </div>

  </div>

 </section>

 `;

}


/* =========================================================
   SETTINGS
========================================================= */

function renderSettings(){

 const el=$('#admin-settings-page');

 if(!el)return;


 const examiners=db.users.filter(
  u=>u.role==='examiner'
 );


 el.innerHTML=`

 <div class="page-heading-row">

  <div>
   <h2>Settings</h2>
   <p>Manage examiner accounts and demo data.</p>
  </div>

 </div>


 <section class="panel">

  <div class="panel-header">

   <div>
    <h3>Examiner Accounts</h3>
    <p>Accounts created through examination setup.</p>
   </div>

  </div>


  <div class="table-wrap">

   <table>

    <thead>

     <tr>
      <th>Name</th>
      <th>Username</th>
      <th>Role</th>
      <th>Action</th>
     </tr>

    </thead>


    <tbody>

     ${
      examiners.length
      ?examiners.map(u=>`

       <tr>

        <td>
         ${esc(u.name||u.username)}
        </td>

        <td>
         ${esc(u.username)}
        </td>

        <td>
         <span class="status-pill status-success">
          Examiner
         </span>
        </td>

        <td>

         <button
          class="danger-btn small"
          data-action="delete-user"
          data-id="${u.id}">
          Delete
         </button>

        </td>

       </tr>

      `).join('')
      :`
       <tr>
        <td colspan="4" class="empty-cell">
         No examiner accounts.
        </td>
       </tr>
      `
     }

    </tbody>

   </table>

  </div>

 </section>


 <section class="panel danger-panel">

  <div class="panel-header">

   <div>
    <h3>Demo Data</h3>
    <p>
     Restore the default examination,
     users and logs.
    </p>
   </div>

   <button
    class="danger-btn"
    data-action="reset-demo">
    Reset Demo Data
   </button>

  </div>

 </section>

 `;

 bindActions();

}


/* =========================================================
   EXAMINER PORTAL
========================================================= */

function openExaminer(){

 const u=currentUser();

 if(!u){

  showView('login');

  return;

 }


 $('#examiner-user-name').textContent=
  u.name||u.username;

 $('#examiner-user-role').textContent=
  'Examiner';

 $('#examiner-avatar').textContent=
  (u.name||u.username)[0].toUpperCase();


 showView('examiner');

 examinerPage('dashboard');

}


function examinerPage(page){

 page=page||'dashboard';


 $$('[data-examiner-page]').forEach(b=>{

  b.classList.toggle(
   'active',
   b.dataset.examinerPage===page
  );

 });


 $$('.examiner-page').forEach(p=>{
  p.classList.remove('active');
 });


 const target=$(
  '#examiner-'+page+'-page'
 );


 if(target){

  target.classList.add('active');

 }


 const title=$('#examiner-page-title');

 if(title){

  title.textContent=
   page==='dashboard'
    ?'Dashboard'
    :'My Examinations';

 }


 renderExaminerPage(page);

}


function renderExaminerPage(page){

 if(page==='dashboard'){

  renderExaminerDashboard();

 }else{

  renderExaminerDashboard();

 }

}


function getAvailableExams(){

 const u=currentUser();

 if(!u)return[];


 const now=Date.now();


 return db.exams.filter(e=>{

  if(!e.active)return false;


  /*
   Match examiner account.
  */
  if(
   String(e.examinerUsername||'').toLowerCase()!==
   String(u.username||'').toLowerCase()
  ){

   return false;

  }


  /*
   Availability start.
  */
  if(
   e.startAt &&
   now<new Date(e.startAt).getTime()
  ){

   return false;

  }


  /*
   Availability end.
  */
  if(
   e.endAt &&
   now>new Date(e.endAt).getTime()
  ){

   return false;

  }


  /*
   Once taken, the examination cannot be retaken.
  */
  const attempt=db.attempts.find(
   a=>
    a.examId===e.id &&
    a.userId===u.id
  );


  if(attempt){

   return false;

  }


  return true;

 });

}


function renderExaminerDashboard(){

 const el=$('#examiner-dashboard-page');

 if(!el)return;


 const u=currentUser();

 if(!u)return;


 const assigned=db.exams.filter(
  e=>
   String(e.examinerUsername||'').toLowerCase()===
   String(u.username||'').toLowerCase()
 );


 const available=getAvailableExams();


 const taken=assigned.filter(
  e=>
   db.attempts.some(
    a=>
     a.examId===e.id &&
     a.userId===u.id
   )
 ).length;


 const completedPct=
  assigned.length
   ?Math.round(
    (taken/assigned.length)*100
   )
   :0;


 el.innerHTML=`

 <div class="page-heading-row">

  <div>

   <span class="eyebrow">
    EXAMINER PORTAL
   </span>

   <h2>Welcome, ${esc(u.name||u.username)}</h2>

   <p>
    Select an available examination to begin.
   </p>

  </div>

 </div>


 <div class="stats-grid">

  <div class="stat-card">
   <span class="stat-label">Assigned Exams</span>
   <strong>${assigned.length}</strong>
   <small>Examinations assigned to you</small>
  </div>

  <div class="stat-card">
   <span class="stat-label">Available</span>
   <strong>${available.length}</strong>
   <small>Ready to take</small>
  </div>

  <div class="stat-card">
   <span class="stat-label">Completed</span>
   <strong>${taken}</strong>
   <small>${completedPct}% completed</small>
  </div>

  <div class="stat-card">
   <span class="stat-label">Account</span>
   <strong>${esc(u.username)}</strong>
   <small>Authenticated examiner</small>
  </div>

 </div>


 <section class="panel">

  <div class="panel-header">

   <div>
    <h3>Examination Progress</h3>
    <p>Your assigned examination completion.</p>
   </div>

  </div>


  <div class="progress-summary">

   <div class="progress-item">

    <div class="progress-meta">
     <span>Completed</span>
     <strong>${completedPct}%</strong>
    </div>

    <div class="progress-track">
     <span style="width:${completedPct}%"></span>
    </div>

   </div>

  </div>

 </section>


 <section class="panel">

  <div class="panel-header">

   <div>
    <h3>Available Examinations</h3>
    <p>Only examinations currently assigned and available are shown.</p>
   </div>

  </div>


  <div class="exam-management-grid">

   ${
    available.length
    ?available.map(e=>`

     <article class="exam-management-card">

      <div class="exam-card-header">

       <div>

        <span class="eyebrow">
         AVAILABLE
        </span>

        <h3>
         ${esc(e.title)}
        </h3>

       </div>

       <span class="status-pill status-success">
        Ready
       </span>

      </div>


      <p class="exam-description">
       ${esc(
        e.description||
        'No description provided.'
       )}
      </p>


      <div class="exam-detail-grid">

       <div>
        <span>Timer</span>
        <strong>
         ${
          e.timerEnabled
           ?`${e.durationMinutes} min`
           :'No Timer'
         }
        </strong>
       </div>

       <div>
        <span>Anti-Cheat</span>
        <strong>
         ${e.antiCheat?'Enabled':'Disabled'}
        </strong>
       </div>

       <div>
        <span>Max Violations</span>
        <strong>
         ${e.maxViolations}
        </strong>
       </div>

      </div>


      <div class="exam-card-actions">

       <button
        class="primary-btn"
        data-action="start-exam"
        data-id="${e.id}">
        Start Examination →
       </button>

      </div>

     </article>

    `).join('')
    :`
     <div class="empty-state">

      ${
       assigned.length
        ?'You have no available examinations. Any assigned exam may already have been completed or may be outside its availability period.'
        :'No examinations have been assigned to your account.'
      }

     </div>
    `
   }

  </div>

 </section>

 `;


 bindActions();

}


/* =========================================================
   START EXAM
========================================================= */

function startExam(id){

 const e=db.exams.find(
  x=>x.id===id
 );

 if(!e)return;


 const u=currentUser();

 if(!u){

  showView('login');

  return;

 }


 const attempt=db.attempts.find(
  a=>
   a.examId===e.id &&
   a.userId===u.id
 );


 if(attempt){

  toast(
   'This examination has already been taken and cannot be retaken.',
   'error'
  );

  return;

 }


 openStartConfirmation(e);

}


function openStartConfirmation(e){

 const root=$('#modal-root');

 if(!root)return;


 root.hidden=false;


 root.innerHTML=`

 <div class="modal-backdrop">

  <div class="modal-card">

   <div class="modal-header">

    <div>

     <span class="eyebrow">
      START EXAMINATION
     </span>

     <h2>
      ${esc(e.title)}
     </h2>

    </div>

    <button
     class="icon-btn"
     data-action="close-modal"
     type="button">
     ×
    </button>

   </div>


   <div class="modal-body">

    <p>
     You are about to start this examination.
     Once started, your attempt will be recorded.
    </p>


    <ul class="confirmation-list">

     <li>
      ${
       e.timerEnabled
        ?`You will have <strong>${e.durationMinutes} minutes</strong> to complete the examination.`
        :'This examination has no timer.'
      }
     </li>

     <li>
      ${
       e.antiCheat
        ?`Anti-cheat monitoring is enabled with a maximum of <strong>${e.maxViolations} violations</strong>.`
        :'Anti-cheat monitoring is disabled.'
      }
     </li>

     <li>
      Submit the Google Form first, then click
      <strong>Submit Exam</strong> in the portal.
     </li>

     <li>
      Once submitted, the examination cannot be retaken.
     </li>

    </ul>


    ${
     e.antiCheat
      ?`
       <div class="notice danger-notice">

        Fullscreen, tab/window focus and visibility
        events may be monitored.

        Browser limitations mean this is a
        detection/deterrence layer, not a guarantee
        against cheating.

       </div>
      `
      :''
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
     data-id="${e.id}">
     Start Examination
    </button>

   </div>

  </div>

 </div>

 `;


 bindActions();

}


function confirmStart(id){

 closeModal();


 const e=db.exams.find(
  x=>x.id===id
 );

 const u=currentUser();

 if(!e||!u)return;


 /*
  Final retake protection.
 */
 const existing=db.attempts.find(
  a=>
   a.examId===e.id &&
   a.userId===u.id
 );


 if(existing){

  toast(
   'This examination has already been taken.',
   'error'
  );

  return;

 }


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


 examState={

  attemptId:attempt.id,

  seconds:
   Number(e.durationMinutes||60)*60,

  timerEnabled:e.timerEnabled,

  antiCheat:e.antiCheat,

  maxViolations:e.maxViolations,

  startedAt:Date.now(),

  active:true

 };


 currentExam=clone(e);


 $('#live-exam-title').textContent=
  e.title;

 $('#live-exam-examiner').textContent=
  'Assigned to '+u.username;

 $('#exam-violations').textContent=
  `0 / ${e.maxViolations}`;


 $('#exam-iframe').src=
  e.formUrl;


 $('#exam-instructions').textContent=
  e.timerEnabled
   ?`Timer: ${e.durationMinutes} minutes • Anti-cheat: ${
      e.antiCheat?'Enabled':'Disabled'
     } • Submit the Google Form, then click Submit Exam.`
   :`No timer • Anti-cheat: ${
      e.antiCheat?'Enabled':'Disabled'
     } • Submit the Google Form, then click Submit Exam.`;


 showView('exam');


 document.body.classList.add(
  'lockdown-active'
 );

 $('#exam-view').classList.add(
  'lockdown-active'
 );


 graceUntil=
  Date.now()+GRACE;


 if(e.antiCheat){

  requestFullscreen().finally(()=>{

   graceUntil=
    Date.now()+GRACE;

  });

 }


 if(e.timerEnabled){

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


 if(
  fn &&
  isFullscreen()
 ){

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


/* =========================================================
   EXAM TIMER
========================================================= */

function startTimer(){

 clearInterval(timer);

 renderTimer();


 timer=setInterval(()=>{

  if(!examState?.active){

   clearInterval(timer);

   return;

  }


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

 const t=
  examState?.seconds??0;


 const m=
  Math.floor(t/60)
   .toString()
   .padStart(2,'0');


 const s=
  (t%60)
   .toString()
   .padStart(2,'0');


 const timerEl=$('#exam-timer');


 if(!timerEl)return;


 timerEl.textContent=
  examState?.timerEnabled
   ?`${m}:${s}`
   :'No Timer';


 timerEl.classList.toggle(
  'warning',
  t<=300&&t>60
 );


 timerEl.classList.toggle(
  'danger',
  t<=60
 );


 const pct=
  examState?.timerEnabled&&
  currentExam?.durationMinutes

   ?Math.max(
     0,
     Math.min(
      100,
      (
       t/
       (
        currentExam.durationMinutes*60
       )
      )*100
     )
    )

   :0;


 const progress=$('#exam-progress');


 if(progress){

  progress.style.width=
   (100-pct)+'%';

 }

}


/* =========================================================
   PROCTORING / ANTI-CHEAT
========================================================= */

function registerViolation(reason){

 if(
  !examState?.active ||
  !examState.antiCheat
 ){

  return;

 }


 const now=Date.now();


 if(
  now<graceUntil ||
  now-lastViolation<DEBOUNCE ||
  violationOverlayOpen
 ){

  return;

 }


 lastViolation=now;


 const a=db.attempts.find(
  x=>x.id===examState.attemptId
 );


 if(!a)return;


 const n=
  (a.violations||0)+1;


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


 if(
  n>=examState.maxViolations
 ){

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

 if(
  !examState?.active ||
  !examState.antiCheat
 ){

  return;

 }


 violationOverlayOpen=true;


 $('#violation-reason').textContent=
  reason;


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


$('#resume-exam-btn')?.addEventListener(
 'click',
 async()=>{

  if(!examState?.active)return;


  $('#violation-overlay').hidden=true;

  violationOverlayOpen=false;


  $('#exam-iframe').style.filter='';


  graceUntil=
   Date.now()+GRACE;


  await requestFullscreen();


  graceUntil=
   Date.now()+GRACE;

 }
);


/*
 Fullscreen changes.
 */
[
 'fullscreenchange',
 'webkitfullscreenchange',
 'mozfullscreenchange'
].forEach(ev=>{

 document.addEventListener(
  ev,
  ()=>{

   if(
    examState?.active &&
    examState.antiCheat &&
    !isFullscreen() &&
    Date.now()>graceUntil
   ){

    registerViolation(
     'You exited full-screen mode.'
    );

   }

  }
 );

});


/*
 Tab visibility.
 */
document.addEventListener(
 'visibilitychange',
 ()=>{

  if(
   examState?.active &&
   examState.antiCheat &&
   document.hidden
  ){

   registerViolation(
    'You switched tabs or minimized the window.'
   );

  }

 }
);


/*
 Window focus.
 */
window.addEventListener(
 'blur',
 ()=>{

  if(
   examState?.active &&
   examState.antiCheat
  ){

   registerViolation(
    'The exam window lost focus.'
   );

  }

 }
);


/*
 Disable context menu during examination.
 */
document.addEventListener(
 'contextmenu',
 e=>{

  if(examState?.active){

   e.preventDefault();

  }

 }
);


/*
 Disable copy.
 */
document.addEventListener(
 'copy',
 e=>{

  if(examState?.active){

   e.preventDefault();

  }

 }
);


/*
 Disable cut.
 */
document.addEventListener(
 'cut',
 e=>{

  if(examState?.active){

   e.preventDefault();

  }

 }
);


/*
 Disable paste.
 */
document.addEventListener(
 'paste',
 e=>{

  if(examState?.active){

   e.preventDefault();

  }

 }
);


/*
 Restricted keyboard shortcuts.
 */
document.addEventListener(
 'keydown',
 e=>{

  if(!examState?.active)return;


  const k=
   (e.key||'').toLowerCase();

  const mod=
   e.ctrlKey||
   e.metaKey;


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

 }
);


/*
 Warn before leaving an active exam.
 */
window.addEventListener(
 'beforeunload',
 e=>{

  if(examState?.active){

   e.preventDefault();

   e.returnValue='';

  }

 }
);


/*
 Security UI guard:
 violation prompts are shown only during an active exam.
 */
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


/* =========================================================
   SUBMIT / RESULT
========================================================= */

$('#exam-submit-btn')?.addEventListener(
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

 timer=null;


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


 $('#result-icon').textContent=
  icon;


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


 $('#result-title').textContent=
  title;


 $('#result-message').textContent=
  message;


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


$('#result-dashboard-btn')?.addEventListener(
 'click',
 ()=>{

  currentExam=null;

  examState=null;

  openPortal();

 }
);


/* =========================================================
   ACTION BINDING
========================================================= */

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

     const title=
      $('#admin-page-title')?.textContent||
      'Dashboard';

     const page=
      Object.keys(pageTitles).find(
       key=>pageTitles[key]===title
      )||'dashboard';

     renderAdminPage(page);

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


 if(
  confirm(
   `Delete user "${u.username}"?`
  )
 ){

  db.users=
   db.users.filter(
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

 applyTheme();

 toast(
  'Demo data reset.',
  'success'
 );

 openAdmin();

}


/* =========================================================
   CLOCKS
========================================================= */

setInterval(
 ()=>{

  const now=
   new Date().toLocaleString();


  const adminClock=
   $('#admin-clock');

  const examinerClock=
   $('#examiner-clock');


  if(adminClock){

   adminClock.textContent=now;

  }


  if(examinerClock){

   examinerClock.textContent=now;

  }

 },
 1000
);


/* =========================================================
   SAFE STARTUP
========================================================= */

function initializePortal(){

 /*
  Rebuild/repair data before doing anything else.
 */
 db=loadDB();


 /*
  Initialize login event.
 */
 initAuthentication();


 /*
  Theme buttons.
 */
 [
  'theme-toggle-login',
  'theme-toggle-admin',
  'theme-toggle-examiner'
 ].forEach(id=>{

  const b=$('#'+id);

  if(
   b &&
   b.dataset.themeBound!=='1'
  ){

   b.addEventListener(
    'click',
    toggleTheme
   );

   b.dataset.themeBound='1';

  }

 });


 /*
  Logout buttons.
 */
 $('#admin-logout')?.addEventListener(
  'click',
  logout
 );

 $('#examiner-logout')?.addEventListener(
  'click',
  logout
 );


 /*
  Apply current theme.
 */
 applyTheme();


 /*
  Remove broken sessions.
 */
 clearBrokenSession();


 /*
  Ensure violation overlay is hidden
  outside an active examination.
 */
 syncViolationOverlay();


 /*
  Always have a real dashboard after
  successful authentication.
 */
 if(
  session &&
  currentUser()
 ){

  openPortal();

 }else{

  session=null;

  saveSession();

  showView('login');

 }

}


/*
 Initialize after DOM is available.
 */
if(
 document.readyState==='loading'
){

 document.addEventListener(
  'DOMContentLoaded',
  initializePortal,
  {once:true}
 );

}else{

 initializePortal();

}

})();
