/* Ube POS — downloadable PDF report (daily or weekly). Libraries load only when a PDF is made. */
(() => {
  const loadJs = src => new Promise((ok, bad) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => bad(new Error('Could not load ' + src)); document.head.appendChild(s); });
  let libs;
  const ensureLibs = () => libs ||= loadJs('vendor/jspdf.umd.min.js').then(() => loadJs('vendor/jspdf.plugin.autotable.min.js')).catch(e => { libs = null; throw e; });

  // the built-in PDF fonts only cover Latin-1, so swap symbols and drop emoji
  const T = x => String(x ?? '').replace(/₱/g, 'P').replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/×/g, 'x').replace(/…/g, '...').replace(/[^\x20-\xff]/g, '').trim();
  const money = n => 'P ' + (Math.round(num(n) * 100) / 100).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const longDate = d => new Date(d + 'T00:00').toLocaleDateString('en-PH', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const time = ts => new Date(ts).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });
  const dayOf = ts => localDay(ts);

  // range for a day, or the Monday–Sunday week that contains the day
  window.pdfRange = (kind, day) => {
    if (kind === 'day') return [day, day];
    const dow = (new Date(day + 'T00:00').getDay() + 6) % 7, a = addDays(day, -dow);
    return [a, addDays(a, 6)];
  };

  window.makePdf = async (kind, day) => {
    await ensureLibs();
    const [a, b] = pdfRange(kind, day), m = metrics([a, b]), s = S.settings;
    const doc = new window.jspdf.jsPDF({ unit: 'pt', format: 'a4' }), W = doc.internal.pageSize.getWidth(), L = 40;
    const purple = [91, 42, 134], head = { fillColor: purple, textColor: 255, fontStyle: 'bold' };
    const table = (title, columns, body, opts = {}) => {
      let y = (doc.lastAutoTable?.finalY ?? 120) + 22;
      if (y > doc.internal.pageSize.getHeight() - 90) { doc.addPage(); y = 50; }
      doc.setFont('helvetica', 'bold').setFontSize(12).setTextColor(...purple).text(T(title), L, y);
      doc.autoTable({ startY: y + 6, margin: { left: L, right: L }, head: [columns.map(T)], body: body.length ? body.map(r => r.map(T)) : [[{ content: 'None', colSpan: columns.length, styles: { textColor: 140 } }]],
        headStyles: head, styles: { fontSize: 9, cellPadding: 4 }, alternateRowStyles: { fillColor: [246, 241, 251] }, ...opts,
        didParseCell: d => { if (d.section === 'head' && opts.columnStyles?.[d.column.index]?.halign) d.cell.styles.halign = opts.columnStyles[d.column.index].halign; opts.didParseCell?.(d); } });
    };
    const right = n => ({ halign: 'right' }), rcols = (...i) => ({ columnStyles: Object.fromEntries(i.map(k => [k, right()])) });

    // header
    doc.setFillColor(...purple).rect(0, 0, W, 86, 'F');
    doc.setTextColor(255).setFont('helvetica', 'bold').setFontSize(18).text(T(s.branch || 'Ube POS'), L, 36);
    doc.setFontSize(12).setFont('helvetica', 'normal').text(kind === 'day' ? 'Daily report - ' + longDate(a) : `Weekly report - ${longDate(a)} to ${longDate(b)}`, L, 56);
    doc.setFontSize(9).text(T(`Made ${new Date().toLocaleString('en-PH')} by ${me()}`), L, 72);

    // summary
    table('Summary', ['', 'Amount'], [
      [`Sales (${m.n} transactions, ${m.pcs} pcs)`, money(m.rev)],
      ['   incl. delivery fees', money(m.del)],
      ['- Cost of goods', money(m.cogs)],
      ['= Gross profit', money(m.gross)],
      ['- Expenses', money(m.exp)],
      ['- Losses & giveaways', money(m.loss)],
      ['= REAL PROFIT', money(m.net)]
    ], { startY: 110, ...rcols(1), didParseCell: d => { if (d.section === 'body' && d.row.index === 6) { d.cell.styles.fontStyle = 'bold'; d.cell.styles.fillColor = [232, 220, 245]; } } });

    // per-day breakdown for weekly
    if (kind === 'week') {
      const rows = [];
      for (let d = a; d <= b; d = addDays(d, 1)) { const x = metrics([d, d]); rows.push([longDate(d), x.n, x.pcs, money(x.rev), money(x.net)]); }
      table('Day by day', ['Day', 'Txns', 'Pcs', 'Sales', 'Real profit'], rows, rcols(1, 2, 3, 4));
    }

    // groupings
    const byP = {}, bySeller = {}, byPay = {};
    m.sales.forEach(x => { x.items.forEach(l => { const r = byP[l.name] ||= { q: 0, amt: 0 }; r.q += l.qty; r.amt += l.qty * l.price; });
      const sl = bySeller[x.seller || '-'] ||= { n: 0, amt: 0 }; sl.n++; sl.amt += x.total;
      const py = byPay[x.pay || '-'] ||= { n: 0, amt: 0 }; py.n++; py.amt += x.total; });
    const sorted = o => Object.entries(o).sort((p, q) => q[1].amt - p[1].amt);
    table('By product', ['Product', 'Qty', 'Sales'], sorted(byP).map(([k, x]) => [k, x.q, money(x.amt)]), rcols(1, 2));
    table('By seller', ['Seller', 'Txns', 'Sales'], sorted(bySeller).map(([k, x]) => [k, x.n, money(x.amt)]), rcols(1, 2));
    table('By payment', ['Payment', 'Txns', 'Amount'], sorted(byPay).map(([k, x]) => [k, x.n, money(x.amt)]), rcols(1, 2));

    // every sale
    table('All sales', [kind === 'day' ? 'Time' : 'Date / time', 'Seller', 'Customer', 'Items', 'Pay', 'Total'],
      m.sales.slice().sort((p, q) => p.ts < q.ts ? -1 : 1).map(x => [
        (kind === 'day' ? '' : dayOf(x.ts).slice(5) + ' ') + time(x.ts), x.seller, x.custName,
        x.items.map(l => `${l.qty} x ${l.name}`).join(', ') + (x.delFee ? ` + delivery ${money(x.delFee)}` : '') + (x.discount ? ` - disc ${money(x.discount)}` : ''),
        x.pay, money(x.total)]),
      { columnStyles: { 3: { cellWidth: 170 }, 5: right() } });

    // money out and losses
    const outs = S.cash.filter(c => c.kind === 'out' && inP(c.ts, [a, b]));
    table('Money out (expenses, stock purchases, refunds)', ['Date', 'Category', 'Note', 'By', 'Amount'],
      outs.map(c => [dayOf(c.ts).slice(5) + ' ' + time(c.ts), c.cat, c.note || '', c.by || '', money(c.amount)]), rcols(4));
    const losses = S.losses.filter(l => inP(l.ts, [a, b]));
    table('Losses & giveaways', ['Date', 'Product', 'Qty', 'Reason', 'Cost'],
      losses.map(l => [dayOf(l.ts).slice(5), P(l.pid)?.name || l.pid, l.qty, l.reason || '', money(l.qty * l.cost)]), rcols(2, 4));

    // stock now
    table('Stock on hand (when this PDF was made)', ['Product', 'Pcs'],
      S.products.filter(p => p.kind === 'item' && p.active).map(p => [p.name, baseStock(p.id)]), rcols(1));
    const open = S.orders.filter(o => o.status === 'open');
    let y = doc.lastAutoTable.finalY + 20;
    if (y > doc.internal.pageSize.getHeight() - 60) { doc.addPage(); y = 50; }
    doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(40)
      .text(T(`Cash / fund on hand now: ${money(fund())}     Open pre-orders: ${open.length}`), L, y);

    // page numbers
    const n = doc.getNumberOfPages();
    for (let i = 1; i <= n; i++) { doc.setPage(i); doc.setFontSize(8).setTextColor(150).text(`Ube POS  -  page ${i} of ${n}`, W - L, doc.internal.pageSize.getHeight() - 20, { align: 'right' }); }

    const name = `${T(s.branch || 'Ube POS').replace(/[^\w-]+/g, '-')}_${kind === 'day' ? 'daily_' + a : 'weekly_' + a + '_to_' + b}.pdf`;
    doc.save(name);
    return name;
  };

  window.pdfBtn = async btn => {
    const kind = document.querySelector('#pdfKind .on')?.dataset.k || 'day', day = document.querySelector('#pdfDay').value || today();
    const old = btn.textContent; btn.disabled = true; btn.textContent = 'Making PDF…';
    try { const f = await makePdf(kind, day); toast('Downloaded ' + f); }
    catch (e) { console.error(e); alert('Could not make the PDF: ' + e.message + (navigator.onLine ? '' : '\nConnect to the internet once so the PDF tool can download, then try again.')); }
    finally { btn.disabled = false; btn.textContent = old; }
  };
})();
