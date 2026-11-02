(() => {
  const config = window.__POSTHOG_ENV__;
  const token = config?.POSTHOG_PROJECT_TOKEN;
  const host = config?.POSTHOG_HOST;

  if (!token || !host) {
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
      const variable = token ? 'POSTHOG_HOST' : 'POSTHOG_PROJECT_TOKEN';
      throw new Error(`${variable} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${variable} is configured`);
    }
    return;
  }

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

  const script = document.createElement('script');
  script.async = true;
  script.crossOrigin = 'anonymous';
  script.src = `${host.replace('.i.posthog.com', '-assets.i.posthog.com')}/static/array.js`;
  script.onload = () => {
    window.posthog.init(token, {
      api_host: host,
      defaults: '2026-08-30',
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
})();
