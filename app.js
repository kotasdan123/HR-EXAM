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
   examinerUserId:'u-test',
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

function boolSetting(v,fallback=false){
 if(v===true||v===1||v==='1'||v==='true'||v==='on'||v==='yes')return true;
 if(v===false||v===0||v==='0'||v==='false'||v==='off'||v==='no'||v===''||v==null)return false;
 return fallback;
}

function getAvailability(e){
 if(!e||e.active===false)return{status:'Unavailable'};

 const now=Date.now();
 const start=e.startAt?new Date(e.startAt).getTime():null;
 const end=e.endAt?new Date(e.endAt).getTime():null;

 if(Number.isFinite(start)&&now<start)return{status:'Unavailable'};
 if(Number.isFinite(end)&&now>end)return{status:'Unavailable'};

 return{status:'Available'};
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
   existing.id=su.id;
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
   exam.active===false||
   exam.active==='false'||
   exam.active===0||
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

  /*
   * IMPORTANT:
   * Keep both the examiner username and examiner user ID synchronized.
   * This repairs older exams that were created before examinerUserId
   * was introduced.
   */
  exam.examinerUsername=username;
  exam.examinerUserId=account.id;
 });

 safeSet(localStorage,KEY,JSON.stringify(repaired));

 return repaired;
}

function saveDB(){
 safeSet(localStorage,KEY,JSON.stringify(db));
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

 $('#toast-container').appendChild(d);

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

 if(t)t.textContent=message;
}

function hideLoading(){
 const o=document.getElementById('loading-overlay');

 if(o)o.style.display='none';
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

async function handleLogin(e){
 if(e)e.preventDefault();

 const loginForm=$('#login-form');

 if(loginForm?.dataset.loggingIn==='1')return false;

 if(loginForm)loginForm.dataset.loggingIn='1';

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

  if(loginForm)loginForm.dataset.loggingIn='';

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

  if(loginForm)loginForm.dataset.loggingIn='';

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
   String(ex?.examinerUsername||'').trim().toLowerCase()===key &&
   String(ex?.examinerPassword??'')===password
  );

  if(assignedExam){
   const existing=db.users.find(
    u=>
     String(u?.username||'').trim().toLowerCase()===key &&
     u?.role!=='admin'
   );

   user=existing||{
    id:uid('user'),
    username:username,
    password:password,
    role:'examiner',
    name:username
   };

   if(!existing){
    db.users.push(user);
    saveDB();
   }
  }
 }

 if(!user){
  const f=fallback[key];

  if(f&&f.password===password){
   user={
    id:f.id,
    username:key,
    password:f.password,
    role:f.role,
    name:f.name
   };
  }
 }

 if(!user){
  showLoginError('Invalid username or password.');

  hideLoading();

  if(loginForm)loginForm.dataset.loggingIn='';

  return false;
 }

 session={
  userId:user.id,
  username:user.username,
  role:user.role,
  loggedInAt:Date.now()
 };

 saveSession();

 hideLoading();

 if(loginForm)loginForm.dataset.loggingIn='';

 openPortal();

 return false;
}

function currentUser(){
 if(!session)return null;

 db=loadDB();

 return db.users.find(
  u=>u.id===session.userId ||
  String(u.username||'').toLowerCase()===
  String(session.username||'').toLowerCase()
 )||null;
}

function logout(){
 if(examState?.active){
  const ok=confirm(
   'An examination is currently active. Logging out may end your session. Continue?'
  );

  if(!ok)return;
 }

 clearInterval(timer);

 examState=null;
 currentExam=null;

 session=null;

 saveSession();

 document.body.classList.remove('lockdown-active');

 showView('login');

 const form=$('#login-form');

 if(form){
  form.reset();
  form.dataset.loggingIn='';
 }

 clearLoginError();
}

function clearBrokenSession(){
 if(!session)return;

 const u=currentUser();

 if(!u){
  session=null;
  saveSession();
 }
}

/* PORTAL NAVIGATION */

function openPortal(){
 const u=currentUser();

 if(!u){
  session=null;
  saveSession();
  showView('login');
  hideLoading();
  return;
 }

 db=loadDB();

 if(u.role==='admin'){
  openAdmin();
 }else{
  openExaminer();
 }
}

function openAdmin(){
 const u=currentUser();

 if(!u||u.role!=='admin'){
  logout();
  return;
 }

 showView('admin');

 renderAdminDashboard();
 renderAdminExams();
 renderSubmissions();
 renderViolations();
 renderAnalytics();
 renderSettings();

 hideLoading();
}

