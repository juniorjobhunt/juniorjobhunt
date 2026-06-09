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

    // ── Rate limiting via KV (5 submissions per IP per 24 hours) ──
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const today = new Date().toISOString().split('T')[0];
    const rlKey = `rl:${ip}:${today}`;

    const currentCount = parseInt(await env.RATE_LIMIT.get(rlKey) || '0', 10);
    if (currentCount >= 5) {
      return new Response(JSON.stringify({ error: 'Too many submissions. Please try again tomorrow.' }), {
        status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    await env.RATE_LIMIT.put(rlKey, String(currentCount + 1), { expirationTtl: 86400 });

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
    const normalizedCity = city.trim().toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
    const normalizedName = fullName.trim();
    const normalizedEmail = email.trim().toLowerCase();
    const normalizedPhone = phone.trim();

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
      const err = await atRes.json();
      console.error('Airtable error:', JSON.stringify(err));
      return new Response(JSON.stringify({ error: 'Something went wrong. Please try again.' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
};
