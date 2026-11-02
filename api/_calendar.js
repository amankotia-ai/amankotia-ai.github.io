// Google Calendar for the contact page's 30 minute calls: the open times, and the booking itself.
// Not an endpoint (Vercel skips files in api/ that start with an underscore); /api/slots and
// /api/brief use it.
// It acts as Abhishek's Google account through an OAuth refresh token held only in environment
// variables on Vercel (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN); the page never
// sees them. Scopes: calendar.freebusy (busy times only, never what the events are) and
// calendar.events (to write the booking). The OAuth app must be published "In production", or
// Google expires the refresh token after seven days.
// A time is open when it falls inside the booking hours and no calendar in GOOGLE_BUSY_CALENDARS
// is busy within the buffer either side: meetings, blocks, focus time and out of office all count,
// as do all-day events marked Busy. Bookings land in GOOGLE_CALENDAR_ID with a Meet link, and
// Google emails the invite.

const { createHash } = require('crypto');

const API = 'https://www.googleapis.com/calendar/v3';
const MINUTES = 30;
const ZONE = process.env.BOOKING_ZONE || 'Asia/Kolkata';
const BOOK_INTO = process.env.GOOGLE_CALENDAR_ID || 'primary';
const CHECK = [...new Set([BOOK_INTO, ...(process.env.GOOGLE_BUSY_CALENDARS || '').split(',').map(s => s.trim()).filter(Boolean)])];
const num = (v, d) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : d);
const NOTICE = num(process.env.BOOKING_NOTICE_HOURS, 12) * 3600e3;    // nothing sooner than this
const BUFFER = num(process.env.BOOKING_BUFFER_MINUTES, 15) * 60e3;    // clear time around other meetings
const DAYS_AHEAD = num(process.env.BOOKING_DAYS_AHEAD, 14);
const HOURS = parseHours(process.env.BOOKING_HOURS || 'mon-fri 14:00-24:00');   // 2 pm to midnight in Bengaluru

// "mon-fri 14:00-24:00; sat 11:00-13:00" -> { 1: [[840, 1440]], ..., 6: [[660, 780]] } (minutes, in ZONE).
// 24:00 is midnight at the end of the day.
function parseHours(text) {
  const DAY = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const hours = {};
  for (const part of text.toLowerCase().split(';')) {
    const m = part.trim().match(/^([a-z]{3})(?:-([a-z]{3}))?\s+(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
    if (!m) continue;
    const from = DAY.indexOf(m[1]), to = DAY.indexOf(m[2] || m[1]);
    if (from < 0 || to < 0) continue;
    for (let d = from; ; d = (d + 1) % 7) {
      (hours[d] ||= []).push([+m[3] * 60 + +m[4], Math.min(+m[5] * 60 + +m[6], 1440)]);
      if (d === to) break;
    }
  }
  return hours;
}

const configured = () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN);

// Wall-clock time in ZONE to an instant. Two passes settle the offset across a DST change.
const wall = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
});
function partsAt(ms) {
  const p = Object.fromEntries(wall.formatToParts(new Date(ms)).map(x => [x.type, +x.value]));
  return { y: p.year, m: p.month, d: p.day, ms: Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) };
}
function instant(y, m, d, minutes) {
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  let ms = guess - (partsAt(guess).ms - guess);
  ms = guess - (partsAt(ms).ms - ms);
  return ms;
}

let access = { token: '', until: 0 };
async function token() {
  if (access.until > Date.now() + 60e3) return access.token;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google token: ${res.status} ${json.error || ''}`.trim());
  access = { token: json.access_token, until: Date.now() + json.expires_in * 1000 };
  return access.token;
}

async function google(method, path, data) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
    body: data ? JSON.stringify(data) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(`Google ${method} ${path.split('?')[0]}: ${res.status} ${json.error?.message || ''}`.trim()), { status: res.status });
  }
  return json;
}

// Busy intervals across every checked calendar, widened by the buffer. A calendar that can't be
// read fails the whole check: better to offer no times than a time that isn't free.
async function busy(from, to) {
  const json = await google('POST', '/freeBusy', {
    timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), items: CHECK.map(id => ({ id })),
  });
  const out = [];
  for (const [id, cal] of Object.entries(json.calendars || {})) {
    if (cal.errors?.length) throw new Error(`Google freeBusy ${id}: ${cal.errors.map(e => e.reason).join(', ')}`);
    for (const b of cal.busy || []) out.push([Date.parse(b.start) - BUFFER, Date.parse(b.end) + BUFFER]);
  }
  return out;
}

// Every open start time, as ISO strings in UTC, from NOTICE ahead to DAYS_AHEAD days out.
async function openSlots(now = Date.now()) {
  const earliest = now + NOTICE, len = MINUTES * 60e3, today = partsAt(now);
  const starts = [];
  for (let i = 0; i <= DAYS_AHEAD; i++) {
    const day = new Date(Date.UTC(today.y, today.m - 1, today.d + i));
    for (const [open, close] of HOURS[day.getUTCDay()] || []) {
      for (let t = open; t + MINUTES <= close; t += MINUTES) {
        const s = instant(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), t);
        if (s >= earliest) starts.push(s);
      }
    }
  }
  if (!starts.length) return [];
  const blocked = await busy(starts[0], starts[starts.length - 1] + len);
  return starts.filter(s => !blocked.some(([a, b]) => s < b && s + len > a)).map(s => new Date(s).toISOString());
}

// Book a call. The slot is checked against the calendar again first; a slot that has gone since
// the page loaded throws with taken: true. The event id comes from the brief, the email and the
// time, so a retried request finds its own booking instead of making a second one.
async function book({ start, name, email, serial, summary, description }) {
  const ms = Date.parse(start);
  if (!Number.isFinite(ms)) throw Object.assign(new Error('Not a time.'), { taken: true });
  const iso = new Date(ms).toISOString(), end = new Date(ms + MINUTES * 60e3).toISOString();
  const id = createHash('sha256').update(`${serial}|${email}|${iso}`).digest('hex').slice(0, 32);
  const cal = encodeURIComponent(BOOK_INTO);
  const result = e => ({ start: iso, end, zone: ZONE, meet: e.hangoutLink || '', event: e.htmlLink || '' });

  if (!(await openSlots()).includes(iso)) {
    const mine = await google('GET', `/calendars/${cal}/events/${id}`).catch(() => null);
    if (mine && mine.status !== 'cancelled') return result(mine);
    throw Object.assign(new Error('Slot is not open.'), { taken: true });
  }
  const event = {
    id, summary, description,
    start: { dateTime: iso, timeZone: ZONE },
    end: { dateTime: end, timeZone: ZONE },
    attendees: [{ email, displayName: name }],
    reminders: { useDefault: true },
    extendedProperties: { private: { source: 'amankotia.com/contact', brief: serial } },
  };
  const insert = `/calendars/${cal}/events?sendUpdates=all`;
  try {
    return result(await google('POST', `${insert}&conferenceDataVersion=1`, {
      ...event, conferenceData: { createRequest: { requestId: id, conferenceSolutionKey: { type: 'hangoutsMeet' } } },
    }));
  } catch (err) {
    if (err.status === 409) return result(await google('GET', `/calendars/${cal}/events/${id}`));
    // An account that can't make Meet links still gets the booking, without one.
    if (err.status === 400) { console.error(err.message); return result(await google('POST', insert, event)); }
    throw err;
  }
}

module.exports = { MINUTES, ZONE, configured, openSlots, book, parseHours, instant };
