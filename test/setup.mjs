// Test-only resolver hook.
//
// host.js imports the bare peer dependency `@deepseek-ai/dsh-typert-protocol`.
// A clean checkout has no node_modules (it is gitignored), so map that specifier
// to the local stub in ./stubs/. The stub deliberately mirrors the REAL
// registration behaviour instead of accepting anything — see the comment inside.
//
// Import this module BEFORE dynamically importing host.js:
//   import "./setup.mjs";
//   const mod = await import("../host.js");
import { registerHooks } from "node:module";

const stubUrl = new URL("./stubs/dsh-typert-protocol.mjs", import.meta.url).href;
const PEER = "@deepseek-ai/dsh-typert-protocol";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === PEER) return { url: stubUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
