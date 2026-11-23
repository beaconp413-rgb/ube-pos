/* Ube POS — offline team POS for a home-based ube franchise branch.
   Data lives in localStorage (KEY). Stock is held in dated batches, sold first-in-first-out. */
'use strict';
const KEY = 'ube-pos-v1', ME_KEY = 'ube-pos-me';
const $ = s => document.querySelector(s);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
const peso = n => '₱' + (Math.round(num(n) * 100) / 100).toLocaleString('en-PH', { maximumFractionDigits: 2 });
const ymd = d => { d = new Date(d); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const today = () => ymd(new Date());
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return ymd(d); };
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 864e5);
const fmtDate = s => s ? new Date(s.length === 10 ? s + 'T00:00:00' : s).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' }) : '';
const fmtTime = s => new Date(s).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });

/* ---------- data ---------- */
function seed() {
  const y = new Date().getFullYear();
  return {
    v: 1,
    settings: {
      branch: 'Ilocos Branch', team: ['Kevin', 'Karen'], delFee: 50,
      target: 100, seasonStart: today(), seasonEnd: y + '-12-31',
      shelfDays: 90, lowStock: 5, expiryWarn: 14, cutoffDay: 3, cutoffHour: 12, downPct: 50,
      thanks: 'Salamat po! 💜 Kindly keep frozen. We would love your feedback — and try our Jar Flans next time!'
    },
    products: [
      { id: 'ube800', name: 'Ube Halaya 800g', price: 380, rprice: 0, kind: 'item', active: true },
      { id: 'flan_sp', name: 'Jar Flan – Spanish', price: 0, rprice: 0, kind: 'item', active: true },
      { id: 'flan_ube', name: 'Jar Flan – Ube', price: 0, rprice: 0, kind: 'item', active: true },
      { id: 'flan_mt', name: 'Jar Flan – Matcha', price: 0, rprice: 0, kind: 'item', active: true },
      { id: 'bundle1', name: 'Gift Bundle (Ube + Ube Flan)', price: 0, rprice: 0, kind: 'bundle', active: true,
        parts: [{ pid: 'ube800', qty: 1 }, { pid: 'flan_ube', qty: 1 }] }
    ],
    batches: [], sales: [], orders: [], customers: [], cash: [], losses: [], moves: [], closes: [], openingFund: 0
  };
}
let S;
function load() {
  try { S = JSON.parse(localStorage.getItem(KEY)); } catch (e) { S = null; }
  if (!S || !S.v) S = seed();
  const d = seed();
  S.settings = Object.assign({}, d.settings, S.settings);
  for (const k of ['batches', 'sales', 'orders', 'customers', 'cash', 'losses', 'moves', 'closes']) S[k] = S[k] || [];
}
function save() { localStorage.setItem(KEY, JSON.stringify(S)); window.onSaved && onSaved(); }
const me = () => (window.cloudName && cloudName()) || localStorage.getItem(ME_KEY) || S.settings.team[0] || 'Me';
const P = id => S.products.find(p => p.id === id);
const C = id => S.customers.find(c => c.id === id);

/* ---------- stock (FIFO batches) ---------- */
const liveBatches = pid => S.batches.filter(b => b.pid === pid && b.qty > 0 && b.expires >= today())
  .sort((a, b) => (a.received + a.expires).localeCompare(b.received + b.expires));
const baseStock = pid => liveBatches(pid).reduce((s, b) => s + b.qty, 0);
function stockOf(pid) {
  const p = P(pid); if (!p) return 0;
  if (p.kind === 'bundle') return (p.parts || []).length ? Math.min(...p.parts.map(x => Math.floor(baseStock(x.pid) / Math.max(1, x.qty)))) : 0;
  return baseStock(pid);
}
function expand(items) { // {pid,qty}[] -> {basePid: qty}
  const need = {};
  for (const l of items) {
    const p = P(l.pid); if (!p) continue;
    if (p.kind === 'bundle') for (const x of p.parts || []) need[x.pid] = (need[x.pid] || 0) + x.qty * l.qty;
    else need[l.pid] = (need[l.pid] || 0) + l.qty;
  }
  return need;
}
function shortages(items) {
  const need = expand(items), out = [];
  for (const pid in need) { const have = baseStock(pid); if (have < need[pid]) out.push(`${P(pid)?.name}: need ${need[pid]}, have ${have}`); }
  return out;
}
function allocate(items) { // deducts stock FIFO; returns {alloc, cost}
  const need = expand(items), alloc = []; let cost = 0;
  for (const pid in need) {
    let left = need[pid];
    for (const b of liveBatches(pid)) {
      if (!left) break;
      const take = Math.min(left, b.qty); b.qty -= take; left -= take;
      alloc.push({ bid: b.id, pid, qty: take, cost: b.cost }); cost += take * b.cost;
    }
  }
  return { alloc, cost };
}
function restore(alloc) { for (const a of alloc || []) { const b = S.batches.find(x => x.id === a.bid); if (b) b.qty += a.qty; } }
const unitPrice = (p, type) => type === 'reseller' && p.rprice > 0 ? p.rprice : p.price;
const pcsOf = items => Object.values(expand(items)).reduce((a, b) => a + b, 0);