function openExaminer(){
 const u=currentUser();

 if(!u||u.role!=='examiner'){
  logout();
  return;
 }

 showView('examiner');

 renderExaminerDashboard();

 hideLoading();
}

function adminPage(page){
 $$('.admin-page').forEach(p=>p.classList.remove('active'));

 const target=$('#admin-'+page+'-page');

 if(target)target.classList.add('active');

 $$('.nav-item[data-admin-page]').forEach(b=>{
  b.classList.toggle(
   'active',
   b.dataset.adminPage===page
  );
 });

 const title=$('#admin-page-title');

 if(title){
  const labels={
   dashboard:'Dashboard',
   exams:'Exam Management',
   submissions:'Submissions',
   violations:'Violations',
   analytics:'Analytics',
   settings:'Settings'
  };

  title.textContent=labels[page]||'Dashboard';
 }

 if(page==='dashboard')renderAdminDashboard();
 if(page==='exams')renderAdminExams();
 if(page==='submissions')renderSubmissions();
 if(page==='violations')renderViolations();
 if(page==='analytics')renderAnalytics();
 if(page==='settings')renderSettings();
}

function attemptCounts(){
 const a=db.attempts||[];

 return{
  total:a.length,
  completed:a.filter(x=>x.status==='Completed').length,
  inProgress:a.filter(x=>x.status==='In Progress').length,
  expired:a.filter(x=>x.status==='Time Expired').length,
  terminated:a.filter(x=>x.status==='Terminated').length
 };
}

function totalSpentSeconds(attempts){
 return attempts.reduce((sum,a)=>{
  if(a.durationSeconds!=null){
   return sum+(Number(a.durationSeconds)||0);
  }

  if(a.startedAt&&a.endedAt){
   return sum+Math.max(
    0,
    Math.floor((a.endedAt-a.startedAt)/1000)
   );
  }

  return sum;
 },0);
}

function formatDuration(seconds){
 const s=Math.max(0,Math.floor(Number(seconds)||0));

 const h=Math.floor(s/3600);
 const m=Math.floor((s%3600)/60);
 const sec=s%60;

 if(h>0){
  return `${h}h ${String(m).padStart(2,'0')}m`;
 }

 return `${m}m ${String(sec).padStart(2,'0')}s`;
}

/* ADMIN DASHBOARD */

function renderAdminDashboard(){
 const c=attemptCounts();

 const el=$('#admin-dashboard-page');

 if(!el)return;

 el.innerHTML=`
  <div class="page-head">
   <div>
    <span class="eyebrow">OVERVIEW</span>
    <h3>Dashboard</h3>
    <p>Current examination and submission overview.</p>
   </div>
   <div class="actions">
    <button class="secondary-btn" data-action="refresh-admin">
     Refresh
    </button>
   </div>
  </div>

  <div class="kpi-grid">
   ${kpi('Total Exams',db.exams.length)}
   ${kpi('Total Sessions',c.total)}
   ${kpi('In Progress',c.inProgress)}
   ${kpi('Completed',c.completed)}
  </div>

  <div class="grid-2">
   <div class="panel">
    <h3>Current Submission Progress</h3>
    ${[
     ['Completed',c.completed],
     ['In Progress',c.inProgress],
     ['Time Expired',c.expired],
     ['Terminated',c.terminated]
    ].map(([l,n])=>chart(l,n,c.total)).join('')}
   </div>

   <div class="panel">
    <h3>Exam Availability</h3>
    ${
     db.exams.length
     ?db.exams.map(e=>{
       const av=getAvailability(e);

       return`
        <div class="chart-row">
         <div>
          <div class="chart-label">${esc(e.title)}</div>
          <div class="muted" style="font-size:11px">
           ${av.status}
          </div>
         </div>
         <div class="chart-number">
          ${db.attempts.filter(a=>a.examId===e.id).length}
         </div>
        </div>
       `;
      }).join('')
     :'<div class="empty">No exams configured.</div>'
    }
   </div>
  </div>
 `;

 bindActions();
}

/* EXAM MANAGEMENT */

