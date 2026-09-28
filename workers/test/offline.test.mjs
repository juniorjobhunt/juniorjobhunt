// Offline tests for the three JJH Workers — mocked Airtable, Resend and KV.
// Run: node workers/test/offline.test.mjs
import customer from '../jjh-customer-form.js';
import tasker from '../jjh-tasker-form.js';
import waitlist from '../jjh-waitlist-form.js';

let pass = 0, failN = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log('  ✓', name); } else { failN++; console.log('  ✗ FAIL:', name); } };

// ── mocks ──
function makeWorld() {
  const w = { tables: { Taskers: [], Customers: [], Matches: [], Waitlist: [] }, emails: [], kv: new Map(),
    resendFail: false, airtableWriteFail: false, patchFail: false, seq: 0, lastTaskerFormula: '' };
  w.env = {
    AT_BASE: 'appTEST', AT_TOKEN: 'x', RESEND_API_KEY: 'y',
    RATE_LIMIT: { get: async k => w.kv.get(k) ?? null, put: async (k, v) => { w.kv.set(k, v); } },
  };
  w.addTasker = (fields, createdTime) => {
    const r = { id: 'recT' + (++w.seq), createdTime: createdTime || new Date(Date.now() - 1e9 + w.seq * 1000).toISOString(), fields };
    w.tables.Taskers.push(r); return r;
  };
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url); const method = opts.method || 'GET';
    const resp = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
    if (u.host === 'api.resend.com') {
      const b = JSON.parse(opts.body); w.emails.push(b);
      return w.resendFail ? resp(500, { message: 'resend down' }) : resp(200, { id: 'em' + w.emails.length });
    }
    const parts = u.pathname.split('/').filter(Boolean); // v0, base, table, [id]
    const table = decodeURIComponent(parts[2]); const id = parts[3];
    if (method === 'GET') {
      const formula = u.searchParams.get('filterByFormula') || '';
      let recs = w.tables[table];
      if (formula.includes('IS_AFTER({Created}')) recs = []; // dedup guard: nothing recent
      else if (table === 'Taskers') {
        w.lastTaskerFormula = formula;
        const city = /\{Neighborhood\/City\}="([^"]*)"/.exec(formula)[1];
        recs = recs.filter(r => r.fields['Neighborhood/City'] === city &&
          (formula.includes('{Status}!="Inactive"') ? r.fields.Status !== 'Inactive' : r.fields.Status === 'New'));
      }
      return resp(200, { records: recs });
    }
    const body = JSON.parse(opts.body);
    if (method === 'POST') {
      if (w.airtableWriteFail) return resp(401, { error: { type: 'AUTHENTICATION_REQUIRED' } });
      const r = { id: 'rec' + table[0] + (++w.seq), createdTime: new Date().toISOString(), fields: { ...body.fields } };
      w.tables[table].push(r);
      if (table === 'Matches') for (const tid of body.fields['Tasker Name']) {
        const t = w.tables.Taskers.find(x => x.id === tid); t.fields.Matches = [...(t.fields.Matches || []), r.id];
      }
      return resp(200, r);
    }
    if (method === 'PATCH') {
      if (w.patchFail) return resp(422, { error: 'bad' });
      const r = w.tables[table].find(x => x.id === id); Object.assign(r.fields, body.fields); return resp(200, r);
    }
    return resp(400, {});
  };
  return w;
}
const req = (payload, { origin = 'https://juniorjobhunt.com', ip = '1.1.1.1', method = 'POST' } = {}) =>
  new Request('https://w.example', { method, headers: { Origin: origin, 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(payload) : undefined });
const cust = (o = {}) => ({ fields: { 'Full Name': 'Casey Customer', 'Email': o.email || 'casey@example.com', 'Phone Number': '5035550101',
  'Neighborhood/City': o.city || 'Wilsonville', 'Task Category': o.cats || ['Yard Work'], 'Task Description': 'Rake leaves',
  'Preferred Date': '2026-10-10', 'Urgency': 'Flexible', 'Consented At': new Date().toISOString() }, ...(o.extra || {}) });
const tsk = (o = {}) => ({ fields: { 'Full Name': 'Terry Tasker', 'Email': o.email || 'terry@example.com', 'Phone Number': '5035550100',
  'Age': 16, 'School Name': 'WHS', 'Neighborhood/City': o.city || 'wilsonville ', 'Skills': ['Yard Work'], 'Availability': ['Weekends'],
  'Consented At': new Date().toISOString() }, ...(o.extra || {}) });
const call = async (worker, w, payload, opts) => { const r = await worker.fetch(req(payload, opts), w.env); return { status: r.status, body: await r.json().catch(() => null) }; };
const pacificToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());

