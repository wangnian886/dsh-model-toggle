// Builds a deliberately broken copy of host.js for the mutation test.
//
// The single mutation: `new ModelToggleRuntime(ctx)` inside apply() is commented
// out. That is exactly the bug that shipped once and made every Remote call fail
// with `active Service "modelToggle" is unavailable` (the Cordis Service is
// registered by its CONSTRUCTOR, so a declared-but-never-instantiated class
// registers nothing).
//
// The copy is written to a temp dir so the checkout stays clean; host.js only
// imports node: builtins plus the peer stub, so it runs from anywhere.
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HOST_URL = new URL("../../host.js", import.meta.url);
const NEEDLE = "  new ModelToggleRuntime(ctx);";

export async function materializeMutant() {
  const source = await fsp.readFile(HOST_URL, "utf8");
  if (!source.includes(NEEDLE)) {
    throw new Error(
      `mutation anchor ${JSON.stringify(NEEDLE)} not found in host.js — update test/mutants/materialize.mjs`
    );
  }
  const mutated = source.replace(NEEDLE, "  // new ModelToggleRuntime(ctx);");
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "mt-mutant-"));
  const target = path.join(dir, "host-mutant.js");
  await fsp.writeFile(target, mutated, "utf8");
  return pathToFileURL(target).href;
}
