// jjh-customer-form — writes a Customer request to Airtable, matches a Tasker
// in the same city, sends 3 Resend emails, marks both records "Matched", and
// logs a Matches row. No-match path emails admin + customer.
//
// Hardened: origin-locked CORS, method + body-size guards, KV rate limiting
// (per IP and per email), honeypot, strict validation, server-built field
// allowlist, HTML-escaped email bodies, formula-injection-safe queries.
//
// Matching rules (Sept 27, 2026):
//   • Eligible Taskers = same city AND Status is not "Inactive". A Tasker stays
//     eligible after being matched — set Status to "Inactive" to remove someone.
//   • A Tasker is never matched to their own email.
//   • Prefer Taskers whose Skills overlap the Task Category; among those, pick the
//     one with the FEWEST matches so far (fair rotation), oldest signup on ties.
//
// Reliability (Sept 27, 2026): every Resend send and Airtable write is checked.
// Any failure is logged, written to the customer's "Pipeline Notes" field, and
// sent to the admin inbox as an alert. Admin mail goes DIRECTLY to Gmail (the
// outreach@ → Gmail forwarding proved unreliable).

const ALLOWED_ORIGINS = ['https://juniorjobhunt.com', 'https://www.juniorjobhunt.com'];
const MAX_BODY_BYTES = 20000;
const RL_IP_MAX = 30;        // submissions per IP per day (schools share one IP)
const RL_EMAIL_MAX = 3;      // submissions per email per day
const RL_TTL = 86400;
const TZ = 'America/Los_Angeles';
const FROM_PUBLIC = 'JuniorJobHunt <outreach@juniorjobhunt.com>';
const FROM_ALERTS = 'JJH Alerts <alerts@juniorjobhunt.com>';
const ADMIN_TO = 'juniorjobhunt@gmail.com';
const WORKER = 'jjh-customer-form';

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
    const cors = {
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
      status, headers: { ...cors, 'Content-Type': 'application/json' },
    });
    const fail = (msg, status = 400) => json({ error: { message: msg } }, status);

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'POST') return fail('Method not allowed.', 405);

    const declared = parseInt(request.headers.get('Content-Length') || '0', 10);
    if (declared && declared > MAX_BODY_BYTES) return fail('Request too large.', 413);
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return fail('Request too large.', 413);

    // Rate limit per IP — protects the Resend quota + Airtable.
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const day = utcDay();
    if (!(await rateOk(env, `rlc:${ip}:${day}`, RL_IP_MAX))) {
      return fail('Too many submissions. Please try again tomorrow.', 429);
    }

    let body;
    try { body = JSON.parse(raw); } catch { return fail('Invalid request body.'); }
    const f = (body && body.fields) || {};

    if (body.website || body.address) return json({ success: true }); // honeypot

    // Validate
    const name  = str(f['Full Name']);
    const email = str(f['Email']).toLowerCase();
    const phone = str(f['Phone Number']);
    const city  = normCity(f['Neighborhood/City']);
    const cats  = strArray(f['Task Category']);
    const desc  = str(f['Task Description']);
    const urgency = str(f['Urgency']);

    const errors = [];
    if (name.length < 2 || name.length > 100) errors.push('Please enter your full name.');
    if (!isEmail(email)) errors.push('Please enter a valid email address.');
    if (digits(phone).length < 10) errors.push('Please enter a valid phone number.');
    if (city.length < 2) errors.push('Please enter your city.');
    if (!cats.length) errors.push('Please select at least one task type.');
    if (desc.length < 1) errors.push('Please describe your task.');
    if (errors.length) return fail(errors.join(' '));

    // Rate limit per email
    if (!(await rateOk(env, `rlce:${email}:${day}`, RL_EMAIL_MAX))) {
      return fail('Too many submissions. Please try again tomorrow.', 429);
    }

    // Allowlisted record — client cannot inject fields or a privileged Status.
    const fields = {
      'Full Name': name,
      'Email': email,
      'Phone Number': phone.slice(0, 40),
      'Neighborhood/City': city,
      'Task Category': cats,
      'Task Description': desc.slice(0, 5000),
      'Preferred Date': isDate(f['Preferred Date']) ? str(f['Preferred Date']) : '',
      'Urgency': urgency.slice(0, 60),
      'Status': 'New',
      'Date Submitted': localDay(),
      'Consented At': isoOrEmpty(f['Consented At']),
    };

    // 0. Duplicate guard — same email in the last 2 minutes
    const since = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const dupFormula = encodeURIComponent(`AND(LOWER({Email})="${atSafe(email)}", IS_AFTER({Created}, "${since}"))`);
    const dupRes = await at(env, `Customers?filterByFormula=${dupFormula}&maxRecords=1`);
    const dupData = await dupRes.json().catch(() => ({}));
    if (dupRes.ok && dupData.records && dupData.records.length) {
      return json({ success: true, duplicate: true });
    }

    // 1. Write customer
    const atRes = await at(env, 'Customers', { method: 'POST', body: { fields } });
    const customer = await atRes.json().catch(() => ({}));
    if (!atRes.ok) {
      const detail = `Airtable ${atRes.status}: ${JSON.stringify(customer).slice(0, 500)}`;
      console.error('Customer write failed:', detail);
      await alertAdmin(env, 'Customer form could not save a request',
        `A customer submission failed to save — the customer saw an error. ${detail}`,
        { name, email, city, task: cats.join(', ') });
      return fail('Something went wrong. Please try again.', 500);
    }

    const customerId = customer.id;
    const cf = customer.fields;
    const cityVal = cf['Neighborhood/City'];
    const problems = [];
    const note = (step, res, extra = '') => { if (!res || !res.ok) problems.push(`${step}: ${res ? res.status : 'no response'}${extra}`); };

    // 2. Find eligible taskers in the same city
    const formula = encodeURIComponent(`AND({Neighborhood/City}="${atSafe(cityVal)}",{Status}!="Inactive")`);
    const taskerRes = await at(env, `Taskers?filterByFormula=${formula}&maxRecords=100`);
    const taskerData = await taskerRes.json().catch(() => ({}));
    if (!taskerRes.ok) note('Tasker search', taskerRes, ` ${JSON.stringify(taskerData).slice(0, 300)}`);
    const taskers = (taskerData.records || [])
      .filter(t => str(t.fields['Email']).toLowerCase() !== email);

    const fmt = val => esc(Array.isArray(val) ? val.join(', ') : (val == null || val === '' ? 'N/A' : String(val)));
    const cityH = esc(cityVal);
    const customerBlock = `
      <p><strong>Name:</strong> ${fmt(cf['Full Name'])}</p>
      <p><strong>Email:</strong> ${fmt(cf['Email'])}</p>
      <p><strong>Phone:</strong> ${fmt(cf['Phone Number'])}</p>
      <p><strong>City:</strong> ${cityH}</p>
      <p><strong>Task:</strong> ${fmt(cf['Task Category'])}</p>
      <p><strong>Description:</strong> ${fmt(cf['Task Description'])}</p>
      <p><strong>Preferred Date:</strong> ${fmt(cf['Preferred Date'])}</p>
      <p><strong>Urgency:</strong> ${fmt(cf['Urgency'])}</p>`;

    if (taskers.length === 0) {
      note('Admin no-match email', await sendEmail(env, {
        from: FROM_ALERTS, to: ADMIN_TO, replyTo: cf['Email'],
        subject: `⚠️ No Tasker Found — ${cf['Full Name']} (${cityVal})`,
        html: `
          <h2>No Tasker Available in ${cityH}</h2>
          <p>A customer submitted a request but no eligible tasker was found in <strong>${cityH}</strong>. Follow up manually or recruit taskers in this area.</p>
          <h3>Customer Details</h3>${customerBlock}`,
      }));

      note('Customer acknowledgment email', await sendEmail(env, {
        from: FROM_PUBLIC, to: cf['Email'],
        subject: 'We got your request — JuniorJobHunt',
        html: `
          <h2>Thanks for your request!</h2>
          <p>We don't have an available tasker in <strong>${cityH}</strong> just yet, but we're on it — we'll reach out as soon as we find someone who can help with your task.</p>
          <p><strong>Your request:</strong> ${fmt(cf['Task Category'])}</p>
          <p>Questions? Just reply to this email.</p>
          <p>— The JuniorJobHunt Team</p>`,
      }));

      note('Customer status → No Match', await updateRecord(env, 'Customers', customerId, { 'Status': 'No Match' }));
      await reportProblems(env, customerId, cf, problems);
      return json({ success: true, matched: false });
    }

    const tasker = pickTasker(taskers, Array.isArray(cf['Task Category']) ? cf['Task Category'] : [cf['Task Category']]);
    const taskerId = tasker.id;
    const tf = tasker.fields;

    // 3. Emails
    note('Admin match email', await sendEmail(env, {
      from: FROM_ALERTS, to: ADMIN_TO,
      subject: `✅ New Match — ${cf['Full Name']} ↔ ${tf['Full Name']} (${cityVal})`,
      html: `
        <h2>A new match was made!</h2>
        <h3>Customer</h3>${customerBlock}
        <h3>Matched Tasker</h3>
        <p><strong>Name:</strong> ${fmt(tf['Full Name'])}</p>
        <p><strong>Email:</strong> ${fmt(tf['Email'])}</p>
        <p><strong>Phone:</strong> ${fmt(tf['Phone Number'])}</p>
        <p><strong>Age:</strong> ${fmt(tf['Age'])}</p>
        <p><strong>Skills:</strong> ${fmt(tf['Skills'])}</p>
        <p><strong>Availability:</strong> ${fmt(tf['Availability'])}</p>
        <p><strong>Matches before this one:</strong> ${matchCount(tasker)}</p>`,
    }));

    if (isEmail(str(tf['Email']).toLowerCase())) {
      note('Tasker match email', await sendEmail(env, {
        from: FROM_PUBLIC, to: tf['Email'],
        subject: "You've been matched with a customer! — JuniorJobHunt",
        html: `
          <p>Hi ${fmt(tf['Full Name'])},</p>
          <p>Great news — you've been matched with a customer in <strong>${cityH}</strong> who needs help with a task!</p>
          <h3>Task Details</h3>
          <p><strong>Task:</strong> ${fmt(cf['Task Category'])}</p>
          <p><strong>Description:</strong> ${fmt(cf['Task Description'])}</p>
          <p><strong>Preferred Date:</strong> ${fmt(cf['Preferred Date'])}</p>
          <p><strong>Urgency:</strong> ${fmt(cf['Urgency'])}</p>
          <h3>Customer Contact</h3>
          <p><strong>Name:</strong> ${fmt(cf['Full Name'])}</p>
          <p><strong>Email:</strong> ${fmt(cf['Email'])}</p>
          <p><strong>Phone:</strong> ${fmt(cf['Phone Number'])}</p>
          <p>Please reach out to them directly to arrange the details. Good luck!</p>
          <br><p>— The JuniorJobHunt Team</p>`,
      }));
    } else {
      problems.push(`Tasker ${taskerId} has no valid email — tasker was not notified`);
    }

    note('Customer match email', await sendEmail(env, {
      from: FROM_PUBLIC, to: cf['Email'],
      subject: 'We found a tasker for you! — JuniorJobHunt',
      html: `
        <p>Hi ${fmt(cf['Full Name'])},</p>
        <p>Great news — we found a tasker in <strong>${cityH}</strong> who can help you!</p>
        <h3>Your Tasker</h3>
        <p><strong>Name:</strong> ${fmt(tf['Full Name'])}</p>
        <p><strong>Email:</strong> ${fmt(tf['Email'])}</p>
        <p><strong>Phone:</strong> ${fmt(tf['Phone Number'])}</p>
        <p>They'll be in touch soon, or feel free to reach out to them directly.</p>
        <p>Thank you for using JuniorJobHunt!</p>
        <br><p>— The JuniorJobHunt Team</p>`,
    }));

    // 4. Mark both "Matched" (Tasker stays eligible for future matches)
    const [u1, u2] = await Promise.all([
      updateRecord(env, 'Customers', customerId, { 'Status': 'Matched' }),
      updateRecord(env, 'Taskers', taskerId, { 'Status': 'Matched' }),
    ]);
    note('Customer status → Matched', u1);
    note('Tasker status → Matched', u2);

    // 5. Log to Matches
    let mRes;
    try {
      mRes = await at(env, 'Matches', { method: 'POST', body: {
        typecast: true,
        fields: {
          'Customer Name': [customerId],
          'Tasker Name': [taskerId],
          'Task Category': Array.isArray(cf['Task Category']) ? cf['Task Category'] : [cf['Task Category']],
          'Match Date': localDay(),
          'Status': 'Pending',
        },
      }});
    } catch (e) { mRes = null; }
    note('Matches log row', mRes);

    await reportProblems(env, customerId, cf, problems);
    return json({ success: true, matched: true });
  },
};