// ── customer: matching rules ──
console.log('Customer Worker — matching');
{
  const w = makeWorld();
  const a = w.addTasker({ 'Full Name': 'A Cleaner', Email: 'a@x.com', 'Neighborhood/City': 'Wilsonville', Skills: ['Cleaning'], Status: 'New' });
  const b = w.addTasker({ 'Full Name': 'B Yard', Email: 'b@x.com', 'Neighborhood/City': 'Wilsonville', Skills: ['Yard Work'], Status: 'Active' });
  const c = w.addTasker({ 'Full Name': 'C Yard', Email: 'c@x.com', 'Neighborhood/City': 'Wilsonville', Skills: ['Yard Work'], Status: 'Matched' });
  w.addTasker({ 'Full Name': 'D Inactive', Email: 'd@x.com', 'Neighborhood/City': 'Wilsonville', Skills: ['Yard Work'], Status: 'Inactive' });
  let r = await call(customer, w, cust({ email: 'c1@example.com' }));
  ok(r.status === 200 && r.body.matched === true, 'match returns matched:true');
  ok(w.lastTaskerFormula.includes('{Status}!="Inactive"'), 'search excludes only Inactive');
  let m = w.tables.Matches.at(-1);
  ok(m.fields['Tasker Name'][0] === b.id, 'skill overlap preferred; oldest of equal-count (B) chosen; Active is eligible');
  r = await call(customer, w, cust({ email: 'c2@example.com' }));
  m = w.tables.Matches.at(-1);
  ok(m.fields['Tasker Name'][0] === c.id, 'fair rotation: 2nd request goes to C (0 matches) not B (1); Matched status still eligible');
  r = await call(customer, w, cust({ email: 'c3@example.com' }));
  m = w.tables.Matches.at(-1);
  ok(m.fields['Tasker Name'][0] === b.id, 'previously matched tasker B is re-eligible (tie → oldest)');
  ok(!w.tables.Matches.some(x => x.fields['Tasker Name'][0] === 'recT4'), 'Inactive tasker never matched');
  ok(!w.tables.Matches.some(x => x.fields['Tasker Name'][0] === a.id), 'non-overlapping skill not chosen while overlap exists');
  const cust1 = w.tables.Customers[0];
  ok(cust1.fields.Status === 'Matched' && b.fields.Status === 'Matched', 'customer + tasker marked Matched');
  ok(cust1.fields['Date Submitted'] === pacificToday && m.fields['Match Date'] === pacificToday, 'dates are Pacific calendar day');
  const admin = w.emails.filter(e => e.to[0] === 'juniorjobhunt@gmail.com');
  ok(admin.length === 3 && admin.every(e => e.from.includes('alerts@juniorjobhunt.com')), 'admin emails go directly to Gmail from alerts@');
  ok(w.emails.filter(e => e.from.includes('outreach@')).length === 6, 'tasker + customer emails still from outreach@');
  ok(!w.tables.Customers.some(x => x.fields['Pipeline Notes']), 'no Pipeline Notes when everything succeeds');
}
{
  const w = makeWorld();
  w.addTasker({ 'Full Name': 'Self', Email: 'same@example.com', 'Neighborhood/City': 'Wilsonville', Skills: ['Yard Work'], Status: 'New' });
  const r = await call(customer, w, cust({ email: 'SAME@example.com' }));
  ok(r.body.matched === false, 'never matches a tasker to their own email');
}
{
  const w = makeWorld();
  w.addTasker({ 'Full Name': 'Only Cleaner', Email: 'o@x.com', 'Neighborhood/City': 'Wilsonville', Skills: ['Cleaning'], Status: 'New' });
  const r = await call(customer, w, cust({ email: 'f@example.com', city: '  WILSONVILLE  ' }));
  ok(r.body.matched === true && w.tables.Matches.length === 1, 'falls back to city-only match; city normalized (caps + spaces)');
}
console.log('Customer Worker — no-match + reliability');
{
  const w = makeWorld();
  const r = await call(customer, w, cust({ city: 'Nowhere' }));
  ok(r.body.matched === false && w.tables.Customers[0].fields.Status === 'No Match', 'no-match → matched:false + Status No Match');
  ok(w.emails.length === 2 && w.emails[0].reply_to === 'casey@example.com', 'no-match: admin alert (reply-to customer) + customer ack');
}
{
  const w = makeWorld(); w.resendFail = true;
  w.addTasker({ 'Full Name': 'T', Email: 't@x.com', 'Neighborhood/City': 'Wilsonville', Skills: ['Yard Work'], Status: 'New' });
  const r = await call(customer, w, cust());
  const c = w.tables.Customers[0];
  ok(r.status === 200 && r.body.matched === true, 'email outage: request still succeeds for the user');
  ok(/Admin match email: 500/.test(c.fields['Pipeline Notes'] || '') && /Customer match email: 500/.test(c.fields['Pipeline Notes']), 'email failures written to Pipeline Notes');
  ok(w.emails.some(e => /JJH alert — Matching pipeline had a problem/.test(e.subject)), 'admin alert attempted on failure');
  const before = w.emails.length;
  await call(customer, w, cust({ email: 'second@example.com' }));
  ok(w.emails.filter(e => /JJH alert/.test(e.subject)).length === 1 && w.emails.length > before, 'alert throttled to 1 per subject per hour');
}
{
  const w = makeWorld(); w.patchFail = true;
  w.addTasker({ 'Full Name': 'T', Email: 't@x.com', 'Neighborhood/City': 'Wilsonville', Skills: ['Yard Work'], Status: 'New' });
  await call(customer, w, cust());
  ok(w.emails.some(e => /JJH alert/.test(e.subject) && /status/.test(e.html)), 'status-update failure triggers alert');
}
{
  const w = makeWorld(); w.airtableWriteFail = true;
  const r = await call(customer, w, cust());
  ok(r.status === 500 && w.emails.some(e => /could not save a request/.test(e.subject)), 'Airtable save failure → 500 + admin alert');
}
console.log('Customer Worker — guards');
{
  const w = makeWorld();
  let r = await call(customer, w, cust({ extra: { website: 'http://spam' } }));
  ok(r.body.success === true && w.tables.Customers.length === 0, 'honeypot → fake success, nothing written');
  r = await call(customer, w, { fields: { 'Full Name': 'x' } });
  ok(r.status === 400, 'validation rejects bad payload');
  r = await customer.fetch(req(null, { method: 'GET' }), w.env);
  ok(r.status === 405, 'GET → 405');
  for (let i = 0; i < 3; i++) await call(customer, w, cust({ email: 'rl@example.com', city: 'Nowhere' }), { ip: '9.9.9.' + i });
  r = await call(customer, w, cust({ email: 'rl@example.com', city: 'Nowhere' }), { ip: '9.9.9.99' });
  ok(r.status === 429, 'per-email limit: 4th submission from same email blocked');
  const w2 = makeWorld(); let last;
  for (let i = 0; i < 31; i++) last = await call(customer, w2, cust({ email: `s${i}@example.com`, city: 'Nowhere' }), { ip: '5.5.5.5' });
  ok(w2.tables.Customers.length === 30 && last.status === 429, 'per-IP limit: 30 different students on one IP succeed, 31st blocked');
  r = await call(customer, w, cust({ email: 'inj@example.com', city: 'Wilsonville") , TRUE()' }));
  ok(!w.lastTaskerFormula.includes('"),') , 'formula injection characters stripped from city');
}

