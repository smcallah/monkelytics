const pages = {
  '/': [
    'See your visits appear.',
    'Browse these pages, try an event, then open Monkelytics to see what was recorded.',
  ],
  '/explore': [
    'A new page. Another view.',
    'This is a separate pageview. Try the event button here, then compare it with your visit to the home page.',
  ],
  '/about': [
    'Small site. Real signals.',
    'This demo uses the real tracker and collection API. It has no sign-up forms, external fonts, or third-party scripts.',
  ],
};
const [heading, intro] = pages[location.pathname] || pages['/'];
document.title = `${heading} | Monkelytics Demo`;
document.getElementById('heading').textContent = heading;
document.getElementById('intro').textContent = intro;
for (const link of document.querySelectorAll('nav a')) {
  if (link.getAttribute('href') === location.pathname) link.setAttribute('aria-current', 'page');
}
const status = document.getElementById('status');
const button = document.getElementById('sample-event');

async function start() {
  const response = await fetch('/config.json');
  if (!response.ok) throw new Error('Demo configuration unavailable');
  const { websiteId, analyticsUrl } = await response.json();
  const dashboard = document.getElementById('dashboard');
  dashboard.href = `${analyticsUrl}/websites/${websiteId}`;
  dashboard.hidden = false;
  const script = document.createElement('script');
  script.src = `${analyticsUrl}/script.js`;
  script.referrerPolicy = 'no-referrer';
  script.dataset.websiteId = websiteId;
  script.dataset.autoTrack = 'false';
  script.dataset.queryStringPolicy = 'allowlist';
  script.dataset.queryStringAllowlist = 'utm_source,utm_medium,utm_campaign';
  await new Promise((resolve, reject) => {
    script.onload = resolve;
    script.onerror = () => reject(new Error('Tracker could not be loaded'));
    document.head.append(script);
  });
  if (!window.umami) throw new Error('Tracker unavailable');
  await window.umami.track();
  status.textContent = 'Tracker loaded. Pageview requested — check the dashboard for delivery.';
  button.disabled = false;
  button.addEventListener('click', async () => {
    await window.umami.track('demo_button_click', { button: 'sample', page: location.pathname });
    status.textContent = 'demo_button_click requested. Look for it in the dashboard’s Events view.';
  });
}
start().catch(() => {
  status.textContent =
    'Tracker unavailable. Check that the analytics server is reachable, then reload.';
});
