/**
 * Utilities for preparing the data that is sent to the AI provider.
 *
 * Commit messages only need the staged diff, never the full contents of the
 * files that are about to be committed. When the diff is too large, the
 * oversized file diffs are replaced by compact local summaries (file stats
 * and changed function/class names) instead of sending their full contents.
 */

const ANSI_ESCAPE_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const DIFF_HEADER = /^diff --(?:git|cc|combined) /;
const HUNK_HEADER = /^@@@? /;
const HUNK_CONTEXT = /^@@+[^@]*@@+\s*(.*)$/;
const DIFF_METADATA = /^(new file mode|deleted file mode|old mode|new mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to|Binary files |GIT binary patch|Subproject commit)/;

const SUMMARY_HEADER =
  '\n[Large file diffs summarized locally; changed symbols and stats only]\n';

const RESERVED_NAMES = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'function',
  'return',
  'else',
  'do',
  'try',
  'with',
  'new',
  'typeof',
  'delete',
  'void',
  'await',
  'yield',
  'super',
  'this',
  'case',
  'default',
  'break',
  'continue',
  'throw',
  'in',
  'of',
  'instanceof',
  'let',
  'const',
  'var',
  'class',
  'interface',
  'enum',
  'type',
  'namespace',
  'module',
  'import',
  'export',
  'public',
  'private',
  'protected',
  'static',
  'async',
  'readonly',
  'abstract',
  'override',
  'final',
  'synchronized',
  'native',
  'virtual',
  'internal',
  'sealed',
  'partial',
  'self'
]);

