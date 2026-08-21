// scripts/manage-devotion.js
// Handles three actions via the Apps Script API (not a local devotions.json
// file): edit scripture (reruns AI), edit date (move, no AI).

const fs = require("fs");
const path = require("path");

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const WRITE_API_KEY = process.env.WRITE_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ISSUE_BODY = process.env.ISSUE_BODY || "";
const ISSUE_NUMBER = process.env.ISSUE_NUMBER || "unknown";
const ISSUE_AUTHOR = process.env.ISSUE_AUTHOR || "";

// Update this if you ever change your GitHub username.
const OWNER_USERNAME = "jeffryfriginal";

if (ISSUE_AUTHOR.toLowerCase() !== OWNER_USERNAME.toLowerCase()) {
  console.log(`Issue author "${ISSUE_AUTHOR}" is not the site owner. Skipping.`);
  process.exit(0);
}

// (APPS_SCRIPT_URL / WRITE_API_KEY are checked inside callAppsScript, not
// here, so this script can still safely no-op on non-management issues.)

function extractField(body, label) {
  const re = new RegExp(`### ${label}\\s*\\n+([\\s\\S]*?)(?=\\n### |$)`, "i");
  const match = body.match(re);
  if (!match) return "";
  const value = match[1].trim();
  return value === "_No response_" ? "" : value;
}

