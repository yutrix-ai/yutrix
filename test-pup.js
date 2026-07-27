const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
  page.on('pageerror', err => console.log('BROWSER ERROR:', err.toString()));
  
  await page.goto('http://localhost:5173/login');
  await page.type('input[type="text"]', 'test');
  await page.type('input[type="password"]', '123456');
  await page.click('button[type="submit"]');
  
  await page.waitForNavigation();
  console.log('Navigated to:', page.url());
  
  await page.goto('http://localhost:5173/api-keys');
  console.log('Navigated to /api-keys');
  
  await new Promise(r => setTimeout(r, 2000));
  
  await browser.close();
})();
