// dsh-model-toggle — host side (v2)
// Per-model hide/show switches for llm-pi-ai providers.
// Hide = move the model entry from llm-pi-ai.providers[route].models into an
// archive JSON file next to the profile config. Show = merge it back. The
// conversation model picker renders exactly the explicit `models` arrays, so a
// removed entry disappears from the picker without touching credentials.
//
// v2: the archive deliberately lives OUTSIDE the settings system. On 0.2 a
// plugin cannot write its own config section during apply (describe() filters
// non-ACTIVE fibers — dsh-settings lib/index.js:415-417; configEditor.edit
// throws "Configuration plugin is no longer active" — dsh-config-editor
// lib/index.js:81), and every successful config write restarts our own fiber,
// whose unload effect would immediately restore what was just hidden. A file
// archive removes both traps: no self-config writes at all, and the unload
// restore is a deterministic read-file → write-llm-pi-ai step (the llm-pi-ai
// fiber is always ACTIVE while ours unloads).

import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import fsp from "node:fs/promises";
import path from "node:path";

const PACKAGE = "dsh-model-toggle";
const SERVICE_KEY = "modelToggle";
const NS_LLM = "llm-pi-ai";
const ARCHIVE_NAME = "dsh-model-toggle.archive.json";

// wire name -> host method name
const METHODS = [
  ["list-states", "listStates"],
  ["hide-model", "hideModel"],
  ["show-model", "showModel"]
];

// ---------------------------------------------------------------- codecs ---
const parser = (parse) => ({ parse });
const strictCodec = (typeSymbol, parse) => ({
  mode: "strict",
  typeSymbol,
  schema: parser(parse),
  create: () => parser(parse)
});
const argsParser = (v) => {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw new TypeError("expected an args object");
  return v;
};
const resultEnvelopeParser = (v) => {
  if (v === null || typeof v !== "object" || typeof v.ok !== "boolean") {
    throw new TypeError("expected an { ok, ... } envelope");
  }
  return v;
};
const argParam = {
  name: "args",
  wire: "args",
  source: "json",
  codec: strictCodec(`${PACKAGE}#Args`, argsParser)
};
const INVOCATIONS = METHODS.map(([, method]) => ({
  id: `${PACKAGE}#${SERVICE_KEY}/${method}`,
  service: SERVICE_KEY,
  namespace: SERVICE_KEY,
  method,
  invocation: { kind: "direct" },
  parameters: [argParam],
  result: strictCodec(`${PACKAGE}#${method}Result`, resultEnvelopeParser)
}));

const MANIFEST = {
  package: PACKAGE,
  face: "host",
  schemas: [],
  model: {
    services: [
      {
        key: SERVICE_KEY,
        exportName: "ModelToggleRuntime",
        description:
          "Model Toggle — per-model hide/show switches for llm-pi-ai providers; hidden models vanish from the model picker and stay restorable.",
        tags: [],
        members: METHODS.map(([, method]) => ({
          kind: "method",
          name: method,
          signature: `${method}(args: object): Promise<object>`
        })),
        types: []
      }
    ],
    events: [],
    objects: []
  },
  invocations: INVOCATIONS
};

// --------------------------------------------------------------- helpers ---
const asRecord = (v) => (v !== null && typeof v === "object" && !Array.isArray(v) ? v : undefined);
const modelIdOf = (entry) => (typeof entry === "string" ? entry : asRecord(entry)?.id);
const modelNameOf = (entry) => {
  if (typeof entry === "string") return entry;
  const r = asRecord(entry);
  return typeof r?.name === "string" && r.name.length > 0 ? r.name : r?.id;
};
const msgOf = (error) => (error instanceof Error ? error.message : String(error));

let boundSettings; // set in apply(ctx)
let boundLogger; // set in apply(ctx); lets pure readers warn without a ctx handle
// Optional: set in apply(ctx) when the host exposes agentDefaultModel. Hiding
// the model DSH falls back to would leave new sessions unable to resolve it,
// so the guard below refuses that. Absent service => guard is a no-op.
let boundDefaultModel;

function settings() {
  return boundSettings;
}

