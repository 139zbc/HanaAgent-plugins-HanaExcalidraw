import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, "ui");
const FONT_SRC = resolve(here, "node_modules/@excalidraw/excalidraw/dist/prod/fonts");
const FONT_DEST = join(OUT, "assets", "fonts");

/** walk a directory tree and collect files by extension */
function collect(dir, ext, acc = []) {
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const name of entries) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) collect(full, ext, acc);
    else if (name.endsWith(ext)) acc.push(full);
  }
  return acc;
}

/**
 * Excalidraw builds its FontFace sources from EXCALIDRAW_ASSET_PATH, and always
 * appends https://esm.sh/... as a last-resort candidate. The card page has no
 * outbound network, so the local copy must be complete and correctly shaped:
 * one directory per family, content-hashed file names, one file per
 * unicode-range subset. Flattening them silently breaks the webfont.
 */
function copyExcalidrawFonts() {
  return {
    name: "copy-excalidraw-fonts",
    apply: "build",
    closeBundle() {
      if (!existsSync(FONT_SRC)) {
        this.error(
          `missing ${FONT_SRC} — Excalidraw fonts must be self-hosted, otherwise the ` +
            "canvas falls back to system fonts (see 开发记录 risk R1 / Q2)",
        );
        return;
      }
      const fonts = collect(FONT_SRC, ".woff2");
      if (!fonts.length) {
        this.error(`no .woff2 under ${FONT_SRC} (see 开发记录 risk R1 / Q2)`);
        return;
      }
      cpSync(FONT_SRC, FONT_DEST, { recursive: true });
      this.info?.(`copied ${fonts.length} Excalidraw font file(s) into ui/assets/fonts/`);
    },
  };
}

/**
 * Publish the card face images into the built app.
 *
 * `contributes.cards[].face.image` is resolved by the host against the app's
 * *ui* directory, not the app root — the served base for an app is
 * `/api/apps/<id>/ui`, and every installed app that renders a cover keeps it at
 * `ui/assets/`. `icon` is the opposite: it is read from the app root. So the two
 * live in different places, and putting a cover at the root resolves to nothing.
 * The symptom is a silent one — the host falls back to its own placeholder and
 * nothing anywhere reports a fault.
 *
 * It cannot simply be committed under `ui/`, either: `outDir` is `ui` and
 * `emptyOutDir` is true, so every build deletes the directory. Hence a copy
 * after the bundle, same as the fonts.
 *
 * The list comes from the manifest rather than a hardcoded filename, so a card
 * added later with a different cover is carried along without touching this file.
 * A declared-but-missing image fails the build: a placeholder is exactly the
 * outcome that cost three releases to notice.
 */
function publishCardFaces() {
  return {
    name: "publish-card-faces",
    apply: "build",
    closeBundle() {
      const manifest = JSON.parse(readFileSync(resolve(here, "manifest.json"), "utf8"));
      const faces = (manifest.contributes?.cards ?? [])
        .map((c) => c?.face?.image)
        .filter(Boolean);
      const unique = [...new Set(faces)];
      if (!unique.length) {
        this.info?.("no card declares a face image");
        return;
      }
      for (const rel of unique) {
        const src = resolve(here, rel);
        if (!existsSync(src)) {
          this.error(
            `card face image declared but not found: ${rel} (looked in ${src}). ` +
              "A cover that does not resolve is not a build error the host reports — " +
              "it silently renders the placeholder face instead.",
          );
          continue;
        }
        const dest = join(OUT, rel);
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(src, dest);
        this.info?.(`published ${rel} -> ui/${rel}`);
      }
    },
  };
}

export default defineConfig({
  // relative base so every built asset inherits the app's surface authorization
  base: "./",
  plugins: [react(), copyExcalidrawFonts(), publishCardFaces()],
  build: {
    outDir: "ui",
    emptyOutDir: true,
    assetsDir: "assets",
    target: "es2022",
    rollupOptions: {
      // Entry pages live at the project root on purpose: Vite derives the output
      // path from each input's location relative to root, so a `pages/` folder
      // would emit ui/pages/board.html and break the manifest's card route.
      input: {
        board: resolve(here, "board.html"),
        standalone: resolve(here, "standalone.html"),
        // The in-chat preview is its own card declaration (see manifest
        // messageRenderers), so it needs its own HTML input. It cannot reuse
        // board.html: the host hands a messageRenderer card no query string, so
        // there is nowhere to put a `?preview=1`.
        preview: resolve(here, "preview.html"),
        // The Function Panel. Declaring this route is what turns the panel from
        // "primitives the card pushes" into "a document the host renders", and
        // the two are mutually exclusive — see sidebar.jsx for why the trade was
        // worth it (a context menu on a row, and a text field).
        sidebar: resolve(here, "sidebar.html"),
      },
    },
  },
});
