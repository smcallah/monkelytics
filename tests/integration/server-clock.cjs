// Loaded only through the integration Compose overlay, never imported by the app.
const { readFileSync } = require('node:fs');
const RealDate = Date;
const clockFile = '/tmp/monkelytics-identity-clock';

function now() {
  try {
    const value = Number(readFileSync(clockFile, 'utf8'));
    if (!Number.isFinite(value)) throw new Error('Invalid integration clock');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return RealDate.now();
    throw error;
  }
}

global.Date = new Proxy(RealDate, {
  construct(target, args, newTarget) {
    return Reflect.construct(target, args.length ? args : [now()], newTarget);
  },
  apply() {
    return new RealDate(now()).toString();
  },
  get(target, key, receiver) {
    return key === 'now' ? now : Reflect.get(target, key, receiver);
  },
});
