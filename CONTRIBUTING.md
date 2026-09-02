# Contributing

Thanks for taking a look. local-leaf is a small, single-user tool, so the bar is low: open an
issue or a pull request.

## Development

```bash
npm install          # also builds node-pty for the integrated terminal
npm run dev          # rebuilds the client on change; server on http://localhost:3737
```

- `server/` is the Express + WebSocket backend. Restart the server after changing it.
- `client/` is the browser app (CodeMirror 6, pdf.js, xterm.js), bundled by esbuild into `public/build/`.
- `bin/leaf.js` is the CLI; it only talks to the server's HTTP API.
- There is no test suite yet. Please exercise what you change in the browser and with `leaf`.

## Ground rules

- Keep it dependency-light and macOS-first; portability patches are welcome if they stay small.
- Never make the server reachable beyond localhost: it can run shell commands and read files.
- Do not commit anything from your own `projects/` folder.
