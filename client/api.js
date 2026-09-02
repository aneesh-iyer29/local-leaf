export async function api(method, path, body, { text = false } = {}) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    if (text) { opts.headers['Content-Type'] = 'text/plain'; opts.body = body; }
    else { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  }
  const res = await fetch(path, opts);
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error(data?.error || res.statusText);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const q = (s) => encodeURIComponent(s);
