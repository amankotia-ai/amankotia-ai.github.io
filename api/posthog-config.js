// GET /api/posthog-config: the PostHog project token and host for /posthog-init.js, read from the
// POSTHOG_PROJECT_TOKEN and POSTHOG_HOST environment variables on Vercel. The project token is a
// public key (it can only send events), so the browser may see it; it lives in Vercel rather than
// the repo so it can change without a commit. Vercel's CDN keeps the answer, so this runs rarely.

function handler(req, res) {
  const token = process.env.POSTHOG_PROJECT_TOKEN;
  const host = process.env.POSTHOG_HOST;
  if (!token || !host) return res.status(404).json({ ok: false, error: 'Not configured.' });
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400');
  return res.status(200).json({ POSTHOG_PROJECT_TOKEN: token, POSTHOG_HOST: host });
}

module.exports = handler;
