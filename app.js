/* Secure Exam Portal - frontend prototype
   Builds on the original client-side proctoring approach. Because this is a
   browser-only app, authentication, passwords, attempt locks and logs are
   stored in localStorage and are NOT secure enough for production. A real
   deployment should move auth, exam data, attempts and violation records to a
   server/database. Google Forms remain cross-origin, so this app cannot detect
   the actual Google Forms Submit click; the portal Submit button is the
   auditable end-of-session signal.
*/

const KEY='secure_exam_portal_v2';
const SESSION='secure_exam_session_v2';
const DEFAULT_FORM='https://docs.google.com/forms/d/e/1FAIpQLSf_PLACEHOLDER_FORM_ID/viewform?embedded=true';

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

let db;
let session=null;
let currentExam=null;
let examState=null;
let timer=null;
let violationOverlayOpen=false;
let graceUntil=0;

const GRACE=2500;

function $(selector){
 return document.querySelector(selector);
}

function $$(selector){
 return [...document.querySelectorAll(selector)];
}

function clone(obj){
 return JSON.parse(JSON.stringify(obj));
}

function uid(prefix='id'){
 return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2,9)}`;
}

function esc(value){
 return String(value??'')
  .replace(/&/g,'&amp;')
  .replace(/</g,'&lt;')
  .replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;')
  .replace(/'/g,'&#039;');
}

function boolSetting(value,fallback=false){
 if(value===true||value===false)return value;
 if(value==='true')return true;
 if(value==='false')return false;
 return fallback;
}

function saveDB(){
 localStorage.setItem(KEY,JSON.stringify(db));
}

function saveSession(){
 if(session){
  localStorage.setItem(SESSION,JSON.stringify(session));
 }else{
  localStorage.removeItem(SESSION);
 }
}

function loadSession(){
 try{
  const raw=localStorage.getItem(SESSION);
  session=raw?JSON.parse(raw):null;
 }catch{
  session=null;
 }
}

function loadDB(){
 let stored=null;

 try{
  const raw=localStorage.getItem(KEY);
  stored=raw?JSON.parse(raw):null;
 }catch{
  stored=null;
 }

 if(!stored||typeof stored!=='object'){
  stored=clone(seed);
 }

 stored.users=Array.isArray(stored.users)?stored.users:[];
 stored.exams=Array.isArray(stored.exams)?stored.exams:[];
 stored.attempts=Array.isArray(stored.attempts)?stored.attempts:[];
 stored.violations=Array.isArray(stored.violations)?stored.violations:[];
 stored.theme=stored.theme==='light'?'light':'dark';

 const adminExists=stored.users.some(
  u=>String(u?.username||'').trim().toLowerCase()==='admin'
 );

 if(!adminExists){
  stored.users.push({
   id:'u-admin',
   username:'admin',
   password:'123admin',
   role:'admin',
   name:'Administrator'
  });
 }

 const testExists=stored.users.some(
  u=>String(u?.username||'').trim().toLowerCase()==='test'
 );

 if(!testExists){
  stored.users.push({
   id:'u-test',
   username:'test',
   password:'test',
   role:'examiner',
   name:'Test Examiner'
  });
 }

 stored.exams=stored.exams.map(ex=>{
  const e={
   ...ex
  };

  e.id=e.id||uid('exam');
  e.title=e.title||'Untitled Examination';
  e.description=e.description||'';
  e.formUrl=e.formUrl||DEFAULT_FORM;
  e.examinerUsername=String(e.examinerUsername||'').trim();
  e.examinerPassword=String(e.examinerPassword??'');
  e.antiCheat=boolSetting(e.antiCheat,true);
  e.maxViolations=Math.max(
   1,
   Number(e.maxViolations)||3
  );
  e.timerEnabled=boolSetting(e.timerEnabled,true);
  e.durationMinutes=Math.max(
   1,
   Number(e.durationMinutes)||60
  );
  e.startAt=e.startAt||'';
  e.endAt=e.endAt||'';
  e.active=e.active!==false;
  e.createdAt=e.createdAt||Date.now();
  e.createdBy=e.createdBy||'u-admin';

  let account=null;

  if(e.examinerUsername){
   account=stored.users.find(u=>
    String(u?.username||'').trim().toLowerCase()===
    e.examinerUsername.toLowerCase() &&
    u?.role!=='admin'
   );

   if(!account){
    account={
     id:e.examinerUserId||uid('user'),
     username:e.examinerUsername,
     password:e.examinerPassword,
     role:'examiner',
     name:e.examinerUsername
    };

    stored.users.push(account);
   }

   account.username=e.examinerUsername;
   account.password=e.examinerPassword;
   account.role='examiner';
   account.name=account.name||account.username;

   e.examinerUserId=account.id;

   /*
    * Keep the assigned examiner credentials synchronized with the
    * account stored in the database.
    */
   e.examinerUsername=account.username;
   e.examinerUserId=account.id;
  }

  return e;
 });

 localStorage.setItem(KEY,JSON.stringify(stored));

 return stored;
}

db=loadDB();
loadSession();

function currentUser(){
 if(!session)return null;

 return db.users.find(
  u=>u.id===session.userId
 ) ||
 db.users.find(
  u=>
   String(u.username||'').trim().toLowerCase()===
   String(session.username||'').trim().toLowerCase()
 );

 return null;
}

function showView(name){
 $$('.view').forEach(view=>{
  view.classList.remove('active');
  view.hidden=true;
 });

 const view=$(`#${name}-view`);

 if(view){
  view.hidden=false;
  view.classList.add('active');
 }
}

function showLoading(text='Loading...'){
 const el=$('#loading-overlay');

 if(el){
  el.hidden=false;

  const message=el.querySelector('[data-loading-message]');

  if(message){
   message.textContent=text;
  }
 }
}

function hideLoading(){
 const el=$('#loading-overlay');

 if(el){
  el.hidden=true;
 }
}

function showLoginError(message){
 const el=$('#login-error');

 if(el){
  el.textContent=message;
  el.hidden=false;
 }
}

