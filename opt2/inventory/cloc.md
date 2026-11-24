# Legacy size report (cloc)
Source SHA: 696383140578f8dea3ece26f80cd7bfb370ddf0f

Measured with: cloc 1.98 · provenance: measured · measured at: 2026-11-24T12:09:13.282Z

The input is a `git archive` extraction of the pin, made outside the checkout; `harness/src/inventory/cloc.ts` regenerates this file.

## Command

Filtered measurement:

    cd <extraction-dir> && cloc --json --fullpath --quiet --not-match-d='(^|/)(core/vendor|core/mura/lib|admin/assets/js/(jquery|filebrowser/assets|bootstrap-slider|porthole|minigrid)|node_modules|\.git|\.github)(/|$)' --not-match-f='(^|/)(oneui\.js|shadowbox\.js|DD_belatedPNG\.js|html5\.js|less\.js|bootstrap-tabdrop\.js|ios-drag-drop\.js|package-lock\.json|[^/]+\.min\.(js|css)|[^/]+\.map)$|(^|/)admin/assets/css/(admin|admin-frontend|ie)\.css$|(^|/)core_assets/css/mura\.7\.[0-9]+(\.skin)?\.css$|(^|/)cta/js/mura\.displayobject\.cta\.js$|(^|/)cta/js/src/templates\.js$|(^|/)(core_assets|admin/assets)/js/mura\.js$' --by-file .

- `--not-match-d`: `(^|/)(core/vendor|core/mura/lib|admin/assets/js/(jquery|filebrowser/assets|bootstrap-slider|porthole|minigrid)|node_modules|\.git|\.github)(/|$)`
- `--not-match-f`: `(^|/)(oneui\.js|shadowbox\.js|DD_belatedPNG\.js|html5\.js|less\.js|bootstrap-tabdrop\.js|ios-drag-drop\.js|package-lock\.json|[^/]+\.min\.(js|css)|[^/]+\.map)$|(^|/)admin/assets/css/(admin|admin-frontend|ie)\.css$|(^|/)core_assets/css/mura\.7\.[0-9]+(\.skin)?\.css$|(^|/)cta/js/mura\.displayobject\.cta\.js$|(^|/)cta/js/src/templates\.js$|(^|/)(core_assets|admin/assets)/js/mura\.js$`

Unfiltered measurement:

    cd <extraction-dir> && cloc --json --fullpath --quiet --not-match-d='(^|/)(core/vendor|node_modules|\.git)(/|$)' .

- `--not-match-d`: `(^|/)(core/vendor|node_modules|\.git)(/|$)`

Planning basis of the unfiltered figure:

    cd <extraction-dir> && cloc --json --fullpath --quiet --not-match-d='(^|/)(vendor|node_modules|\.git)(/|$)' --not-match-f='(^|/)(package-lock\.json|[^/]+\.min\.(js|css)|[^/]+\.map)$' .

- `--not-match-d`: `(^|/)(vendor|node_modules|\.git)(/|$)`
- `--not-match-f`: `(^|/)(package-lock\.json|[^/]+\.min\.(js|css)|[^/]+\.map)$`

## Exclusions

| Exclusion | Patterns | Why |
|---|---|---|
| Vendored code | `core/vendor`, `core/mura/lib`, `admin/assets/js/{jquery,filebrowser/assets,bootstrap-slider,porthole,minigrid}`, `oneui.js`, `shadowbox.js`, `DD_belatedPNG.js`, `html5.js`, `less.js`, `bootstrap-tabdrop.js`, `ios-drag-drop.js` | Not Masa application code |
| Generated files | `admin/assets/css/{admin,admin-frontend,ie}.css`, `core_assets/css/mura.7.x(.skin).css`, `*.min.js`, `*.min.css`, `*.map`, `cta/js/mura.displayobject.cta.js`, `cta/js/src/templates.js`, `core_assets/js/mura.js`, `admin/assets/js/mura.js` | Build output (gulpfile.js LESS, GruntFile.js, webpack) |
| Tooling | `node_modules`, `.git`, `package-lock.json` | Not code; the .git pattern also covers .github |

## Result

| Language | Files | Code lines |
|---|---:|---:|
| ColdFusion CFScript | 307 | 95,807 |
| ColdFusion (tags) | 568 | 51,044 |
| LESS | 153 | 32,856 |
| Properties (resource bundles) | 41 | 26,002 |
| JavaScript | 40 | 12,860 |
| SQL | 6 | 4,504 |
| SVG | 7 | 3,233 |
| CSS | 25 | 1,184 |
| Text, JSON, YAML, Markdown, HTML, Handlebars | 32 | 1,349 |
| **Total** | **1,179** | **228,839** |

## Derived figures

| Figure | Files | Code lines |
|---|---:|---:|
| CFML application code (CFScript + tags) | 875 | 146,851 |
| Unfiltered (excludes only `core/vendor`, `node_modules` and `.git`) | 1,350 | 368,039 |
| Unfiltered, planning basis (also excludes `vendor`, `package-lock.json`, `*.min.js`, `*.min.css` and `*.map`) | 1,243 | 362,994 |

Directory patterns match a directory name at any depth.

Blank lines: 41,752; comment lines: 37,826. `cloc.json` lists the 1,179 counted files under `detail.perFile`.

## Unfiltered reconciliation

The planning basis measures 1,243 files and 362,994 code lines, which equals the unfiltered planning figure of 1,243 / 362,994 measured with cloc 1.98.

Each row is what one exclusion removes after the rows above it:

| Exclusion | Files | Code lines |
|---|---:|---:|
| `vendor` | 2 | 432 |
| `package-lock.json` | 2 | 4,410 |
| `*.min.js`, `*.min.css` and `*.map` | 103 | 203 |
| **Total** | **107** | **5,045** |

## Planning comparison

These figures differ from the planning measurement made with cloc 1.98; the measured values are the ones reported.

| Figure | Planning files | Planning code lines | Measured files | Measured code lines |
|---|---:|---:|---:|---:|
| unfiltered | 1,243 | 362,994 | 1,350 | 368,039 |
