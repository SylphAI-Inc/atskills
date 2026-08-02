'use strict';
// "View prompt" — the exact text injected into the model, word for word,
// with its token count and, per entry, the file or URL it was read from.
// You read what the model reads. No hidden state, no summary in place of
// the real thing.

const path = require('path');
const { expand } = require('./autotrigger');
const { approxTokens } = require('./fsx');

// buildPrompt(cache, root) → {
//   text,            the injected prompt, verbatim
//   tokens,          approximate token count of `text`
//   sections,        [{ line, id, where, ref, readPath, entryText, tokens, error? }]
// }
// Each index entry ends with a READABLE on-disk path — the project file for
// local skills, the cached file for cloud ones (already downloaded by expand
// time) — matching adal's `- name: description (path)` render, so an agent in
// this session can read the full SKILL.md (and bundled files) on demand.
// `ref` stays the provenance link (URL for cloud) for the read-trail display.
async function buildPrompt(cache, root) {
  const entries = await expand(cache, root);
  const sections = [];
  const lines = [];

  for (const e of entries) {
    if (e.error) {
      sections.push({ line: e.line, error: e.error });
      continue;
    }
    const localRef = e.file ? path.join('.atskills', path.relative(root, e.file)) : null;
    const readPath = localRef || (cache.location && cache.location(e.url)) || e.url;
    const entryText = `- ${e.fm.name || '?'}: ${e.fm.description || ''} (${readPath})`;
    lines.push(entryText);
    sections.push({
      line: e.line,
      id: e.id,
      where: e.where,
      // the agent's path is local; `web` is the hosting page for user review
      ref: readPath,
      web: e.url ? require('./sources').webUrl(e.id) : null,
      readPath,
      entryText,
      tokens: approxTokens(entryText),
    });
  }

  const text = lines.length
    ? `Available skills (auto-triggered from .atskills/.autotrigger):\n${lines.join('\n')}\n\nTo use a skill: read the file at the path in parentheses, then follow its\ninstructions. Bundled scripts/references live beside a project skill's\nSKILL.md; for cloud skills fetch them from the same source path on demand.\n`
    : '';

  return { text, tokens: approxTokens(text), sections };
}

module.exports = { buildPrompt };
