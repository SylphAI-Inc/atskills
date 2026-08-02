'use strict';
// Resolution — the whole rule: local first, by path. A folder at
// .atskills/<path> is the project's own and always answers; a cloud path with
// no such folder means the cloud. `.source` is never consulted to resolve.

const fs = require('fs');
const path = require('path');
const { diskPath, isGh } = require('./ids');
const { safeJoin, walkSkills, frontmatter, nearestSource } = require('./fsx');
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
      const entries = walkSkills(local).map((s) => ({
        id: s.rel ? `${id}/${s.rel}` : id,
        description: frontmatter(fs.readFileSync(path.join(s.dir, 'SKILL.md'), 'utf8')).description || '(no description)',
      }));
      if (entries.length) return { kind: 'menu', where: 'local', entries };
      // an empty folder is not a skill — fall through to the cloud
    }
  }

  try {
    const { text, status } = await sources.fetchSkill(cache, id);
    return { kind: 'skill', where: isGh(id) ? 'github' : 'hub', status, text, url: sources.skillUrl(id) };
  } catch (err) {
    if (err.code !== 'GONE') throw err;
    // No SKILL.md at the path — a directory is a menu.
    const entries = await sources.fetchMenu(cache, id);
    return { kind: 'menu', where: isGh(id) ? 'github' : 'hub', entries };
  }
}

module.exports = { resolve };
