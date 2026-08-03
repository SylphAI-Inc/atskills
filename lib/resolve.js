'use strict';
// Resolution — the whole rule: local first, by path. A folder at
// .atskills/<path> is the project's own and always answers; a cloud path with
// no such folder means the cloud. `.source` is never consulted to resolve.

const fs = require('fs');
const path = require('path');
const { diskPath, isGh } = require('./ids');
const { safeJoin, walkSkills, frontmatter, nearestSource, assertCollectionFits } = require('./fsx');
const sources = require('./sources');

// resolve(cache, id, root) →
//   { kind: 'skill', where, text, dir?, url? }
//   { kind: 'menu',  where, entries: [{ id, description }] }
// `where` is 'local' | 'github' | 'hub', plus cache status for remote.
async function resolve(cache, id, root) {
  if (root) {
    const local = safeJoin(root, diskPath(id));
    if (fs.existsSync(local) && fs.statSync(local).isDirectory()) {
      const skillFile = path.join(local, 'SKILL.md');
      if (fs.existsSync(skillFile)) {
        return {
          kind: 'skill',
          where: 'local',
          dir: local,
          text: fs.readFileSync(skillFile, 'utf8'),
          source: nearestSource(local, root),
        };
      }
      // The same cap on the local side: a vendored tree can be just as broad,
      // and the index is what actually enters the model's context.
      const found = walkSkills(local);
      assertCollectionFits(id, found.map((s) => s.rel).filter(Boolean));
      const entries = found.map((s) => {
        const file = path.join(s.dir, 'SKILL.md');
        const fm = frontmatter(fs.readFileSync(file, 'utf8'));
        const entryId = s.rel ? `${id}/${s.rel}` : id;
        const bundle = fs
          .readdirSync(s.dir, { withFileTypes: true })
          .filter((e) => !e.name.startsWith('.') && e.name !== 'SKILL.md')
          .map((e) => (e.isDirectory() ? e.name + '/' : e.name))
          .sort();
        return {
          id: entryId,
          name: fm.name || entryId.split('/').pop(),
          description: fm.description || '(no description)',
          file,
          bundle,
        };
      });
      if (entries.length) return { kind: 'menu', where: 'local', entries };
      // an empty folder is not a skill — fall through to the cloud
    }
  }

  try {
    const { text, status, bodyPath } = await sources.fetchSkill(cache, id);
    return {
      kind: 'skill',
      where: isGh(id) ? 'github' : 'hub',
      status,
      text,
      url: sources.skillUrl(id),
      // The cached copy is a real local file at the ID's tree path —
      // readable any time, safe to delete.
      cachePath: bodyPath || cache.location(sources.skillUrl(id)),
    };
  } catch (err) {
    if (err.code !== 'GONE') throw err;
    // No SKILL.md at the path — a directory is a menu. Fetching the menu
    // materializes each child SKILL.md, so the cache holds a real local dir.
    const entries = await sources.fetchMenu(cache, id);
    return {
      kind: 'menu',
      where: isGh(id) ? 'github' : 'hub',
      entries,
      cacheDir: path.join(cache.dir, diskPath(id)),
    };
  }
}

module.exports = { resolve };
