// Host-logic self-test for dsh-model-toggle (no real DSH runtime involved).
// The archive lives in a JSON file in the profile directory, the plugin NEVER
// writes its own config section (guarded explicitly), and both settings arms
// ("raw" 0.1 get/replace, "descriptor" 0.2 describe/replace) are exercised for
// the llm-pi-ai read/write path.
//
// The assertions live in ./suite.mjs so the mutation run executes the very same
// body — see host-mutant.test.mjs.
import "./setup.mjs";
import { runSuite } from "./suite.mjs";

const { pass, fail, results } = await runSuite(() => import("../host.js"));

console.log(results.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
