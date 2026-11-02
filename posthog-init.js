(() => {
  // The consent bar's answer, kept on this device. "accepted" lets PostHog keep its cookie, so a
  // visit links up across pages and returns; until then (and after "declined") it runs in memory,
  // storing nothing, and each page view counts on its own.
  const CONSENT_KEY = 'cookie-consent';
  const readConsent = () => { try { return localStorage.getItem(CONSENT_KEY); } catch { return null; } };
  const saveConsent = value => { try { localStorage.setItem(CONSENT_KEY, value); } catch {} };
  const persistenceFor = consent => (consent === 'accepted' ? 'localStorage+cookie' : 'memory');

  window.capturePostHogEvent = (event, properties) => {
    if (window.posthog) {
      window.posthog.capture(event, properties);
      return;
    }
    window.addEventListener('posthog:ready', () => window.posthog.capture(event, properties), { once: true });
  };

  window.logPostHog = (level, message, attributes) => {
    const write = () => {
      const logger = window.posthog?.logger;
      if (typeof logger?.[level] === 'function') logger[level](message, attributes);
    };
    if (window.posthog) write();
    else window.addEventListener('posthog:ready', write, { once: true });
  };

  // A small white box in the corner, in the site's mono tag type, asked once per device.
  function showConsentBar() {
    const style = document.createElement('style');
    style.textContent = `
      .consent {
        position: fixed; z-index: 1000; left: 16px; bottom: 16px; width: min(340px, calc(100% - 32px));
        display: grid; gap: 12px; padding: 12px 14px;
        font: 300 12px/1.4 var(--mono, "GT America Mono", "DM Mono", ui-monospace, Menlo, monospace);
        text-transform: uppercase; color: #000; background: #fff; box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.12);
        animation: consent-in 0.4s ease both;
      }
      .consent p { margin: 0; }
      .consent-actions { display: flex; gap: 18px; }
      .consent button {
        padding: 0; border: 0; background: none; color: inherit; cursor: pointer;
        font: inherit; text-transform: inherit; transition: opacity 0.2s;
      }
      .consent button:hover { opacity: 0.5; }
      .consent button:focus-visible { outline: 1px solid; outline-offset: 3px; }
      @keyframes consent-in { from { opacity: 0; transform: translateY(6px); } }
      @media (prefers-reduced-motion: reduce) { .consent { animation: none; } }
    `;
    const bar = document.createElement('section');
    bar.className = 'consent';
    bar.setAttribute('aria-label', 'Cookie consent');
    bar.innerHTML = `
      <p>Cookies help me see which work gets opened. Decline and I only count anonymous visits.</p>
      <div class="consent-actions">
        <button type="button" data-choice="accepted">( Accept )</button>
        <button type="button" data-choice="declined">( Decline )</button>
      </div>`;
    bar.addEventListener('click', event => {
      const choice = event.target.closest('button')?.dataset.choice;
      if (!choice) return;
      saveConsent(choice);
      window.posthog?.set_config?.({ persistence: persistenceFor(choice) });
      bar.remove();
      style.remove();
    });
    document.head.appendChild(style);
    document.body.appendChild(bar);
  }

  function start(config) {
    const token = config?.POSTHOG_PROJECT_TOKEN;
    const host = config?.POSTHOG_HOST;

    if (!token || !host) {
      if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
        const variable = token ? 'POSTHOG_HOST' : 'POSTHOG_PROJECT_TOKEN';
        console.error(`${variable} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${variable} is configured`);
      }
      return;
    }

    // A page that must show nothing but its content (the private pitch pages in /for/) sets
    // window.__POSTHOG_QUIET__: no consent bar, so PostHog stays in memory and stores nothing.
    if (!readConsent() && !window.__POSTHOG_QUIET__) {
      if (document.body) showConsentBar();
      else document.addEventListener('DOMContentLoaded', showConsentBar, { once: true });
    }

    const script = document.createElement('script');
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.src = `${host.replace('.i.posthog.com', '-assets.i.posthog.com')}/static/array.js`;
    script.onload = () => {
      window.posthog.init(token, {
        api_host: host,
        defaults: '2026-08-30',
        persistence: persistenceFor(readConsent()),
        capture_exceptions: {
          capture_unhandled_errors: true,
          capture_unhandled_rejections: true,
          capture_console_errors: false,
        },
        logs: {
          serviceName: 'portfolio-web',
        },
      });
      window.logPostHog('info', 'portfolio client initialized', { runtime: 'browser' });
      window.dispatchEvent(new Event('posthog:ready'));
    };
    document.head.appendChild(script);
  }

  // The token and host are Vercel environment variables, served by /api/posthog-config. A page can
  // set window.__POSTHOG_ENV__ itself to skip the request (on the GitHub Pages copy there is no
  // /api, so PostHog and the consent bar stay off).
  if (window.__POSTHOG_ENV__) start(window.__POSTHOG_ENV__);
  else fetch('/api/posthog-config').then(r => (r.ok ? r.json() : null)).catch(() => null).then(start);
})();
