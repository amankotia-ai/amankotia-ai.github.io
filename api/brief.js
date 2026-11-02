// POST /api/brief: a project brief from /contact, filed in Attio.
// The Attio key lives only in the ATTIO_API_KEY environment variable on Vercel; the page never sees it.
// Each brief becomes a person (matched on email), a company (matched on domain, when given),
// a deal at the first stage with Budget, Timeline, Offer and Source filled, the brief as a note
// on the deal and on the person, and a task assigned to Abhishek.
// Token scopes: record_permission:read-write, object_configuration:read, note:read-write,
// task:read-write, user_management:read.
// A brief that rings a time (slot) also books a 30 minute call in Google Calendar (api/_calendar.js)
// before it is filed; the call's time goes in the note and the task.

const calendar = require('./_calendar');

const ATTIO = 'https://api.attio.com/v2';
const OWNER = process.env.ATTIO_OWNER_EMAIL || 'hello@amankotia.com';
const STAGE = process.env.ATTIO_DEAL_STAGE || 'Lead';
// Custom deal fields, by attribute ID so renaming a field in Attio can't break the form.
const FIELD = {
  budget: 'adfca14d-9dcf-445b-abc1-078a21b6fd2c',   // Budget (status)
  timeline: '748db1e4-0840-4e55-8ffa-e6627bbd5ef1', // Timeline (select)
  offer: 'd9b2dcee-45b6-4e21-8ceb-8de3aa581dd5',    // Offer (multi-select)
  source: 'b1fa910d-325f-4a12-ad54-724f21d696f1',   // Source (select)
};
// The form's tick boxes, as the Offer options the outreach deals use.
const OFFER_OF = {
  'Brand and website rebuild': 'Site rebuild',
  'Launch or explainer film': 'Launch film',
  'Pitch deck to a first version': 'First version',
  'Product demo or walkthrough': 'Demo videos',
  'Something else': 'Something else',
};
const ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://www.amankotia.com,https://amankotia.com')
  .split(',').map(s => s.trim()).filter(Boolean);

const clip = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// "https://www.Acme.com/about" -> "acme.com"; anything that isn't a plain domain -> ''.
function domainOf(site) {
  const host = clip(site, 200).toLowerCase().replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0].replace(/^www\./, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : '';
}

function readBrief(body) {
  const b = body && typeof body === 'object' ? body : {};
  return {
    name: clip(b.name, 200),
    email: clip(b.email, 200).toLowerCase(),
    company: clip(b.company, 200),
    needs: (Array.isArray(b.needs) ? b.needs : []).map(n => clip(n, 60)).filter(Boolean).slice(0, 6),
    budget: clip(b.budget, 40),
    timeline: clip(b.timeline, 40),
    message: clip(b.message, 5000),
    serial: clip(String(b.serial ?? ''), 20),
    slot: clip(b.slot, 40),
    zone: zoneOf(clip(b.zone, 60)),
    botcheck: b.botcheck === true,
  };
}

// The visitor's time zone, when it is one Intl knows.
function zoneOf(tz) {
  try { return tz ? new Intl.DateTimeFormat('en-GB', { timeZone: tz }).resolvedOptions().timeZone : ''; }
  catch (e) { return ''; }
}
// "Tue 4 Nov, 15:30 (Bengaluru), 10:00 (London)"; the visitor's date shows only when it differs.
function callTime(iso, zone) {
  const at = tz => new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz }).format(new Date(iso));
  const city = tz => (tz === 'Asia/Kolkata' ? 'Bengaluru' : (tz.split('/').pop() || tz).replace(/_/g, ' '));
  const mine = at(calendar.ZONE), theirs = zone ? at(zone) : mine;
  if (theirs === mine) return `${mine} (${city(calendar.ZONE)})`;
  const sameDay = theirs.split(', ')[0] === mine.split(', ')[0];
  return `${mine} (${city(calendar.ZONE)}), ${sameDay ? theirs.split(', ')[1] : theirs} (${city(zone)})`;
}

// The brief as label and value pairs, for the Attio note and the calendar invite.
function briefLines(b) {
  return [
    ['Needs', b.needs.join(', ') || 'Not given'],
    ['Budget', b.budget || 'Not given'],
    ['Timeline', b.timeline || 'Not given'],
    ['Company website', b.company || 'Not given'],
    ['From', `${b.name}, ${b.email}`],
  ];
}

async function attio(method, path, data) {
  const res = await fetch(`${ATTIO}${path}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.ATTIO_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Attio ${method} ${path.split('?')[0]}: ${res.status} ${json.message || ''}`.trim());
  return json.data;
}

const ref = (object, id) => [{ target_object: object, target_record_id: id }];

