// jjh-waitlist-form — writes a Waitlist signup to Airtable.
// Validation, honeypot, KV rate limiting (per IP + per email).
// Sept 27, 2026: per-IP limit raised to 30/day (schools share one IP), per-email
// limit 3/day added, admin alert if Airtable fails.

const RL_IP_MAX = 30;
const RL_EMAIL_MAX = 3;
const FROM_ALERTS = 'JJH Alerts <alerts@juniorjobhunt.com>';
const ADMIN_TO = 'juniorjobhunt@gmail.com';
const WORKER = 'jjh-waitlist-form';

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowedOrigins = ['https://juniorjobhunt.com', 'https://www.juniorjobhunt.com'];
    const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

    const corsHeaders = {
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // ── Rate limiting via KV (per IP per day) ──
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const today = new Date().toISOString().split('T')[0];
    const tooMany = () => new Response(JSON.stringify({ error: 'Too many submissions. Please try again tomorrow.' }), {
      status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
    if (!(await rateOk(env, `rl:${ip}:${today}`, RL_IP_MAX))) return tooMany();

    // ── Parse body ──
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid request body.' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // ── Honeypot check (bots fill hidden fields, humans don't) ──
    if (body.website || body.address) {
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // ── Input validation ──
    const { fullName, email, phone, city } = body;
    const errors = [];

    if (!fullName || fullName.trim().length < 2)
      errors.push('Please enter your full name.');
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
      errors.push('Please enter a valid email address.');
    if (!phone || phone.replace(/\D/g, '').length < 10)
      errors.push('Please enter a valid phone number.');
    if (!city || city.trim().length < 2)
      errors.push('Please enter your city.');

    if (errors.length > 0) {
      return new Response(JSON.stringify({ error: errors.join(' ') }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // ── Normalize fields ──
    const normalizedCity = city.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const normalizedName = fullName.trim();
    const normalizedEmail = email.trim().toLowerCase();
    const normalizedPhone = phone.trim();

    // ── Rate limiting per email ──
    if (!(await rateOk(env, `rle:${normalizedEmail}:${today}`, RL_EMAIL_MAX))) return tooMany();

    // ── Write to Airtable Waitlist table ──
    const atRes = await fetch(`https://api.airtable.com/v0/${env.AT_BASE}/Waitlist`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.AT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fields: {
          'Full Name': normalizedName,
          'Email': normalizedEmail,
          'Phone': normalizedPhone,
          'City': normalizedCity,
          'Consented At': (typeof body.consentedAt === 'string' ? body.consentedAt : ''),
        }
      }),
    });

    if (!atRes.ok) {
      const err = await atRes.json().catch(() => ({}));
      console.error('Airtable error:', JSON.stringify(err));
      await alertAdmin(env, 'Waitlist form could not save a signup',
        `A waitlist signup failed to save — the visitor saw an error. Airtable ${atRes.status}: ${esc(JSON.stringify(err).slice(0, 500))}`,
        { name: normalizedName, email: normalizedEmail, city: normalizedCity });
      return new Response(JSON.stringify({ error: 'Something went wrong. Please try again.' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
};

async function rateOk(env, key, max) {
  const count = parseInt((await env.RATE_LIMIT.get(key)) || '0', 10);
  if (count >= max) return false;
  await env.RATE_LIMIT.put(key, String(count + 1), { expirationTtl: 86400 });
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

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
