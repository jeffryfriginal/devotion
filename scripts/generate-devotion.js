// scripts/generate-devotion.js
// Reads the GitHub issue body (scripture text) from env, calls Google's
// gemini-3.6-flash model, and appends a structured devotion entry
// to devotions/devotions.json.

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

// --- Parse the issue form body -------------------------------------------
// GitHub issue forms render fields as markdown, roughly:
// ### Scripture
//
// <the text>
//
// ### Date (optional)
//
// <the text or "_No response_">

function extractField(body, label) {
  const re = new RegExp(`### ${label}\\s*\\n+([\\s\\S]*?)(?=\\n### |$)`, "i");
  const match = body.match(re);
  if (!match) return "";
  const value = match[1].trim();
  return value === "_No response_" ? "" : value;
}

const scripture = extractField(ISSUE_BODY, "Scripture");
const dateField = extractField(ISSUE_BODY, "Date \\(optional\\)");

if (!scripture) {
  // Not a devotion-creation issue (could be Edit Scripture, Edit Date, or
  // Delete instead, those are handled by manage-devotion.js). Exit quietly
  // rather than failing, so both workflows can safely trigger on every
  // new issue without stepping on each other.
  console.log("No Scripture field found. Not a devotion-creation issue. Skipping.");
  process.exit(0);
}

if (!GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY env var.");
  process.exit(1);
}

// --- Normalize scripture input into "Reference - Verse text" -------------
// Accepts input in any order/format (reference first, text first, with or
// without a dash) and reassembles it consistently. Uses pattern matching
// only, never the AI, so the original wording is never paraphrased.

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
]
  // Longest names first so "Song of Solomon" matches before a shorter
  // partial book name could.
  .sort((a, b) => b.length - a.length);

// A real book name + chapter:verse is short. Cap the prefix so a whole
// paragraph ending in a verse number can't be mistaken for 'reference-first'.
const MAX_REF_PREFIX_LEN = 30;

function normalizeScripture(input) {
  const cleaned = input.replace(/\s+/g, " ").trim();

  // Already correctly formatted as 'Reference - Text'. Language-agnostic,
  // works regardless of what language the book name is in.
  const alreadyFormatted = new RegExp(
    `^.{1,${MAX_REF_PREFIX_LEN}}?\\d{1,3}:\\d{1,3}(-\\d{1,3})?\\s*-\\s*\\S`
  ).test(cleaned);
  if (alreadyFormatted) return cleaned;

  // Reference-first with no dash before the trailing text
  // ('Isaias 46:4 Ako ang...' or '2 Timothy 1:7 For the Spirit...').
  // Language-agnostic: no hardcoded book list needed for this case.
  const refFirstMatch = cleaned.match(
    new RegExp(`^(.{1,${MAX_REF_PREFIX_LEN}}?\\d{1,3}:\\d{1,3}(-\\d{1,3})?)\\s+(\\S.*)$`)
  );
  if (refFirstMatch) {
    const [, reference, , rest] = refFirstMatch;
    return `${reference} - ${rest}`;
  }

  // Bare reference only, nothing trailing. Leave as-is.
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

  // Text-first, reference at the end (English only, needs the book list
  // since we can't otherwise tell where an embedded reference starts).
  const bookPattern = BIBLE_BOOKS.map((b) => b.replace(/\s+/g, "\\s+")).join("|");
  const refPattern = new RegExp(
    `(${bookPattern})\\s+\\d{1,3}:\\d{1,3}(-\\d{1,3})?`,
    "i"
  );
  const match = cleaned.match(refPattern);
  if (!match) {
    // No recognizable reference found; leave input untouched rather than
    // guessing wrong.
    return cleaned;
  }
  const reference = match[0];
  let rest = cleaned.slice(0, match.index) + cleaned.slice(match.index + reference.length);

  // Strip leftover separators from where the reference used to sit.
  // Deliberately excludes '.' so a verse's real closing period is never eaten.
  rest = rest.replace(/^[\s\-–—:,]+/, "").replace(/[\s\-–—:,]+$/, "").trim();

  return rest ? `${reference} - ${rest}` : reference;
}

