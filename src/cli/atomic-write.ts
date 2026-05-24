import { rename, unlink, writeFile } from 'node:fs/promises';

/**
 * Atomic file write: write to `<path>.tmp` then rename(2) onto `path`.
 *
 * On POSIX, rename is atomic within a filesystem, so a crash or SIGINT mid-
 * write leaves the previous content intact rather than a truncated file. This
 * is the safe default for any file we touch in a user's repo (CLAUDE.md,
 * .cursorrules, git hooks, the wizard's config output) — `writeFile` truncates
 * on open and can wipe user content if interrupted.
 *
 * `mode` is passed through so callers writing executables (e.g. git hooks)
 * still get the right permission bits.
 */
export async function atomicWrite(path: string, content: string, mode?: number): Promise<void> {
    const tmp = `${path}.tmp`;
    try {
        await writeFile(tmp, content, mode === undefined ? { encoding: 'utf8' } : { encoding: 'utf8', mode });
        await rename(tmp, path);
    } catch (err) {
        try {
            await unlink(tmp);
        } catch {
            // tmp may not exist if the writeFile itself failed before creating it.
        }
        throw err;
    }
}
