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
  const existing=users.find(u=>
   String(u?.username||'').trim().toLowerCase()===su.username.toLowerCase()
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

 /*
  Normalize every exam and repair its examiner account.
  This is important for exams created before examiner accounts
  were synchronized with the exam settings.
 */
 repaired.exams.forEach(exam=>{

  exam.timerEnabled=
   exam.timerEnabled===true||
   exam.timerEnabled==='true'||
   exam.timerEnabled===1||
   exam.timerEnabled==='1'||
   exam.timerEnabled==='on';

  exam.durationMinutes=
   Math.max(1,Math.round(Number(exam.durationMinutes)||60));

  exam.antiCheat=
   exam.antiCheat===true||
   exam.antiCheat==='true'||
   exam.antiCheat===1||
   exam.antiCheat==='1'||
   exam.antiCheat==='on';

  exam.maxViolations=
   Math.max(1,Math.round(Number(exam.maxViolations)||3));

  exam.active=
   !(exam.active===false||
     exam.active==='false'||
     exam.active===0||
     exam.active==='0');

  const username=String(exam.examinerUsername||'').trim();

  if(!username)return;

  const normalized=username.toLowerCase();

  let account=repaired.users.find(u=>
   String(u?.username||'').trim().toLowerCase()===normalized
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
    light?'☾':'☼';

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
  Built-in accounts.
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

 /*
  Normal examiner account login.
 */
 let user=db.users.find(u=>
  String(u?.username||'')
   .trim()
   .toLowerCase()===key &&
  String(u?.password??'')===password &&
  u?.role==='examiner'
 );

 /*
  Recovery:
  If an examiner account is missing from localStorage,
  the exam configuration itself is used to rebuild it.
 */
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

   user.username=
    String(
     assignedExam.examinerUsername
    ).trim();

   user.password=
    String(
     assignedExam.examinerPassword
    );

   user.role='examiner';

   user.name=
    user.name||
    user.username;

   if(!existing){
    db.users.push(user);
   }

   saveDB();
  }
 }

 /*
  Final fallback for built-in credentials.
 */
 if(
  !user&&
  fallback[key]&&
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
 )||
 db.users.find(
  u=>
   String(u.username||'').toLowerCase()===
   String(session.username||'').toLowerCase()
 )||
 null;
}

function clearBrokenSession(){

 if(!session)return;

 const user=currentUser();

 if(!user){

  session=null;
  saveSession();
 }
}

function logout(){

 clearInterval(timer);

 currentExam=null;
 examState=null;

 violationOverlayOpen=false;

 syncViolationOverlay();

 session=null;

 saveSession();

 showView('login');

 clearLoginError();

 const usernameEl=$('#login-username');
 const passwordEl=$('#login-password');

 if(usernameEl)usernameEl.value='';
 if(passwordEl)passwordEl.value='';
}

function openPortal(){

 const user=currentUser();

 if(!user){

  session=null;
  saveSession();

  showView('login');

  return;
 }

 if(user.role==='admin'){
  openAdmin();
 }else{
  openExaminer();
 }
}

/* =========================================================
   ADMIN
========================================================= */

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

 const valid=[
  'dashboard',
  'exams',
  'submissions',
  'violations',
  'users',
  'settings'
 ];

 if(!valid.includes(page)){
  page='dashboard';
 }

 $$('.admin-page').forEach(p=>{
  p.classList.remove('active');
 });

 const target=$('#admin-'+page+'-page');

 if(target){
  target.classList.add('active');
 }

 $$('.nav-item[data-admin-page]').forEach(n=>{
  n.classList.toggle(
   'active',
   n.dataset.adminPage===page
  );
 });

 const title=$('#admin-page-title');

 if(title){

  const labels={
   dashboard:'Dashboard',
   exams:'Exam Management',
   submissions:'Submissions',
   violations:'Violation Logs',
   users:'Users',
   settings:'Settings'
  };

  title.textContent=labels[page]||'Dashboard';
 }

 if(page==='dashboard')renderAdminDashboard();
 if(page==='exams')renderExams();
 if(page==='submissions')renderSubmissions();
 if(page==='violations')renderViolations();
 if(page==='users')renderUsers();
 if(page==='settings')renderSettings();
}