// Returns the model id when `modelId` of `route` is DSH's current default
// selection, otherwise undefined. Any failure reading the selection counts as
// "not the default": a broken reader must not block hiding.
function currentDefaultHit(route, modelId) {
  try {
    const selection = boundDefaultModel?.currentSelection?.();
    if (selection && selection.provider === route && selection.model === modelId) return selection.model;
  } catch {
    // fall through
  }
  return undefined;
}

function warn(message) {
  try {
    boundLogger?.warn?.(message);
  } catch {
    // A broken logger must never take a read path down with it.
  }
}

function settingsArm(st) {
  if (st === undefined || st === null) return "unknown";
  if (typeof st.get === "function") return "raw";
  if (typeof st.describe === "function") return "descriptor";
  return "unknown";
}

function fromDescribe(st, ns) {
  const describe = st.describe;
  if (typeof describe !== "function") return {};
  const row = describe.call(st)?.find((r) => r?.ns === ns);
  if (row === undefined) return {};
  return asRecord(row.user) ?? asRecord(row.value) ?? {};
}

// Read a whole settings section. 0.1 exposes get(ns); 0.2 exposes describe()
// rows ({ ns, user, value }).
//
// A throwing reader is NOT the same as an empty section: swallowing the error
// turns "the settings service is broken" into "you have no providers", which
// the panel renders as a perfectly normal empty list. Warn once so the two
// states stay distinguishable in the log.
function readSection(st, ns) {
  if (st === undefined || st === null) return {};
  if (typeof st.get === "function") {
    try {
      return asRecord(st.get(ns)) ?? {};
    } catch (error) {
      warn(`dsh-model-toggle: reading settings section "${ns}" failed: ${msgOf(error)}`);
      return {};
    }
  }
  try {
    return fromDescribe(st, ns);
  } catch (error) {
    warn(`dsh-model-toggle: describing settings section "${ns}" failed: ${msgOf(error)}`);
    return {};
  }
}

function readProviderDict(st) {
  return asRecord(readSection(st, NS_LLM).providers) ?? {};
}

// 0.2 replace() resets every live field of the namespace and then writes the
// given fields, so we always hand back a full section. For llm-pi-ai we keep
// every key we read (providers replaced with the new dict).
async function writeLlm(st, providers, previousSection) {
  const section = Object.create(null);
  for (const [k, v] of Object.entries(previousSection ?? {})) {
    if (k !== "providers") section[k] = v;
  }
  const plain = Object.create(null);
  for (const [route, profile] of Object.entries(providers)) plain[route] = profile;
  section.providers = plain;
  await st.replace(NS_LLM, section);
}

function cloneProviders(providers) {
  const out = Object.create(null);
  for (const [route, profile] of Object.entries(providers)) {
    const rec = asRecord(profile);
    const copy = Object.assign(Object.create(null), rec ?? {});
    const models = Array.isArray(rec?.models) ? rec.models.slice() : undefined;
    if (models) copy.models = models;
    out[route] = copy;
  }
  return out;
}

// ------------------------------------------------------- archive (file) ---
// Shape: { version: 1, hidden: { [route]: [modelEntry, ...] } } — modelEntry is
// the verbatim llm-pi-ai model item (string or object), so a restore puts back
// exactly what was removed.
let archivePath; // absolute file path; undefined => memory-only mode
let memoryArchive; // mirror / fallback when the profile dir is not resolvable

function emptyArchive() {
  const hidden = Object.create(null);
  return { version: 1, hidden };
}

