/* Ube POS cloud: email-code login, business team with email invites, offline-first sync.
   Each app record is one row in public.records; the phone keeps a snapshot of what the server has,
   pushes what differs, and pulls rows changed since its last cursor. */
'use strict';
const CFG = window.UBE_CONFIG || {};
const COLLS = ['products', 'batches', 'sales', 'orders', 'customers', 'cash', 'losses', 'moves', 'closes'];
const LOCAL_ONLY = 'ube-pos-local-only', CACHE = 'ube-pos-cloud', BACKUP = 'ube-pos-backup-before-cloud';
const CL = { sb: null, user: null, team: null, member: null, members: [], invites: [], snap: {}, cursor: null, busy: false, again: false, pulling: false, pullAgain: false, err: '', last: null, pushT: 0, chan: null };
const syncKey = () => 'ube-pos-sync-' + CL.team.id;
const cloudOn = () => !!(CL.sb && CL.user && CL.team);
const isOwner = () => CL.member?.role === 'owner';

window.cloudName = () => cloudOn() ? (CL.member?.name || CL.user.email.split('@')[0]) : '';
window.syncBadge = () => {
  if (!cloudOn()) return '';
  if (!navigator.onLine) return ' · offline';
  if (CL.err) return ' · ⚠️';
  return CL.busy || CL.pulling || pendingCount() ? ' · ⏳' : ' · ☁️';
};
window.onSaved = () => { if (cloudOn()) { clearTimeout(CL.pushT); CL.pushT = setTimeout(push, 700); badge(); } };
function badge() { const c = $('#sellerChip'); if (c) c.textContent = '👤 ' + me() + syncBadge(); if (tab === 'team' && !$('#sheetBg').classList.contains('on')) renderTeamStatus(); }

/* ---------- snapshot / diff ---------- */
const metaStr = () => JSON.stringify({ settings: S.settings, openingFund: S.openingFund || 0 });
function recMap() {
  const m = { 'meta/main': metaStr() };
  for (const c of COLLS) for (const r of S[c] || []) m[c + '/' + r.id] = JSON.stringify(r);
  return m;
}
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v ?? null);
}
function pendingCount() {
  if (!cloudOn()) return 0;
  const cur = recMap(); let n = 0;
  for (const k in cur) if (cur[k] !== CL.snap[k]) n++;
  for (const k in CL.snap) if (!(k in cur)) n++;
  return n;
}
function saveSync() { localStorage.setItem(syncKey(), JSON.stringify({ snap: CL.snap, cursor: CL.cursor, last: CL.last })); }
const splitKey = k => { const i = k.indexOf('/'); return [k.slice(0, i), k.slice(i + 1)]; };

async function push() {
  if (!cloudOn()) return;
  if (CL.busy) { CL.again = true; return; }
  if (!navigator.onLine) { badge(); return; }
  const cur = recMap(), rows = [], sent = {};
  for (const k in cur) if (cur[k] !== CL.snap[k]) { const [coll, id] = splitKey(k); rows.push({ team_id: CL.team.id, coll, id, data: JSON.parse(cur[k]), deleted: false }); sent[k] = cur[k]; }
  for (const k in CL.snap) if (!(k in cur)) { const [coll, id] = splitKey(k); rows.push({ team_id: CL.team.id, coll, id, data: {}, deleted: true }); sent[k] = null; }
  if (!rows.length) { badge(); return; }
  CL.busy = true; badge();
  try {
    for (let i = 0; i < rows.length; i += 400) {
      const { error } = await CL.sb.from('records').upsert(rows.slice(i, i + 400));
      if (error) throw error;
    }
    for (const k in sent) { if (sent[k] === null) delete CL.snap[k]; else CL.snap[k] = sent[k]; }
    CL.err = ''; CL.last = new Date().toISOString(); saveSync();
  } catch (e) { CL.err = e.message || String(e); }
  CL.busy = false; badge();
  if (CL.again) { CL.again = false; push(); }
}

