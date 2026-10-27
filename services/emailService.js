// All email code. Sends over SMTP with nodemailer, using settings from .env:
// SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM.
const nodemailer = require('nodemailer');
const { firm, deposit } = require('../lib/site-data');
const { describeConsultation } = require('../lib/consultation-view');
const consultationService = require('./consultationService');

const SENDER_NAME = firm.logoText; // "Northbridge Wealth"
const SIGN_OFF = `${firm.logoText} · built at ${firm.builtAt} · by ${firm.builtBy}`;

let transport = null;

function smtpSettings() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
  const missing = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_FROM'].filter((k) => !process.env[k]);
  if (missing.length) return { error: `missing ${missing.join(', ')}` };
  // SMTP_FROM may be "name@domain" or "Name <name@domain>"; we always send as the firm name.
  const fromAddress = (SMTP_FROM.match(/<([^>]+)>/) || [null, SMTP_FROM])[1].trim();
  const port = Number(SMTP_PORT);
  return {
    fromAddress,
    options: {
      host: SMTP_HOST,
      port,
      secure: port === 465, // 465 = TLS from the start; 587/2525 upgrade with STARTTLS
      auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
    },
  };
}

function getTransport(options) {
  if (!transport) transport = nodemailer.createTransport(options);
  return transport;
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Builds the subject, plain-text and HTML versions of the confirmation email. */
function buildConfirmationEmail(consultation) {
  const c = describeConsultation(consultation);
  const firstName = c.clientName.split(' ')[0];
  const where = c.meetingType === 'office'
    ? `Our office: ${firm.address}`
    : `${c.advisorName} will email you the video call link before the meeting.`;
  const rows = [
    ['Service', c.serviceTitle],
    ['Advisor', c.advisorName],
    ['Meeting type', c.meetingLabel],
    ['Date', c.dateLabel],
    ['Time', `${c.timeLabel} (UAE time, 45 minutes)`],
    [c.meetingType === 'office' ? 'Address' : 'Video link', c.meetingType === 'office' ? firm.address : 'Sent by your advisor before the meeting'],
    ['Reference', c.reference],
    ['Deposit', `${deposit.label} paid. ${deposit.description}`],
  ];

  const text = [
    `Dear ${firstName},`,
    '',
    'Your consultation is confirmed. Here are the details:',
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    where,
    '',
    `To change or cancel, call us on ${firm.phone}.`,
    '',
    'Information in this email is general and is not personal financial advice.',
    '',
    SIGN_OFF,
  ].join('\n');

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f4f1ea;font-family:Arial,Helvetica,sans-serif;color:#1d2733;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e6e1d6;">
    <tr><td style="background:#0b1b33;padding:22px 28px;color:#ffffff;font-family:Georgia,serif;font-size:20px;">
      ${escapeHtml(firm.logoText)}
    </td></tr>
    <tr><td style="padding:28px;">
      <p style="margin:0 0 6px;font-size:13px;letter-spacing:1px;text-transform:uppercase;color:#ad8b44;font-weight:bold;">Consultation confirmed</p>
      <p style="margin:0 0 18px;font-size:16px;">Dear ${escapeHtml(firstName)}, your consultation is confirmed.</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;border-collapse:collapse;">
        ${rows.map(([k, v]) => `<tr>
          <td style="padding:9px 0;border-bottom:1px solid #eee8dc;color:#5d6878;width:120px;vertical-align:top;">${escapeHtml(k)}</td>
          <td style="padding:9px 0;border-bottom:1px solid #eee8dc;font-weight:bold;color:#0b1b33;">${escapeHtml(v)}</td>
        </tr>`).join('')}
      </table>
      <p style="margin:18px 0 0;font-size:14px;">${escapeHtml(where)}</p>
      <p style="margin:12px 0 0;font-size:14px;">To change or cancel, call us on <a href="tel:${escapeHtml(firm.phone.replace(/\s/g, ''))}" style="color:#102544;">${escapeHtml(firm.phone)}</a>.</p>
    </td></tr>
    <tr><td style="padding:16px 28px;background:#fbfaf7;border-top:1px solid #e6e1d6;font-size:12px;color:#5d6878;">
      Information in this email is general and is not personal financial advice.<br>
      <span style="color:#8a93a1;">${escapeHtml(SIGN_OFF)}</span>
    </td></tr>
  </table>
</body></html>`;

  return { subject: 'Your consultation is confirmed', text, html };
}

// Sends one message to a consultation's client. Throws if SMTP fails.
async function deliver(settings, consultation, message) {
  return getTransport(settings.options).sendMail({
    from: { name: SENDER_NAME, address: settings.fromAddress },
    replyTo: settings.fromAddress,
    to: consultation.clientEmail,
    subject: message.subject,
    text: message.text,
    html: message.html,
  });
}

/**
 * Sends the "Your consultation is confirmed" email for a Booked consultation, once.
 * Never throws: failures are logged and the booking stays confirmed.
 * Returns 'sent', 'already-sent', 'not-configured' or 'failed'.
 */
async function sendBookingConfirmation(consultation) {
  const settings = smtpSettings();
  if (settings.error) {
    console.warn(`[email] confirmation for consultation ${consultation.id} not sent: SMTP not configured (${settings.error}).`);
    return 'not-configured';
  }

  // Only one request can claim the send, even if the success page is refreshed many times.
  const claimedAt = consultationService.claimConfirmationEmail(consultation.id);
  if (!claimedAt) return 'already-sent';

  try {
    const info = await deliver(settings, consultation, buildConfirmationEmail(consultation));
    console.log(`[email] confirmation for consultation ${consultation.id} sent to ${consultation.clientEmail} (${info.messageId})`);
    return 'sent';
  } catch (err) {
    // Allow a later attempt; the client still sees their booking as confirmed.
    consultationService.releaseConfirmationEmail(consultation.id, claimedAt);
    console.error(`[email] confirmation for consultation ${consultation.id} failed: ${err.message}`);
    return 'failed';
  }
}

// ---------------------------------------------------------------------------
// Reminder (sent by staff from /desk)
// ---------------------------------------------------------------------------
const REMINDER_PLACE = `${firm.logoText}, ${firm.area.split(',')[0]}`; // "Northbridge Wealth, Al Maryah Island"
const REMINDER_SIGN_OFF = `Powered by ${firm.builtAt} · built by ${firm.builtByFullName}`;

/** Builds the reminder email; the {placeholders} are filled from the booking. */
function buildReminderEmail(consultation) {
  const c = describeConsultation(consultation);
  const startTime = c.timeLabel.split(' – ')[0]; // "10:30am"
  const sentence = `Hi ${c.clientName}, a reminder that your ${c.serviceTitle} consultation with ${c.advisorName} `
    + `is on ${c.dateLabel} at ${startTime} (${c.meetingLabel}) with ${REMINDER_PLACE}. `
    + 'Bring any statements you’d like to discuss. Reply to reschedule.';

  const text = `${sentence}\n\n${REMINDER_SIGN_OFF}`;
  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f4f1ea;font-family:Arial,Helvetica,sans-serif;color:#1d2733;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e6e1d6;">
    <tr><td style="background:#0b1b33;padding:22px 28px;color:#ffffff;font-family:Georgia,serif;font-size:20px;">${escapeHtml(firm.logoText)}</td></tr>
    <tr><td style="padding:28px;font-size:15px;line-height:1.6;">${escapeHtml(sentence)}</td></tr>
    <tr><td style="padding:14px 28px;background:#fbfaf7;border-top:1px solid #e6e1d6;font-size:12px;color:#8a93a1;">${escapeHtml(REMINDER_SIGN_OFF)}</td></tr>
  </table>
</body></html>`;
  return { subject: 'Reminder: your consultation', text, html };
}

/**
 * Sends a reminder for a Booked consultation and records when it was sent.
 * Returns { ok: true, consultation } or { ok: false, reason: 'not-configured' | 'not-booked' | 'failed', error }.
 */
async function sendReminder(consultation) {
  if (!consultation || consultation.status !== 'Booked') return { ok: false, reason: 'not-booked' };
  const settings = smtpSettings();
  if (settings.error) {
    console.warn(`[email] reminder for consultation ${consultation.id} not sent: SMTP not configured (${settings.error}).`);
    return { ok: false, reason: 'not-configured', error: settings.error };
  }
  try {
    const info = await deliver(settings, consultation, buildReminderEmail(consultation));
    console.log(`[email] reminder for consultation ${consultation.id} sent to ${consultation.clientEmail} (${info.messageId})`);
    return { ok: true, consultation: consultationService.recordReminderSent(consultation.id) };
  } catch (err) {
    console.error(`[email] reminder for consultation ${consultation.id} failed: ${err.message}`);
    return { ok: false, reason: 'failed', error: err.message };
  }
}

module.exports = { sendBookingConfirmation, buildConfirmationEmail, sendReminder, buildReminderEmail };