async function callAppsScript(action, payload) {
  if (!APPS_SCRIPT_URL || !WRITE_API_KEY) {
    throw new Error("Missing APPS_SCRIPT_URL or WRITE_API_KEY env var. Nothing was changed.");
  }

  const response = await fetch(APPS_SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: WRITE_API_KEY, action, ...payload }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Apps Script HTTP error ${response.status}: ${text}`);
  }

  const data = await response.json();
  if (!data.success) {
    throw new Error(data.error);
  }
  return data;
}

// --- Scripture normalization (same logic as generate-devotion.js) --------

const BIBLE_BOOKS = [
  "1 Chronicles", "2 Chronicles", "1 Corinthians", "2 Corinthians",
  "1 John", "2 John", "3 John", "1 Kings", "2 Kings", "1 Peter", "2 Peter",
  "1 Samuel", "2 Samuel", "1 Thessalonians", "2 Thessalonians",
  "1 Timothy", "2 Timothy", "Song of Solomon", "Song of Songs",
  "Genesis", "Exodus", "Leviticus", "Numbers", "Deuteronomy", "Joshua",
  "Judges", "Ruth", "Ezra", "Nehemiah", "Esther", "Job", "Psalm", "Psalms",
  "Proverbs", "Ecclesiastes", "Isaiah", "Jeremiah", "Lamentations",
  "Ezekiel", "Daniel", "Hosea", "Joel", "Amos", "Obadiah", "Jonah",
  "Micah", "Nahum", "Habakkuk", "Zephaniah", "Haggai", "Zechariah",
  "Malachi", "Matthew", "Mark", "Luke", "John", "Acts", "Romans",
  "Galatians", "Ephesians", "Philippians", "Colossians", "Titus",
  "Philemon", "Hebrews", "James", "Jude", "Revelation", "Revelations",
].sort((a, b) => b.length - a.length);

// A real book name + chapter:verse is short. Cap the prefix so a whole
// paragraph ending in a verse number can't be mistaken for 'reference-first'.
const MAX_REF_PREFIX_LEN = 30;

function normalizeScripture(input) {
  const cleaned = input.replace(/\s+/g, " ").trim();

  const alreadyFormatted = new RegExp(
    `^.{1,${MAX_REF_PREFIX_LEN}}?\\d{1,3}:\\d{1,3}(-\\d{1,3})?\\s*-\\s*\\S`
  ).test(cleaned);
  if (alreadyFormatted) return cleaned;

  const refFirstMatch = cleaned.match(
    new RegExp(`^(.{1,${MAX_REF_PREFIX_LEN}}?\\d{1,3}:\\d{1,3}(-\\d{1,3})?)\\s+(\\S.*)$`)
  );
  if (refFirstMatch) {
    const [, reference, , rest] = refFirstMatch;
    return `${reference} - ${rest}`;
  }

  const bareRefMatch = cleaned.match(
    new RegExp(`^.{1,${MAX_REF_PREFIX_LEN}}?\\d{1,3}:\\d{1,3}(-\\d{1,3})?$`)
  );
  if (bareRefMatch) return cleaned;

  // Text-first with a short language-agnostic reference at the very end
  // ('Verse text. Mga Taga-Filipos 2:3'). Match only the bounded tail
  // immediately before chapter:verse, not the whole paragraph.
  const trailingRefMatch = cleaned.match(
    new RegExp(`^(.+?)\\s+([^\\s.!?;][^.!?;]{0,${MAX_REF_PREFIX_LEN - 1}}?\\d{1,3}:\\d{1,3}(-\\d{1,3})?)$`)
  );
  if (trailingRefMatch) {
    const [, text, reference] = trailingRefMatch;
    let rest = text;
    rest = rest.replace(/^[\s\-–—:,]+/, "").replace(/[\s\-–—:,]+$/, "").trim();
    return rest ? `${reference} - ${rest}` : reference;
  }

  const bookPattern = BIBLE_BOOKS.map((b) => b.replace(/\s+/g, "\\s+")).join("|");
  const refPattern = new RegExp(`(${bookPattern})\\s+\\d{1,3}:\\d{1,3}(-\\d{1,3})?`, "i");
  const match = cleaned.match(refPattern);
  if (!match) return cleaned;
  const reference = match[0];
  let rest = cleaned.slice(0, match.index) + cleaned.slice(match.index + reference.length);
  rest = rest.replace(/^[\s\-–—:,]+/, "").replace(/[\s\-–—:,]+$/, "").trim();
  return rest ? `${reference} - ${rest}` : reference;
}

function normalizeQuotes(str) {
  if (!str) return str;
  return str.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');
}

// --- AI call for application/prayer (same as generate-devotion.js) -------

const SYSTEM_PROMPT = `You write short daily devotions for a personal devotion app.
You will be given a scripture reference and/or text. Produce exactly two sections: APPLICATION and PRAYER.

Rules:
- Match the language of your response to the language of the scripture input. If the scripture is in English, respond in English. If the scripture is in Tagalog, respond in modern conversational Taglish (natural mixed Tagalog-English, the way people actually speak, not formal/pure Tagalog).
- APPLICATION: 2-3 bullet points. Each point is exactly 1-2 sentences. Before drawing out application, first identify what the passage reveals about God's character, actions, or redemptive purposes, letting application flow out of that rather than treating the passage as standalone moral advice. Pay attention to the context, tension, assumptions, commands, promises, warnings, or attitudes present in the passage when relevant. Draw out a deeper spiritual implication clearly rooted in the passage's own terms, never the surface lesson or a forced moral. Avoid generic Christian advice, therapeutic self-help, or any application that simply hands the reader more effort to perform rather than a change grounded in who God is. Application points do not need to be encouraging or constructive, where the passage warrants it, let a point convict or unsettle. Each sentence should hold both a meaningful, text-grounded insight and a practical implication while staying natural and easy to understand.
- PRAYER: 2 sentences, first person, sincere, tied to the application above, not generic.
- Do not restate or quote the scripture back, that's handled separately. Focus only on application and prayer.
- No preamble, no sign-off, no extra commentary.

Respond ONLY with strict JSON in this exact shape, nothing else, no markdown fences:
{"application": ["point one", "point two", "point three"], "prayer": "..."}`;

const GEMINI_MODEL = "gemini-3.6-flash";

async function generateApplicationAndPrayer(scriptureInput) {
  if (!GEMINI_API_KEY) {
    throw new Error("Missing GEMINI_API_KEY env var. Nothing was changed.");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": GEMINI_API_KEY,
    },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ parts: [{ text: `Scripture input:\n${scriptureInput}` }] }],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${text}`);
  }

  const data = await response.json();
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const cleaned = raw.replace(/```json|```/g, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Failed to parse model output as JSON. Raw output:\n${raw}`);
  }

  if (!Array.isArray(parsed.application) || parsed.application.length === 0 || !parsed.prayer) {
    throw new Error(`Model output missing required fields, or application was not a non-empty array. Got: ${JSON.stringify(parsed)}`);
  }

  return parsed;
}

// --- Action handlers -------------------------------------------------------

async function editScripture(dateRaw, newScriptureRaw) {
  const date = parseDateInput(dateRaw);
  if (!date) {
    throw new Error(
      `Could not understand "${dateRaw}" as a date. Use YYYY-MM-DD or M-D-YY. Nothing was changed.`
    );
  }

  const normalized = normalizeScripture(newScriptureRaw);
  const { application, prayer } = await generateApplicationAndPrayer(normalized);

  const result = await callAppsScript("editScripture", {
    date,
    scripture: normalizeQuotes(normalized),
    application: application.map(normalizeQuotes),
    prayer: normalizeQuotes(prayer),
  });

  return result.message;
}

function isValidCalendarDate(year, month, day) {
  // Guards against things like month=13 or day=32 slipping through as
  // "valid-looking" strings. JS Date normalizes overflow silently (e.g.
  // 2026-02-30 becomes March 2), so we check it round-trips exactly.
  const d = new Date(year, month - 1, day);
  return (
    d.getFullYear() === year &&
    d.getMonth() === month - 1 &&
    d.getDate() === day
  );
}

function parseDateInput(input) {
  const cleaned = String(input || "").trim();

  // Accept strict ISO format: YYYY-MM-DD
  const isoMatch = cleaned.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch.map(Number);
    return isValidCalendarDate(y, m, d) ? cleaned : null;
  }

  // Accept the same M-D-YY shorthand used when creating devotions.
  const shortMatch = cleaned.match(/^(\d{1,2})-(\d{1,2})-(\d{2})$/);
  if (shortMatch) {
    const [, m, d, yy] = shortMatch.map(Number);
    const year = 2000 + yy;
    if (!isValidCalendarDate(year, m, d)) return null;
    return `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  return null;
}

