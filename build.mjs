// Stitches src/ into the single page that gets served: public/index.html. No dependencies.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const read = (f) => readFileSync(new URL("../src/" + f, import.meta.url), "utf8");
const parts = { CSS: read("style.css"), LOGIC: read("logic.js"), STANDALONE: read("standalone.js"), APP: read("app.js") };
let html = read("shell.html");
for (const [name, text] of Object.entries(parts)) {
  if (name !== "CSS" && text.includes("</script>")) throw new Error(name + " contains a closing script tag");
  html = html.replace(`/*${name}*/`, () => text);
}
mkdirSync(new URL("../public/", import.meta.url), { recursive: true });
writeFileSync(new URL("../public/index.html", import.meta.url), html);
console.log(`public/index.html written (${(html.length / 1024).toFixed(0)} KB)`);
