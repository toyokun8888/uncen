"use strict";

const puppeteer = require("puppeteer");

function parseArgs(argv) {
  const args = {
    url: "http://127.0.0.1:5173/",
    source: "10musume",
    expectedText: "天然むすめ",
    expectedLibraryCode: "050626_01",
    expectedCompletionCode: "060426_01",
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--url") args.url = argv[++i];
    else if (arg.startsWith("--url=")) args.url = arg.slice(6);
    else if (arg === "--source") args.source = argv[++i];
    else if (arg.startsWith("--source=")) args.source = arg.slice(9);
    else if (arg === "--expected-text") args.expectedText = argv[++i];
    else if (arg.startsWith("--expected-text=")) args.expectedText = arg.slice(16);
    else if (arg === "--expected-library-code") args.expectedLibraryCode = argv[++i];
    else if (arg.startsWith("--expected-library-code=")) args.expectedLibraryCode = arg.slice(24);
    else if (arg === "--expected-completion-code") args.expectedCompletionCode = argv[++i];
    else if (arg.startsWith("--expected-completion-code=")) args.expectedCompletionCode = arg.slice(27);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

async function waitForElementText(page, selector, text) {
  await page.waitForFunction(
    (targetSelector, expected) => Array.from(document.querySelectorAll(targetSelector))
      .some((element) => element.textContent.includes(expected)),
    { timeout: 60000 },
    selector,
    text
  );
}

async function main() {
  const args = parseArgs(process.argv);
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

    await page.goto(args.url, { waitUntil: "networkidle2", timeout: 60000 });
    await page.select(".library-controls select", args.source);
    await waitForElementText(page, ".card-id", args.expectedLibraryCode);

    const brandText = await page.$eval(".ledger-brand", (element) => element.textContent);
    const appError = await page.$eval(".app-error", (element) => element.innerText).catch(() => "");

    await page.$eval(".ledger-tabs nav button:nth-child(2)", (button) => button.click());
    await page.waitForFunction(
      () => document.querySelector(".ledger-tabs nav button:nth-child(2)")?.classList.contains("active"),
      { timeout: 60000 }
    );
    await page.waitForSelector(".completion-page", { timeout: 60000 });
    await waitForElementText(page, ".completion-code", args.expectedCompletionCode);

    if (appError) throw new Error(`Browser app error: ${appError}`);
    if (!brandText.includes(args.expectedText)) throw new Error(`Missing site text: ${args.expectedText}`);
    if (failedResponses.length) throw new Error(`HTTP failures: ${JSON.stringify(failedResponses.slice(0, 10))}`);
    if (consoleErrors.length) throw new Error(`Console errors: ${JSON.stringify(consoleErrors.slice(0, 10))}`);

    process.stdout.write(`${JSON.stringify({
      ok: true,
      url: args.url,
      source: args.source,
      library_code: args.expectedLibraryCode,
      completion_code: args.expectedCompletionCode,
      console_errors: consoleErrors.length,
      failed_responses: failedResponses.length,
    }, null, 2)}\n`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
