# Daily Devotion

Submit a scripture via a GitHub Issue. A GitHub Action calls Groq
(`openai/gpt-oss-120b`) to generate a SCRIPTURE / APPLICATION / PRAYER
devotion, commits it to `docs/devotions/devotions.json`, and the static
site (served from `/docs` via GitHub Pages) displays it.

## One-time setup

1. **Add your Groq API key as a repo secret.**
   Repo → Settings → Secrets and variables → Actions → New repository secret.
   Name: `GROQ_API_KEY`. Get a key at https://console.groq.com

2. **Enable GitHub Pages.**
   Repo → Settings → Pages → Source: "Deploy from a branch" → Branch: `main`,
   folder: `/docs`.

3. **Push this repo to GitHub.** That's it, no other config needed.

## Daily use

1. Go to the **Issues** tab → **New Issue** → pick the "New Devotion" template.
2. Paste in a scripture reference or full verse text.
3. Submit. The Action runs automatically, generates the devotion, commits it,
   and closes the issue with a confirmation comment (or leaves it open with
   an error comment if generation failed — check the Actions log in that case).
4. Refresh your Pages site. New devotion is on top.

## File map

- `.github/ISSUE_TEMPLATE/devotion.yml` — the issue form
- `.github/workflows/generate-devotion.yml` — the automation
- `scripts/generate-devotion.js` — parses the issue, calls Groq, writes JSON
- `docs/devotions/devotions.json` — all devotions, newest first
- `docs/index.html` — the site itself

## Known limitations / things to watch

- Submitting a second issue for the same date overwrites that date's entry
  rather than creating a duplicate. No history of prior attempts is kept.
- If Groq deprecates `openai/gpt-oss-120b` at some point, generation will
  start failing with a clear error in the Action log — update the model
  string in `scripts/generate-devotion.js` when that happens. Check
  https://console.groq.com/docs/deprecations occasionally.
- The model's theological framing is not reviewed before publishing. If
  that matters to you, consider reading the issue comment/output before
  sharing the site link, since there's currently no manual approval step
  between generation and publish.
