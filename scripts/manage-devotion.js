// scripts/manage-devotion.js
// Handles three actions on existing devotions.json entries, detected by
// which fields are present in the issue body: edit scripture (reruns AI),
// edit date (move, no AI), and delete (single entry, no confirmation).

const fs = require("fs");
const path = require("path");

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const ISSUE_BODY = process.env.ISSUE_BODY || "";
const ISSUE_NUMBER = process.env.ISSUE_NUMBER || "unknown";

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
- APPLICATION: 2-4 sentences. Concrete, specific, grounded in the actual text of the passage. Avoid vague platitudes ("God is good", "trust the process") unless directly tied to something specific in the passage. Write like a thoughtful person reflecting, not a greeting card.
- PRAYER: 2-4 sentences, first person, sincere, tied to the application above, not generic.
- Do not restate or quote the scripture back, that's handled separately. Focus only on application and prayer.
- No preamble, no sign-off, no extra commentary.

Respond ONLY with strict JSON in this exact shape, nothing else, no markdown fences:
{"application": "...", "prayer": "..."}`;

async function generateApplicationAndPrayer(scriptureInput) {
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

  return parsed;
}

// --- Action handlers -------------------------------------------------------

async function editScripture(date, newScriptureRaw) {
  const entries = loadEntries();
  const idx = entries.findIndex((e) => e.date === date);
  if (idx === -1) {
    throw new Error(`No entry found for date ${date}. Nothing was changed.`);
  }

  const normalized = normalizeScripture(newScriptureRaw);
  const { application, prayer } = await generateApplicationAndPrayer(normalized);

  entries[idx].scripture = normalizeQuotes(normalized);
  entries[idx].application = normalizeQuotes(application);
  entries[idx].prayer = normalizeQuotes(prayer);
  entries[idx].generatedAt = new Date().toISOString();

  saveEntries(entries);
  return `Scripture updated for ${date}, application and prayer regenerated.`;
}

function editDate(currentDate, newDate) {
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

function deleteEntry(date) {
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
