// Verify the wire contract: the INVOCATIONS the client mounts must agree with the
// ones the host registers in its TYPERT_MANIFEST. client.js does not export its
// constants (only name/inject/apply), so probe them by appending exports to a copy.
//
// The codec schemas carry FUNCTIONS (parse), which JSON.stringify silently drops —
// comparing serialized copies proves nothing about whether both sides still accept
// and reject the same values, so the codec check below is behavioural.
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

// Compare the behaviour of two codec parsers, not their serialized form.
// Each probe is [label, value, shouldBeAccepted]; a parser that accepts a value
// its counterpart rejects (or vice versa) has drifted away from the contract.
function sameParseBehaviour(a, b, probes) {
  for (const [label, value] of probes) {
    let aAccepted = true, bAccepted = true;
    try { a(value); } catch { aAccepted = false; }
    try { b(value); } catch { bAccepted = false; }
    if (aAccepted !== bAccepted) {
      console.log(`     drift on ${label}: host=${aAccepted ? "accept" : "reject"} client=${bAccepted ? "accept" : "reject"}`);
      return false;
    }
  }
  return true;
}
const ENVELOPE_PROBES = [
  ["{ok:true}", { ok: true }],
  ["{ok:false,error}", { ok: false, error: "boom" }],
  ["null", null],
  ["undefined", undefined],
  ["{ok:'yes'}", { ok: "yes" }],
  ["{}", {}],
  ["42", 42]
];
const ARGS_PROBES = [
  ["{route,modelId}", { route: "r", modelId: "m" }],
  ["{}", {}],
  ["null", null],
  ["undefined", undefined],
  ["42", 42]
];

// Structural equality of the serialized shape (ids, methods, modes) — this part
// IS legitimately comparable as text because it contains no functions.
const strip = (inv) => inv.map((i) => ({
  id: i.id,
  service: i.service,
  method: i.method,
  args: { mode: i.parameters?.[0]?.codec?.mode, typeSymbol: i.parameters?.[0]?.codec?.typeSymbol },
  result: { mode: i.result?.mode, typeSymbol: i.result?.typeSymbol }
}));
check("host/client INVOCATIONS structural shape", JSON.stringify(strip(hostMod.INVOCATIONS)) === JSON.stringify(strip(clientExports.__INVOCATIONS)));
check("host/client invocation count", hostMod.INVOCATIONS.length === clientExports.__INVOCATIONS.length);

// The real guard: both sides must agree on which envelopes/args are valid.
// The parsers live at parameters[0].codec.schema.parse (args) and
// result.schema.parse (result envelope) — not on a top-level `args` field.
{
  let argsSame = true, resultSame = true, codecPresent = true;
  for (let i = 0; i < hostMod.INVOCATIONS.length; i += 1) {
    const h = hostMod.INVOCATIONS[i];
    const c = clientExports.__INVOCATIONS[i];
    const hArgs = h?.parameters?.[0]?.codec?.schema?.parse;
    const cArgs = c?.parameters?.[0]?.codec?.schema?.parse;
    const hResult = h?.result?.schema?.parse;
    const cResult = c?.result?.schema?.parse;
    if (typeof hArgs !== "function" || typeof cArgs !== "function"
      || typeof hResult !== "function" || typeof cResult !== "function") {
      codecPresent = false;
      continue;
    }
    if (!sameParseBehaviour(hArgs, cArgs, ARGS_PROBES)) argsSame = false;
    if (!sameParseBehaviour(hResult, cResult, ENVELOPE_PROBES)) resultSame = false;
  }
  check("both sides carry a codec parse() on args and result", codecPresent);
  check("host/client args codec accept+reject the same values", argsSame);
  check("host/client result codec accept+reject the same values", resultSame);
}
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
