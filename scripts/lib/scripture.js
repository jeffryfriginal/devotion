// scripts/lib/scripture.js
// Shared scripture helpers. Same logic as the copies inside
// generate-devotion.js and manage-devotion.js.

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
  // ('Verse text. Mga Taga-Filipos 2:3').
  const trailingRefMatch = cleaned.match(
    new RegExp(`^(.+?)\\s+([^\\s.!?;][^.!?;]{0,${MAX_REF_PREFIX_LEN - 1}}?\\d{1,3}:\\d{1,3}(-\\d{1,3})?)$`)
  );
  if (trailingRefMatch) {
    const [, text, reference] = trailingRefMatch;
    let rest = text;
    rest = rest.replace(/^[\s\-–—:,]+/, "").replace(/[\s\-–—:,]+$/, "").trim();
    return rest ? `${reference} - ${rest}` : reference;
  }

  // Text-first, reference at the end (English only, needs the book list).
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

module.exports = { normalizeScripture, normalizeQuotes };
