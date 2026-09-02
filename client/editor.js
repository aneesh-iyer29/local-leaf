import { EditorState, Compartment, StateEffect, StateField } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars, Decoration } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { StreamLanguage, bracketMatching, indentOnInput, syntaxHighlighting, defaultHighlightStyle, foldGutter, foldKeymap } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { oneDark } from '@codemirror/theme-one-dark';

const COMMANDS = [
  'begin', 'end', 'section', 'subsection', 'subsubsection', 'chapter', 'paragraph', 'textbf', 'textit', 'emph',
  'underline', 'texttt', 'textsc', 'cite', 'ref', 'eqref', 'label', 'caption', 'includegraphics', 'input', 'include',
  'usepackage', 'documentclass', 'title', 'author', 'date', 'maketitle', 'tableofcontents', 'item', 'frac', 'sqrt',
  'sum', 'int', 'prod', 'lim', 'infty', 'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'theta', 'lambda', 'mu', 'pi',
  'sigma', 'phi', 'omega', 'partial', 'nabla', 'cdot', 'times', 'leq', 'geq', 'neq', 'approx', 'left', 'right',
  'mathbf', 'mathrm', 'mathcal', 'mathbb', 'text', 'hat', 'bar', 'vec', 'dot', 'newcommand', 'renewcommand',
  'footnote', 'hspace', 'vspace', 'newpage', 'clearpage', 'centering', 'hline', 'toprule', 'midrule', 'bottomrule',
  'multicolumn', 'textwidth', 'linewidth', 'noindent', 'bibliography', 'bibliographystyle', 'printbibliography',
  'url', 'href', 'today', 'LaTeX', 'TeX', 'ldots', 'dots', 'quad', 'qquad', 'displaystyle', 'boldsymbol',
];
const ENVS = ['document', 'itemize', 'enumerate', 'description', 'figure', 'table', 'tabular', 'equation', 'equation*',
  'align', 'align*', 'gather', 'center', 'abstract', 'verbatim', 'lstlisting', 'minipage', 'theorem', 'lemma', 'proof',
  'definition', 'example', 'remark', 'cases', 'matrix', 'pmatrix', 'bmatrix', 'tikzpicture', 'frame', 'quote'];

function latexCompletions(context) {
  const cmd = context.matchBefore(/\\[A-Za-z]*/);
  if (cmd && (cmd.from < cmd.to || context.explicit)) {
    return {
      from: cmd.from,
      options: COMMANDS.map((c) => ({ label: `\\${c}`, type: 'keyword' })).concat([
        { label: '\\begin', detail: 'environment', type: 'keyword', apply: (view, c, from, to) => {
          view.dispatch({ changes: { from, to, insert: '\\begin{}\n\n\\end{}' }, selection: { anchor: from + 7 } });
        } },
      ]),
      validFor: /^\\[A-Za-z]*$/,
    };
  }
  const env = context.matchBefore(/\\(?:begin|end)\{[A-Za-z*]*/);
  if (env) {
    const brace = env.text.indexOf('{') + 1;
    return { from: env.from + brace, options: ENVS.map((e) => ({ label: e, type: 'type' })), validFor: /^[A-Za-z*]*$/ };
  }
  // \ref{ / \cite{ completions from document labels & keys
  const ref = context.matchBefore(/\\(?:ref|eqref|autoref|cref|Cref|pageref)\{[^}]*/);
  if (ref) {
    const brace = ref.text.indexOf('{') + 1;
    const labels = [...context.state.doc.toString().matchAll(/\\label\{([^}]+)\}/g)].map((m) => m[1]);
    return { from: ref.from + brace, options: [...new Set(labels)].map((l) => ({ label: l, type: 'variable' })), validFor: /^[^}]*$/ };
  }
  const cite = context.matchBefore(/\\(?:cite|citep|citet|textcite|parencite|autocite)\{[^}]*/);
  if (cite && window.__bibKeys?.length) {
    const brace = cite.text.indexOf('{') + 1;
    const before = cite.text.slice(brace);
    const lastComma = before.lastIndexOf(',');
    return { from: cite.from + brace + lastComma + 1, options: window.__bibKeys.map((k) => ({ label: k, type: 'variable' })), validFor: /^[^},]*$/ };
  }
  return null;
}

// Highlight decoration used to flash the line targeted by an inverse SyncTeX jump.
const setFlash = StateEffect.define();
const flashField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) if (e.is(setFlash)) deco = e.value;
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});
const flashLine = Decoration.line({ class: 'cm-synctex-line' });

export function createEditor(parent, { onSave, onCompile, onSyncForward, onChange }) {
  const language = new Compartment();
  const state = EditorState.create({
    doc: '',
    extensions: [
      lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), foldGutter(), drawSelection(),
      dropCursor(), EditorState.allowMultipleSelections.of(true), indentOnInput(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }), bracketMatching(), closeBrackets(),
      autocompletion({ override: [latexCompletions] }), rectangularSelection(), crosshairCursor(), highlightActiveLine(),
      highlightSelectionMatches(),
      keymap.of([
        { key: 'Mod-s', run: () => { onSave(); return true; } },
        { key: 'Mod-Enter', run: () => { onCompile(); return true; } },
        { key: 'Mod-Shift-j', run: () => { onSyncForward(); return true; } },
        ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab,
      ]),
      language.of(StreamLanguage.define(stex)),
      oneDark,
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ spellcheck: 'true', autocorrect: 'off', autocapitalize: 'off' }),
      flashField,
      EditorView.updateListener.of((u) => { if (u.docChanged) onChange(); }),
    ],
  });
  const view = new EditorView({ state, parent });

  return {
    view,
    getText: () => view.state.doc.toString(),
    setText(text, { preserve = true } = {}) {
      const cur = view.state.doc.toString();
      if (cur === text) return;
      const sel = view.state.selection.main;
      const scroll = view.scrollDOM.scrollTop;
      view.dispatch({ changes: { from: 0, to: cur.length, insert: text }, selection: preserve ? { anchor: Math.min(sel.anchor, text.length) } : { anchor: 0 } });
      if (preserve) view.scrollDOM.scrollTop = scroll;
    },
    gotoLine(line, column = 0, { flash = true } = {}) {
      const l = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
      const pos = Math.min(l.from + column, l.to);
      view.dispatch({
        selection: { anchor: pos },
        effects: [
          EditorView.scrollIntoView(pos, { y: 'center' }),
          ...(flash ? [setFlash.of(Decoration.set([flashLine.range(l.from)]))] : []),
        ],
      });
      view.focus();
      if (flash) setTimeout(() => view.dispatch({ effects: setFlash.of(Decoration.none) }), 1500);
    },
    cursor() {
      const pos = view.state.selection.main.head;
      const l = view.state.doc.lineAt(pos);
      return { line: l.number, column: pos - l.from };
    },
    focus: () => view.focus(),
  };
}