/* =========================================================
   EXAMINER
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

 renderExaminerDashboard();
}

function renderExaminerDashboard(){

 const container=$('#examiner-dashboard-page');

 if(!container)return;

 const u=currentUser();

 if(!u)return;

 const assigned=db.exams.filter(e=>
  String(e.examinerUsername||'')
   .trim()
   .toLowerCase()===
  String(u.username||'')
   .trim()
   .toLowerCase()
 );

 const cards=assigned.map(e=>{

  const availability=getAvailability(e);

  const taken=db.attempts.some(a=>
   a.examId===e.id&&
   a.userId===u.id&&
   ['Completed','Terminated','Time Expired'].includes(a.status)
  );

  const inProgress=db.attempts.find(a=>
   a.examId===e.id&&
   a.userId===u.id&&
   a.status==='In Progress'
  );

  let button='';

  if(taken){

   button=
    '<button class="secondary-btn" disabled>Completed</button>';

  }else if(inProgress){

   button=
    `<button class="primary-btn" data-action="start-exam" data-id="${esc(e.id)}">Resume Exam</button>`;

  }else if(availability.status==='Available'){

   button=
    `<button class="primary-btn" data-action="start-exam" data-id="${esc(e.id)}">Start Exam</button>`;

  }else{

   button=
    '<button class="secondary-btn" disabled>Unavailable</button>';
  }

  return `
   <div class="exam-card">
    <div class="exam-card-top">
     <span class="status-pill ${availability.status==='Available'?'success':''}">
      ${esc(availability.status)}
     </span>
    </div>

    <h3>${esc(e.title)}</h3>

    <p>${esc(e.description||'No description provided.')}</p>

    <div class="exam-card-meta">
     <span>
      ${e.timerEnabled
       ?`${e.durationMinutes} min`
       :'No Timer'}
     </span>

     <span>
      Anti-cheat:
      ${e.antiCheat?'On':'Off'}
     </span>
    </div>

    <div class="exam-card-actions">
     ${button}
    </div>
   </div>
  `;
 }).join('');

 container.innerHTML=`
  <div class="page-heading">
   <div>
    <span class="eyebrow">EXAMINER PORTAL</span>
    <h2>Assigned Examinations</h2>
    <p>Select an available examination to begin.</p>
   </div>
  </div>

  <div class="exam-grid">
   ${
    cards||
    `<div class="empty-state">
      <strong>No exams assigned</strong>
      <span>There are currently no examinations assigned to your account.</span>
     </div>`
   }
  </div>
 `;

 bindActions();
}

/* =========================================================
   AVAILABILITY
========================================================= */

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

/* =========================================================
   EXAM MODAL / MANAGEMENT
========================================================= */

function openExamModal(id){

 const modal=$('#modal-root');

 if(!modal)return;

 const exam=id
  ?db.exams.find(e=>e.id===id)
  :null;

 const maxReached=
  !exam&&db.exams.length>=6;

 if(maxReached){

  toast(
   'Maximum of 6 exams reached. Delete an exam to create another.',
   'error'
  );

  return;
 }

 modal.hidden=false;

 const form=$('#exam-form');

 if(!form)return;

 form.reset();

 $('#exam-modal-title').textContent=
  exam?'Edit Examination':'Create Examination';

 $('#exam-id').value=
  exam?.id||'';

 $('#exam-title').value=
  exam?.title||'';

 $('#exam-description').value=
  exam?.description||'';

 $('#exam-form-url').value=
  exam?.formUrl||'';

 $('#examiner-username').value=
  exam?.examinerUsername||'';

 $('#examiner-password').value=
  exam?.examinerPassword||'';

 $('#exam-anti-cheat').checked=
  exam?.antiCheat===true;

 $('#exam-max-violations').value=
  exam?.maxViolations||3;

 $('#exam-timer-enabled').checked=
  exam?.timerEnabled===true;

 $('#exam-duration').value=
  exam?.durationMinutes||60;

 $('#exam-start').value=
  exam?.startAt
   ?isoLocal(exam.startAt)
   :'';

 $('#exam-end').value=
  exam?.endAt
   ?isoLocal(exam.endAt)
   :'';

 $('#exam-active').checked=
  exam
   ?exam.active!==false
   :true;

 updateTimerFields();

 const timerCheckbox=
  $('#exam-timer-enabled');

 if(timerCheckbox&&timerCheckbox.dataset.bound!=='1'){

  timerCheckbox.addEventListener(
   'change',
   updateTimerFields
  );

  timerCheckbox.dataset.bound='1';
 }
}

function isoLocal(v){

 if(!v)return '';

 const d=new Date(v);

 if(Number.isNaN(d.getTime()))return '';

 const pad=n=>String(n).padStart(2,'0');

 return d.getFullYear()+
  '-'+pad(d.getMonth()+1)+
  '-'+pad(d.getDate())+
  'T'+pad(d.getHours())+
  ':'+pad(d.getMinutes());
}

function updateTimerFields(){

 const checkbox=$('#exam-timer-enabled');
 const duration=$('#exam-duration');

 if(!checkbox||!duration)return;

 duration.disabled=!checkbox.checked;
 duration.style.opacity=
  checkbox.checked?'1':'.55';
}

