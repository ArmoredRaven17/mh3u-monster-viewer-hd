# MH3U Monster Viewer HD

A fan-made 3D viewer for the monsters of Monster Hunter 3 Ultimate, built from the **Wii U**
version's higher-resolution models and textures. Same app as the
[MH3U Monster Viewer](https://armoredraven17.github.io/mh3u-monster-viewer/) (3DS data), copied from
it on 2026-10-10 so it looks and works the same. It's kept as its own repository so it has its own
size budget.

Published at https://armoredraven17.github.io/mh3u-monster-viewer-hd/. The first version covers
models, animations and part ids, plus the MHGU viewer's Texture Cache setting. Effects and the
other extras come later.

## Running it

No build step. Serve `docs/` with any static file server:

    python dev/serve.py 5590

## Contents

    docs/index.html        the app: markup, styles and logic (from the MH3U Monster Viewer)
    docs/monsters.json     per monster: model, pieces, motion lists
    docs/materials.json    each material's base texture and render state
    docs/models/monsters/  one glb per model (the monster, and its severed pieces)
    docs/poses/monsters/   one glb per motion list, animations only
    docs/tex/              textures, deduplicated by content hash
    docs/render/           the render core

## Where the data comes from

The scripts live beside this repository in `C:\MH3U-Extract` and read the Wii U disc
(US, `WUP-P-AHDE`). The disc is decrypted locally. Keys and decrypted files are never part of this
repository. The data has to stay under 900 MB so the published app stays under GitHub Pages' 1 GB
limit.

## Credits

See NOTICE.md, and the About dialog in the app.

Monster Hunter 3 Ultimate is © CAPCOM CO., LTD. This is an unofficial fan project and is not
affiliated with or endorsed by Capcom.
