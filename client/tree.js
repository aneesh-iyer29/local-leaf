// Renders the project file tree with expand/collapse, selection, context menu and drag-drop upload.
export function createTree(container, { onOpen, onContext, onUpload }) {
  const collapsed = new Set();
  let selected = null;
  let mainFile = null;
  let data = [];

  const ICONS = { dir: '▸', tex: '𝑇', bib: '≡', img: '▨', pdf: '▤', other: '·' };
  function kind(node) {
    if (node.type === 'dir') return 'dir';
    if (['.tex', '.ltx', '.sty', '.cls'].includes(node.ext)) return 'tex';
    if (node.ext === '.bib') return 'bib';
    if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.eps'].includes(node.ext)) return 'img';
    if (node.ext === '.pdf') return 'pdf';
    return 'other';
  }

  function render() {
    container.innerHTML = '';
    if (!data.length) { container.innerHTML = '<div class="empty">Empty folder</div>'; return; }
    container.appendChild(renderList(data, 0));
  }

  function renderList(nodes, depth) {
    const ul = document.createElement('ul');
    for (const n of nodes) {
      const li = document.createElement('li');
      const row = document.createElement('div');
      const k = kind(n);
      row.className = `row ${k}` + (n.path === selected ? ' selected' : '') + (n.path === mainFile ? ' main' : '');
      row.style.paddingLeft = `${8 + depth * 14}px`;
      row.dataset.path = n.path;
      row.dataset.type = n.type;
      row.title = n.path;
      const caret = document.createElement('span');
      caret.className = 'caret';
      caret.textContent = n.type === 'dir' ? (collapsed.has(n.path) ? '▸' : '▾') : '';
      const icon = document.createElement('span');
      icon.className = 'icon';
      icon.textContent = n.type === 'dir' ? '' : ICONS[k];
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = n.name;
      row.append(caret, icon, name);
      row.addEventListener('click', () => {
        if (n.type === 'dir') {
          collapsed.has(n.path) ? collapsed.delete(n.path) : collapsed.add(n.path);
          render();
        } else {
          onOpen(n);
        }
      });
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); onContext(e, n); });
      li.appendChild(row);
      if (n.type === 'dir') {
        if (collapsed.has(n.path)) li.classList.add('collapsed');
        li.appendChild(renderList(n.children || [], depth + 1));
      }
      ul.appendChild(li);
    }
    return ul;
  }

  container.addEventListener('contextmenu', (e) => {
    if (e.target === container || e.target.tagName === 'UL') { e.preventDefault(); onContext(e, null); }
  });
  container.addEventListener('dragover', (e) => { e.preventDefault(); container.classList.add('dragover'); });
  container.addEventListener('dragleave', () => container.classList.remove('dragover'));
  container.addEventListener('drop', (e) => {
    e.preventDefault();
    container.classList.remove('dragover');
    const target = e.target.closest('.row');
    let dir = '';
    if (target) dir = target.dataset.type === 'dir' ? target.dataset.path : target.dataset.path.split('/').slice(0, -1).join('/');
    if (e.dataTransfer.files.length) onUpload([...e.dataTransfer.files], dir);
  });

  return {
    set(nodes) { data = nodes || []; render(); },
    select(path) { selected = path; render(); },
    setMain(path) { mainFile = path; render(); },
    find(path) {
      const walk = (nodes) => { for (const n of nodes) { if (n.path === path) return n; if (n.children) { const r = walk(n.children); if (r) return r; } } return null; };
      return walk(data);
    },
    expandTo(path) {
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) collapsed.delete(parts.slice(0, i).join('/'));
    },
  };
}
