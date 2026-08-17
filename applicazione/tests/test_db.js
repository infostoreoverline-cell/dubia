const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  page.on('console', msg => console.log('BROWSER LOG:', msg.text()));

  await page.goto('http://localhost:3000');
  await page.waitForLoadState('networkidle');

  // Let's expose appState
  await page.evaluate(() => {
    window._testAppState = appState;
  });

  await page.evaluate(() => {
     appState.measurements = [];
     appState.params.manualCalibrations = {};
  });

  await page.click('#fabAdd');
  await page.fill('#inputWeight', '1000');
  await page.fill('#inputFoodAmount', '0');
  await page.evaluate(() => {
     document.querySelector('#entryForm button[type="submit"]').click();
  });
  await page.waitForTimeout(1000);

  let counts = await page.evaluate(() => {
      return {
          female: document.getElementById('countFemale').innerText,
          male: document.getElementById('countMale').innerText,
          subadult: document.getElementById('countSubAdult').innerText,
          medium: document.getElementById('countMedium').innerText,
          small: document.getElementById('countSmall').innerText,
          baby: document.getElementById('countBaby').innerText,
      };
  });
  console.log('BEFORE CALIBRATION:', counts);


  await page.click('button[data-target="census"]');
  await page.waitForTimeout(500);

  // Click Avvia Calibrazione
  await page.click('#btnCalibrate');
  await page.waitForTimeout(500);

  // Fill in the form
  await page.selectOption('#calibCategory', 'FEMALE');
  await page.fill('#calibCount', '50');

  // Submit calibration
  await page.evaluate(() => {
     document.querySelector('#calibrationForm button[type="submit"]').click();
  });
  await page.waitForTimeout(1500);

  // Need to call updateUI to trigger recalculation, though the modal should have done it
  await page.evaluate(() => {
     updateUI();
  });

  counts = await page.evaluate(() => {
      return {
          female: document.getElementById('countFemale').innerText,
          male: document.getElementById('countMale').innerText,
          subadult: document.getElementById('countSubAdult').innerText,
          medium: document.getElementById('countMedium').innerText,
          small: document.getElementById('countSmall').innerText,
          baby: document.getElementById('countBaby').innerText,
      };
  });
  console.log('AFTER CALIBRATION:', counts);

  const calibs = await page.evaluate(() => {
    return window._testAppState.params.manualCalibrations;
  });
  console.log('MANUAL CALIBRATIONS:', calibs);

  await context.close();
  await browser.close();
})();