async function editDate(currentDateRaw, newDateRaw) {
  const currentDate = parseDateInput(currentDateRaw);
  const newDate = parseDateInput(newDateRaw);

  if (!currentDate) {
    throw new Error(
      `Could not understand "${currentDateRaw}" as a date. Use YYYY-MM-DD or M-D-YY. Nothing was changed.`
    );
  }
  if (!newDate) {
    throw new Error(
      `Could not understand "${newDateRaw}" as a date. Use YYYY-MM-DD or M-D-YY. Nothing was changed.`
    );
  }

  const result = await callAppsScript("editDate", { currentDate, newDate });
  return result.message;
}

// --- Main: detect action from body fields ----------------------------------

async function main() {
  const editScriptureDate = extractField(ISSUE_BODY, "Date to Edit");
  const newScripture = extractField(ISSUE_BODY, "New Scripture Text");
  const currentDate = extractField(ISSUE_BODY, "Current Date");
  const newDate = extractField(ISSUE_BODY, "New Date");

  let resultMessage;

  if (editScriptureDate && newScripture) {
    resultMessage = await editScripture(editScriptureDate, newScripture);
  } else if (currentDate && newDate) {
    resultMessage = await editDate(currentDate, newDate);
  } else {
    // Not one of our two management actions (e.g. this is a plain
    // devotion-creation issue). Exit quietly, generate-devotion.js handles those.
    console.log("No management action detected in this issue. Skipping.");
    process.exit(0);
  }

  console.log(resultMessage);
  fs.writeFileSync(
    path.join(__dirname, "..", ".manage-result"),
    resultMessage
  );
}

main().catch((err) => {
  console.error(err.message);
  fs.writeFileSync(
    path.join(__dirname, "..", ".manage-error"),
    err.message
  );
  process.exit(1);
});
