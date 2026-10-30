// Mutation run: builds a deliberately broken copy of host.js (see
// ./mutants/materialize.mjs), then runs the SAME suite as host.test.mjs.
// It must FAIL — proving the suite catches a Service class that is declared but
// never constructed. If this file ever goes green, the suite stopped working.
import "./setup.mjs";
import { materializeMutant } from "./mutants/materialize.mjs";
import { runSuite } from "./suite.mjs";

const mutantPath = await materializeMutant();
const { pass, fail, results } = await runSuite(() => import(mutantPath));

console.log(results.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
