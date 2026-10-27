// Firm details, services and advisors used across the site. Edit these to update every page.

const firm = {
  name: 'Northbridge Wealth Advisors',
  logoText: 'Northbridge Wealth', // shorter name shown in the navbar logo
  area: 'Al Maryah Island, Abu Dhabi',
  tagline: 'Clear advice for every stage of life',
  regulatory: 'Licensed by the SCA, licence no. 000000',
  address: 'Tower X, Al Maryah Island, Abu Dhabi',
  phone: '+971 2 000 0000',
  timeZone: 'Asia/Dubai',
  hours: [
    { days: 'Monday – Friday', time: '9:00am – 6:00pm' },
    { days: 'Saturday – Sunday', time: 'Closed' },
  ],
  builtAt: 'London International · lisrc.ae',
  builtBy: 'Hadi',
  builtByFullName: 'Hadi Dina', // used in the reminder email sign-off
};

// Refundable consultation deposit, paid by card through Stripe and credited to the first planning fee.
const deposit = {
  amount: 25000, // in fils, Stripe's smallest unit for AED (25000 = AED 250.00)
  currency: 'aed',
  label: 'AED 250',
  name: 'Consultation deposit',
  description: 'Refundable deposit, credited to your first planning fee.',
};

const services = [
  {
    id: 'retirement',
    icon: 'bi-sunrise',
    title: 'Retirement Planning',
    text: 'Work out what you need to retire comfortably and build a steady plan to get there.',
  },
  {
    id: 'investment',
    icon: 'bi-graph-up-arrow',
    title: 'Investment Planning',
    text: 'A diversified portfolio matched to your goals, timeline and comfort with risk.',
  },
  {
    id: 'education',
    icon: 'bi-mortarboard',
    title: 'Education Planning',
    text: "Save steadily for your children's school and university fees, in the UAE or abroad.",
  },
  {
    id: 'protection',
    icon: 'bi-shield-check',
    title: 'Protection & Insurance',
    text: 'Life, health and income cover so your family stays secure whatever happens.',
  },
];

// Each advisor lists the services they cover.
const advisors = [
  {
    id: 'sara-ahmed',
    name: 'Sara Ahmed',
    credential: 'CFP',
    role: 'Retirement Planning Specialist',
    services: ['retirement'],
    languages: 'English, Arabic',
  },
  {
    id: 'omar-khan',
    name: 'Omar Khan',
    credential: 'CFA',
    role: 'Investment Planning Specialist',
    services: ['investment'],
    languages: 'English, Urdu, Arabic',
  },
  {
    id: 'lina-haddad',
    name: 'Lina Haddad',
    credential: '',
    role: 'Education Planning Specialist',
    services: ['education'],
    languages: 'English, Arabic, French',
  },
  {
    id: 'raj-mehta',
    name: 'Raj Mehta',
    credential: '',
    role: 'Protection & Insurance Specialist',
    services: ['protection'],
    languages: 'English, Hindi',
  },
];

const meetingTypes = [
  { id: 'office', label: 'In office', icon: 'bi-building', detail: firm.address },
  { id: 'video', label: 'Video call', icon: 'bi-camera-video', detail: 'We email you a secure link before the meeting' },
];

module.exports = { firm, services, advisors, meetingTypes, deposit };
