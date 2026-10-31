// اختبار شامل من البداية للنهاية: راكب + سواق في متصفحين، ضد Supabase الحقيقي
// run 7
// يشتغل في GitHub Actions (انظر .github/workflows/e2e.yml)
const { chromium, devices } = require('playwright');
const fs = require('fs');

const BASE = process.env.BASE_URL || 'http://localhost:8080';
const PW = process.env.E2E_PASSWORD;
const RIDER = '900000101', DRIVER = '900000102';
const A = { latitude: 15.6680, longitude: 32.5714, accuracy: 8 };
const D0 = { latitude: 15.6684, longitude: 32.5704, accuracy: 8 };
fs.mkdirSync('shots', { recursive: true });

const results = []; const errors = [];
let shotN = 0;
async function shot(page, name) { shotN++; await page.screenshot({ path: `shots/${String(shotN).padStart(2, '0')}-${name}.png` }).catch(() => {}); }

async function step(name, pages, fn) {
  const t = Date.now();
  try { await fn(); results.push({ name, ok: true, ms: Date.now() - t }); console.log(`::notice::PASS ${name}`); }
  catch (e) {
    results.push({ name, ok: false, err: String(e.message || e).split('\n')[0] });
    console.log(`::error::FAIL ${name}: ${String(e.message || e).split('\n')[0]}`);
    for (const [k, p] of Object.entries(pages)) await shot(p, `FAIL-${name}-${k}`);
  }
}

