const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const path = require('path');
const store = require('./store');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'pink2026';
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const wrap = fn => (req, res) => fn(req, res).catch(err => {
  console.error(err);
  res.status(500).json({ error: 'שגיאה בשרת, נסי שוב' });
});

function requireAdmin(req, res, next) {
  const pw = req.get('x-admin-password') || req.query.pw;
  if (pw !== ADMIN_PASSWORD) return res.status(401).json({ error: 'סיסמת מנהלת שגויה' });
  next();
}

const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();

// קריאת האקסל וזיהוי אוטומטי של העמודות
function parseWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
  if (!rows.length) throw new Error('הקובץ ריק');

  const isTickets = h => /כמות|כרטיס|ערכ|מספר משתתפות|מס' משתתפות|משתתפות/.test(h);
  const isPhone = h => /טלפון|נייד|פלאפון|סלולרי/.test(h);
  const isName = h => /שם/.test(h);

  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    if (rows[i].some(c => isName(clean(c)) && !isTickets(clean(c)))) { headerIdx = i; break; }
  }

  let nameCols = [], ticketsCol = -1, phoneCol = -1, headers = [];
  if (headerIdx >= 0) {
    headers = rows[headerIdx].map(clean);
    headers.forEach((h, i) => {
      if (ticketsCol < 0 && isTickets(h)) ticketsCol = i;
      else if (phoneCol < 0 && isPhone(h)) phoneCol = i;
    });
    const first = headers.findIndex((h, i) => /שם פרטי/.test(h) && i !== ticketsCol);
    const last = headers.findIndex((h, i) => /שם משפחה/.test(h) && i !== ticketsCol);
    if (first >= 0 && last >= 0) nameCols = [first, last];
    else {
      const full = headers.findIndex((h, i) => /שם מלא/.test(h) && i !== ticketsCol && i !== phoneCol);
      const any = headers.findIndex((h, i) => isName(h) && i !== ticketsCol && i !== phoneCol);
      nameCols = [full >= 0 ? full : any];
    }
  } else {
    // אין כותרות – עמודה ראשונה שם, שנייה כמות
    nameCols = [0];
    ticketsCol = 1;
    headerIdx = -1;
  }

  const list = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const name = clean(nameCols.map(c => r[c]).filter(Boolean).join(' '));
    if (!name) continue;
    let tickets = parseInt(String(r[ticketsCol] ?? '').replace(/[^\d]/g, ''), 10);
    if (!Number.isFinite(tickets) || tickets < 1) tickets = 1;
    if (tickets > 50) tickets = 50;
    const phone = phoneCol >= 0 ? clean(r[phoneCol]) : '';
    list.push({ name, phone, tickets });
  }
  if (!list.length) throw new Error('לא נמצאו שמות בקובץ. ודאי שיש עמודה עם הכותרת "שם"');

  return {
    list,
    columns: {
      name: headerIdx >= 0 ? nameCols.map(c => headers[c]).join(' + ') : 'עמודה ראשונה',
      tickets: ticketsCol >= 0 ? (headers[ticketsCol] || 'עמודה שנייה') : 'לא נמצאה – כל אחת 1',
      phone: phoneCol >= 0 ? headers[phoneCol] : 'לא נמצאה',
    },
  };
}

const volunteerName = req => clean(req.body && req.body.by).slice(0, 40);

app.get('/api/attendees', wrap(async (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.json(await store.list());
}));

app.post('/api/attendees/:id/mark', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const qty = Math.max(1, Math.min(50, parseInt(req.body.qty, 10) || 1));
  const result = await store.mark(id, qty, volunteerName(req));
  if (!result.row) return res.status(404).json({ error: 'השם לא נמצא ברשימה (אולי הרשימה הוחלפה)' });
  res.status(result.ok ? 200 : 409).json(result);
}));

app.post('/api/attendees/:id/unmark', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const result = await store.unmark(id, volunteerName(req));
  if (!result.row) return res.status(404).json({ error: 'השם לא נמצא ברשימה' });
  res.status(result.ok ? 200 : 409).json(result);
}));

app.post('/api/admin/check', requireAdmin, (req, res) => res.json({ ok: true }));

app.post('/api/admin/upload', requireAdmin, upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'לא נבחר קובץ' });
  let parsed;
  try { parsed = parseWorkbook(req.file.buffer); }
  catch (e) { return res.status(400).json({ error: e.message || 'לא הצלחתי לקרוא את הקובץ' }); }
  await store.replaceAll(parsed.list);
  res.json({ count: parsed.list.length, tickets: parsed.list.reduce((s, r) => s + r.tickets, 0), columns: parsed.columns });
}));

app.post('/api/admin/reset', requireAdmin, wrap(async (req, res) => {
  await store.resetMarks();
  res.json({ ok: true });
}));

app.get('/api/admin/export', requireAdmin, wrap(async (req, res) => {
  const rows = await store.list();
  const fmt = d => d ? new Date(d).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' }) : '';
  const data = rows.map(r => ({
    'שם': r.name,
    'טלפון': r.phone,
    'כמות כרטיסים': r.tickets,
    'ערכות שנמסרו': r.received,
    'סטטוס': r.received >= r.tickets ? 'קיבלה הכול' : r.received > 0 ? 'קיבלה חלקית' : 'טרם קיבלה',
    'סומן ע"י': r.last_by,
    'עדכון אחרון': fmt(r.last_at),
  }));
  const ws = XLSX.utils.json_to_sheet(data);
  ws['!cols'] = [{ wch: 24 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 20 }];
  const wb = XLSX.utils.book_new();
  wb.Workbook = { Views: [{ RTL: true }] };
  XLSX.utils.book_append_sheet(wb, ws, 'חלוקת ערכות');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('ירושלים בורוד - חלוקת ערכות.xlsx')}`);
  res.send(buf);
}));

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

store.init().then(() => {
  app.listen(PORT, () => console.log(`ירושלים בורוד פועל על פורט ${PORT} (אחסון: ${store.kind})`));
}).catch(err => {
  console.error('לא הצלחתי להתחבר למסד הנתונים', err);
  process.exit(1);
});
