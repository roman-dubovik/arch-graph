import { readFile } from 'node:fs/promises';
import type { ArchGraph } from './types.js';

/**
 * Loads a structural ArchGraph from a JSON file.
 * Returns the parsed graph object.
 * Throws if the file is missing or invalid JSON.
 */
export async function loadGraph(path: string): Promise<ArchGraph> {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as ArchGraph;
}
