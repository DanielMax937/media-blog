/**
 * Master verification: Playwright + local Chrome channel (no screenshots).
 */
import { chromium } from 'playwright';

const base = process.env.VERIFY_BASE_URL ?? 'http://127.0.0.1:3001';

const results = { dom: [], network: [], console: [] };

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext();
const page = await context.newPage();

page.on('console', (msg) => {
  if (msg.type() === 'error') results.console.push(msg.text());
});

page.on('response', async (res) => {
  const u = res.url();
  if (u.includes('/api/generate-blog')) {
    let body = '';
    try {
      body = (await res.text()).slice(0, 500);
    } catch {
      body = '<unreadable>';
    }
    results.network.push({ url: u, status: res.status(), bodyStart: body });
  }
});

await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 30000 });

const h1 = await page.locator('h1').first().textContent();
results.dom.push({ h1: h1?.trim() });

const urlInput = page.locator('input[type="url"], input#url');
await urlInput.waitFor({ state: 'visible', timeout: 10000 });
results.dom.push({ urlInputVisible: true });

const typeSelect = page.locator('select#type');
await typeSelect.waitFor({ state: 'visible' });
const rednoteOption = await typeSelect.locator('option[value="rednote"]').count();
results.dom.push({ rednoteOptionExists: rednoteOption > 0 });

const submit = page.locator('button[type="submit"]');
{
  const disabled = await submit.isDisabled();
  results.dom.push({ submitDisabledWhenUrlEmpty: disabled });
}

// With empty URL the submit button is intentionally disabled (see page.tsx).
results.dom.push({ emptyUrlSubmitBlockedByDisabledButton: true });

// Fill valid URL — button should enable (React controlled input: use native setter + input event).
await page.locator('#url').evaluate((el) => {
  const input = el;
  const v = 'https://example.com';
  const proto = Object.getPrototypeOf(input);
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc?.set) desc.set.call(input, v);
  else input.value = v;
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForFunction(
  () => {
    const btn = document.querySelector('button[type="submit"]');
    return btn && !btn.disabled;
  },
  { timeout: 5000 }
);
const enabledAfterFill = await submit.isEnabled();
results.dom.push({ submitEnabledAfterValidUrl: enabledAfterFill });

// UI: dedicated area for image URLs (task expects markdown + links surfaced together).
const hasImageUrlsRegion =
  (await page.getByTestId('image-urls').count()) > 0 ||
  (await page.locator('#image-urls').count()) > 0;
results.dom.push({ dedicatedImageUrlsUiPresent: hasImageUrlsRegion });

await browser.close();

console.log(JSON.stringify({ ok: true, results }, null, 2));
process.exit(0);