console.log('Tasker Worker');
{
  const w = makeWorld();
  let r = await call(tasker, w, tsk());
  ok(r.status === 200 && JSON.stringify(r.body) === '{"success":true}', 'returns only {success:true} (no record echo)');
  const t = w.tables.Taskers[0];
  ok(t.fields['Neighborhood/City'] === 'Wilsonville', 'city trimmed + title-cased');
  ok(t.fields.Status === 'New' && t.fields['Date Submitted'] === pacificToday, 'Status New + Pacific date');
  r = await call(tasker, w, tsk({ extra: { address: '123 Main St' } }));
  ok(r.body.success === true && w.tables.Taskers.length === 1, 'honeypot → fake success');
  r = await call(tasker, w, tsk({ extra: {} , email: 'x' }));
  ok(r.status === 400, 'validation rejects bad email');
  const w2 = makeWorld(); w2.airtableWriteFail = true;
  r = await call(tasker, w2, tsk());
  ok(r.status === 500 && w2.emails.length === 1 && w2.emails[0].to[0] === 'juniorjobhunt@gmail.com', 'Airtable failure → 500 + alert to Gmail');
  await call(tasker, w2, tsk({ email: 'b@example.com' }));
  ok(w2.emails.length === 1, 'tasker alert throttled');
  const w3 = makeWorld();
  for (let i = 0; i < 4; i++) r = await call(tasker, w3, tsk({ email: 'same@example.com' }), { ip: '7.7.7.' + i });
  ok(r.status === 429 && w3.tables.Taskers.length === 3, 'per-email limit 3/day');
}

console.log('Waitlist Worker');
{
  const w = makeWorld();
  const wl = (e, extra = {}) => ({ fullName: 'Wendy W', email: e, phone: '5035550102', city: '  san   diego ', consentedAt: new Date().toISOString(), ...extra });
  let r = await call(waitlist, w, wl('w@example.com'));
  ok(r.body.success === true && w.tables.Waitlist[0].fields.City === 'San Diego', 'writes signup; city whitespace collapsed');
  r = await call(waitlist, w, wl('h@example.com', { website: 'x' }));
  ok(w.tables.Waitlist.length === 1, 'honeypot');
  for (let i = 0; i < 4; i++) r = await call(waitlist, w, wl('rep@example.com'), { ip: '8.8.8.' + i });
  ok(r.status === 429 && w.tables.Waitlist.filter(x => x.fields.Email === 'rep@example.com').length === 3, 'per-email limit 3/day');
  const w2 = makeWorld(); w2.airtableWriteFail = true;
  r = await call(waitlist, w2, wl('z@example.com'));
  ok(r.status === 500 && w2.emails.length === 1, 'Airtable failure → 500 + alert');
}

console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