async function readArchive() {
  if (archivePath === undefined) return memoryArchive;
  let text;
  try {
    text = await fsp.readFile(archivePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return emptyArchive();
    throw error; // unreadable/corrupt → fail closed (hide aborts before touching llm-pi-ai)
  }
  const data = JSON.parse(text);
  const source = asRecord(data?.hidden);
  const bag = Object.create(null);
  if (source) {
    for (const [route, list] of Object.entries(source)) {
      if (Array.isArray(list) && list.length > 0) bag[route] = list.slice();
    }
  }
  const archive = { version: 1, hidden: bag };
  memoryArchive = archive;
  return archive;
}

async function writeArchive(archive) {
  memoryArchive = archive;
  if (archivePath === undefined) return;
  await fsp.mkdir(path.dirname(archivePath), { recursive: true });
  const tmp = `${archivePath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  await fsp.writeFile(tmp, JSON.stringify(archive, null, 2), "utf8");
  await fsp.rename(tmp, archivePath);
}

// Serialize every mutating operation (archive + llm-pi-ai are read-modify-write).
let opChain = Promise.resolve();
function serialized(fn) {
  const run = opChain.then(fn, fn);
  opChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

// ------------------------------------------------------------ core logic ---
async function listStates() {
  const st = settings();
  const providers = readProviderDict(st);
  let hidden;
  let archiveError;
  try {
    hidden = (await readArchive()).hidden;
  } catch (error) {
    hidden = Object.create(null);
    archiveError = msgOf(error);
  }
  let visible = 0;
  let hiddenCount = 0;
  const out = [];
  for (const [route, profile] of Object.entries(providers)) {
    const rec = asRecord(profile) ?? {};
    const models = Array.isArray(rec.models) ? rec.models : [];
    const archive = Array.isArray(hidden[route]) ? hidden[route] : [];
    visible += models.length;
    hiddenCount += archive.length;
    out.push({
      route,
      displayName: typeof rec.displayName === "string" ? rec.displayName : route,
      models: models.map((m) => ({ id: String(modelIdOf(m)), name: String(modelNameOf(m)) })),
      hidden: archive.map((m) => ({ id: String(modelIdOf(m)), name: String(modelNameOf(m)) }))
    });
  }
  // Providers that no longer exist in llm-pi-ai (e.g. disabled via
  // dsh-model-pro) but still hold archived models — surface them so the UI
  // can explain why "show" is unavailable.
  for (const [route, archive] of Object.entries(hidden)) {
    if (providers[route] !== undefined) continue;
    const list = Array.isArray(archive) ? archive : [];
    hiddenCount += list.length;
    out.push({
      route,
      displayName: route,
      providerMissing: true,
      models: [],
      hidden: list.map((m) => ({ id: String(modelIdOf(m)), name: String(modelNameOf(m)) }))
    });
  }
  return {
    ok: true,
    providers: out,
    totals: { visible, hidden: hiddenCount },
    ...(archiveError !== undefined ? { archiveError } : {})
  };
}

async function hideModel(args) {
  const route = typeof args?.route === "string" ? args.route : "";
  const modelId = typeof args?.modelId === "string" ? args.modelId : "";
  if (!route || !modelId) return { ok: false, error: "route and modelId are required" };
  const st = settings();
  if (st === undefined || st === null) return { ok: false, error: "settings service is not available" };
  const providers = readProviderDict(st);
  const profile = asRecord(providers[route]);
  if (!profile) return { ok: false, error: `provider "${route}" is not configured` };
  const models = Array.isArray(profile.models) ? profile.models.slice() : [];
  const idx = models.findIndex((m) => String(modelIdOf(m)) === modelId);
  if (idx < 0) {
    // Not visible. Either already archived (idempotent) or unknown.
    const archive = await readArchive();
    const list = Array.isArray(archive.hidden[route]) ? archive.hidden[route] : [];
    if (list.some((m) => String(modelIdOf(m)) === modelId)) {
      return { ok: true, route, modelId, already: true };
    }
    return { ok: false, error: `model "${modelId}" not found in provider "${route}"` };
  }
  // Guard 1: llm-pi-ai rejects a declared route whose models list is empty
  // (`resolves no models` in resolveRouteModels, strict validation), so hiding
  // the last visible model would make the write fail and leave the model listed
  // as both visible and hidden.
  if (models.length <= 1) {
    return {
      ok: false,
      route,
      modelId,
      error: `cannot hide the last visible model of "${route}": llm-pi-ai requires every route to keep at least one model entry. Add another model to this provider first, then hide this one.`
    };
  }
  // Guard 2: hiding the model DSH currently falls back to would leave new
  // sessions unable to resolve it. Same rule dsh-model-pro 2.1.0 enforces.
  const isDefault = currentDefaultHit(route, modelId);
  if (isDefault !== undefined) {
    return {
      ok: false,
      route,
      modelId,
      error: `"${isDefault}" is DSH's current default model; hiding it would leave new sessions unable to resolve it. Switch the model picker to another model first, then hide this one.`
    };
  }
  const [entry] = models.splice(idx, 1);
  const archive = await readArchive();
  const list = Array.isArray(archive.hidden[route]) ? archive.hidden[route].slice() : [];
  const deduped = list.filter((m) => String(modelIdOf(m)) !== modelId);
  deduped.push(entry);
  archive.hidden[route] = deduped;
  // Archive FIRST — a hidden model without an archive entry would be lost on
  // the next unload restore, so any archive failure aborts the whole hide.
  await writeArchive(archive);
  try {
    const next = cloneProviders(providers);
    next[route].models = models;
    const prev = readSection(st, NS_LLM);
    await writeLlm(st, next, prev);
  } catch (error) {
    return {
      ok: false,
      route,
      modelId,
      archivedOnly: true,
      error: `archived, but removing the model from the picker failed: ${msgOf(error)}`
    };
  }
  return { ok: true, route, modelId, hiddenCount: deduped.length };
}

