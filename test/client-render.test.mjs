// Render smoke test: evaluate client.js, run apply() against a stub ctx,
// capture the component registered into settings.models.footer, and render it
// with a fake React in three states (loading / error / loaded) to prove the
// panel tree builds without throwing and carries the expected text.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("..", import.meta.url));
const src = readFileSync(join(dir, "client.js"), "utf8");

// ---------------------------------------------------------------- fake React
function makeReact(stateQueue) {
  const tree = [];
  const React = {
    createElement(type, props, ...children) {
      const node = { type, props: props ?? {}, children: children.flat() };
      tree.push(node);
      return node;
    },
    useState(initial) {
      const next = stateQueue.length > 0 ? stateQueue.shift() : initial;
      return [next, () => {}];
    },
    useEffect(fn) {
      // deliberately not executed: the effect drives RPC, which we cover elsewhere
      void fn;
    }
  };
  return { React, tree };
}

// ------------------------------------------------------------------ loader
let registration;
const window = { __ModuleLoader__: { load: (r) => { registration = r; } } };
new Function("window", "document", src)(window, undefined);

const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });

check("bundle registered", registration !== undefined);

// ------------------------------------------------------------ stub services
let registeredComponent = null;
let remoteCalls = [];
const remoteHandle = {
  listStates: async (a) => { remoteCalls.push(["listStates", a]); return { ok: true, value: { ok: true, providers: [], totals: { visible: 0, hidden: 0 } } }; },
  hideModel: async (a) => { remoteCalls.push(["hideModel", a]); return { ok: true, value: { ok: true } }; },
  showModel: async (a) => { remoteCalls.push(["showModel", a]); return { ok: true, value: { ok: true } }; }
};

const { React, tree } = makeReact([]);
const ctx = {
  // Real Cordis runs the effect body; the client relies on it to mount the
  // Remote namespace, so the stub must run it too (fire-and-forget).
  effect(fn, label) { void label; void Promise.resolve().then(fn).catch(() => {}); return () => {}; },
  get(name) {
    if (name === "slots") {
      return {
        inject(key, cb) { check("slots.inject targets settings.models.footer", key === "settings.models.footer", key); cb(); return () => {}; },
        register(def, component) {
          check("slot registration id is dsh-model-toggle", def.id === "dsh-model-toggle", JSON.stringify(def));
          registeredComponent = component;
          return () => {};
        }
      };
    }
    return undefined;
  },
  remote: { $mount: async () => () => {} },
  reflect: { get: () => remoteHandle }
};

const mod = registration.factory((spec) => {
  if (spec === "react") return React;
  throw new Error(`unexpected require("${spec}")`);
});
mod.apply(ctx);
// apply() mounts the Remote namespace inside ctx.effect (async); let it settle.
await new Promise((r) => setTimeout(r, 20));

check("a component was registered into the slot", typeof registeredComponent === "function", typeof registeredComponent);

// ------------------------------------------------------------ render states
// The component closes over the `React` captured at factory time, so swapping
// that binding is impossible; instead drive it with the same React instance but
// feed states through a mutable queue.
const queue = [];
React.useState = (initial) => {
  const next = queue.length > 0 ? queue.shift() : initial;
  return [next, () => {}];
};

// The slot registers `() => React.createElement(FooterPanel)`, so the first
// node's type is the function component itself; real React would invoke it, so
// this fake has to as well.
function mountPanel(data, error, busy) {
  queue.length = 0;
  queue.push(data, error, busy, 0);
  tree.length = 0;
  const element = registeredComponent();
  if (typeof element.type !== "function") throw new Error("slot did not return a component element");
  return element.type(element.props);
}

function render(data, error, busy) {
  return mountPanel(data, error, busy);
}

const okData = {
  providers: [
    {
      route: "wb-gateway",
      displayName: "WorkBuddy 主通道",
      models: [{ id: "wb-fixed-6", name: "wb-fixed-6" }, { id: "wb-fixed-5", name: "wb-fixed-5" }],
      hidden: [{ id: "wb-fixed-4", name: "wb-fixed-4" }]
    },
    {
      route: "gone",
      displayName: "已消失的提供商",
      providerMissing: true,
      models: [],
      hidden: [{ id: "m1", name: "m1" }]
    }
  ],
  totals: { visible: 2, hidden: 2 }
};

for (const [label, args] of [
  ["loading", [null, null, null]],
  ["error", [null, "boom", null]],
  ["loaded", [okData, null, null]]
]) {
  let threw = null;
  try { render(...args); } catch (e) { threw = e; }
  check(`render "${label}" does not throw`, threw === null, threw ? String(threw.message) : "");
}

