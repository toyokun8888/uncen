"use strict";

const puppeteer = require("puppeteer");

async function main() {
  const browser = await puppeteer.launch({ headless: true });
  const failedResponses = [];
  const consoleErrors = [];
  try {
    const page = await browser.newPage();
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(error.message));
    page.on("response", (response) => {
      if (response.status() >= 400) failedResponses.push({ status: response.status(), url: response.url() });
    });
    await page.goto("http://127.0.0.1:5173/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction(() => document.body.textContent.includes("Completion"), { timeout: 60000 });
    await page.evaluate(() => {
      const button = Array.from(document.querySelectorAll("button")).find((item) => item.textContent.includes("Completion"));
      if (!button) throw new Error("completion_button_not_found");
      button.click();
    });
    await page.waitForSelector(".completion-page", { timeout: 60000 });
    await page.waitForFunction(() => Array.from(document.querySelectorAll(".site-row")).some((item) => item.textContent.includes("H0930")), { timeout: 60000 });
    await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll(".site-row")).find((item) => item.textContent.includes("H0930"));
      if (!row) throw new Error("h0930_site_row_not_found");
      row.click();
    });
    await page.waitForFunction(() => document.body.textContent.includes("ori1802"), { timeout: 60000 });
    const brandText = await page.$eval(".ledger-brand", (element) => element.textContent);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      brand_text: brandText,
      has_h0930: await page.evaluate(() => document.body.textContent.includes("H0930")),
      has_ori1802: await page.evaluate(() => document.body.textContent.includes("ori1802")),
      failed_responses: failedResponses,
      console_errors: consoleErrors,
    }, null, 2)}\n`);
    if (failedResponses.length || consoleErrors.length) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