async function showModel(args) {
  const route = typeof args?.route === "string" ? args.route : "";
  const modelId = typeof args?.modelId === "string" ? args.modelId : "";
  if (!route || !modelId) return { ok: false, error: "route and modelId are required" };
  const st = settings();
  if (st === undefined || st === null) return { ok: false, error: "settings service is not available" };
  const providers = readProviderDict(st);
  const profile = asRecord(providers[route]);
  if (!profile) {
    return {
      ok: false,
      error: `provider "${route}" is currently not configured (it may be disabled via dsh-model-pro); the archived model is kept`
    };
  }
  const archive = await readArchive();
  const list = Array.isArray(archive.hidden[route]) ? archive.hidden[route].slice() : [];
  const idx = list.findIndex((m) => String(modelIdOf(m)) === modelId);
  if (idx < 0) {
    const models = Array.isArray(profile.models) ? profile.models : [];
    if (models.some((m) => String(modelIdOf(m)) === modelId)) {
      return { ok: true, route, modelId, already: true }; // idempotent
    }
    return { ok: false, error: `model "${modelId}" is not archived for provider "${route}"` };
  }
  const [entry] = list.splice(idx, 1);
  const models = Array.isArray(profile.models) ? profile.models.slice() : [];
  if (!models.some((m) => String(modelIdOf(m)) === modelId)) models.push(entry);
  const next = cloneProviders(providers);
  next[route].models = models;
  // Restore into llm-pi-ai FIRST — if that fails the archive stays intact and
  // nothing is lost; a failing archive cleanup afterwards only leaves a stale
  // (harmless, retryable) entry behind.
  try {
    const prev = readSection(st, NS_LLM);
    await writeLlm(st, next, prev);
  } catch (error) {
    return {
      ok: false,
      route,
      modelId,
      error: `could not restore the model into the picker: ${msgOf(error)}`
    };
  }
  if (list.length > 0) archive.hidden[route] = list;
  else delete archive.hidden[route];
  try {
    await writeArchive(archive);
  } catch (error) {
    return { ok: true, route, modelId, warning: `restored, but archive cleanup failed: ${msgOf(error)}` };
  }
  return { ok: true, route, modelId };
}

// Merge every archived entry back (used when the plugin is disabled or
// uninstalled). Best effort per route: a missing provider keeps its archive.
// Returns the number of restored routes.
async function restoreAll() {
  const st = settings();
  if (st === undefined || st === null) return 0;
  const archive = await readArchive();
  const routes = Object.keys(archive.hidden);
  if (routes.length === 0) return 0;
  const providers = readProviderDict(st);
  const next = cloneProviders(providers);
  const remaining = Object.create(null);
  let touched = false;
  for (const route of routes) {
    const list = archive.hidden[route];
    const profile = asRecord(next[route]);
    if (!profile) {
      remaining[route] = list; // provider gone; keep archive untouched
      continue;
    }
    const models = Array.isArray(profile.models) ? profile.models.slice() : [];
    for (const entry of list) {
      const id = String(modelIdOf(entry));
      if (!models.some((m) => String(modelIdOf(m)) === id)) models.push(entry);
    }
    profile.models = models;
    touched = true;
  }
  if (!touched) return 0;
  const prev = readSection(st, NS_LLM);
  await writeLlm(st, next, prev); // failure leaves the archive file untouched
  archive.hidden = remaining;
  await writeArchive(archive);
  return routes.length - Object.keys(remaining).length;
}