// ── matching ──
function matchCount(t) { return Array.isArray(t.fields['Matches']) ? t.fields['Matches'].length : 0; }
function pickTasker(taskers, wantedCats) {
  const overlap = taskers.filter(t => {
    const skills = t.fields['Skills'] || [];
    return Array.isArray(skills) && skills.some(s => wantedCats.includes(s));
  });
  const pool = overlap.length ? overlap : taskers;
  return pool.slice().sort((a, b) =>
    (matchCount(a) - matchCount(b)) ||
    (Date.parse(a.createdTime || 0) - Date.parse(b.createdTime || 0)))[0];
}

// ── reliability ──
async function reportProblems(env, customerId, cf, problems) {
  if (!problems.length) return;
  const stamp = new Date().toISOString();
  console.error(`[${WORKER}] pipeline problems for ${customerId}:`, problems.join(' | '));
  try {
    await updateRecord(env, 'Customers', customerId, {
      'Pipeline Notes': `${stamp} — ${problems.join('; ')}`.slice(0, 5000),
    });
  } catch (e) { /* best effort */ }
  await alertAdmin(env, 'Matching pipeline had a problem',
    `The request was saved, but some steps failed:<br>• ${problems.map(esc).join('<br>• ')}`,
    { name: cf['Full Name'], email: cf['Email'], city: cf['Neighborhood/City'], record: customerId });
}