function examModalMarkup(e=null){
 const editing=!!e;

 const value=(v='')=>esc(v);

 return`
  <div class="modal">
   <div class="modal-head">
    <div>
     <span class="eyebrow">
      ${editing?'EDIT EXAM':'CREATE EXAM'}
     </span>
     <h3>${editing?'Update Examination':'New Examination'}</h3>
    </div>

    <button
     type="button"
     class="close-btn"
     data-action="close-modal"
     aria-label="Close"
    >×</button>
   </div>

   <form id="exam-form" class="modal-body">
    <label>Exam Title</label>
    <input
     name="title"
     required
     value="${value(e?.title||'')}"
     placeholder="Enter exam title"
    >

    <label>Description</label>
    <textarea
     name="description"
     rows="3"
     placeholder="Enter examination description"
    >${value(e?.description||'')}</textarea>

    <label>Google Form Link</label>
    <input
     name="formUrl"
     type="url"
     required
     value="${value(e?.formUrl||'')}"
     placeholder="https://docs.google.com/forms/..."
    >

    <div class="grid-2">
     <div>
      <label>Examiner Username</label>
      <input
       name="examinerUsername"
       required
       value="${value(e?.examinerUsername||'')}"
       placeholder="examiner username"
      >
     </div>

     <div>
      <label>Examiner Password</label>
      <input
       name="examinerPassword"
       type="text"
       required
       value="${value(e?.examinerPassword||'')}"
       placeholder="examiner password"
      >
     </div>
    </div>

    <div class="grid-2">
     <div>
      <label>Start Date & Time</label>
      <input
       name="startAt"
       type="datetime-local"
       value="${e?.startAt?new Date(e.startAt).toISOString().slice(0,16):''}"
      >
     </div>

     <div>
      <label>End Date & Time</label>
      <input
       name="endAt"
       type="datetime-local"
       value="${e?.endAt?new Date(e.endAt).toISOString().slice(0,16):''}"
      >
     </div>
    </div>

    <div class="grid-2">
     <div class="panel compact">
      <label class="check-row">
       <input
        id="timerEnabled"
        type="checkbox"
        ${e?.timerEnabled!==false?'checked':''}
       >
       <span>Enable Timer</span>
      </label>

      <label>Duration in Minutes</label>
      <input
       name="durationMinutes"
       type="number"
       min="1"
       value="${Number(e?.durationMinutes)||60}"
      >
     </div>

     <div class="panel compact">
      <label class="check-row">
       <input
        id="antiCheat"
        type="checkbox"
        ${e?.antiCheat!==false?'checked':''}
       >
       <span>Enable Anti-Cheat</span>
      </label>

      <label>Maximum Violations</label>
      <input
       name="maxViolations"
       type="number"
       min="1"
       value="${Number(e?.maxViolations)||3}"
      >
     </div>
    </div>

    <label class="check-row">
     <input
      id="active"
      type="checkbox"
      ${e?.active!==false?'checked':''}
     >
     <span>Exam Active</span>
    </label>

    <div class="modal-footer">
     <button
      type="button"
      class="secondary-btn"
      data-action="close-modal"
     >Cancel</button>

     <button
      type="submit"
      class="primary-btn"
     >
      ${editing?'Save Changes':'Create Exam'}
     </button>
    </div>
   </form>
  </div>
 `;
}

