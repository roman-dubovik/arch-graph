import { writeFile } from 'node:fs/promises';
import { relative } from 'node:path';

import type { ProjectConfig, ValidationReport } from './types.js';

export async function writeMarkdownReport(
    report: ValidationReport,
    cfg: ProjectConfig,
    outPath: string,
): Promise<void> {
    const md: string[] = [];
    const s = report.summary;
    const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

    md.push(`# ${cfg.id} — validation report`);
    md.push('');
    md.push(`_${report.timestamp}_`);
    md.push('');
    md.push(`## Summary`);
    md.push('');
    md.push(`| Metric | Value | Target |`);
    md.push(`|---|---|---|`);
    md.push(`| Recall @ handlers | **${pct(s.recallHandlers)}** | ≥ 99% |`);
    md.push(`| Recall @ senders | **${pct(s.recallSenders)}** | ≥ 95% |`);
    md.push(`| Classification accuracy (excl. unresolved) | **${pct(s.classificationAccuracy)}** | ≥ 95% |`);
    md.push(`| Concrete resolve rate (literal+pattern) | ${pct(s.resolveRate)} | informational |`);
    md.push(`| Total extracted | ${s.totalExtracted} | |`);
    md.push(`| Total ground truth | ${s.totalGroundTruth} | |`);
    md.push(`| Missed (in GT, not extracted) | ${report.missed.length} | |`);
    md.push(`| Extra (extracted, not GT) | ${report.extra.length} | |`);
    md.push('');

    if (report.missed.length > 0) {
        md.push(`## Missed (top 30)`);
        md.push('');
        md.push(`| File | Line | Role | Context | Code |`);
        md.push(`|---|---|---|---|---|`);
        for (const m of report.missed.slice(0, 30)) {
            md.push(
                `| ${relative(cfg.root, m.location.file)} | ${m.location.line} | ${m.role} | ${m.context} | \`${escapeMd(m.matchedText)}\` |`,
            );
        }
        md.push('');
    }

    if (report.extra.length > 0) {
        md.push(`## Extra (top 30)`);
        md.push('');
        md.push(`| File | Line | Role | Via | Subject |`);
        md.push(`|---|---|---|---|---|`);
        for (const e of report.extra.slice(0, 30)) {
            md.push(
                `| ${relative(cfg.root, e.location.file)} | ${e.location.line} | ${e.role} | ${e.via} | ${describeSubject(e.subject)} |`,
            );
        }
        md.push('');
    }

    if (report.unresolvedSamples.length > 0) {
        md.push(`## Unresolved / dynamic (top 30)`);
        md.push('');
        md.push(`| File | Line | Via | Raw |`);
        md.push(`|---|---|---|---|`);
        for (const u of report.unresolvedSamples) {
            md.push(
                `| ${relative(cfg.root, u.location.file)} | ${u.location.line} | ${u.via} | ${describeSubject(u.subject)} |`,
            );
        }
        md.push('');
    }

    // breakdown by subject kind
    const kinds = new Map<string, number>();
    for (const e of report.extracted) {
        kinds.set(e.subject.kind, (kinds.get(e.subject.kind) ?? 0) + 1);
    }
    md.push(`## Subject kinds breakdown`);
    md.push('');
    md.push(`| Kind | Count |`);
    md.push(`|---|---|`);
    for (const [k, v] of [...kinds.entries()].sort((a, b) => b[1] - a[1])) {
        md.push(`| ${k} | ${v} |`);
    }
    md.push('');

    await writeFile(outPath, md.join('\n'), 'utf8');
}

function describeSubject(s: ValidationReport['extracted'][number]['subject']): string {
    switch (s.kind) {
        case 'literal':
            return `\`literal:${s.value}\``;
        case 'pattern':
            return `\`pattern:${s.pattern}\``;
        case 'dynamic':
            return `dynamic: ${escapeMd(s.hint)}`;
        case 'unresolved':
            return `unresolved (${s.reason}): \`${escapeMd(s.raw).slice(0, 60)}\``;
    }
}

function escapeMd(s: string): string {
    return s.replace(/\|/g, '\\|');
}

export async function writeJsonReport(report: ValidationReport, outPath: string): Promise<void> {
    await writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
}
