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

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

const date = /^\d{4}-\d{2}-\d{2}$/.test(dateField) ? dateField : todayISO();

// --- Call Groq -------------------------------------------------------------

const SYSTEM_PROMPT = `You write short daily devotions for a personal devotion app.
Given a scripture reference and/or text, produce exactly three sections:
SCRIPTURE, APPLICATION, and PRAYER.

Rules:
- SCRIPTURE: reproduce the reference given. If full verse text was provided, include it verbatim; otherwise just state the reference clearly.
- APPLICATION: 2-4 sentences. Concrete, specific, grounded in the actual text of the passage and has nuanced observations. Avoid vague platitudes ("God is good", "trust the process") unless directly tied to something specific in the passage. Write like a thoughtful person reflecting, not a greeting card.
- PRAYER: 2-4 sentences, first person, sincere, tied to the application above, not generic.
- No headers other than the three exact words SCRIPTURE, APPLICATION, PRAYER, each on its own line, followed by the content.
- No preamble, no sign-off, no extra commentary.

Respond ONLY with strict JSON in this exact shape, nothing else, no markdown fences:
{"scripture": "...", "application": "...", "prayer": "..."}`;

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

  if (!parsed.scripture || !parsed.application || !parsed.prayer) {
    throw new Error(`Model output missing required fields. Got: ${JSON.stringify(parsed)}`);
  }

  return parsed;
}

// --- Write to devotions.json ------------------------------------------------

async function main() {
  const devotion = await generateDevotion(scripture);

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
