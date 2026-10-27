// Booking rules: available dates and time slots (UAE time) and validation of a booking request.
const { firm, services, advisors, meetingTypes } = require('./site-data');

const DAY_START = 9 * 60; // 9:00am
const DAY_END = 18 * 60; // 6:00pm
const SLOT_MINUTES = 45;
const MIN_NOTICE_MINUTES = 60; // a slot must start at least an hour from now
const DATES_SHOWN = 15; // working days offered in the date picker
const MAX_DAYS_AHEAD = 60; // furthest date accepted by the server

// 45-minute slots that fit between 9am and 6pm: 9:00, 9:45, 10:30 ... 17:15.
const SLOTS = [];
for (let start = DAY_START; start + SLOT_MINUTES <= DAY_END; start += SLOT_MINUTES) {
  SLOTS.push({ value: toHHMM(start), start, label: `${to12h(start)} – ${to12h(start + SLOT_MINUTES)}` });
}

function toHHMM(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function to12h(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const suffix = h >= 12 ? 'pm' : 'am';
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}${suffix}`;
}

// Current date (YYYY-MM-DD) and minutes past midnight in the firm's time zone.
function nowInFirmTime(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: firm.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now).map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

// Calendar helpers on plain YYYY-MM-DD strings (no time zone involved).
const asUTC = (ymd) => new Date(`${ymd}T00:00:00Z`);
const toYMD = (d) => d.toISOString().slice(0, 10);
const addDays = (ymd, n) => { const d = asUTC(ymd); d.setUTCDate(d.getUTCDate() + n); return toYMD(d); };
const isWeekday = (ymd) => { const day = asUTC(ymd).getUTCDay(); return day >= 1 && day <= 5; };
const daysBetween = (a, b) => Math.round((asUTC(b) - asUTC(a)) / 86400000);

function slotsLeftToday(clock) {
  return SLOTS.filter((s) => s.start >= clock.minutes + MIN_NOTICE_MINUTES);
}

// The next working days that still have bookable slots.
function availableDates(clock = nowInFirmTime()) {
  const dates = [];
  for (let i = 0; dates.length < DATES_SHOWN && i <= MAX_DAYS_AHEAD; i++) {
    const ymd = addDays(clock.date, i);
    if (!isWeekday(ymd)) continue;
    if (i === 0 && slotsLeftToday(clock).length === 0) continue;
    const d = asUTC(ymd);
    dates.push({
      value: ymd,
      weekday: d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' }),
      day: d.getUTCDate(),
      month: d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' }),
      isToday: i === 0,
    });
  }
  return dates;
}

function formatLongDate(ymd) {
  return asUTC(ymd).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

// ---------------------------------------------------------------------------
// Validation. Returns { errors, booking }: errors maps field -> message.
// ---------------------------------------------------------------------------
const clean = (v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');

function validateBooking(input, clock = nowInFirmTime()) {
  const errors = {};
  const v = {
    service: clean(input.service),
    advisor: clean(input.advisor),
    meeting: clean(input.meeting),
    date: clean(input.date),
    time: clean(input.time),
    name: clean(input.name),
    phone: clean(input.phone),
    email: clean(input.email).toLowerCase(),
    goal: typeof input.goal === 'string' ? input.goal.trim() : '',
  };

  // Step 1: service
  const service = services.find((s) => s.id === v.service);
  if (!service) errors.service = 'Please choose a service.';

  // Step 2: advisor (must cover the chosen service)
  const advisor = advisors.find((a) => a.id === v.advisor);
  if (!advisor) errors.advisor = 'Please choose an advisor.';
  else if (service && !advisor.services.includes(service.id)) {
    errors.advisor = `${advisor.name} does not cover ${service.title}. Please choose another advisor.`;
  }

  // Step 3: meeting type, date and time
  const meeting = meetingTypes.find((m) => m.id === v.meeting);
  if (!meeting) errors.meeting = 'Please choose in office or video call.';

  const validDateFormat = /^\d{4}-\d{2}-\d{2}$/.test(v.date) && toYMD(asUTC(v.date)) === v.date;
  if (!v.date || !validDateFormat) {
    errors.date = 'Please choose a date.';
  } else if (v.date < clock.date) {
    errors.date = 'That date has passed. Please choose another date.';
  } else if (!isWeekday(v.date)) {
    errors.date = 'We meet clients Monday to Friday. Please choose a weekday.';
  } else if (daysBetween(clock.date, v.date) > MAX_DAYS_AHEAD) {
    errors.date = `Please choose a date within the next ${MAX_DAYS_AHEAD} days.`;
  }

  const slot = SLOTS.find((s) => s.value === v.time);
  if (!slot) {
    errors.time = 'Please choose a time.';
  } else if (!errors.date && v.date === clock.date && slot.start < clock.minutes + MIN_NOTICE_MINUTES) {
    errors.time = 'That time is too soon or has passed. Please choose a later time.';
  }

  // Step 4: contact details
  if (!v.name) errors.name = 'Please enter your full name.';
  else if (v.name.length < 2 || v.name.length > 80 || !/^[\p{L}][\p{L}\p{M}\s'.-]*$/u.test(v.name)) {
    errors.name = 'Please enter your name using letters only.';
  }

  const phoneDigits = v.phone.replace(/\D/g, '');
  if (!v.phone) errors.phone = 'Please enter a phone number.';
  else if (!/^\+?[\d\s()-]+$/.test(v.phone) || phoneDigits.length < 7 || phoneDigits.length > 15) {
    errors.phone = 'Please enter a valid phone number, for example +971 50 123 4567.';
  }

  if (!v.email) errors.email = 'Please enter your email address.';
  else if (v.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.email)) {
    errors.email = 'Please enter a valid email address.';
  }

  if (/[\r\n]/.test(v.goal)) errors.goal = 'Please keep your goal to one line.';
  else if (v.goal.length > 120) errors.goal = 'Please keep your goal under 120 characters.';
  else if (/\d[\d\s-]{6,}\d/.test(v.goal)) {
    // Long digit runs look like account, card or Emirates ID numbers, which we never collect here.
    errors.goal = 'Please leave out account, card or ID numbers. We will never ask for them online.';
  }

  const booking = Object.keys(errors).length ? null : {
    ...v,
    serviceTitle: service.title,
    advisorName: advisor.credential ? `${advisor.name}, ${advisor.credential}` : advisor.name,
    advisorRole: advisor.role,
    meetingLabel: meeting.label,
    meetingDetail: meeting.detail,
    dateLabel: formatLongDate(v.date),
    timeLabel: slot.label,
  };
  return { errors, values: v, booking };
}

// Which wizard step a field belongs to (to reopen the form at the first problem).
const FIELD_STEP = { service: 1, advisor: 2, meeting: 3, date: 3, time: 3, name: 4, phone: 4, email: 4, goal: 4 };

function firstErrorStep(errors) {
  const steps = Object.keys(errors).map((f) => FIELD_STEP[f] || 1);
  return steps.length ? Math.min(...steps) : 1;
}

module.exports = {
  SLOTS, SLOT_MINUTES, MIN_NOTICE_MINUTES,
  nowInFirmTime, availableDates, slotsLeftToday, validateBooking, firstErrorStep, formatLongDate,
};
