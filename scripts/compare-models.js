// scripts/compare-models.js
// Standalone test tool. Calls Groq and Gemini with the SAME prompt and
// scripture input, prints both outputs to the log for manual comparison.
// Does NOT write to devotions.json, does NOT touch the live site, does NOT
// create or modify any issue. Purely for you to eyeball output quality.

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SCRIPTURE_INPUT = process.env.SCRIPTURE_INPUT || "";

// Update this if Google renames/deprecates this model. Verify current
// model names at https://ai.google.dev/gemini-api/docs/pricing before
// assuming this still works.
const GEMINI_MODEL = "gemini-3.6-flash";

// Same prompt currently live in generate-devotion.js / manage-devotion.js,
// kept identical here so the comparison is apples-to-apples.
const SYSTEM_PROMPT = `You write short daily devotions for a personal devotion app.
You will be given a scripture reference and/or text. Produce exactly two sections: APPLICATION and PRAYER.

Rules:
- APPLICATION: 2-3 bullet points. Each point is exactly one sentence. Concrete, specific, grounded in the actual text of the passage. Avoid vague platitudes ("God is good", "trust the process") unless directly tied to something specific in the passage. Write like a thoughtful person reflecting, not a greeting card.
- PRAYER: 2-4 sentences, first person, sincere, tied to the application above, not generic.
- Do not restate or quote the scripture back, that's handled separately. Focus only on application and prayer.
- No preamble, no sign-off, no extra commentary.

Respond ONLY with strict JSON in this exact shape, nothing else, no markdown fences:
{"application": ["point one", "point two", "point three"], "prayer": "..."}`;

if (!SCRIPTURE_INPUT) {
  console.error("No scripture input provided. Aborting.");
  process.exit(1);
}

function cleanJson(raw) {
  return raw.replace(/```json|```/g, "").trim();
}

async function callGroq() {
  if (!GROQ_API_KEY) return { error: "GROQ_API_KEY not set." };
  try {
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
          { role: "user", content: `Scripture input:\n${SCRIPTURE_INPUT}` },
        ],
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      return { error: `Groq API error ${response.status}: ${text}` };
    }
    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content || "";
    return { raw: cleanJson(raw) };
  } catch (err) {
    return { error: `Groq request failed: ${err.message}` };
  }
}

async function callGemini() {
  if (!GEMINI_API_KEY) return { error: "GEMINI_API_KEY not set." };
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY,
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ parts: [{ text: `Scripture input:\n${SCRIPTURE_INPUT}` }] }],
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      return { error: `Gemini API error ${response.status}: ${text}` };
    }
    const data = await response.json();
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    return { raw: cleanJson(raw) };
  } catch (err) {
    return { error: `Gemini request failed: ${err.message}` };
  }
}

function tryParse(raw) {
  try {
    return { parsed: JSON.parse(raw) };
  } catch (err) {
    return { parseError: `Could not parse as JSON: ${err.message}` };
  }
}

function printResult(label, result) {
  console.log(`\n========== ${label} ==========`);
  if (result.error) {
    console.log(`ERROR: ${result.error}`);
    return;
  }
  console.log("Raw output:");
  console.log(result.raw);

  const { parsed, parseError } = tryParse(result.raw);
  if (parseError) {
    console.log(`\n${parseError}`);
    return;
  }

  console.log("\nParsed APPLICATION:");
  if (Array.isArray(parsed.application)) {
    parsed.application.forEach((point, i) => console.log(`  ${i + 1}. ${point}`));
  } else {
    console.log(`  (not an array) ${parsed.application}`);
  }
  console.log("\nParsed PRAYER:");
  console.log(`  ${parsed.prayer}`);
}

async function main() {
  console.log(`Comparing models for scripture input:\n"${SCRIPTURE_INPUT}"`);

  const [groqResult, geminiResult] = await Promise.all([callGroq(), callGemini()]);

  printResult("GROQ (openai/gpt-oss-120b)", groqResult);
  printResult(`GEMINI (${GEMINI_MODEL})`, geminiResult);

  console.log("\n\nNothing was written to devotions.json or the site. This was a comparison only.");
}

main();
