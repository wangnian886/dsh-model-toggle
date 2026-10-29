// Host-logic self-test for dsh-model-toggle v2 (no real DSH runtime involved).
// v2 semantics: the archive lives in a JSON file in the profile directory, the
// plugin NEVER writes its own config section (guarded explicitly), and both
// settings arms ("raw" 0.1 get/replace, "descriptor" 0.2 describe/replace) are
// exercised for the llm-pi-ai read/write path.
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Mutation run: applies the patch in ./mutants/no-new-service.patch to a copy of
// host.js, then runs the SAME suite. It must FAIL — proving the suite catches a
// Service class that is declared but never constructed.
import "./setup.mjs";
import { materializeMutant } from "./mutants/materialize.mjs";

const mutantPath = await materializeMutant();
const { apply, ModelToggleRuntime, NS_LLM, SERVICE_KEY } = await import(mutantPath);

let pass = 0;
let fail = 0;
const results = [];
function check(name, fn) {
  try {
    fn();
    pass += 1;
    results.push(`ok   ${name}`);
  } catch (e) {
    fail += 1;
    results.push(`FAIL ${name} — ${e && e.message ? e.message : String(e)}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    pass += 1;
    results.push(`ok   ${name}`);
  } catch (e) {
    fail += 1;
    results.push(`FAIL ${name} — ${e && e.message ? e.message : String(e)}`);
  }
}

// ------------------------------------------------------------ fake services ---
function makeSettings(arm) {
  const sections = new Map();
  const replaceCalls = [];
  const svc = {
    arm,
    writable: true,
    replace(ns, section) {
      replaceCalls.push(ns);
      sections.set(ns, section);
    },
    _sections: sections,
    _replaceCalls: replaceCalls
  };
  if (arm === "raw") {
    svc.get = (ns) => sections.get(ns);
  } else {
    svc.describe = () => [...sections.keys()].map((ns) => ({ ns, user: sections.get(ns) }));
  }
  return svc;
}

function makeCtx(svc, { profileDir, configEditorDoc } = {}) {
  const warns = [];
  const effects = [];
  const manifests = [];
  const services = new Map();
  const ctx = {
    warns,
    effects,
    manifests,
    // Mirrors Cordis' reflect registry closely enough to catch a plugin that
    // declares a Service class but never constructs it (the real gateway then
    // fails with `active Service "..." is unavailable`), and to catch a double
    // registration, which real Cordis rejects.
    reflect: {
      props: {},
      provide(key, value) {
        if (services.has(key)) throw new Error(`service "${key}" is already registered`);
        services.set(key, value);
        ctx.reflect.props[key] = { type: "service" };
        return () => { services.delete(key); delete ctx.reflect.props[key]; };
      }
    },
    services,
    typert: { register: (m) => { manifests.push(m); return { dispose() {} }; } },
    get(name) {
      if (services.has(name)) return services.get(name);
      if (name === "settings") return svc;
      if (name === "typert") return ctx.typert;
      if (name === "profileContext") return profileDir !== undefined ? { dir: profileDir } : undefined;
      if (name === "configEditor") return configEditorDoc !== undefined ? { documentPath: configEditorDoc } : undefined;
      return undefined;
    },
    effect(fn, label) {
      const disposer = fn();
      effects.push({ label, disposer });
      return disposer;
    },
    logger: {
      warn: (m) => warns.push(String(m)),
      info: (m) => warns.push(`info: ${String(m)}`)
    }
  };
  return ctx;
}

const seed = () => ({
  providers: {
    p1: {
      displayName: "Provider One",
      api: "openai-completions",
      baseURL: "http://127.0.0.1:1/v1",
      models: [
        "m-str",
        { id: "m2", name: "Model Two", contextWindow: 65536, maxTokens: 8192 }
      ]
    },
    p2: {
      displayName: "Provider Two",
      models: [{ id: "m3", name: "Model Three" }]
    }
  },
  unrelatedKey: { keep: "me" }
});

const cloneSeed = () => JSON.parse(JSON.stringify(seed()));

async function readArchiveFile(profileDir) {
  const text = await fsp.readFile(path.join(profileDir, "dsh-model-toggle.archive.json"), "utf8");
  return JSON.parse(text);
}

// ------------------------------------------------------------- one full arm ---
async function runArm(arm) {
  const profileDir = await fsp.mkdtemp(path.join(os.tmpdir(), `mt-${arm}-`));
  const svc = makeSettings(arm);
  svc._sections.set(NS_LLM, cloneSeed());
  const ctx = makeCtx(svc, { profileDir });
  await apply(ctx);
  const rt = ctx.services.get(SERVICE_KEY);
  // Hard stop with a readable message: without the Service the gateway fails
  // every Remote call with `active Service "..." is unavailable`, so an
  // undefined `rt` here must never be papered over by a later assertion.
  if (rt === undefined) {
    fail += 1;
    results.push(`FAIL ${arm}: apply() did not construct the modelToggle Service (Remote calls would fail with "active Service is unavailable")`);
    await fsp.rm(profileDir, { recursive: true, force: true }).catch(() => {});
    return;
  }
  const archiveFile = () => readArchiveFile(profileDir);
  const llm = () => svc._sections.get(NS_LLM);

  check(`${arm}: apply registered the modelToggle Service on ctx`, () => {
    assert.ok(ctx.services.has(SERVICE_KEY), "apply must construct ModelToggleRuntime");
    assert.ok(ctx.services.get(SERVICE_KEY).typertRemote, "Service must carry the typert binding");
  });
  check(`${arm}: typert manifest registered once`, () => assert.equal(ctx.manifests.length, 1));
  check(`${arm}: manifest shape`, () => {
    const m = ctx.manifests[0];
    assert.equal(m.face, "host");
    assert.equal(m.model.services.length, 1);
    const s = m.model.services[0];
    assert.equal(s.key, SERVICE_KEY);
    assert.equal(s.exportName, "ModelToggleRuntime");
    assert.deepEqual(s.members.map((x) => x.name), ["listStates", "hideModel", "showModel"]);
    assert.equal(m.invocations.length, 3);
  });
  check(`${arm}: self-check is read-only (no config writes during apply)`, () => {
    assert.deepEqual(svc._replaceCalls, []);
    assert.equal(ctx.warns.filter((w) => w.includes("self-check")).length, 0);
  });
  check(`${arm}: unload restore effect registered`, () => {
    assert.ok(ctx.effects.some((e) => String(e.label).includes("restore")));
  });

  // listStates
  const listed = await rt.listStates();
  check(`${arm}: listStates totals`, () => {
    assert.equal(listed.ok, true);
    assert.deepEqual(listed.totals, { visible: 3, hidden: 0 });
    const p1 = listed.providers.find((p) => p.route === "p1");
    assert.deepEqual(p1.models, [
      { id: "m-str", name: "m-str" },
      { id: "m2", name: "Model Two" }
    ]);
  });

  // hide an object entry
  const hidden1 = await rt.hideModel({ route: "p1", modelId: "m2" });
  check(`${arm}: hideModel returns ok`, () => assert.equal(hidden1.ok, true));
  check(`${arm}: hideModel removed from providers and archived verbatim to the file`, async () => {
    assert.deepEqual(llm().providers.p1.models, ["m-str"]);
    const file = await archiveFile();
    assert.deepEqual(file.hidden.p1, [
      { id: "m2", name: "Model Two", contextWindow: 65536, maxTokens: 8192 }
    ]);
  });
  check(`${arm}: unrelated llm key preserved`, () => {
    assert.deepEqual(llm().unrelatedKey, { keep: "me" });
  });
  check(`${arm}: written providers are null-prototype plain objects`, () => {
    assert.equal(Object.getPrototypeOf(llm().providers), null);
  });

  // idempotent hide
  const again = await rt.hideModel({ route: "p1", modelId: "m2" });
  check(`${arm}: hide is idempotent`, () => {
    assert.equal(again.ok, true);
    assert.equal(again.already, true);
  });
  check(`${arm}: idempotent hide left exactly one archived entry`, async () => {
    const file = await archiveFile();
    assert.equal(file.hidden.p1.length, 1);
  });

  // unknown model
  const missing = await rt.hideModel({ route: "p1", modelId: "nope" });
  check(`${arm}: hide unknown model refuses`, () => {
    assert.equal(missing.ok, false);
    assert.match(String(missing.error), /not found/);
  });

  // guard args
  const badArgs = await rt.hideModel({});
  check(`${arm}: hide without args refuses`, () => {
    assert.equal(badArgs.ok, false);
    assert.match(String(badArgs.error), /required/);
  });

  // listStates reflects hidden
  const listed2 = await rt.listStates();
  check(`${arm}: listStates shows archived`, () => {
    assert.deepEqual(listed2.totals, { visible: 2, hidden: 1 });
    const p1 = listed2.providers.find((p) => p.route === "p1");
    assert.deepEqual(p1.hidden, [{ id: "m2", name: "Model Two" }]);
  });

  // show it back
  const shown = await rt.showModel({ route: "p1", modelId: "m2" });
  check(`${arm}: showModel returns ok`, () => assert.equal(shown.ok, true));
  check(`${arm}: showModel merged back verbatim and archive cleared`, async () => {
    assert.deepEqual(llm().providers.p1.models, [
      "m-str",
      { id: "m2", name: "Model Two", contextWindow: 65536, maxTokens: 8192 }
    ]);
    const file = await archiveFile();
    assert.equal(file.hidden.p1, undefined);
  });

  // show when not archived
  const shownAgain = await rt.showModel({ route: "p1", modelId: "m2" });
  check(`${arm}: show is idempotent when already visible`, () => {
    assert.equal(shownAgain.ok, true);
    assert.equal(shownAgain.already, true);
  });

  // provider disappears (e.g. disabled by dsh-model-pro) while holding archive
  await rt.hideModel({ route: "p2", modelId: "m3" });
  const seededLlm = cloneSeed();
  delete seededLlm.providers.p2;
  seededLlm.unrelatedKey = llm().unrelatedKey;
  svc.replace(NS_LLM, seededLlm);
  const ghostShown = await rt.showModel({ route: "p2", modelId: "m3" });
  check(`${arm}: show on missing provider refuses and keeps archive`, async () => {
    assert.equal(ghostShown.ok, false);
    assert.match(String(ghostShown.error), /not configured/);
    const file = await archiveFile();
    assert.equal(file.hidden.p2.length, 1);
  });
  const ghostListed = await rt.listStates();
  check(`${arm}: listStates flags providerMissing with archive`, () => {
    const p2 = ghostListed.providers.find((p) => p.route === "p2");
    assert.equal(p2.providerMissing, true);
    assert.deepEqual(p2.hidden, [{ id: "m3", name: "Model Three" }]);
  });

  // string entry round trip
  await rt.hideModel({ route: "p1", modelId: "m-str" });
  check(`${arm}: string entry archived as string`, async () => {
    const file = await archiveFile();
    assert.deepEqual(file.hidden.p1, ["m-str"]);
  });
  await rt.showModel({ route: "p1", modelId: "m-str" });
  check(`${arm}: string entry restored (appended at end of list)`, () => {
    const models = llm().providers.p1.models;
    assert.equal(models.length, 2);
    assert.ok(models.some((m) => m === "m-str"));
  });

  // unload restores everything
  await rt.hideModel({ route: "p1", modelId: "m2" });
  const unload = ctx.effects.find((e) => String(e.label).includes("restore"));
  await unload.disposer();
  check(`${arm}: unload restore merges existing providers, keeps missing provider archive`, async () => {
    const after = llm();
    assert.ok(after.providers.p1.models.some((m) => typeof m === "object" && m.id === "m2"));
    const file = await archiveFile();
    assert.equal(file.hidden.p1, undefined);
    assert.equal(file.hidden.p2.length, 1); // p2 gone from config; archive kept by design
    assert.deepEqual(after.unrelatedKey, { keep: "me" });
  });

  // v2 regression guard: the plugin must NEVER write any settings namespace
  // other than llm-pi-ai (no own-config section at all in v2).
  check(`${arm}: every settings.replace targeted llm-pi-ai only`, () => {
    for (const ns of svc._replaceCalls) assert.equal(ns, NS_LLM);
    assert.ok(svc._replaceCalls.length > 0);
  });

  await fsp.rm(profileDir, { recursive: true, force: true }).catch(() => {});
}

await runArm("raw");
await runArm("descriptor");

// ------------------------------------------------------------- extra guards ---
await checkAsync("no settings service: methods refuse instead of throwing", async () => {
  const profileDir = await fsp.mkdtemp(path.join(os.tmpdir(), "mt-nosvc-"));
  const ctx = makeCtx(undefined, { profileDir });
  await apply(ctx);
  const rt = ctx.services.get(SERVICE_KEY);
  const r = await rt.listStates();
  assert.equal(r.ok, true);
  assert.deepEqual(r.providers, []);
  const h = await rt.hideModel({ route: "p1", modelId: "m" });
  assert.equal(h.ok, false);
  assert.match(String(h.error), /settings service/);
  await fsp.rm(profileDir, { recursive: true, force: true }).catch(() => {});
});

await checkAsync("memory-only mode when the profile dir is not resolvable", async () => {
  const svc = makeSettings("descriptor");
  svc._sections.set(NS_LLM, cloneSeed());
  const ctx = makeCtx(svc); // no profileContext, no configEditor
  await apply(ctx);
  assert.equal(ctx.warns.some((w) => w.includes("memory only")), true);
  const rt = ctx.services.get(SERVICE_KEY);
  const h = await rt.hideModel({ route: "p1", modelId: "m2" });
  assert.equal(h.ok, true);
  assert.deepEqual(svc._sections.get(NS_LLM).providers.p1.models, ["m-str"]);
  const unload = ctx.effects.find((e) => String(e.label).includes("restore"));
  await unload.disposer();
  assert.ok(svc._sections.get(NS_LLM).providers.p1.models.some((m) => typeof m === "object" && m.id === "m2"));
});

await checkAsync("broken archive location: hide fails closed before touching llm-pi-ai", async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "mt-broken-"));
  const fakeFile = path.join(base, "not-a-dir");
  await fsp.writeFile(fakeFile, "x", "utf8"); // a FILE where the profile dir should be
  const svc = makeSettings("descriptor");
  svc._sections.set(NS_LLM, cloneSeed());
  const ctx = makeCtx(svc, { profileDir: fakeFile });
  await apply(ctx);
  const rt = ctx.services.get(SERVICE_KEY);
  let threw = false;
  try {
    await rt.hideModel({ route: "p1", modelId: "m2" });
  } catch {
    threw = true;
  }
  assert.equal(threw, true, "hideModel should reject when the archive layer is broken");
  assert.deepEqual(svc._sections.get(NS_LLM).providers.p1.models.length, 2, "llm-pi-ai must stay untouched");
  await fsp.rm(base, { recursive: true, force: true }).catch(() => {});
});

await checkAsync("corrupt archive file: listStates reports archiveError, hide fails closed", async () => {
  const profileDir = await fsp.mkdtemp(path.join(os.tmpdir(), "mt-corrupt-"));
  await fsp.writeFile(path.join(profileDir, "dsh-model-toggle.archive.json"), "{not json", "utf8");
  const svc = makeSettings("descriptor");
  svc._sections.set(NS_LLM, cloneSeed());
  const ctx = makeCtx(svc, { profileDir });
  await apply(ctx);
  const rt = ctx.services.get(SERVICE_KEY);
  const listed = await rt.listStates();
  assert.equal(listed.ok, true);
  assert.match(String(listed.archiveError), /JSON|json|Unexpected/);
  let threw = false;
  try {
    await rt.hideModel({ route: "p1", modelId: "m2" });
  } catch {
    threw = true;
  }
  assert.equal(threw, true, "hideModel should reject on a corrupt archive");
  assert.equal(svc._sections.get(NS_LLM).providers.p1.models.length, 2, "llm-pi-ai must stay untouched");
  await fsp.rm(profileDir, { recursive: true, force: true }).catch(() => {});
});

console.log(results.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
