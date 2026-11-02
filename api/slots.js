// GET /api/slots: the open 30 minute call times for /contact, read from Google Calendar through
// api/_calendar.js. Never cached: a time booked a moment ago must not be offered again.
// Until the Google variables are set on Vercel it answers 404 and the page leaves the call out.

const calendar = require('./_calendar');

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Use GET.' });
  if (!calendar.configured()) return res.status(404).json({ ok: false, error: 'Not configured.' });
  try {
    const slots = await calendar.openSlots();
    return res.status(200).json({ ok: true, minutes: calendar.MINUTES, zone: calendar.ZONE, slots });
  } catch (err) {
    console.error(err.message);
    return res.status(502).json({ ok: false, error: 'Could not read the calendar.' });
  }
}

module.exports = handler;
