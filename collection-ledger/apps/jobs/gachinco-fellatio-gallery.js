"use strict";

// Manually run to snapshot the three gallery listing pages and linked work pages.
const fs = require("node:fs");
const path = require("node:path");
const cheerio = require("cheerio");

const ROOT = path.resolve(__dirname, "../..");
const DIR = path.join(ROOT, "storage/imports/gachinco");
const INDEX = path.join(DIR, "fellatio-gallery-index.json");
const DETAILS = path.join(DIR, "fellatio-gallery-details.json");
const LISTING_URLS = [
  "https://fellatio.gallery/xxx/%E3%82%AC%E3%83%81%E9%9D%A2%E6%8E%A5",
  "https://fellatio.gallery/xxx/%E3%82%AC%E3%83%81%E9%9D%A2%E6%8E%A5/2",
  "https://fellatio.gallery/xxx/%E3%82%AC%E3%83%81%E9%9D%A2%E6%8E%A5/3",
];

function parseIndex(html, page, url) {
  const $ = cheerio.load(html);
  const rows = [];
  $("img[src*='4037-']").each((_, element) => {
    const source = $(element).attr("src") || "";
    const id = /4037-(\d+)/.exec(source);
    const href = $(element).closest("a").attr("href");
    if (!id || !href) throw new Error(`listing_row_incomplete:${page}`);
    rows.push({ page, number: Number(id[1]), image: new URL(source, url).href,
      alt: $(element).attr("alt") || "", detail: new URL(href, url).href });
  });
  return rows;
}

function parseDetail(html, row) {
  const $ = cheerio.load(html);
  const links = $(`a[href="/access/heydouga/4037/${row.number}"]`);
  const title = links.first().parent().text().replace(/\s+/g, " ").replace(/\s*ダウンロード.*$/, "").trim();
  const pageTitle = $("title").text().trim();
  const images = $("img[src*='4037-']").map((_, element) => $(element).attr("src")).get();
  return { ...row, title, pageTitle, accessLinks: links.length, imageMatches: images.filter((src) => new RegExp(`4037-${row.number}(?!\\d)`).test(src)).length };
}

async function main() {
  fs.mkdirSync(DIR, { recursive: true });
  const rows = [];
  for (let page = 1; page <= LISTING_URLS.length; page += 1) {
    const url = LISTING_URLS[page - 1];
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`listing_fetch_failed:${page}:${response.status}`);
    const html = await response.text();
    fs.writeFileSync(path.join(DIR, `fellatio-gallery-gachi-page${page}.html`), html);
    rows.push(...parseIndex(html, page, url));
  }
  if (!rows.length || new Set(rows.map((row) => row.number)).size !== rows.length) throw new Error("listing_missing_or_duplicate_4037_number");
  fs.writeFileSync(INDEX, JSON.stringify(rows, null, 2) + "\n");
  const result = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    try {
      const response = await fetch(row.detail, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`http_${response.status}`);
      result.push(parseDetail(await response.text(), row));
    } catch (error) {
      result.push({ ...row, error: String(error.message || error) });
    }
    if ((i + 1) % 10 === 0 || i + 1 === rows.length) {
      fs.writeFileSync(DETAILS, JSON.stringify(result, null, 2) + "\n");
      process.stdout.write(`${i + 1}/${rows.length} titles=${result.filter((item) => item.title).length} failures=${result.filter((item) => item.error).length}\n`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });

module.exports = { parseDetail, parseIndex };
