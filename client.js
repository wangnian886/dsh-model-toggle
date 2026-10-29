// dsh-model-toggle — client side (web)
// Renders a panel in the settings page "settings.models.footer" slot:
// every llm-pi-ai provider with its models, each row carrying a hide/show
// toggle. Hidden models are archived by the host service and disappear from
// the conversation model picker; showing merges them back. React comes from
// the module loader (window.__ModuleLoader__), same as dsh-model-pro.

// The loader id must be the resolved package name verbatim: dsh-client-modules
// keys factories by stripClientSuffix(registration.id) but looks them up by the
// graph row id, which comes from the manifest package name. A bare "model-toggle"
// never matches "dsh-model-toggle", so arrive() reports "loaded without
// registering" and apply() never runs. Verified against shipped + third-party
// bundles: every client.js id equals its package.json name.
window.__ModuleLoader__.load({ id: "dsh-model-toggle", factory: (require) => {
  var module = { exports: {} };
  var exports = module.exports;
  var React = require("react");

  const PACKAGE = "dsh-model-toggle";
  const SERVICE_KEY = "modelToggle";

  // wire name -> host method name (must match host.js METHODS)
  const METHODS = [
    ["list-states", "listStates"],
    ["hide-model", "hideModel"],
    ["show-model", "showModel"]
  ];
  const METHOD_MAP = Object.fromEntries(METHODS);

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

  // ------------------------------------------------------------------ rpc ---
  let remote;
  const msgOf = (e) => {
    if (e === null || typeof e !== "object") return String(e ?? "unknown error");
    return String(e.message ?? e.error ?? e.detail ?? e.failure ?? e.cause ?? "unknown error");
  };
  const createCall = () => async (method, payload) => {
    if (remote === undefined) throw new Error("dsh-model-toggle remote is not mounted yet");
    const remoteMethod = METHOD_MAP[method];
    if (remoteMethod === undefined) throw new Error(`unknown method "${method}"`);
    const r = await remote[remoteMethod](payload || {});
    if ((r === null || typeof r !== "object") || r.ok !== true) {
      throw new Error(`remote bridge refused "${method}"${r ? `: ${msgOf(r)}` : ""}`);
    }
    const value = r.value;
    if ((value === null || typeof value !== "object") || value.ok !== true) {
      throw new Error(value ? msgOf(value) : `method "${method}" returned no value`);
    }
    return value;
  };
  const call = createCall();

  // ----------------------------------------------------------------- css ---
  const CSS = [
    ".mtg-panel{margin-top:10px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:9px}",
    ".mtg-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}",
    ".mtg-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}",
    ".mtg-totals{font-size:10.5px;color:var(--dsw-alias-label-tertiary)}",
    ".mtg-provider{border-left:2px solid var(--dsw-alias-border-l2);padding-left:10px;display:flex;flex-direction:column;gap:5px}",
    ".mtg-providerName{font-size:11px;color:var(--dsw-alias-label-secondary)}",
    ".mtg-providerMissing{color:var(--dsw-alias-state-warn-label);font-size:10.5px}",
    ".mtg-row{display:flex;align-items:center;gap:8px;min-width:0}",
    ".mtg-modelName{font-size:11.5px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}",
    ".mtg-modelId{font-size:10px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}",
    ".mtg-rowHidden .mtg-modelName{color:var(--dsw-alias-label-quaternary);text-decoration:line-through}",
    ".mtg-btn{flex:none;font-size:10.5px;padding:2px 9px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}",
    ".mtg-btn:hover{border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary)}",
    ".mtg-btnBusy{opacity:.5;cursor:default}",
    ".mtg-note{font-size:10.5px;color:var(--dsw-alias-state-danger-label,var(--dsw-alias-state-warn-label));overflow-wrap:anywhere}",
    ".mtg-hint{font-size:10px;color:var(--dsw-alias-label-tertiary)}"
  ].join("");

  function adoptStyles(css) {
    const id = "dsh-model-toggle-styles";
    if (typeof document === "undefined") return;
    if (document.getElementById(id) !== null) return;
    const style = document.createElement("style");
    style.id = id;
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ----------------------------------------------------------------- ui ---
  function FooterPanel() {
    const [data, setData] = React.useState(null);
    const [error, setError] = React.useState(null);
    const [busy, setBusy] = React.useState(null); // `${route}/${modelId}` while in flight
    const [loadTick, setLoadTick] = React.useState(0);

    React.useEffect(() => {
      let alive = true;
      call("list-states")
        .then((r) => {
          if (alive) {
            setData(r);
            setError(null);
          }
        })
        .catch((e) => {
          if (alive) setError(msgOf(e));
        });
      return () => {
        alive = false;
      };
    }, [loadTick]);

    const toggle = (route, modelId, isHidden) => {
      if (busy !== null) return;
      setBusy(`${route}/${modelId}`);
      const wire = isHidden ? "show-model" : "hide-model";
      call(wire, { route, modelId })
        .then(() => {
          setBusy(null);
          setLoadTick((n) => n + 1);
        })
        .catch((e) => {
          setBusy(null);
          setError(msgOf(e));
        });
    };

    const totals = data && data.totals ? data.totals : null;
    return React.createElement(
      "div",
      { className: "mtg-panel" },
      React.createElement(
        "div",
        { className: "mtg-head" },
        React.createElement("span", { className: "mtg-title" }, "模型开关"),
        totals
          ? React.createElement("span", { className: "mtg-totals" }, `可见 ${totals.visible} · 已隐藏 ${totals.hidden}`)
          : null
      ),
      error !== null ? React.createElement("div", { className: "mtg-note" }, error) : null,
      data === null && error === null ? React.createElement("div", { className: "mtg-hint" }, "加载中…") : null,
      data !== null && data.providers.length === 0
        ? React.createElement("div", { className: "mtg-hint" }, "没有可管理的模型提供商")
        : null,
      data !== null
        ? data.providers.map((p) =>
            React.createElement(
              "div",
              { className: "mtg-provider", key: p.route },
              React.createElement("span", { className: "mtg-providerName" }, p.displayName),
              p.providerMissing === true
                ? React.createElement(
                    "span",
                    { className: "mtg-providerMissing" },
                    "该提供商当前不在配置中（可能已被「模型 Pro」禁用）；隐藏的模型保留在存档里，等提供商恢复后可再显示"
                  )
                : null,
              p.models.map((m) =>
                React.createElement(
                  "div",
                  { className: "mtg-row", key: `v-${p.route}/${m.id}` },
                  React.createElement("span", { className: "mtg-modelName" }, m.name),
                  m.name !== m.id ? React.createElement("span", { className: "mtg-modelId" }, m.id) : null,
                  React.createElement("span", { style: { flex: "1 1 auto" } }),
                  React.createElement(
                    "button",
                    {
                      className: busy === `${p.route}/${m.id}` ? "mtg-btn mtg-btnBusy" : "mtg-btn",
                      disabled: busy !== null,
                      onClick: () => toggle(p.route, m.id, false)
                    },
                    "隐藏"
                  )
                )
              ),
              p.hidden.map((m) =>
                React.createElement(
                  "div",
                  { className: "mtg-row mtg-rowHidden", key: `h-${p.route}/${m.id}` },
                  React.createElement("span", { className: "mtg-modelName" }, m.name),
                  m.name !== m.id ? React.createElement("span", { className: "mtg-modelId" }, m.id) : null,
                  React.createElement("span", { style: { flex: "1 1 auto" } }),
                  React.createElement(
                    "button",
                    {
                      className: busy === `${p.route}/${m.id}` ? "mtg-btn mtg-btnBusy" : "mtg-btn",
                      disabled: busy !== null,
                      onClick: () => toggle(p.route, m.id, true)
                    },
                    "显示"
                  )
                )
              )
            )
          )
        : null,
      React.createElement(
        "div",
        { className: "mtg-hint" },
        "隐藏只把模型从对话选择器里摘下并存档，不改凭据、可随时恢复；禁用本插件会自动全部还原。"
      )
    );
  }

  // --------------------------------------------------------------- apply ---
  function apply(ctx) {
    adoptStyles(CSS);
    ctx.effect(async () => {
      const dispose = await ctx.remote.$mount({ package: PACKAGE, descriptors: INVOCATIONS });
      const handle = ctx.reflect.get(`remote.${SERVICE_KEY}`);
      if (handle === undefined) {
        throw new Error(`dsh-model-toggle: the ${SERVICE_KEY} Remote namespace did not mount`);
      }
      remote = handle;
      return () => {
        remote = undefined;
        void dispose();
      };
    }, "dsh-model-toggle: remote");
    const slots = ctx.get("slots") ?? ctx.slots;
    if (slots === undefined) return;
    slots.inject("settings.models.footer", () => {
      return slots.register(
        { name: "settings.models.footer", id: "dsh-model-toggle" },
        () => React.createElement(FooterPanel)
      );
    });
  }

  exports.name = PACKAGE;
  exports.inject = ["slots", "remote"];
  exports.apply = apply;
  return module.exports;
} });
