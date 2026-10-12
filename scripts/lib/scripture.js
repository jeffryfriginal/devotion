// scripts/lib/scripture.js
const BIBLE_BOOKS = [ /* same list as manage-devotion.js */ ].sort((a, b) => b.length - a.length);
const MAX_REF_PREFIX_LEN = 30;

function normalizeScripture(input) {
  /* same body as manage-devotion.js */
}

function normalizeQuotes(str) {
  if (!str) return str;
  return str.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');
}

module.exports = { normalizeScripture, normalizeQuotes };