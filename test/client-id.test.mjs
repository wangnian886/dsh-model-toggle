// Static check: does client.js register under the resolved package name?
// Mirrors dsh-client-modules/lib/client.js:702 register() (key = stripClientSuffix(id))
// and :745 arrive() (lookup = graph row id = manifest package name).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
const src = readFileSync(join(dir, "client.js"), "utf8");

const stripClientSuffix = (spec) => (spec.endsWith("/client") ? spec.slice(0, -7) : spec);

let registration;
const window = {
  __ModuleLoader__: {
    load: (r) => {
      registration = r;
    }
  }
};
const document = undefined;

// Evaluate the bundle exactly as the browser would (top-level side effects only).
const fn = new Function("window", "document", src);
fn(window, document);

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, ok: !!cond, detail });
};

check("bundle calls __ModuleLoader__.load", registration !== undefined, registration ? "" : "no registration captured");
if (registration) {
  const rowId = pkg.name; // host graph row id = manifest package name
  const factoryKey = stripClientSuffix(registration.id);
  check(
    `registration.id ("${registration.id}") equals package name ("${rowId}")`,
    registration.id === rowId,
    `factory key would be "${factoryKey}", arrive() looks up "${rowId}"`
  );
  check(
    `arrive() would find the factory (factories.has("${rowId}"))`,
    factoryKey === rowId,
    factoryKey === rowId ? "" : `mismatch -> "loaded without registering" -> apply() never runs`
  );
  check("registration exposes a factory function", typeof registration.factory === "function", typeof registration.factory);

  if (typeof registration.factory === "function") {
    const req = createRequire(join(dir, "package.json"));
    const stubReact = {
      createElement: () => null,
      useState: () => [null, () => {}],
      useEffect: () => {}
    };
    const requireStub = (spec) => {
      if (spec === "react") return stubReact;
      throw new Error(`unexpected require("${spec}")`);
    };
    let mod;
    let threw = null;
    try {
      mod = registration.factory(requireStub);
    } catch (e) {
      threw = e;
    }
    check("factory materializes without throwing", threw === null, threw ? String(threw.message) : "");
    if (mod) {
      check("exports.apply is a function", typeof mod.apply === "function", typeof mod.apply);
      check("exports.name equals package name", mod.name === pkg.name, `${mod.name} vs ${pkg.name}`);
      check("exports.inject lists slots + remote", Array.isArray(mod.inject) && mod.inject.includes("slots") && mod.inject.includes("remote"), JSON.stringify(mod.inject));
    }
  }
}

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  [${r.detail}]` : ""}`);
}
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
