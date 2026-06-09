export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }

    const body = await request.json();

    // Normalize city to title case so matching works regardless of how the user typed it
    if (body.fields && body.fields['Neighborhood/City']) {
      body.fields['Neighborhood/City'] = body.fields['Neighborhood/City']
        .trim()
        .toLowerCase()
        .replace(/\b\w/g, c => c.toUpperCase());
    }

    // Duplicate-submission guard — skip if this email already submitted in the last 2 minutes
    const subEmail = body.fields && body.fields['Email'] ? String(body.fields['Email']).trim() : '';
    if (subEmail) {
      const since = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      const dupFormula = encodeURIComponent(`AND(LOWER({Email})="${subEmail.toLowerCase().replace(/"/g, '')}", IS_AFTER({Created}, "${since}"))`);
      const dupRes = await fetch(`https://api.airtable.com/v0/${env.AT_BASE}/Taskers?filterByFormula=${dupFormula}&maxRecords=1`, {
        headers: { 'Authorization': `Bearer ${env.AT_TOKEN}` }
      });
      const dupData = await dupRes.json().catch(() => ({}));
      if (dupRes.ok && dupData.records && dupData.records.length) {
        return new Response(JSON.stringify({ success: true, duplicate: true }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    const res = await fetch(`https://api.airtable.com/v0/${env.AT_BASE}/Taskers`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.AT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await res.json();
    return new Response(JSON.stringify(data), {
      status: res.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      }
    });
  }
};
