// Builds the sideload package for the Roku channel: dist/play-ezasapi-roku.zip
// Roku requires `manifest` at the zip root, so the zip contains the contents of
// roku/ (not the roku/ folder itself).
import AdmZip from "adm-zip";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const out = resolve(root, "dist/play-ezasapi-roku.zip");
mkdirSync(resolve(root, "dist"), { recursive: true });

const zip = new AdmZip();
zip.addLocalFolder(resolve(root, "roku"), "", (path) => !path.endsWith(".md"));
zip.writeZip(out);
console.log(`wrote ${out} (${zip.getEntries().map((e) => e.entryName).join(", ")})`);
