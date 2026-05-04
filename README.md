# GIG Component Inspector

Chrome DevTools extension for inspecting rendered GIG/GNG Angular component trees.

It is built for local development of the TotalSales Angular frontend, but it can scan any inspected page for component host selectors with these prefixes:

- `sl-*`
- `gsm-*`
- `gig-*`
- `gng-*`
- `app-*`

## Features

- Adds a **GIG Components** panel to Chrome DevTools.
- Scans the inspected page and builds a rendered component tree from DOM nesting.
- Shows host attributes, classes, DOM path, Angular debug metadata when available, and safe component instance summaries.
- Includes a **Created only** toggle for hiding GNG/GIG/GSM framework components and focusing on `sl-*` / `app-*` components.
- Shows indexed source metadata such as component class, relative `.component.ts` path, `.component.html` path, component folder, and route/page hints.
- Loads `.component.html` template source from a generated component index.
- Double-clicking a tree node calls `inspect(element)` to select the real component host in the Elements panel.

## Install

1. Open Chrome.
2. Go to `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select this folder:

```text
C:\Users\Yousefi.Naser\Desktop\personal\gng-dev
```

6. Open a local/dev Angular app page.
7. Open DevTools.
8. Click the **GIG Components** panel.
9. Click **Refresh**.

## Generate Template Source Index

The extension can discover rendered DOM components without an index. To show `.component.html` content, relative `.component.ts` paths, class names, and created/framework ownership, generate `component-index.json`.

From this folder:

```powershell
node .\scripts\build-component-index.js "C:\Users\Yousefi.Naser\Desktop\TotalSales\Gng.TotalSales.UI\GIG.App.Sl\ClientApp"
```

The generated file is written to:

```text
component-index.json
```

Reload the unpacked extension after generating it, or use **Load index** inside the DevTools panel and select the JSON file.

## How Double Click Works

The panel stores a temporary ID for each discovered component host. On double click it evaluates this in the inspected page:

```js
inspect(element)
```

This is the supported DevTools way to select a DOM node in the Elements panel. If the DOM changed since the last scan, refresh the component tree and try again.

## Limitations

- Angular production builds may not expose `window.ng`, so component class names and instance summaries can be unavailable.
- The component tree shows rendered component hosts, not every declared component in source.
- Template source requires `component-index.json` or another source mapping path.
- GNG/GIG/GSM framework components are treated as framework components. The **Created only** toggle keeps `sl-*` and `app-*` components visible and hides framework rows unless they contain visible created children.
- Library components such as `gig-crud-table` and `gng-data-grid` may not have local template source in the app project.
- The extension does not mutate application state or Angular components.

## Development Notes

The extension is intentionally vanilla JavaScript:

- `manifest.json`
- `devtools.html`
- `devtools.js`
- `panel.html`
- `panel.css`
- `panel.js`
- `inspected-bridge.js`
- `source-loader.js`
- `scripts/build-component-index.js`

No frontend app build is required.