const normalizedScripture = normalizeScripture(scripture);

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function isValidCalendarDate(year, month, day) {
  // JavaScript Date silently normalizes invalid dates, so require an exact
  // round trip before accepting user input.
  const d = new Date(year, month - 1, day);
  return (
    d.getFullYear() === year &&
    d.getMonth() === month - 1 &&
    d.getDate() === day
  );
}

function parseMDYY(input) {
  const match = String(input || "").trim().match(/^(\d{1,2})-(\d{1,2})-(\d{2})$/);
  if (!match) return null;
  const [, m, d, yy] = match.map(Number);
  const year = 2000 + yy;
  if (!isValidCalendarDate(year, m, d)) {
    throw new Error(
      `Could not understand "${input}" as a date. Use M-D-YY with a real calendar date, or leave it blank. Nothing was changed.`
    );
  }
  return `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const parsedDate = parseMDYY(dateField);
const date = parsedDate || todayISO();

// --- Call Groq -------------------------------------------------------------

const SYSTEM_PROMPT = `You write short daily devotions for a personal devotion app.
You will be given a scripture reference and/or text. Produce exactly two sections: APPLICATION and PRAYER.

Rules:
- Match the language of your response to the language of the scripture input. If the scripture is in English, respond in English. If the scripture is in Tagalog, respond in modern conversational Taglish (natural mixed Tagalog-English, the way people actually speak, not formal/pure Tagalog).
- APPLICATION: 2-3 bullet points. Each point is exactly one sentence. Explain the main spiritual truth of the passage in a simple, natural, and relatable way. Do not merely repeat or summarize the verse. Help the reader understand what God may be teaching through the passage and why it matters in everyday life. Explain what the reader can actually do, change, practice, or remember after reading the devotional. The application should encourage personal reflection, obedience, and a closer relationship with God. Use simple words. Avoid vague platitudes ("trust the process") unless directly tied to something specific in the passage. Write like a thoughtful person reflecting, not a greeting card. Write it in first-person plural (we, us, our, ours, ourselves)
- PRAYER: 2-4 sentences, first person, sincere, tied to the application above, not generic.
- Do not restate or quote the scripture back, that's handled separately. Focus only on application and prayer.
- No preamble, no sign-off, no extra commentary.

Respond ONLY with strict JSON in this exact shape, nothing else, no markdown fences:
{"application": ["point one", "point two", "point three"], "prayer": "..."}`;

const GEMINI_MODEL = "gemini-3.6-flash";

async function generateDevotion(scriptureInput) {
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

  // Scripture is never taken from the model. Whatever the user typed in the
  // issue form is used verbatim, guaranteeing accuracy instead of trusting
  // the model to reproduce text without paraphrasing or truncating it.
  parsed.scripture = scriptureInput;

  return parsed;
}

// --- Write to devotions.json ------------------------------------------------

function normalizeQuotes(str) {
  if (!str) return str;
  return str
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"');
}

async function main() {
  const devotion = await generateDevotion(normalizedScripture);

  devotion.scripture = normalizeQuotes(devotion.scripture);
  devotion.application = devotion.application.map(normalizeQuotes);
  devotion.prayer = normalizeQuotes(devotion.prayer);

  const outPath = path.join(__dirname, "..", "docs", "devotions", "devotions.json");

  let existing = [];
  if (fs.existsSync(outPath)) {
    existing = JSON.parse(fs.readFileSync(outPath, "utf-8"));
  }

  // Prevent duplicate entries for the same date; overwrite if regenerating.
  existing = existing.filter((d) => d.date !== date);

  existing.push({
    date,
    scripture: devotion.scripture,
    application: devotion.application,
    prayer: devotion.prayer,
    sourceIssue: ISSUE_NUMBER,
    generatedAt: new Date().toISOString(),
  });

  existing.sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first

  fs.writeFileSync(outPath, JSON.stringify(existing, null, 2) + "\n");
  console.log(`Wrote devotion for ${date} to ${outPath}`);
  fs.writeFileSync(path.join(__dirname, "..", ".generate-happened"), "true");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