function closeModal(){

 const modal=$('#modal-root');

 if(modal)modal.hidden=true;
}

function saveExamFromForm(e){

 if(e)e.preventDefault();

 const id=
  String($('#exam-id')?.value||'').trim();

 const title=
  String($('#exam-title')?.value||'').trim();

 const description=
  String($('#exam-description')?.value||'').trim();

 const formUrl=
  String($('#exam-form-url')?.value||'').trim();

 const examinerUsername=
  String($('#examiner-username')?.value||'').trim();

 const examinerPassword=
  String($('#examiner-password')?.value||'');

 const timerEnabled=
  $('#exam-timer-enabled')?.checked===true;

 const durationMinutes=
  Math.max(
   1,
   Math.round(
    Number($('#exam-duration')?.value)||60
   )
  );

 const antiCheat=
  $('#exam-anti-cheat')?.checked===true;

 const maxViolations=
  Math.max(
   1,
   Math.round(
    Number($('#exam-max-violations')?.value)||3
   )
  );

 const startAt=
  String($('#exam-start')?.value||'');

 const endAt=
  String($('#exam-end')?.value||'');

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
   'Please enter the examiner username and password.',
   'error'
  );

  return;
 }

 const normalizedUsername=
  examinerUsername.toLowerCase();

 const adminAccount=db.users.find(u=>
  String(u.username||'')
   .trim()
   .toLowerCase()===
  normalizedUsername&&
  u.role==='admin'
 );

 if(adminAccount){

  toast(
   'That username belongs to an administrator. Please use another examiner username.',
   'error'
  );

  return;
 }

 const obj={
  id:id||uid('exam'),
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
  createdAt:id
   ?(db.exams.find(x=>x.id===id)?.createdAt||Date.now())
   :Date.now(),
  createdBy:currentUser()?.id||'u-admin'
 };

 /*
  Create or update the actual portal examiner account.
 */
 let account=db.users.find(u=>
  String(u.username||'')
   .trim()
   .toLowerCase()===
  normalizedUsername
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
  account.name=
   account.name||examinerUsername;
 }

 if(id){

  const index=
   db.exams.findIndex(x=>x.id===id);

  if(index>=0){
   db.exams[index]=obj;
  }

 }else{

  db.exams.push(obj);
 }

 saveDB();

 closeModal();

 renderExams();

 toast(
  id
   ?'Exam updated successfully.'
   :'Exam created successfully.',
  'success'
 );
}

function deleteExam(id){

 const exam=
  db.exams.find(e=>e.id===id);

 if(!exam)return;

 if(
  !confirm(
   `Delete "${exam.title}"?`
  )
 ){
  return;
 }

 db.exams=
  db.exams.filter(e=>e.id!==id);

 saveDB();

 renderExams();

 toast(
  'Exam deleted successfully.',
  'success'
 );
}

/* =========================================================
   START EXAM
========================================================= */

function startExam(id){

 const u=currentUser();

 if(!u)return;

 const e=db.exams.find(
  x=>x.id===id
 );

 if(!e){

  toast(
   'Exam not found.',
   'error'
  );

  return;
 }

 if(
  String(e.examinerUsername||'')
   .trim()
   .toLowerCase()!==
  String(u.username||'')
   .trim()
   .toLowerCase()
 ){

  toast(
   'This exam is not assigned to your account.',
   'error'
  );

  return;
 }

 const availability=
  getAvailability(e);

 if(availability.status!=='Available'){

  toast(
   'This examination is currently unavailable.',
   'error'
  );

  return;
 }

 const completed=db.attempts.some(a=>
  a.examId===e.id&&
  a.userId===u.id&&
  ['Completed','Terminated','Time Expired'].includes(a.status)
 );

 if(completed){

  toast(
   'You have already taken this examination.',
   'error'
  );

  return;
 }

 const existing=db.attempts.find(a=>
  a.examId===e.id&&
  a.userId===u.id&&
  a.status==='In Progress'
 );

 if(existing){

  currentExam=clone(e);

  confirmStart(
   e.id,
   existing.id
  );

 }else{

  openStartConfirmation(e);
 }
}

