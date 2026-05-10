# GIG Component Inspector

Chrome DevTools extension for inspecting rendered GIG/GNG Angular component trees.

It can scan any inspected page for component host selectors with these prefixes:

- `sl-*`
- `gsm-*`
- `gig-*`
- `gng-*`
- `app-*`

## Features

- Adds a **GIG Components** panel to Chrome DevTools.
- Scans the inspected page and builds a rendered component tree from DOM nesting.
- Shows host attributes, classes, DOM path, Angular debug metadata when available, and safe component instance summaries.
- Resolves component source paths from the generated local `component-index.json` in this extension folder.
- Opens indexed `.component.ts` / `.component.html` files in VS Code.
- Rebuilds the source index through Chrome Native Messaging with the refresh icon in the DevTools panel.
- Double-clicking a tree node calls `inspect(element)` to select the real component host in the Elements panel.

## Install

1. Open Chrome.
2. Go to `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select this extension folder.
6. Copy `.env.sample` to `.env`.
7. Set `TOTALSALES_ROOT` in `.env`.
8. Register the native host:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\register-native-host.ps1
```

9. Reload the unpacked extension in `chrome://extensions`.

The extension ID is fixed by `manifest.json`:

```text
pnimpbggomkfmajomfnmpnfllnancnkk
```

If you change the manifest key, set `CHROME_EXTENSION_ID` in `.env` and rerun the registration script.

## Configuration

`.env` is local machine configuration and is intentionally ignored by git.

Example:

```text
TOTALSALES_ROOT=C:\Path\To\TotalSales
```

Optional values:

```text
CLIENT_APP_ROOT=C:\Path\To\TotalSales\Gng.TotalSales.UI\GIG.App.Sl\ClientApp
GNG_COMPONENT_INDEX_SCRIPT=C:\Path\To\TotalSales\Tools\gng-component-index.js
CHROME_EXTENSION_ID=pnimpbggomkfmajomfnmpnfllnancnkk
```

## Source Index

The recommended generator lives in the target project:

```text
<TotalSalesRoot>\Tools\gng-component-index.js
```

The panel refresh icon asks the native host to run that generator and write:

```text
.\component-index.json
```

That file is generated next to the extension files and ignored by git. When it does not exist, the refresh icon is red. While rebuilding it shows a loading state, then turns green and shows the update time and indexed component count.

Chrome's native messaging manifest is generated under `.\native\com.gng.dev_indexer.json` by the registration script. Chrome requires that manifest and the host launcher path to be absolute, so the generated file is local machine state and is ignored by git.

## How Double Click Works

The panel stores a temporary ID for each discovered component host. On double click it evaluates this in the inspected page:

```js
inspect(element)
```

This is the supported DevTools way to select a DOM node in the Elements panel. If the DOM changed since the last scan, refresh the component tree and try again.

## Limitations

- Angular production builds may not expose `window.ng`, so component class names and instance summaries can be unavailable.
- The component tree shows rendered component hosts, not every declared component in source.
- Template source and VS Code file paths require `component-index.json`.
- GNG/GIG/GSM framework components are treated as framework components.
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
- `native/gng-index-host.js`
- `scripts/register-native-host.ps1`

No frontend app build is required.