// Sends at most one alert per subject per hour (KV-throttled) so an outage
// can't flood the inbox or burn the Resend quota.
async function alertAdmin(env, subject, htmlDetail, ctx = {}) {
  try {
    const key = `alert:${WORKER}:${subject}:${new Date().toISOString().slice(0, 13)}`;
    if (env.RATE_LIMIT && await env.RATE_LIMIT.get(key)) return;
    if (env.RATE_LIMIT) await env.RATE_LIMIT.put(key, '1', { expirationTtl: 3600 });
    const rows = Object.entries(ctx).map(([k, v]) => `<p><strong>${esc(k)}:</strong> ${esc(v)}</p>`).join('');
    await sendEmail(env, {
      from: FROM_ALERTS, to: ADMIN_TO,
      subject: `🚨 JJH alert — ${subject}`,
      html: `<h2>${esc(subject)}</h2><p>${htmlDetail}</p>${rows}<p style="color:#888">Worker: ${WORKER} · ${new Date().toISOString()}. Further alerts with this subject are paused for the rest of the hour.</p>`,
    });
  } catch (e) { console.error('alertAdmin failed', e && e.message); }
}

async function sendEmail(env, { from, to, subject, html, replyTo }) {
  try {
    const payload = { from, to: [to], subject, html };
    if (replyTo && isEmail(str(replyTo).toLowerCase())) payload.reply_to = replyTo;
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) console.error('Resend error', res.status, (await res.text().catch(() => '')).slice(0, 300));
    return res;
  } catch (e) {
    console.error('Resend fetch threw', e && e.message);
    return null;
  }
}

