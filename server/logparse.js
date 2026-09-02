// Parse a LaTeX .log (produced with -file-line-error and max_print_line raised) into structured
// error / warning / info entries with file + line where available.

const OPEN_FILE = /\(((?:\.{1,2}\/|\/)[^\s()]+)/g;

function normalizeFile(f) {
  if (!f) return null;
  return f.replace(/^\.\//, '').replace(/^"|"$/g, '');
}

export function parseLog(log) {
  const lines = log.split(/\r?\n/);
  const entries = [];
  const stack = [];
  let pendingError = null;

  const push = (e) => {
    if (e.file) e.file = normalizeFile(e.file);
    entries.push(e);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // file-line-error format: ./path/file.tex:12: Undefined control sequence.
    let m = line.match(/^(\.{0,2}\/?[^:\s][^:]*?\.(?:tex|sty|cls|bib|ltx|def|cfg|clo)):(\d+):\s*(.*)$/);
    if (m) {
      const err = { type: 'error', file: m[1], line: Number(m[2]), message: m[3].trim(), context: '' };
      // Collect the following context lines up to the "l.NN" line
      let j = i + 1;
      const ctx = [];
      while (j < lines.length && j < i + 12) {
        if (/^l\.\d+/.test(lines[j])) { ctx.push(lines[j]); j++; break; }
        if (lines[j].trim() && !lines[j].startsWith('!')) ctx.push(lines[j]);
        j++;
      }
      err.context = ctx.join('\n').trim();
      push(err);
      continue;
    }

    // Classic error: "! message" followed later by "l.NN"
    if (line.startsWith('! ')) {
      pendingError = { type: 'error', file: stack[stack.length - 1] || null, line: null, message: line.slice(2).trim(), context: '' };
      push(pendingError);
      continue;
    }
    if (pendingError) {
      const lm = line.match(/^l\.(\d+)\s?(.*)$/);
      if (lm) {
        pendingError.line = Number(lm[1]);
        pendingError.context = lm[2];
        pendingError = null;
        continue;
      }
      if (line.trim() === '' && i > 0 && lines[i - 1].trim() === '') pendingError = null;
    }

    // Warnings: "LaTeX Warning: ... on input line 12." / "Package foo Warning: ..."
    m = line.match(/^(LaTeX|Package \S+|Class \S+|pdfTeX|LuaTeX|XeTeX)\s+Warning:\s*(.*)$/);
    if (m) {
      let msg = m[2];
      let j = i + 1;
      // Continuation lines begin with "(package)" or are indented
      while (j < lines.length && (/^\([^)]+\)\s{2,}/.test(lines[j]) || (lines[j].startsWith('  ') && !lines[j].startsWith('   ')))) {
        msg += ' ' + lines[j].replace(/^\([^)]+\)\s*/, '').trim();
        j++;
      }
      const lineM = msg.match(/on input line (\d+)/);
      push({ type: 'warning', file: stack[stack.length - 1] || null, line: lineM ? Number(lineM[1]) : null, message: msg.trim(), context: '' });
      i = j - 1;
      continue;
    }

    // Overfull/Underfull boxes → info
    m = line.match(/^(Overfull|Underfull) \\[hv]box \((.*?)\) in paragraph at lines (\d+)--(\d+)/);
    if (m) {
      push({ type: 'info', file: stack[stack.length - 1] || null, line: Number(m[3]), message: `${m[1]} \\${line.includes('hbox') ? 'hbox' : 'vbox'} (${m[2]})`, context: '' });
      continue;
    }

    // Missing file / citations / references
    if (/^No file .*\.(bbl|aux|toc)\.$/.test(line)) {
      push({ type: 'info', file: null, line: null, message: line, context: '' });
    }

    // Track file stack from parentheses. We only track paths that look like files.
    OPEN_FILE.lastIndex = 0;
    let fm;
    const opens = [];
    while ((fm = OPEN_FILE.exec(line))) opens.push({ idx: fm.index, file: fm[1] });
    if (opens.length === 0 && !line.includes(')')) continue;
    // Walk the line char by char for balance, but only push file-looking opens.
    let k = 0;
    let oi = 0;
    while (k < line.length) {
      const ch = line[k];
      if (ch === '(') {
        if (oi < opens.length && opens[oi].idx === k) {
          stack.push(opens[oi].file);
          k += opens[oi].file.length + 1;
          oi++;
          continue;
        }
        stack.push(null);
      } else if (ch === ')') {
        stack.pop();
      }
      k++;
    }
  }

  return dedupe(entries);
}

function dedupe(entries) {
  const seen = new Set();
  return entries.filter((e) => {
    const key = `${e.type}|${e.file}|${e.line}|${e.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
