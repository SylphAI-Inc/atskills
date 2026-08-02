'use strict';
// Remote sources behind one interface. GitHub (`gh:`) needs nothing from us —
// raw file fetches plus the trees API. The hub is the same interface over
// different URLs; the protocol never relies on it.

const { isGh, ghParts, diskPath } = require('./ids');

// This reference implementation supports local and GitHub-hosted skills.
// Hub paths (`owner/path`) are part of the protocol but the hub ships later —
// until then they resolve only if ATSKILLS_HUB points at a server.
const HUB_BASE = process.env.ATSKILLS_HUB || null;

function requireHub(id) {
  if (!HUB_BASE) {
    throw new Error(
      `"${id}" is a hub path — the hub (atskills.one) ships later. For now use gh:owner/repo/path or a ` +
      `local skill (or set ATSKILLS_HUB to a server that speaks the protocol).`
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

// Fetch one skill's SKILL.md text. Throws GONE on 404. The body materializes
// in the cache at the ID's own tree path — a readable local dir, like adal's
// session workflow cache.
async function fetchSkill(cache, id) {
  return cache.fetch(skillUrl(id), { treePath: `${diskPath(id)}/SKILL.md` });
}

// Fetch an arbitrary bundled file of a skill (same tree materialization).
async function fetchFile(cache, id, file) {
  return cache.fetch(skillUrl(id, file), { treePath: `${diskPath(id)}/${file}` });
}

// List a remote directory as menu entries: [{ id, name, description, file }].
// A directory is an index of skills; `file` is each child SKILL.md's readable
// materialized path in the cache tree, so the index renders like the skills
// prompt: `- name: description (path)`.
async function fetchMenu(cache, id) {
  if (!isGh(id)) {
    const { text } = await cache.fetch(`${requireHub(id)}?prefix=${encodeURIComponent(id)}/`);
    const parsed = JSON.parse(text);
    return (parsed.skills || []).map((s) => ({
      id: s.path || s.id,
      name: s.name || String(s.path || s.id).split('/').pop(),
      description: s.description || '',
      file: null,
    }));
  }
  const files = await listGhFiles(cache, id);
  const { frontmatter, pool } = require('./fsx');
  const skillRels = files.filter((f) => f === 'SKILL.md' || f.endsWith('/SKILL.md'));
  const fetched = await pool(skillRels, 8, (rel) => fetchFile(cache, id, rel));
  const entries = [];
  for (let k = 0; k < skillRels.length; k++) {
    const rel = skillRels[k];
    const dir = rel === 'SKILL.md' ? '' : rel.slice(0, -'/SKILL.md'.length);
    const { text, bodyPath } = fetched[k];
    const fm = frontmatter(text);
    const entryId = dir ? `${id}/${dir}` : id;
    // The skill's own dir structure (top-level, dirs marked /) — included in
    // the index so the agent already knows what each skill bundles.
    const bundle = [
      ...new Set(
        files
          .filter((f) => (dir ? f.startsWith(dir + '/') : true))
          .map((f) => (dir ? f.slice(dir.length + 1) : f))
          .filter((r) => r && r !== 'SKILL.md')
          .map((r) => (r.includes('/') ? r.split('/')[0] + '/' : r))
      ),
    ].sort();
    entries.push({
      id: entryId,
      name: fm.name || entryId.split('/').pop(),
      description: fm.description || '(no description)',
      file: bodyPath || null,
      bundle,
    });
  }
  if (!entries.length) {
    const err = new Error(`no skills under ${id}`);
    err.code = 'GONE';
    throw err;
  }
  return entries;
}

// Same, at a pinned revision (immutable blobs — cached forever, no treePath).
async function listGhFilesAt(cache, id, ref) {
  const { owner, repo, sub } = ghParts(id);
  const { text } = await cache.fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`);
  const tree = JSON.parse(text).tree || [];
  const prefix = sub ? `${sub}/` : '';
  return tree
    .filter((e) => e.type === 'blob' && (prefix === '' || e.path.startsWith(prefix)))
    .map((e) => e.path.slice(prefix.length));
}

async function fetchFileAt(cache, id, file, ref) {
  const { owner, repo, sub } = ghParts(id);
  const p = sub ? `${sub}/${file}` : file;
  return cache.fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${p}`);
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
  // ecosystem first: git ls-remote gives the full HEAD sha with no API quota
  try {
    const { spawnSync } = require('child_process');
    const r = spawnSync('git', ['ls-remote', `https://github.com/${owner}/${repo}.git`, 'HEAD'], {
      encoding: 'utf8',
      timeout: 20000,
    });
    const sha = r.status === 0 ? String(r.stdout).split(/\s+/)[0] : '';
    if (/^[0-9a-f]{40}$/i.test(sha)) return sha;
  } catch {}
  try {
    const { text } = await cache.fetch(`https://api.github.com/repos/${owner}/${repo}/commits/HEAD`);
    return JSON.parse(text).sha || 'unknown';
  } catch {
    return 'unknown';
  }
}

// The human-viewable hosting page (for user review) — the GitHub page, not
// the raw file. HEAD redirects to the default branch.
function webUrl(id) {
  if (!isGh(id)) return HUB_BASE ? `${HUB_BASE}/${id}` : null;
  const { owner, repo, sub } = ghParts(id);
  return `https://github.com/${owner}/${repo}${sub ? `/tree/HEAD/${sub}` : ''}`;
}

module.exports = { HUB_BASE, skillUrl, rawUrl, webUrl, fetchSkill, fetchFile, fetchMenu, listGhFiles, listGhFilesAt, fetchFileAt, headRevision };
