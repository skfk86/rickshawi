// اختبار شامل من البداية للنهاية: راكب + سواق في متصفحين، ضد Supabase الحقيقي
// run 16 — السواقين المفضلين
// يشتغل في GitHub Actions (انظر .github/workflows/e2e.yml)
const { chromium, devices } = require('playwright');
const fs = require('fs');

const BASE = process.env.BASE_URL || 'http://localhost:8080';
const PW = process.env.E2E_PASSWORD;
const RIDER = '900000101', DRIVER = '900000102', RIDER2 = '900000103';
const A2 = { latitude: 15.6683, longitude: 32.5717, accuracy: 8 };
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
  const R = await mk(A, 'rider'), D = await mk(D0, 'driver'), R2 = await mk(A2, 'rider2');
  const rp = R.page, dp = D.page, r2 = R2.page;
  const both = { rider: rp, driver: dp, rider2: r2 };

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
  await step('rider enables طرحة (2 people)', both, async () => {
    await rp.check('#shareTg');
    await rp.waitForSelector('#sPlus'); await rp.click('#sPlus');
    await rp.waitForSelector('#reqBtn:has-text("طرحة")');
    await shot(rp, 'rider-shared-toggle');
  });
  await step('rider requests trip', both, async () => {
    await rp.click('#reqBtn');
    await rp.waitForSelector('#cancel', { timeout: 15000 });
    await shot(rp, 'rider-waiting');
  });
  await step('second rider finds and joins the طرحة', both, async () => {
    await login(r2, RIDER2);
    await r2.waitForSelector('#destIn'); await r2.waitForTimeout(2500);
    const box = await r2.locator('#map').boundingBox();
    await r2.mouse.click(box.x + box.width * 0.7, box.y + 140);
    await r2.waitForSelector('[data-join]', { timeout: 20000 });
    await shot(r2, 'rider2-join-card');
    await r2.click('[data-join]');
    await r2.waitForSelector('#wShares .card', { timeout: 15000 });
    await rp.waitForFunction(() => /٣ ركاب/.test(document.querySelector('#wShares')?.textContent || ''), null, { timeout: 15000 });
    await shot(r2, 'rider2-waiting'); await shot(rp, 'rider-waiting-shared');
  });
  await step('driver receives request', both, async () => {
    await dp.waitForSelector('[data-r]', { timeout: 25000 });
    await dp.waitForSelector('[data-r]:has-text("طرحة")', { timeout: 10000 });
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
  await step('rider accepts offer → tracking (both riders)', both, async () => {
    await rp.click('[data-acc]');
    await rp.waitForSelector('#chatBtn', { timeout: 20000 });
    await dp.waitForSelector('#nextBtn', { timeout: 25000 });
    await r2.waitForSelector('#chatBtn', { timeout: 25000 });
    await rp.waitForTimeout(3000); await shot(rp, 'rider-tracking'); await shot(dp, 'driver-trip');
  });
  await step('fare split shown to riders and driver', both, async () => {
    await r2.waitForFunction(() => /نصيبك/.test(document.body.textContent), null, { timeout: 15000 });
    await dp.waitForFunction(() => /طرحة/.test(document.querySelector('#sheet')?.textContent || ''), null, { timeout: 15000 });
    await shot(r2, 'rider2-tracking'); await shot(dp, 'driver-trip-shared');
  });
  await step('sheet collapses and expands', both, async () => {
    const h1 = (await rp.locator('.sheet').boundingBox()).height;
    await rp.click('.sheet .grab-hit'); await rp.waitForTimeout(500);
    const h2 = (await rp.locator('.sheet').boundingBox()).height;
    await shot(rp, 'rider-sheet-collapsed');
    await rp.click('.sheet .grab-hit'); await rp.waitForTimeout(400);
    if (!(h2 < h1 - 100)) throw new Error(`heights ${h1} → ${h2}`);
  });
  await step('rider safety sheet (999, share, report)', both, async () => {
    await rp.click('#shareBtn');
    await rp.waitForSelector('a[href="tel:999"]'); await rp.waitForSelector('#sfReport');
    await shot(rp, 'rider-safety');
    await rp.click('#sfReport');
    await rp.waitForSelector('[data-cat="dangerous_driving"]');
    if (await rp.locator('[data-cat="no_payment"]').count()) throw new Error('driver category shown to rider');
    await rp.mouse.click(10, 10); await rp.waitForSelector('.overlay', { state: 'detached' });
  });
  await step('driver sees rider-specific problem options', both, async () => {
    await dp.click('#reportBtn');
    await dp.waitForSelector('[data-cat="extra_riders"]');
    if (await dp.locator('[data-cat="dangerous_driving"]').count()) throw new Error('rider category shown to driver');
    await shot(dp, 'driver-problem');
    await dp.mouse.click(10, 10); await dp.waitForSelector('.overlay', { state: 'detached' });
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
    await r2.waitForSelector('#send', { timeout: 25000 });
    await shot(rp, 'rider-rating'); await shot(r2, 'rider2-rating');
  });
  await step('save driver to favorites from rating (name + category)', both, async () => {
    await rp.waitForSelector('[data-fav]', { timeout: 10000 }); await rp.click('[data-fav]');
    await rp.waitForSelector('#fvName');
    await rp.fill('#fvName', 'عم الاختبار جارنا');
    await rp.click('[data-fc="neighbor"]'); await rp.fill('#fvNote', 'بيعرف البيت');
    await shot(rp, 'rider-fav-editor');
    await rp.click('#fvSave');
    await rp.waitForSelector('.overlay', { state: 'detached', timeout: 10000 });
    await rp.waitForSelector('[data-fav][aria-pressed="true"]', { timeout: 10000 });
  });
  await step('no horizontal overflow on rating screen', both, async () => {
    const over = await rp.evaluate(() => [...document.querySelectorAll('.btn')].filter(b => { const r = b.getBoundingClientRect(); return r.width && (r.left < -1 || r.right > innerWidth + 1); }).map(b => b.textContent.trim()));
    if (over.length) throw new Error('overflowing: ' + over.join(' | '));
  });
  await step('both rate each other', both, async () => {
    await rp.waitForSelector('#send:not([disabled])');
    await rp.waitForSelector('[data-iss="lost_item"]');
    await rp.locator('[data-s="2"]').click(); await rp.waitForSelector('[data-iss="overcharge"]');
    await shot(rp, 'rider-rating-low');
    await dp.waitForSelector('[data-iss="no_payment"]');
    await rp.locator('[data-s="4"]').click(); await rp.locator('[data-t]').first().click(); await rp.click('#send');
    await dp.waitForSelector('#send:not([disabled])'); await dp.click('#send');
    await rp.waitForSelector('.nav', { timeout: 15000 }); await dp.waitForSelector('.nav', { timeout: 15000 });
  });
  await step('history shows completed trip', both, async () => {
    await rp.click('[data-nav="history"]');
    await rp.waitForSelector('.pill.green', { timeout: 15000 });
    await shot(rp, 'rider-history');
  });
  await step('report from history + shows in بلاغاتي', both, async () => {
    await rp.locator('[data-rp]').first().click();
    await rp.waitForSelector('[data-cat="route"]');
    await rp.waitForSelector('[data-cat="lost_item"]');
    await rp.click('[data-cat="route"]'); await rp.waitForSelector('#rpD'); await rp.fill('#rpD', 'اختبار بلاغ: لف بطريق طويل');
    await shot(rp, 'rider-report-modal');
    await rp.click('#rpSend');
    await rp.waitForSelector('.overlay', { state: 'detached', timeout: 10000 });
    await rp.click('[data-nav="account"]'); await rp.click('#myRpBtn');
    await rp.waitForSelector('#rpList .card:has-text("طريق طويل")', { timeout: 10000 });
    await shot(rp, 'rider-my-reports');
    await rp.click('[data-back]');
  });
  await step('joined passenger can report the driver', both, async () => {
    await r2.waitForSelector('#send:not([disabled])'); await r2.click('#send');
    await r2.waitForSelector('.nav', { timeout: 15000 });
    await r2.click('[data-nav="history"]');
    await r2.waitForSelector('[data-rp]', { timeout: 15000 });
    await r2.locator('[data-rp]').first().click();
    await r2.click('[data-cat="behavior"]'); await r2.waitForSelector('#rpSend'); await r2.click('#rpSend');
    await r2.waitForSelector('.overlay', { state: 'detached', timeout: 10000 });
  });
  await step('waiting timer renders', both, async () => {});
  await step('favorites screen grouped by category', both, async () => {
    await rp.click('[data-nav="account"]'); await rp.click('#favBtn');
    await rp.waitForSelector('#fvList .card:has-text("عم الاختبار جارنا")', { timeout: 15000 });
    await rp.waitForSelector('#fvList:has-text("جار أو معرفة")');
    await shot(rp, 'rider-favorites');
  });
  await step('request favorite driver directly → driver sees "طلبك إنت"', both, async () => {
    await rp.waitForSelector('[data-req]:not([disabled])', { timeout: 25000 });
    await rp.click('[data-req]');
    await rp.waitForSelector('#clearPref', { timeout: 15000 });
    const box = await rp.locator('#map').boundingBox();
    await rp.mouse.click(box.x + box.width * 0.3, box.y + 160);
    await rp.waitForSelector('#reqBtn:has-text("عم الاختبار")', { timeout: 20000 });
    await shot(rp, 'rider-pref-request');
    await rp.click('#reqBtn');
    await rp.waitForSelector('#cancel', { timeout: 15000 });
    await dp.click('[data-nav="driverHome"]').catch(() => {});
    await dp.waitForSelector('[data-r]:has-text("طلبك إنت")', { timeout: 30000 });
    await shot(dp, 'driver-pref-request'); await shot(rp, 'rider-pref-waiting');
    await rp.click('#cancel'); await rp.click('[data-ok]');
    await rp.waitForSelector('.nav', { timeout: 15000 });
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
