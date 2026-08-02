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
//   sections,        [{ line, id, where, ref, entryText, tokens, error? }]
// }
// `ref` is the read link: a project-relative file path for local skills, the
// URL for cloud ones — the same trail an agent's "Read" badge shows.
async function buildPrompt(cache, root) {
  const entries = await expand(cache, root);
  const sections = [];
  const lines = [];

  for (const e of entries) {
    if (e.error) {
      sections.push({ line: e.line, error: e.error });
      continue;
    }
    const entryText = `- ${e.fm.name || '?'}: ${e.fm.description || ''} (${e.id})`;
    lines.push(entryText);
    // The read trail: project-relative path for local skills, URL for cloud.
    const ref = e.file ? path.join('.atskills', path.relative(root, e.file)) : e.url;
    sections.push({
      line: e.line,
      id: e.id,
      where: e.where,
      ref,
      entryText,
      tokens: approxTokens(entryText),
    });
  }

  const text = lines.length
    ? `Available skills (auto-triggered from .atskills/.autotrigger — read the\nskill's SKILL.md before using it):\n${lines.join('\n')}\n`
    : '';

  return { text, tokens: approxTokens(text), sections };
}

module.exports = { buildPrompt };
