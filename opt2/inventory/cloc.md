# Legacy size report (cloc)
Source SHA: 696383140578f8dea3ece26f80cd7bfb370ddf0f

Measured with: cloc 1.98 · provenance: measured · measured at: 2026-11-10T22:29:54.456Z

The input is a `git archive` extraction of the pin, made outside the checkout; `harness/src/inventory/cloc.ts` regenerates this file.

## Command

Filtered measurement:

    cd <extraction-dir> && cloc --json --fullpath --quiet --not-match-d='(^|/)(core/vendor|core/mura/lib|admin/assets/js/(jquery|filebrowser/assets|bootstrap-slider|porthole|minigrid)|node_modules|\.git|\.github)(/|$)' --not-match-f='(^|/)(oneui\.js|shadowbox\.js|DD_belatedPNG\.js|html5\.js|less\.js|bootstrap-tabdrop\.js|ios-drag-drop\.js|package-lock\.json|[^/]+\.min\.(js|css)|[^/]+\.map)$|(^|/)admin/assets/css/(admin|admin-frontend|ie)\.css$|(^|/)core_assets/css/mura\.7\.[0-9]+(\.skin)?\.css$|(^|/)cta/js/mura\.displayobject\.cta\.js$|(^|/)cta/js/src/templates\.js$|(^|/)(core_assets|admin/assets)/js/mura\.js$' --by-file .

- `--not-match-d`: `(^|/)(core/vendor|core/mura/lib|admin/assets/js/(jquery|filebrowser/assets|bootstrap-slider|porthole|minigrid)|node_modules|\.git|\.github)(/|$)`
- `--not-match-f`: `(^|/)(oneui\.js|shadowbox\.js|DD_belatedPNG\.js|html5\.js|less\.js|bootstrap-tabdrop\.js|ios-drag-drop\.js|package-lock\.json|[^/]+\.min\.(js|css)|[^/]+\.map)$|(^|/)admin/assets/css/(admin|admin-frontend|ie)\.css$|(^|/)core_assets/css/mura\.7\.[0-9]+(\.skin)?\.css$|(^|/)cta/js/mura\.displayobject\.cta\.js$|(^|/)cta/js/src/templates\.js$|(^|/)(core_assets|admin/assets)/js/mura\.js$`

Unfiltered measurement:

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
| Unfiltered (excludes only `vendor`, `node_modules`, `.git`, `package-lock.json`, `*.min.js`, `*.min.css`, `*.map`) | 1,243 | 362,994 |

Directory patterns match a directory name at any depth.

Blank lines: 41,752; comment lines: 37,826. `cloc.json` lists the 1,179 counted files under `detail.perFile`.

## Planning comparison

Every figure matches the planning measurement made with cloc 1.98.
