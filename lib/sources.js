'use strict';
// Remote sources behind one interface. GitHub (`gh:`) needs nothing from us —
// raw file fetches plus the trees API. The hub is the same interface over
// different URLs; the protocol never relies on it.

const { isGh, ghParts } = require('./ids');

// This reference implementation supports local and GitHub-hosted skills.
// Hub paths (`owner/path`) are part of the protocol but the hub ships later —
// until then they resolve only if ATSKILLS_HUB points at a server.
const HUB_BASE = process.env.ATSKILLS_HUB || null;

function requireHub(id) {
  if (!HUB_BASE) {
    throw new Error(
      `"${id}" is a hub path — the hub ships later. For now use gh:owner/repo/path or a local skill ` +
      `(or set ATSKILLS_HUB to a server that speaks the protocol).`
    );
  }
  return HUB_BASE;
}

function rawUrl(id, file = 'SKILL.md') {
  const { owner, repo, sub } = ghParts(id);
  return `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${sub ? sub + '/' : ''}${file}`;
}

function skillUrl(id, file = 'SKILL.md') {
  if (isGh(id)) return rawUrl(id, file);
  return `${requireHub(id)}/${id}${file === 'SKILL.md' ? '' : '/' + file}`;
}

// Fetch one skill's SKILL.md text. Throws GONE on 404.
async function fetchSkill(cache, id) {
  return cache.fetch(skillUrl(id));
}

// Fetch an arbitrary bundled file of a skill.
async function fetchFile(cache, id, file) {
  return cache.fetch(skillUrl(id, file));
}

// List a remote directory as menu entries: [{ id, description }].
// A directory is a menu — one line per skill, every line a valid path.
async function fetchMenu(cache, id) {
  if (!isGh(id)) {
    const { text } = await cache.fetch(`${requireHub(id)}?prefix=${encodeURIComponent(id)}/`);
    const parsed = JSON.parse(text);
    return (parsed.skills || []).map((s) => ({ id: s.path || s.id, description: s.description || '' }));
  }
  const files = await listGhFiles(cache, id);
  const { frontmatter } = require('./fsx');
  const entries = [];
  for (const rel of files.filter((f) => f === 'SKILL.md' || f.endsWith('/SKILL.md'))) {
    const dir = rel === 'SKILL.md' ? '' : rel.slice(0, -'/SKILL.md'.length);
    const { text } = await fetchFile(cache, id, rel);
    const fm = frontmatter(text);
    entries.push({ id: dir ? `${id}/${dir}` : id, description: fm.description || '(no description)' });
  }
  if (!entries.length) {
    const err = new Error(`no skills under ${id}`);
    err.code = 'GONE';
    throw err;
  }
  return entries;
}

// All file paths (relative to the id's directory) in a gh: subtree.
async function listGhFiles(cache, id) {
  const { owner, repo, sub } = ghParts(id);
  const { text } = await cache.fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`);
  const tree = JSON.parse(text).tree || [];
  const prefix = sub ? `${sub}/` : '';
  return tree
    .filter((e) => e.type === 'blob' && (prefix === '' || e.path.startsWith(prefix)))
    .map((e) => e.path.slice(prefix.length));
}

// Upstream revision for the .source birth certificate.
async function headRevision(cache, id) {
  if (!isGh(id)) {
    try {
      const { text } = await cache.fetch(`${requireHub(id)}/${id}/revision`);
      return JSON.parse(text).revision || 'unknown';
    } catch {
      return 'unknown';
    }
  }
  const { owner, repo } = ghParts(id);
  try {
    const { text } = await cache.fetch(`https://api.github.com/repos/${owner}/${repo}/commits/HEAD`);
    return (JSON.parse(text).sha || 'unknown').slice(0, 7);
  } catch {
    return 'unknown';
  }
}

module.exports = { HUB_BASE, skillUrl, rawUrl, fetchSkill, fetchFile, fetchMenu, listGhFiles, headRevision };
