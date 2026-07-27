const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  
  page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
  page.on('pageerror', err => console.log('BROWSER ERROR:', err.toString()));
  
  await page.goto('http://localhost:5173/login');
  await page.type('input[type="text"]', 'testuser_1780031060422'); // we need a valid user
  await page.type('input[type="password"]', 'password');
  await page.click('button[type="submit"]');
  
  await page.waitForNavigation();
  await page.goto('http://localhost:5173/api-keys');
  await new Promise(r => setTimeout(r, 2000));
  
  await browser.close();
})();
