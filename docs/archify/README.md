# System maps

These are [Archify](https://github.com/tt-a1i/archify) artifacts. The `.json` files are the typed
source; the `.html` files are compiled, self-contained interactive viewers (generated, not edited);
the `.png` files are the visual-check renders the top-level README embeds.

GitHub Pages (`.github/workflows/pages.yml`) compiles the JSON on every push to `main` and publishes
this folder, so the live maps are:

- https://bartholomewtj.github.io/sightr/archify/sightr-runtime.architecture.html
- https://bartholomewtj.github.io/sightr/archify/sightr-reply.sequence.html

Do not hand-edit the HTML. Change the JSON, then regenerate.

## Re-render after a change

Install Archify once (`npx skills add tt-a1i/archify -g`), then from the repo root, with `ARCHIFY`
pointing at the installed skill's `bin/archify.mjs`:

```powershell
node $ARCHIFY deliver architecture docs/archify/sightr-runtime.architecture.json docs/archify/sightr-runtime.architecture.html --quality showcase --repo-root . --json
node $ARCHIFY visual-check docs/archify/sightr-runtime.architecture.html --json
node $ARCHIFY deliver sequence docs/archify/sightr-reply.sequence.json docs/archify/sightr-reply.sequence.html --quality showcase --json
node $ARCHIFY visual-check docs/archify/sightr-reply.sequence.html --json
```

`--repo-root .` makes the validator check every `sources` entry (file and line range) against the
current commit and pins that revision into the HTML, so a stale line reference fails the build
instead of pointing at the wrong code. Swap `deliver` for `validate` to check without rewriting.
