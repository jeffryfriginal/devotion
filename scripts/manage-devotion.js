// scripts/manage-devotion.js
// Handles three actions on existing devotions.json entries, detected by
// which fields are present in the issue body: edit scripture (reruns AI),
// edit date (move, no AI), and delete (single entry, no confirmation).

const fs = require("fs");
const path = require("path");

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

const DATA_PATH = path.join(__dirname, "..", "docs", "devotions", "devotions.json");

function extractField(body, label) {
  const re = new RegExp(`### ${label}\\s*\\n+([\\s\\S]*?)(?=\\n### |$)`, "i");
  const match = body.match(re);
  if (!match) return "";
  const value = match[1].trim();
  return value === "_No response_" ? "" : value;
}

function loadEntries() {
  if (!fs.existsSync(DATA_PATH)) return [];
  return JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"));
}

function saveEntries(entries) {
  entries.sort((a, b) => (a.date < b.date ? 1 : -1));
  fs.writeFileSync(DATA_PATH, JSON.stringify(entries, null, 2) + "\n");
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

function normalizeScripture(input) {
  const cleaned = input.replace(/\s+/g, " ").trim();
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
- APPLICATION: 2-3 bullet points. Each point is exactly one sentence. Concrete, specific, grounded in the actual text of the passage. Avoid vague platitudes ("God is good", "trust the process") unless directly tied to something specific in the passage. Write like a thoughtful person reflecting, not a greeting card.
- PRAYER: 2-4 sentences, first person, sincere, tied to the application above, not generic.
- Do not restate or quote the scripture back, that's handled separately. Focus only on application and prayer.
- No preamble, no sign-off, no extra commentary.

Respond ONLY with strict JSON in this exact shape, nothing else, no markdown fences:
{"application": ["point one", "point two", "point three"], "prayer": "..."}`;

const GEMINI_MODEL = "gemini-3.6-flash";

async function generateApplicationAndPrayer(scriptureInput) {
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

  const entries = loadEntries();
  const idx = entries.findIndex((e) => e.date === date);
  if (idx === -1) {
    throw new Error(`No entry found for date ${date}. Nothing was changed.`);
  }

  const normalized = normalizeScripture(newScriptureRaw);
  const { application, prayer } = await generateApplicationAndPrayer(normalized);

  entries[idx].scripture = normalizeQuotes(normalized);
  entries[idx].application = application.map(normalizeQuotes);
  entries[idx].prayer = normalizeQuotes(prayer);
  entries[idx].generatedAt = new Date().toISOString();

  saveEntries(entries);
  return `Scripture updated for ${date}, application and prayer regenerated.`;
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

function editDate(currentDateRaw, newDateRaw) {
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

  const entries = loadEntries();
  const idx = entries.findIndex((e) => e.date === currentDate);
  if (idx === -1) {
    throw new Error(`No entry found for date ${currentDate}. Nothing was changed.`);
  }
  const collision = entries.some((e) => e.date === newDate);
  if (collision) {
    throw new Error(
      `An entry already exists for ${newDate}. Refusing to overwrite it. Delete or move that entry first if you want to reuse this date.`
    );
  }

  entries[idx].date = newDate;
  saveEntries(entries);
  return `Entry moved from ${currentDate} to ${newDate}.`;
}

function deleteEntry(dateRaw) {
  const date = parseDateInput(dateRaw);
  if (!date) {
    throw new Error(
      `Could not understand "${dateRaw}" as a date. Use YYYY-MM-DD or M-D-YY. Nothing was deleted.`
    );
  }

  const entries = loadEntries();
  const idx = entries.findIndex((e) => e.date === date);
  if (idx === -1) {
    throw new Error(`No entry found for date ${date}. Nothing was deleted.`);
  }
  entries.splice(idx, 1);
  saveEntries(entries);
  return `Entry for ${date} deleted.`;
}

// --- Main: detect action from body fields ----------------------------------

async function main() {
  const editScriptureDate = extractField(ISSUE_BODY, "Date to Edit");
  const newScripture = extractField(ISSUE_BODY, "New Scripture Text");
  const currentDate = extractField(ISSUE_BODY, "Current Date");
  const newDate = extractField(ISSUE_BODY, "New Date");
  const dateToDelete = extractField(ISSUE_BODY, "Date to Delete");

  let resultMessage;

  if (editScriptureDate && newScripture) {
    resultMessage = await editScripture(editScriptureDate, newScripture);
  } else if (currentDate && newDate) {
    resultMessage = editDate(currentDate, newDate);
  } else if (dateToDelete) {
    resultMessage = deleteEntry(dateToDelete);
  } else {
    // Not one of our three management actions (e.g. this is a plain
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
