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

function boolSetting(value,fallback=false){
 if(
  value===true ||
  value===1 ||
  value==='1' ||
  String(value).toLowerCase()==='true' ||
  String(value).toLowerCase()==='on' ||
  String(value).toLowerCase()==='yes'
 ){
  return true;
 }

 if(
  value===false ||
  value===0 ||
  value==='0' ||
  String(value).toLowerCase()==='false' ||
  String(value).toLowerCase()==='off' ||
  String(value).toLowerCase()==='no'
 ){
  return false;
 }

 return fallback;
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

  exam.antiCheat=boolSetting(exam.antiCheat,false);

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

function formatDuration(seconds){
 const total=Math.max(
  0,
  Math.round(Number(seconds)||0)
 );

 const hours=Math.floor(total/3600);
 const minutes=Math.floor((total%3600)/60);
 const secs=total%60;

 if(hours>0){
  return `${hours}h ${minutes}m`;
 }

 if(minutes>0){
  return `${minutes}m ${secs}s`;
 }

 return `${secs}s`;
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

 if(!container)return;

 const d=document.createElement('div');

 d.className='toast '+type;
 d.textContent=msg;

 container.appendChild(d);

 setTimeout(()=>{
  d.remove();
 },3000);
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

/* THEME */

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
 db.theme=db.theme==='light'
  ?'dark'
  :'light';

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

 await new Promise(
  resolve=>setTimeout(resolve,350)
 );

 clearLoginError();

 const usernameEl=$('#login-username');
 const passwordEl=$('#login-password');

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

 const username=String(
  usernameEl.value||''
 ).trim();

 const password=String(
  passwordEl.value||''
 );

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
  String(u?.username||'')
   .trim()
   .toLowerCase()===key &&
  String(u?.password??'')===password
 );

 if(!user){

  const assignedExam=db.exams.find(ex=>
   String(ex?.examinerUsername||'')
    .trim()
    .toLowerCase()===key &&
   String(ex?.examinerPassword??'')===password
  );

  if(assignedExam){

   const existing=db.users.find(
    u=>
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

   if(!existing){
    db.users.push(user);
   }else{
    user.password=String(
     assignedExam.examinerPassword
    );

    user.role='examiner';

    user.name=
     user.name||
     String(
      assignedExam.examinerUsername
     ).trim();
   }

   saveDB();
  }
 }

 if(!user&&fallback[key]&&fallback[key].password===password){

  user={
   id:fallback[key].id,
   username:key,
   password:password,
   role:fallback[key].role,
   name:fallback[key].name
  };
 }

 if(!user){

  showLoginError(
   'Invalid username or password.'
  );

  if(loginForm){
   loginForm.classList.remove(
    'login-error-shake'
   );

   void loginForm.offsetWidth;

   loginForm.classList.add(
    'login-error-shake'
   );
  }

  hideLoading();

  if(loginForm){
   loginForm.dataset.loggingIn='';
  }

  passwordEl.focus();

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

 hideLoading();

 if(loginForm){
  loginForm.dataset.loggingIn='';
 }

 return false;
}

function initAuthentication(){
 const form=$('#login-form');

 if(form&&!form.dataset.bound){
  form.addEventListener(
   'submit',
   handleLogin
  );

  form.dataset.bound='1';
 }
}

function currentUser(){
 if(!session)return null;

 return db.users.find(
  u=>u.id===session.userId
 )||db.users.find(
  u=>
   String(u.username||'')
    .toLowerCase()===
   String(session.username||'')
    .toLowerCase()
 );
}

function logout(){
 showLoading('Signing out...');

 clearInterval(timer);

 if(examState){
  examState.active=false;
 }

 currentExam=null;
 examState=null;

 session=null;

 saveSession();

 setTimeout(()=>{
  hideLoading();
  showView('login');

  const username=$('#login-username');
  const password=$('#login-password');

  if(username)username.value='';
  if(password)password.value='';

  clearLoginError();
 },350);
}

function clearBrokenSession(){
 if(!session)return;

 const u=currentUser();

 if(!u){
  session=null;
  saveSession();
 }
}

/* PORTAL ROUTING */

function openPortal(){
 const user=currentUser();

 if(!user){
  showView('login');
  return;
 }

 if(user.role==='admin'){
  openAdmin();
 }else{
  openExaminer();
 }
}

function openAdmin(){
 showView('admin');

 const nav=$$('.nav-item[data-admin-page]');

 nav.forEach(x=>{
  x.classList.toggle(
   'active',
   x.dataset.adminPage==='dashboard'
  );
 });

 adminPage('dashboard');
}

function openExaminer(){
 showView('examiner');
 renderExaminerDashboard();
}

function adminPage(page){
 $$('.admin-page').forEach(p=>{
  p.classList.remove('active');
 });

 const target=$(`#admin-${page}-page`);

 if(target){
  target.classList.add('active');
 }

 $$('.nav-item[data-admin-page]').forEach(n=>{
  n.classList.toggle(
   'active',
   n.dataset.adminPage===page
  );
 });

 renderAdminPage(page);
}

function renderAdminPage(page){
 if(page==='dashboard'){
  renderAdminDashboard();
 }

 if(page==='exams'){
  renderExamManagement();
 }

 if(page==='submissions'){
  renderSubmissions();
 }

 if(page==='settings'){
  renderSettings();
 }
}

/* EXAMINER DASHBOARD */

function getAssignedExams(user){
 if(!user)return[];

 const username=String(
  user.username||''
 ).trim().toLowerCase();

 return db.exams.filter(ex=>
  String(ex.examinerUsername||'')
   .trim()
   .toLowerCase()===username &&
  ex.active!==false
 );
}

function getAttemptForExam(exam,user){
 if(!exam||!user)return null;

 return db.attempts.find(
  a=>
   a.examId===exam.id &&
   String(a.username||'')
    .trim()
    .toLowerCase()===
   String(user.username||'')
    .trim()
    .toLowerCase()
 );
}

function isExamAvailable(exam){
 const now=Date.now();

 if(!exam)return false;

 if(exam.active===false)return false;

 if(exam.startAt){

  const start=new Date(
   exam.startAt
  ).getTime();

  if(!Number.isNaN(start)&&now<start){
   return false;
  }
 }

 if(exam.endAt){

  const end=new Date(
   exam.endAt
  ).getTime();

  if(!Number.isNaN(end)&&now>end){
   return false;
  }
 }

 return true;
}

function renderExaminerDashboard(){
 const user=currentUser();

 if(!user)return;

 const container=$('#examiner-dashboard-page');

 if(!container)return;

 const exams=getAssignedExams(user);

 const attempts=db.attempts.filter(
  a=>
   String(a.username||'')
    .trim()
    .toLowerCase()===
   String(user.username||'')
    .trim()
    .toLowerCase()
 );

 const completed=attempts.filter(
  a=>
   a.status==='Completed'||
   a.status==='Time Expired'||
   a.status==='Terminated'
 );

 const takenCount=completed.length;

 const totalAssigned=exams.length;

 const progress=totalAssigned
  ?Math.min(
    100,
    Math.round(
     (takenCount/totalAssigned)*100
    )
   )
  :0;

 const violations=attempts.reduce(
  (sum,a)=>sum+(Number(a.violations)||0),
  0
 );

 const totalTime=completed.reduce(
  (sum,a)=>sum+(Number(a.durationSeconds)||0),
  0
 );

 container.innerHTML=`
  <div class="dashboard-head">
   <div>
    <span class="eyebrow">EXAMINER PORTAL</span>
    <h1>Welcome, ${esc(user.name||user.username)}</h1>
    <p>View your assigned examinations and examination progress.</p>
   </div>

   <div class="dashboard-date">
    <span>Current Time</span>
    <strong id="examiner-dashboard-time">
     ${esc(new Date().toLocaleString())}
    </strong>
   </div>
  </div>

  <div class="stats-grid">
   <div class="stat-card">
    <span class="stat-label">TESTS TAKEN</span>
    <strong>${takenCount}</strong>
    <small>of ${totalAssigned} assigned</small>
   </div>

   <div class="stat-card">
    <span class="stat-label">VIOLATIONS</span>
    <strong>${violations}</strong>
    <small>Total recorded violations</small>
   </div>

   <div class="stat-card">
    <span class="stat-label">TIME SPENT</span>
    <strong>${formatDuration(totalTime)}</strong>
    <small>Across completed exams</small>
   </div>
  </div>

  <div class="progress-card">
   <div class="progress-card-head">
    <div>
     <span class="eyebrow">EXAMINATION PROGRESS</span>
     <h3>Completed Examinations</h3>
    </div>

    <strong>${takenCount}/${totalAssigned}</strong>
   </div>

   <div class="dashboard-progress">
    <div style="width:${progress}%"></div>
   </div>

   <div class="progress-meta">
    <span>${progress}% completed</span>
    <span>${Math.max(0,totalAssigned-takenCount)} remaining</span>
   </div>
  </div>

  <div class="section-head">
   <div>
    <span class="eyebrow">ASSIGNED EXAMINATIONS</span>
    <h2>Your Exams</h2>
   </div>
  </div>

  <div class="examiner-exam-grid">
   ${
    exams.length
     ?exams.map(exam=>
       renderExaminerExamCard(
        exam,
        user
       )
      ).join('')
     :`
      <div class="empty-state">
       <strong>No examinations assigned</strong>
       <span>Your assigned examinations will appear here.</span>
      </div>
     `
   }
  </div>
 `;

 const clock=$('#examiner-dashboard-time');

 if(clock){
  clock.textContent=
   new Date().toLocaleString();
 }
}

function renderExaminerExamCard(exam,user){
 const attempt=getAttemptForExam(
  exam,
  user
 );

 const taken=!!attempt;

 const available=isExamAvailable(
  exam
 );

 let status='AVAILABLE';
 let statusClass='success';
 let buttonText='Start Exam';
 let disabled=false;

 if(taken){
  status=
   attempt.status==='In Progress'
    ?'IN PROGRESS'
    :'COMPLETED';

  statusClass=
   attempt.status==='In Progress'
    ?'warning'
    :'muted';

  buttonText=
   attempt.status==='In Progress'
    ?'Continue Exam'
    :'Exam Completed';

  disabled=
   attempt.status!=='In Progress';
 }else if(!available){

  const now=Date.now();

  if(exam.startAt&&now<
   new Date(exam.startAt).getTime()
  ){
   status='NOT YET AVAILABLE';
  }else{
   status='EXPIRED';
  }

  statusClass='muted';
  buttonText='Unavailable';
  disabled=true;
 }

 return`
  <article class="examiner-exam-card">

   <div class="exam-card-top">
    <span class="status-pill ${statusClass}">
     ${esc(status)}
    </span>

    <span class="exam-duration">
     ${exam.timerEnabled
      ?`${esc(exam.durationMinutes)} min`
      :'No Timer'}
    </span>
   </div>

   <h3>${esc(exam.title||'Untitled Exam')}</h3>

   <p class="exam-description">
    ${esc(
     exam.description||
     'No examination description provided.'
    )}
   </p>

   <div class="exam-details">

    <div>
     <span>STARTS</span>
     <strong>
      ${exam.startAt
       ?esc(fmtDate(
        new Date(exam.startAt).getTime()
       ))
       :'Immediately'}
     </strong>
    </div>

    <div>
     <span>ENDS</span>
     <strong>
      ${exam.endAt
       ?esc(fmtDate(
        new Date(exam.endAt).getTime()
       ))
       :'No end date'}
     </strong>
    </div>

    <div>
     <span>DURATION</span>
     <strong>
      ${exam.timerEnabled
       ?`${esc(exam.durationMinutes)} minutes`
       :'Unlimited'}
     </strong>
    </div>

    <div>
     <span>ANTI-CHEAT</span>
     <strong>
      ${exam.antiCheat
       ?'Enabled'
       :'Disabled'}
     </strong>
    </div>

   </div>

   ${
    taken
     ?`
      <div class="exam-attempt-summary">
       <span>Violations</span>
       <strong>
        ${Number(attempt.violations)||0}
       </strong>

       <span>Time Spent</span>
       <strong>
        ${
         attempt.durationSeconds
          ?formatDuration(
           attempt.durationSeconds
          )
          :'—'
        }
       </strong>
      </div>
     `
     :''
   }

   <button
    class="primary-btn full"
    data-action="start-exam"
    data-id="${esc(exam.id)}"
    ${disabled?'disabled':''}
   >
    ${esc(buttonText)}
   </button>

  </article>
 `;
}

/* ADMIN DASHBOARD */

function renderAdminDashboard(){
 const container=$('#admin-dashboard-page');

 if(!container)return;

 const attempts=db.attempts||[];

 const completed=attempts.filter(
  a=>a.status==='Completed'
 );

 const totalViolations=db.violations.length;

 const totalTime=attempts.reduce(
  (sum,a)=>sum+
   (Number(a.durationSeconds)||0),
  0
 );

 container.innerHTML=`
  <div class="dashboard-head">
   <div>
    <span class="eyebrow">ADMIN DASHBOARD</span>
    <h1>Dashboard</h1>
    <p>Monitor examinations, submissions and proctoring activity.</p>
   </div>
  </div>

  <div class="stats-grid">

   <div class="stat-card">
    <span class="stat-label">EXAMS</span>
    <strong>${db.exams.length}</strong>
    <small>Configured examinations</small>
   </div>

   <div class="stat-card">
    <span class="stat-label">SUBMISSIONS</span>
    <strong>${completed.length}</strong>
    <small>Completed examinations</small>
   </div>

   <div class="stat-card">
    <span class="stat-label">VIOLATIONS</span>
    <strong>${totalViolations}</strong>
    <small>Recorded proctoring violations</small>
   </div>

   <div class="stat-card">
    <span class="stat-label">TIME SPENT</span>
    <strong>${formatDuration(totalTime)}</strong>
    <small>Total examination time</small>
   </div>

  </div>

  <div class="progress-card">
   <div class="progress-card-head">
    <div>
     <span class="eyebrow">CURRENT SUBMISSION PROGRESS</span>
     <h3>Overall Completion</h3>
    </div>

    <strong>
     ${
      db.exams.length
       ?Math.round(
        (completed.length/
         Math.max(
          db.exams.length,
          1
         ))*100
        )
       :0
     }%
    </strong>
   </div>

   <div class="dashboard-progress">
    <div style="width:${
     db.exams.length
      ?Math.min(
       100,
       (completed.length/
        Math.max(db.exams.length,1))*100
       )
      :0
    }%"></div>
   </div>
  </div>
 `;
}

/* EXAM MANAGEMENT */

function renderExamManagement(){
 const container=$('#admin-exams-page');

 if(!container)return;

 container.innerHTML=`
  <div class="dashboard-head">
   <div>
    <span class="eyebrow">EXAM MANAGEMENT</span>
    <h1>Examinations</h1>
    <p>Create, update and manage assigned examinations.</p>
   </div>

   <button
    class="primary-btn"
    data-action="new-exam"
   >
    + Add Examination
   </button>
  </div>

  <div class="exam-admin-list">
   ${
    db.exams.map(exam=>`
     <article class="admin-exam-card">

      <div>
       <span class="status-pill ${
        exam.active
         ?'success'
         :'muted'
       }">
        ${exam.active?'ACTIVE':'INACTIVE'}
       </span>

       <h3>${esc(exam.title)}</h3>

       <p>
        ${esc(exam.description||'No description')}
       </p>
      </div>

      <div class="admin-exam-meta">

       <span>
        Examiner:
        <strong>
         ${esc(exam.examinerUsername||'—')}
        </strong>
       </span>

       <span>
        Duration:
        <strong>
         ${
          exam.timerEnabled
           ?`${exam.durationMinutes} min`
           :'No Timer'
         }
        </strong>
       </span>

       <span>
        Anti-cheat:
        <strong>
         ${exam.antiCheat?'ON':'OFF'}
        </strong>
       </span>

       <span>
        Violations:
        <strong>
         ${exam.maxViolations}
        </strong>
       </span>

       <span>
        Start:
        <strong>
         ${
          exam.startAt
           ?esc(fmtDate(
            new Date(exam.startAt).getTime()
           ))
           :'Immediately'
         }
        </strong>
       </span>

       <span>
        End:
        <strong>
         ${
          exam.endAt
           ?esc(fmtDate(
            new Date(exam.endAt).getTime()
           ))
           :'No end date'
         }
        </strong>
       </span>

      </div>

      <div class="admin-card-actions">
       <button
        class="secondary-btn"
        data-action="edit-exam"
        data-id="${esc(exam.id)}"
       >
        Edit
       </button>

       <button
        class="danger-btn"
        data-action="delete-exam"
        data-id="${esc(exam.id)}"
       >
        Delete
       </button>
      </div>

     </article>
    `).join('')
   }
  </div>
 `;
}

/* EXAM MODAL */

function openExamModal(id=null){
 const existing=id
  ?db.exams.find(e=>e.id===id)
  :null;

 const root=$('#modal-root');

 if(!root)return;

 root.hidden=false;

 root.innerHTML=`
  <div class="modal-backdrop">
   <div class="modal-card large">

    <div class="modal-head">
     <div>
      <span class="eyebrow">
       ${existing?'EDIT EXAM':'NEW EXAM'}
      </span>
      <h2>
       ${existing
        ?'Update Examination'
        :'Create Examination'}
      </h2>
     </div>

     <button
      class="icon-btn"
      data-action="close-modal"
     >
      ×
     </button>
    </div>

    <form id="exam-form">

     <input
      id="exam-id"
      type="hidden"
      value="${esc(existing?.id||'')}"
     >

     <label for="exam-title">
      Exam Title
     </label>

     <input
      id="exam-title"
      required
      value="${esc(existing?.title||'')}"
      placeholder="Enter exam title"
     >

     <label for="exam-description">
      Description
     </label>

     <textarea
      id="exam-description"
      rows="3"
      placeholder="Enter exam description"
     >${esc(existing?.description||'')}</textarea>

     <label for="exam-form-url">
      Google Form URL
     </label>

     <input
      id="exam-form-url"
      type="url"
      required
      value="${esc(existing?.formUrl||'')}"
      placeholder="https://docs.google.com/forms/..."
     >

     <div class="form-grid">

      <div>
       <label for="examiner-username">
        Examiner Username
       </label>

       <input
        id="examiner-username"
        required
        value="${esc(existing?.examinerUsername||'')}"
        placeholder="examiner username"
       >
      </div>

      <div>
       <label for="examiner-password">
        Examiner Password
       </label>

       <input
        id="examiner-password"
        type="text"
        required
        value="${esc(existing?.examinerPassword||'')}"
        placeholder="examiner password"
       >
      </div>

     </div>

     <div class="setting-box">

      <label class="checkbox-row">
       <input
        id="exam-timer-enabled"
        type="checkbox"
        ${boolSetting(
         existing?.timerEnabled,
         true
        )?'checked':''}
       >
       <span>
        <strong>Enable Timer</strong>
        <small>
         Limit the examination session to a set duration.
        </small>
       </span>
      </label>

      <div id="timer-setting">

       <label for="exam-duration">
        Duration (minutes)
       </label>

       <input
        id="exam-duration"
        type="number"
        min="1"
        value="${Math.max(
         1,
         Number(existing?.durationMinutes)||60
        )}"
       >

       <small id="timer-status"></small>

      </div>

     </div>

     <div class="setting-box">

      <label class="checkbox-row">
       <input
        id="exam-anti-cheat"
        type="checkbox"
        ${boolSetting(
         existing?.antiCheat,
         true
        )?'checked':''}
       >

       <span>
        <strong>Enable Anti-Cheat</strong>
        <small>
         Detect tab switching, focus loss,
         full-screen exits and restricted shortcuts.
        </small>
       </span>
      </label>

      <label for="exam-max-violations">
       Maximum Violations
      </label>

      <input
       id="exam-max-violations"
       type="number"
       min="1"
       value="${Math.max(
        1,
        Number(existing?.maxViolations)||3
       )}"
      >

     </div>

     <div class="form-grid">

      <div>
       <label for="exam-start">
        Start Date / Time
       </label>

       <input
        id="exam-start"
        type="datetime-local"
        value="${esc(
         existing?.startAt||''
        )}"
       >
      </div>

      <div>
       <label for="exam-end">
        End Date / Time
       </label>

       <input
        id="exam-end"
        type="datetime-local"
        value="${esc(
         existing?.endAt||''
        )}"
       >
      </div>

     </div>

     <label class="checkbox-row">
      <input
       id="exam-active"
       type="checkbox"
       ${existing?.active!==false?'checked':''}
      >

      <span>
       <strong>Exam Active</strong>
       <small>
        Allow this examination to appear on the examiner dashboard.
       </small>
      </span>
     </label>

     <div class="modal-actions">

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
       Save Examination
      </button>

     </div>

    </form>
   </div>
  </div>
 `;

 const timerCheckbox=$('#exam-timer-enabled');
 const duration=$('#exam-duration');
 const status=$('#timer-status');

 function updateTimerFields(){
  const enabled=
   timerCheckbox?.checked===true;

  if(duration){
   duration.disabled=!enabled;
   duration.style.opacity=
    enabled?'1':'.55';
  }

  if(status){
   status.textContent=
    enabled
     ?`Timer ON — ${
       Math.max(
        1,
        Math.round(
         Number(duration?.value)||60
        )
       )
      } minute(s)`
     :'Timer OFF';
  }
 }

 timerCheckbox?.addEventListener(
  'change',
  updateTimerFields
 );

 duration?.addEventListener(
  'input',
  updateTimerFields
 );

 updateTimerFields();

 $('#exam-form')?.addEventListener(
  'submit',
  e=>{
   e.preventDefault();
   saveExamFromForm();
  }
 );
}

function closeModal(){
 const root=$('#modal-root');

 if(root){
  root.hidden=true;
  root.innerHTML='';
 }
}

function saveExamFromForm(){
 const id=$('#exam-id')?.value||'';

 const title=$('#exam-title')?.value.trim();

 const description=
  $('#exam-description')?.value.trim()||'';

 const formUrl=
  $('#exam-form-url')?.value.trim();

 const examinerUsername=
  $('#examiner-username')?.value.trim();

 const examinerPassword=
  $('#examiner-password')?.value||'';

 const timerEnabled=
  $('#exam-timer-enabled')?.checked===true;

 const durationMinutes=
  Math.max(
   1,
   Math.round(
    Number(
     $('#exam-duration')?.value
    )||60
   )
  );

 const antiCheat=
  $('#exam-anti-cheat')?.checked===true;

 const maxViolations=
  Math.max(
   1,
   Math.round(
    Number(
     $('#exam-max-violations')?.value
    )||3
   )
  );

 const startAt=
  $('#exam-start')?.value||'';

 const endAt=
  $('#exam-end')?.value||'';

 const active=
  $('#exam-active')?.checked!==false;

 if(!title){
  toast(
   'Please enter an exam title.',
   'error'
  );
  return;
 }

 if(!formUrl){
  toast(
   'Please enter the Google Form URL.',
   'error'
  );
  return;
 }

 if(!examinerUsername||!examinerPassword){
  toast(
   'Please enter examiner credentials.',
   'error'
  );
  return;
 }

 if(startAt&&endAt&&
    new Date(startAt)>=new Date(endAt)){
  toast(
   'The end date must be later than the start date.',
   'error'
  );
  return;
 }

 let exam=id
  ?db.exams.find(e=>e.id===id)
  :null;

 if(!exam){

  if(db.exams.length>=6){
   toast(
    'Maximum of 6 examinations reached.',
    'error'
   );
   return;
  }

  exam={
   id:uid('exam'),
   createdAt:Date.now(),
   createdBy:currentUser()?.id||'u-admin'
  };

  db.exams.push(exam);
 }

 exam.title=title;
 exam.description=description;
 exam.formUrl=formUrl;
 exam.examinerUsername=examinerUsername;
 exam.examinerPassword=examinerPassword;
 exam.timerEnabled=timerEnabled===true;
 exam.durationMinutes=durationMinutes;
 exam.antiCheat=antiCheat===true;
 exam.maxViolations=maxViolations;
 exam.startAt=startAt;
 exam.endAt=endAt;
 exam.active=active;

 let account=db.users.find(
  u=>
   String(u.username||'')
    .trim()
    .toLowerCase()===
   examinerUsername.toLowerCase()
 );

 if(!account){

  account={
   id:uid('user'),
   username:examinerUsername,
   password:examinerPassword,
   role:'examiner',
   name:examinerUsername
  };

  db.users.push(account);

 }else if(account.role!=='admin'){

  account.password=examinerPassword;
  account.role='examiner';
  account.name=
   account.name||examinerUsername;
 }

 saveDB();

 closeModal();

 renderAdminPage('exams');

 toast(
  id
   ?'Examination updated successfully.'
   :'Examination created successfully.',
  'success'
 );
}

function deleteExam(id){
 const exam=db.exams.find(
  e=>e.id===id
 );

 if(!exam)return;

 if(!confirm(
  `Delete "${exam.title}"?`
 )){
  return;
 }

 db.exams=db.exams.filter(
  e=>e.id!==id
 );

 saveDB();

 renderAdminPage('exams');

 toast(
  'Examination deleted.',
  'success'
 );
}

/* SUBMISSIONS */

function renderSubmissions(){
 const container=$('#admin-submissions-page');

 if(!container)return;

 const attempts=db.attempts||[];

 container.innerHTML=`
  <div class="dashboard-head">
   <div>
    <span class="eyebrow">SUBMISSIONS</span>
    <h1>Exam Submissions</h1>
    <p>Review examiner examination sessions.</p>
   </div>
  </div>

  <div class="table-wrap">

   <table class="data-table">

    <thead>
     <tr>
      <th>Exam</th>
      <th>Examiner</th>
      <th>Status</th>
      <th>Violations</th>
      <th>Started</th>
      <th>Ended</th>
      <th>Time Spent</th>
     </tr>
    </thead>

    <tbody>

     ${
      attempts.length
       ?attempts.map(a=>`
        <tr>
         <td>${esc(a.examTitle||'—')}</td>
         <td>${esc(a.username||'—')}</td>
         <td>${esc(a.status||'—')}</td>
         <td>${Number(a.violations)||0}</td>
         <td>${esc(fmtDate(a.startedAt))}</td>
         <td>${esc(fmtDate(a.endedAt))}</td>
         <td>
          ${formatDuration(
           a.durationSeconds||0
          )}
         </td>
        </tr>
       `).join('')
       :`
        <tr>
         <td colspan="7">
          No submissions yet.
         </td>
        </tr>
       `
     }

    </tbody>

   </table>

  </div>
 `;
}

/* SETTINGS */

function renderSettings(){
 const container=$('#admin-settings-page');

 if(!container)return;

 const examiners=db.users.filter(
  u=>u.role==='examiner'
 );

 container.innerHTML=`
  <div class="dashboard-head">
   <div>
    <span class="eyebrow">SYSTEM SETTINGS</span>
    <h1>Settings</h1>
    <p>Manage examiner accounts and portal settings.</p>
   </div>
  </div>

  <div class="settings-card">

   <h3>Examiner Accounts</h3>

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
      ${
       examiners.length
        ?examiners.map(u=>`
         <tr>
          <td>${esc(u.username)}</td>
          <td>${esc(u.name||'—')}</td>
          <td>${esc(u.role)}</td>
          <td>
           <button
            class="danger-btn"
            data-action="delete-user"
            data-id="${esc(u.id)}"
           >
            Delete
           </button>
          </td>
         </tr>
        `).join('')
        :`
         <tr>
          <td colspan="4">
           No examiner accounts.
          </td>
         </tr>
        `
      }
     </tbody>

    </table>

   </div>

  </div>
 `;

}

/* EXAM START */

function startExam(id){
 const user=currentUser();

 if(!user)return;

 const exam=db.exams.find(
  e=>e.id===id
 );

 if(!exam){
  toast(
   'Examination not found.',
   'error'
  );
  return;
 }

 const assigned=
  String(exam.examinerUsername||'')
   .trim()
   .toLowerCase()===
  String(user.username||'')
   .trim()
   .toLowerCase();

 if(!assigned){
  toast(
   'This examination is not assigned to you.',
   'error'
  );
  return;
 }

 if(!isExamAvailable(exam)){
  toast(
   'This examination is not currently available.',
   'error'
  );
  return;
 }

 const existing=getAttemptForExam(
  exam,
  user
 );

 if(existing){

  if(existing.status==='In Progress'){
   currentExam=exam;
   confirmStart(
    exam.id,
    existing.id
   );
   return;
  }

  toast(
   'You have already taken this examination.',
   'error'
  );

  return;
 }

 currentExam=exam;

 openConfirmStartModal(
  exam
 );
}

function openConfirmStartModal(exam){
 const root=$('#modal-root');

 if(!root)return;

 root.hidden=false;

 root.innerHTML=`
  <div class="modal-backdrop">
   <div class="modal-card">

    <div class="modal-head">
     <div>
      <span class="eyebrow">START EXAM</span>
      <h2>${esc(exam.title)}</h2>
     </div>

     <button
      class="icon-btn"
      data-action="close-modal"
     >
      ×
     </button>
    </div>

    <p>
     ${esc(
      exam.description||
      'You are about to begin your examination.'
     )}
    </p>

    <div class="exam-start-details">

     <div>
      <span>DURATION</span>
      <strong>
       ${
        exam.timerEnabled
         ?`${exam.durationMinutes} minutes`
         :'No Timer'
       }
      </strong>
     </div>

     <div>
      <span>ANTI-CHEAT</span>
      <strong>
       ${exam.antiCheat?'Enabled':'Disabled'}
      </strong>
     </div>

     <div>
      <span>MAX VIOLATIONS</span>
      <strong>
       ${exam.maxViolations}
      </strong>
     </div>

    </div>

    <div class="exam-start-warning">
     ${
      exam.antiCheat
       ?'Anti-cheat monitoring will be active. Switching tabs, leaving full-screen mode or losing window focus may result in a violation.'
       :'Anti-cheat monitoring is disabled for this examination.'
     }
    </div>

    <div class="modal-actions">

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
      data-id="${esc(exam.id)}"
     >
      Start Examination
     </button>

    </div>

   </div>
  </div>
 `;
}

function confirmStart(id,existingAttemptId=null){
 const user=currentUser();

 const e=db.exams.find(
  x=>x.id===id
 );

 if(!e||!user)return;

 currentExam=e;

 const timerEnabled=
  boolSetting(
   e.timerEnabled,
   false
  );

 const durationMinutes=
  Math.max(
   1,
   Math.round(
    Number(e.durationMinutes)||60
   )
  );

 const antiCheat=
  boolSetting(
   e.antiCheat,
   false
  );

 const maxViolations=
  Math.max(
   1,
   Math.round(
    Number(e.maxViolations)||3
   )
  );

 e.timerEnabled=timerEnabled;
 e.durationMinutes=durationMinutes;
 e.antiCheat=antiCheat;
 e.maxViolations=maxViolations;

 let attempt=
  existingAttemptId
   ?db.attempts.find(
     a=>a.id===existingAttemptId
    )
   :getAttemptForExam(
     e,
     user
    );

 if(!attempt){

  attempt={
   id:uid('attempt'),
   examId:e.id,
   examTitle:e.title,
   username:user.username,
   startedAt:Date.now(),
   endedAt:null,
   durationSeconds:0,
   status:'In Progress',
   violations:0
  };

  db.attempts.push(attempt);

 }else{

  attempt.status='In Progress';

  if(!attempt.startedAt){
   attempt.startedAt=Date.now();
  }
 }

 saveDB();

 clearInterval(timer);

 examState={
  attemptId:attempt.id,
  seconds:timerEnabled
   ?durationMinutes*60
   :0,
  timerEnabled,
  antiCheat,
  maxViolations,
  startedAt:attempt.startedAt||Date.now(),
  active:true
 };

 $('#live-exam-title').textContent=
  e.title;

 $('#live-exam-examiner').textContent=
  'Assigned to '+user.username;

 $('#exam-violations').textContent=
  `${attempt.violations||0} / ${maxViolations}`;

 $('#exam-iframe').src=e.formUrl;

 $('#exam-instructions').textContent=
  timerEnabled
   ?`Timer: ${durationMinutes} minutes • Anti-cheat: ${antiCheat?'Enabled':'Disabled'} • Submit the Google Form, then click Submit Exam.`
   :`No timer • Anti-cheat: ${antiCheat?'Enabled':'Disabled'} • Submit the Google Form, then click Submit Exam.`;

 showView('exam');

 document.body.classList.add(
  'lockdown-active'
 );

 $('#exam-view').classList.add(
  'lockdown-active'
 );

 graceUntil=Date.now()+GRACE;

 if(antiCheat){
  requestFullscreen().finally(()=>{
   graceUntil=Date.now()+GRACE;
  });
 }else{
  requestFullscreen();
 }

 renderTimer();

 if(timerEnabled){
  startTimer();
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
  fn&&
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

/* TIMER */

function startTimer(){
 clearInterval(timer);

 renderTimer();

 timer=setInterval(()=>{

  if(!examState?.active){
   clearInterval(timer);
   return;
  }

  examState.seconds--;

  if(examState.seconds<0){
   examState.seconds=0;
  }

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

 const m=
  Math.floor(t/60)
   .toString()
   .padStart(2,'0');

 const sec=
  (t%60)
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
  progress.style.width=
   (100-pct)+'%';
 }
}

/* PROCTORING */

function registerViolation(reason){
 if(
  !examState?.active||
  !examState.antiCheat
 ){
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

 const n=
  (Number(a.violations)||0)+1;

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
 if(
  !examState?.active||
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
 document.addEventListener(
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
 );
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

  a.durationSeconds=
   Math.max(
    0,
    (
     a.endedAt-
     (a.startedAt||a.endedAt)
    )/1000
   );
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
     closeModal();
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

 const u=db.users.find(
  x=>x.id===id
 );

 if(!u)return;

 if(confirm(
  `Delete user "${u.username}"?`
 )){

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
 )){
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
  const now=
   new Date().toLocaleString();

  const adminClock=
   $('#admin-clock');

  const examinerClock=
   $('#examiner-clock');

  const dashboardClock=
   $('#examiner-dashboard-time');

  if(adminClock){
   adminClock.textContent=now;
  }

  if(examinerClock){
   examinerClock.textContent=now;
  }

  if(dashboardClock){
   dashboardClock.textContent=now;
  }
 },
 1000
);

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

 const missing=
  required.filter(
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

 bindActions();
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