function applyRow(r, cur) {
  const k = r.coll + '/' + r.id;
  const dirty = k in cur ? cur[k] !== CL.snap[k] : k in CL.snap;
  if (dirty) return false; // this phone has an unsent change: it wins and will be pushed
  if (r.coll === 'meta') {
    if (r.deleted || canon(JSON.parse(cur[k])) === canon(r.data)) { CL.snap[k] = cur[k]; return false; }
    S.settings = Object.assign({}, seed().settings, r.data.settings || {}); S.openingFund = r.data.openingFund || 0;
    CL.snap[k] = cur[k] = metaStr(); return true;
  }
  const arr = S[r.coll]; if (!arr) return false;
  const i = arr.findIndex(x => x.id === r.id);
  if (r.deleted) { if (i >= 0) arr.splice(i, 1); delete CL.snap[k]; delete cur[k]; return i >= 0; }
  if (i >= 0 && canon(arr[i]) === canon(r.data)) { CL.snap[k] = cur[k]; return false; }
  if (i >= 0) arr[i] = r.data; else arr.push(r.data);
  CL.snap[k] = cur[k] = JSON.stringify(r.data); return true;
}
function sortColls() {
  for (const c of ['sales', 'cash', 'losses', 'moves', 'closes']) S[c].sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
  S.orders.sort((a, b) => (a.created || '').localeCompare(b.created || ''));
}
async function pull(full) {
  if (!cloudOn() || !navigator.onLine) return;
  if (CL.pulling) { CL.pullAgain = true; return; }
  CL.pulling = true; badge();
  try {
    // 30 s overlap covers rows whose transactions committed slightly out of order
    const since = full || !CL.cursor ? '1970-01-01T00:00:00Z' : new Date(new Date(CL.cursor).getTime() - 30000).toISOString();
    const cur = recMap(); let changed = false, maxTs = CL.cursor;
    for (let page = 0; ; page++) {
      const { data, error } = await CL.sb.from('records').select('coll,id,data,deleted,updated_at')
        .eq('team_id', CL.team.id).gte('updated_at', since).order('updated_at').order('id').range(page * 1000, page * 1000 + 999);
      if (error) throw error;
      for (const r of data) { if (applyRow(r, cur)) changed = true; if (!maxTs || new Date(r.updated_at) > new Date(maxTs)) maxTs = r.updated_at; }
      if (data.length < 1000) break;
    }
    CL.cursor = maxTs; CL.err = ''; CL.last = new Date().toISOString();
    if (changed) { sortColls(); localStorage.setItem(KEY, JSON.stringify(S)); render(); }
    saveSync();
  } catch (e) { CL.err = e.message || String(e); }
  CL.pulling = false; badge();
  if (CL.pullAgain) { CL.pullAgain = false; pull(); }
}
window.syncNow = async () => { await push(); await pull(); toast(CL.err ? 'Sync problem: ' + CL.err : 'Synced ✔'); };

/* ---------- login gate ---------- */
let gateEmail = '';
function showGate(step) {
  let g = $('#gate');
  if (!g) { g = document.createElement('div'); g.id = 'gate'; document.body.appendChild(g); }
  g.innerHTML = `<div class="gate-box"><img src="icons/icon.svg" alt="" style="width:64px;height:64px;border-radius:16px"><h2 style="margin:12px 0 4px">Ube POS</h2>
  ${step === 'code' ? `<p class="mut small">We emailed a code to <b>${esc(gateEmail)}</b>. Check Spam/Promotions if you don't see it.</p>
    <label class="f">Login code<input id="gCode" inputmode="numeric" autocomplete="one-time-code" maxlength="10" style="font-size:22px;letter-spacing:6px;text-align:center"></label>
    <button class="btn block" id="gBtn" onclick="gateVerify()">Sign in</button>
    <button class="btn ghost block" style="margin-top:8px" onclick="showGate()">Use a different email</button>`
  : `<p class="mut small">Sign in with your email — no password. Your team sees the same stock and sales on every phone.</p>
    <label class="f">Email<input id="gEmail" type="email" inputmode="email" autocomplete="email" value="${esc(gateEmail)}" placeholder="you@gmail.com"></label>
    <button class="btn block" id="gBtn" onclick="gateSend()">Email me a login code</button>`}
  <div id="gErr" class="small bad" style="margin-top:8px"></div>
  ${step === 'code' ? '' : `<button class="btn ghost block" style="margin-top:18px;border:0" onclick="useLocalOnly()">Use without an account (this phone only)</button>`}</div>`;
  g.style.display = 'flex';
  setTimeout(() => ($('#gCode') || $('#gEmail'))?.focus(), 50);
}
const hideGate = () => { const g = $('#gate'); if (g) g.style.display = 'none'; };
const gateBusy = (on, label) => { const b = $('#gBtn'); if (b) { b.disabled = on; if (label) b.textContent = label; } };
window.gateSend = async () => {
  gateEmail = $('#gEmail').value.trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(gateEmail)) { $('#gErr').textContent = 'Enter a valid email.'; return; }
  if (!navigator.onLine) { $('#gErr').textContent = 'You are offline. Connect to the internet to sign in.'; return; }
  gateBusy(true, 'Sending…');
  const { error } = await CL.sb.auth.signInWithOtp({ email: gateEmail, options: { shouldCreateUser: true } });
  if (error) { gateBusy(false, 'Email me a login code'); $('#gErr').textContent = /rate|seconds/i.test(error.message) ? 'Too many codes requested. Wait a minute, then try again.' : error.message; return; }
  showGate('code');
};
window.gateVerify = async () => {
  const token = $('#gCode').value.replace(/\D/g, '');
  if (token.length < 6) { $('#gErr').textContent = 'Enter the code from the email.'; return; }
  gateBusy(true, 'Checking…');
  const { data, error } = await CL.sb.auth.verifyOtp({ email: gateEmail, token, type: 'email' });
  if (error) { gateBusy(false, 'Sign in'); $('#gErr').textContent = /expired|invalid/i.test(error.message) ? 'Wrong or expired code. Check the latest email, or go back and send a new one.' : error.message; return; }
  localStorage.removeItem(LOCAL_ONLY);
  await afterLogin(data.user);
};
window.useLocalOnly = () => { localStorage.setItem(LOCAL_ONLY, '1'); hideGate(); render(); };

