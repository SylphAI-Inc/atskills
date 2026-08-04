/**
 * @license
 * Copyright 2025 SylphAI Inc.
 */

/**
 * Residency — the auto-trigger prompt block, built ENTIRELY by the client.
 *
 * The protocol has one implementation per client: this one. The host that
 * assembles the model's prompt never parses `.autotrigger`, never walks
 * `.atskills/`, never touches the cache — it receives this block as a string
 * and splices it in verbatim. That keeps resolution, caching, and residency
 * in one codebase, so the management surface, the `@skills:` loader, and the
 * session prompt can never disagree.
 *
 * Each row matches the index-entry shape the backend uses for every other
 * skill source: `- name: description (path to SKILL.md)` — description first
 * so the trigger signal sits next to the name; the path is trailing metadata
 * the agent only needs after deciding to load the skill.
 *
 * Cloud lines resolve through the global validating cache, so calling this at
 * session start IS the "cloud lines refresh once per session" cadence:
 * unchanged upstreams serve instantly, offline serves the cached copy.
 * Per-line failures are never fatal — a line that loads nothing is reported
 * through the injected logger and the session goes on.
 */

import * as path from 'path';
import { SKILLS_DIR } from './ids.js';
import { frontmatter, pool } from './fsx.js';
import { expandLocalTriggers, parseTriggers } from './autotrigger.js';
import { resolveSkill, skillsRoot, type SkillResolverOpts } from './resolver.js';

const HEADER = 'Auto-triggered Skills (.atskills/.autotrigger):';

/** Cloud lines resolve concurrently — each may cost a network probe. */
const CLOUD_CONCURRENCY = 4;

/**
 * Build the block, or '' when nothing is resident. One skill loads once, no
 * matter how many lines cover it. A cloud line served from a stale cache is
 * marked IN ITS ROW — the block is what the user reads via "view prompt", so
 * the staleness note must live where they look, not in a dev log.
 */
export async function buildAutotriggerIndex(opts: SkillResolverOpts): Promise<string> {
  const root = skillsRoot(opts.workingDir);
  const wholeDirByLine = new Map(parseTriggers(root).map((e) => [e.line, e.wholeDir === true]));
  const rows: string[] = [];
  const seen = new Set<string>(); // SKILL.md paths — one skill loads once

  const push = (
    name: string | null | undefined,
    description: string | null | undefined,
    file: string,
    line: string,
    note = '',
  ) => {
    if (seen.has(file)) return;
    if (!name || !description) {
      opts.log?.warn(`[skills] .autotrigger line '${line}': ${file} is missing frontmatter (name + description) — skipped`);
      return;
    }
    seen.add(file);
    // Project files read as project-relative paths (.atskills/…): stable
    // across machines, no username in the prompt, and directly readable from
    // the project cwd. Cache paths stay absolute — they live outside it.
    const shown = file.startsWith(root + path.sep)
      ? path.join(SKILLS_DIR, path.relative(root, file))
      : file;
    rows.push(`- ${name}: ${description}${note} (${shown})`);
  };

  const resident = expandLocalTriggers(root);
  for (const r of resident) {
    if (r.error) {
      opts.log?.warn(`[skills] .autotrigger line '${r.line}': ${r.error}`);
    } else if (r.where !== 'cloud') {
      push(r.fm?.name, r.fm?.description, r.file as string, r.line);
    }
  }

  // Cloud lines with no local copy — resolved through the global cache,
  // concurrently (each line can cost an ls-remote; a cold one costs a clone).
  const cloud = resident.filter((r) => !r.error && r.where === 'cloud');
  const resolutions = await pool(cloud, CLOUD_CONCURRENCY, async (r) => ({
    r,
    resolved: await resolveSkill(r.id as string, false, opts),
  }));

  for (const { r, resolved } of resolutions) {
    if (!resolved.success) {
      opts.log?.warn(`[skills] .autotrigger line '${r.line}' loads nothing: ${resolved.error}`);
      continue;
    }
    const note = resolved.warning ? ' [served from cache — upstream unreachable, may be stale]' : '';
    if (resolved.warning) opts.log?.warn(`[skills] ${resolved.warning}`);
    if (resolved.kind === 'skill' && resolved.path && resolved.content !== undefined) {
      const fm = frontmatter(resolved.content);
      push(fm.name, fm.description, resolved.path, r.line, note);
    } else if (resolved.kind === 'menu' && wholeDirByLine.get(r.line)) {
      for (const entry of resolved.entries ?? []) {
        push(entry.name, entry.description, entry.path, r.line, note);
      }
    } else {
      // A single-skill line only ever loads the skill at its own path.
      opts.log?.warn(`[skills] .autotrigger line '${r.line}': no SKILL.md at the id's own path — loads nothing (write '@${r.id}/' for the whole directory)`);
    }
  }

  return rows.length > 0 ? `${HEADER}\n${rows.join('\n')}` : '';
}
