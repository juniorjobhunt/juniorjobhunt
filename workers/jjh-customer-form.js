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

    // Normalize city to title case
    if (body.fields && body.fields['Neighborhood/City']) {
      body.fields['Neighborhood/City'] = body.fields['Neighborhood/City']
        .trim()
        .toLowerCase()
        .replace(/\b\w/g, c => c.toUpperCase());
    }

    // 1. Write customer to Airtable
    const atRes = await fetch(`https://api.airtable.com/v0/${env.AT_BASE}/Customers`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.AT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const customer = await atRes.json();

    if (!atRes.ok) {
      return new Response(JSON.stringify(customer), {
        status: atRes.status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    const customerId = customer.id;
    const cf = customer.fields;
    const city = cf['Neighborhood/City'];

    // 2. Search for an available tasker in the same city
    const formula = encodeURIComponent(`AND({Neighborhood/City}="${city}",{Status}="New")`);
    const taskerRes = await fetch(
      `https://api.airtable.com/v0/${env.AT_BASE}/Taskers?filterByFormula=${formula}&maxRecords=50`,
      { headers: { 'Authorization': `Bearer ${env.AT_TOKEN}` } }
    );
    const taskerData = await taskerRes.json();
    const taskers = taskerData.records || [];

    // Helper: format array fields (multi-select) into a readable string
    const fmt = val => Array.isArray(val) ? val.join(', ') : (val || 'N/A');

    if (taskers.length === 0) {
      // No tasker found — notify admin and update customer status
      await sendEmail(env, {
        to: 'outreach@juniorjobhunt.com',
        subject: '⚠️ No Tasker Found — New Customer Request',
        html: `
          <h2>No Tasker Available in ${city}</h2>
          <p>A customer submitted a request but no available tasker was found in <strong>${city}</strong>. You may want to follow up manually or recruit taskers in this area.</p>
          <h3>Customer Details</h3>
          <p><strong>Name:</strong> ${fmt(cf['Full Name'])}</p>
          <p><strong>Email:</strong> ${fmt(cf['Email'])}</p>
          <p><strong>Phone:</strong> ${fmt(cf['Phone Number'])}</p>
          <p><strong>City:</strong> ${city}</p>
          <p><strong>Task:</strong> ${fmt(cf['Task Category'])}</p>
          <p><strong>Description:</strong> ${fmt(cf['Task Description'])}</p>
          <p><strong>Preferred Date:</strong> ${fmt(cf['Preferred Date'])}</p>
          <p><strong>Urgency:</strong> ${fmt(cf['Urgency'])}</p>
        `
      });

      // Acknowledge the customer so they aren't left hanging while we recruit a tasker
      await sendEmail(env, {
        to: cf['Email'],
        subject: 'We got your request — JuniorJobHunt',
        html: `
          <h2>Thanks for your request!</h2>
          <p>We don't have an available tasker in <strong>${city}</strong> just yet, but we're on it — we'll reach out as soon as we find someone who can help with your task.</p>
          <p><strong>Your request:</strong> ${fmt(cf['Task Category'])}</p>
          <p>Questions? Just reply to this email.</p>
          <p>— The JuniorJobHunt Team</p>
        `
      });

      await updateRecord(env, 'Customers', customerId, { 'Status': 'No Match' });

      return new Response(JSON.stringify({ success: true, matched: false }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // Prefer a tasker whose Skills overlap the customer's Task Category; fall back to first available in the city
    const wantedCats = Array.isArray(cf['Task Category']) ? cf['Task Category'] : (cf['Task Category'] ? [cf['Task Category']] : []);
    const skillMatch = taskers.find(t => {
      const skills = t.fields['Skills'] || [];
      return Array.isArray(skills) && skills.some(s => wantedCats.includes(s));
    });
    const tasker = skillMatch || taskers[0];
    const taskerId = tasker.id;
    const tf = tasker.fields;

    // 3. Send 3 emails via Resend

    // Email 1 — Admin notification
    await sendEmail(env, {
      to: 'outreach@juniorjobhunt.com',
      subject: '✅ New Match Made — JuniorJobHunt',
      html: `
        <h2>A new match was made!</h2>
        <h3>Customer</h3>
        <p><strong>Name:</strong> ${fmt(cf['Full Name'])}</p>
        <p><strong>Email:</strong> ${fmt(cf['Email'])}</p>
        <p><strong>Phone:</strong> ${fmt(cf['Phone Number'])}</p>
        <p><strong>City:</strong> ${city}</p>
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

    // Email 2 — Matched tasker
    await sendEmail(env, {
      to: tf['Email'],
      subject: "You've been matched with a customer! — JuniorJobHunt",
      html: `
        <p>Hi ${fmt(tf['Full Name'])},</p>
        <p>Great news — you've been matched with a customer in <strong>${city}</strong> who needs help with a task!</p>
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

    // Email 3 — Customer confirmation
    await sendEmail(env, {
      to: cf['Email'],
      subject: "We found a tasker for you! — JuniorJobHunt",
      html: `
        <p>Hi ${fmt(cf['Full Name'])},</p>
        <p>Great news — we found a tasker in <strong>${city}</strong> who can help you!</p>
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

    // 4. Update both records to "Matched" so neither gets re-matched
    await Promise.all([
      updateRecord(env, 'Customers', customerId, { 'Status': 'Matched' }),
      updateRecord(env, 'Taskers', taskerId, { 'Status': 'Matched' }),
    ]);

    // 5. Log to Matches table
    try {
      await fetch(`https://api.airtable.com/v0/${env.AT_BASE}/Matches`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.AT_TOKEN}`,
          'Content-Type': 'application/json',
        },
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
    } catch (e) {
      // Matches table logging is non-critical — don't fail the request if it errors
    }

    return new Response(JSON.stringify({ success: true, matched: true }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
};

async function sendEmail(env, { to, subject, html }) {
  return fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'JuniorJobHunt <outreach@juniorjobhunt.com>',
      to: [to],
      subject,
      html,
    })
  });
}

async function updateRecord(env, table, recordId, fields) {
  return fetch(`https://api.airtable.com/v0/${env.AT_BASE}/${encodeURIComponent(table)}/${recordId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${env.AT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields, typecast: true })
  });
}
