import puppeteer from 'puppeteer';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const tiles = [
  { file: 'small-promo-440x280.html', output: 'small-promo-440x280.png', width: 440, height: 280 },
  { file: 'large-promo-920x680.html', output: 'large-promo-920x680.png', width: 920, height: 680 },
];

async function capture() {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  for (const { file, output, width, height } of tiles) {
    await page.setViewport({ width, height, deviceScaleFactor: 2 });
    const filePath = path.join(__dirname, file);
    await page.goto(`file://${filePath}`, { waitUntil: 'networkidle0', timeout: 15000 });
    await page.evaluate(() => document.fonts.ready);
    await new Promise(r => setTimeout(r, 1000));
    const outputPath = path.join(__dirname, output);
    await page.screenshot({ path: outputPath, type: 'png' });
    console.log(`Captured: ${output} (${width}x${height})`);
  }

  await browser.close();
  console.log('All promo tiles captured!');
}

capture().catch(err => { console.error(err); process.exit(1); });