/* ---------- ui helpers ---------- */
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('on'), 2200); }
function openSheet(html) { $('#sheet').innerHTML = html; $('#sheetBg').classList.add('on'); $('#sheet').scrollTop = 0; }
function closeSheet() { $('#sheetBg').classList.remove('on'); }
$('#sheetBg').addEventListener('click', e => { if (e.target.id === 'sheetBg') closeSheet(); });
async function shareText(text, title) {
  if (navigator.share) { try { await navigator.share({ title, text }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  try { await navigator.clipboard.writeText(text); toast('Copied — paste it in Messenger'); } catch (e) { prompt('Copy this:', text); }
}
const opt = (v, l, sel) => `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(l)}</option>`;
const custOptions = sel => '<option value="">— Walk-in / no name —</option>' +
  S.customers.slice().sort((a, b) => a.name.localeCompare(b.name)).map(c => opt(c.id, c.name + (c.type !== 'customer' ? ` (${c.type})` : ''), sel)).join('') +
  opt('__new', '+ New customer…', sel);

let tab = 'home';
function go(t) { tab = t; document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t || (t !== 'home' && t !== 'sell' && t !== 'stock' && t !== 'orders' && b.dataset.tab === 'more'))); render(); window.scrollTo(0, 0); }
$('#tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) go(b.dataset.tab); });
$('#sellerChip').onclick = () => (window.cloudName && cloudName()) ? go('team') : openSheet(`<h2>Who is using this phone?</h2><p class="mut small">Sales are recorded under this name.</p>
  ${S.settings.team.map(n => `<button class="btn ${n === me() ? '' : 'sec'} block" style="margin-bottom:8px" onclick="setMe('${esc(n)}')">${esc(n)}</button>`).join('')}`);
window.setMe = n => { localStorage.setItem(ME_KEY, n); closeSheet(); render(); };

function render() {
  $('#hdrSub').textContent = S.settings.branch;
  $('#sellerChip').textContent = '👤 ' + me() + (window.syncBadge ? syncBadge() : '');
  const v = $('#view');
  ({ home: vHome, sell: vSell, stock: vStock, orders: vOrders, more: vMore, customers: vCustomers, money: vMoney, reports: vReports, settings: vSettings, team: x => window.vTeam ? vTeam(x) : (x.innerHTML = '') })[tab](v);
  $('.cartbar')?.remove();
  if (tab === 'sell') renderCartBar();
}

/* ---------- periods & metrics ---------- */
function period(key) {
  const t = today(), d = new Date();
  if (key === 'today') return [t, t];
  if (key === 'week') { const dow = (d.getDay() + 6) % 7; return [addDays(t, -dow), t]; }
  if (key === 'month') return [t.slice(0, 8) + '01', t];
  if (key === 'season') return [S.settings.seasonStart, S.settings.seasonEnd];
  return ['0000', '9999'];
}
const localDay = ts => ts.length > 10 ? ymd(ts) : ts; // stored times are UTC; compare by the phone's local date
const inP = (ts, [a, b]) => { const x = localDay(ts); return x >= a && x <= b; };
function metrics(p) {
  const sales = S.sales.filter(s => inP(s.ts, p));
  const rev = sales.reduce((a, s) => a + s.total, 0), cogs = sales.reduce((a, s) => a + s.cost, 0);
  const exp = S.cash.filter(c => c.kind === 'out' && c.cat !== 'Stock purchase' && c.cat !== 'Refund' && c.cat !== 'Owner withdrawal' && inP(c.ts, p)).reduce((a, c) => a + c.amount, 0);
  const loss = S.losses.filter(l => inP(l.ts, p)).reduce((a, l) => a + l.qty * l.cost, 0);
  const pcs = sales.reduce((a, s) => a + pcsOf(s.items), 0), del = sales.reduce((a, s) => a + (s.delFee || 0), 0);
  return { sales, del, rev, cogs, gross: rev - cogs, exp, loss, net: rev - cogs - exp - loss, pcs, n: sales.length };
}
const fund = () => num(S.openingFund) + S.cash.reduce((a, c) => a + (c.kind === 'in' ? c.amount : -c.amount), 0);
function nextCutoff() {
  const d = new Date(), { cutoffDay, cutoffHour } = S.settings;
  const c = new Date(d); c.setHours(cutoffHour, 0, 0, 0);
  c.setDate(c.getDate() + ((cutoffDay - c.getDay() + 7) % 7));
  if (c <= d) c.setDate(c.getDate() + 7);
  return c;
}
function reorderPlan() { // sell rate of last 14 days × 14 days cover + open orders − stock
  const since = addDays(today(), -13), sold = {};
  S.sales.filter(s => localDay(s.ts) >= since).forEach(s => { const e = expand(s.items); for (const k in e) sold[k] = (sold[k] || 0) + e[k]; });
  const reserved = expand(S.orders.filter(o => o.status === 'open').flatMap(o => o.items));
  return S.products.filter(p => p.kind === 'item' && p.active).map(p => {
    const rate = (sold[p.id] || 0) / 14, stock = baseStock(p.id), res = reserved[p.id] || 0;
    return { p, rate, stock, res, suggest: Math.max(0, Math.ceil(rate * 14 + res - stock)) };
  });
}

/* ---------- HOME ---------- */
function vHome(v) {
  const s = S.settings, season = metrics(period('season')), td = metrics(period('today'));
  const pct = Math.min(100, Math.round(season.pcs / Math.max(1, s.target) * 100));
  const daysLeft = Math.max(0, daysBetween(today(), s.seasonEnd));
  const perDay = daysLeft ? Math.ceil(Math.max(0, s.target - season.pcs) / daysLeft) : 0;
  const alerts = [];
  const exp = S.batches.filter(b => b.qty > 0 && b.expires < today());
  if (exp.length) alerts.push(`<div class="alert bad">⚠️ <b>${exp.reduce((a, b) => a + b.qty, 0)} pcs expired</b> — do not sell. <a href="#" onclick="go('stock');return false">Discard in Stock</a></div>`);
  const soon = S.batches.filter(b => b.qty > 0 && b.expires >= today() && daysBetween(today(), b.expires) <= s.expiryWarn);
  if (soon.length) alerts.push(`<div class="alert">⏳ ${soon.reduce((a, b) => a + b.qty, 0)} pcs expire within ${s.expiryWarn} days — sell these first / bundle them.</div>`);
  S.products.filter(p => p.kind === 'item' && p.active).forEach(p => { const n = baseStock(p.id); if (n <= lowOf(p)) alerts.push(`<div class="alert">📉 Low stock: <b>${esc(p.name)}</b> (${n} left)</div>`); });
  S.orders.filter(o => o.status === 'open' && daysBetween(today(), o.due) <= 3).forEach(o => alerts.push(`<div class="alert ${o.due < today() ? 'bad' : 'info'}">📋 Order for <b>${esc(o.custName)}</b> due ${fmtDate(o.due)} — ${pcsOf(o.items)} pcs, balance ${peso(o.total - o.paid)}</div>`));
  const noPrice = S.products.filter(p => p.active && !p.price);
  if (noPrice.length) alerts.push(`<div class="alert info">💡 Set prices for: ${noPrice.map(p => esc(p.name)).join(', ')}. <a href="#" onclick="go('settings');return false">Settings</a></div>`);
  const cut = nextCutoff(), hrs = Math.round((cut - new Date()) / 36e5);
  const plan = reorderPlan().filter(r => r.suggest > 0);
  v.innerHTML = `
  <div class="card"><div class="row sb"><b>🎄 Christmas target</b><span class="mut small">${fmtDate(s.seasonStart)} – ${fmtDate(s.seasonEnd)}</span></div>
    <div class="row sb" style="margin:8px 0 6px"><span style="font-size:22px;font-weight:700">${season.pcs} <span class="mut" style="font-size:14px">/ ${s.target} pcs</span></span><b class="${pct >= 100 ? 'ok' : ''}">${pct}%</b></div>
    <div class="bar"><i style="width:${pct}%"></i></div>
    <div class="small mut" style="margin-top:6px">${pct >= 100 ? 'Target reached! 🎉' : `${daysLeft} days left · need about <b>${perDay} pcs/day</b>`}</div></div>
  <div class="grid3">
    <div class="card stat"><small>Today sales</small><b>${peso(td.rev)}</b><small>${td.pcs} pcs</small></div>
    <div class="card stat"><small>Today profit</small><b class="${td.net >= 0 ? 'ok' : 'bad'}">${peso(td.net)}</b><small>after costs</small></div>
    <div class="card stat"><small>Fund on hand</small><b>${peso(fund())}</b><small>revolving</small></div>
  </div>
  ${alerts.join('')}
  <div class="card"><div class="row sb"><b>🚚 Next order cutoff</b><span class="pill ${hrs < 24 ? 'warn' : ''}">${cut.toLocaleDateString('en-PH', { weekday: 'short', month: 'short', day: 'numeric' })} ${S.settings.cutoffHour}:00 · ${hrs < 48 ? hrs + 'h' : Math.round(hrs / 24) + ' days'}</span></div>
    ${plan.length ? `<table class="t" style="margin-top:8px"><tr><th>Suggested order</th><th class="r">Stock</th><th class="r">Reserved</th><th class="r">Order</th></tr>
      ${plan.map(r => `<tr><td>${esc(r.p.name)}</td><td class="r">${r.stock}</td><td class="r">${r.res}</td><td class="r"><b>${r.suggest}</b></td></tr>`).join('')}</table>
      <div class="small mut" style="margin-top:6px">Based on the last 14 days of sales + open pre-orders. Combine into one weekly order.</div>`
      : `<div class="small mut" style="margin-top:6px">No reorder needed from recent sales. Order once a week; dispatch Sat/Sun.</div>`}</div>
  <div class="card"><b>Stock on hand</b><div class="list">${S.products.filter(p => p.active).map(p => { const n = stockOf(p.id); return `<div class="it"><span class="grow">${esc(p.name)}</span><span class="pill ${n <= (p.kind === 'bundle' ? S.settings.lowStock : lowOf(p)) ? (n ? 'warn' : 'bad') : 'ok'}">${n} ${p.kind === 'bundle' ? 'possible' : 'pcs'}</span></div>`; }).join('')}</div></div>
  <button class="btn sec block" onclick="shareDaily()">📤 Share today's report to the team</button>`;
}
window.shareDaily = () => shareText(reportText('today'), 'Daily report');

/* ---------- SELL ---------- */
const cart = { lines: {}, type: 'retail', cust: '', pay: 'Cash', disc: 0, deliv: false, delFee: 0, courier: 0, addr: '' };
function cartItems() { return Object.entries(cart.lines).filter(([, q]) => q > 0).map(([pid, qty]) => ({ pid, qty })); }
function cartTotals() {
  const items = cartItems().map(l => { const p = P(l.pid); return { ...l, name: p.name, price: unitPrice(p, cart.type) }; });
  const sub = items.reduce((a, l) => a + l.qty * l.price, 0);
  const delFee = cart.deliv ? num(cart.delFee) : 0;
  return { items, sub, delFee, total: Math.max(0, sub - num(cart.disc)) + delFee };
}
function vSell(v) {
  const prods = S.products.filter(p => p.active);
  v.innerHTML = `<div class="seg" style="margin-bottom:10px">${['retail', 'reseller'].map(t => `<button class="${cart.type === t ? 'on' : ''}" onclick="cart.type='${t}';render()">${t === 'retail' ? 'Retail' : 'Reseller price'}</button>`).join('')}</div>
  <div class="prods">${prods.map(p => { const n = stockOf(p.id), q = cart.lines[p.id] || 0, pr = unitPrice(p, cart.type);
    return `<button class="prod ${n - q <= 0 && !q ? 'out' : ''}" onclick="addCart('${p.id}')">${q ? `<span class="q">${q}</span>` : ''}<b>${esc(p.name)}</b>
      <div class="p">${pr ? peso(pr) : '<span class="warn small">Set price</span>'}</div><div class="s">${n} in stock</div></button>`; }).join('')}</div>
  ${prods.length ? '' : '<div class="empty">No products. Add them in More → Settings.</div>'}`;
}
window.addCart = pid => {
  const p = P(pid);
  if (!unitPrice(p, cart.type)) { const v = num(prompt(`Price for ${p.name}?`)); if (!v) return; p.price = v; save(); }
  const q = (cart.lines[pid] || 0) + 1;
  if (shortages([...cartItems().filter(l => l.pid !== pid), { pid, qty: q }]).length) { toast('Not enough stock — receive stock first'); return; }
  cart.lines[pid] = q; render();
};
function renderCartBar() {
  const { items, total } = cartTotals(); if (!items.length) return;
  const d = document.createElement('div'); d.className = 'cartbar';
  d.innerHTML = `<button class="btn" onclick="openCart()"><span>🛒 ${items.reduce((a, l) => a + l.qty, 0)} item(s)</span><span>${peso(total)} ›</span></button>`;
  document.body.appendChild(d);
}
window.openCart = () => {
  const { items, sub, total } = cartTotals();
  if (!items.length) { closeSheet(); render(); return; }
  openSheet(`<h2>Checkout</h2>
  <div class="list">${items.map(l => `<div class="it"><div class="grow"><b>${esc(l.name)}</b><div class="small mut">${peso(l.price)} each</div></div>
    <div class="qty"><button onclick="cartQty('${l.pid}',-1)">−</button><b style="min-width:22px;text-align:center">${l.qty}</b><button onclick="cartQty('${l.pid}',1)">+</button></div>
    <b style="min-width:70px" class="r">${peso(l.qty * l.price)}</b></div>`).join('')}</div>
  <label class="f">Customer<select id="cCust" onchange="if(this.value==='__new')newCustomer('cCust')">${custOptions(cart.cust)}</select></label>
  <div class="grid2"><label class="f">Payment<select id="cPay">${['Cash', 'GCash', 'Maya', 'Bank'].map(x => opt(x, x, cart.pay)).join('')}</select></label>
  <label class="f">Discount (₱)<input id="cDisc" type="number" inputmode="decimal" value="${cart.disc || ''}" oninput="cart.disc=this.value;cUpd()"></label></div>
  <label class="f"><input type="checkbox" ${cart.deliv ? 'checked' : ''} style="display:inline;width:auto" onchange="cKeep();cart.deliv=this.checked;if(cart.deliv&&!cart.delFee)cart.delFee=S.settings.delFee;openCart()"> 🛵 For delivery</label>
  ${cart.deliv ? `<div class="card" style="background:var(--ube-l)"><div class="grid2"><label class="f">Delivery fee customer pays (₱)<input id="cDF" type="number" inputmode="decimal" value="${cart.delFee || ''}" oninput="cart.delFee=this.value;cUpd()"></label>
  <label class="f">Rider / courier cost we pay (₱)<input id="cCo" type="number" inputmode="decimal" value="${cart.courier || ''}" placeholder="0 if we deliver" oninput="cart.courier=this.value"></label></div>
  <label class="f" style="margin:0">Address / landmark<input id="cAd" value="${esc(cart.addr)}" oninput="cart.addr=this.value"></label></div>` : ''}
  <div class="row sb" style="font-size:20px;margin:6px 0 14px"><span>Total</span><b id="cTot">${peso(total)}</b></div>
  <div class="row"><button class="btn ghost" onclick="clearCart()">Clear</button><button class="btn grow" onclick="checkout()">✅ Complete sale</button></div>`);
};
window.cUpd = () => { const t = cartTotals(); $('#cTot').textContent = peso(t.total); };
window.cKeep = () => { cart.cust = $('#cCust').value === '__new' ? '' : $('#cCust').value; cart.pay = $('#cPay').value; };
window.cartQty = (pid, d) => {
  cKeep();
  const q = (cart.lines[pid] || 0) + d;
  if (d > 0 && shortages([...cartItems().filter(l => l.pid !== pid), { pid, qty: q }]).length) { toast('Not enough stock'); return; }
  cart.lines[pid] = Math.max(0, q); openCart(); render();
};
window.clearCart = () => { Object.assign(cart, { lines: {}, disc: 0, cust: '', deliv: false, delFee: 0, courier: 0, addr: '' }); closeSheet(); render(); };
window.checkout = () => {
  cart.cust = $('#cCust').value === '__new' ? '' : $('#cCust').value; cart.pay = $('#cPay').value; cart.disc = num($('#cDisc').value);
  const { items, sub, total, delFee } = cartTotals(), courier = cart.deliv ? num(cart.courier) : 0;
  const short = shortages(items); if (short.length) { alert('Not enough stock:\n' + short.join('\n')); return; }
  const { alloc, cost } = allocate(items), c = C(cart.cust);
  const sale = { id: uid(), ts: new Date().toISOString(), seller: me(), customerId: c?.id || '', custName: c?.name || 'Walk-in', type: cart.type, pay: cart.pay, items, sub, discount: num(cart.disc), delFee, courier, addr: cart.deliv ? cart.addr : '', total, cost, alloc };
  S.sales.push(sale);
  S.cash.push({ id: uid(), ts: sale.ts, kind: 'in', amount: total, cat: 'Sale', via: sale.pay, note: sale.custName, ref: sale.id, by: me() });
  if (courier > 0) S.cash.push({ id: uid(), ts: sale.ts, kind: 'out', amount: courier, cat: 'Delivery / courier', via: 'Cash', note: sale.custName, ref: sale.id, by: me() });
  save(); Object.assign(cart, { lines: {}, disc: 0, cust: '', deliv: false, delFee: 0, courier: 0, addr: '' });
  showReceipt(sale); render();
};
function receiptText(s) {
  return `${S.settings.branch}\n${new Date(s.ts).toLocaleString('en-PH')}\nCustomer: ${s.custName}\n\n` +
    s.items.map(l => `${l.qty} × ${l.name}  ${peso(l.qty * l.price)}`).join('\n') +
    (s.discount ? `\nDiscount  -${peso(s.discount)}` : '') + (s.delFee ? `\nDelivery fee  ${peso(s.delFee)}` : '') + (s.addr ? `\nDeliver to: ${s.addr}` : '') + `\nTOTAL  ${peso(s.total)}  (${s.pay})` +
    (s.orderId ? `\nPaid earlier (deposit)  ${peso(s.total - s.collected)}` : '') + `\n\n${S.settings.thanks}`;
}
function showReceipt(s) {
  openSheet(`<h2>✅ Sale saved</h2><pre class="rcpt">${esc(receiptText(s))}</pre>
  <div class="row"><button class="btn sec grow" onclick="shareText(receiptText(S.sales.find(x=>x.id==='${s.id}')),'Receipt')">📤 Send receipt</button><button class="btn grow" onclick="closeSheet()">Done</button></div>`);
}
window.receiptText = receiptText;

window.newCustomer = (selectId, after) => {
  const name = (prompt('Customer / reseller name?') || '').trim();
  if (!name) { if (selectId) $('#' + selectId).value = ''; return; }
  const type = confirm(`Is ${name} a RESELLER?\nOK = Reseller, Cancel = Regular customer`) ? 'reseller' : 'customer';
  const c = { id: uid(), name, phone: '', type, note: '', created: today() };
  S.customers.push(c); save();
  if (selectId) { const sel = $('#' + selectId); sel.innerHTML = custOptions(c.id); sel.value = c.id; }
  if (selectId === 'cCust' && type === 'reseller' && cart.type !== 'reseller') { cart.type = 'reseller'; cart.cust = c.id; openCart(); render(); }
  after && after(c);
};

/* ---------- STOCK ---------- */
const lowOf = p => p.low ?? S.settings.lowStock;
const shelfOf = p => p.shelf || S.settings.shelfDays;
function logMove(pid, qty, type, reason, bid, note) {
  S.moves.push({ id: uid(), ts: new Date().toISOString(), pid, qty, type, reason: reason || '', bid: bid || '', note: note || '', by: me() });
}
const sortB = (a, b) => (a.received + a.expires).localeCompare(b.received + b.expires);
function vStock(v) {
  const items = S.products.filter(p => p.kind === 'item' && p.active), bundles = S.products.filter(p => p.kind === 'bundle' && p.active);
  const archived = S.products.filter(p => !p.active);
  v.innerHTML = `<h2>Stock (first in, first out)</h2>
  <div class="row" style="margin-bottom:12px"><button class="btn grow" onclick="receiveForm()">＋ Receive stock</button><button class="btn sec grow" onclick="productForm()">＋ New product</button></div>
  ${items.map(p => {
    const bs = S.batches.filter(b => b.pid === p.id && b.qty > 0).sort(sortB), n = baseStock(p.id);
    return `<div class="card"><div class="row sb"><div class="grow"><b>${esc(p.name)}</b><div class="small mut">${p.price ? peso(p.price) : '<span class="warn">no price</span>'}${p.rprice ? ' · reseller ' + peso(p.rprice) : ''} · alert at ${lowOf(p)} · ${shelfOf(p)}d shelf</div></div>
      <span class="pill ${n <= lowOf(p) ? (n ? 'warn' : 'bad') : 'ok'}">${n} sellable</span></div>
    ${bs.length ? `<table class="t" style="margin-top:6px"><tr><th>Received</th><th>Expires</th><th class="r">Qty</th><th></th></tr>${bs.map((b, i) => {
      const dl = daysBetween(today(), b.expires), cls = dl < 0 ? 'bad' : dl <= S.settings.expiryWarn ? 'warn' : 'ok';
      return `<tr><td>${fmtDate(b.received)}${i === 0 ? ' <span class="pill">sell 1st</span>' : ''}</td><td><span class="pill ${cls}">${dl < 0 ? 'EXPIRED' : fmtDate(b.expires) + ' · ' + dl + 'd'}</span></td><td class="r"><b>${b.qty}</b>/${b.qty0}</td>
      <td class="r"><button class="btn ghost sm" onclick="batchMenu('${b.id}')">Edit</button></td></tr>`; }).join('')}</table>`
      : '<div class="small mut" style="margin-top:6px">No stock.</div>'}
    <div class="row" style="margin-top:8px"><button class="btn ghost sm" onclick="productForm('${p.id}')">✏️ Edit product</button><button class="btn ghost sm" onclick="countForm('${p.id}')">🔢 Count stock</button><button class="btn ghost sm" onclick="receiveForm('${p.id}')">＋ Receive</button></div></div>`; }).join('') || '<div class="empty">No products yet. Tap “New product”.</div>'}
  ${bundles.length ? `<h3>Bundles</h3><div class="card list">${bundles.map(p => `<div class="it"><div class="grow"><b>${esc(p.name)}</b><div class="small mut">${(p.parts || []).map(x => x.qty + '× ' + esc(P(x.pid)?.name || '?')).join(' + ')} · ${p.price ? peso(p.price) : 'no price'}</div></div>
    <span class="pill">${stockOf(p.id)} possible</span><button class="btn ghost sm" onclick="productForm('${p.id}')">Edit</button></div>`).join('')}</div>` : ''}
  ${archived.length ? `<h3>Hidden products</h3><div class="card list">${archived.map(p => `<div class="it"><span class="grow mut">${esc(p.name)}</span><button class="btn ghost sm" onclick="productForm('${p.id}')">Edit / show</button></div>`).join('')}</div>` : ''}
  <h3>Stock history</h3><div class="card list">${moveRows(S.moves.slice(-12).reverse(), true) || '<div class="small mut">No stock changes yet.</div>'}</div>
  <div class="small mut">Rules: mark the date received on day one · keep frozen, away from meat · thawed &gt;24 hrs = discard.</div>`;
}
const moveRows = (ms, showName) => ms.map(m => `<div class="it"><div class="grow">${showName ? `<b>${esc(P(m.pid)?.name || '?')}</b> · ` : ''}${esc(m.type)}${m.reason ? ' — ' + esc(m.reason) : ''}
  <div class="small mut">${fmtDate(m.ts)} ${fmtTime(m.ts)} · ${esc(m.by)}${m.note ? ' · ' + esc(m.note) : ''}</div></div><b class="${m.qty >= 0 ? 'ok' : 'bad'}">${m.qty > 0 ? '+' : ''}${m.qty}</b></div>`).join('');

/* product add / edit */
window.productForm = (id, kind) => {
  const p = id ? P(id) : { name: '', price: 0, rprice: 0, kind: kind || 'item', active: true, parts: [] };
  const isNew = !id, items = S.products.filter(q => q.kind === 'item' && q.active);
  const used = id && (S.batches.some(b => b.pid === id) || S.sales.some(s => s.items.some(l => l.pid === id)) || S.orders.some(o => o.items.some(l => l.pid === id)) || S.products.some(q => (q.parts || []).some(x => x.pid === id)));
  const hist = id ? S.moves.filter(m => m.pid === id).slice(-15).reverse() : [];
  pfParts = (p.parts || []).map(x => ({ ...x }));
  if (p.kind === 'bundle' && !pfParts.length && items.length) pfParts = [{ pid: items[0].id, qty: 1 }];
  openSheet(`<h2>${isNew ? 'New ' + (p.kind === 'bundle' ? 'bundle' : 'product') : 'Edit ' + esc(p.name)}</h2>
  ${isNew ? `<div class="seg" style="margin-bottom:10px">${[['item', 'Single product'], ['bundle', 'Bundle / gift set']].map(([k, l]) => `<button class="${p.kind === k ? 'on' : ''}" onclick="productForm(null,'${k}')">${l}</button>`).join('')}</div>` : ''}
  <label class="f">Name<input id="pfN" value="${esc(p.name)}" placeholder="${p.kind === 'bundle' ? 'e.g. Christmas Gift Set' : 'e.g. Ube Cheese Flan, Sugar-free Ube'}"></label>
  <div class="grid2"><label class="f">Retail price ₱<input id="pfP" type="number" inputmode="decimal" value="${p.price || ''}"></label>
  <label class="f">Reseller price ₱<input id="pfR" type="number" inputmode="decimal" value="${p.rprice || ''}" placeholder="same as retail"></label></div>
  ${p.kind === 'item' ? `<div class="grid2"><label class="f">Low-stock alert (pcs)<input id="pfL" type="number" inputmode="numeric" value="${p.low ?? ''}" placeholder="${S.settings.lowStock}"></label>
  <label class="f">Frozen shelf life (days)<input id="pfS" type="number" inputmode="numeric" value="${p.shelf || ''}" placeholder="${S.settings.shelfDays}"></label></div>
  ${isNew ? `<div class="card" style="background:var(--ube-l)"><b class="small">Starting stock (optional)</b><div class="grid3" style="margin-top:6px">
    <label class="f">Qty<input id="pfQ" type="number" inputmode="numeric"></label><label class="f">Cost/pc<input id="pfC" type="number" inputmode="decimal"></label><label class="f">Received<input id="pfD" type="date" value="${today()}"></label></div></div>` : ''}`
    : `<b class="small">Contents</b><div id="pfParts"></div><button class="btn ghost sm" onclick="pfAdd()">＋ Add item</button>`}
  <label class="f" style="margin-top:10px"><input type="checkbox" id="pfA" ${p.active ? 'checked' : ''} style="display:inline;width:auto"> Show in Sell screen</label>
  <button class="btn block" onclick="saveProduct('${id || ''}','${p.kind}')">${isNew ? 'Add product' : 'Save changes'}</button>
  ${id && !used ? `<button class="btn danger block" style="margin-top:8px" onclick="delProduct('${id}')">Delete product</button>` : id ? `<div class="small mut" style="margin-top:8px">This product has history, so it can't be deleted — untick “Show in Sell screen” to hide it.</div>` : ''}
  ${hist.length ? `<h3>History</h3><div class="list">${moveRows(hist)}</div>` : ''}`);
  if (p.kind === 'bundle') pfDraw();
};
let pfParts = [];
function pfDraw() {
  const items = S.products.filter(q => q.kind === 'item');
  $('#pfParts').innerHTML = pfParts.map((x, i) => `<div class="row" style="margin:6px 0"><select class="grow" style="padding:8px;border:1px solid var(--line);border-radius:9px" onchange="pfParts[${i}].pid=this.value">${items.map(q => opt(q.id, q.name, x.pid)).join('')}</select>
    <input type="number" inputmode="numeric" min="1" value="${x.qty}" style="width:56px;padding:8px;border:1px solid var(--line);border-radius:9px;text-align:center" onchange="pfParts[${i}].qty=Math.max(1,Math.floor(num(this.value)))">
    <button class="btn ghost sm" onclick="pfParts.splice(${i},1);pfDraw()">✕</button></div>`).join('');
}
window.pfAdd = () => { const it = S.products.find(q => q.kind === 'item'); if (it) { pfParts.push({ pid: it.id, qty: 1 }); pfDraw(); } };
window.saveProduct = (id, kind) => {
  const name = $('#pfN').value.trim(); if (!name) { toast('Enter a name'); return; }
  if (S.products.some(q => q.id !== id && q.name.toLowerCase() === name.toLowerCase())) { toast('A product with that name exists'); return; }
  if (kind === 'bundle' && !pfParts.length) { toast('Add at least one item to the bundle'); return; }
  const p = id ? P(id) : { id: uid(), kind };
  Object.assign(p, { name, price: num($('#pfP').value), rprice: num($('#pfR').value), active: $('#pfA').checked });
  if (kind === 'item') { const l = $('#pfL').value; p.low = l === '' ? undefined : num(l); p.shelf = num($('#pfS').value) || undefined; }
  else p.parts = pfParts.map(x => ({ ...x }));
  if (!id) {
    S.products.push(p);
    const q = kind === 'item' ? Math.floor(num($('#pfQ').value)) : 0;
    if (q > 0) { const rec = $('#pfD').value || today(), b = { id: uid(), pid: p.id, qty0: q, qty: q, cost: num($('#pfC').value), received: rec, expires: addDays(rec, shelfOf(p)), by: me() };
      S.batches.push(b); logMove(p.id, q, 'Received', 'Starting stock', b.id); }
    logMove(p.id, 0, 'Product added', '', '', name);
  }
  save(); closeSheet(); render(); toast(id ? 'Saved' : `${name} added`);
};
window.delProduct = id => { if (!confirm('Delete this product?')) return; S.products = S.products.filter(p => p.id !== id); S.moves = S.moves.filter(m => m.pid !== id); delete cart.lines[id]; save(); closeSheet(); render(); };

/* receive */
window.receiveForm = pid => {
  const items = S.products.filter(p => p.kind === 'item' && p.active);
  if (!items.length) { productForm(); return; }
  const first = P(pid) || items[0];
  openSheet(`<h2>Receive stock</h2>
  <label class="f">Product<select id="rP">${items.map(p => opt(p.id, p.name, first.id)).join('')}${opt('__new', '+ New product…')}</select></label>
  <div class="grid2"><label class="f">Quantity (pcs)<input id="rQ" type="number" inputmode="numeric" min="1"></label>
  <label class="f">Cost per pc (franchise price)<input id="rC" type="number" inputmode="decimal" value="${lastCost(first.id)}"></label></div>
  <div class="grid2"><label class="f">Date received<input id="rD" type="date" value="${today()}" onchange="rExp()"></label>
  <label class="f">Expires<input id="rE" type="date"></label></div>
  <label class="f"><input type="checkbox" id="rPay" checked style="display:inline;width:auto"> Paid from revolving fund (records cash out)</label>
  <button class="btn block" onclick="receive()">Save batch</button>`);
  $('#rP').onchange = e => { if (e.target.value === '__new') { productForm(); return; } $('#rC').value = lastCost(e.target.value); rExp(); };
  rExp();
};
window.rExp = () => { const p = P($('#rP').value); if (p) $('#rE').value = addDays($('#rD').value || today(), shelfOf(p)); };
window.addDays = addDays;
const lastCost = pid => { const b = S.batches.filter(x => x.pid === pid).pop(); return b ? b.cost : ''; };
window.receive = () => {
  const pid = $('#rP').value, qty = Math.floor(num($('#rQ').value)), cost = num($('#rC').value);
  if (!P(pid)) return;
  if (qty <= 0) { toast('Enter quantity'); return; }
  const b = { id: uid(), pid, qty0: qty, qty, cost, received: $('#rD').value || today(), expires: $('#rE').value || addDays(today(), shelfOf(P(pid))), by: me() };
  S.batches.push(b); logMove(pid, qty, 'Received', cost ? peso(cost) + '/pc' : '', b.id);
  if ($('#rPay').checked && cost > 0) S.cash.push({ id: uid(), ts: new Date().toISOString(), kind: 'out', amount: qty * cost, cat: 'Stock purchase', via: 'Cash', note: `${qty} × ${P(pid).name}`, ref: b.id, by: me() });
  save(); closeSheet(); toast(`${qty} pcs added — label them "received ${fmtDate(b.received)}"`); render();
};

/* batch edit + remove */
const LOSS_REASONS = ['Expired', 'Thawed >24 hrs', 'Damaged / cracked', 'Tasting / giveaway', 'Sample for photos', 'Own use', 'Missing / lost'];
window.batchMenu = bid => {
  const b = S.batches.find(x => x.id === bid), exp = b.expires < today();
  openSheet(`<h2>${esc(P(b.pid).name)}</h2><p class="mut small">Batch received ${fmtDate(b.received)} · ${b.qty} left of ${b.qty0}</p>
  <h3>Remove from stock</h3>
  <div class="grid2"><label class="f">How many pcs?<input id="lQ" type="number" inputmode="numeric" value="${exp ? b.qty : 1}"></label>
  <label class="f">Reason<select id="lR">${LOSS_REASONS.map(x => opt(x, x, exp ? 'Expired' : '')).join('')}</select></label></div>
  <button class="btn danger block" onclick="discard('${bid}')">Remove (counted as loss)</button>
  <h3>Edit batch details</h3>
  <div class="grid2"><label class="f">Qty on hand<input id="bQ" type="number" inputmode="numeric" value="${b.qty}"></label>
  <label class="f">Cost per pc ₱<input id="bC" type="number" inputmode="decimal" value="${b.cost}"></label>
  <label class="f">Received<input id="bR" type="date" value="${b.received}"></label>
  <label class="f">Expires<input id="bE" type="date" value="${b.expires}"></label></div>
  <button class="btn sec block" onclick="saveBatch('${bid}')">Save batch</button>
  <div class="small mut" style="margin-top:6px">Changing the qty here is logged as a count correction. Use “Remove” above for spoilage or giveaways.</div>`);
};
window.discard = bid => {
  const b = S.batches.find(x => x.id === bid), q = Math.min(b.qty, Math.floor(num($('#lQ').value)));
  if (q <= 0) return;
  const reason = $('#lR').value;
  b.qty -= q; S.losses.push({ id: uid(), ts: new Date().toISOString(), bid, pid: b.pid, qty: q, cost: b.cost, reason, by: me() });
  logMove(b.pid, -q, 'Removed', reason, bid);
  save(); closeSheet(); render();
};
function correct(b, newQty, note) {
  const d = newQty - b.qty; if (!d) return;
  if (d < 0) S.losses.push({ id: uid(), ts: new Date().toISOString(), bid: b.id, pid: b.pid, qty: -d, cost: b.cost, reason: 'Count correction', by: me() });
  else b.qty0 = Math.max(b.qty0, newQty);
  b.qty = newQty; logMove(b.pid, d, 'Count correction', note, b.id);
}
window.saveBatch = bid => {
  const b = S.batches.find(x => x.id === bid), q = Math.max(0, Math.floor(num($('#bQ').value)));
  const changes = [];
  const c = num($('#bC').value); if (c !== b.cost) { changes.push(`cost ${peso(b.cost)}→${peso(c)}`); b.cost = c; }
  if ($('#bR').value && $('#bR').value !== b.received) { changes.push('received date'); b.received = $('#bR').value; }
  if ($('#bE').value && $('#bE').value !== b.expires) { changes.push('expiry date'); b.expires = $('#bE').value; }
  if (changes.length) logMove(b.pid, 0, 'Batch edited', changes.join(', '), bid);
  correct(b, q, 'edited batch');
  save(); closeSheet(); render(); toast('Batch saved');
};

/* stock count (stocktake) */
window.countForm = pid => {
  const p = P(pid), bs = S.batches.filter(b => b.pid === pid && b.qty > 0).sort(sortB);
  openSheet(`<h2>Count stock — ${esc(p.name)}</h2><p class="small mut">Count what is physically in the freezer, batch by batch, and type the real number. The difference is saved in the stock history.</p>
  ${bs.length ? `<table class="t">${bs.map(b => `<tr><td>Received ${fmtDate(b.received)}<div class="small mut">expires ${fmtDate(b.expires)} · app says ${b.qty}</div></td>
    <td class="r"><input class="cnt" data-bid="${b.id}" type="number" inputmode="numeric" value="${b.qty}" style="width:70px;padding:8px;border:1px solid var(--line);border-radius:9px;text-align:center"></td></tr>`).join('')}</table>
    <button class="btn block" style="margin-top:12px" onclick="saveCount('${pid}')">Save count</button>`
    : `<div class="empty">No stock recorded. If you found some, use Receive stock.</div>`}
  <button class="btn ghost block" style="margin-top:8px" onclick="receiveForm('${pid}')">Found stock not listed? Receive it as a batch</button>`);
};
window.saveCount = pid => {
  let diff = 0;
  document.querySelectorAll('.cnt').forEach(i => { const b = S.batches.find(x => x.id === i.dataset.bid), q = Math.max(0, Math.floor(num(i.value))); diff += q - b.qty; correct(b, q, 'stock count'); });
  logMove(pid, 0, 'Stock count done', diff ? `difference ${diff > 0 ? '+' : ''}${diff}` : 'matched');
  save(); closeSheet(); render(); toast(diff ? `Count saved (${diff > 0 ? '+' : ''}${diff})` : 'Count matches ✔');
};

/* ---------- ORDERS (pre-orders / reseller / bulk) ---------- */
function vOrders(v) {
  const open = S.orders.filter(o => o.status === 'open').sort((a, b) => a.due.localeCompare(b.due));
  const done = S.orders.filter(o => o.status !== 'open').slice(-10).reverse();
  const row = o => { const bal = o.total - o.paid, dl = daysBetween(today(), o.due);
    return `<div class="it" onclick="orderView('${o.id}')" style="cursor:pointer"><div class="grow"><b>${esc(o.custName)}</b> <span class="pill">${o.type}</span>
      <div class="small mut">${o.items.map(l => l.qty + '× ' + esc(P(l.pid)?.name || l.name)).join(', ')}</div></div>
      <div class="r"><span class="pill ${o.status === 'open' ? (dl < 0 ? 'bad' : dl <= 3 ? 'warn' : '') : o.status === 'done' ? 'ok' : 'bad'}">${o.status === 'open' ? 'Due ' + fmtDate(o.due) : o.status}</span>
      <div class="small ${bal > 0 && o.status === 'open' ? 'warn' : 'mut'}">${o.status === 'open' ? 'Bal ' + peso(bal) : peso(o.total)}</div></div></div>`; };
  v.innerHTML = `<h2>Pre-orders</h2><button class="btn block" style="margin-bottom:12px" onclick="orderForm()">＋ New pre-order</button>
  <div class="card list">${open.map(row).join('') || '<div class="empty">No open orders.</div>'}</div>
  <div class="small mut" style="margin:-2px 2px 10px">Rule: payment first — at least ${S.settings.downPct}% down on bulk and reseller orders.</div>
  ${done.length ? `<h3>Recent</h3><div class="card list">${done.map(row).join('')}</div>` : ''}`;
}
window.orderForm = () => {
  openSheet(`<h2>New pre-order</h2>
  <label class="f">Customer<select id="oC" onchange="if(this.value==='__new')newCustomer('oC');oCalc()">${custOptions('')}</select></label>
  <div class="grid2"><label class="f">Type<select id="oT" onchange="oCalc()">${opt('retail', 'Retail')}${opt('reseller', 'Reseller')}${opt('bulk', 'Bulk / corporate / church')}</select></label>
  <label class="f">Due date<input id="oD" type="date" value="${addDays(today(), 3)}"></label></div>
  ${S.products.filter(p => p.active).map(p => `<div class="row sb" style="margin-bottom:8px"><span class="grow">${esc(p.name)} <span class="small mut" id="oPr_${p.id}"></span></span>
    <input class="oq" data-pid="${p.id}" type="number" inputmode="numeric" min="0" placeholder="0" style="width:70px;padding:8px;border:1px solid var(--line);border-radius:9px;text-align:center" oninput="oCalc()"></div>`).join('')}
  <div class="grid2"><label class="f">Delivery fee (₱)<input id="oDF" type="number" inputmode="decimal" placeholder="0 = pick-up" oninput="oCalc()"></label>
  <label class="f">Address / pick-up<input id="oAd"></label></div>
  <div class="row sb" style="font-size:18px;margin:6px 0"><span>Total</span><b id="oTot">₱0</b></div>
  <div class="grid2"><label class="f">Deposit paid now (₱)<input id="oDep" type="number" inputmode="decimal" oninput="oCalc()"></label>
  <label class="f">Via<select id="oPay">${['Cash', 'GCash', 'Maya', 'Bank'].map(x => opt(x, x)).join('')}</select></label></div>
  <div id="oWarn" class="small"></div>
  <label class="f">Note<input id="oN" placeholder="e.g. with ribbon, pick-up at church"></label>
  <button class="btn block" onclick="saveOrder()">Save order</button>`);
  oCalc();
};
function oLines() {
  const type = $('#oT').value === 'reseller' ? 'reseller' : 'retail';
  return [...document.querySelectorAll('.oq')].map(i => ({ pid: i.dataset.pid, qty: Math.floor(num(i.value)) })).filter(l => l.qty > 0)
    .map(l => { const p = P(l.pid); return { ...l, name: p.name, price: unitPrice(p, type) }; });
}
window.oCalc = () => {
  const c = C($('#oC').value); if (c && c.type === 'reseller' && $('#oT').value === 'retail') $('#oT').value = 'reseller';
  const type = $('#oT').value === 'reseller' ? 'reseller' : 'retail';
  S.products.filter(p => p.active).forEach(p => { const e = $('#oPr_' + p.id); if (e) e.textContent = unitPrice(p, type) ? '· ' + peso(unitPrice(p, type)) : '· no price set'; });
  const ls = oLines(), tot = ls.reduce((a, l) => a + l.qty * l.price, 0) + num($('#oDF').value), dep = num($('#oDep').value);
  $('#oTot').textContent = peso(tot);
  const needDown = $('#oT').value !== 'retail' || pcsOf(ls) >= 10, min = Math.ceil(tot * S.settings.downPct / 100);
  $('#oWarn').innerHTML = needDown && tot && dep < min ? `<div class="alert">Needs at least ${S.settings.downPct}% down: <b>${peso(min)}</b></div>` : '';
};
window.saveOrder = () => {
  const ls = oLines(); if (!ls.length) { toast('Add at least one item'); return; }
  if (ls.some(l => !l.price)) { toast('Set prices first (More → Settings)'); return; }
  const cid = $('#oC').value, c = C(cid);
  if (!c) { toast('Pick or add a customer'); return; }
  const delFee = num($('#oDF').value), tot = ls.reduce((a, l) => a + l.qty * l.price, 0) + delFee, dep = Math.min(tot, num($('#oDep').value)), type = $('#oT').value;
  if ((type !== 'retail' || pcsOf(ls) >= 10) && dep < tot * S.settings.downPct / 100 && !confirm(`Deposit is below ${S.settings.downPct}%. Save anyway?`)) return;
  const o = { id: uid(), created: new Date().toISOString(), due: $('#oD').value || today(), customerId: c.id, custName: c.name, type, items: ls, delFee, addr: $('#oAd').value, total: tot, paid: dep, payments: [], status: 'open', note: $('#oN').value, by: me() };
  if (dep > 0) addPayment(o, dep, $('#oPay').value);
  S.orders.push(o); save(); closeSheet(); render(); toast('Order saved');
};
function addPayment(o, amt, via) {
  const ts = new Date().toISOString();
  o.payments.push({ ts, amt, via });
  S.cash.push({ id: uid(), ts, kind: 'in', amount: amt, cat: 'Order deposit', via, note: o.custName, ref: o.id, by: me() });
}
window.orderView = id => {
  const o = S.orders.find(x => x.id === id), bal = o.total - o.paid, short = o.status === 'open' ? shortages(o.items) : [];
  openSheet(`<h2>${esc(o.custName)} <span class="pill">${o.type}</span></h2>
  <div class="small mut">Due ${fmtDate(o.due)} · taken by ${esc(o.by)} ${o.note ? '· ' + esc(o.note) : ''}</div>
  <table class="t" style="margin:10px 0">${o.items.map(l => `<tr><td>${l.qty} × ${esc(l.name)}</td><td class="r">${peso(l.qty * l.price)}</td></tr>`).join('')}
  ${o.delFee ? `<tr><td>🛵 Delivery fee${o.addr ? ' · ' + esc(o.addr) : ''}</td><td class="r">${peso(o.delFee)}</td></tr>` : o.addr ? `<tr><td colspan="2" class="small mut">${esc(o.addr)}</td></tr>` : ''}
  <tr><td><b>Total</b></td><td class="r"><b>${peso(o.total)}</b></td></tr><tr><td>Paid</td><td class="r ok">${peso(o.paid)}</td></tr><tr><td>Balance</td><td class="r ${bal > 0 ? 'warn' : ''}"><b>${peso(bal)}</b></td></tr></table>
  ${o.payments.map(p => `<div class="small mut">• ${fmtDate(p.ts)} ${peso(p.amt)} via ${esc(p.via)}</div>`).join('')}
  ${o.status === 'open' ? `
    ${short.length ? `<div class="alert bad" style="margin-top:10px">Not enough stock to release:<br>${short.map(esc).join('<br>')}</div>` : ''}
    ${bal > 0 ? `<div class="grid2" style="margin-top:10px"><label class="f">Add payment (₱)<input id="pA" type="number" inputmode="decimal" value="${bal}"></label><label class="f">Via<select id="pV">${['Cash', 'GCash', 'Maya', 'Bank'].map(x => opt(x, x)).join('')}</select></label></div>
      <button class="btn sec block" onclick="payOrder('${o.id}')">Record payment</button>` : ''}
    ${o.delFee || o.addr ? `<label class="f" style="margin-top:10px">Rider / courier cost we pay (₱)<input id="oCo" type="number" inputmode="decimal" placeholder="0 if we deliver"></label>` : ''}
    <button class="btn block" style="margin-top:8px" ${short.length ? 'disabled' : ''} onclick="completeOrder('${o.id}')">📦 Released / delivered${bal > 0 ? ' (collect ' + peso(bal) + ')' : ''}</button>
    <div class="row" style="margin-top:8px"><button class="btn ghost grow" onclick="shareText(orderMsg('${o.id}'),'Order')">📤 Send order summary</button><button class="btn danger" onclick="cancelOrder('${o.id}')">Cancel</button></div>`
    : `<div class="small mut" style="margin-top:8px">Status: ${o.status}</div>`}`);
};
window.orderMsg = id => { const o = S.orders.find(x => x.id === id);
  return `Hi ${o.custName}! 💜 Order confirmation\n${o.items.map(l => `${l.qty} × ${l.name}`).join('\n')}${o.delFee ? `\nDelivery fee ${peso(o.delFee)}` : ''}\nTotal ${peso(o.total)} · Paid ${peso(o.paid)} · Balance ${peso(o.total - o.paid)}\nTarget date: ${fmtDate(o.due)}\nWe'll message you right away if there is any delay. Salamat po!`; };
window.payOrder = id => { const o = S.orders.find(x => x.id === id), a = Math.min(num($('#pA').value), o.total - o.paid); if (a <= 0) return;
  addPayment(o, a, $('#pV').value); o.paid += a; save(); orderView(id); render(); };
window.completeOrder = id => {
  const o = S.orders.find(x => x.id === id), bal = o.total - o.paid, balVia = $('#pV')?.value || 'Cash', courier = num($('#oCo')?.value);
  if (shortages(o.items).length) return;
  if (bal > 0 && !confirm(`Collect the balance of ${peso(bal)} now?`)) return;
  const { alloc, cost } = allocate(o.items), ts = new Date().toISOString();
  const sale = { id: uid(), ts, seller: o.by || me(), customerId: o.customerId, custName: o.custName, type: o.type === 'reseller' ? 'reseller' : 'retail', pay: o.payments[0]?.via || 'Cash',
    items: o.items, sub: o.total - (o.delFee || 0), discount: 0, delFee: o.delFee || 0, courier, addr: o.addr || '', total: o.total, cost, alloc, orderId: o.id, collected: bal };
  S.sales.push(sale);
  if (bal > 0) S.cash.push({ id: uid(), ts, kind: 'in', amount: bal, cat: 'Order balance', via: balVia, note: o.custName, ref: sale.id, by: me() });
  if (courier > 0) S.cash.push({ id: uid(), ts, kind: 'out', amount: courier, cat: 'Delivery / courier', via: 'Cash', note: o.custName, ref: sale.id, by: me() });
  o.paid = o.total; o.status = 'done'; o.saleId = sale.id; save(); showReceipt(sale); render();
};
window.cancelOrder = id => {
  const o = S.orders.find(x => x.id === id); if (!confirm('Cancel this order?')) return;
  if (o.paid > 0 && confirm(`Refund the ${peso(o.paid)} deposit? (records cash out)`)) S.cash.push({ id: uid(), ts: new Date().toISOString(), kind: 'out', amount: o.paid, cat: 'Refund', via: 'Cash', note: o.custName, ref: o.id, by: me() });
  o.status = 'cancelled'; save(); closeSheet(); render();
};

/* ---------- MORE ---------- */
function vMore(v) {
  v.innerHTML = `<h2>More</h2><div class="card list menu">
  ${[['team', '🔐', 'Team & account', window.cloudName && cloudName() ? 'Signed in · invite or remove team members' : 'Sign in to share with your team'], ['customers', '👥', 'Customers & resellers', 'Repeat buyers, contact, history'], ['money', '💰', 'Money (revolving fund)', 'Daily cash in / cash out, expenses'],
    ['reports', '📊', 'Reports', 'Real profit by day, week, month, season'], ['settings', '⚙️', 'Settings & backup', 'Products, prices, team, target']]
    .map(([t, i, a, b]) => `<div class="it" onclick="go('${t}')"><span>${i}</span><div class="grow"><b>${a}</b><div class="small mut">${b}</div></div><span class="mut">›</span></div>`).join('')}</div>
  <h3>Recent sales</h3><div class="card list">${S.sales.slice(-15).reverse().map(s => `<div class="it" onclick="saleView('${s.id}')" style="cursor:pointer"><div class="grow"><b>${esc(s.custName)}</b> <span class="small mut">· ${fmtDate(s.ts)} ${fmtTime(s.ts)} · ${esc(s.seller)}</span>
    <div class="small mut">${s.items.map(l => l.qty + '× ' + esc(l.name)).join(', ')}</div></div><b>${peso(s.total)}</b></div>`).join('') || '<div class="small mut">No sales yet.</div>'}</div>`;
}
window.saleView = id => { const s = S.sales.find(x => x.id === id);
  openSheet(`<h2>Sale</h2><pre class="rcpt">${esc(receiptText(s))}</pre><div class="small mut">Sold by ${esc(s.seller)} · cost ${peso(s.cost)} · profit ${peso(s.total - s.cost)}</div>
  <div class="row" style="margin-top:10px"><button class="btn sec grow" onclick="shareText(receiptText(S.sales.find(x=>x.id==='${id}')),'Receipt')">📤 Send receipt</button><button class="btn danger" onclick="voidSale('${id}')">Void</button></div>`); };
window.voidSale = id => {
  if (!confirm('Void this sale? Stock goes back to its batches and the cash entry is removed.')) return;
  const s = S.sales.find(x => x.id === id); restore(s.alloc);
  S.cash = S.cash.filter(c => c.ref !== id);
  if (s.orderId) { const o = S.orders.find(x => x.id === s.orderId); if (o) { o.status = 'open'; o.paid = o.total - (s.collected || 0); delete o.saleId; } }
  S.sales = S.sales.filter(x => x.id !== id); save(); closeSheet(); render(); toast('Sale voided');
};

function vCustomers(v) {
  const stats = {}; S.sales.forEach(s => { if (!s.customerId) return; const x = stats[s.customerId] ||= { n: 0, amt: 0, last: '' }; x.n++; x.amt += s.total; if (s.ts > x.last) x.last = s.ts; });
  const list = S.customers.slice().sort((a, b) => (stats[b.id]?.amt || 0) - (stats[a.id]?.amt || 0));
  v.innerHTML = `<div class="row sb"><h2>Customers & resellers</h2><button class="btn sm" onclick="newCustomer(null,()=>render())">＋ Add</button></div>
  <div class="card list">${list.map(c => { const x = stats[c.id];
    return `<div class="it" onclick="custView('${c.id}')" style="cursor:pointer"><div class="grow"><b>${esc(c.name)}</b> ${c.type !== 'customer' ? `<span class="pill">${c.type}</span>` : ''} ${x?.n >= 2 ? '<span class="pill ok">repeat</span>' : ''}
      <div class="small mut">${x ? `${x.n} purchase(s) · last ${fmtDate(x.last)}` : 'No purchases yet'}${c.phone ? ' · ' + esc(c.phone) : ''}</div></div><b>${peso(x?.amt || 0)}</b></div>`; }).join('') || '<div class="empty">No customers yet. They are added from Checkout or Orders.</div>'}</div>
  <div class="small mut">After each sale: ask for feedback → suggest the next product → offer a repeat-customer discount.</div>`;
}
window.custView = id => { const c = C(id), sales = S.sales.filter(s => s.customerId === id).reverse();
  openSheet(`<h2>${esc(c.name)}</h2>
  <label class="f">Name<input id="cuN" value="${esc(c.name)}"></label>
  <div class="grid2"><label class="f">Phone / FB<input id="cuP" value="${esc(c.phone)}"></label><label class="f">Type<select id="cuT">${['customer', 'reseller', 'corporate'].map(t => opt(t, t, c.type)).join('')}</select></label></div>
  <label class="f">Note<input id="cuNo" value="${esc(c.note)}" placeholder="e.g. likes matcha, office in Laoag"></label>
  <button class="btn block" onclick="saveCust('${id}')">Save</button>
  <h3>History</h3>${sales.map(s => `<div class="small">${fmtDate(s.ts)} · ${s.items.map(l => l.qty + '× ' + esc(l.name)).join(', ')} · <b>${peso(s.total)}</b></div>`).join('') || '<div class="small mut">None.</div>'}`); };
window.saveCust = id => { const c = C(id); c.name = $('#cuN').value.trim() || c.name; c.phone = $('#cuP').value; c.type = $('#cuT').value; c.note = $('#cuNo').value; save(); closeSheet(); render(); };

const METHODS = ['Cash', 'GCash', 'Maya', 'Bank'];
function balances() {
  const b = Object.fromEntries(METHODS.map(m => [m, 0])); b.Cash += num(S.openingFund);
  S.cash.forEach(c => { const m = c.via || 'Cash'; b[m] = (b[m] || 0) + (c.kind === 'in' ? c.amount : -c.amount); });
  return b;
}
function vMoney(v) {
  const td = period('today'), list = S.cash.slice().reverse().slice(0, 40), bal = balances();
  const inT = S.cash.filter(c => c.kind === 'in' && inP(c.ts, td)).reduce((a, c) => a + c.amount, 0), outT = S.cash.filter(c => c.kind === 'out' && inP(c.ts, td)).reduce((a, c) => a + c.amount, 0);
  const lastClose = S.closes[S.closes.length - 1];
  v.innerHTML = `<h2>Money — revolving fund</h2>
  <div class="grid3"><div class="card stat"><small>Fund on hand</small><b>${peso(fund())}</b></div><div class="card stat"><small>In today</small><b class="ok">${peso(inT)}</b></div><div class="card stat"><small>Out today</small><b class="bad">${peso(outT)}</b></div></div>
  <div class="card"><b>Where the money is</b><table class="t">${METHODS.filter(m => bal[m]).map(m => `<tr><td>${m}</td><td class="r">${peso(bal[m])}</td></tr>`).join('') || '<tr><td class="mut">Nothing yet</td></tr>'}</table></div>
  <button class="btn block" style="margin-bottom:8px" onclick="closeForm()">🧮 End-of-day cash count</button>
  ${lastClose ? `<div class="small mut" style="margin:-2px 2px 10px">Last count: ${fmtDate(lastClose.ts)} by ${esc(lastClose.by)} — ${lastClose.diff ? `<span class="${lastClose.diff > 0 ? 'ok' : 'bad'}">${lastClose.diff > 0 ? 'over' : 'short'} ${peso(Math.abs(lastClose.diff))}</span>` : '<span class="ok">balanced ✔</span>'}</div>` : ''}
  <div class="row" style="margin-bottom:12px"><button class="btn sec grow" onclick="cashForm('out')">− Expense / cash out</button><button class="btn sec grow" onclick="cashForm('in')">＋ Cash in</button></div>
  <div class="card list">${list.map(c => `<div class="it"><div class="grow"><b>${esc(c.cat)}</b> <span class="small mut">· ${fmtDate(c.ts)} · ${esc(c.via || 'Cash')} · ${esc(c.by || '')}</span><div class="small mut">${esc(c.note)}</div></div>
    <b class="${c.kind === 'in' ? 'ok' : 'bad'}">${c.kind === 'in' ? '+' : '−'}${peso(c.amount)}</b>${c.ref ? '' : `<button class="btn ghost sm" onclick="delCash('${c.id}')">✕</button>`}</div>`).join('') || '<div class="small mut">No entries yet.</div>'}</div>
  <div class="small mut">Never use personal money — top up the fund as "Capital" instead. Opening cash: ${peso(S.openingFund)} (Settings).</div>`;
}
window.closeForm = () => {
  const bal = balances(), m = metrics(period('today')), byPay = {};
  m.sales.forEach(s => byPay[s.pay] = (byPay[s.pay] || 0) + s.total);
  openSheet(`<h2>End-of-day cash count</h2>
  <p class="small mut">Count the actual cash in the box and check the GCash/Maya app balance. Type what you really have — not what the app says.</p>
  <table class="t" style="margin-bottom:10px"><tr><th>Today's sales</th><th class="r">${m.n} txns</th></tr>${Object.entries(byPay).map(([k, x]) => `<tr><td>${esc(k)}</td><td class="r">${peso(x)}</td></tr>`).join('') || '<tr><td class="mut">No sales today</td><td></td></tr>'}</table>
  ${METHODS.filter(x => x === 'Cash' || bal[x]).map(x => `<div class="row sb" style="margin-bottom:8px"><div class="grow"><b>${x}</b><div class="small mut">App expects ${peso(bal[x])}</div></div>
    <input class="cc" data-m="${x}" type="number" inputmode="decimal" placeholder="counted" style="width:120px;padding:9px;border:1px solid var(--line);border-radius:9px;text-align:right" oninput="ccCalc()"></div>`).join('')}
  <div id="ccRes" class="small" style="margin:6px 0 10px"></div>
  <label class="f">Note<input id="ccN" placeholder="e.g. gave ₱20 change twice"></label>
  <button class="btn block" onclick="saveClose()">Save count</button>`);
};
window.ccCalc = () => { const bal = balances(); let d = 0, any = false;
  document.querySelectorAll('.cc').forEach(i => { if (i.value !== '') { any = true; d += num(i.value) - bal[i.dataset.m]; } });
  $('#ccRes').innerHTML = !any ? '' : Math.abs(d) < 0.01 ? '<div class="alert info">✔ Balanced</div>' : `<div class="alert ${d < 0 ? 'bad' : ''}">${d < 0 ? 'Short' : 'Over'} by <b>${peso(Math.abs(d))}</b> — the difference will be recorded.</div>`; };
window.saveClose = () => {
  const bal = balances(), ts = new Date().toISOString(), rows = []; let diff = 0;
  document.querySelectorAll('.cc').forEach(i => { if (i.value === '') return; const m = i.dataset.m, d = num(i.value) - bal[m];
    rows.push({ m, expected: bal[m], counted: num(i.value) }); diff += d;
    if (Math.abs(d) >= 0.01) S.cash.push({ id: uid(), ts, kind: d > 0 ? 'in' : 'out', amount: Math.abs(d), cat: 'Count difference', via: m, note: $('#ccN').value || 'end-of-day count', by: me() }); });
  if (!rows.length) { toast('Enter at least the cash count'); return; }
  S.closes.push({ id: uid(), ts, rows, diff: Math.round(diff * 100) / 100, by: me(), note: $('#ccN').value });
  save(); closeSheet(); render(); toast(Math.abs(diff) < 0.01 ? 'Balanced ✔' : `Saved — ${diff < 0 ? 'short' : 'over'} ${peso(Math.abs(diff))}`);
};
window.cashForm = kind => openSheet(`<h2>${kind === 'in' ? 'Cash in' : 'Expense / cash out'}</h2>
  <label class="f">Amount (₱)<input id="mA" type="number" inputmode="decimal"></label>
  <label class="f">Category<select id="mC">${(kind === 'in' ? ['Capital', 'Other income'] : ['Delivery / courier', 'Shipping / fare', 'Packaging / ribbons / stickers', 'Marketing / boost', 'Ice / styro / rock salt', 'Freezer / equipment', 'Stock purchase', 'Owner withdrawal', 'Other']).map(x => opt(x, x)).join('')}</select></label>
  <label class="f">${kind === 'in' ? 'Received in' : 'Paid from'}<select id="mV">${METHODS.map(x => opt(x, x)).join('')}</select></label>
  <label class="f">Note<input id="mN"></label><button class="btn block" onclick="saveCash('${kind}')">Save</button>`);
window.saveCash = kind => { const a = num($('#mA').value); if (a <= 0) return;
  S.cash.push({ id: uid(), ts: new Date().toISOString(), kind, amount: a, cat: $('#mC').value, via: $('#mV').value, note: $('#mN').value, by: me() }); save(); closeSheet(); render(); };
window.delCash = id => { if (confirm('Delete this entry?')) { S.cash = S.cash.filter(c => c.id !== id); save(); render(); } };

let rp = 'today';
function vReports(v) {
  const m = metrics(period(rp)), byP = {}, bySeller = {}, byPay = {};
  m.sales.forEach(s => { s.items.forEach(l => { const x = byP[l.name] ||= { q: 0, amt: 0 }; x.q += l.qty; x.amt += l.qty * l.price; });
    bySeller[s.seller] = (bySeller[s.seller] || 0) + s.total; byPay[s.pay] = (byPay[s.pay] || 0) + s.total; });
  const tbl = (o, money) => Object.entries(o).sort((a, b) => (money ? b[1] - a[1] : b[1].amt - a[1].amt)).map(([k, x]) => `<tr><td>${esc(k)}</td>${money ? `<td class="r">${peso(x)}</td>` : `<td class="r">${x.q}</td><td class="r">${peso(x.amt)}</td>`}</tr>`).join('');
  v.innerHTML = `<h2>Reports</h2><div class="seg" style="margin-bottom:10px">${[['today', 'Today'], ['week', 'Week'], ['month', 'Month'], ['season', 'Christmas']].map(([k, l]) => `<button class="${rp === k ? 'on' : ''}" onclick="rp='${k}';render()">${l}</button>`).join('')}</div>
  <div class="card"><table class="t"><tr><td>Sales (${m.n} transactions, ${m.pcs} pcs)${m.del ? `<div class="small mut">incl. ${peso(m.del)} delivery fees</div>` : ''}</td><td class="r"><b>${peso(m.rev)}</b></td></tr>
  <tr><td>− Cost of goods (franchise price)</td><td class="r">${peso(m.cogs)}</td></tr><tr><td>= Gross profit</td><td class="r">${peso(m.gross)}</td></tr>
  <tr><td>− Expenses (rider, shipping, packaging…)</td><td class="r">${peso(m.exp)}</td></tr><tr><td>− Losses & giveaways</td><td class="r">${peso(m.loss)}</td></tr>
  <tr><td><b>= Real profit</b></td><td class="r"><b class="${m.net >= 0 ? 'ok' : 'bad'}">${peso(m.net)}</b></td></tr></table></div>
  ${m.n ? `<div class="card"><b>By product</b><table class="t"><tr><th></th><th class="r">Qty</th><th class="r">Sales</th></tr>${tbl(byP)}</table></div>
  <div class="grid2"><div class="card"><b>By seller</b><table class="t">${tbl(bySeller, 1)}</table></div><div class="card"><b>By payment</b><table class="t">${tbl(byPay, 1)}</table></div></div>` : '<div class="empty">No sales in this period.</div>'}
  <button class="btn sec block" onclick="shareText(reportText(rp),'Report')">📤 Share this report</button>`;
}
function reportText(k) {
  const m = metrics(period(k)), s = metrics(period('season')), byP = {};
  m.sales.forEach(x => x.items.forEach(l => byP[l.name] = (byP[l.name] || 0) + l.qty));
  const label = { today: 'Today ' + fmtDate(today()), week: 'This week', month: 'This month', season: 'Christmas season' }[k];
  return `📊 ${S.settings.branch} — ${label}\nSales: ${peso(m.rev)} (${m.pcs} pcs, ${m.n} txns)\nReal profit: ${peso(m.net)}\n` +
    Object.entries(byP).map(([n, q]) => `• ${n}: ${q}`).join('\n') +
    `\nFund on hand: ${peso(fund())}\n🎄 Target: ${s.pcs}/${S.settings.target} pcs\nStock: ` +
    S.products.filter(p => p.kind === 'item' && p.active).map(p => `${p.name.replace('Jar Flan – ', 'Flan ')} ${baseStock(p.id)}`).join(', ') +
    `\nOpen orders: ${S.orders.filter(o => o.status === 'open').length}`;
}
window.reportText = reportText;

/* ---------- SETTINGS ---------- */
function vSettings(v) {
  const s = S.settings;
  v.innerHTML = `<h2>Settings</h2>
  <div class="card"><b>Quick price edit</b>
  ${S.products.map(p => `<div class="it" style="display:block;border-bottom:1px solid var(--line);padding:10px 0">
    <div class="row"><input class="grow" value="${esc(p.name)}" onchange="setP('${p.id}','name',this.value)" style="padding:8px;border:1px solid var(--line);border-radius:9px">
    <label class="small"><input type="checkbox" ${p.active ? 'checked' : ''} onchange="setP('${p.id}','active',this.checked)"> on</label></div>
    <div class="grid2" style="margin-top:6px"><label class="f" style="margin:0">Retail ₱<input type="number" inputmode="decimal" value="${p.price || ''}" onchange="setP('${p.id}','price',num(this.value))"></label>
    <label class="f" style="margin:0">Reseller ₱<input type="number" inputmode="decimal" value="${p.rprice || ''}" placeholder="same as retail" onchange="setP('${p.id}','rprice',num(this.value))"></label></div>
  </div>`).join('')}
  <button class="btn sec block" style="margin-top:10px" onclick="go('stock')">Add / edit products, bundles & stock → Stock tab</button></div>
  <div class="card"><b>Branch & team</b>
  <label class="f">Branch name<input value="${esc(s.branch)}" onchange="setS('branch',this.value)"></label>
  ${window.cloudName && cloudName() ? '<div class="small mut" style="margin-bottom:10px">Team members are managed in More → Team & account.</div>' : `<label class="f">Team members (comma separated)<input value="${esc(s.team.join(', '))}" onchange="setS('team',this.value.split(',').map(x=>x.trim()).filter(Boolean))"></label>`}
  <label class="f">Receipt thank-you message<textarea rows="2" onchange="setS('thanks',this.value)">${esc(s.thanks)}</textarea></label></div>
  <div class="card"><b>Targets & rules</b>
  <div class="grid2"><label class="f">Christmas target (pcs)<input type="number" value="${s.target}" onchange="setS('target',num(this.value))"></label>
  <label class="f">Opening cash (₱)<input type="number" value="${S.openingFund || ''}" onchange="S.openingFund=num(this.value);save()"></label>
  <label class="f">Season start<input type="date" value="${s.seasonStart}" onchange="setS('seasonStart',this.value)"></label>
  <label class="f">Season end<input type="date" value="${s.seasonEnd}" onchange="setS('seasonEnd',this.value)"></label>
  <label class="f">Frozen shelf life (days)<input type="number" value="${s.shelfDays}" onchange="setS('shelfDays',num(this.value))"></label>
  <label class="f">Low-stock alert (pcs)<input type="number" value="${s.lowStock}" onchange="setS('lowStock',num(this.value))"></label>
  <label class="f">Order cutoff day<select onchange="setS('cutoffDay',num(this.value))">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => `<option value="${i}" ${i === s.cutoffDay ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
  <label class="f">Default delivery fee (₱)<input type="number" value="${s.delFee}" onchange="setS('delFee',num(this.value))"></label>
  <label class="f">Min. down payment %<input type="number" value="${s.downPct}" onchange="setS('downPct',num(this.value))"></label></div></div>
  <div class="card"><b>Backup & sharing</b><p class="small mut">Data is saved on this phone only. Back up daily and send the file to the team group chat.</p>
  <div class="row"><button class="btn grow" onclick="exportData()">⬇️ Backup file</button><label class="btn sec grow" style="text-align:center">⬆️ Restore<input type="file" accept=".json,application/json" hidden onchange="importData(this.files[0])"></label></div>
  <button class="btn danger block" style="margin-top:10px" onclick="resetAll()">Erase all data on this phone</button></div>
  <div class="small mut r">Ube POS v2.2</div>`;
}
window.setP = (id, k, val) => { P(id)[k] = val; save(); };
window.setPart = (id, i, pid) => { P(id).parts[i].pid = pid; save(); };
window.setS = (k, val) => { S.settings[k] = val; save(); render(); };
window.exportData = () => {
  const blob = new Blob([JSON.stringify(S, null, 1)], { type: 'application/json' });
  const f = new File([blob], `ube-pos-backup-${today()}.json`, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [f] })) { navigator.share({ files: [f], title: 'Ube POS backup' }).catch(() => {}); return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = f.name; a.click();
};
window.importData = file => { if (!file) return; const r = new FileReader();
  r.onload = () => { try { const d = JSON.parse(r.result); if (!d.v || !d.products) throw 0;
    if (!confirm('Replace ALL data on this phone with this backup?')) return; localStorage.setItem(KEY, JSON.stringify(d)); load(); render(); toast('Backup restored'); } catch (e) { alert('Not a valid Ube POS backup file.'); } };
  r.readAsText(file); };
window.resetAll = () => { if (prompt('Type ERASE to delete everything on this phone') === 'ERASE') { localStorage.removeItem(KEY); load(); render(); } };

/* ---------- boot ---------- */
load();
go('home');
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
