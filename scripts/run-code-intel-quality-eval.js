import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// Project sidecar output directories are supplied via env var
// ARCH_QUALITY_OUT_BY_PROJECT as JSON, or as CLI args of the form
// `--out=projectName:outDir`. Project names are never hard-coded so that
// internal product names stay out of the repository.
//
// Examples:
//   ARCH_QUALITY_OUT_BY_PROJECT='{"app-alpha":"/tmp/app-alpha"}' \
//     node scripts/run-code-intel-quality-eval.js
//   node scripts/run-code-intel-quality-eval.js \
//     --out=app-alpha:/tmp/app-alpha --out=app-beta:/tmp/app-beta
//
// Override paths with:
//   --questions=<path>       default: bench/code-intel/quality-questions-projects.json
//   --output=<path>          default: bench/code-intel/quality-eval-current.md

function parseOutByProject() {
  if (process.env.ARCH_QUALITY_OUT_BY_PROJECT) {
    return JSON.parse(process.env.ARCH_QUALITY_OUT_BY_PROJECT);
  }
  const map = {};
  for (const arg of process.argv.slice(2)) {
    if (!arg.startsWith('--out=')) continue;
    const rest = arg.slice('--out='.length);
    const colon = rest.indexOf(':');
    if (colon <= 0) throw new Error(`bad --out arg: ${arg} (expected --out=projectName:outDir)`);
    map[rest.slice(0, colon)] = rest.slice(colon + 1);
  }
  if (Object.keys(map).length === 0) {
    throw new Error(
      'no project out dirs supplied. Set ARCH_QUALITY_OUT_BY_PROJECT or pass --out=projectName:outDir args.',
    );
  }
  return map;
}

function getFlag(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const outByProject = parseOutByProject();
const questionsPath = getFlag('questions', 'bench/code-intel/quality-questions-projects.json');
const outputPath = getFlag('output', 'bench/code-intel/quality-eval-current.md');
const archBin = resolve('bin/arch-graph');
const questions = JSON.parse(readFileSync(questionsPath, 'utf8'));

const rows = [];
const byProject = new Map();
let pass = 0;
let partial = 0;
let fail = 0;

for (const question of questions) {
  const outDir = outByProject[question.project];
  if (!outDir) {
    throw new Error(`no sidecar out dir configured for project '${question.project}'`);
  }
  const args = splitCli(question.cli.replace(/^arch-graph\s+/, '')).concat(['--out', outDir]);
  let output = '';
  let error = '';
  try {
    output = execFileSync(archBin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    error = err.stderr || err.message;
  }

  const missingMust = question.mustContain.filter((item) => !output.includes(item));
  const presentNice = question.niceToHave.filter((item) => output.includes(item));
  const forbiddenFound = question.mustNotContain.filter((item) => output.includes(item));
  const mustScore = question.mustContain.length === 0
    ? 1
    : (question.mustContain.length - missingMust.length) / question.mustContain.length;
  const niceScore = question.niceToHave.length === 0
    ? 1
    : presentNice.length / question.niceToHave.length;
  const score = Number((mustScore * 0.8 + niceScore * 0.2).toFixed(2));
  const result = error
    ? 'ERROR'
    : forbiddenFound.length > 0 || mustScore < 0.7
      ? 'FAIL'
      : missingMust.length > 0
        ? 'PARTIAL'
        : niceScore < 1
          ? 'PARTIAL'
          : 'PASS';

  if (result === 'PASS') pass++;
  else if (result === 'PARTIAL') partial++;
  else fail++;

  const projectStats = byProject.get(question.project) ?? { pass: 0, partial: 0, fail: 0, total: 0, score: 0 };
  projectStats.total++;
  projectStats.score += score;
  if (result === 'PASS') projectStats.pass++;
  else if (result === 'PARTIAL') projectStats.partial++;
  else projectStats.fail++;
  byProject.set(question.project, projectStats);

  rows.push({
    ...question,
    result,
    score,
    missingMust,
    presentNice,
    forbiddenFound,
    error,
  });
}

let report = '# Code-Intel Quality Eval\n\n';
report += `Date: ${new Date().toISOString()}\n\n`;
report += 'This is a quality-oriented eval over proof packets, not a smoke string snapshot. ';
report += 'Each case has manually chosen `mustContain`, `niceToHave`, and `mustNotContain` checks. ';
report += '`PASS` requires all required and nice evidence, `PARTIAL` means the answer is usable but not complete, and `FAIL` marks missing core evidence or forbidden noise.\n\n';
report += `Summary: ${pass} PASS, ${partial} PARTIAL, ${fail} FAIL, ${questions.length} total.\n\n`;
report += '| Project | PASS | PARTIAL | FAIL | Avg score |\n';
report += '|---|---:|---:|---:|---:|\n';
for (const [project, stats] of byProject.entries()) {
  report += `| ${project} | ${stats.pass} | ${stats.partial} | ${stats.fail} | ${(stats.score / stats.total).toFixed(2)} |\n`;
}

report += '\n## Cases\n\n';
report += '| ID | Project | Category | Result | Score | Quality focus | Missing must | Nice hits | Forbidden found |\n';
report += '|---|---|---|---|---:|---|---|---|---|\n';
for (const row of rows) {
  report += `| ${escapeCell(row.id)} | ${escapeCell(row.project)} | ${escapeCell(row.category)} | ${row.result} | ${row.score.toFixed(2)} | ${escapeCell(row.qualityFocus)} | ${escapeCell(row.missingMust.join(', '))} | ${escapeCell(row.presentNice.join(', '))} | ${escapeCell(row.forbiddenFound.join(', ') || row.error)} |\n`;
}

writeFileSync(outputPath, report);
console.log(`Quality eval report generated: ${outputPath}`);

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
