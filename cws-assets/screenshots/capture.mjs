import puppeteer from 'puppeteer';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const screenshots = [
  { file: 'screenshot-1-hero.html', output: 'screenshot-1-hero.png' },
  { file: 'screenshot-2-profile.html', output: 'screenshot-2-profile.png' },
  { file: 'screenshot-3-company.html', output: 'screenshot-3-company.png' },
  { file: 'screenshot-4-loading.html', output: 'screenshot-4-loading.png' },
  { file: 'screenshot-5-privacy.html', output: 'screenshot-5-privacy.png' },
];

async function capture() {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });

  for (const { file, output } of screenshots) {
    const filePath = path.join(__dirname, file);
    await page.goto(`file://${filePath}`, { waitUntil: 'networkidle0', timeout: 15000 });
    // Wait for fonts to load
    await page.evaluate(() => document.fonts.ready);
    await new Promise(r => setTimeout(r, 1000)); // extra settle time for animations
    const outputPath = path.join(__dirname, output);
    await page.screenshot({ path: outputPath, type: 'png' });
    console.log(`Captured: ${output}`);
  }

  await browser.close();
  console.log('All screenshots captured!');
}

capture().catch(err => { console.error(err); process.exit(1); });
