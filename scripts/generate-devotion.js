// scripts/generate-devotion.js
// Reads the GitHub issue body (scripture text) from env, calls Google's
// Gemini model, and writes the entry to a Google Sheet via the
// Apps Script API (not a local devotions.json file).

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

// --- Parse the issue form body -------------------------------------------

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
  // Delete, those are handled by manage-devotion.js). Exit quietly so both
  // workflows can safely trigger on every new issue.
  console.log("No Scripture field found. Not a devotion-creation issue. Skipping.");
  process.exit(0);
}

if (!GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY env var.");
  process.exit(1);
}

if (!APPS_SCRIPT_URL || !WRITE_API_KEY) {
  console.error("Missing APPS_SCRIPT_URL or WRITE_API_KEY env var.");
  process.exit(1);
}

// --- Normalize scripture input into "Reference - Verse text" -------------
// Pattern matching only, never the AI, so the original wording is never
// paraphrased.

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
  .sort((a, b) => b.length - a.length);

const MAX_REF_PREFIX_LEN = 30;

// Phone keyboards often turn " - " into " – " (en dash) or " — " (em dash),
// so every dash check accepts all three.
const DASH = "[-–—]";
const RANGE = `(?:${DASH}\\d{1,3})?`;
const REF_CORE = `\\d{1,3}:\\d{1,3}${RANGE}`;

function tidyRef(ref) {
  return ref.replace(/[–—]/g, "-");
}

function stripEdges(s) {
  return s.replace(/^[\s\-–—:,]+/, "").replace(/[\s\-–—:,]+$/, "").trim();
}

function normalizeScripture(input) {
  const cleaned = input.replace(/\s+/g, " ").trim();

  const formatted = cleaned.match(
    new RegExp(`^(.{1,${MAX_REF_PREFIX_LEN}}?${REF_CORE})\\s*${DASH}\\s+(\\S.*)$`)
  );
  if (formatted) return `${tidyRef(formatted[1])} - ${formatted[2]}`;

  const refFirst = cleaned.match(
    new RegExp(`^(.{1,${MAX_REF_PREFIX_LEN}}?${REF_CORE})\\s+(\\S.*)$`)
  );
  if (refFirst) {
    const rest = refFirst[2].replace(/^[\s\-–—:,]+/, "");
    return `${tidyRef(refFirst[1])} - ${rest}`;
  }

  if (new RegExp(`^.{1,${MAX_REF_PREFIX_LEN}}?${REF_CORE}$`).test(cleaned)) {
    return tidyRef(cleaned);
  }

  const trailing = cleaned.match(
    new RegExp(
      `^(.+?)\\s+([^\\s.!?;][^.!?;]{0,${MAX_REF_PREFIX_LEN - 1}}?${REF_CORE})$`
    )
  );
  if (trailing) {
    const rest = stripEdges(trailing[1]);
    const reference = tidyRef(trailing[2]);
    return rest ? `${reference} - ${rest}` : reference;
  }

  const bookPattern = BIBLE_BOOKS.map((b) => b.replace(/\s+/g, "\\s+")).join("|");
  const match = cleaned.match(new RegExp(`(${bookPattern})\\s+${REF_CORE}`, "i"));
  if (!match) return cleaned;

  const reference = tidyRef(match[0]);
  const rest = stripEdges(
    cleaned.slice(0, match.index) + cleaned.slice(match.index + match[0].length)
  );
  return rest ? `${reference} - ${rest}` : reference;
}

const normalizedScripture = normalizeScripture(scripture);

function todayISO() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());
}