function openExamModal(id=null){
 const e=id?db.exams.find(x=>x.id===id):null;

 if(!id&&db.exams.length>=6){
  toast('Maximum of 6 exams reached. Delete an exam to create a new one.','error');
  return;
 }

 const root=$('#modal-root');

 root.hidden=false;
 root.innerHTML=examModalMarkup(e);

 const form=$('#exam-form');

 form.addEventListener('submit',event=>{
  event.preventDefault();

  const f=new FormData(form);

  const url=String(f.get('formUrl')||'').trim();

  if(!/^https?:\\/\\//i.test(url)){
   toast('Please enter a valid Google Form URL.','error');
   return;
  }

  const examinerUsername=
   String(f.get('examinerUsername')||'').trim();

  const examinerPassword=
   String(f.get('examinerPassword')||'');

  if(!examinerUsername||!examinerPassword){
   toast('Examiner username and password are required.','error');
   return;
  }

  const timerEnabled=boolSetting(
   $('#timerEnabled')?.checked,
   false
  );

  const durationMinutes=Math.max(
   1,
   Math.round(Number(f.get('durationMinutes'))||60)
  );

  const obj={
   title:String(f.get('title')||'').trim(),
   description:String(f.get('description')||'').trim(),
   formUrl:url,
   examinerUsername,
   examinerPassword,
   examinerUserId:'',
   antiCheat:!!$('#antiCheat')?.checked,
   maxViolations:Math.max(
    1,
    Math.round(Number(f.get('maxViolations'))||3)
   ),
   timerEnabled,
   durationMinutes,
   startAt:f.get('startAt')
    ?new Date(f.get('startAt')).toISOString()
    :'',
   endAt:f.get('endAt')
    ?new Date(f.get('endAt')).toISOString()
    :'',
   active:!!$('#active')?.checked
  };

  let account=db.users.find(
   u=>
    String(u?.username||'').trim().toLowerCase()===
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
  }else{
   account.username=examinerUsername;
   account.password=examinerPassword;
   account.role='examiner';

   if(!account.name){
    account.name=examinerUsername;
   }
  }

  obj.examinerUserId=account.id;

  const existingAttemptedExam=e&&db.attempts.some(
   a=>a.examId===e.id
  );

  if(e&&existingAttemptedExam){
   const lockedCompleted=db.attempts.some(
    a=>
     a.examId===e.id &&
     ['Completed','Time Expired','Terminated'].includes(a.status)
   );

   if(lockedCompleted){
    toast(
     'This exam already has completed attempts and cannot be reassigned by editing.',
     'error'
    );
    return;
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

function renderAdminExams(){
 const el=$('#admin-exams-page');

 if(!el)return;

 el.innerHTML=`
  <div class="page-head">
   <div>
    <span class="eyebrow">MANAGEMENT</span>
    <h3>Exam Management</h3>
    <p>Create and configure examinations.</p>
   </div>

   <div class="actions">
    <button class="primary-btn" data-action="new-exam">
     + Add Exam
    </button>
   </div>
  </div>

  <div class="exam-grid">
   ${
    db.exams.length
    ?db.exams.map(adminExamCard).join('')
    :'<div class="empty">No examinations configured.</div>'
   }
  </div>
 `;

 bindActions();
}

function adminExamCard(e){
 const av=getAvailability(e);

 const attempts=db.attempts.filter(
  a=>a.examId===e.id
 );

 return`
  <div class="exam-card">
   <div class="exam-card-top">
    <span class="status-badge ${av.status==='Available'?'success':''}">
     ${av.status}
    </span>

    <span class="muted">
     ${attempts.length} session(s)
    </span>
   </div>

   <h3>${esc(e.title)}</h3>

   <p class="muted">
    ${esc(e.description||'No description provided.')}
   </p>

   <div class="exam-meta">
    <div class="meta-box">
     <span>EXAMINER</span>
     <strong>${esc(e.examinerUsername||'—')}</strong>
    </div>

    <div class="meta-box">
     <span>TIMER</span>
     <strong>
      ${e.timerEnabled?`${e.durationMinutes} min`:'Off'}
     </strong>
    </div>

    <div class="meta-box">
     <span>ANTI-CHEAT</span>
     <strong>${e.antiCheat?'On':'Off'}</strong>
    </div>

    <div class="meta-box">
     <span>VIOLATIONS</span>
     <strong>${e.maxViolations}</strong>
    </div>
   </div>

   <div class="exam-card-actions">
    <button
     class="secondary-btn"
     data-action="edit-exam"
     data-id="${e.id}"
    >Edit</button>

    <button
     class="danger-btn"
     data-action="delete-exam"
     data-id="${e.id}"
    >Delete</button>
   </div>
  </div>
 `;
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
 const root=$('#modal-root');

 if(!root)return;

 root.hidden=true;
 root.innerHTML='';
}

/* SUBMISSIONS / VIOLATIONS / ANALYTICS */

function submissionTable(rows){
 if(!rows.length){
  return'<div class="empty">No examination sessions yet.</div>';
 }

 return`
  <div class="table-wrap">
   <table class="data-table">
    <thead>
     <tr>
      <th>Started</th>
      <th>Examiner</th>
      <th>Exam</th>
      <th>Status</th>
      <th>Violations</th>
     </tr>
    </thead>

    <tbody>
     ${rows.map(a=>`
      <tr>
       <td>${fmtDate(a.startedAt)}</td>
       <td>${esc(a.username)}</td>
       <td>${esc(a.examTitle)}</td>
       <td>${esc(a.status)}</td>
       <td>${Number(a.violations)||0}</td>
      </tr>
     `).join('')}
    </tbody>
   </table>
  </div>
 `;
}

function renderSubmissions(){
 const sorted=db.attempts
  .slice()
  .sort((a,b)=>(b.startedAt||0)-(a.startedAt||0));

 $('#admin-submissions-page').innerHTML=`
  <div class="page-head">
   <div>
    <span class="eyebrow">MONITORING</span>
    <h3>Submissions</h3>
    <p>Current and completed examination sessions.</p>
   </div>

   <div class="actions">
    <button class="secondary-btn" data-action="refresh-admin">
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
   n:db.attempts.filter(a=>a.examId===e.id).length
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
   ${kpi('Completion Rate',Math.round(c.completed/total*100)+'%')}
   ${kpi('In Progress',c.inProgress)}
   ${kpi('Termination Rate',Math.round(c.terminated/total*100)+'%')}
   ${kpi('Avg. Violations',avg)}
  </div>

  <div class="grid-2">
   <div class="panel">
    <h3>Session Status</h3>

    ${[
     ['Completed',c.completed],
     ['In Progress',c.inProgress],
     ['Time Expired',c.expired],
     ['Terminated',c.terminated]
    ].map(([l,n])=>chart(l,n,c.total)).join('')}
   </div>

   <div class="panel">
    <h3>Sessions by Exam</h3>

    ${
     byExam.length
     ?byExam.map(x=>chart(x.e.title,x.n,c.total)).join('')
     :'<div class="empty">No exams.</div>'
    }
   </div>
  </div>

  <div class="panel" style="margin-top:18px">
   <h3>Violation Activity</h3>

   <p class="muted" style="font-size:12px">
    ${db.violations.length} security events have been recorded across
    ${db.attempts.length} session(s).
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
 return`
  <div class="kpi">
   <span>${l}</span>
   <strong>${v}</strong>
  </div>
 `;
}

function chart(l,n,total){
 const p=total?Math.round(n/total*100):0;

 return`
  <div class="chart-row">
   <div>
    <div class="chart-label">${esc(l)}</div>

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

    <p class="muted" style="font-size:12px">
     Current theme:
     <strong>${db.theme}</strong>
    </p>

    <button
     class="secondary-btn"
     data-action="toggle-theme"
    >
     Toggle Theme
    </button>
   </div>

   <div class="panel">
    <h3>Current Account</h3>

    <p>
     <strong>${esc(u?.username||'—')}</strong>
    </p>

    <p class="muted">
     ${esc(u?.role||'—')}
    </p>

    <button
     class="danger-btn"
     data-action="reset-demo"
    >
     Reset Demo Data
    </button>
   </div>
  </div>
 `;

 bindActions();
}

/* EXAMINER DASHBOARD */

function getAssignedExamsForUser(u){
 if(!u)return[];

 const username=
  String(u.username||'').trim().toLowerCase();

 const userId=String(u.id||'');

 return db.exams.filter(e=>{
  const assignedId=String(e.examinerUserId||'');
  const assignedUsername=
   String(e.examinerUsername||'').trim().toLowerCase();

  return(
   (userId&&assignedId===userId)||
   (username&&assignedUsername===username)
  );
 });
}

function getUserAttempts(u){
 if(!u)return[];

 const username=
  String(u.username||'').trim().toLowerCase();

 const userId=String(u.id||'');

 return db.attempts.filter(a=>{
  const aid=String(a.userId||'');
  const aname=
   String(a.username||'').trim().toLowerCase();

  return(
   (userId&&aid===userId)||
   (username&&aname===username)
  );
 });
}

function examinerExamCard(e,done,attempts){
 const availability=getAvailability(e);

 const examAttempts=attempts.filter(
  a=>a.examId===e.id
 );

 const inProgress=examAttempts.find(
  a=>a.status==='In Progress'
 );

 const last=examAttempts
  .slice()
  .sort((a,b)=>(b.startedAt||0)-(a.startedAt||0))[0];

 let action='';

 if(done){
  action=`
   <button
    class="secondary-btn"
    disabled
   >
    Exam Locked
   </button>
  `;
 }else if(availability.status!=='Available'){
  action=`
   <button
    class="secondary-btn"
    disabled
   >
    Not Available
   </button>
  `;
 }else{
  action=`
   <button
    class="primary-btn"
    data-action="start-exam"
    data-id="${e.id}"
   >
    ${inProgress?'Resume Exam':'Start Exam'}
   </button>
  `;
 }

 return`
  <div class="exam-card">
   <div class="exam-card-top">
    <span class="status-badge ${
     availability.status==='Available'
      ?'success'
      :''
    }">
     ${availability.status}
    </span>

    <span class="muted">
     ${done?'Completed':inProgress?'In Progress':'Not Started'}
    </span>
   </div>

   <h3>${esc(e.title)}</h3>

   <p class="muted">
    ${esc(e.description||'No description provided.')}
   </p>

   <div class="exam-date-range">
    <span>AVAILABLE</span>

    <strong>
     ${
      e.startAt
      ?fmtDate(e.startAt)
      :'Immediately'
     }

     &nbsp;—&nbsp;

     ${
      e.endAt
      ?fmtDate(e.endAt)
      :'No end date'
     }
    </strong>
   </div>

   <div class="exam-meta">
    <div class="meta-box">
     <span>DURATION</span>
     <strong>
      ${e.timerEnabled?`${e.durationMinutes} min`:'No Timer'}
     </strong>
    </div>

    <div class="meta-box">
     <span>ANTI-CHEAT</span>
     <strong>
      ${e.antiCheat?'Enabled':'Disabled'}
     </strong>
    </div>

    <div class="meta-box">
     <span>MAX VIOLATIONS</span>
     <strong>${e.maxViolations}</strong>
    </div>

    <div class="meta-box">
     <span>ATTEMPTS</span>
     <strong>${examAttempts.length}</strong>
    </div>
   </div>

   ${
    last
    ?`
     <div class="muted" style="font-size:11px;margin-top:12px">
      Last session:
      ${esc(last.status)}
      •
      ${fmtDate(last.startedAt)}
     </div>
    `
    :''
   }

   <div class="exam-card-actions">
    ${action}
   </div>
  </div>
 `;
}

function renderExaminerDashboard(){
 const u=currentUser();

 if(!u)return;

 db=loadDB();

 const assigned=getAssignedExamsForUser(u);
 const attempts=getUserAttempts(u);

 const completedAttempts=attempts.filter(
  a=>[
   'Completed',
   'Time Expired',
   'Terminated'
  ].includes(a.status)
 );

 const completedExamIds=new Set(
  completedAttempts.map(a=>a.examId)
 );

 const taken=completedExamIds.size;
 const totalAssigned=assigned.length;

 const progress=totalAssigned
  ?Math.min(
    100,
    Math.round(taken/totalAssigned*100)
   )
  :0;

 const violations=attempts.reduce(
  (n,a)=>n+(Number(a.violations)||0),
  0
 );

 const spent=totalSpentSeconds(attempts);

 $('#examiner-dashboard-page').innerHTML=`
  <div class="page-head">
   <div>
    <span class="eyebrow">EXAMINER PORTAL</span>
    <h3>My Examinations</h3>
    <p>
     Select an assigned examination to begin your session.
    </p>
   </div>

   <div class="actions">
    <button
     class="secondary-btn"
     data-action="refresh-examiner"
    >
     Refresh
    </button>
   </div>
  </div>

  <div class="examiner-stats">
   <div class="panel metric-panel">
    <span class="metric-label">Tests Taken</span>

    <strong>
     ${taken} / ${totalAssigned}
    </strong>

    <div class="progress-bar">
     <div
      class="progress-fill"
      style="width:${progress}%"
     ></div>
    </div>

    <span class="metric-sub">
     ${progress}% completion
    </span>
   </div>

   <div class="panel metric-panel">
    <span class="metric-label">Violations</span>

    <strong>
     ${violations}
    </strong>

    <span class="metric-sub">
     Total recorded security events
    </span>
   </div>

   <div class="panel metric-panel">
    <span class="metric-label">Total Time Spent</span>

    <strong>
     ${formatDuration(spent)}
    </strong>

    <span class="metric-sub">
     Across your examination sessions
    </span>
   </div>
  </div>

  <div class="panel" style="margin-bottom:18px">
   <div class="progress-meta">
    <span>EXAMINATION PROGRESS</span>
    <strong>${taken}/${totalAssigned}</strong>
   </div>

   <div class="progress-bar">
    <div
     class="progress-fill"
     style="width:${progress}%"
    ></div>
   </div>
  </div>

  <div class="exam-grid">
   ${
    assigned.length
    ?assigned.map(e=>
      examinerExamCard(
       e,
       completedExamIds.has(e.id),
       attempts
      )
     ).join('')
    :`
     <div class="panel empty">
      No examinations have been assigned to your account yet.
     </div>
    `
   }
  </div>
 `;

 bindActions();
}

/* START EXAM FLOW */

/*
 * FIX:
 * The previous version created the Start Examination button dynamically,
 * but did not re-bind the button after inserting the modal into the DOM.
 * This caused the Start button and X/Cancel buttons to appear but do nothing.
 *
 * The modal now calls bindActions() after rendering.
 */

function startExam(id){
 const e=db.exams.find(x=>x.id===id);
 const u=currentUser();

 if(!e||!u)return;

 const assigned=
  getAssignedExamsForUser(u).some(
   x=>x.id===id
  );

 if(!assigned){
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

 const completed=db.attempts.some(
  a=>
   a.examId===id &&
   (
    (a.userId&&a.userId===u.id)||
    String(a.username||'').toLowerCase()===
    String(u.username||'').toLowerCase()
   ) &&
   [
    'Completed',
    'Time Expired',
    'Terminated'
   ].includes(a.status)
 );

 if(completed){
  toast(
   'This exam is locked because it has already been taken.',
   'error'
  );
  return;
 }

 const inProg=db.attempts.find(
  a=>
   a.examId===id &&
   (
    (a.userId&&a.userId===u.id)||
    String(a.username||'').toLowerCase()===
    String(u.username||'').toLowerCase()
   ) &&
   a.status==='In Progress'
 );

 openStartInstructions(e,!!inProg);
}

function openStartInstructions(e,resume=false){
 const root=$('#modal-root');

 if(!root)return;

 root.hidden=false;

 root.innerHTML=`
  <div class="modal">

   <div class="modal-head">
    <div>
     <span class="eyebrow">
      ${resume?'RESUME EXAMINATION':'EXAM INSTRUCTIONS'}
     </span>

     <h3>${esc(e.title)}</h3>
    </div>

    <button
     type="button"
     class="close-btn"
     data-action="close-modal"
     aria-label="Close"
     title="Close"
    >×</button>
   </div>

   <div class="modal-body">

    <div class="notice">
     ${
      resume
      ?'An unfinished examination session was found. Click Resume Examination to continue the existing session.'
      :'You can take this examination only once. Once submitted, expired or terminated, it cannot be retaken.'
     }
    </div>

    <ul
     style="
      color:var(--muted);
      font-size:13px;
      line-height:1.8;
      padding-left:20px
     "
    >
     <li>
      ${
       boolSetting(e.timerEnabled,false)
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
     data-id="${e.id}"
    >
     ${resume?'Resume Examination':'Start Examination'}
    </button>

   </div>

  </div>
 `;

 /*
  * IMPORTANT FIX:
  * Bind the newly-created X, Cancel and Start buttons.
  */
 bindActions();
}

function confirmStart(id){
 const e=db.exams.find(x=>x.id===id);
 const u=currentUser();

 if(!e||!u)return;

 /*
  * Re-check availability and assignment before starting.
  */
 const assigned=
  getAssignedExamsForUser(u).some(
   x=>x.id===id
  );

 if(!assigned){
  closeModal();

  toast(
   'This exam is not assigned to your account.',
   'error'
  );

  return;
 }

 if(getAvailability(e).status!=='Available'){
  closeModal();

  toast(
   'This exam is not currently available.',
   'error'
  );

  return;
 }

 /*
  * Once a completed/expired/terminated attempt exists,
  * the exam is permanently locked.
  */
 const completed=db.attempts.some(
  a=>
   a.examId===id &&
   (
    (a.userId&&a.userId===u.id)||
    String(a.username||'').toLowerCase()===
    String(u.username||'').toLowerCase()
   ) &&
   [
    'Completed',
    'Time Expired',
    'Terminated'
   ].includes(a.status)
 );

 if(completed){
  closeModal();

  toast(
   'This exam is locked because it has already been taken.',
   'error'
  );

  return;
 }

 closeModal();

 const timerEnabled=boolSetting(
  e.timerEnabled,
  false
 );

 const durationMinutes=Math.max(
  1,
  Math.round(Number(e.durationMinutes)||60)
 );

 const antiCheat=boolSetting(
  e.antiCheat,
  false
 );

 const maxViolations=Math.max(
  1,
  Math.round(Number(e.maxViolations)||3)
 );

 /*
  * Persist normalized settings.
  */
 e.timerEnabled=timerEnabled;
 e.durationMinutes=durationMinutes;
 e.antiCheat=antiCheat;
 e.maxViolations=maxViolations;

 saveDB();

 currentExam=clone(e);

 const now=Date.now();

 /*
  * IMPORTANT FIX:
  * Reuse an existing In Progress attempt instead of creating
  * a duplicate attempt.
  */
 const existing=db.attempts.find(
  a=>
   a.examId===e.id &&
   (
    (a.userId&&a.userId===u.id)||
    String(a.username||'').toLowerCase()===
    String(u.username||'').toLowerCase()
   ) &&
   a.status==='In Progress'
 );

 const attempt=existing||{
  id:uid('attempt'),
  examId:e.id,
  examTitle:e.title,
  username:u.username,
  userId:u.id,
  startedAt:now,
  endedAt:null,
  status:'In Progress',
  violations:0
 };

 if(!existing){
  db.attempts.push(attempt);
 }

 attempt.userId=u.id;
 attempt.username=u.username;
 attempt.examTitle=e.title;
 attempt.startedAt=attempt.startedAt||now;
 attempt.violations=Number(attempt.violations)||0;
 attempt.endedAt=null;
 attempt.status='In Progress';

 saveDB();

 clearInterval(timer);

 /*
  * Calculate remaining time when resuming an unfinished session.
  */
 const elapsed=existing
  ?Math.max(
    0,
    Math.floor(
     (now-(attempt.startedAt||now))/1000
    )
   )
  :0;

 const remaining=timerEnabled
  ?Math.max(
    0,
    durationMinutes*60-elapsed
   )
  :0;

 examState={
  attemptId:attempt.id,
  seconds:remaining,
  timerEnabled,
  antiCheat,
  maxViolations,
  startedAt:attempt.startedAt||now,
  active:true
 };

 /*
  * Build the actual examination session page.
  */
 $('#live-exam-title').textContent=e.title;

 $('#live-exam-examiner').textContent=
  'Assigned to '+u.username;

 $('#exam-violations').textContent=
  `${attempt.violations} / ${maxViolations}`;

 /*
  * Load the Google Form.
  */
 $('#exam-iframe').src=e.formUrl;

 /*
  * Session instructions displayed directly above the form.
  */
 $('#exam-instructions').textContent=
  timerEnabled
  ?`Timer: ${durationMinutes} minutes • Anti-cheat: ${
    antiCheat?'Enabled':'Disabled'
   } • Submit the Google Form, then click Submit Exam.`
  :`No timer • Anti-cheat: ${
    antiCheat?'Enabled':'Disabled'
   } • Submit the Google Form, then click Submit Exam.`;

 /*
  * IMPORTANT:
  * This changes the screen from the Examiner Dashboard
  * to the dedicated live examination session.
  *
  * The timer is located in the exam header in index.html:
  * #exam-timer
  */
 showView('exam');

 document.body.classList.add(
  'lockdown-active'
 );

 $('#exam-view').classList.add(
  'lockdown-active'
 );

 /*
  * Give the page a short grace period before monitoring
  * focus/fullscreen events.
  */
 graceUntil=Date.now()+GRACE;

 /*
  * Start fullscreen when anti-cheat is enabled.
  */
 if(antiCheat){
  requestFullscreen().finally(()=>{
   graceUntil=Date.now()+GRACE;
  });
 }

 /*
  * Immediately render the timer at the top of the page.
  */
 renderTimer();

 /*
  * Start countdown immediately.
  */
 if(timerEnabled){

  /*
   * If a resumed attempt has already consumed the entire
   * allotted duration, end it immediately.
   */
  if(examState.seconds<=0){
   finishExam(
    'Time Expired',
    'Time Expired',
    'Your allotted examination time has ended.',
    '⌛'
   );

   return;
  }

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

 const duration=Math.max(
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

  if(a.startedAt){
   a.durationSeconds=Math.max(
    0,
    Math.floor(
     (a.endedAt-a.startedAt)/1000
    )
   );
  }
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

 const resultTime=$('#result-time');

 if(resultTime){
  resultTime.textContent=
   formatDuration(a?.durationSeconds||0);
 }

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

    /*
     * FIX:
     * Both the X button and Cancel button now close
     * the dynamically-created exam instruction modal.
     */
    if(a==='close-modal'){
     closeModal();
    }

    /*
     * FIX:
     * The dynamically-created Start Examination button
     * now correctly calls confirmStart().
     */
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

    if(a==='refresh-examiner'){
     db=loadDB();
     renderExaminerDashboard();
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
  const adminClock=$('#admin-clock');
  const examinerClock=$('#examiner-clock');

  if(adminClock){
   adminClock.textContent=
    new Date().toLocaleString();
  }

  if(examinerClock){
   examinerClock.textContent=
    new Date().toLocaleString();
  }
 },
 1000
);

/* AUTHENTICATION INITIALIZATION */

function initAuthentication(){
 const loginForm=$('#login-form');

 if(loginForm&&loginForm.dataset.bound!=='1'){
  loginForm.addEventListener(
   'submit',
   handleLogin
  );

  loginForm.dataset.bound='1';
 }

 $$('.nav-item[data-admin-page]').forEach(b=>{
  if(b.dataset.navBound==='1')return;

  b.addEventListener(
   'click',
   ()=>{
    adminPage(
     b.dataset.adminPage
    );
   }
  );

  b.dataset.navBound='1';
 });
}

/* ADMIN PAGE FALLBACK */

function renderAdminPage(page){
 const normalized=String(page||'dashboard')
  .replace('admin-','')
  .replace('-page','');

 adminPage(
  normalized==='dashboard'
   ?'dashboard'
   :normalized
 );
}

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

 if(
  session&&
  currentUser()
 ){
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
