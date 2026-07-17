// jjh-tasker-form — writes a Tasker application to Airtable.
// Hardened: origin-locked CORS, method + body-size guards, KV rate limiting,
// honeypot, strict validation, and a server-built field allowlist (the client
// cannot set arbitrary Airtable fields or a privileged Status).

const ALLOWED_ORIGINS = ['https://juniorjobhunt.com', 'https://www.juniorjobhunt.com'];
const MAX_BODY_BYTES = 20000;
const RL_MAX = 5;            // submissions per IP per day
const RL_TTL = 86400;

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

    // Rate limit (5 / IP / day)
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rlKey = `rlt:${ip}:${new Date().toISOString().split('T')[0]}`;
    const count = parseInt((await env.RATE_LIMIT.get(rlKey)) || '0', 10);
    if (count >= RL_MAX) return fail('Too many submissions. Please try again tomorrow.', 429);
    await env.RATE_LIMIT.put(rlKey, String(count + 1), { expirationTtl: RL_TTL });

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
    const city  = titleCase(str(f['Neighborhood/City']));
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
      'Date Submitted': new Date().toISOString().split('T')[0],
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
      console.error('Airtable error:', JSON.stringify(data));
      return fail('Something went wrong. Please try again.', 500);
    }
    return json(data);
  },
};

// ── helpers ──
function str(v) { return (typeof v === 'string' ? v : (v == null ? '' : String(v))).trim(); }
function digits(v) { return str(v).replace(/\D/g, ''); }
function isEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254; }
// City normalizer: strip quotes/backslashes, collapse whitespace, title-case —
// keeps stored cities clean and makes exact-string matching robust.
function titleCase(v) { return str(v).toLowerCase().replace(/[\\"]/g, '').replace(/\s+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()); }
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