function openStartConfirmation(e){

 const modal=$('#modal-root');

 if(!modal)return;

 modal.hidden=false;

 modal.innerHTML=`
  <div class="modal-backdrop">
   <div class="modal-card">
    <button
     class="modal-close"
     data-action="close-modal"
     type="button">
     ×
    </button>

    <span class="eyebrow">READY TO BEGIN?</span>

    <h2>${esc(e.title)}</h2>

    <p>
     ${esc(
      e.description||
      'Please review the exam settings before starting.'
     )}
    </p>

    <div class="start-summary">
     <div>
      <span>Timer</span>
      <strong>
       ${
        e.timerEnabled
         ?`${e.durationMinutes} minutes`
         :'Disabled'
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
      <span>Maximum Violations</span>
      <strong>${e.maxViolations}</strong>
     </div>
    </div>

    <div class="modal-actions">
     <button
      class="secondary-btn"
      data-action="close-modal"
      type="button">
      Cancel
     </button>

     <button
      class="primary-btn"
      data-action="confirm-start"
      data-id="${esc(e.id)}"
      type="button">
      Start Examination
     </button>
    </div>
   </div>
  </div>
 `;

 bindActions();
}

function confirmStart(id,existingAttemptId=null){

 const u=currentUser();

 if(!u)return;

 const e=db.exams.find(
  x=>x.id===id
 );

 if(!e)return;

 /*
  Normalize timer and security settings.
 */
 const timerEnabled=
  e.timerEnabled===true||
  e.timerEnabled==='true'||
  e.timerEnabled===1||
  e.timerEnabled==='1'||
  e.timerEnabled==='on';

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
  e.antiCheat==='1'||
  e.antiCheat==='on';

 const maxViolations=
  Math.max(
   1,
   Number(e.maxViolations)||3
  );

 /*
  Persist normalized settings.
 */
 e.timerEnabled=timerEnabled;
 e.durationMinutes=durationMinutes;
 e.antiCheat=antiCheat;
 e.maxViolations=maxViolations;

 saveDB();

 currentExam=clone(e);

 let attempt=
  existingAttemptId
   ?db.attempts.find(
     a=>a.id===existingAttemptId
    )
   :null;

 if(!attempt){

  attempt={
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
 }

 clearInterval(timer);

 examState={
  attemptId:attempt.id,
  seconds:
   timerEnabled
    ?durationMinutes*60
    :0,
  timerEnabled,
  antiCheat,
  maxViolations,
  startedAt:
   attempt.startedAt||Date.now(),
  active:true
 };

 $('#live-exam-title').textContent=
  e.title;

 $('#live-exam-examiner').textContent=
  'Assigned to '+u.username;

 $('#exam-violations').textContent=
  `${attempt.violations||0} / ${maxViolations}`;

 $('#exam-iframe').src=
  e.formUrl;

 $('#exam-instructions').textContent=
  timerEnabled
   ?`Timer: ${durationMinutes} minutes • Anti-cheat: ${antiCheat?'Enabled':'Disabled'} • Submit the Google Form, then click Submit Exam.`
   :`No timer • Anti-cheat: ${antiCheat?'Enabled':'Disabled'} • Submit the Google Form, then click Submit Exam.`;

 closeModal();

 showView('exam');

 document.body.classList.add(
  'lockdown-active'
 );

 $('#exam-view').classList.add(
  'lockdown-active'
 );

 graceUntil=
  Date.now()+GRACE;

 if(antiCheat){

  requestFullscreen().finally(()=>{
   graceUntil=
    Date.now()+GRACE;
  });
 }

 renderTimer();

 if(timerEnabled){
  startTimer();
 }
}

/* =========================================================
   TIMER
========================================================= */

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

 const t=
  Math.max(
   0,
   Number(
    examState?.seconds
   )||0
  );

 const m=
  Math.floor(t/60)
   .toString()
   .padStart(2,'0');

 const sec=
  (t%60)
   .toString()
   .padStart(2,'0');

 const timerEl=
  $('#exam-timer');

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
    Number(
     currentExam?.durationMinutes
    )||60
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

 const progress=
  $('#exam-progress');

 if(progress){
  progress.style.width=
   (100-pct)+'%';
 }
}

/* =========================================================
   PROCTORING
========================================================= */

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

 const a=
  db.attempts.find(
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
  !examState?.active||
  !examState.antiCheat
 ){
  return;
 }

 violationOverlayOpen=true;

 $('#violation-reason').textContent=
  reason;

 const a=
  db.attempts.find(
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
     ]
      .filter(Boolean)
      .join('+')
    }`
   );
  }
 }
);

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

 const a=
  db.attempts.find(
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

     const page=
      $('#admin-page-title')?.textContent||
      'Dashboard';

     const map={
      Dashboard:'dashboard',
      'Exam Management':'exams',
      Submissions:'submissions',
      'Violation Logs':'violations',
      Users:'users',
      Settings:'settings'
     };

     adminPage(
      map[page]||'dashboard'
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

 const u=
  db.users.find(
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

/* =========================================================
   STARTUP
========================================================= */

function initializePortal(){

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
 }
}

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
