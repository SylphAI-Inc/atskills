"use strict";
/**
 * Composition — resolving the SEVERAL references a single message carries.
 *
 * Its own module because it is a distinct protocol concern from resolution.
 * `resolver.ts` answers "what does one reference mean"; this answers "what does
 * a message of them mean, and in what order does it happen". Hosts need the
 * second rule as much as the first, and every host that reimplemented it got a
 * `for` loop with an `await` inside — N references costing N SEQUENTIAL round
 * trips, on the very capability the protocol exists for.
 *
 * THE SPLIT THAT MAKES THIS ADOPTABLE
 * `resolveMany` takes the single-reference resolver as an ARGUMENT. It owns the
 * policy — what may overlap, what must not, what order results come back in —
 * and knows nothing about how a reference is actually fetched. That matters for
 * a protocol meant to be implemented by other people: a host that shells out to
 * the CLI, or resolves over its own transport, or stubs resolution in tests,
 * gets the same composition semantics without adopting our resolver. The rules
 * live in one place; the plumbing stays the host's.
 *
 * `resolveSkills` below is simply `resolveMany` bound to this package's own
 * resolver — the convenience path, not the contract.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveMany = resolveMany;
exports.resolveSkills = resolveSkills;
const resolver_js_1 = require("./resolver.js");
/**
 * Resolve a message's references, overlapping the reads.
 *
 * Guarantees, all of which a sequential loop gave for free and which callers
 * depend on — this function exists to keep them while going concurrent:
 *
 *   ORDER      results[i] belongs to ids[i]. A host injects each reference at
 *              its own point of use, so a reordered batch puts the wrong skill
 *              in the wrong place.
 *   DEDUP      a repeated id resolves ONCE and the result is shared. Beyond
 *              saving a fetch this is correctness: two concurrent `:save`s of
 *              one id would race on the same directory.
 *   ISOLATION  one failure never rejects the batch. A rejected promise lands in
 *              its own slot via `onError`, and the rest of the message survives
 *              — per-reference failures are reported, not fatal.
 *   WRITES     references carrying `save` or `install` are NOT overlapped. They
 *              mutate `.atskills/` and append to a single `.autotrigger`, and
 *              concurrent appends interleave and drop lines. They run after the
 *              reads, sequentially, in the order written.
 *
 * @param onError builds the value for a reference whose resolver threw. Hosts
 *                model failure differently (a result object, a null, a tagged
 *                union), so the shape stays theirs.
 */
async function resolveMany(ids, flags, resolveOne, onError) {
    if (ids.length === 0)
        return [];
    const mutates = (i) => Boolean(flags[i]?.save || flags[i]?.install);
    const results = new Array(ids.length);
    // Reads: one promise per DISTINCT id, all dispatched before any is awaited.
    const inFlight = new Map();
    await Promise.all(ids.map(async (id, i) => {
        if (mutates(i))
            return;
        let p = inFlight.get(id);
        if (!p) {
            p = resolveOne(id, false, false).catch((e) => onError(id, e instanceof Error ? e : new Error(String(e))));
            inFlight.set(id, p);
        }
        results[i] = await p;
    }));
    // Writes: sequential, in the order the user wrote them.
    for (let i = 0; i < ids.length; i++) {
        if (!mutates(i))
            continue;
        try {
            results[i] = await resolveOne(ids[i], flags[i]?.save ?? false, flags[i]?.install ?? false);
        }
        catch (e) {
            results[i] = onError(ids[i], e instanceof Error ? e : new Error(String(e)));
        }
    }
    return results;
}
/**
 * `resolveMany` bound to this package's resolver — the convenience path for a
 * host that has no resolver of its own.
 */
async function resolveSkills(ids, opts, flags = []) {
    return resolveMany(ids, flags, (id, save, install) => (0, resolver_js_1.resolveSkill)(id, save, opts, install), (_id, error) => ({ success: false, error: error.message }));
}
