// שכבת שמירת נתונים: PostgreSQL ב-Render, או קובץ JSON להרצה מקומית
const fs = require('fs');
const path = require('path');

function makePgStore(url) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: url,
    ssl: /render\.com|neon\.tech|supabase/.test(url) ? { rejectUnauthorized: false } : false,
  });

  return {
    kind: 'postgres',
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS attendees (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        phone TEXT NOT NULL DEFAULT '',
        tickets INT NOT NULL DEFAULT 1,
        received INT NOT NULL DEFAULT 0,
        last_by TEXT NOT NULL DEFAULT '',
        last_at TIMESTAMPTZ
      )`);
    },
    async list() {
      const r = await pool.query('SELECT * FROM attendees ORDER BY id');
      return r.rows;
    },
    async replaceAll(rows) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('TRUNCATE attendees RESTART IDENTITY');
        if (rows.length) {
          await client.query(
            `INSERT INTO attendees (name, phone, tickets)
             SELECT * FROM unnest($1::text[], $2::text[], $3::int[])`,
            [rows.map(r => r.name), rows.map(r => r.phone), rows.map(r => r.tickets)]
          );
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    // הסימון אטומי: מצליח רק אם לא עוברים את כמות הכרטיסים – גם אם שתי מחלקות לוחצות באותה שנייה
    async mark(id, qty, by) {
      const r = await pool.query(
        `UPDATE attendees SET received = received + $2, last_by = $3, last_at = now()
         WHERE id = $1 AND received + $2 <= tickets RETURNING *`,
        [id, qty, by]
      );
      if (r.rows[0]) return { ok: true, row: r.rows[0] };
      const cur = await pool.query('SELECT * FROM attendees WHERE id = $1', [id]);
      return { ok: false, row: cur.rows[0] || null };
    },
    async unmark(id, by) {
      const r = await pool.query(
        `UPDATE attendees SET received = received - 1, last_by = $2, last_at = now()
         WHERE id = $1 AND received > 0 RETURNING *`,
        [id, by]
      );
      if (r.rows[0]) return { ok: true, row: r.rows[0] };
      const cur = await pool.query('SELECT * FROM attendees WHERE id = $1', [id]);
      return { ok: false, row: cur.rows[0] || null };
    },
    async resetMarks() {
      await pool.query(`UPDATE attendees SET received = 0, last_by = '', last_at = NULL`);
    },
  };
}

function makeFileStore(file) {
  let data = { nextId: 1, rows: [] };
  const save = () => fs.writeFileSync(file, JSON.stringify(data));
  const copy = r => (r ? { ...r } : null);
  return {
    kind: 'file',
    async init() {
      try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { save(); }
    },
    async list() { return data.rows.map(copy); },
    async replaceAll(rows) {
      data = { nextId: 1, rows: [] };
      for (const r of rows) {
        data.rows.push({ id: data.nextId++, name: r.name, phone: r.phone, tickets: r.tickets, received: 0, last_by: '', last_at: null });
      }
      save();
    },
    async mark(id, qty, by) {
      const row = data.rows.find(r => r.id === id);
      if (!row || row.received + qty > row.tickets) return { ok: false, row: copy(row) };
      row.received += qty; row.last_by = by; row.last_at = new Date().toISOString();
      save();
      return { ok: true, row: copy(row) };
    },
    async unmark(id, by) {
      const row = data.rows.find(r => r.id === id);
      if (!row || row.received <= 0) return { ok: false, row: copy(row) };
      row.received -= 1; row.last_by = by; row.last_at = new Date().toISOString();
      save();
      return { ok: true, row: copy(row) };
    },
    async resetMarks() {
      data.rows.forEach(r => { r.received = 0; r.last_by = ''; r.last_at = null; });
      save();
    },
  };
}

module.exports = process.env.DATABASE_URL
  ? makePgStore(process.env.DATABASE_URL)
  : makeFileStore(path.join(process.env.DATA_DIR || __dirname, 'data.json'));