/* ---------- team setup ---------- */
async function afterLogin(user) {
  CL.user = { id: user.id, email: (user.email || '').toLowerCase() };
  const { data: teamId, error } = await CL.sb.rpc('accept_invites', { p_name: '' });
  if (error) { showGate(); $('#gErr').textContent = 'Could not load your team: ' + error.message; return; }
  if (!teamId) { showCreateTeam(); return; }
  await loadTeam(teamId);
}
const hasLocalData = () => S.sales.length || S.batches.length || S.orders.length || S.customers.length;
function showCreateTeam() {
  showGate();
  $('#gate .gate-box').innerHTML = `<img src="icons/icon.svg" alt="" style="width:64px;height:64px;border-radius:16px"><h2 style="margin:12px 0 4px">Set up your business</h2>
  <p class="mut small">Signed in as <b>${esc(CL.user.email)}</b>. If your team already uses Ube POS, ask the owner to invite this email, then sign in again.</p>
  <label class="f">Business / branch name<input id="tName" value="${esc(S.settings.branch)}"></label>
  <label class="f">Your name (shown on sales)<input id="tMe" value="${esc(localStorage.getItem(ME_KEY) || '')}" placeholder="e.g. Karen"></label>
  ${hasLocalData() ? `<label class="f"><input type="checkbox" id="tUp" checked style="display:inline;width:auto"> Upload the sales & stock already on this phone</label>` : ''}
  <button class="btn block" id="gBtn" onclick="createTeam()">Create my business</button>
  <button class="btn ghost block" style="margin-top:8px" onclick="checkInviteAgain()">I was invited — check again</button>
  <button class="btn ghost block" style="margin-top:8px;border:0" onclick="signOut(true)">Sign out</button><div id="gErr" class="small bad" style="margin-top:8px"></div>`;
}
window.checkInviteAgain = async () => { gateBusy(true); await afterLogin(CL.user); };
window.createTeam = async () => {
  const name = $('#tName').value.trim(), myName = $('#tMe').value.trim();
  if (!name || !myName) { $('#gErr').textContent = 'Enter the business name and your name.'; return; }
  gateBusy(true, 'Creating…');
  const { data: teamId, error } = await CL.sb.rpc('create_team', { p_team: name, p_name: myName });
  if (error) { gateBusy(false, 'Create my business'); $('#gErr').textContent = error.message; return; }
  if (!($('#tUp')?.checked)) { localStorage.setItem(BACKUP, JSON.stringify(S)); S = seed(); }
  S.settings.branch = name; S.settings.team = [myName];
  localStorage.setItem(KEY, JSON.stringify(S));
  localStorage.setItem('ube-pos-sync-' + teamId, JSON.stringify({ snap: {}, cursor: null })); // empty snapshot = upload everything
  await loadTeam(teamId);
};
async function refreshTeam() {
  const [t, m, i] = await Promise.all([
    CL.sb.from('teams').select('id,name,owner').eq('id', CL.team.id).maybeSingle(),
    CL.sb.from('members').select('user_id,email,name,role,joined_at').eq('team_id', CL.team.id).order('joined_at'),
    CL.sb.from('invites').select('email,created_at').eq('team_id', CL.team.id).order('created_at')]);
  if (t.error || !t.data) throw new Error(t.error?.message || 'You are no longer a member of this team.');
  CL.team = t.data; CL.members = m.data || []; CL.invites = i.data || [];
  CL.member = CL.members.find(x => x.user_id === CL.user.id) || CL.member;
  localStorage.setItem(CACHE, JSON.stringify({ user: CL.user, team: CL.team, member: CL.member }));
}
async function loadTeam(teamId) {
  CL.team = { id: teamId };
  try { await refreshTeam(); } catch (e) { CL.team = null; showGate(); $('#gErr').textContent = e.message; return; }
  const st = JSON.parse(localStorage.getItem(syncKey()) || 'null');
  if (st) { CL.snap = st.snap || {}; CL.cursor = st.cursor || null; CL.last = st.last || null; }
  else { // first time this phone opens this team: keep old local data aside, start clean, download everything
    if (hasLocalData()) localStorage.setItem(BACKUP, JSON.stringify(S));
    S = Object.assign(seed(), { products: [] }); localStorage.setItem(KEY, JSON.stringify(S));
    CL.snap = recMap(); CL.cursor = null; saveSync();
  }
  hideGate(); listen(); render();
  await push(); await pull(!st); render();
}
function listen() {
  if (CL.chan) CL.sb.removeChannel(CL.chan);
  let t = 0;
  CL.chan = CL.sb.channel('records-' + CL.team.id)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'records', filter: 'team_id=eq.' + CL.team.id }, () => { clearTimeout(t); t = setTimeout(() => pull(), 400); })
    .subscribe();
}
window.signOut = async quiet => {
  if (!quiet) {
    const n = pendingCount();
    if (n && !confirm(`${n} change(s) have not reached the cloud yet (you may be offline). Sign out anyway and lose them?`)) return;
    if (!n && !confirm('Sign out? This phone\'s copy is cleared — everything stays safe in the cloud.')) return;
  }
  if (CL.team) localStorage.removeItem(syncKey());
  if (CL.chan) CL.sb.removeChannel(CL.chan);
  await CL.sb.auth.signOut().catch(() => {});
  localStorage.removeItem(CACHE);
  Object.assign(CL, { user: null, team: null, member: null, members: [], invites: [], snap: {}, cursor: null, err: '' });
  S = seed(); localStorage.setItem(KEY, JSON.stringify(S)); gateEmail = '';
  render(); showGate();
};

