import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// Project list is supplied via env var ARCH_BENCH_PROJECTS as JSON, or as CLI
// args of the form `name=outDir:questionsFile`. Project names are never
// hard-coded so that internal product names stay out of the repository.
//
// Example:
//   ARCH_BENCH_PROJECTS='[{"name":"app-alpha","out":"/tmp/app-alpha","questions":"bench/code-intel/questions-app-alpha.json"}]' \
//     node scripts/run-ci-snapshot.js
// Or:
//   node scripts/run-ci-snapshot.js \
//     app-alpha=/tmp/app-alpha:bench/code-intel/questions-app-alpha.json
//
// Output path defaults to bench/code-intel/snapshot-current.md and can be
// overridden with --output=<path>.

function parseProjects() {
  if (process.env.ARCH_BENCH_PROJECTS) {
    return JSON.parse(process.env.ARCH_BENCH_PROJECTS);
  }
  const list = [];
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    const colon = arg.indexOf(':', eq + 1);
    if (eq <= 0 || colon <= eq) {
      throw new Error(`bad project arg: ${arg} (expected name=outDir:questionsFile)`);
    }
    list.push({
      name: arg.slice(0, eq),
      out: arg.slice(eq + 1, colon),
      questions: arg.slice(colon + 1),
    });
  }
  if (list.length === 0) {
    throw new Error(
      'no projects supplied. Set ARCH_BENCH_PROJECTS or pass name=outDir:questionsFile args.',
    );
  }
  return list;
}

function getOutputPath() {
  const flag = process.argv.find((a) => a.startsWith('--output='));
  if (flag) return flag.slice('--output='.length);
  return 'bench/code-intel/snapshot-current.md';
}

const projects = parseProjects();
const archBin = resolve('bin/arch-graph');
const outputPath = getOutputPath();

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
