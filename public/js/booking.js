// Booking wizard: shows one step at a time. Without JavaScript the form still
// works as a single page, and the server checks everything either way.
(function () {
  var form = document.getElementById('booking-form');
  if (!form) return;

  var steps = Array.prototype.slice.call(form.querySelectorAll('.booking-step'));
  var progress = Array.prototype.slice.call(document.querySelectorAll('.booking-progress li'));
  var backBtn = form.querySelector('[data-nav="back"]');
  var nextBtn = form.querySelector('[data-nav="next"]');
  var submitBtn = form.querySelector('[data-nav="submit"]');
  var today = form.dataset.today;
  var earliest = Number(form.dataset.earliest);
  var current = Number(form.dataset.startStep) || 1;

  form.classList.add('is-wizard');

  var checked = function (name) { return form.querySelector('input[name="' + name + '"]:checked'); };

  // ---------- Inline messages ----------
  function clearMessage(step) {
    step.querySelectorAll('.field-error[data-client]').forEach(function (el) { el.remove(); });
    step.querySelectorAll('.is-invalid').forEach(function (el) { el.classList.remove('is-invalid'); });
  }

  function showMessage(anchor, text, markEls) {
    var msg = document.createElement('div');
    msg.className = 'field-error';
    msg.dataset.client = '1';
    msg.setAttribute('role', 'alert');
    msg.textContent = text;
    anchor.insertAdjacentElement('afterend', msg);
    (markEls || []).forEach(function (el) { el.classList.add('is-invalid'); });
  }

  // ---------- Step checks (the server repeats all of these) ----------
  function validate(n) {
    var step = steps[n - 1];
    clearMessage(step);
    var ok = true;
    var requireChoice = function (name, text, groupSelector) {
      if (checked(name)) return;
      var group = step.querySelector(groupSelector);
      showMessage(group, text, Array.prototype.slice.call(group.children));
      ok = false;
    };
    if (n === 1) requireChoice('service', 'Please choose a service.', '.choice-grid');
    if (n === 2) requireChoice('advisor', 'Please choose an advisor.', '.choice-grid');
    if (n === 3) {
      requireChoice('meeting', 'Please choose in office or video call.', '.choice-grid');
      requireChoice('date', 'Please choose a date.', '.date-strip');
      requireChoice('time', 'Please choose a time.', '.slot-grid');
    }
    if (n === 4) {
      var field = function (id, test, text) {
        var input = form.querySelector('#' + id);
        if (test(input.value.trim())) return;
        showMessage(input, text, [input]);
        ok = false;
      };
      field('name', function (v) { return v.length >= 2; }, 'Please enter your full name.');
      field('phone', function (v) { var d = v.replace(/\D/g, ''); return /^\+?[\d\s()-]+$/.test(v) && d.length >= 7 && d.length <= 15; },
        'Please enter a valid phone number, for example +971 50 123 4567.');
      field('email', function (v) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v); }, 'Please enter a valid email address.');
    }
    if (!ok) {
      var first = step.querySelector('.is-invalid input, input.is-invalid');
      if (first) first.focus({ preventScroll: true });
    }
    return ok;
  }

  // ---------- Step 2: only the advisors for the chosen service ----------
  function filterAdvisors() {
    var service = checked('service');
    var cards = Array.prototype.slice.call(form.querySelectorAll('.advisor-card'));
    var visible = cards.filter(function (card) {
      var match = !service || card.dataset.services.split(' ').indexOf(service.value) !== -1;
      card.hidden = !match;
      if (!match) card.querySelector('input').checked = false;
      return match;
    });
    if (visible.length === 1) visible[0].querySelector('input').checked = true;
    var hint = document.getElementById('advisor-hint');
    if (service && hint) {
      var title = service.closest('.choice-card').querySelector('.choice-card__title').textContent;
      hint.textContent = visible.length === 1
        ? 'Your specialist for ' + title + ':'
        : 'Advisors who specialise in ' + title + ':';
    }
  }

  // ---------- Step 3: no slots that are too soon today ----------
  function updateSlots() {
    var date = checked('date');
    var isToday = date && date.value === today;
    form.querySelectorAll('input[name="time"]').forEach(function (input) {
      var tooSoon = isToday && Number(input.dataset.start) < earliest;
      input.disabled = tooSoon;
      input.closest('.slot-chip').classList.toggle('is-disabled', tooSoon);
      if (tooSoon) input.checked = false;
    });
    document.getElementById('today-note').classList.toggle('d-none', !isToday);
  }

  // ---------- Navigation ----------
  function show(n, focus) {
    current = n;
    steps.forEach(function (step, i) { step.hidden = i + 1 !== n; });
    progress.forEach(function (li, i) {
      li.classList.toggle('is-current', i + 1 === n);
      li.classList.toggle('is-done', i + 1 < n);
      if (i + 1 === n) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
    });
    backBtn.hidden = n === 1;
    nextBtn.hidden = n === steps.length;
    submitBtn.hidden = n !== steps.length;
    if (n === 2) filterAdvisors();
    if (n === 3) updateSlots();
    if (focus) {
      var legend = steps[n - 1].querySelector('legend');
      legend.setAttribute('tabindex', '-1');
      legend.focus({ preventScroll: true });
      document.querySelector('.booking-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  nextBtn.addEventListener('click', function () {
    if (validate(current)) show(current + 1, true);
  });
  backBtn.addEventListener('click', function () { show(current - 1, true); });

  form.addEventListener('submit', function (e) {
    // Enter key on an earlier step moves forward instead of submitting.
    if (current < steps.length) {
      e.preventDefault();
      if (validate(current)) show(current + 1, true);
      return;
    }
    for (var n = 1; n <= steps.length; n++) {
      if (!validate(n)) { e.preventDefault(); show(n, true); return; }
    }
    submitBtn.disabled = true;
    submitBtn.textContent = 'Checking…';
  });

  // Choosing an option clears that group's error message.
  form.addEventListener('change', function (e) {
    var step = e.target.closest('.booking-step');
    if (step && e.target.type === 'radio') {
      step.querySelectorAll('input[name="' + e.target.name + '"]').forEach(function (input) {
        input.closest('label').classList.remove('is-invalid');
      });
      var group = e.target.closest('.choice-grid, .date-strip, .slot-grid');
      var next = group && group.nextElementSibling;
      if (next && next.classList.contains('field-error')) next.remove();
    }
    if (e.target.name === 'date') updateSlots();
  });

  // Progress steps already completed can be clicked to go back.
  progress.forEach(function (li, i) {
    li.addEventListener('click', function () { if (i + 1 < current) show(i + 1, true); });
  });

  show(current, false);
  var summary = document.getElementById('error-summary');
  if (summary) summary.focus();
})();
