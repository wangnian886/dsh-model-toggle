// Minimal stub of @deepseek-ai/dsh-typert-protocol for host-logic self-tests.
//
// Mirrors the REAL registration behaviour of the vendored package: Cordis'
// `Service` constructor calls `ctx.reflect.provide(name, self, check)`
// (cordis lib/types/service.js:52), and `TypertRemoteService` additionally
// binds `this.typertRemote` (dsh-typert-protocol lib/index.js:348-351).
// A stub that silently accepts anything hides the class of bug where a plugin
// declares a Service class but never instantiates it — the gateway then fails
// every call with `active Service "..." is unavailable`.
export class TypertRemoteService {
  constructor(ctx, serviceKey, options = {}) {
    if (ctx === undefined || ctx === null) throw new TypeError("typert-protocol: ctx is required");
    if (typeof ctx.reflect?.provide !== "function") {
      throw new TypeError("typert-protocol: ctx.reflect.provide is unavailable");
    }
    this.ctx = ctx;
    this.name = serviceKey;
    this.typertRemote = Object.freeze({
      service: this,
      serviceKey,
      namespace: options.namespace ?? serviceKey,
    });
    ctx.reflect.provide(serviceKey, this, this.constructor.check);
  }
}
