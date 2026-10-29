// Verify the wire contract: the INVOCATIONS the client mounts must be byte-identical
// to the ones the host registers in its TYPERT_MANIFEST. client.js does not export its
// constants (only name/inject/apply), so probe them by appending exports to a copy.
import fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("..", import.meta.url));
const hostSrc = fs.readFileSync(join(dir, "host.js"), "utf8");
const clientSrc = fs.readFileSync(join(dir, "client.js"), "utf8");

let hostMod;
{
  const stub = "data:text/javascript," + encodeURIComponent(
    "export class TypertRemoteService { constructor(ctx, key){ this.ctx = ctx; this.key = key; } }"
  );
  const patched = hostSrc
    .replace('from "@deepseek-ai/dsh-typert-protocol"', 'from "' + stub + '"')
    .replace('import fsp from "node:fs/promises";', "const fsp = {};")
    .replace('import path from "node:path";', 'const path = { join: (...a) => a.join("/") };');
  hostMod = await import("data:text/javascript," + encodeURIComponent(patched));
}

let clientExports;
{
  const probed = clientSrc.replace(
    "exports.name = PACKAGE;",
    "exports.name = PACKAGE; exports.__PACKAGE = PACKAGE; exports.__SERVICE_KEY = SERVICE_KEY; exports.__INVOCATIONS = INVOCATIONS; exports.__METHODS = METHODS;"
  );
  const window = { __ModuleLoader__: { load: (reg) => { clientExports = reg.factory((s) => ({})); } } };
  const document = { head: { appendChild() {} }, createElement: () => ({ setAttribute(){}, appendChild(){}, style: {} }), getElementById: () => null };
  const React = { createElement: () => null, useState: () => [null, () => {}], useEffect: () => {}, useCallback: (f) => f, Fragment: "f" };
  new Function("window", "document", "React", "console", probed)(window, document, React, console);
}

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log("ok   " + name); } else { fail++; console.log("FAIL " + name); } };
const manifestService = hostMod.MANIFEST.model.services[0];

check("host INVOCATIONS === client INVOCATIONS", JSON.stringify(hostMod.INVOCATIONS) === JSON.stringify(clientExports.__INVOCATIONS));
check("manifest.package === client PACKAGE", hostMod.MANIFEST.package === clientExports.__PACKAGE);
check("manifest service key === client SERVICE_KEY", manifestService.key === clientExports.__SERVICE_KEY);
check("host export name === client PACKAGE", hostMod.name === clientExports.__PACKAGE);
check("client export name === client PACKAGE", clientExports.name === clientExports.__PACKAGE);
check("manifest exportName resolves to a class", typeof hostMod[manifestService.exportName] === "function");
check("manifest member names === invocation methods", JSON.stringify(manifestService.members.map((m) => m.name)) === JSON.stringify(hostMod.INVOCATIONS.map((i) => i.method)));
check("client METHOD_MAP wire names", JSON.stringify(clientExports.__METHODS.map(([w]) => w)) === JSON.stringify(["list-states","hide-model","show-model"]));
check("client METHOD_MAP target names === invocation methods", JSON.stringify(clientExports.__METHODS.map(([, m]) => m)) === JSON.stringify(hostMod.INVOCATIONS.map((i) => i.method)));
check("every invocation id is package#service/method", hostMod.INVOCATIONS.every((i) => i.id === `${hostMod.MANIFEST.package}#${i.service}/${i.method}`));
check("invocation ids unique", new Set(hostMod.INVOCATIONS.map((i) => i.id)).size === hostMod.INVOCATIONS.length);
check("client inject === [slots, remote]", JSON.stringify(clientExports.inject) === JSON.stringify(["slots","remote"]));
check("host inject includes typert+settings", hostMod.inject.includes("typert") && hostMod.inject.includes("settings"));
check("manifest face is host", hostMod.MANIFEST.face === "host");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
