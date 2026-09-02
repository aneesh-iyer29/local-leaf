import * as pdfjsLib from 'pdfjs-dist';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/build/pdf.worker.js';

// A simple continuous-scroll PDF viewer with lazy page rendering, zoom, and SyncTeX hooks.
export function createPdfViewer(container, { onInverseSync, onPageChange }) {
  let doc = null;
  let scale = 1;
  let fitWidth = true;
  let pages = []; // { num, div, canvas, viewport, rendered, pdfPage }
  let renderToken = 0;
  const dpr = window.devicePixelRatio || 1;

  function pageWidthPt() { return pages[0]?.pdfPage.getViewport({ scale: 1 }).width || 612; }
  function computeFitScale() { return Math.max(0.2, (container.clientWidth - 24 - 2) / pageWidthPt()); }

  async function load(url) {
    const prevScroll = { top: container.scrollTop, left: container.scrollLeft, height: container.scrollHeight };
    const token = ++renderToken;
    let newDoc;
    try {
      newDoc = await pdfjsLib.getDocument({ url, disableAutoFetch: false }).promise;
    } catch (e) {
      throw e;
    }
    if (token !== renderToken) { newDoc.destroy(); return; }
    const old = doc;
    doc = newDoc;
    const newPages = [];
    for (let i = 1; i <= doc.numPages; i++) newPages.push({ num: i, pdfPage: await doc.getPage(i), rendered: false });
    if (token !== renderToken) return;
    pages = newPages;
    if (fitWidth) scale = computeFitScale();
    layout();
    // Restore the scroll position proportionally so recompiles don't jump around.
    if (prevScroll.height > 0) {
      const ratio = prevScroll.top / prevScroll.height;
      container.scrollTop = ratio * container.scrollHeight;
      container.scrollLeft = prevScroll.left;
    }
    renderVisible();
    old?.destroy();
  }

  // Render pages within a margin of the visible area. Scroll-driven rather than IntersectionObserver
  // so it behaves identically in every embedding (some webviews never fire IO callbacks).
  let fittedWidth = 0;
  function renderVisible() {
    // Self-heal: if we're in fit-width mode and the container width changed since the last layout, refit.
    if (fitWidth && pages.length && Math.abs(container.clientWidth - fittedWidth) > 2) {
      setScale(0, { fit: true });
      return;
    }
    const top = container.scrollTop - 600;
    const bottom = container.scrollTop + container.clientHeight + 600;
    for (const p of pages) {
      if (!p.div) continue;
      const pt = p.div.offsetTop;
      const pb = pt + p.div.offsetHeight;
      if (pb >= top && pt <= bottom) renderPage(p);
    }
    updateIndicator();
  }

  function layout() {
    fittedWidth = container.clientWidth;
    container.querySelectorAll('.pdf-page').forEach((el) => el.remove());
    for (const p of pages) {
      const vp = p.pdfPage.getViewport({ scale });
      p.viewport = vp;
      p.rendered = false;
      const div = document.createElement('div');
      div.className = 'pdf-page';
      div.dataset.page = p.num;
      div.style.width = `${Math.floor(vp.width)}px`;
      div.style.height = `${Math.floor(vp.height)}px`;
      const canvas = document.createElement('canvas');
      div.appendChild(canvas);
      p.div = div;
      p.canvas = canvas;
      div.addEventListener('click', (e) => {
        if (!(e.metaKey || e.ctrlKey)) return;
        const rect = div.getBoundingClientRect();
        const x = (e.clientX - rect.left) / scale;
        const y = (e.clientY - rect.top) / scale;
        onInverseSync({ page: p.num, x, y });
      });
      div.addEventListener('dblclick', (e) => {
        const rect = div.getBoundingClientRect();
        onInverseSync({ page: p.num, x: (e.clientX - rect.left) / scale, y: (e.clientY - rect.top) / scale });
      });
      container.appendChild(div);
    }
    renderVisible();
  }

  async function renderPage(p) {
    if (!p || p.rendered) return;
    p.rendered = true;
    const token = renderToken;
    const vp = p.viewport;
    p.canvas.width = Math.floor(vp.width * dpr);
    p.canvas.height = Math.floor(vp.height * dpr);
    p.canvas.style.width = `${Math.floor(vp.width)}px`;
    p.canvas.style.height = `${Math.floor(vp.height)}px`;
    const ctx = p.canvas.getContext('2d');
    try {
      await p.pdfPage.render({ canvasContext: ctx, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise;
    } catch (e) {
      if (e?.name !== 'RenderingCancelledException') console.error('pdf render failed', e);
      if (token === renderToken) p.rendered = false;
    }
  }

  function updateIndicator() {
    if (!pages.length) return onPageChange?.('');
    const mid = container.scrollTop + container.clientHeight / 2;
    let cur = 1;
    for (const p of pages) { if (p.div.offsetTop <= mid) cur = p.num; }
    onPageChange?.(`${cur} / ${pages.length}`);
  }
  let scrollTimer;
  container.addEventListener('scroll', () => { clearTimeout(scrollTimer); scrollTimer = setTimeout(renderVisible, 40); }, { passive: true });

  function setScale(s, { fit = false } = {}) {
    fitWidth = fit;
    const ratio = container.scrollTop / Math.max(1, container.scrollHeight);
    scale = fit ? computeFitScale() : Math.min(6, Math.max(0.25, s));
    if (!pages.length) return;
    layout();
    container.scrollTop = ratio * container.scrollHeight;
    renderVisible();
  }

  let resizeTimer;
  const onResize = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderVisible, 100); };
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(onResize).observe(container);
  window.addEventListener('resize', onResize);

  // Highlight a SyncTeX box: h,v are the box's bottom-left in PDF points from the top-left origin.
  function highlight({ page, h, v, W, H, x, y }) {
    const p = pages[page - 1];
    if (!p) return;
    const box = document.createElement('div');
    box.className = 'pdf-highlight';
    const height = Math.max(H || 0, 8);
    const width = Math.max(W || 0, 6);
    const left = (h ?? x) * scale;
    const top = ((v ?? y) - height) * scale;
    box.style.left = `${left - 2}px`;
    box.style.top = `${top - 2}px`;
    box.style.width = `${width * scale + 4}px`;
    box.style.height = `${height * scale + 4}px`;
    p.div.querySelectorAll('.pdf-highlight').forEach((el) => el.remove());
    p.div.appendChild(box);
    const targetTop = p.div.offsetTop + top - container.clientHeight / 3;
    container.scrollTo({ top: targetTop, behavior: 'smooth' });
    renderPage(p);
  }

  function clear() {
    renderToken++;
    container.querySelectorAll('.pdf-page').forEach((el) => el.remove());
    pages = [];
    doc?.destroy();
    doc = null;
    onPageChange?.('');
  }

  return {
    load,
    clear,
    highlight,
    zoomIn: () => setScale(scale * 1.2),
    zoomOut: () => setScale(scale / 1.2),
    fit: () => setScale(0, { fit: true }),
    get scale() { return scale; },
    get hasDoc() { return !!doc; },
  };
}