async function file(b, call) {
  const domain = domainOf(b.company);
  const company = domain
    ? await attio('PUT', '/objects/companies/records?matching_attribute=domains', { values: { domains: [domain] } })
    : null;
  const companyId = company?.id?.record_id;

  const [first, ...rest] = b.name.split(/\s+/);
  const person = await attio('PUT', '/objects/people/records?matching_attribute=email_addresses', {
    values: {
      email_addresses: [b.email],
      name: [{ first_name: first || '', last_name: rest.join(' '), full_name: b.name }],
      ...(companyId ? { company: ref('companies', companyId) } : {}),
    },
  });
  const personId = person.id.record_id;

  const offers = [...new Set(b.needs.map(n => OFFER_OF[n]).filter(Boolean))];
  // Named like the outreach deals, "Company · Offer"; the person stands in when no site is given.
  // The brief number is only for the page's receipt, so it stays in the note.
  const base = {
    name: `${domain || b.name} · ${offers.join(' + ') || 'Project'}`,
    stage: STAGE,
    owner: OWNER,
    associated_people: ref('people', personId),
    ...(companyId ? { associated_company: ref('companies', companyId) } : {}),
  };
  const fields = {
    ...(b.budget ? { [FIELD.budget]: b.budget } : {}),
    ...(b.timeline ? { [FIELD.timeline]: b.timeline } : {}),
    ...(offers.length ? { [FIELD.offer]: offers } : {}),
    [FIELD.source]: 'Website form',
  };
  let deal;
  try {
    deal = await attio('POST', '/objects/deals/records', { values: { ...base, ...fields } });
  } catch (err) {
    // A changed or removed field must never lose a brief: file it without them (the note has it all).
    console.error(err.message);
    deal = await attio('POST', '/objects/deals/records', { values: base });
  }
  const dealId = deal.id.record_id;

  const lines = [
    ...briefLines(b).map(([k, v]) => `**${k}:** ${v}`),
    ...(call ? [`**Call:** ${callTime(call.start, b.zone)}${call.meet ? `, ${call.meet}` : ''}`] : []),
    b.message ? `**Message:**\n\n${b.message}` : '**Message:** none',
    `Sent from the contact page, brief No. ${b.serial}.`,
  ];
  // The brief goes on the deal and, so it shows where replies land, on the person too.
  const note = { title: 'Website brief', format: 'markdown', content: lines.join('\n\n') };
  await attio('POST', '/notes', { parent_object: 'deals', parent_record_id: dealId, ...note });
  await attio('POST', '/notes', { parent_object: 'people', parent_record_id: personId, ...note });

  // A booked call is due when it starts; a plain brief wants a reply within a day.
  const about = `${b.needs.join(', ') || 'a project'}; budget ${b.budget || 'not given'}; timeline ${b.timeline || 'not given'}.`;
  await attio('POST', '/tasks', {
    content: clip(call
      ? `Call with ${b.name} (${b.email}) on ${callTime(call.start, '')}: brief for ${about}`
      : `Reply to ${b.name} (${b.email}): new brief for ${about}`, 2000),
    format: 'plaintext',
    deadline_at: call ? call.start : new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    is_completed: false,
    linked_records: ref('deals', dealId),
    assignees: [{ workspace_member_email_address: OWNER }],
  });
  return dealId;
}

async function handler(req, res) {
  const origin = req.headers.origin;
  if (origin && ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Use POST.' });
  if (origin && !ORIGINS.includes(origin)) return res.status(403).json({ ok: false, error: 'Origin not allowed.' });

  const b = readBrief(req.body);
  // The page's hidden checkbox: only bots tick it. Answer as if it worked and file nothing.
  if (b.botcheck) return res.status(200).json({ ok: true });
  if (!b.name || !EMAIL_RE.test(b.email) || !b.needs.length) {
    return res.status(400).json({ ok: false, error: 'A name, a valid email and at least one need are required.' });
  }
  if (!b.slot && !process.env.ATTIO_API_KEY) return res.status(500).json({ ok: false, error: 'Not configured.' });

  // The call first: if the time has gone, nothing is filed and the page offers the times that are left.
  let call = null;
  if (b.slot) {
    if (!calendar.configured()) return res.status(503).json({ ok: false, error: 'Booking is not set up.' });
    try {
      call = await calendar.book({
        start: b.slot, name: b.name, email: b.email, serial: b.serial,
        summary: `Abhishek Mankotia and ${b.name}`,
        description: [
          ...briefLines(b).map(([k, v]) => `${k}: ${v}`),
          ...(b.message ? ['', b.message] : []),
          '', `Booked on amankotia.com/contact, brief No. ${b.serial}.`,
        ].join('\n'),
      });
    } catch (err) {
      if (err.taken) return res.status(409).json({ ok: false, taken: true, error: 'That time is no longer free.' });
      console.error(err.message);
      return res.status(502).json({ ok: false, error: 'Could not book the call.' });
    }
  }

  try {
    if (process.env.ATTIO_API_KEY) await file(b, call);
  } catch (err) {
    console.error(err.message);
    // A booked call already holds the brief in its invite, so only a plain brief has failed.
    if (!call) return res.status(502).json({ ok: false, error: 'Could not file the brief.' });
  }
  return res.status(200).json({ ok: true, ...(call ? { call: { start: call.start, end: call.end, meet: call.meet } } : {}) });
}

module.exports = handler;
module.exports.domainOf = domainOf;
module.exports.readBrief = readBrief;
module.exports.callTime = callTime;
