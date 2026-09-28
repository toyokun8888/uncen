"use strict";

const TITLE_COLLATOR = new Intl.Collator("ja", { numeric: true, sensitivity: "base" });

function compareNight24Titles(a, b) {
  return TITLE_COLLATOR.compare(String(a.title || ""), String(b.title || "")) ||
    String(a.movie_code || "").localeCompare(String(b.movie_code || ""));
}

function recognitionIdNumber(value) {
  const match = String(value || "").match(/^ngt(\d{3,})$/);
  return match ? Number(match[1]) : 0;
}

function formatRecognitionId(number) {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("invalid_recognition_id_number");
  return "ngt" + String(number).padStart(3, "0");
}

function buildRecognitionPlan(masters, mappings) {
  const mappedCodes = new Set();
  const mappedIds = new Set();
  let maximum = 0;
  for (const row of mappings) {
    const number = recognitionIdNumber(row.recognition_id);
    if (!number) throw new Error("invalid_existing_recognition_id:" + row.recognition_id);
    const id = String(row.recognition_id);
    const code = String(row.movie_code);
    if (mappedIds.has(id) || mappedCodes.has(code)) throw new Error("duplicate_existing_recognition_mapping:" + id);
    mappedIds.add(id);
    mappedCodes.add(code);
    maximum = Math.max(maximum, number);
  }

  const missing = masters.filter((row) => !mappedCodes.has(String(row.movie_code))).slice().sort(compareNight24Titles);
  return missing.map((row, index) => ({
    recognition_id: formatRecognitionId(maximum + index + 1),
    movie_code: String(row.movie_code),
    title: String(row.title || ""),
  }));
}

module.exports = { buildRecognitionPlan, compareNight24Titles, formatRecognitionId, recognitionIdNumber };