function isValidCalendarDate(year, month, day) {
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

// --- Call Gemini -------------------------------------------------------------

const SYSTEM_PROMPT = `You write short daily devotions for a personal devotion app.
You will be given a scripture reference and/or text. Produce exactly two sections: POINTS and PRAYER.

Rules:
- Match the language of your response to the language of the scripture input. If the scripture is in English, respond in plain conversational English. If the scripture is in Tagalog, respond in modern conversational Taglish (natural mixed Tagalog-English, the way people actually speak, not formal/pure Tagalog). Never switch to Taglish for an English scripture.
- POINTS: exactly 3 points, each one a short paragraph of 2 to 4 sentences. Write like a friend sharing a reflection in a small group, not like a sermon, a blog post, or a commentary. Always in first person plural ("we," "us," "our," and "natin," "tayo" in Taglish). Never use "you," "I," "a believer," "a person," "someone," or "people."
  - Three different angles. Each point must take its own angle on the passage: a different phrase, assumption, tension, command, or area of life. No two points may make the same basic point in different words. Do not default to the safe, obvious landing (like "God did it for us first") unless the passage is genuinely driving at it. Look for what is easy to miss on a first read, and ask what the passage assumes about us.
  - Each point starts from a truth in the passage, then moves straight into what it means for how we live and what we should do, all in one flow. No labels.
  - Name the real, specific things we go through, picked to fit the passage: fear of failure, rejection, pride, money worries, comparing ourselves to others, group chat drama, scrolling, grudges, procrastination, being tired. Don't stay abstract.
  - Be direct about what to do. Name a concrete attitude to drop or a habit to start. Avoid vague lines like "trust God more" or "be more faithful."
  - Do not begin any sentence with "Let us" or "Let's." Vary how each point opens and how it ends. At most one or two of the three points should end on a short punchy line, and the others should end plainly on the action.
  - Voice: simple everyday words, spoken grammar is fine, it doesn't need to sound polished. Avoid pulpit phrases like "we are called to," "self-righteous," "embrace," "journey," "bitterness," "walk in," "lay down." Mix sentence lengths: a longer sentence that explains, then a short one that lands.
  - Refer to God as "the Lord," "God," "Diyos," or "Siya." No churchy filler or cliches. Stay grounded in what the passage actually says or implies. Don't restate the verse.
  - Style examples. Copy the voice and rhythm only. Never reuse their wording, topics, or structure.
    Taglish example (for Tagalog scripture only): "Kapag nakakaramdam ng takot, palaging magpray, isuko natin lahat yan sa Lord. And huwag tayong mag worry masyado. We fear because of failure or rejection or the uncertainty ng future. Ibigay natin lahat yan sa Lord. Dont let fear control us."
    English example (for English scripture): "We say we trust God, but we check our bank balance every hour. Worry about money is rarely about the money. It's about whether we believe He will actually show up. Next time that number makes our chest tight, we pray first and look second."
- PRAYER: 2 sentences, first person, sincere, tied to the points above, not generic.
- Do not restate or quote the scripture back, that's handled separately.
- No preamble, no sign-off, no extra commentary.

Respond ONLY with JSON in this shape, with exactly 3 strings in "points":
{"points": ["...", "...", "..."], "prayer": "..."}`;

// Confirm this ID against Google's current model list.
const GEMINI_MODEL = "gemini-3.7-flash";

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callGemini(scriptureInput) {
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
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 8192,
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            points: {
              type: "ARRAY",
              minItems: 3,
              maxItems: 3,
              items: { type: "STRING" },
            },
            prayer: { type: "STRING" },
          },
          required: ["points", "prayer"],
        },
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    const err = new Error(`Gemini API error ${response.status}: ${text}`);
    err.status = response.status;
    throw err;
  }

  return response.json();
}

async function callGeminiWithRetry(scriptureInput) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await callGemini(scriptureInput);
    } catch (err) {
      lastErr = err;
      const isRetryable = !err.status || RETRYABLE_STATUS_CODES.has(err.status);
      const attemptsLeft = MAX_RETRIES - attempt;

      if (!isRetryable || attemptsLeft === 0) throw err;

      const delayMs = 2000 * Math.pow(2, attempt) + Math.random() * 500;
      console.log(
        `Gemini call failed (${err.message}). Retrying in ${Math.round(delayMs / 1000)}s (${attemptsLeft} attempt(s) left)...`
      );
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

async function generateDevotion(scriptureInput) {
  const data = await callGeminiWithRetry(scriptureInput);
  const finishReason = data.candidates?.[0]?.finishReason;
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  console.log(`Gemini finishReason: ${finishReason}`);

  const cleaned = raw.replace(/```json|```/g, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Failed to parse model output as JSON (finishReason: ${finishReason}). Raw output:\n${raw}`);
  }

  if (
    !Array.isArray(parsed.points) ||
    parsed.points.length !== 3 ||
    !parsed.points.every((p) => typeof p === "string" && p.trim()) ||
    !parsed.prayer
  ) {
    throw new Error(`Model output missing required fields or did not return exactly 3 text points. Got: ${JSON.stringify(parsed)}`);
  }

  // The rest of the pipeline (Apps Script, the site) expects `application`
  // as an array of strings.
  parsed.application = parsed.points.map((p) => p.trim());
  delete parsed.points;

  // Scripture is never taken from the model. Whatever the user typed in the
  // issue form is used verbatim.
  parsed.scripture = scriptureInput;

  return parsed;
}

// --- Write via Apps Script API ----------------------------------------

function normalizeQuotes(str) {
  if (!str) return str;
  return str
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"');
}

async function callAppsScript(action, payload) {
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
    throw new Error(`Apps Script rejected the request: ${data.error}`);
  }
  return data;
}

async function main() {
  const devotion = await generateDevotion(normalizedScripture);

  devotion.scripture = normalizeQuotes(devotion.scripture);
  devotion.application = devotion.application.map(normalizeQuotes);
  devotion.prayer = normalizeQuotes(devotion.prayer);

  const result = await callAppsScript("create", {
    date,
    scripture: devotion.scripture,
    application: devotion.application,
    prayer: devotion.prayer,
    sourceIssue: ISSUE_NUMBER,
  });

  console.log(result.message);
  fs.writeFileSync(path.join(__dirname, "..", ".generate-happened"), "true");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