// --------------------------------------------------------------- runtime ---
export class ModelToggleRuntime extends TypertRemoteService {
  constructor(ctx) {
    super(ctx, SERVICE_KEY);
  }
  async listStates() {
    // Queued as well: a read racing a hide/show would otherwise observe the
    // half-applied window where the archive already moved but llm-pi-ai has not.
    return serialized(() => listStates());
  }
  async hideModel(args) {
    return serialized(() => hideModel(args || {}));
  }
  async showModel(args) {
    return serialized(() => showModel(args || {}));
  }
}

// ------------------------------------------------------------------ apply ---
export async function apply(ctx) {
  boundSettings = ctx.get("settings");
  boundLogger = ctx.logger;
  // agentDefaultModel is optional: it is absent in deployments without a
  // default-model owner, in which case the "do not hide the default" guard
  // simply has nothing to check.
  try {
    boundDefaultModel = ctx.get("agentDefaultModel");
  } catch {
    boundDefaultModel = undefined;
  }

  // Resolve the archive file location: the profile directory that holds
  // cordis.patch.yml. Both services are injected by dsh-settings itself
  // (static inject = ["configEditor", "profileContext"]).
  let profileDir;
  try {
    profileDir = ctx.get("profileContext")?.dir;
    if (typeof profileDir !== "string" || profileDir.length === 0) {
      const docPath = ctx.get("configEditor")?.documentPath;
      if (typeof docPath === "string" && docPath.length > 0) profileDir = path.dirname(docPath);
    }
  } catch {
    profileDir = undefined;
  }
  if (typeof profileDir === "string" && profileDir.length > 0) {
    archivePath = path.join(profileDir, ARCHIVE_NAME);
  } else {
    archivePath = undefined;
    memoryArchive = emptyArchive();
    ctx.logger?.warn?.(
      "dsh-model-toggle: profile directory not resolvable — the archive stays in memory only (hidden models are restored on unload but not across restarts)"
    );
  }

  // Read-only self check. v1 wrote a probe into our own config section here;
  // on 0.2 that write can never succeed during apply (describe() filters
  // non-ACTIVE fibers, configEditor.edit enforces state ACTIVE) and a
  // successful self-write would restart our fiber and trip the unload
  // restore. Real write coverage starts with the first hide/show call.
  const arm = settingsArm(boundSettings);
  if (boundSettings === undefined || boundSettings === null) {
    ctx.logger?.warn?.("dsh-model-toggle: no settings service mounted — list/hide/show cannot work");
  } else if (arm === "unknown") {
    ctx.logger?.warn?.(
      "dsh-model-toggle: unrecognised settings service (neither get(ns) nor describe()) — configuration reads and writes cannot be performed"
    );
  }

  // Register the Cordis Service that the Remote endpoint resolves against.
  // The class body alone registers nothing: without this constructor call the
  // gateway fails every call with `active Service "modelToggle" is unavailable`
  // (dsh-api-gateway lib/index.js:1193). dsh-model-pro does the same in its
  // apply() (`new ModelProRuntime(ctx)`, dist/host.js:4545).
  new ModelToggleRuntime(ctx);

  ctx.effect(() => ctx.typert.register(MANIFEST), "dsh-model-toggle: typert manifest");

  // Restore every archived model when the plugin is disabled or uninstalled,
  // so hiding never becomes data loss. llm-pi-ai's fiber stays ACTIVE while
  // ours unloads, so this write succeeds even though ours cannot.
  ctx.effect(
    () => {
      return async () => {
        try {
          const restored = await serialized(() => restoreAll());
          if (restored > 0) {
            ctx.logger?.info?.(`dsh-model-toggle: restored ${restored} route(s) from the archive on unload`);
          }
        } catch (error) {
          ctx.logger?.warn?.(
            `dsh-model-toggle: restore on unload failed: ${msgOf(error)} — the archive file is kept`
          );
        }
      };
    },
    "dsh-model-toggle: restore archived models on unload"
  );

  return () => {
    boundSettings = undefined;
    boundLogger = undefined;
    boundDefaultModel = undefined;
  };
}

export { MANIFEST, INVOCATIONS, SERVICE_KEY, PACKAGE, NS_LLM, ARCHIVE_NAME };
export const inject = ["typert", "settings", "configEditor", "profileContext"];
export const name = PACKAGE;
