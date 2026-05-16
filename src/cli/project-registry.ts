// Project registry — tracks which absolute project paths have had any
// arch-graph artefact installed (config, CLAUDE.md section, or git hook).
// Lets `arch-graph uninstall` clean up across all known projects in one shot
// without making the user `cd` into each.
//
// Location: $ARCH_GRAPH_REGISTRY override, else
//           $XDG_STATE_HOME/arch-graph/registry.json, else
//           ~/.local/state/arch-graph/registry.json
//
// Lives OUTSIDE ~/.arch-graph/ on purpose — global uninstall wipes the install
// dir, but we want the registry to survive a reinstall so the user can still
// clean up projects from before the reinstall.
//
// Format: { version: 1, projects: [{ path: <abs>, lastSeen: <iso8601> }, …] }
// Soft schema: unknown fields preserved on round-trip is NOT a requirement —
// JSON.parse + write-back will drop them. Acceptable for a state file we own.

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

const REGISTRY_VERSION = 1;

interface RegistryEntry {
    path: string;
    lastSeen: string;
}

interface Registry {
    version: number;
    projects: RegistryEntry[];
}

/** Absolute path to the registry file, honouring overrides + XDG. */
export function registryPath(): string {
    if (process.env.ARCH_GRAPH_REGISTRY) return process.env.ARCH_GRAPH_REGISTRY;
    const xdg = process.env.XDG_STATE_HOME;
    const base = xdg || resolve(homedir(), '.local', 'state');
    return resolve(base, 'arch-graph', 'registry.json');
}

/** Load + validate the registry. Returns an empty one on any I/O or parse error. */
async function loadRegistry(): Promise<Registry> {
    const path = registryPath();
    if (!existsSync(path)) return { version: REGISTRY_VERSION, projects: [] };

    let raw: string;
    try {
        raw = await readFile(path, 'utf8');
    } catch {
        return { version: REGISTRY_VERSION, projects: [] };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { version: REGISTRY_VERSION, projects: [] };
    }

    if (typeof parsed !== 'object' || parsed === null) {
        return { version: REGISTRY_VERSION, projects: [] };
    }
    const obj = parsed as Record<string, unknown>;
    if (!Array.isArray(obj.projects)) {
        return { version: REGISTRY_VERSION, projects: [] };
    }

    const projects: RegistryEntry[] = [];
    for (const item of obj.projects) {
        if (typeof item !== 'object' || item === null) continue;
        const it = item as Record<string, unknown>;
        if (typeof it.path === 'string' && it.path.length > 0) {
            const lastSeen = typeof it.lastSeen === 'string' ? it.lastSeen : new Date().toISOString();
            projects.push({ path: it.path, lastSeen });
        }
    }

    return { version: REGISTRY_VERSION, projects };
}

async function saveRegistry(reg: Registry): Promise<void> {
    const path = registryPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(reg, null, 2) + '\n', 'utf8');
}

/**
 * Record a project as installed. Idempotent — re-registering the same path
 * just refreshes lastSeen. Best-effort: I/O errors are swallowed so a
 * read-only registry never blocks `arch-graph init`.
 */
export async function registerProject(projectPath: string): Promise<void> {
    try {
        const abs = resolve(projectPath);
        const reg = await loadRegistry();
        const now = new Date().toISOString();
        const existing = reg.projects.find((p) => p.path === abs);
        if (existing) {
            existing.lastSeen = now;
        } else {
            reg.projects.push({ path: abs, lastSeen: now });
        }
        await saveRegistry(reg);
    } catch {
        // Best-effort — never block the caller on a registry write failure.
    }
}

/**
 * Remove a project from the registry. If the registry becomes empty, the
 * file is deleted (saves a stray empty file in $HOME after full teardown).
 */
export async function unregisterProject(projectPath: string): Promise<void> {
    try {
        const abs = resolve(projectPath);
        const reg = await loadRegistry();
        reg.projects = reg.projects.filter((p) => p.path !== abs);
        if (reg.projects.length === 0) {
            // Empty registry — delete the file outright. saveRegistry would
            // write `{"projects":[]}` which is just noise after full teardown.
            const path = registryPath();
            if (existsSync(path)) await unlink(path);
        } else {
            await saveRegistry(reg);
        }
    } catch {
        // Best-effort.
    }
}

/**
 * List all known project paths, auto-pruning entries whose directory no
 * longer exists. Pruning is persisted so the registry self-heals over time.
 */
export async function listProjects(): Promise<string[]> {
    const reg = await loadRegistry();
    const alive: RegistryEntry[] = [];
    const dead: RegistryEntry[] = [];
    for (const p of reg.projects) {
        if (existsSync(p.path)) alive.push(p);
        else dead.push(p);
    }
    if (dead.length > 0) {
        reg.projects = alive;
        if (alive.length === 0) {
            const path = registryPath();
            try {
                if (existsSync(path)) await unlink(path);
            } catch {
                // ignore
            }
        } else {
            try {
                await saveRegistry(reg);
            } catch {
                // ignore
            }
        }
    }
    return alive.map((p) => p.path);
}
