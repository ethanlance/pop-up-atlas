# Pop-up Atlas — append-only log

## 2026-11-17 lead — kickoff, assumptions
- Project lives at ~/Work/pop-up-atlas (own repo, not inside t3).
- ASSUMPTION: Codex CLI is not installed and no image-generation key is present. The only other generator reachable
  (Figma AI) is a paid, company-plan feature the brief did not name, so it is not used. Concept frames are instead
  path-traced in Blender Cycles from the brief (tilt-shift papercraft, paper traveller, open book, lantern light).
  Paper textures and printed details are generated procedurally and baked in Blender.
- Reference photos: 12 freely licensed images from Wikimedia Commons, sources in reference/photos/SOURCES.md.
  Useful ones: ref01 (layered city pop-up), ref03 (cream paper box fold, visible hinge), ref07 (ship, paper edges),
  ref08 (layered floral cut silhouettes), ref11 (paper village from high angle), ref12 (tunnel-book layers).
- ASSUMPTION: "endless book" = one endless page surface with a gutter/crease motif; tiles are 2x2 units.
- ASSUMPTION: traveller walks on the flat page; pop-ups are obstacles or scenery; rivers block except at bridges.
- Playwright drives the installed Google Chrome (GPU) for captures and fps; no browser download.