// loaded-state content assertions
tree.length = 0;
const panel = mountPanel(okData, null, null);
const flat = [];
const walk = (n) => {
  if (n === null || n === undefined) return;
  if (typeof n === "string" || typeof n === "number") { flat.push(String(n)); return; }
  if (Array.isArray(n)) { n.forEach(walk); return; }
  if (n.children) n.children.forEach(walk);
};
walk(panel);
const text = flat.join(" | ");

check("panel title present", text.includes("模型开关"), text.slice(0, 120));
check("totals rendered", text.includes("可见 2 · 已隐藏 2"), "");
check("missing-provider notice rendered", text.includes("该提供商当前不在配置中"), "");
check("footer hint rendered", text.includes("隐藏只把模型从对话选择器里摘下并存档"), "");

// button onClick wires the right wire method
const buttons = [];
const walkBtn = (n) => {
  if (n === null || n === undefined) return;
  if (Array.isArray(n)) { n.forEach(walkBtn); return; }
  if (n.type === "button") buttons.push(n);
  if (n.children) n.children.forEach(walkBtn);
};
queue.length = 0;
queue.push(okData, null, null, 0);
tree.length = 0;
const panel2 = mountPanel(okData, null, null);
walkBtn(panel2);
check("two hide + two show buttons exist", buttons.length === 4, String(buttons.length));
const hideBtns = buttons.filter((b) => b.children.includes("隐藏"));
const showBtns = buttons.filter((b) => b.children.includes("显示"));
check("hide buttons = visible models (2)", hideBtns.length === 2, String(hideBtns.length));
check("show buttons = hidden models (2)", showBtns.length === 2, String(showBtns.length));
let clickErr = null;
try { hideBtns[0].props.onClick(); } catch (e) { clickErr = e; }
check("hide button onClick does not throw", clickErr === null, clickErr ? String(clickErr.message) : "");
await new Promise((r) => setTimeout(r, 20));
check("hide button calls hide-model with route+modelId", remoteCalls.some((c) => c[0] === "hideModel" && c[1].route === "wb-gateway" && c[1].modelId === "wb-fixed-6"), JSON.stringify(remoteCalls));

// A corrupt archive must be visible in the panel, not silently rendered as a
// normal (empty) list: host returns ok:true plus `archiveError`.
{
  const brokenData = { providers: [], totals: { visible: 0, hidden: 0 }, archiveError: "Unexpected token } in JSON" };
  tree.length = 0;
  const brokenPanel = mountPanel(brokenData, null, null);
  const brokenFlat = [];
  const walkText = (n) => {
    if (n === null || n === undefined) return;
    if (typeof n === "string" || typeof n === "number") { brokenFlat.push(String(n)); return; }
    if (Array.isArray(n)) { n.forEach(walkText); return; }
    if (n.children) n.children.forEach(walkText);
  };
  walkText(brokenPanel);
  const brokenText = brokenFlat.join(" | ");
  check("archiveError is surfaced in the panel", brokenText.includes("存档读取失败") && brokenText.includes("Unexpected token } in JSON"), brokenText.slice(0, 160));
}

// ------------------------------------------------- concurrency guard (busy) ---
// While one operation is in flight the panel must refuse a second one: every
// button is disabled and toggle() returns before issuing a Remote call. The
// guard is `if (busy !== null) return;` in client.js — without a non-null busy
// state this branch is never reached, so it needs its own render.
remoteCalls = [];
const busyButtons = [];
const busyPanel = mountPanel(okData, null, "wb-gateway/wb-fixed-6");
walkBtn(busyPanel);
// walkBtn pushes into `buttons`; take the fresh tail instead of a second walker.
busyButtons.push(...buttons.slice(-4));
check("all buttons disabled while an operation is in flight", busyButtons.length > 0 && busyButtons.every((b) => b.props.disabled === true), String(busyButtons.length));
let busyClickErr = null;
try { busyButtons[0].props.onClick(); } catch (e) { busyClickErr = e; }
check("clicking a disabled button does not throw", busyClickErr === null, busyClickErr ? String(busyClickErr.message) : "");
await new Promise((r) => setTimeout(r, 20));
check("no Remote call is issued while busy", remoteCalls.length === 0, JSON.stringify(remoteCalls));

// The button for the in-flight row carries the busy class; the others do not.
const busyClasses = busyButtons.map((b) => b.props.className);
check("in-flight row is marked busy, others are not", busyClasses.filter((c) => c.includes("mtg-btnBusy")).length === 1, JSON.stringify(busyClasses));

// ---------------------------------------------------------------- reporting
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  [${r.detail}]` : ""}`);
}
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
