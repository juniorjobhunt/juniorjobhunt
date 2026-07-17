// jjh-customer-form — writes a Customer request to Airtable, matches a Tasker
// in the same city (skills-preferred), sends 3 Resend emails, flips both records
// to "Matched", and logs a Matches row. No-match path emails admin + customer.
//
// Hardened: origin-locked CORS, method + body-size guards, KV rate limiting,
// honeypot, strict validation, server-built field allowlist, HTML-escaped email
// bodies (no injection / brand-spoofing relay), and formula-injection-safe queries.

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

    const declared = parseInt(request.headers.get('Content-Length') || '0', 10);
    if (declared && declared > MAX_BODY_BYTES) return fail('Request too large.', 413);
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return fail('Request too large.', 413);

    // Rate limit (5 / IP / day) — protects the Resend email quota + Airtable.
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rlKey = `rlc:${ip}:${new Date().toISOString().split('T')[0]}`;
    const count = parseInt((await env.RATE_LIMIT.get(rlKey)) || '0', 10);
    if (count >= RL_MAX) return fail('Too many submissions. Please try again tomorrow.', 429);
    await env.RATE_LIMIT.put(rlKey, String(count + 1), { expirationTtl: RL_TTL });

    let body;
    try { body = JSON.parse(raw); } catch { return fail('Invalid request body.'); }
    const f = (body && body.fields) || {};

    if (body.website || body.address) return json({ success: true }); // honeypot

    // Validate
    const name  = str(f['Full Name']);
    const email = str(f['Email']).toLowerCase();
    const phone = str(f['Phone Number']);
    const city  = titleCase(str(f['Neighborhood/City'])).replace(/\s+/g, ' ');
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
      'Date Submitted': new Date().toISOString().split('T')[0],
      'Consented At': isoOrEmpty(f['Consented At']),
    };

    // 0. Duplicate guard — same email in the last 2 minutes
    const since = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const dupFormula = encodeURIComponent(`AND(LOWER({Email})="${atSafe(email)}", IS_AFTER({Created}, "${since}"))`);
    const dupRes = await fetch(`https://api.airtable.com/v0/${env.AT_BASE}/Customers?filterByFormula=${dupFormula}&maxRecords=1`, {
      headers: { 'Authorization': `Bearer ${env.AT_TOKEN}` },
    });
    const dupData = await dupRes.json().catch(() => ({}));
    if (dupRes.ok && dupData.records && dupData.records.length) {
      return json({ success: true, duplicate: true });
    }

    // 1. Write customer
    const atRes = await fetch(`https://api.airtable.com/v0/${env.AT_BASE}/Customers`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.AT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    });
    const customer = await atRes.json().catch(() => ({}));
    if (!atRes.ok) {
      console.error('Airtable error:', JSON.stringify(customer));
      return fail('Something went wrong. Please try again.', 500);
    }

    const customerId = customer.id;
    const cf = customer.fields;
    const cityVal = cf['Neighborhood/City'];

    // 2. Find an available tasker in the same city
    const formula = encodeURIComponent(`AND({Neighborhood/City}="${atSafe(cityVal)}",{Status}="New")`);
    const taskerRes = await fetch(
      `https://api.airtable.com/v0/${env.AT_BASE}/Taskers?filterByFormula=${formula}&maxRecords=50`,
      { headers: { 'Authorization': `Bearer ${env.AT_TOKEN}` } }
    );
    const taskerData = await taskerRes.json().catch(() => ({}));
    const taskers = taskerData.records || [];

    // format + HTML-escape multi-select / text field for safe email rendering
    const fmt = val => esc(Array.isArray(val) ? val.join(', ') : (val == null ? 'N/A' : String(val)));
    const cityH = esc(cityVal);

    if (taskers.length === 0) {
      await sendEmail(env, {
        to: 'outreach@juniorjobhunt.com',
        subject: '⚠️ No Tasker Found — New Customer Request',
        html: `
          <h2>No Tasker Available in ${cityH}</h2>
          <p>A customer submitted a request but no available tasker was found in <strong>${cityH}</strong>. You may want to follow up manually or recruit taskers in this area.</p>
          <h3>Customer Details</h3>
          <p><strong>Name:</strong> ${fmt(cf['Full Name'])}</p>
          <p><strong>Email:</strong> ${fmt(cf['Email'])}</p>
          <p><strong>Phone:</strong> ${fmt(cf['Phone Number'])}</p>
          <p><strong>City:</strong> ${cityH}</p>
          <p><strong>Task:</strong> ${fmt(cf['Task Category'])}</p>
          <p><strong>Description:</strong> ${fmt(cf['Task Description'])}</p>
          <p><strong>Preferred Date:</strong> ${fmt(cf['Preferred Date'])}</p>
          <p><strong>Urgency:</strong> ${fmt(cf['Urgency'])}</p>
        `
      });

      if (isEmail(str(cf['Email']).toLowerCase())) {
        await sendEmail(env, {
          to: cf['Email'],
          subject: 'We got your request — JuniorJobHunt',
          html: `
            <h2>Thanks for your request!</h2>
            <p>We don't have an available tasker in <strong>${cityH}</strong> just yet, but we're on it — we'll reach out as soon as we find someone who can help with your task.</p>
            <p><strong>Your request:</strong> ${fmt(cf['Task Category'])}</p>
            <p>Questions? Just reply to this email.</p>
            <p>— The JuniorJobHunt Team</p>
          `
        });
      }

      await updateRecord(env, 'Customers', customerId, { 'Status': 'No Match' });
      return json({ success: true, matched: false });
    }

    // Prefer a tasker whose Skills overlap the Task Category; else first in city.
    const wantedCats = Array.isArray(cf['Task Category']) ? cf['Task Category'] : (cf['Task Category'] ? [cf['Task Category']] : []);
    const skillMatch = taskers.find(t => {
      const skills = t.fields['Skills'] || [];
      return Array.isArray(skills) && skills.some(s => wantedCats.includes(s));
    });
    const tasker = skillMatch || taskers[0];
    const taskerId = tasker.id;
    const tf = tasker.fields;

    // 3. Emails

    await sendEmail(env, {
      to: 'outreach@juniorjobhunt.com',
      subject: '✅ New Match Made — JuniorJobHunt',
      html: `
        <h2>A new match was made!</h2>
        <h3>Customer</h3>
        <p><strong>Name:</strong> ${fmt(cf['Full Name'])}</p>
        <p><strong>Email:</strong> ${fmt(cf['Email'])}</p>
        <p><strong>Phone:</strong> ${fmt(cf['Phone Number'])}</p>
        <p><strong>City:</strong> ${cityH}</p>
        <p><strong>Task:</strong> ${fmt(cf['Task Category'])}</p>
        <p><strong>Description:</strong> ${fmt(cf['Task Description'])}</p>
        <p><strong>Preferred Date:</strong> ${fmt(cf['Preferred Date'])}</p>
        <p><strong>Urgency:</strong> ${fmt(cf['Urgency'])}</p>
        <h3>Matched Tasker</h3>
        <p><strong>Name:</strong> ${fmt(tf['Full Name'])}</p>
        <p><strong>Email:</strong> ${fmt(tf['Email'])}</p>
        <p><strong>Phone:</strong> ${fmt(tf['Phone Number'])}</p>
        <p><strong>Skills:</strong> ${fmt(tf['Skills'])}</p>
        <p><strong>Availability:</strong> ${fmt(tf['Availability'])}</p>
      `
    });

    if (isEmail(str(tf['Email']).toLowerCase())) {
      await sendEmail(env, {
        to: tf['Email'],
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
          <br>
          <p>— The JuniorJobHunt Team</p>
        `
      });
    }

    if (isEmail(str(cf['Email']).toLowerCase())) {
      await sendEmail(env, {
        to: cf['Email'],
        subject: "We found a tasker for you! — JuniorJobHunt",
        html: `
          <p>Hi ${fmt(cf['Full Name'])},</p>
          <p>Great news — we found a tasker in <strong>${cityH}</strong> who can help you!</p>
          <h3>Your Tasker</h3>
          <p><strong>Name:</strong> ${fmt(tf['Full Name'])}</p>
          <p><strong>Email:</strong> ${fmt(tf['Email'])}</p>
          <p><strong>Phone:</strong> ${fmt(tf['Phone Number'])}</p>
          <p>They'll be in touch soon, or feel free to reach out to them directly.</p>
          <p>Thank you for using JuniorJobHunt!</p>
          <br>
          <p>— The JuniorJobHunt Team</p>
        `
      });
    }

    // 4. Flip both to "Matched"
    await Promise.all([
      updateRecord(env, 'Customers', customerId, { 'Status': 'Matched' }),
      updateRecord(env, 'Taskers', taskerId, { 'Status': 'Matched' }),
    ]);

    // 5. Log to Matches (non-critical)
    try {
      await fetch(`https://api.airtable.com/v0/${env.AT_BASE}/Matches`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.AT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          typecast: true,
          fields: {
            'Customer Name': [customerId],
            'Tasker Name': [taskerId],
            'Task Category': Array.isArray(cf['Task Category']) ? cf['Task Category'] : [cf['Task Category']],
            'Match Date': new Date().toISOString().split('T')[0],
            'Status': 'Pending',
          }
        })
      });
    } catch (e) { /* non-critical */ }

    return json({ success: true, matched: true });
  },
};

async function sendEmail(env, { to, subject, html }) {
  return fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'JuniorJobHunt <outreach@juniorjobhunt.com>', to: [to], subject, html }),
  });
}

async function updateRecord(env, table, recordId, fields) {
  return fetch(`https://api.airtable.com/v0/${env.AT_BASE}/${encodeURIComponent(table)}/${recordId}`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${env.AT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields, typecast: true }),
  });
}

// ── helpers ──
function str(v) { return (typeof v === 'string' ? v : (v == null ? '' : String(v))).trim(); }
function digits(v) { return str(v).replace(/\D/g, ''); }
function isEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254; }
function isDate(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()); }
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
function atSafe(v) { return str(v).replace(/\\/g, '').replace(/"/g, ''); }
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