const DECLARATION_PATTERNS: RegExp[] = [
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /^(?:export\s+|default\s+|public\s+|private\s+|protected\s+|static\s+|final\s+|abstract\s+|sealed\s+|partial\s+|const\s+|pub\s+)*(?:class|interface|enum|type|namespace|module|record)\s+([A-Za-z_$][\w$]*)/,
  /^(?:async\s+)?def\s+([A-Za-z_$][\w$]*)/,
  /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)/,
  /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_$][\w$]*)/,
  /^(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|impl|type|union)\s+([A-Za-z_$][\w$]*)/,
  /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/,
  // Class methods in JS/TS/Java/C#: name(...) { ... }
  /^(?:(?:public|private|protected|static|async|readonly|abstract|override|final|synchronized|native|virtual|internal|sealed|partial|get|set)\s+)*([A-Za-z_$][\w$]*(?:::[A-Za-z_$][\w$]*)*)\s*\([^)]*\)\s*(?::\s*[^{;]+)?(?:throws\s+[\w.,\s]+)?\s*\{/,
  // C/C++/Java/C# functions with a return type: Type name(args) { ... }
  /^(?:(?:public|private|protected|static|async|readonly|abstract|override|final|synchronized|native|virtual|internal|sealed|partial|inline|constexpr|extern)\s+)*(?:[\w:<>\[\],.?*&]+\s+)+([A-Za-z_$][\w$]*(?:::[A-Za-z_$][\w$]*)*)\s*\([^;{}]*\)\s*(?:(?:const|noexcept)\s*)*(?:throws\s+[\w.,\s]+)?(?::[^{;]+)?\s*\{/
];

const CONTEXT_PATTERNS: RegExp[] = [
  /\b(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /\b(?:class|interface|enum|struct|trait|impl|type|record)\s+([A-Za-z_$][\w$]*)/,
  /\b(?:def|func|fn)\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)/,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/,
  /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/
];

export interface PreparedDiff {
  /** The unified diff or local diff summary that should be sent to the AI. */
  diff: string;
  /** Number of files present in the staged diff (including summarized files). */
  fileCount: number;
  /** True when the size budget forced files to be summarized or omitted. */
  truncated: boolean;
  /** Files whose diff was replaced by a compact local summary. */
  summarizedFiles: string[];
  /** Files that were left out completely because of the size budget. */
  omittedFiles: string[];
}

interface FileDiff {
  filePath: string;
  text: string;
}

interface FileStats {
  added: number;
  removed: number;
  hunks: number;
}

/**
 * Removes terminal escape sequences and NUL bytes and drops anything that is
 * not part of a unified diff (for example Git warnings printed before the
 * diff). Returns an empty string when the output does not contain a diff.
 */
export function extractUnifiedDiff(raw: string): string {
  if (!raw) {
    return '';
  }

  const clean = raw
    .replace(ANSI_ESCAPE_SEQUENCE, '')
    .replace(/\0/g, '')
    .replace(/\r\n/g, '\n');

  const lines = clean.split('\n');
  const start = lines.findIndex((line) => DIFF_HEADER.test(line));

  if (start !== -1) {
    return lines.slice(start).join('\n').trim();
  }

  // Be tolerant of `---`/`+++` style patches without a `diff --git` header,
  // but still only keep the actual patch, never arbitrary file content.
  const hunk = lines.findIndex((line) => HUNK_HEADER.test(line));
  if (hunk === -1) {
    return '';
  }

  let patchStart = hunk;
  for (let i = hunk - 1; i >= 0 && i >= hunk - 2; i--) {
    if (lines[i].startsWith('--- ') || lines[i].startsWith('+++ ')) {
      patchStart = i;
    }
  }
  return lines.slice(patchStart).join('\n').trim();
}

/**
 * Splits a unified diff into one chunk per file. Everything before the first
 * `diff --git` header is ignored.
 */
function splitDiffByFile(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | undefined;

  for (const line of diff.split('\n')) {
    if (DIFF_HEADER.test(line)) {
      if (current) {
        files.push(current);
      }
      current = { filePath: getFilePath(line), text: `${line}\n` };
    } else if (current) {
      current.text += `${line}\n`;
    }
  }

  if (current) {
    files.push(current);
  }

  return files;
}

function getFilePath(diffHeader: string): string {
  const header = diffHeader.replace(DIFF_HEADER, '').trim();
  const match = header.match(/^"?a\/(.+?)"?\s+"?b\/(.+?)"?$/);

  if (match) {
    return match[2];
  }

  const parts = header.split(' ');
  return (parts[parts.length - 1] ?? '')
    .replace(/^"?(?:b\/)?/, '')
    .replace(/"$/, '');
}

/**
 * Keeps only the actual patch for each file. A chunk without hunks is only
 * valid when Git describes a rename, mode change, deletion or binary file;
 * anything else is discarded instead of being sent as file content.
 */
function isUsableFileDiff(file: FileDiff): boolean {
  if (file.text.split('\n').some((line) => HUNK_HEADER.test(line))) {
    return true;
  }

  return file.text
    .split('\n')
    .some((line) => DIFF_METADATA.test(line));
}

function getFileStats(file: FileDiff): FileStats {
  let added = 0;
  let removed = 0;
  let hunks = 0;

  for (const line of file.text.split('\n')) {
    if (HUNK_HEADER.test(line)) {
      hunks++;
    } else if (line.startsWith('+++') || line.startsWith('---')) {
      continue;
    } else if (line.startsWith('+')) {
      added++;
    } else if (line.startsWith('-')) {
      removed++;
    }
  }

  return { added, removed, hunks };
}

function getFileStatus(file: FileDiff): string {
  if (/^new file mode /m.test(file.text)) {
    return 'added';
  }
  if (/^deleted file mode /m.test(file.text)) {
    return 'deleted';
  }
  if (/^rename from /m.test(file.text)) {
    return 'renamed';
  }
  if (/^(?:Binary files |GIT binary patch)/m.test(file.text)) {
    return 'binary';
  }
  return 'modified';
}

function isReserved(name: string): boolean {
  const leaf = name.split(/[:.]/).pop() ?? name;
  return RESERVED_NAMES.has(leaf);
}

function collectSymbols(
  text: string,
  patterns: RegExp[],
  result: Set<string>
): void {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1] && !isReserved(match[1])) {
      result.add(match[1]);
    }
  }
}

/**
 * Extracts function/class/method names from the changed parts of a file diff.
 * Hunk headers provide the enclosing symbol for modifications; added and
 * removed declaration lines provide symbols for new or deleted code.
 */
function extractChangedSymbols(file: FileDiff): string[] {
  const symbols = new Set<string>();

  for (const line of file.text.split('\n')) {
    const hunkContext = line.match(HUNK_CONTEXT);
    if (hunkContext?.[1]) {
      collectSymbols(hunkContext[1], CONTEXT_PATTERNS, symbols);
      continue;
    }

    if (line.startsWith('+++') || line.startsWith('---')) {
      continue;
    }

    if (line.startsWith('+') || line.startsWith('-')) {
      const content = line.replace(/^[+-]+/, '').trim();
      if (content) {
        collectSymbols(content, DECLARATION_PATTERNS, symbols);
      }
    } else if (line.startsWith(' ')) {
      // Unchanged context inside a hunk can contain the declaration that
      // encloses the change, which is useful when Git has no hunk context.
      const content = line.slice(1).trim();
      if (content) {
        collectSymbols(content, DECLARATION_PATTERNS, symbols);
      }
    }
  }

  return [...symbols].slice(0, 8);
}

/**
 * Builds a compact, content-free representation of an oversized file diff.
 * It contains the file path, change type, hunk/line stats and the names of the
 * functions, classes or methods affected by the change.
 */
function summarizeFileDiff(file: FileDiff): string {
  const stats = getFileStats(file);
  const symbols = extractChangedSymbols(file);
  const symbolText =
    symbols.length > 0 ? `; changed symbols: ${symbols.join(', ')}` : '';

  return `[summary] ${file.filePath} (${getFileStatus(file)}, ${stats.hunks} hunk(s), +${stats.added}/-${stats.removed})${symbolText}\n`;
}

/**
 * A shorter summary for very small budgets: path, status and line stats only.
 */
function summarizeFileDiffCompact(file: FileDiff): string {
  const stats = getFileStats(file);

  return `[summary] ${file.filePath} (${getFileStatus(file)}, +${stats.added}/-${stats.removed})\n`;
}

function buildSummarySection(
  candidates: { file: FileDiff; text: string; compact: string }[],
  budget: number
): {
  section: string;
  summarizedFiles: string[];
  omittedFiles: string[];
} {
  // Prefer a section with the explanatory header only when it does not cost
  // symbol information. A header-less section may fit the full summaries
  // (with symbols) while the header would force compact summaries.
  let best:
    | {
        section: string;
        summarizedFiles: string[];
        omittedFiles: string[];
        fullCount: number;
      }
    | undefined;

  for (const includeHeader of [true, false]) {
    let remaining = budget - (includeHeader ? SUMMARY_HEADER.length : 0);
    if (remaining <= 0) {
      continue;
    }

    const lines: string[] = [];
    const summarizedFiles: string[] = [];
    const omittedFiles: string[] = [];
    let fullCount = 0;

    for (const candidate of candidates) {
      let line = '';
      if (candidate.text.length <= remaining) {
        line = candidate.text;
        fullCount++;
      } else if (candidate.compact.length <= remaining) {
        line = candidate.compact;
      }

      if (line) {
        lines.push(line);
        remaining -= line.length;
        summarizedFiles.push(candidate.file.filePath);
      } else {
        omittedFiles.push(candidate.file.filePath);
      }
    }

    if (lines.length === 0) {
      continue;
    }

    const result = {
      section: `${includeHeader ? SUMMARY_HEADER : ''}${lines.join('')}`,
      summarizedFiles,
      omittedFiles,
      fullCount
    };

    if (
      !best ||
      result.fullCount > best.fullCount ||
      (result.fullCount === best.fullCount &&
        result.summarizedFiles.length > best.summarizedFiles.length)
    ) {
      best = result;
    }
  }

  if (best) {
    return {
      section: best.section,
      summarizedFiles: best.summarizedFiles,
      omittedFiles: best.omittedFiles
    };
  }

  return {
    section: '',
    summarizedFiles: [],
    omittedFiles: candidates.map((candidate) => candidate.file.filePath)
  };
}

export interface StagedFileDiff {
  filePath: string;
  diff: string;
}

/**
 * Returns each staged file's unified diff. This is used by the per-file
 * overflow strategy, where every file is analyzed in a separate request.
 */
export function splitStagedDiffByFile(rawDiff: string): StagedFileDiff[] {
  const unifiedDiff = extractUnifiedDiff(rawDiff);

  return splitDiffByFile(unifiedDiff)
    .filter(isUsableFileDiff)
    .map((file) => ({
      filePath: file.filePath,
      diff: file.text.trim()
    }));
}

/**
 * Builds the payload that is sent to the AI provider.
 *
 * Only the staged unified diff is returned. When `maxChars` is greater than
 * zero and the diff is too large, full diffs are kept while they fit and the
 * remaining files are represented by local summaries (changed function/class
 * names and stats) instead of sending all of their content.
 */
export function prepareDiffPayload(
  rawDiff: string,
  maxChars = 60000
): PreparedDiff {
  const unifiedDiff = extractUnifiedDiff(rawDiff);
  const allFiles = splitDiffByFile(unifiedDiff).filter(isUsableFileDiff);

  if (allFiles.length === 0) {
    return {
      diff: '',
      fileCount: 0,
      truncated: false,
      summarizedFiles: [],
      omittedFiles: []
    };
  }

  const fullDiff = allFiles.map((file) => file.text).join('').trim();
  const unlimited = !Number.isFinite(maxChars) || maxChars <= 0;

  if (unlimited || fullDiff.length <= maxChars) {
    return {
      diff: fullDiff,
      fileCount: allFiles.length,
      truncated: false,
      summarizedFiles: [],
      omittedFiles: []
    };
  }

  const summaries = allFiles.map((file) => ({
    file,
    text: summarizeFileDiff(file),
    compact: summarizeFileDiffCompact(file)
  }));
  const summaryTotal = summaries.reduce(
    (total, summary) => total + summary.text.length,
    0
  );

  // Reserve room for local summaries, but never spend more than a quarter of
  // the budget on them (with a small floor for tiny budgets).
  const summaryCap = Math.max(100, Math.floor(maxChars * 0.25));
  const summaryBudget = Math.min(
    SUMMARY_HEADER.length + summaryTotal,
    summaryCap,
    maxChars
  );
  const rawBudget = Math.max(0, maxChars - summaryBudget);

  const rawChunks: string[] = [];
  const summaryCandidates: {
    file: FileDiff;
    text: string;
    compact: string;
  }[] = [];
  let rawUsed = 0;

  for (const summary of summaries) {
    if (rawUsed + summary.file.text.length <= rawBudget) {
      rawChunks.push(summary.file.text);
      rawUsed += summary.file.text.length;
    } else {
      summaryCandidates.push(summary);
    }
  }

  const summaryResult = buildSummarySection(summaryCandidates, summaryBudget);
  const summarizedFiles = summaryResult.summarizedFiles;
  const omittedFiles = summaryResult.omittedFiles;

  const parts: string[] = [];
  if (rawChunks.length > 0) {
    parts.push(rawChunks.join('').trim());
  }
  if (summaryResult.section) {
    parts.push(summaryResult.section.trim());
  }

  return {
    diff: parts.join('\n\n'),
    fileCount: allFiles.length,
    truncated: true,
    summarizedFiles,
    omittedFiles
  };
}