/* ---------- Team & account screen ---------- */
function vTeam(v) {
  if (!CL.sb) { v.innerHTML = `<h2>Team & account</h2><div class="card">Cloud sync is not set up in this version (missing config.js). The app works on this phone only.</div>`; return; }
  if (!CL.user) { v.innerHTML = `<h2>Team & account</h2><div class="card"><p>You are using Ube POS on <b>this phone only</b>. Sign in to share stock and sales with your team and keep a safe copy in the cloud.</p>
    <button class="btn block" onclick="showGate()">Sign in with email</button></div>`; return; }
  if (!CL.team) { showCreateTeam(); return; }
  const own = isOwner();
  v.innerHTML = `<h2>Team & account</h2>
  <div class="card"><div class="row sb"><div><b>${esc(CL.team.name)}</b><div class="small mut">${esc(CL.user.email)} · ${own ? 'Owner' : 'Member'}</div></div><button class="btn ghost sm" onclick="signOut()">Sign out</button></div>
    <label class="f" style="margin-top:10px">Your name on sales<div class="row"><input id="myName" class="grow" value="${esc(CL.member?.name || '')}" style="margin:0"><button class="btn sm" onclick="saveMyName()">Save</button></div></label></div>
  <div class="card" id="syncCard"></div>
  <div class="card"><b>Team (${CL.members.length})</b><div class="list">${CL.members.map(m => `<div class="it"><div class="grow"><b>${esc(m.name || m.email.split('@')[0])}</b> ${m.role === 'owner' ? '<span class="pill">owner</span>' : ''}${m.user_id === CL.user.id ? ' <span class="pill ok">you</span>' : ''}
      <div class="small mut">${esc(m.email)}</div></div>${own && m.role !== 'owner' ? `<button class="btn danger sm" onclick="removeMember('${m.user_id}')">Remove</button>` : ''}</div>`).join('')}</div>
    ${CL.invites.length ? `<h3>Waiting to join</h3><div class="list">${CL.invites.map(i => `<div class="it"><span class="grow">${esc(i.email)}<div class="small mut">invited ${fmtDate(i.created_at)}</div></span>
      <button class="btn ghost sm" onclick="shareInvite('${esc(i.email)}')">Send</button>${own ? `<button class="btn ghost sm" onclick="cancelInvite('${esc(i.email)}')">✕</button>` : ''}</div>`).join('')}</div>` : ''}
    ${own ? `<h3>Invite someone</h3><div class="row"><input id="invEmail" class="grow" type="email" inputmode="email" placeholder="their email (Gmail)" style="padding:10px;border:1px solid var(--line);border-radius:10px"><button class="btn" onclick="invite()">Invite</button></div>
      <div class="small mut" style="margin-top:6px">They sign in with that email and join automatically. Everyone sees the same stock, sales and orders.</div>`
      : '<div class="small mut" style="margin-top:8px">Only the owner can invite or remove people.</div>'}</div>`;
  renderTeamStatus();
}
function renderTeamStatus() {
  const c = $('#syncCard'); if (!c || !cloudOn()) return;
  const n = pendingCount();
  c.innerHTML = `<div class="row sb"><div><b>Sync</b><div class="small ${CL.err ? 'bad' : 'mut'}">${!navigator.onLine ? 'Offline — sales are saved on this phone and will upload when you reconnect.'
    : CL.err ? 'Problem: ' + esc(CL.err) : CL.busy || CL.pulling ? 'Syncing…' : n ? n + ' change(s) waiting to upload' : 'All changes saved to the cloud ☁️'}</div>
    ${CL.last ? `<div class="small mut">Last sync ${fmtDate(CL.last)} ${fmtTime(CL.last)}</div>` : ''}</div><button class="btn sec sm" onclick="syncNow()">Sync now</button></div>`;
}
window.saveMyName = async () => {
  const n = $('#myName').value.trim(); if (!n) return;
  const { error } = await CL.sb.rpc('set_my_name', { p_team: CL.team.id, p_name: n });
  if (error) { toast(error.message); return; }
  CL.member.name = n; await refreshTeam().catch(() => {}); render(); toast('Name saved');
};
window.invite = async () => {
  const email = $('#invEmail').value.trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) { toast('Enter a valid email'); return; }
  if (CL.members.some(m => m.email === email)) { toast('Already on the team'); return; }
  const { error } = await CL.sb.from('invites').upsert({ team_id: CL.team.id, email, invited_by: CL.user.id });
  if (error) { toast(error.message); return; }
  await refreshTeam().catch(() => {}); render(); shareInvite(email);
};
window.shareInvite = email => shareText(`Hi! 💜 You're invited to "${CL.team.name}" on Ube POS.\n\n1. Open ${CFG.appUrl || location.href.split('#')[0]}${CFG.apkUrl ? `\n   (Android app: ${CFG.apkUrl})` : ''}\n2. Sign in with this email: ${email}\n3. Type the code we send to your email.\n\nYou'll see our stock, sales and orders right away.`, 'Ube POS invite');
window.cancelInvite = async email => {
  if (!confirm(`Cancel the invite for ${email}?`)) return;
  const { error } = await CL.sb.from('invites').delete().eq('team_id', CL.team.id).eq('email', email);
  if (error) { toast(error.message); return; }
  await refreshTeam().catch(() => {}); render();
};
window.removeMember = async uid => {
  const m = CL.members.find(x => x.user_id === uid);
  if (!confirm(`Remove ${m.name || m.email} from the team? They will no longer see the business data.`)) return;
  const { error } = await CL.sb.from('members').delete().eq('team_id', CL.team.id).eq('user_id', uid);
  if (error) { toast(error.message); return; }
  await refreshTeam().catch(() => {}); render();
};

