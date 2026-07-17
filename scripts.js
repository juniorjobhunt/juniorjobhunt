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

// --- Accessibility: dialog focus management (focus on open, restore on close, trap Tab) ---
var _lastFocused = null;
var _activeDialog = null;
function _focusables(c) {
  return Array.prototype.slice.call(c.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter(function(el) { return el.offsetParent !== null; });
}
function dialogOpened(container) {
  if (!container) return;
  _activeDialog = container;
  _lastFocused = document.activeElement;
  var pref = container.querySelector('input:not([disabled]), textarea, select') || _focusables(container)[0];
  if (pref) setTimeout(function() { pref.focus(); }, 50);
}
function dialogClosed() {
  _activeDialog = null;
  if (_lastFocused && _lastFocused.focus) { try { _lastFocused.focus(); } catch (e) {} }
  _lastFocused = null;
}
document.addEventListener('keydown', function(e) {
  if (e.key !== 'Tab' || !_activeDialog) return;
  var f = _focusables(_activeDialog);
  if (!f.length) return;
  var first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

// --- Modal Controls ---
function openModal(type) {
  document.getElementById('modal-overlay').style.display = 'block';
  document.getElementById('modal-tasker').style.display = (type === 'tasker') ? 'block' : 'none';
  document.getElementById('modal-customer').style.display = (type === 'customer') ? 'block' : 'none';
  document.body.style.overflow = 'hidden';
  dialogOpened(document.getElementById('modal-' + type));
}

function closeModal() {
  document.getElementById('modal-overlay').style.display = 'none';
  document.getElementById('modal-tasker').style.display = 'none';
  document.getElementById('modal-customer').style.display = 'none';
  document.body.style.overflow = '';
  dialogClosed();
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
    "Date Submitted": new Date().toISOString().split('T')[0],
    "Consented At": (form.querySelector('input[name="consent"]') || {}).checked ? new Date().toISOString() : ''
  };
  try {
    var res = await fetch(WORKER_TASKER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: fields,
        website: (form.querySelector('[name="website"]') || {}).value || '',
        address: (form.querySelector('[name="address"]') || {}).value || ''
      })
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
    "Date Submitted": new Date().toISOString().split('T')[0],
    "Consented At": (form.querySelector('input[name="consent"]') || {}).checked ? new Date().toISOString() : ''
  };
  try {
    var res = await fetch(WORKER_CUSTOMER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: fields,
        website: (form.querySelector('[name="website"]') || {}).value || '',
        address: (form.querySelector('[name="address"]') || {}).value || ''
      })
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

// ── WAITLIST ──
const WAITLIST_WORKER = 'https://jjh-waitlist-form.juniorjobhunt.workers.dev';

function openWaitlist() {
  document.getElementById('wlOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
  document.getElementById('wlFormView').style.display = '';
  document.getElementById('wlSuccess').style.display = 'none';
  document.getElementById('wlError').classList.remove('show');
  document.getElementById('wlForm').reset();
  dialogOpened(document.querySelector('#wlOverlay .wl-modal'));
}

function closeWaitlist() {
  document.getElementById('wlOverlay').classList.remove('open');
  document.body.style.overflow = '';
  dialogClosed();
}

function closeWaitlistOnBackdrop(e) {
  if (e.target === document.getElementById('wlOverlay')) closeWaitlist();
}

function dismissBanner() {
  var banner = document.getElementById('waitlistBanner');
  banner.style.display = 'none';
  try { sessionStorage.setItem('wl_banner_dismissed', '1'); } catch(e) {}
}

async function submitWaitlist(e) {
  e.preventDefault();
  var btn = document.getElementById('wlSubmit');
  var errEl = document.getElementById('wlError');
  errEl.classList.remove('show');
  btn.disabled = true;
  btn.textContent = 'Submitting…';

  var payload = {
    fullName: document.getElementById('wlName').value,
    email:    document.getElementById('wlEmail').value,
    phone:    document.getElementById('wlPhone').value,
    city:     document.getElementById('wlCity').value,
    website:  document.querySelector('[name="website"]').value,
    address:  document.querySelector('[name="address"]').value,
    consentedAt: (document.querySelector('#wlForm input[name="consent"]') || {}).checked ? new Date().toISOString() : '',
  };

  try {
    var res = await fetch(WAITLIST_WORKER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    var data = await res.json();
    if (data.success) {
      document.getElementById('wlFormView').style.display = 'none';
      document.getElementById('wlSuccess').style.display = '';
      dismissBanner();
      try { localStorage.setItem('wl_joined', '1'); } catch(e) {}
    } else {
      errEl.textContent = data.error || 'Something went wrong. Please try again.';
      errEl.classList.add('show');
      btn.disabled = false;
      btn.textContent = 'Reserve My Spot →';
    }
  } catch(err) {
    errEl.textContent = 'Network error — please check your connection and try again.';
    errEl.classList.add('show');
    btn.disabled = false;
    btn.textContent = 'Reserve My Spot →';
  }
}

// Hide banner if already dismissed this session
(function() {
  try { if (sessionStorage.getItem('wl_banner_dismissed')) document.getElementById('waitlistBanner').style.display = 'none'; } catch(e) {}
})();

// Close waitlist modal on Escape key
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') closeWaitlist();
});

// ── WAITLIST AUTO-POPUP ──
// Opens the waitlist modal shortly after page load, then again every 60s.
// Skips visitors who already joined, and never interrupts an open dialog
// (tasker/customer forms, or the waitlist modal itself) or a hidden tab.
(function() {
  if (!document.getElementById('wlOverlay')) return;
  function alreadyJoined() {
    try { return !!localStorage.getItem('wl_joined'); } catch(e) { return false; }
  }
  if (alreadyJoined()) return;
  function autoOpenWaitlist() {
    if (alreadyJoined() || _activeDialog || document.hidden) return;
    openWaitlist();
  }
  setTimeout(autoOpenWaitlist, 2000);
  setInterval(autoOpenWaitlist, 60000);
})();