(async () => {
  const browser = await chromium.launch();
  const mk = async (geo, label) => {
    const ctx = await browser.newContext({ ...devices['Pixel 7'], geolocation: geo, permissions: ['geolocation'], locale: 'ar' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`[${label}] pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${label}] console: ${m.text()}`); });
    return { ctx, page };
  };
  const R = await mk(A, 'rider'), D = await mk(D0, 'driver');
  const rp = R.page, dp = D.page;
  const both = { rider: rp, driver: dp };

  const login = async (p, phone) => {
    await p.goto(BASE);
    await p.waitForSelector('#phone', { timeout: 20000 });
    await p.fill('#phone', phone); await p.fill('#pass', PW);
    await p.click('#authBtn');
    await p.waitForSelector('.nav', { timeout: 25000 });
  };

  await step('rider login', both, async () => { await login(rp, RIDER); await rp.waitForSelector('#destIn'); await rp.waitForTimeout(3000); await shot(rp, 'rider-home'); });
  await step('map tiles load', both, async () => {
    const n = await rp.locator('.leaflet-tile-loaded').count();
    if (n < 2) throw new Error('tiles loaded: ' + n);
  });
  await step('driver login + switch to driver mode', both, async () => {
    await login(dp, DRIVER);
    await dp.click('[data-nav="account"]');
    await dp.click('#modeSw');
    await dp.waitForSelector('#onlineBtn', { timeout: 20000 });
  });
  await step('driver goes online', both, async () => {
    await dp.waitForTimeout(1500);
    if ((await dp.textContent('#onLbl')) !== 'متاح') await dp.click('#onlineBtn');
    await dp.waitForFunction(() => document.querySelector('#onLbl')?.textContent === 'متاح', null, { timeout: 15000 });
    await dp.waitForTimeout(2500); await shot(dp, 'driver-online');
  });
  await step('rider sees nearby rickshaw', both, async () => {
    await rp.waitForTimeout(11000); // دورة تحديث السواقين
    await rp.waitForSelector('.driver-item', { timeout: 15000 });
    await shot(rp, 'rider-nearby');
  });
  await step('rider picks destination on map + route + price', both, async () => {
    const box = await rp.locator('#map').boundingBox();
    await rp.mouse.click(box.x + box.width * 0.7, box.y + 140);
    await rp.waitForSelector('#reqBtn', { timeout: 20000 });
    await rp.waitForTimeout(1500); await shot(rp, 'rider-price');
  });
  await step('rider requests trip', both, async () => {
    await rp.click('#reqBtn');
    await rp.waitForSelector('#cancel', { timeout: 15000 });
    await shot(rp, 'rider-waiting');
  });
  await step('driver receives request', both, async () => {
    await dp.waitForSelector('[data-r]', { timeout: 25000 });
    await shot(dp, 'driver-request');
  });
  await step('driver counter-offer reaches rider', both, async () => {
    await dp.click('[data-r]');
    await dp.waitForSelector('[data-c]', { timeout: 5000 });
    await shot(dp, 'driver-modal');
    await dp.locator('[data-c]').first().click();
    await rp.waitForSelector('[data-acc]', { timeout: 20000 });
    await shot(rp, 'rider-offer');
  });
  await step('rider accepts offer → tracking', both, async () => {
    await rp.click('[data-acc]');
    await rp.waitForSelector('#chatBtn', { timeout: 20000 });
    await dp.waitForSelector('#nextBtn', { timeout: 25000 });
    await rp.waitForTimeout(3000); await shot(rp, 'rider-tracking'); await shot(dp, 'driver-trip');
  });
  await step('in-app route & ETA shown to driver', both, async () => {
    await dp.waitForFunction(() => /د/.test(document.querySelector('#navInfo')?.textContent || ''), null, { timeout: 20000 });
  });
  await step('chat rider → driver', both, async () => {
    await rp.click('#chatBtn');
    await rp.waitForSelector('#cIn');
    await rp.fill('#cIn', 'أنا قدام الباب الأزرق');
    await rp.press('#cIn', 'Enter');
    await dp.click('#chatBtn');
    await dp.waitForSelector('.bubble.them:has-text("الباب الأزرق")', { timeout: 15000 });
  });
  await step('chat driver → rider (quick reply + location)', both, async () => {
    await dp.locator('[data-q]').first().click();
    await dp.click('#sendLoc');
    await rp.waitForSelector('.bubble.them a[href*="maps.google.com"]', { timeout: 20000 });
    await shot(rp, 'rider-chat'); await shot(dp, 'driver-chat');
  });
  await step('trip stages arriving → arrived → started', both, async () => {
    await dp.click('[data-back]'); await rp.click('[data-back]');
    for (let i = 0; i < 3; i++) {
      await dp.waitForSelector('#nextBtn:not([disabled])', { timeout: 15000 });
      await dp.click('#nextBtn'); await dp.waitForTimeout(1500);
    }
    await dp.waitForSelector('#mKm', { timeout: 15000 });
    await rp.waitForSelector('#mKm', { timeout: 20000 });
  });
  await step('meter counts distance while moving', both, async () => {
    const pts = [[15.6690, 32.5716], [15.6698, 32.5719], [15.6706, 32.5723], [15.6714, 32.5727], [15.6722, 32.5730]];
    for (const [la, lo] of pts) { await D.ctx.setGeolocation({ latitude: la, longitude: lo, accuracy: 8 }); await dp.waitForTimeout(1500); }
    const km = parseFloat((await dp.textContent('#mKm')).replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace('٫', '.'));
    if (!(km > 0.3)) throw new Error('meter km=' + km);
    await shot(dp, 'driver-meter');
    await rp.waitForTimeout(14000); await shot(rp, 'rider-meter');
  });
  await step('driver completes trip → rating screens', both, async () => {
    await dp.click('#nextBtn');
    await dp.click('[data-ok]');
    await dp.waitForSelector('#send', { timeout: 15000 });
    await rp.waitForSelector('#send', { timeout: 25000 });
    await shot(rp, 'rider-rating');
  });
  await step('both rate each other', both, async () => {
    await rp.waitForSelector('#send:not([disabled])'); await rp.locator('[data-s="4"]').click(); await rp.locator('[data-t]').first().click(); await rp.click('#send');
    await dp.waitForSelector('#send:not([disabled])'); await dp.click('#send');
    await rp.waitForSelector('.nav', { timeout: 15000 }); await dp.waitForSelector('.nav', { timeout: 15000 });
  });
  await step('history shows completed trip', both, async () => {
    await rp.click('[data-nav="history"]');
    await rp.waitForSelector('.pill.green', { timeout: 15000 });
    await shot(rp, 'rider-history');
  });
  await step('support chat', both, async () => {
    await rp.click('[data-nav="account"]');
    await rp.click('#supportBtn');
    await rp.waitForSelector('#sIn');
    await rp.fill('#sIn', 'اختبار الدعم الفني'); await rp.press('#sIn', 'Enter');
    await rp.waitForSelector('.bubble.me:has-text("اختبار الدعم")', { timeout: 10000 });
    await shot(rp, 'rider-support');
  });
  await step('driver earnings screen', both, async () => {
    await dp.click('[data-nav="earnings"]');
    await dp.waitForSelector('#renew, #sub .card', { timeout: 15000 });
    await shot(dp, 'driver-earnings');
  });

  await browser.close();
  const passed = results.filter(r => r.ok).length;
  const md = [`# E2E — ${passed}/${results.length} passed`, '', ...results.map(r => `- ${r.ok ? '✅' : '❌'} ${r.name}${r.ok ? ` (${r.ms}ms)` : ` — ${r.err}`}`),
    '', '## Browser errors', ...(errors.length ? [...new Set(errors)].slice(0, 40).map(e => '- ' + e) : ['- none'])].join('\n');
  fs.writeFileSync('shots/REPORT.md', md);
  console.log(md);
  for (const e of [...new Set(errors)].slice(0, 15)) console.log(`::warning::${e.slice(0, 300)}`);
  process.exit(0);
})();
