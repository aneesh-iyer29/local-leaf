# local-leaf — notes for agents

local-leaf is a browser LaTeX editor (Overleaf-style) backed by the TeX distribution on this Mac.
Projects live as plain folders in the workspace (`leaf workspace` prints it; the default is `projects/`, which this repo ignores). `leaf git commit` commits only the open project's files into whatever repository the workspace is.

## Work on a LaTeX project from the terminal

Use the `leaf` CLI (`bin/leaf.js`, also on PATH after `npm link`). It talks to the running
server, so anything you do is reflected live in the browser and vice versa.

```bash
leaf serve --detach            # start the server if `leaf status` says it is unreachable
leaf projects                  # what exists; * marks the open project
leaf open <name>               # open a workspace project (or a path to any folder)
leaf root                      # absolute path of the open project — edit files there directly
leaf files                     # file tree
leaf compile                   # compile main file, wait, print problems; exit 1 on failure
leaf problems --errors         # just the errors, with file:line
leaf log                       # full .log when a problem needs more context
leaf status                    # main file, engine, last compile, git summary
leaf git status / commit -m "…" / push
leaf help                      # everything else (set main/engine/auto, synctex, pdf, clean, import, new)
```

If you were started from local-leaf's integrated terminal panel (or any shell) inside a project folder (`projects/<name>`), that project is usually already
open in the browser; `leaf status` confirms it, `leaf open <name>` switches if not. `leaf compile
<file.tex>` builds that file when it has its own `\documentclass` (projects here often contain
several standalone documents), otherwise the main file.

Typical loop: edit files under `leaf root` with normal file tools → `leaf compile` → fix what
`leaf problems` reports → repeat. Auto-compile is usually on, so saving a file already triggers a
build in the browser; `leaf compile` forces one and blocks until it finishes.

Add `--json` to any command for machine-readable output.

## Repo layout

- `server/` Express + WebSocket backend (file API, latexmk runner, log parser, SyncTeX, watcher, git, workspace)
- `client/` browser app (CodeMirror 6, pdf.js), bundled by esbuild into `public/build/`
- `bin/leaf.js` the CLI
- `projects/` default workspace for user projects, ignored by this repo (a moved-in folder with its own .git stays standalone)

Run `npm run build` after changing anything in `client/`; restart the server after changing `server/`.
