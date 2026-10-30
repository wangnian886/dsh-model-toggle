// 用真实 cordis 验证「卸载时还原」这条承诺。
//
// 为什么不能只靠 test/suite.mjs：那里的假 ctx 把 `effect(fn)` 直接当 fn() 调用、
// disposer 是同步的，根本模拟不出 cordis 真实的卸载顺序。真实 cordis 的
// `_unload()` 是 `Promise.all(disposables.clear().map(...))`——apply() 的返回值
// 只是其中一项，同步 cleanup 会跑完才轮到 async disposer 的第一个 await。
// v0.1.2 就是栽在这里：cleanup 先把 boundSettings 清空，restoreAll() 读到
// undefined 直接 return 0，真机上卸载后 8 个模型全留在归档里。
//
// 依赖：@deepseek-ai/cordis（本仓库把它当 devDependency，但干净检出可能没装）。
// 解析不到就跳过并明确打印，不算失败——保持「clone 下来 npm test 全绿」的特性。
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import "./setup.mjs";

let Context;
try {
  ({ Context } = await import("@deepseek-ai/cordis"));
} catch (error) {
  console.log("SKIP real-cordis unload test: @deepseek-ai/cordis is not installed");
  console.log(`     (${error.code ?? error.message})`);
  process.exit(0);
}

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "mt-real-unload-"));
const archivePath = path.join(tmp, "dsh-model-toggle.archive.json");

let live = {
  providers: {
    "wb-gateway": {
      displayName: "WorkBuddy main",
      api: "openai-completions",
      baseURL: "http://127.0.0.1:1/v1",
      models: [
        { id: "wb-fixed-1", name: "WB 1" },
        { id: "wb-fixed-2", name: "WB 2" },
      ],
    },
  },
};

const replaceCalls = [];
const warns = [];
const infos = [];

// 0.2 形状：describe() 同步返回行数组，replace() 异步。
const settingsStub = {
  describe() {
    return [{ ns: "llm-pi-ai", user: live, value: live, base: live }];
  },
  async replace(ns, section) {
    if (ns !== "llm-pi-ai") throw new Error(`unexpected ns ${ns}`);
    replaceCalls.push(JSON.parse(JSON.stringify(section)));
    live = JSON.parse(JSON.stringify(section));
  },
};

const ctx = new Context();
ctx.provide("settings", settingsStub);
ctx.provide("configEditor", {
  get documentPath() {
    return path.join(tmp, "cordis.patch.yml");
  },
  entries() {
    return [];
  },
});
ctx.provide("profileContext", { dir: tmp, patchPath: path.join(tmp, "cordis.patch.yml") });
ctx.provide("agentDefaultModel", {
  currentSelection() {
    return { provider: "wb-gateway", model: "wb-fixed-1" };
  },
});
ctx.provide("typert", { register: () => () => {} });
ctx.logger = {
  info: (m) => infos.push(String(m)),
  warn: (m) => warns.push(String(m)),
  error: (m) => warns.push(String(m)),
  debug: () => {},
};

const hostMod = await import("../host.js");

let pass = 0;
const results = [];
async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    results.push(`ok   ${name}`);
  } catch (error) {
    results.push(`FAIL ${name} — ${error.message}`);
  }
}

// 必须走 ctx.plugin()：直接调 apply() 不会创建 Fiber，effect 注册的 disposer
// 根本不会被收集，那样测出来的「没还原」是假阳性。
ctx.plugin(hostMod.default ?? hostMod);
await new Promise((resolve) => setTimeout(resolve, 300));

const svc = ctx.get("modelToggle");
const fiber = ctx.fiber;

await check("ctx.plugin() brings the modelToggle service up", () => {
  assert.equal(fiber?.state, 2, "the plugin fiber must be ACTIVE");
  assert.ok(svc, "the modelToggle service must be registered");
});

await check("hiding a model removes it from the live config", async () => {
  const hidden = await svc.hideModel({ route: "wb-gateway", modelId: "wb-fixed-2" });
  assert.equal(hidden.ok, true);
  assert.deepEqual(
    live.providers["wb-gateway"].models.map((m) => m.id),
    ["wb-fixed-1"],
    "the hidden model must be gone from the live provider list"
  );
  assert.ok(await fsp.access(archivePath).then(() => true, () => false), "the archive file must exist");
});

await check("disposing the fiber restores the archived model (the real unload path)", async () => {
  await fiber.dispose();
  assert.deepEqual(
    live.providers["wb-gateway"].models.map((m) => m.id),
    ["wb-fixed-1", "wb-fixed-2"],
    "the archived model must come back when the fiber is disposed"
  );
  const leftover = JSON.parse(await fsp.readFile(archivePath, "utf8").catch(() => '{"hidden":{}}'));
  assert.deepEqual(leftover.hidden, {}, "the archive must be emptied once everything is restored");
  assert.ok(
    infos.some((m) => m.includes("restored 1 route(s)")),
    `expected an info line reporting the restore, got ${JSON.stringify(infos)}`
  );
});

await check("the restore happens after apply()'s own cleanup would have run", async () => {
  // 上面三步已经覆盖了真实顺序；这一条把「同步 cleanup 先跑」这个前提也钉住：
  // 如果哪天有人在 apply() 末尾重新加回清理句柄的 return，disposer 会读到空的
  // boundSettings，上面的断言就会失败。这里再断言 cleanup 本身没被用来清句柄。
  assert.equal(warns.length, 0, `no warnings expected, got ${JSON.stringify(warns)}`);
  assert.ok(replaceCalls.length >= 2, "the restore must issue its own config write");
});

await fsp.rm(tmp, { recursive: true, force: true });

console.log(results.join("\n"));
console.log(`${pass} passed, ${results.length - pass} failed`);
process.exitCode = results.length === pass ? 0 : 1;