function clearLoginError(){
 const el=$('#login-error');

 if(el){
  el.textContent='';
  el.hidden=true;
 }
}

function toast(message,type='info'){
 const root=$('#toast-root');

 if(!root)return;

 const item=document.createElement('div');

 item.className=`toast ${type}`;
 item.textContent=message;

 root.appendChild(item);

 setTimeout(()=>{
  item.remove();
 },3500);
}

function closeModal(){
 const root=$('#modal-root');

 if(root){
  root.hidden=true;
  root.innerHTML='';
 }
}

function getAvailability(exam){
 const now=Date.now();

 if(exam.active===false){
  return{
   status:'Unavailable',
   label:'Inactive'
  };
 }

 const start=exam.startAt?
  new Date(exam.startAt).getTime():
  null;

 const end=exam.endAt?
  new Date(exam.endAt).getTime():
  null;

 if(start&&!Number.isNaN(start)&&now<start){
  return{
   status:'Upcoming',
   label:`Starts ${formatDateTime(exam.startAt)}`
  };
 }

 if(end&&!Number.isNaN(end)&&now>end){
  return{
   status:'Expired',
   label:`Ended ${formatDateTime(exam.endAt)}`
  };
 }

 return{
  status:'Available',
  label:'Available now'
 };
}

function formatDateTime(value){
 if(!value)return'Not set';

 const d=new Date(value);

 if(Number.isNaN(d.getTime()))return'Not set';

 return d.toLocaleString(
  undefined,
  {
   year:'numeric',
   month:'short',
   day:'2-digit',
   hour:'2-digit',
   minute:'2-digit'
  }
 );
}

