// jjh-tasker-form — writes a Tasker application to Airtable.
// Hardened: origin-locked CORS, method + body-size guards, KV rate limiting,
// honeypot, strict validation, and a server-built field allowlist (the client
// cannot set arbitrary Airtable fields or a privileged Status).
// Sept 27, 2026: per-IP + per-email rate limits (schools share one IP), Pacific
// "Date Submitted", minimal response body, and admin alert if Airtable fails.

const ALLOWED_ORIGINS = ['https://juniorjobhunt.com', 'https://www.juniorjobhunt.com'];
const MAX_BODY_BYTES = 20000;
const RL_IP_MAX = 30;        // submissions per IP per day
const RL_EMAIL_MAX = 3;      // submissions per email per day
const RL_TTL = 86400;
const TZ = 'America/Los_Angeles';
const FROM_ALERTS = 'JJH Alerts <alerts@juniorjobhunt.com>';
const ADMIN_TO = 'juniorjobhunt@gmail.com';
const WORKER = 'jjh-tasker-form';

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

    // Body-size guard (declared + actual)
    const declared = parseInt(request.headers.get('Content-Length') || '0', 10);
    if (declared && declared > MAX_BODY_BYTES) return fail('Request too large.', 413);
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return fail('Request too large.', 413);

    // Rate limit per IP
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const day = new Date().toISOString().split('T')[0];
    if (!(await rateOk(env, `rlt:${ip}:${day}`, RL_IP_MAX))) return fail('Too many submissions. Please try again tomorrow.', 429);

    // Parse
    let body;
    try { body = JSON.parse(raw); } catch { return fail('Invalid request body.'); }
    const f = (body && body.fields) || {};

    // Honeypot — pretend success so bots don't retry
    if (body.website || body.address) return json({ success: true });

    // Validate
    const name  = str(f['Full Name']);
    const email = str(f['Email']).toLowerCase();
    const phone = str(f['Phone Number']);
    const city  = normCity(f['Neighborhood/City']);
    const school = str(f['School Name']);
    const age = Number.parseInt(f['Age'], 10);
    const skills = strArray(f['Skills']);
    const avail  = strArray(f['Availability']);

    const errors = [];
    if (name.length < 2 || name.length > 100) errors.push('Please enter your full name.');
    if (!isEmail(email)) errors.push('Please enter a valid email address.');
    if (digits(phone).length < 10) errors.push('Please enter a valid phone number.');
    if (!Number.isInteger(age) || age < 13 || age > 120) errors.push('Please enter a valid age.');
    if (city.length < 2) errors.push('Please enter your city.');
    if (school.length < 1) errors.push('Please enter your school.');
    if (!skills.length) errors.push('Please select at least one skill.');
    if (!avail.length) errors.push('Please select your availability.');
    if (errors.length) return fail(errors.join(' '));

    // Rate limit per email
    if (!(await rateOk(env, `rlte:${email}:${day}`, RL_EMAIL_MAX))) return fail('Too many submissions. Please try again tomorrow.', 429);

    // Build the record from an allowlist — client cannot inject fields or Status.
    const fields = {
      'Full Name': name,
      'Email': email,
      'Phone Number': phone.slice(0, 40),
      'Age': age,
      'School Name': school.slice(0, 200),
      'Neighborhood/City': city,
      'Skills': skills,
      'Availability': avail,
      'Short Bio': str(f['Short Bio']).slice(0, 2000),
      'Status': 'New',
      'Date Submitted': localDay(),
      'Consented At': isoOrEmpty(f['Consented At']),
    };

    // Duplicate guard — same email in the last 2 minutes
    const since = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const dupFormula = encodeURIComponent(`AND(LOWER({Email})="${atSafe(email)}", IS_AFTER({Created}, "${since}"))`);
    const dupRes = await fetch(`https://api.airtable.com/v0/${env.AT_BASE}/Taskers?filterByFormula=${dupFormula}&maxRecords=1`, {
      headers: { 'Authorization': `Bearer ${env.AT_TOKEN}` },
    });
    const dupData = await dupRes.json().catch(() => ({}));
    if (dupRes.ok && dupData.records && dupData.records.length) {
      return json({ success: true, duplicate: true });
    }

    // Write
    const res = await fetch(`https://api.airtable.com/v0/${env.AT_BASE}/Taskers`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.AT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = `Airtable ${res.status}: ${JSON.stringify(data).slice(0, 500)}`;
      console.error('Tasker write failed:', detail);
      await alertAdmin(env, 'Tasker form could not save a signup',
        `A tasker signup failed to save — the applicant saw an error. ${esc(detail)}`,
        { name, email, city });
      return fail('Something went wrong. Please try again.', 500);
    }
    return json({ success: true });
  },
};

async function rateOk(env, key, max) {
  const count = parseInt((await env.RATE_LIMIT.get(key)) || '0', 10);
  if (count >= max) return false;
  await env.RATE_LIMIT.put(key, String(count + 1), { expirationTtl: RL_TTL });
  return true;
}

// One alert per subject per hour (KV-throttled).
async function alertAdmin(env, subject, htmlDetail, ctx = {}) {
  try {
    const key = `alert:${WORKER}:${subject}:${new Date().toISOString().slice(0, 13)}`;
    if (await env.RATE_LIMIT.get(key)) return;
    await env.RATE_LIMIT.put(key, '1', { expirationTtl: 3600 });
    const rows = Object.entries(ctx).map(([k, v]) => `<p><strong>${esc(k)}:</strong> ${esc(v)}</p>`).join('');
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM_ALERTS, to: [ADMIN_TO], subject: `🚨 JJH alert — ${subject}`,
        html: `<h2>${esc(subject)}</h2><p>${htmlDetail}</p>${rows}<p style="color:#888">Worker: ${WORKER} · ${new Date().toISOString()}. Further alerts with this subject are paused for the rest of the hour.</p>` }),
    });
    if (!res.ok) console.error('alert send failed', res.status);
  } catch (e) { console.error('alertAdmin failed', e && e.message); }
}

// ── helpers ──
function str(v) { return (typeof v === 'string' ? v : (v == null ? '' : String(v))).trim(); }
function digits(v) { return str(v).replace(/\D/g, ''); }
function isEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254; }
// City normalizer: strip quotes/backslashes, collapse whitespace, trim, title-case —
// keeps stored cities clean and makes exact-string matching robust.
function normCity(v) { return str(v).toLowerCase().replace(/[\\"]/g, '').replace(/\s+/g, ' ').trim().replace(/\b\w/g, c => c.toUpperCase()); }
// Calendar date in Pacific time (YYYY-MM-DD).
function localDay() { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function strArray(v) {
  if (!Array.isArray(v)) return [];
  return v.filter(x => typeof x === 'string').map(x => x.trim()).filter(Boolean).slice(0, 30).map(x => x.slice(0, 100));
}
function isoOrEmpty(v) {
  if (typeof v !== 'string' || v.length > 40) return '';
  return Number.isNaN(Date.parse(v)) ? '' : v;
}
// Neutralize Airtable formula string injection (backslash + double-quote).
function atSafe(v) { return str(v).replace(/\\/g, '').replace(/"/g, ''); }
