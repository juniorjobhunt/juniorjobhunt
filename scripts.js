/* ============================================================
   Junior Job Hunt — Main JavaScript
   Extracted from index.html for easier editing.
   ============================================================ */

// Chip toggle interaction (hero section) — runs after DOM is ready
document.addEventListener('DOMContentLoaded', function() {
  document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
    });
  });
});

// --- Worker URLs (token is stored securely in Cloudflare, not here) ---
const WORKER_TASKER = "https://jjh-tasker-form.juniorjobhunt.workers.dev";
const WORKER_CUSTOMER = "https://jjh-customer-form.juniorjobhunt.workers.dev";

// --- Modal Controls ---
function openModal(type) {
  document.getElementById('modal-overlay').style.display = 'block';
  document.getElementById('modal-tasker').style.display = (type === 'tasker') ? 'block' : 'none';
  document.getElementById('modal-customer').style.display = (type === 'customer') ? 'block' : 'none';
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  document.getElementById('modal-overlay').style.display = 'none';
  document.getElementById('modal-tasker').style.display = 'none';
  document.getElementById('modal-customer').style.display = 'none';
  document.body.style.overflow = '';
}

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') closeModal();
});

// --- Chip Toggle (Modal) ---
function toggleChip(el, groupId) {
  var isActive = el.getAttribute('data-active') === '1';
  el.setAttribute('data-active', isActive ? '0' : '1');
  el.style.background = isActive ? '#f4f6f8' : '#17C3F0';
  el.style.color = isActive ? '' : '#fff';
  el.style.borderColor = isActive ? 'transparent' : '#17C3F0';
}

function getSelected(groupId) {
  var chips = document.querySelectorAll('#' + groupId + ' span');
  var vals = [];
  chips.forEach(function(c) {
    if (c.getAttribute('data-active') === '1') vals.push(c.getAttribute('data-val'));
  });
  return vals;
}

function showMsg(id, text, success) {
  var el = document.getElementById(id);
  el.style.display = 'block';
  el.textContent = text;
  el.style.background = success ? '#ecfdf5' : '#fef2f2';
  el.style.color = success ? '#065f46' : '#991b1b';
}

// --- Submit: Become a Tasker ---
async function submitTasker(e) {
  e.preventDefault();
  var form = document.getElementById('form-tasker');
  var btn = document.getElementById('btn-tasker');
  var fd = new FormData(form);
  var skills = getSelected('t-skills');
  var avail = getSelected('t-avail');
  if (!skills.length) { showMsg('msg-tasker', 'Please select at least one skill.', false); return; }
  if (!avail.length) { showMsg('msg-tasker', 'Please select your availability.', false); return; }
  btn.textContent = 'Submitting...';
  btn.disabled = true;
  var fields = {
    "Full Name": fd.get('Full Name'),
    "Email": fd.get('Email'),
    "Phone Number": fd.get('Phone Number'),
    "Age": parseInt(fd.get('Age')),
    "School Name": fd.get('School Name'),
    "Neighborhood/City": fd.get('Neighborhood/City'),
    "Skills": skills,
    "Availability": avail,
    "Short Bio": fd.get('Short Bio') || '',
    "Status": "New",
    "Date Submitted": new Date().toISOString().split('T')[0]
  };
  try {
    var res = await fetch(WORKER_TASKER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: fields })
    });
    var result = await res.json();
    if (res.ok) {
      showMsg('msg-tasker', '🎉 Application submitted! We\'ll be in touch soon.', true);
      form.reset();
      document.querySelectorAll('#t-skills span, #t-avail span').forEach(function(el) {
        el.setAttribute('data-active', '0');
        el.style.background = '#f4f6f8'; el.style.color = ''; el.style.borderColor = 'transparent';
      });
      btn.textContent = '✓ Submitted!';
    } else {
      showMsg('msg-tasker', 'Error: ' + (result.error ? result.error.message : 'Please try again.'), false);
      btn.textContent = 'Submit Application →'; btn.disabled = false;
    }
  } catch(err) {
    showMsg('msg-tasker', 'Network error — please try again.', false);
    btn.textContent = 'Submit Application →'; btn.disabled = false;
  }
}

// --- Submit: Hire a Tasker ---
async function submitCustomer(e) {
  e.preventDefault();
  var form = document.getElementById('form-customer');
  var btn = document.getElementById('btn-customer');
  var fd = new FormData(form);
  var tasks = getSelected('c-tasks');
  if (!tasks.length) { showMsg('msg-customer', 'Please select at least one task type.', false); return; }
  btn.textContent = 'Submitting...';
  btn.disabled = true;
  var fields = {
    "Full Name": fd.get('Full Name'),
    "Email": fd.get('Email'),
    "Phone Number": fd.get('Phone Number'),
    "Neighborhood/City": fd.get('Neighborhood/City'),
    "Task Category": tasks,
    "Task Description": fd.get('Task Description'),
    "Preferred Date": fd.get('Preferred Date') || '',
    "Urgency": fd.get('Urgency'),
    "Status": "New",
    "Date Submitted": new Date().toISOString().split('T')[0]
  };
  try {
    var res = await fetch(WORKER_CUSTOMER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: fields })
    });
    var result = await res.json();
    if (res.ok) {
      showMsg('msg-customer', '✅ Request received! We\'ll match you with a Tasker shortly.', true);
      form.reset();
      document.querySelectorAll('#c-tasks span').forEach(function(el) {
        el.setAttribute('data-active', '0');
        el.style.background = '#f4f6f8'; el.style.color = ''; el.style.borderColor = 'transparent';
      });
      btn.textContent = '✓ Request Sent!';
    } else {
      showMsg('msg-customer', 'Error: ' + (result.error ? result.error.message : 'Please try again.'), false);
      btn.textContent = 'Find Me a Tasker →'; btn.disabled = false;
    }
  } catch(err) {
    showMsg('msg-customer', 'Network error — please try again.', false);
    btn.textContent = 'Find Me a Tasker →'; btn.disabled = false;
  }
}

// --- Pre-select category when clicking a task card ---
function openModalWithCategory(category) {
  openModal('customer');
  setTimeout(function() {
    var chips = document.querySelectorAll('#c-tasks span');
    chips.forEach(function(chip) {
      if (chip.getAttribute('data-val') === category) {
        toggleChip(chip, 'c-tasks');
      }
    });
  }, 100);
}
