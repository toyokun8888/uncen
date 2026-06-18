"use strict";

const path = require("path");
const puppeteer = require("puppeteer");

async function main() {
  const browser = await puppeteer.launch({ headless: true });
  const consoleErrors = [];
  const failedResponses = [];
  try {
    const page = await browser.newPage();
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(error.message));
    page.on("response", (response) => {
      if (response.status() >= 400) failedResponses.push({ status: response.status(), url: response.url() });
    });

    await page.goto("http://127.0.0.1:5173/", { waitUntil: "networkidle2", timeout: 60000 });
    await page.select(".library-controls select", "tokyo_hot");
    await page.waitForFunction(() => document.body.innerText.includes("東京熱"), { timeout: 60000 });
    await page.screenshot({
      path: path.resolve("storage", "exports", "tokyo_hot", "tokyo_hot_library_after_explicit_folders.png"),
      fullPage: true,
    });

    const bodyText = await page.evaluate(() => document.body.innerText);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      has_tokyo_hot: bodyText.includes("東京熱"),
      has_error_text: bodyText.includes("読み込みに失敗") || bodyText.includes("エラー"),
      console_errors: consoleErrors,
      failed_responses: failedResponses,
      screenshot: "storage/exports/tokyo_hot/tokyo_hot_library_after_explicit_folders.png",
    }, null, 2)}\n`);

    if (consoleErrors.length || failedResponses.length) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