/* ---------- boot ---------- */
async function cloudBoot() {
  if (!CFG.url || !CFG.key || !window.supabase) return;
  CL.sb = supabase.createClient(CFG.url, CFG.key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
  window.addEventListener('online', async () => {
    if (CL.offlineStart) { // started offline: confirm the login is still valid now that we have signal
      CL.offlineStart = false;
      const s = (await CL.sb.auth.getSession().catch(() => ({ data: {} }))).data?.session;
      if (!s) { toast('Please sign in again to sync'); showGate(); return; }
    }
    push(); pull(); badge();
  });
  window.addEventListener('offline', badge);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pull(); });
  setInterval(() => { push(); pull(); }, 60000);
  const cached = JSON.parse(localStorage.getItem(CACHE) || 'null');
  let session = null;
  try { session = (await CL.sb.auth.getSession()).data.session; } catch (e) { /* offline */ }
  if (session) { await afterLogin(session.user); return; }
  if (cached && !navigator.onLine) { // offline start: keep selling, sync later
    Object.assign(CL, { user: cached.user, team: cached.team, member: cached.member, offlineStart: true });
    const st = JSON.parse(localStorage.getItem(syncKey()) || 'null');
    if (st) { CL.snap = st.snap || {}; CL.cursor = st.cursor; CL.last = st.last; }
    render(); return;
  }
  if (!localStorage.getItem(LOCAL_ONLY)) showGate();
}
cloudBoot();
