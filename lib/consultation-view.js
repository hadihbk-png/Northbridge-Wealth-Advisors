// Turns a stored consultation into readable labels for the pages.
const { services, advisors, meetingTypes } = require('./site-data');
const { formatLongDate } = require('./booking');

const to12h = (minutes) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}${h >= 12 ? 'pm' : 'am'}`;
};

const reference = (id) => `NB-${String(id).padStart(6, '0')}`;

function describeConsultation(c) {
  const service = services.find((s) => s.id === c.service);
  const advisor = advisors.find((a) => a.id === c.advisor);
  const meeting = meetingTypes.find((m) => m.id === c.meetingType);
  const date = c.consultationDateTime.slice(0, 10);
  const [h, m] = c.consultationDateTime.slice(11, 16).split(':').map(Number);
  const start = h * 60 + m;
  return {
    ...c,
    reference: reference(c.id),
    serviceTitle: service ? service.title : c.service,
    serviceIcon: service ? service.icon : 'bi-calendar',
    advisorName: advisor ? `${advisor.name}${advisor.credential ? `, ${advisor.credential}` : ''}` : c.advisor,
    advisorRole: advisor ? advisor.role : '',
    meetingLabel: meeting ? meeting.label : c.meetingType,
    meetingDetail: meeting ? meeting.detail : '',
    dateLabel: formatLongDate(date),
    timeLabel: `${to12h(start)} – ${to12h(start + 45)}`,
  };
}

module.exports = { describeConsultation, reference };
