import type { ArchGraphConfig } from '../core/config.js';
import type { GroundTruthEntry } from '../core/types.js';
import { iterateSourceFiles } from './scan.js';
import { stripComments } from './strip-comments.js';

/**
 * Ground truth для receiver-сайтов: декораторы @MessagePattern / @EventPattern.
 * Самый точный сигнал — однозначные NATS-маркеры.
 */
export async function enumerateHandlers(cfg: ArchGraphConfig): Promise<GroundTruthEntry[]> {
    const decoratorRe = /@(MessagePattern|EventPattern)\s*\(/g;
    const out: GroundTruthEntry[] = [];

    for await (const { file, content } of iterateSourceFiles(cfg, 'handlers GT')) {
        const stripped = stripComments(content);
        const lines = stripped.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i]!;
            if (line.trim().length === 0) continue;
            for (const m of line.matchAll(decoratorRe)) {
                out.push({
                    role: 'receiver',
                    location: { file, line: i + 1, column: (m.index ?? 0) + 1 },
                    matchedText: line.trim(),
                    context: `@${m[1]}`,
                });
            }
        }
    }

    return out;
}
