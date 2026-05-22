import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const projects = [
  { name: 'project-alpha', out: '<tmp>/project-alpha', questions: 'bench/code-intel/questions-project-alpha.json' },
  { name: 'project-beta', out: '<tmp>/project-beta', questions: 'bench/code-intel/questions-project-beta.json' },
  { name: 'project-gamma', out: '<tmp>/project-gamma', questions: 'bench/code-intel/questions-project-gamma.json' }
];

const archBin = resolve('bin/arch-graph');
const outputPath = 'bench/code-intel/snapshot-2026-05-22-current.md';

let report = '# Code-Intel Project Questions Snapshot\n\n';
report += 'Date: ' + new Date().toISOString() + '\n\n';
report += 'Sidecars: `<tmp>/*/code-intel`.\n\n';

let total = 0;
let passedTotal = 0;
const projectSummaries = [];

for (const project of projects) {
  let projectTotal = 0;
  let projectPassed = 0;
  const diagnostics = readDiagnostics(project.out);
  report += `## Project: ${project.name}\n\n`;
  if (diagnostics) {
    report += `Index: ${diagnostics.counts.symbols} symbols, ${diagnostics.counts.calls} calls, `;
    report += `${diagnostics.counts.flows} flows, ${diagnostics.counts.branches} branches, `;
    report += `${diagnostics.counts.impacts} impacts. `;
    report += `Project resolved ratio: ${diagnostics.counts.projectResolvedCallRatio ?? 'n/a'}.\n\n`;
  }
  report += '| ID | Category | Question | Tool | Result | Details |\n';
  report += '|---|---|---|---|---|---|\n';

  const questions = JSON.parse(readFileSync(project.questions, 'utf8'));

  for (const q of questions) {
    total++;
    projectTotal++;
    const args = splitCli(q.cli.replace(/^arch-graph\s+/, '')).concat(['--out', project.out]);

    let result = 'FAIL';
    let details = '';
    try {
      const output = execFileSync(archBin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const passed = q.expectedContains.every(str => output.includes(str));
      if (passed) {
        result = 'PASS';
        passedTotal++;
        projectPassed++;
      } else {
        details = 'Missing: ' + q.expectedContains.filter(str => !output.includes(str)).join(', ');
      }
    } catch (err) {
      result = 'ERROR';
      details = err.stderr || err.message;
    }

    report += `| ${escapeCell(q.id)} | ${escapeCell(q.category)} | ${escapeCell(q.question)} | ${escapeCell(q.tool)} | ${result} | ${escapeCell(details)} |\n`;
  }
  report += '\n';
  projectSummaries.push({ name: project.name, passed: projectPassed, total: projectTotal });
}

const summary = [
  '## Summary',
  '',
  `Total: ${passedTotal}/${total} PASS.`,
  '',
  '| Project | PASS | Total |',
  '|---|---:|---:|',
  ...projectSummaries.map((project) => `| ${project.name} | ${project.passed} | ${project.total} |`),
  '',
].join('\n');
report = report.replace('\nSidecars:', `\n${summary}\nSidecars:`);

writeFileSync(outputPath, report);
console.log(`Snapshot report generated: ${outputPath}`);

function readDiagnostics(outDir) {
  try {
    return JSON.parse(readFileSync(`${outDir}/code-intel/diagnostics.json`, 'utf8'));
  } catch {
    return null;
  }
}

function splitCli(input) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(input)) !== null) {
    out.push(match[1] ?? match[2] ?? match[3]);
  }
  return out;
}

function escapeCell(value) {
  return String(value ?? '')
    .replace(/\n/g, ' ')
    .replace(/\|/g, '\\|');
}
