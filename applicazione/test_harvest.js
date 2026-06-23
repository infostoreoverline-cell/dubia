const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    recordVideo: {
      dir: '/home/jules/verification/videos',
      size: { width: 1280, height: 720 }
    }
  });
  const page = await context.newPage();

  // Create verification dirs if they don't exist
  if (!fs.existsSync('/home/jules/verification/screenshots')){
      fs.mkdirSync('/home/jules/verification/screenshots', { recursive: true });
  }

  await page.goto('http://localhost:3000');
  await page.waitForLoadState('networkidle');

  // Go to the 'census' tab
  await page.click('button[data-target="census"]');
  await page.waitForTimeout(500);

  // Set an amount for the harvest
  await page.fill('#harvestAmount', '50');
  await page.waitForTimeout(500);

  // Click the 'Conferma Prelievo Ora' button
  await page.click('#btnConfirmHarvestSim');
  await page.waitForTimeout(500);

  // Take screenshot of the modal
  await page.screenshot({ path: '/home/jules/verification/screenshots/harvest_modal.png' });

  // Confirm the action in the modal
  await page.click('#btnConfirmSimHarvestAction');
  await page.waitForTimeout(1000); // Wait for processing and UI update

  await page.screenshot({ path: '/home/jules/verification/screenshots/harvest_completed.png' });

  await context.close();
  await browser.close();
  console.log("Playwright test completed.");
})();
