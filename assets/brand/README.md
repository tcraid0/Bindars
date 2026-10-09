# Bindars app icon

`bindars-icon.svg` contains the approved primary icon from the artist's final
delivery (October 7, 2026), including the BINDARS lettering inside the yellow
highlight. The 13 original paths and their colours are unchanged. Illustrator
metadata, its hidden layer, and unused definitions were removed. Lettering is
outlined, so rendering does not depend on an installed font.

`app-icon.svg` places that artwork on a light rounded tile with transparent outer
padding for desktop use. It is generated from the primary icon, not a new logo.

The startup screen in `index.html` also shows this artwork. Vite inlines it at
build time, so it appears in the first frame. Its `viewBox` there is the
artwork's bounds, so update it if the artwork's geometry changes.

After installing the project's existing dependencies, regenerate with:

```sh
node scripts/generate-app-icons.mjs
```

This uses the installed Tauri CLI to update the PNG, ICNS, ICO, and existing
mobile icon assets in `src-tauri/icons`. Tauri's existing bundle configuration
already references these files. A rebuilt app is required to see the new icon;
updating these assets does not modify an already installed app bundle.

The native icon uses the same artwork across reading themes. The source palette:

- Front page: `#56A3FE`
- Middle page: `#1570F6`
- Back page: `#0841B4`
- Highlight: `#FFCA54`
- Page lines and tile: `#F8F8F7`
- Lettering: `#FFFFFF`
