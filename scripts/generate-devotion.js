// scripts/generate-devotion.js
// Reads the GitHub issue body (scripture text) from env, calls Groq's
// openai/gpt-oss-120b model, and appends a structured devotion entry
// to devotions/devotions.json.

const fs = require("fs");
const path = require("path");

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const ISSUE_BODY = process.env.ISSUE_BODY || "";
const ISSUE_NUMBER = process.env.ISSUE_NUMBER || "unknown";

if (!GROQ_API_KEY) {
  console.error("Missing GROQ_API_KEY env var.");
  process.exit(1);
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
  console.error("Could not find scripture text in issue body. Aborting.");
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

function normalizeScripture(input) {
  const cleaned = input.replace(/\s+/g, " ").trim();

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

function parseMDYY(input) {
  const match = input.match(/^(\d{1,2})-(\d{1,2})-(\d{2})$/);
  if (!match) return null;
  const [, m, d, yy] = match;
  const year = 2000 + parseInt(yy, 10);
  const month = String(m).padStart(2, "0");
  const day = String(d).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const parsedDate = parseMDYY(dateField);
const date = parsedDate || todayISO();

// --- Call Groq -------------------------------------------------------------

const SYSTEM_PROMPT = `You write short daily devotions for a personal devotion app.
You will be given a scripture reference and/or text. Produce exactly two sections: APPLICATION and PRAYER.

Rules:
- APPLICATION: 2-4 sentences. Concrete, specific, grounded in the actual text of the passage. Avoid vague platitudes ("God is good", "trust the process") unless directly tied to something specific in the passage. Write like a thoughtful person reflecting, not a greeting card.
- PRAYER: 2-4 sentences, first person, sincere, tied to the application above, not generic.
- Do not restate or quote the scripture back, that's handled separately. Focus only on application and prayer.
- No preamble, no sign-off, no extra commentary.

Respond ONLY with strict JSON in this exact shape, nothing else, no markdown fences:
{"application": "...", "prayer": "..."}`;

async function generateDevotion(scriptureInput) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: "openai/gpt-oss-120b",
      temperature: 0.7,
      max_tokens: 800,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Scripture input:\n${scriptureInput}` },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Groq API error ${response.status}: ${text}`);
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content || "";

  const cleaned = raw.replace(/```json|```/g, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Failed to parse model output as JSON. Raw output:\n${raw}`);
  }

  if (!parsed.application || !parsed.prayer) {
    throw new Error(`Model output missing required fields. Got: ${JSON.stringify(parsed)}`);
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
  devotion.application = normalizeQuotes(devotion.application);
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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