function formatDuration(seconds){
 const total=Math.max(
  0,
  Number(seconds)||0
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

function getAssignedExamsForUser(u){
 if(!u)return[];

 const username=String(u.username||'').trim().toLowerCase();
 const userId=String(u.id||'');

 return db.exams.filter(e=>{
  const assignedId=String(e.examinerUserId||'');
  const assignedUsername=String(
   e.examinerUsername||''
  ).trim().toLowerCase();

  return(
   (userId&&assignedId===userId)||
   (username&&assignedUsername===username)
  );
 });
}

function getUserAttempts(u){
 if(!u)return[];

 return db.attempts.filter(a=>
  (
   a.userId&&a.userId===u.id
  ) ||
  (
   String(a.username||'').trim().toLowerCase()===
   String(u.username||'').trim().toLowerCase()
  )
 );
}

/* =========================
   AUTHENTICATION
========================= */
function handleLogin(e){
  if(e)e.preventDefault();

  const form=$('#login-form');
  const usernameEl=$('#login-username');
  const passwordEl=$('#login-password');

  if(!form||!usernameEl||!passwordEl)return false;
  if(form.dataset.loggingIn==='1')return false;

  form.dataset.loggingIn='1';
  clearLoginError();

  const username=String(usernameEl.value||'').trim();
  const password=String(passwordEl.value||'');
  const key=username.toLowerCase();

  if(!username||!password){
    showLoginError('Please enter both your username and your password.');
    (username?passwordEl:usernameEl).focus();
    form.dataset.loggingIn='';
    return false;
  }

  // Reload and repair the database before authentication.
  try{
    db=loadDB();
  }catch(err){
    console.error('Database repair failed:',err);
    db=clone(seed);
    saveDB();
  }

  // Built-in credentials.
  const credentials={
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

  let user=null;

  // Check built-in credentials first.
  if(
    credentials[key] &&
    credentials[key].password===password
  ){
    const c=credentials[key];

    user={
      id:c.id,
      username:key,
      password:c.password,
      role:c.role,
      name:c.name
    };
  }else{
    // Check accounts created by the Admin.
    user=db.users.find(u=>
      String(u?.username||'').trim().toLowerCase()===key &&
      String(u?.password??'')===password &&
      (u?.role==='admin'||u?.role==='examiner')
    )||null;

    // Recover examiner account from an assigned exam if needed.
    if(!user){
      const assignedExam=db.exams.find(ex=>
        String(ex?.examinerUsername||'').trim().toLowerCase()===key &&
        String(ex?.examinerPassword??'')===password
      );

      if(assignedExam){
        user=db.users.find(u=>
          String(u?.username||'').trim().toLowerCase()===key &&
          u?.role==='examiner'
        )||{
          id:uid('user'),
          username:String(assignedExam.examinerUsername).trim(),
          password:String(assignedExam.examinerPassword),
          role:'examiner',
          name:String(assignedExam.examinerUsername).trim()
        };

        if(!db.users.some(u=>u.id===user.id)){
          db.users.push(user);
        }

        saveDB();
      }
    }
  }

  // Invalid login.
  if(!user){
    showLoginError(
      'Incorrect username or password. Please check your credentials and try again.'
    );

    passwordEl.value='';
    passwordEl.focus();

    form.classList.remove('login-error-shake');
    void form.offsetWidth;
    form.classList.add('login-error-shake');

    form.dataset.loggingIn='';
    return false;
  }

  // Make sure the authenticated account exists in localStorage.
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

  // Create login session.
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

  // Open the correct dashboard.
  openPortal();
  hideLoading();

  form.dataset.loggingIn='';

  return false;
}

/* =========================
   PORTAL ROUTING
========================= */

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

/* =========================
   ADMIN
========================= */

function openAdmin(){
 showView('admin');
 renderAdminDashboard();
 bindAdminNavigation();
}

function bindAdminNavigation(){
 $$('.nav-item[data-admin-page]').forEach(btn=>{
  if(btn.dataset.navBound==='1')return;

  btn.addEventListener('click',()=>{
   const page=btn.dataset.adminPage;

   $$('.nav-item[data-admin-page]').forEach(x=>{
    x.classList.toggle(
     'active',
     x===btn
    );
   });

   $$('.admin-page').forEach(p=>{
    p.classList.remove('active');
   });

   const target=$(`#admin-${page}-page`);

   if(target){
    target.classList.add('active');
   }

   if(page==='dashboard'){
    renderAdminDashboard();
   }

   if(page==='exams'){
    renderAdminExams();
   }
  });

  btn.dataset.navBound='1';
 });
}

function renderAdminDashboard(){
 const root=$('#admin-dashboard-page');

 if(!root)return;

 const totalExams=db.exams.length;
 const activeExams=db.exams.filter(
  e=>getAvailability(e).status==='Available'
 ).length;

 const attempts=db.attempts;

 const completed=attempts.filter(
  a=>['Completed','Time Expired','Terminated'].includes(a.status)
 ).length;

 const inProgress=attempts.filter(
  a=>a.status==='In Progress'
 ).length;

 const totalViolations=db.violations.length;

 root.innerHTML=`
  <div class="page-heading">
   <div>
    <span class="eyebrow">ADMINISTRATION</span>
    <h1>Dashboard</h1>
    <p>Monitor examinations, submissions and security activity.</p>
   </div>
  </div>

  <div class="stat-grid">
   <div class="stat-card">
    <span>EXAMINATIONS</span>
    <strong>${totalExams}</strong>
    <small>${activeExams} currently available</small>
   </div>

   <div class="stat-card">
    <span>COMPLETED</span>
    <strong>${completed}</strong>
    <small>${attempts.length} total sessions</small>
   </div>

   <div class="stat-card">
    <span>IN PROGRESS</span>
    <strong>${inProgress}</strong>
    <small>Active examination sessions</small>
   </div>

   <div class="stat-card">
    <span>VIOLATIONS</span>
    <strong>${totalViolations}</strong>
    <small>Logged security events</small>
   </div>
  </div>

  <div class="grid-2">
   <section class="panel">
    <div class="panel-heading">
     <div>
      <span class="eyebrow">CURRENT SUBMISSIONS</span>
      <h2>Submission Progress</h2>
     </div>
    </div>

    ${
     attempts.length
      ? attempts
       .slice()
       .sort(
        (a,b)=>
         (b.startedAt||0)-
         (a.startedAt||0)
       )
       .slice(0,10)
       .map(a=>`
        <div class="list-row">
         <div>
          <strong>${esc(a.examTitle||'Examination')}</strong>
          <span>${esc(a.username||'—')}</span>
         </div>
         <div>
          ${badge(a.status)}
         </div>
        </div>
       `)
       .join('')
      :
       `<div class="empty-state">No examination sessions yet.</div>`
    }
   </section>

   <section class="panel">
    <div class="panel-heading">
     <div>
      <span class="eyebrow">EXAMINATIONS</span>
      <h2>Managed Exams</h2>
     </div>
    </div>

    ${
     db.exams.length
      ? db.exams.map(e=>`
       <div class="list-row">
        <div>
         <strong>${esc(e.title)}</strong>
         <span>${esc(e.examinerUsername||'Unassigned')}</span>
        </div>
        <div>
         ${badge(getAvailability(e).status)}
        </div>
       </div>
      `).join('')
      :
       `<div class="empty-state">No examinations configured.</div>`
    }
   </section>
  </div>
 `;

 renderAdminExams();
}

function renderAdminExams(){
 const root=$('#admin-exams-page');

 if(!root)return;

 root.innerHTML=`
  <div class="page-heading">
   <div>
    <span class="eyebrow">EXAM MANAGEMENT</span>
    <h1>Examinations</h1>
    <p>Create, update and manage assigned examinations.</p>
   </div>

   <button
    class="primary-btn"
    data-action="add-exam"
    type="button"
   >
    + Add Examination
   </button>
  </div>

  <div class="exam-grid">
   ${
    db.exams.length
     ? db.exams.map(renderAdminExamCard).join('')
     :
      `<div class="panel empty-state">
       No examinations have been created yet.
      </div>`
   }
  </div>
 `;
}

function renderAdminExamCard(e){
 const availability=getAvailability(e);

 const attempts=db.attempts.filter(
  a=>a.examId===e.id
 );

 const completed=attempts.filter(
  a=>['Completed','Time Expired','Terminated'].includes(a.status)
 ).length;

 return`
  <article class="exam-card">
   <div class="exam-card-top">
    ${badge(availability.status)}
   </div>

   <h3>${esc(e.title)}</h3>

   <p>
    ${esc(e.description||'No description provided.')}
   </p>

   <div class="exam-meta">
    <div class="meta-box">
     <span>Examiner</span>
     <strong>${esc(e.examinerUsername||'—')}</strong>
    </div>

    <div class="meta-box">
     <span>Duration</span>
     <strong>
      ${e.timerEnabled?
       `${e.durationMinutes} min`:
       'No timer'
      }
     </strong>
    </div>

    <div class="meta-box">
     <span>Anti-cheat</span>
     <strong>
      ${e.antiCheat?'Enabled':'Disabled'}
     </strong>
    </div>

    <div class="meta-box">
     <span>Attempts</span>
     <strong>${completed} completed</strong>
    </div>
   </div>

   <div class="exam-date-range">
    <span>AVAILABILITY</span>
    <strong>
     ${e.startAt?
      formatDateTime(e.startAt):
      'No start date'
     }
     →
     ${e.endAt?
      formatDateTime(e.endAt):
      'No end date'
     }
    </strong>
   </div>

   <div class="exam-card-actions">
    <button
     class="secondary-btn"
     type="button"
     data-action="edit-exam"
     data-id="${e.id}"
    >
     Edit
    </button>

    <button
     class="danger-btn"
     type="button"
     data-action="delete-exam"
     data-id="${e.id}"
    >
     Delete
    </button>
   </div>
  </article>
 `;
}

function openExamForm(id=null){
 const existing=id?
  db.exams.find(e=>e.id===id):
  null;

 const e=existing||{
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
  <div class="modal modal-large">
   <div class="modal-head">
    <div>
     <span class="eyebrow">
      ${existing?'EDIT':'CREATE'} EXAMINATION
     </span>
     <h3>${existing?'Update Examination':'Add Examination'}</h3>
    </div>

    <button
     class="close-btn"
     type="button"
     data-action="close-modal"
     aria-label="Close"
    >×</button>
   </div>

   <form
    id="exam-form"
    class="modal-body form-grid"
    data-id="${existing?existing.id:''}"
   >
    <div class="field full">
     <label>Exam Title</label>
     <input
      name="title"
      required
      value="${esc(e.title)}"
      placeholder="e.g. HR Certification Examination"
     >
    </div>

    <div class="field full">
     <label>Description</label>
     <textarea
      name="description"
      rows="3"
      placeholder="Enter the examination description"
     >${esc(e.description)}</textarea>
    </div>

    <div class="field full">
     <label>Google Form Link</label>
     <input
      name="formUrl"
      type="url"
      required
      value="${esc(e.formUrl)}"
      placeholder="https://docs.google.com/forms/..."
     >
    </div>

    <div class="field">
     <label>Examiner Username</label>
     <input
      name="examinerUsername"
      required
      value="${esc(e.examinerUsername)}"
      placeholder="Username"
     >
    </div>

    <div class="field">
     <label>Examiner Password</label>
     <input
      name="examinerPassword"
      required
      value="${esc(e.examinerPassword)}"
      placeholder="Password"
     >
    </div>

    <div class="field">
     <label>Start Date / Time</label>
     <input
      name="startAt"
      type="datetime-local"
      value="${esc(e.startAt)}"
     >
    </div>

    <div class="field">
     <label>End Date / Time</label>
     <input
      name="endAt"
      type="datetime-local"
      value="${esc(e.endAt)}"
     >
    </div>

    <div class="field">
     <label>Timer</label>
     <select name="timerEnabled">
      <option value="true" ${e.timerEnabled?'selected':''}>
       Enabled
      </option>
      <option value="false" ${!e.timerEnabled?'selected':''}>
       Disabled
      </option>
     </select>
    </div>

    <div class="field">
     <label>Duration in Minutes</label>
     <input
      name="durationMinutes"
      type="number"
      min="1"
      value="${Number(e.durationMinutes)||60}"
     >
    </div>

    <div class="field">
     <label>Anti-cheat</label>
     <select name="antiCheat">
      <option value="true" ${e.antiCheat?'selected':''}>
       Enabled
      </option>
      <option value="false" ${!e.antiCheat?'selected':''}>
       Disabled
      </option>
     </select>
    </div>

    <div class="field">
     <label>Maximum Violations</label>
     <input
      name="maxViolations"
      type="number"
      min="1"
      value="${Number(e.maxViolations)||3}"
     >
    </div>

    <div class="field full">
     <label>
      <input
       name="active"
       type="checkbox"
       ${e.active!==false?'checked':''}
      >
      Examination Active
     </label>
    </div>

    <div class="modal-footer full">
     <button
      class="secondary-btn"
      type="button"
      data-action="close-modal"
     >
      Cancel
     </button>

     <button
      class="primary-btn"
      type="submit"
     >
      ${existing?'Save Changes':'Create Examination'}
     </button>
    </div>
   </form>
  </div>
 `;

 const form=$('#exam-form');

 if(form){
  form.addEventListener(
   'submit',
   saveExam
  );
 }

 bindActions();
}

function saveExam(event){
 event.preventDefault();

 const form=event.currentTarget;
 const id=form.dataset.id||'';
 const data=new FormData(form);

 const title=String(
  data.get('title')||''
 ).trim();

 const description=String(
  data.get('description')||''
 ).trim();

 const formUrl=String(
  data.get('formUrl')||''
 ).trim();

 const examinerUsername=String(
  data.get('examinerUsername')||''
 ).trim();

 const examinerPassword=String(
  data.get('examinerPassword')||''
 );

 if(!title||!formUrl||!examinerUsername||!examinerPassword){
  toast(
   'Please complete all required examination fields.',
   'error'
  );
  return;
 }

 if(!id&&db.exams.length>=6){
  toast(
   'You can create a maximum of 6 examinations.',
   'error'
  );
  return;
 }

 let exam=id?
  db.exams.find(e=>e.id===id):
  null;

 if(!exam){
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
 exam.antiCheat=
  String(data.get('antiCheat'))==='true';

 exam.maxViolations=Math.max(
  1,
  Number(data.get('maxViolations'))||3
 );

 exam.timerEnabled=
  String(data.get('timerEnabled'))==='true';

 exam.durationMinutes=Math.max(
  1,
  Number(data.get('durationMinutes'))||60
 );

 exam.startAt=String(
  data.get('startAt')||''
 );

 exam.endAt=String(
  data.get('endAt')||''
 );

 exam.active=form.querySelector(
  '[name="active"]'
 )?.checked!==false;

 /*
  * Create or update the examiner account.
  */
 let account=db.users.find(
  u=>
   String(u.username||'').trim().toLowerCase()===
   examinerUsername.toLowerCase() &&
   u.role!=='admin'
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
 }

 exam.examinerUserId=account.id;

 saveDB();

 closeModal();

 renderAdminDashboard();
 renderAdminExams();

 toast(
  id?
   'Examination updated successfully.':
   'Examination created successfully.',
  'success'
 );
}

function deleteExam(id){
 const exam=db.exams.find(e=>e.id===id);

 if(!exam)return;

 const confirmed=window.confirm(
  `Delete "${exam.title}"?\n\nThis will remove the examination from the admin portal.`
 );

 if(!confirmed)return;

 db.exams=db.exams.filter(
  e=>e.id!==id
 );

 saveDB();

 renderAdminDashboard();
 renderAdminExams();

 toast(
  'Examination deleted.',
  'success'
 );
}

/* =========================
   EXAMINER DASHBOARD
========================= */

function openExaminer(){
 showView('examiner');

 db=loadDB();

 renderExaminerDashboard();
}

function renderExaminerDashboard(){
 const root=$('#examiner-dashboard-page');

 if(!root)return;

 db=loadDB();

 const u=currentUser();

 if(!u){
  openPortal();
  return;
 }

 const exams=getAssignedExamsForUser(u);
 const attempts=getUserAttempts(u);

 const completedAttempts=attempts.filter(
  a=>['Completed','Time Expired','Terminated'].includes(a.status)
 );

 const totalViolations=attempts.reduce(
  (sum,a)=>sum+(Number(a.violations)||0),
  0
 );

 const totalSeconds=completedAttempts.reduce(
  (sum,a)=>sum+(Number(a.durationSeconds)||0),
  0
 );

 const completedExamIds=new Set(
  completedAttempts.map(a=>a.examId)
 );

 const progress=exams.length?
  Math.round(
   (completedExamIds.size/exams.length)*100
  ):
  0;

 root.innerHTML=`
  <div class="page-heading">
   <div>
    <span class="eyebrow">EXAMINER PORTAL</span>
    <h1>Welcome, ${esc(u.name||u.username)}</h1>
    <p>Review your assigned examinations and examination progress.</p>
   </div>

   <div class="helper">
    Examiner: <strong>${esc(u.username)}</strong>
   </div>
  </div>

  <div class="examiner-stats">
   <section class="panel metric-panel">
    <span class="metric-label">TESTS TAKEN</span>
    <strong>${completedExamIds.size} / ${exams.length}</strong>

    <div class="progress-bar">
     <div
      class="progress-fill"
      style="width:${progress}%"
     ></div>
    </div>

    <span class="metric-sub">
     ${progress}% completion
    </span>
   </section>

   <section class="panel metric-panel">
    <span class="metric-label">VIOLATIONS</span>
    <strong>${totalViolations}</strong>
    <span class="metric-sub">
     Total recorded security violations
    </span>
   </section>

   <section class="panel metric-panel">
    <span class="metric-label">TOTAL TIME SPENT</span>
    <strong>${formatDuration(totalSeconds)}</strong>
    <span class="metric-sub">
     Across completed examinations
    </span>
   </section>
  </div>

  <section class="panel">
   <div class="panel-heading">
    <div>
     <span class="eyebrow">ASSIGNED EXAMINATIONS</span>
     <h2>Your Examinations</h2>
    </div>
   </div>

   ${
    exams.length
     ?
      `<div class="exam-grid">
       ${exams.map(
        e=>renderExaminerExamCard(
         e,
         u
        )
       ).join('')}
      </div>`
     :
      `<div class="empty-state">
       No examinations have been assigned to your account.
      </div>`
   }
  </section>
 `;
}

function renderExaminerExamCard(e,u){
 const attempts=getUserAttempts(u).filter(
  a=>a.examId===e.id
 );

 const completed=attempts.find(
  a=>['Completed','Time Expired','Terminated'].includes(a.status)
 );

 const last=attempts
  .slice()
  .sort(
   (a,b)=>
    (b.startedAt||0)-
    (a.startedAt||0)
  )[0];

 const inProgress=attempts.find(
  a=>a.status==='In Progress'
 );

 const availability=getAvailability(e);

 const done=!!completed;

 const canStart=
  !done&&
  !inProgress&&
  availability.status==='Available';

 const canResume=
  !done&&
  !!inProgress;

 return`
  <article class="exam-card">
   <div class="exam-card-top">
    ${
     done
      ? '<span class="badge green">COMPLETED</span>'
      : badge(
       canResume?
        'In Progress':
        availability.status
      )
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
      ${e.timerEnabled?
       `${e.durationMinutes} min`:
       'No timer'
      }
     </strong>
    </div>

    <div class="meta-box">
     <span>Anti-cheat</span>
     <strong>
      ${e.antiCheat?
       'Enabled':
       'Disabled'
      }
     </strong>
    </div>

    <div class="meta-box">
     <span>Max violations</span>
     <strong>${e.maxViolations}</strong>
    </div>

    <div class="meta-box">
     <span>Attempts</span>
     <strong>${done?'1 / 1':'0 / 1'}</strong>
    </div>
   </div>

   <div class="exam-date-range">
    <span>AVAILABILITY</span>
    <strong>
     ${e.startAt?
      formatDateTime(e.startAt):
      'No start date'
     }
     →
     ${e.endAt?
      formatDateTime(e.endAt):
      'No end date'
     }
    </strong>
   </div>

   <div class="exam-card-actions">
    ${
     done
      ?
       '<button class="secondary-btn" disabled>Exam Locked</button>'
      :
      canResume
       ?
        `<button
         class="primary-btn"
         data-action="start-exam"
         data-id="${e.id}"
        >
         Resume Exam
        </button>`
       :
       canStart
        ?
         `<button
          class="primary-btn"
          data-action="start-exam"
          data-id="${e.id}"
         >
          Start Exam
         </button>`
        :
         `<button
          class="secondary-btn"
          disabled
         >
          Not Available
         </button>`
    }
   </div>

   ${
    last&&last.status==='In Progress'
     ?
      `<div class="helper">
       A previous session is still marked in progress.
       You can resume it without creating a second attempt.
      </div>`
     :
      ''
   }
  </article>
 `;
}

/* =========================
   START EXAM
========================= */

function startExam(id){
 db=loadDB();

 const e=db.exams.find(
  x=>x.id===id
 );

 const u=currentUser();

 if(!e||!u)return;

 const assigned=
  String(e.examinerUsername||'').trim().toLowerCase()===
  String(u.username||'').trim().toLowerCase()
  ||
  String(e.examinerUserId||'')===
  String(u.id||'');

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

 const attempts=getUserAttempts(u);

 if(
  attempts.some(
   a=>
    a.examId===id&&
    ['Completed','Time Expired','Terminated'].includes(
     a.status
    )
  )
 ){
  toast(
   'This exam is locked because it has already been taken.',
   'error'
  );
  return;
 }

 const inProg=attempts.find(
  a=>
   a.examId===id&&
   a.status==='In Progress'
 );

 openStartInstructions(
  e,
  !!inProg
 );
}

function openStartInstructions(e,resume=false){
 const root=$('#modal-root');

 if(!root)return;

 root.hidden=false;

 root.innerHTML=`
  <div class="modal">
   <div class="modal-head">
    <div>
     <span class="eyebrow">EXAM INSTRUCTIONS</span>
     <h3>${esc(e.title)}</h3>
    </div>

    <button
     type="button"
     class="close-btn"
     data-action="close-modal"
     aria-label="Close"
     title="Close"
    >
     ×
    </button>
   </div>

   <div class="modal-body">
    <div class="notice">
     You can take this examination only once.
     Once submitted, expired or terminated, it cannot be retaken.
    </div>

    <div class="exam-date-range">
     <span>EXAM AVAILABILITY</span>
     <strong>
      ${e.startAt?
       formatDateTime(e.startAt):
       'No start date'
      }
      →
      ${e.endAt?
       formatDateTime(e.endAt):
       'No end date'
      }
     </strong>
    </div>

    <ul
     style="
      color:var(--muted);
      font-size:13px;
      line-height:1.8;
      padding-left:20px;
     "
    >
     <li>
      ${
       boolSetting(e.timerEnabled,false)
        ?
         `You have <strong>${e.durationMinutes} minutes</strong> to complete the examination.`
        :
         'No countdown timer is configured for this exam.'
      }
     </li>

     <li>
      ${
       e.antiCheat
        ?
         `Anti-cheat is enabled. Up to <strong>${e.maxViolations}</strong> violation(s) are allowed before automatic termination.`
        :
         'Anti-cheat monitoring is disabled for this examination.'
      }
     </li>

     <li>
      Submit the Google Form first, then use the portal's
      <strong>Submit Exam</strong> button.
     </li>

     <li>
      Do not refresh or close the page while the exam is active.
     </li>

     <li>
      ${
       resume
        ?
         '<strong>Your previous examination session will be resumed.</strong>'
        :
         'Once you click Start Examination, your one allowed attempt begins.'
      }
     </li>
    </ul>

    ${
     e.antiCheat
      ?
       `
       <div class="notice danger-notice">
        Fullscreen, tab/window focus and visibility events may be monitored.
        Browser limitations mean this is a detection/deterrence layer,
        not a guarantee against cheating.
       </div>
       `
      :
       ''
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
  * IMPORTANT:
  * The modal is dynamically generated, so its newly-created
  * buttons must be bound again.
  */
 bindActions();
}

function confirmStart(id){
 db=loadDB();

 const e=db.exams.find(
  x=>x.id===id
 );

 const u=currentUser();

 if(!e||!u)return;

 const assigned=
  String(e.examinerUsername||'').trim().toLowerCase()===
  String(u.username||'').trim().toLowerCase()
  ||
  String(e.examinerUserId||'')===
  String(u.id||'');

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

 const attempts=getUserAttempts(u);

 if(
  attempts.some(
   a=>
    a.examId===id&&
    ['Completed','Time Expired','Terminated'].includes(
     a.status
    )
  )
 ){
  toast(
   'This exam is locked because it has already been taken.',
   'error'
  );
  return;
 }

 closeModal();

 currentExam=clone(e);

 const now=Date.now();

 /*
  * Reuse an existing In Progress attempt rather than
  * creating a duplicate attempt.
  */
 let attempt=attempts.find(
  a=>
   a.examId===e.id&&
   a.status==='In Progress'
 );

 const existing=!!attempt;

 if(!attempt){
  attempt={
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

 const elapsed=existing
  ?
   Math.max(
    0,
    Math.floor(
     (now-(attempt.startedAt||now))/1000
    )
   )
  :
   0;

 const timerEnabled=
  boolSetting(
   e.timerEnabled,
   true
  );

 const durationMinutes=Math.max(
  1,
  Number(e.durationMinutes)||60
 );

 const antiCheat=
  boolSetting(
   e.antiCheat,
   true
  );

 const maxViolations=Math.max(
  1,
  Number(e.maxViolations)||3
 );

 const remaining=timerEnabled
  ?
   Math.max(
    0,
    durationMinutes*60-elapsed
   )
  :
   0;

 examState={
  attemptId:attempt.id,
  seconds:remaining,
  timerEnabled,
  antiCheat,
  maxViolations,
  startedAt:attempt.startedAt||now,
  active:true
 };

 $('#live-exam-title').textContent=e.title;

 $('#live-exam-examiner').textContent=
  'Assigned to '+u.username;

 $('#exam-violations').textContent=
  `${attempt.violations} / ${maxViolations}`;

 const iframe=$('#exam-iframe');

 if(iframe){
  iframe.src=e.formUrl;
 }

 const instructions=$('#exam-instructions');

 if(instructions){
  instructions.textContent=
   timerEnabled
    ?
     `Timer: ${durationMinutes} minutes • Anti-cheat: ${antiCheat?'Enabled':'Disabled'} • Submit the Google Form, then click Submit Exam.`
    :
     `No timer • Anti-cheat: ${antiCheat?'Enabled':'Disabled'} • Submit the Google Form, then click Submit Exam.`;
 }

 showView('exam');

 document.body.classList.add(
  'lockdown-active'
 );

 const examView=$('#exam-view');

 if(examView){
  examView.classList.add(
   'lockdown-active'
  );
 }

 graceUntil=Date.now()+GRACE;

 if(antiCheat){
  requestFullscreen().finally(()=>{
   graceUntil=Date.now()+GRACE;
  });
 }

 renderTimer();

 if(timerEnabled){
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

/* =========================
   TIMER
========================= */

function startTimer(){
 clearInterval(timer);

 renderTimer();

 timer=setInterval(()=>{
  if(!examState?.active){
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
 const t=Math.max(
  0,
  Number(examState?.seconds)||0
 );

 const m=Math.floor(
  t/60
 ).toString().padStart(2,'0');

 const sec=(t%60)
  .toString()
  .padStart(2,'0');

 const timerEl=$('#exam-timer');

 if(timerEl){
  timerEl.textContent=
   examState?.timerEnabled
    ?
     `${m}:${sec}`
    :
     'No Timer';

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
  ?
   Math.max(
    0,
    Math.min(
     100,
     (t/(duration*60))*100
    )
   )
  :
   0;

 const progress=$('#exam-progress');

 if(progress){
  progress.style.width=
   `${100-pct}%`;
 }
}

/* =========================
   PROCTORING
========================= */

async function requestFullscreen(){
 try{
  const element=document.documentElement;

  if(!document.fullscreenElement&&element.requestFullscreen){
   await element.requestFullscreen();
  }
 }catch{
  /*
   * Fullscreen may be blocked by browser policy.
   * The exam can still continue.
   */
 }
}

function exitFullscreen(){
 try{
  if(document.fullscreenElement&&document.exitFullscreen){
   document.exitFullscreen();
  }
 }catch{}
}

function registerViolation(reason){
 if(
  !examState?.active||
  !examState.antiCheat||
  Date.now()<graceUntil
 ){
  return;
 }

 const attempt=db.attempts.find(
  a=>a.id===examState.attemptId
 );

 if(!attempt)return;

 attempt.violations=
  (Number(attempt.violations)||0)+1;

 const violation={
  id:uid('violation'),
  attemptId:attempt.id,
  examId:attempt.examId,
  username:attempt.username,
  reason,
  timestamp:Date.now(),
  count:attempt.violations
 };

 db.violations.push(violation);

 saveDB();

 $('#exam-violations').textContent=
  `${attempt.violations} / ${examState.maxViolations}`;

 violationOverlayOpen=true;

 syncViolationOverlay(
  reason,
  attempt.violations,
  examState.maxViolations
 );

 if(
  attempt.violations>=
  examState.maxViolations
 ){
  finishExam(
   'Exam Terminated',
   'Exam Terminated',
   'The maximum number of allowed violations has been reached.',
   '!'
  );
 }
}

function syncViolationOverlay(
 reason='The examination window lost focus.',
 count=null,
 max=null
){
 const overlay=$('#violation-overlay');

 if(!overlay)return;

 overlay.hidden=!violationOverlayOpen;

 if(!violationOverlayOpen)return;

 const attempt=db.attempts.find(
  a=>a.id===examState?.attemptId
 );

 const actualCount=
  count??Number(attempt?.violations)||0;

 const actualMax=
  max??Number(examState?.maxViolations)||3;

 const reasonEl=$('#violation-reason');
 const countEl=$('#overlay-count');
 const maxEl=$('#overlay-max');

 if(reasonEl){
  reasonEl.textContent=reason;
 }

 if(countEl){
  countEl.textContent=actualCount;
 }

 if(maxEl){
  maxEl.textContent=actualMax;
 }
}

function resumeExam(){
 if(!examState?.active){
  violationOverlayOpen=false;
  syncViolationOverlay();
  return;
 }

 violationOverlayOpen=false;
 syncViolationOverlay();

 graceUntil=Date.now()+GRACE;

 requestFullscreen().finally(()=>{
  graceUntil=Date.now()+GRACE;
 });
}

/* =========================
   FINISH EXAM
========================= */

function finishExam(
 eyebrow='EXAM COMPLETE',
 title='Thank you for taking the exam!',
 message='Your examination session has ended.',
 icon='✓'
){
 if(!examState?.attemptId){
  return;
 }

 const attempt=db.attempts.find(
  a=>a.id===examState.attemptId
 );

 if(!attempt){
  return;
 }

 if(
  attempt.status!=='In Progress'&&
  examState.active===false
 ){
  return;
 }

 clearInterval(timer);
 timer=null;

 const endedAt=Date.now();

 attempt.endedAt=endedAt;

 if(attempt.startedAt){
  attempt.durationSeconds=Math.max(
   0,
   Math.floor(
    (endedAt-attempt.startedAt)/1000
   )
  );
 }

 if(
  eyebrow==='Time Expired'||
  title==='Time Expired'
 ){
  attempt.status='Time Expired';
 }else if(
  eyebrow==='Exam Terminated'||
  title==='Exam Terminated'
 ){
  attempt.status='Terminated';
 }else{
  attempt.status='Completed';
 }

 saveDB();

 examState.active=false;

 violationOverlayOpen=false;
 syncViolationOverlay();

 exitFullscreen();

 document.body.classList.remove(
  'lockdown-active'
 );

 const examView=$('#exam-view');

 if(examView){
  examView.classList.remove(
   'lockdown-active'
  );
 }

 const iconEl=$('#result-icon');
 const eyebrowEl=$('#result-eyebrow');
 const titleEl=$('#result-title');
 const messageEl=$('#result-message');
 const examEl=$('#result-exam');
 const userEl=$('#result-user');
 const violationsEl=$('#result-violations');
 const endedEl=$('#result-ended');
 const timeEl=$('#result-time');

 if(iconEl){
  iconEl.textContent=icon;
 }

 if(eyebrowEl){
  eyebrowEl.textContent=eyebrow;
 }

 if(titleEl){
  titleEl.textContent=title;
 }

 if(messageEl){
  messageEl.textContent=message;
 }

 if(examEl){
  examEl.textContent=
   attempt.examTitle||'—';
 }

 if(userEl){
  userEl.textContent=
   attempt.username||'—';
 }

 if(violationsEl){
  violationsEl.textContent=
   Number(attempt.violations)||0;
 }

 if(endedEl){
  endedEl.textContent=
   formatDateTime(attempt.endedAt);
 }

 if(timeEl){
  timeEl.textContent=
   formatDuration(
    Number(attempt.durationSeconds)||0
   );
 }

 showView('result');

 examState=null;
 currentExam=null;
}

/* =========================
   THEME
========================= */

function applyTheme(){
 document.body.dataset.theme=
  db.theme==='light'?
   'light':
   'dark';
}

function toggleTheme(){
 db.theme=
  db.theme==='dark'?
   'light':
   'dark';

 saveDB();
 applyTheme();
}

function initTheme(){
 applyTheme();

 const loginToggle=$('#theme-toggle-login');

 if(loginToggle&&loginToggle.dataset.bound!=='1'){
  loginToggle.addEventListener(
   'click',
   toggleTheme
  );

  loginToggle.dataset.bound='1';
 }
}

/* =========================
   ACTION BINDING
========================= */

function bindActions(){
 $$('[data-action]').forEach(el=>{
  if(el.dataset.bound==='1'){
   return;
  }

  el.addEventListener(
   'click',
   ()=>{
    const action=el.dataset.action;
    const id=el.dataset.id;

    if(action==='close-modal'){
     closeModal();
    }

    if(action==='add-exam'){
     openExamForm();
    }

    if(action==='edit-exam'){
     openExamForm(id);
    }

    if(action==='delete-exam'){
     deleteExam(id);
    }

    if(action==='start-exam'){
     startExam(id);
    }

    if(action==='confirm-start'){
     confirmStart(id);
    }

    if(action==='logout'){
     logout();
    }

    if(action==='resume-exam'){
     resumeExam();
    }

    if(action==='submit-exam'){
     finishExam(
      'EXAM COMPLETE',
      'Thank you for taking the exam!',
      'Your examination session has ended.',
      '✓'
     );
    }
   }
  );

  el.dataset.bound='1';
 });
}

/* =========================
   BADGES
========================= */

function badge(status){
 const normalized=String(
  status||''
 ).toLowerCase();

 let cls='';

 if(
  normalized==='available'||
  normalized==='completed'||
  normalized==='yes'
 ){
  cls='green';
 }else if(
  normalized==='in progress'||
  normalized==='pending'||
  normalized==='upcoming'
 ){
  cls='yellow';
 }else if(
  normalized==='expired'||
  normalized==='terminated'||
  normalized==='unavailable'||
  normalized==='no'
 ){
  cls='red';
 }else{
  cls='';
 }

 return`
  <span class="badge ${cls}">
   ${esc(status)}
  </span>
 `;
}

/* =========================
   EVENT LISTENERS
========================= */

function initProctoring(){
 document.addEventListener(
  'fullscreenchange',
  ()=>{
   if(
    examState?.active&&
    examState.antiCheat&&
    !document.fullscreenElement&&
    Date.now()>=graceUntil
   ){
    registerViolation(
     'Fullscreen mode was exited.'
    );
   }
  }
 );

 document.addEventListener(
  'visibilitychange',
  ()=>{
   if(
    document.hidden&&
    examState?.active&&
    examState.antiCheat
   ){
    registerViolation(
     'The examination tab became hidden or another tab/window was opened.'
    );
   }
  }
 );

 window.addEventListener(
  'blur',
  ()=>{
   if(
    examState?.active&&
    examState.antiCheat&&
    Date.now()>=graceUntil
   ){
    registerViolation(
     'The examination window lost focus.'
    );
   }
  }
 );

 document.addEventListener(
  'contextmenu',
  event=>{
   if(
    examState?.active&&
    examState.antiCheat
   ){
    event.preventDefault();

    registerViolation(
     'Right-click/context menu was used during the examination.'
    );
   }
  }
 );

 document.addEventListener(
  'copy',
  event=>{
   if(
    examState?.active&&
    examState.antiCheat
   ){
    event.preventDefault();

    registerViolation(
     'Copy action was detected during the examination.'
    );
   }
  }
 );

 document.addEventListener(
  'cut',
  event=>{
   if(
    examState?.active&&
    examState.antiCheat
   ){
    event.preventDefault();

    registerViolation(
     'Cut action was detected during the examination.'
    );
   }
  }
 );

 document.addEventListener(
  'paste',
  event=>{
   if(
    examState?.active&&
    examState.antiCheat
   ){
    event.preventDefault();

    registerViolation(
     'Paste action was detected during the examination.'
    );
   }
  }
 );

 document.addEventListener(
  'keydown',
  event=>{
   if(
    !examState?.active||
    !examState.antiCheat
   ){
    return;
   }

   const key=String(
    event.key||''
   ).toLowerCase();

   const ctrl=event.ctrlKey||
    event.metaKey;

   const shift=event.shiftKey;

   const restricted=
    key==='f12'||
    (
     ctrl&&
     shift&&
     ['i','j','c'].includes(key)
    )||
    (
     ctrl&&
     ['t','n','w','u'].includes(key)
    );

   if(restricted){
    event.preventDefault();

    registerViolation(
     `Restricted keyboard shortcut detected: ${event.key}`
    );
   }
  }
 );

 window.addEventListener(
  'beforeunload',
  event=>{
   if(examState?.active){
    event.preventDefault();
    event.returnValue='';
   }
  }
 );

 const resumeBtn=$('#resume-exam-btn');

 if(resumeBtn&&resumeBtn.dataset.bound!=='1'){
  resumeBtn.addEventListener(
   'click',
   resumeExam
  );

  resumeBtn.dataset.bound='1';
 }

 const submitBtn=$('#exam-submit-btn');

 if(submitBtn&&submitBtn.dataset.bound!=='1'){
  submitBtn.addEventListener(
   'click',
   ()=>{
    if(
     !examState?.active
    ){
     return;
    }

    const confirmed=window.confirm(
     'Are you sure you want to submit this examination?\n\nMake sure you have submitted the Google Form first.'
    );

    if(!confirmed){
     return;
    }

    finishExam(
     'EXAM COMPLETE',
     'Thank you for taking the exam!',
     'Your examination session has ended.',
     '✓'
    );
   }
  );

  submitBtn.dataset.bound='1';
 }

 const resultBtn=$('#result-dashboard-btn');

 if(resultBtn&&resultBtn.dataset.bound!=='1'){
  resultBtn.addEventListener(
   'click',
   ()=>{
    openPortal();
   }
  );

  resultBtn.dataset.bound='1';
 }
}

/* =========================
   INITIALIZATION
========================= */

function init(){
 db=loadDB();
 loadSession();

 initTheme();
 initAuthentication();
 initProctoring();

 bindActions();
 bindAdminNavigation();

 syncViolationOverlay();

 if(session){
  openPortal();
 }else{
  showView('login');
 }

 hideLoading();
}

document.addEventListener(
 'DOMContentLoaded',
 init
);
```
