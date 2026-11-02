// POST /api/brief: a project brief from /contact, filed in Attio.
// The Attio key lives only in the ATTIO_API_KEY environment variable on Vercel; the page never sees it.
// Each brief becomes a person (matched on email), a company (matched on domain, when given),
// a deal at the first stage with Budget, Timeline, Offer and Source filled, the brief as a note
// on the deal and on the person, and a task assigned to Abhishek.
// Token scopes: record_permission:read-write, object_configuration:read, note:read-write,
// task:read-write, user_management:read.

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
    botcheck: b.botcheck === true,
  };
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

async function file(b) {
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
    `**Needs:** ${b.needs.join(', ') || 'Not given'}`,
    `**Budget:** ${b.budget || 'Not given'}`,
    `**Timeline:** ${b.timeline || 'Not given'}`,
    `**Company website:** ${b.company || 'Not given'}`,
    `**From:** ${b.name}, ${b.email}`,
    b.message ? `**Message:**\n\n${b.message}` : '**Message:** none',
    `Sent from the contact page, brief No. ${b.serial}.`,
  ];
  // The brief goes on the deal and, so it shows where replies land, on the person too.
  const note = { title: 'Website brief', format: 'markdown', content: lines.join('\n\n') };
  await attio('POST', '/notes', { parent_object: 'deals', parent_record_id: dealId, ...note });
  await attio('POST', '/notes', { parent_object: 'people', parent_record_id: personId, ...note });

  await attio('POST', '/tasks', {
    content: clip(`Reply to ${b.name} (${b.email}): new brief for ${b.needs.join(', ') || 'a project'}; budget ${b.budget || 'not given'}; timeline ${b.timeline || 'not given'}.`, 2000),
    format: 'plaintext',
    deadline_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
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
  if (!process.env.ATTIO_API_KEY) return res.status(500).json({ ok: false, error: 'Not configured.' });

  try {
    await file(b);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err.message);
    return res.status(502).json({ ok: false, error: 'Could not file the brief.' });
  }
}

module.exports = handler;
module.exports.domainOf = domainOf;
module.exports.readBrief = readBrief;