async function at(env, path, opts = {}) {
  return fetch(`https://api.airtable.com/v0/${env.AT_BASE}/${path}`, {
    method: opts.method || 'GET',
    headers: { 'Authorization': `Bearer ${env.AT_TOKEN}`, 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
}

async function updateRecord(env, table, recordId, fields) {
  try {
    return await at(env, `${encodeURIComponent(table)}/${recordId}`, { method: 'PATCH', body: { fields, typecast: true } });
  } catch (e) { return null; }
}

async function rateOk(env, key, max) {
  const count = parseInt((await env.RATE_LIMIT.get(key)) || '0', 10);
  if (count >= max) return false;
  await env.RATE_LIMIT.put(key, String(count + 1), { expirationTtl: RL_TTL });
  return true;
}

// ── helpers ──
function utcDay() { return new Date().toISOString().split('T')[0]; }
// Calendar date in Pacific time as YYYY-MM-DD (Airtable date fields display in UTC,
// so a date-only value shows exactly this day).
function localDay() { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
function str(v) { return (typeof v === 'string' ? v : (v == null ? '' : String(v))).trim(); }
function digits(v) { return str(v).replace(/\D/g, ''); }
function isEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254; }
function isDate(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()); }
// City normalizer: strip quotes/backslashes, collapse whitespace, trim, title-case.
function normCity(v) { return str(v).toLowerCase().replace(/[\\"]/g, '').replace(/\s+/g, ' ').trim().replace(/\b\w/g, c => c.toUpperCase()); }
function strArray(v) {
  if (!Array.isArray(v)) return [];
  return v.filter(x => typeof x === 'string').map(x => x.trim()).filter(Boolean).slice(0, 30).map(x => x.slice(0, 100));
}
function isoOrEmpty(v) {
  if (typeof v !== 'string' || v.length > 40) return '';
  return Number.isNaN(Date.parse(v)) ? '' : v;
}
function atSafe(v) { return str(v).replace(/\\/g, '').replace(/"/g, ''); }
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
