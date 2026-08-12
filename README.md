# Views

Views adds more ways to display [Obsidian Bases](https://help.obsidian.md/bases). It uses the filters, sorting, grouping, formulas, and properties already configured in your Base.

## Included views

### Collection

Displays files as cards in a carousel or grid.

- Choose a property for the title and image.
- Use top to bottom, image left, or image right layouts.
- Set card width, height, shape, spacing, image fit, and image share.
- Show properties selected in the standard Bases properties menu.
- Add colors from frontmatter or assign them automatically from a color pack.
- Add icons from frontmatter, folder rules, or Notebook Navigator folder icons.
- Handles large Bases by loading cards in batches.

### Timeline

Displays files along a time axis.

- Use date properties or file creation and modification times.
- Set start and end properties.
- Group entries and change the time scale or density.
- Keep entries without dates available in a separate drawer.

### Table colors

Adds color to the built-in Bases table.

- Read colors from a frontmatter property such as `color`.
- Assign consistent colors automatically from another property such as `status`.
- Use the included Notion, Pastel, Vivid, and Earth palettes or add a custom palette.
- Display list values and tags as colored pills.

## Requirements

- Obsidian 1.10.0 or newer
- Bases core plugin enabled

## Install

Until Views is available in the Obsidian community plugin directory, install it manually or with BRAT.

For BRAT, add `https://github.com/Maws7140/Views` as a beta plugin.

For a manual install, copy these files into `.obsidian/plugins/more-bases-views/` inside your vault:

- `main.js`
- `manifest.json`
- `styles.css`

Reload Obsidian, then enable **Views** in Community plugins.

## Build

```bash
npm install
npm run build
```

## Privacy

Views runs locally and has no telemetry. Remote image URLs used by Collection are loaded by Obsidian when displayed.

## License

[MIT](LICENSE)
