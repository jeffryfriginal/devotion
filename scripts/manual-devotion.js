const fs = require("fs");
const path = require("path");
const { normalizeScripture, normalizeQuotes } = require("./lib/scripture");

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const WRITE_API_KEY = process.env.WRITE_API_KEY;
const ISSUE_BODY = process.env.ISSUE_BODY || "";
const ISSUE_NUMBER = process.env.ISSUE_NUMBER || "unknown";
const ISSUE_AUTHOR = process.env.ISSUE_AUTHOR || "";
const OWNER_USERNAME = "jeffryfriginal";

if (ISSUE_AUTHOR.toLowerCase() !== OWNER_USERNAME.toLowerCase()) {
  console.log(`Issue author "${ISSUE_AUTHOR}" is not the site owner. Skipping.`);
  process.exit(0);
}

function extractField(body, label) {
  const re = new RegExp(`### ${label}\\s*\\n+([\\s\\S]*?)(?=\\n### |$)`, "i");
  const match = body.match(re);
  if (!match) return "";
  const value = match[1].trim();
  return value === "_No response_" ? "" : value;
}

function isValidCalendarDate(y, m, d) {
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

function parseDate(input) {
  const s = String(input || "").trim();
  if (!s) return null;
  let y, m, d;
  let match = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) {
    [, y, m, d] = match.map(Number);
  } else if ((match = s.match(/^(\d{1,2})-(\d{1,2})-(\d{2})$/))) {
    let yy;
    [, m, d, yy] = match.map(Number);
    y = 2000 + yy;
  } else {
    throw new Error(`Could not understand "${input}" as a date. Use M-D-YY or YYYY-MM-DD. Nothing was changed.`);
  }
  if (!isValidCalendarDate(y, m, d)) {
    throw new Error(`"${input}" is not a real calendar date. Nothing was changed.`);
  }
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// Actions runs in UTC, so toISOString() would file anything submitted
// between midnight and 8am Manila time under yesterday.
function todayManila() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());
}

function parseApplication(raw) {
  return raw
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*\u2022\u2013]|\d+[.)])\s*/, "").trim())
    .filter(Boolean);
}

async function main() {
  const scriptureRaw = extractField(ISSUE_BODY, "Manual Scripture");
  if (!scriptureRaw) {
    console.log("Not a manual devotion issue. Skipping.");
    process.exit(0);
  }
  if (!APPS_SCRIPT_URL || !WRITE_API_KEY) {
    throw new Error("Missing APPS_SCRIPT_URL or WRITE_API_KEY. Nothing was changed.");
  }

  const application = parseApplication(extractField(ISSUE_BODY, "Manual Application"));
  if (application.length === 0) {
    throw new Error("Application is empty. Add at least one point. Nothing was changed.");
  }
  const prayer = extractField(ISSUE_BODY, "Manual Prayer \\(optional\\)");
  const date = parseDate(extractField(ISSUE_BODY, "Manual Date \\(optional\\)")) || todayManila();

  const response = await fetch(APPS_SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiKey: WRITE_API_KEY,
      action: "create",
      date,
      scripture: normalizeQuotes(normalizeScripture(scriptureRaw)),
      application: application.map(normalizeQuotes),
      prayer: normalizeQuotes(prayer),
      sourceIssue: ISSUE_NUMBER,
    }),
  });
  if (!response.ok) throw new Error(`Apps Script HTTP error ${response.status}: ${await response.text()}`);
  const data = await response.json();
  if (!data.success) throw new Error(`Apps Script rejected the request: ${data.error}`);

  console.log(data.message);
  fs.writeFileSync(path.join(__dirname, "..", ".manual-result"), data.message || "Devotion saved.");
}

main().catch((err) => {
  console.error(err.message);
  fs.writeFileSync(path.join(__dirname, "..", ".manual-error"), err.message);
  process.exit(1);
});