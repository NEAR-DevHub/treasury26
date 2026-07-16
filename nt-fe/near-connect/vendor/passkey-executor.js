(function() {
  "use strict";
  var _a$1;
  function $constructor(name, initializer2, params) {
    function init(inst, def) {
      if (!inst._zod) {
        Object.defineProperty(inst, "_zod", {
          value: {
            def,
            constr: _,
            traits: /* @__PURE__ */ new Set()
          },
          enumerable: false
        });
      }
      if (inst._zod.traits.has(name)) {
        return;
      }
      inst._zod.traits.add(name);
      initializer2(inst, def);
      const proto = _.prototype;
      const keys2 = Object.keys(proto);
      for (let i = 0; i < keys2.length; i++) {
        const k = keys2[i];
        if (!(k in inst)) {
          inst[k] = proto[k].bind(inst);
        }
      }
    }
    const Parent = params?.Parent ?? Object;
    class Definition extends Parent {
    }
    Object.defineProperty(Definition, "name", { value: name });
    function _(def) {
      var _a2;
      const inst = params?.Parent ? new Definition() : this;
      init(inst, def);
      (_a2 = inst._zod).deferred ?? (_a2.deferred = []);
      for (const fn of inst._zod.deferred) {
        fn();
      }
      return inst;
    }
    Object.defineProperty(_, "init", { value: init });
    Object.defineProperty(_, Symbol.hasInstance, {
      value: (inst) => {
        if (params?.Parent && inst instanceof params.Parent)
          return true;
        return inst?._zod?.traits?.has(name);
      }
    });
    Object.defineProperty(_, "name", { value: name });
    return _;
  }
  class $ZodAsyncError extends Error {
    constructor() {
      super(`Encountered Promise during synchronous parse. Use .parseAsync() instead.`);
    }
  }
  class $ZodEncodeError extends Error {
    constructor(name) {
      super(`Encountered unidirectional transform during encode: ${name}`);
      this.name = "ZodEncodeError";
    }
  }
  (_a$1 = globalThis).__zod_globalConfig ?? (_a$1.__zod_globalConfig = {});
  const globalConfig = globalThis.__zod_globalConfig;
  function config(newConfig) {
    return globalConfig;
  }
  function getEnumValues(entries) {
    const numericValues = Object.values(entries).filter((v) => typeof v === "number");
    const values = Object.entries(entries).filter(([k, _]) => numericValues.indexOf(+k) === -1).map(([_, v]) => v);
    return values;
  }
  function jsonStringifyReplacer(_, value) {
    if (typeof value === "bigint")
      return value.toString();
    return value;
  }
  function cached(getter) {
    return {
      get value() {
        {
          const value = getter();
          Object.defineProperty(this, "value", { value });
          return value;
        }
      }
    };
  }
  function nullish(input) {
    return input === null || input === void 0;
  }
  function cleanRegex(source) {
    const start = source.startsWith("^") ? 1 : 0;
    const end = source.endsWith("$") ? source.length - 1 : source.length;
    return source.slice(start, end);
  }
  const EVALUATING = /* @__PURE__ */ Symbol("evaluating");
  function defineLazy(object2, key, getter) {
    let value = void 0;
    Object.defineProperty(object2, key, {
      get() {
        if (value === EVALUATING) {
          return void 0;
        }
        if (value === void 0) {
          value = EVALUATING;
          value = getter();
        }
        return value;
      },
      set(v) {
        Object.defineProperty(object2, key, {
          value: v
          // configurable: true,
        });
      },
      configurable: true
    });
  }
  function assignProp(target, prop, value) {
    Object.defineProperty(target, prop, {
      value,
      writable: true,
      enumerable: true,
      configurable: true
    });
  }
  function mergeDefs(...defs) {
    const mergedDescriptors = {};
    for (const def of defs) {
      const descriptors = Object.getOwnPropertyDescriptors(def);
      Object.assign(mergedDescriptors, descriptors);
    }
    return Object.defineProperties({}, mergedDescriptors);
  }
  const captureStackTrace = "captureStackTrace" in Error ? Error.captureStackTrace : (..._args) => {
  };
  function isObject$1(data) {
    return typeof data === "object" && data !== null && !Array.isArray(data);
  }
  function isPlainObject$1(o) {
    if (isObject$1(o) === false)
      return false;
    const ctor = o.constructor;
    if (ctor === void 0)
      return true;
    if (typeof ctor !== "function")
      return true;
    const prot = ctor.prototype;
    if (isObject$1(prot) === false)
      return false;
    if (Object.prototype.hasOwnProperty.call(prot, "isPrototypeOf") === false) {
      return false;
    }
    return true;
  }
  const propertyKeyTypes = /* @__PURE__ */ new Set(["string", "number", "symbol"]);
  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  function clone(inst, def, params) {
    const cl = new inst._zod.constr(def ?? inst._zod.def);
    if (!def || params?.parent)
      cl._zod.parent = inst;
    return cl;
  }
  function normalizeParams(_params) {
    const params = _params;
    if (!params)
      return {};
    if (typeof params === "string")
      return { error: () => params };
    if (params?.message !== void 0) {
      if (params?.error !== void 0)
        throw new Error("Cannot specify both `message` and `error` params");
      params.error = params.message;
    }
    delete params.message;
    if (typeof params.error === "string")
      return { ...params, error: () => params.error };
    return params;
  }
  function optionalKeys(shape) {
    return Object.keys(shape).filter((k) => {
      return shape[k]._zod.optin === "optional" && shape[k]._zod.optout === "optional";
    });
  }
  const NUMBER_FORMAT_RANGES = {
    safeint: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    int32: [-2147483648, 2147483647],
    uint32: [0, 4294967295],
    float32: [-34028234663852886e22, 34028234663852886e22],
    float64: [-Number.MAX_VALUE, Number.MAX_VALUE]
  };
  function partial$1(Class, schema, mask) {
    const currDef = schema._zod.def;
    const checks = currDef.checks;
    const hasChecks = checks && checks.length > 0;
    if (hasChecks) {
      throw new Error(".partial() cannot be used on object schemas containing refinements");
    }
    const def = mergeDefs(schema._zod.def, {
      get shape() {
        const oldShape = schema._zod.def.shape;
        const shape = { ...oldShape };
        {
          for (const key in oldShape) {
            shape[key] = Class ? new Class({
              type: "optional",
              innerType: oldShape[key]
            }) : oldShape[key];
          }
        }
        assignProp(this, "shape", shape);
        return shape;
      },
      checks: []
    });
    return clone(schema, def);
  }
  function aborted(x, startIndex = 0) {
    if (x.aborted === true)
      return true;
    for (let i = startIndex; i < x.issues.length; i++) {
      if (x.issues[i]?.continue !== true) {
        return true;
      }
    }
    return false;
  }
  function explicitlyAborted(x, startIndex = 0) {
    if (x.aborted === true)
      return true;
    for (let i = startIndex; i < x.issues.length; i++) {
      if (x.issues[i]?.continue === false) {
        return true;
      }
    }
    return false;
  }
  function prefixIssues(path, issues) {
    return issues.map((iss) => {
      var _a2;
      (_a2 = iss).path ?? (_a2.path = []);
      iss.path.unshift(path);
      return iss;
    });
  }
  function unwrapMessage(message) {
    return typeof message === "string" ? message : message?.message;
  }
  function finalizeIssue(iss, ctx, config2) {
    const message = iss.message ? iss.message : unwrapMessage(iss.inst?._zod.def?.error?.(iss)) ?? unwrapMessage(ctx?.error?.(iss)) ?? unwrapMessage(config2.customError?.(iss)) ?? unwrapMessage(config2.localeError?.(iss)) ?? "Invalid input";
    const { inst: _inst, continue: _continue, input: _input, ...rest } = iss;
    rest.path ?? (rest.path = []);
    rest.message = message;
    if (ctx?.reportInput) {
      rest.input = _input;
    }
    return rest;
  }
  function getLengthableOrigin(input) {
    if (Array.isArray(input))
      return "array";
    if (typeof input === "string")
      return "string";
    return "unknown";
  }
  function issue(...args) {
    const [iss, input, inst] = args;
    if (typeof iss === "string") {
      return {
        message: iss,
        code: "custom",
        input,
        inst
      };
    }
    return { ...iss };
  }
  const initializer = (inst, def) => {
    inst.name = "$ZodError";
    Object.defineProperty(inst, "_zod", {
      value: inst._zod,
      enumerable: false
    });
    Object.defineProperty(inst, "issues", {
      value: def,
      enumerable: false
    });
    inst.message = JSON.stringify(def, jsonStringifyReplacer, 2);
    Object.defineProperty(inst, "toString", {
      value: () => inst.message,
      enumerable: false
    });
  };
  const $ZodError = $constructor("$ZodError", initializer);
  const $ZodRealError = $constructor("$ZodError", initializer, { Parent: Error });
  const _parse = (_Err) => (schema, value, _ctx, _params) => {
    const ctx = _ctx ? { ..._ctx, async: false } : { async: false };
    const result2 = schema._zod.run({ value, issues: [] }, ctx);
    if (result2 instanceof Promise) {
      throw new $ZodAsyncError();
    }
    if (result2.issues.length) {
      const e = new (_params?.Err ?? _Err)(result2.issues.map((iss) => finalizeIssue(iss, ctx, config())));
      captureStackTrace(e, _params?.callee);
      throw e;
    }
    return result2.value;
  };
  const parse = /* @__PURE__ */ _parse($ZodRealError);
  const _parseAsync = (_Err) => async (schema, value, _ctx, params) => {
    const ctx = _ctx ? { ..._ctx, async: true } : { async: true };
    let result2 = schema._zod.run({ value, issues: [] }, ctx);
    if (result2 instanceof Promise)
      result2 = await result2;
    if (result2.issues.length) {
      const e = new (params?.Err ?? _Err)(result2.issues.map((iss) => finalizeIssue(iss, ctx, config())));
      captureStackTrace(e, params?.callee);
      throw e;
    }
    return result2.value;
  };
  const parseAsync = /* @__PURE__ */ _parseAsync($ZodRealError);
  const _safeParse = (_Err) => (schema, value, _ctx) => {
    const ctx = _ctx ? { ..._ctx, async: false } : { async: false };
    const result2 = schema._zod.run({ value, issues: [] }, ctx);
    if (result2 instanceof Promise) {
      throw new $ZodAsyncError();
    }
    return result2.issues.length ? {
      success: false,
      error: new (_Err ?? $ZodError)(result2.issues.map((iss) => finalizeIssue(iss, ctx, config())))
    } : { success: true, data: result2.value };
  };
  const safeParse = /* @__PURE__ */ _safeParse($ZodRealError);
  const _safeParseAsync = (_Err) => async (schema, value, _ctx) => {
    const ctx = _ctx ? { ..._ctx, async: true } : { async: true };
    let result2 = schema._zod.run({ value, issues: [] }, ctx);
    if (result2 instanceof Promise)
      result2 = await result2;
    return result2.issues.length ? {
      success: false,
      error: new _Err(result2.issues.map((iss) => finalizeIssue(iss, ctx, config())))
    } : { success: true, data: result2.value };
  };
  const safeParseAsync = /* @__PURE__ */ _safeParseAsync($ZodRealError);
  const base64$2 = /^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$/;
  const httpProtocol = /^https?$/;
  const string$1 = (params) => {
    const regex = params ? `[\\s\\S]{${params?.minimum ?? 0},${params?.maximum ?? ""}}` : `[\\s\\S]*`;
    return new RegExp(`^${regex}$`);
  };
  const bigint$1 = /^-?\d+n?$/;
  const integer = /^-?\d+$/;
  const number$1 = /^-?\d+(?:\.\d+)?$/;
  const boolean$1 = /^(?:true|false)$/i;
  const _null$2 = /^null$/i;
  const _undefined$2 = /^undefined$/i;
  const $ZodCheck = /* @__PURE__ */ $constructor("$ZodCheck", (inst, def) => {
    var _a2;
    inst._zod ?? (inst._zod = {});
    inst._zod.def = def;
    (_a2 = inst._zod).onattach ?? (_a2.onattach = []);
  });
  const numericOriginMap = {
    number: "number",
    bigint: "bigint",
    object: "date"
  };
  const $ZodCheckGreaterThan = /* @__PURE__ */ $constructor("$ZodCheckGreaterThan", (inst, def) => {
    $ZodCheck.init(inst, def);
    const origin = numericOriginMap[typeof def.value];
    inst._zod.onattach.push((inst2) => {
      const bag = inst2._zod.bag;
      const curr = (def.inclusive ? bag.minimum : bag.exclusiveMinimum) ?? Number.NEGATIVE_INFINITY;
      if (def.value > curr) {
        if (def.inclusive)
          bag.minimum = def.value;
        else
          bag.exclusiveMinimum = def.value;
      }
    });
    inst._zod.check = (payload) => {
      if (def.inclusive ? payload.value >= def.value : payload.value > def.value) {
        return;
      }
      payload.issues.push({
        origin,
        code: "too_small",
        minimum: typeof def.value === "object" ? def.value.getTime() : def.value,
        input: payload.value,
        inclusive: def.inclusive,
        inst,
        continue: !def.abort
      });
    };
  });
  const $ZodCheckNumberFormat = /* @__PURE__ */ $constructor("$ZodCheckNumberFormat", (inst, def) => {
    $ZodCheck.init(inst, def);
    def.format = def.format || "float64";
    const isInt = def.format?.includes("int");
    const origin = isInt ? "int" : "number";
    const [minimum, maximum] = NUMBER_FORMAT_RANGES[def.format];
    inst._zod.onattach.push((inst2) => {
      const bag = inst2._zod.bag;
      bag.format = def.format;
      bag.minimum = minimum;
      bag.maximum = maximum;
      if (isInt)
        bag.pattern = integer;
    });
    inst._zod.check = (payload) => {
      const input = payload.value;
      if (isInt) {
        if (!Number.isInteger(input)) {
          payload.issues.push({
            expected: origin,
            format: def.format,
            code: "invalid_type",
            continue: false,
            input,
            inst
          });
          return;
        }
        if (!Number.isSafeInteger(input)) {
          if (input > 0) {
            payload.issues.push({
              input,
              code: "too_big",
              maximum: Number.MAX_SAFE_INTEGER,
              note: "Integers must be within the safe integer range.",
              inst,
              origin,
              inclusive: true,
              continue: !def.abort
            });
          } else {
            payload.issues.push({
              input,
              code: "too_small",
              minimum: Number.MIN_SAFE_INTEGER,
              note: "Integers must be within the safe integer range.",
              inst,
              origin,
              inclusive: true,
              continue: !def.abort
            });
          }
          return;
        }
      }
      if (input < minimum) {
        payload.issues.push({
          origin: "number",
          input,
          code: "too_small",
          minimum,
          inclusive: true,
          inst,
          continue: !def.abort
        });
      }
      if (input > maximum) {
        payload.issues.push({
          origin: "number",
          input,
          code: "too_big",
          maximum,
          inclusive: true,
          inst,
          continue: !def.abort
        });
      }
    };
  });
  const $ZodCheckMaxLength = /* @__PURE__ */ $constructor("$ZodCheckMaxLength", (inst, def) => {
    var _a2;
    $ZodCheck.init(inst, def);
    (_a2 = inst._zod.def).when ?? (_a2.when = (payload) => {
      const val = payload.value;
      return !nullish(val) && val.length !== void 0;
    });
    inst._zod.onattach.push((inst2) => {
      const curr = inst2._zod.bag.maximum ?? Number.POSITIVE_INFINITY;
      if (def.maximum < curr)
        inst2._zod.bag.maximum = def.maximum;
    });
    inst._zod.check = (payload) => {
      const input = payload.value;
      const length = input.length;
      if (length <= def.maximum)
        return;
      const origin = getLengthableOrigin(input);
      payload.issues.push({
        origin,
        code: "too_big",
        maximum: def.maximum,
        inclusive: true,
        input,
        inst,
        continue: !def.abort
      });
    };
  });
  const $ZodCheckMinLength = /* @__PURE__ */ $constructor("$ZodCheckMinLength", (inst, def) => {
    var _a2;
    $ZodCheck.init(inst, def);
    (_a2 = inst._zod.def).when ?? (_a2.when = (payload) => {
      const val = payload.value;
      return !nullish(val) && val.length !== void 0;
    });
    inst._zod.onattach.push((inst2) => {
      const curr = inst2._zod.bag.minimum ?? Number.NEGATIVE_INFINITY;
      if (def.minimum > curr)
        inst2._zod.bag.minimum = def.minimum;
    });
    inst._zod.check = (payload) => {
      const input = payload.value;
      const length = input.length;
      if (length >= def.minimum)
        return;
      const origin = getLengthableOrigin(input);
      payload.issues.push({
        origin,
        code: "too_small",
        minimum: def.minimum,
        inclusive: true,
        input,
        inst,
        continue: !def.abort
      });
    };
  });
  const $ZodCheckLengthEquals = /* @__PURE__ */ $constructor("$ZodCheckLengthEquals", (inst, def) => {
    var _a2;
    $ZodCheck.init(inst, def);
    (_a2 = inst._zod.def).when ?? (_a2.when = (payload) => {
      const val = payload.value;
      return !nullish(val) && val.length !== void 0;
    });
    inst._zod.onattach.push((inst2) => {
      const bag = inst2._zod.bag;
      bag.minimum = def.length;
      bag.maximum = def.length;
      bag.length = def.length;
    });
    inst._zod.check = (payload) => {
      const input = payload.value;
      const length = input.length;
      if (length === def.length)
        return;
      const origin = getLengthableOrigin(input);
      const tooBig = length > def.length;
      payload.issues.push({
        origin,
        ...tooBig ? { code: "too_big", maximum: def.length } : { code: "too_small", minimum: def.length },
        inclusive: true,
        exact: true,
        input: payload.value,
        inst,
        continue: !def.abort
      });
    };
  });
  const $ZodCheckStringFormat = /* @__PURE__ */ $constructor("$ZodCheckStringFormat", (inst, def) => {
    var _a2, _b2;
    $ZodCheck.init(inst, def);
    inst._zod.onattach.push((inst2) => {
      const bag = inst2._zod.bag;
      bag.format = def.format;
      if (def.pattern) {
        bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
        bag.patterns.add(def.pattern);
      }
    });
    if (def.pattern)
      (_a2 = inst._zod).check ?? (_a2.check = (payload) => {
        def.pattern.lastIndex = 0;
        if (def.pattern.test(payload.value))
          return;
        payload.issues.push({
          origin: "string",
          code: "invalid_format",
          format: def.format,
          input: payload.value,
          ...def.pattern ? { pattern: def.pattern.toString() } : {},
          inst,
          continue: !def.abort
        });
      });
    else
      (_b2 = inst._zod).check ?? (_b2.check = () => {
      });
  });
  const $ZodCheckRegex = /* @__PURE__ */ $constructor("$ZodCheckRegex", (inst, def) => {
    $ZodCheckStringFormat.init(inst, def);
    inst._zod.check = (payload) => {
      def.pattern.lastIndex = 0;
      if (def.pattern.test(payload.value))
        return;
      payload.issues.push({
        origin: "string",
        code: "invalid_format",
        format: "regex",
        input: payload.value,
        pattern: def.pattern.toString(),
        inst,
        continue: !def.abort
      });
    };
  });
  const version = {
    major: 4,
    minor: 4,
    patch: 3
  };
  const $ZodType = /* @__PURE__ */ $constructor("$ZodType", (inst, def) => {
    var _a2;
    inst ?? (inst = {});
    inst._zod.def = def;
    inst._zod.bag = inst._zod.bag || {};
    inst._zod.version = version;
    const checks = [...inst._zod.def.checks ?? []];
    if (inst._zod.traits.has("$ZodCheck")) {
      checks.unshift(inst);
    }
    for (const ch of checks) {
      for (const fn of ch._zod.onattach) {
        fn(inst);
      }
    }
    if (checks.length === 0) {
      (_a2 = inst._zod).deferred ?? (_a2.deferred = []);
      inst._zod.deferred?.push(() => {
        inst._zod.run = inst._zod.parse;
      });
    } else {
      const runChecks = (payload, checks2, ctx) => {
        let isAborted = aborted(payload);
        let asyncResult;
        for (const ch of checks2) {
          if (ch._zod.def.when) {
            if (explicitlyAborted(payload))
              continue;
            const shouldRun = ch._zod.def.when(payload);
            if (!shouldRun)
              continue;
          } else if (isAborted) {
            continue;
          }
          const currLen = payload.issues.length;
          const _ = ch._zod.check(payload);
          if (_ instanceof Promise && ctx?.async === false) {
            throw new $ZodAsyncError();
          }
          if (asyncResult || _ instanceof Promise) {
            asyncResult = (asyncResult ?? Promise.resolve()).then(async () => {
              await _;
              const nextLen = payload.issues.length;
              if (nextLen === currLen)
                return;
              if (!isAborted)
                isAborted = aborted(payload, currLen);
            });
          } else {
            const nextLen = payload.issues.length;
            if (nextLen === currLen)
              continue;
            if (!isAborted)
              isAborted = aborted(payload, currLen);
          }
        }
        if (asyncResult) {
          return asyncResult.then(() => {
            return payload;
          });
        }
        return payload;
      };
      const handleCanaryResult = (canary, payload, ctx) => {
        if (aborted(canary)) {
          canary.aborted = true;
          return canary;
        }
        const checkResult = runChecks(payload, checks, ctx);
        if (checkResult instanceof Promise) {
          if (ctx.async === false)
            throw new $ZodAsyncError();
          return checkResult.then((checkResult2) => inst._zod.parse(checkResult2, ctx));
        }
        return inst._zod.parse(checkResult, ctx);
      };
      inst._zod.run = (payload, ctx) => {
        if (ctx.skipChecks) {
          return inst._zod.parse(payload, ctx);
        }
        if (ctx.direction === "backward") {
          const canary = inst._zod.parse({ value: payload.value, issues: [] }, { ...ctx, skipChecks: true });
          if (canary instanceof Promise) {
            return canary.then((canary2) => {
              return handleCanaryResult(canary2, payload, ctx);
            });
          }
          return handleCanaryResult(canary, payload, ctx);
        }
        const result2 = inst._zod.parse(payload, ctx);
        if (result2 instanceof Promise) {
          if (ctx.async === false)
            throw new $ZodAsyncError();
          return result2.then((result3) => runChecks(result3, checks, ctx));
        }
        return runChecks(result2, checks, ctx);
      };
    }
    defineLazy(inst, "~standard", () => ({
      validate: (value) => {
        try {
          const r = safeParse(inst, value);
          return r.success ? { value: r.data } : { issues: r.error?.issues };
        } catch (_) {
          return safeParseAsync(inst, value).then((r) => r.success ? { value: r.data } : { issues: r.error?.issues });
        }
      },
      vendor: "zod",
      version: 1
    }));
  });
  const $ZodString = /* @__PURE__ */ $constructor("$ZodString", (inst, def) => {
    $ZodType.init(inst, def);
    inst._zod.pattern = [...inst?._zod.bag?.patterns ?? []].pop() ?? string$1(inst._zod.bag);
    inst._zod.parse = (payload, _) => {
      if (def.coerce)
        try {
          payload.value = String(payload.value);
        } catch (_2) {
        }
      if (typeof payload.value === "string")
        return payload;
      payload.issues.push({
        expected: "string",
        code: "invalid_type",
        input: payload.value,
        inst
      });
      return payload;
    };
  });
  const $ZodStringFormat = /* @__PURE__ */ $constructor("$ZodStringFormat", (inst, def) => {
    $ZodCheckStringFormat.init(inst, def);
    $ZodString.init(inst, def);
  });
  const $ZodURL = /* @__PURE__ */ $constructor("$ZodURL", (inst, def) => {
    $ZodStringFormat.init(inst, def);
    inst._zod.check = (payload) => {
      try {
        const trimmed = payload.value.trim();
        if (!def.normalize && def.protocol?.source === httpProtocol.source) {
          if (!/^https?:\/\//i.test(trimmed)) {
            payload.issues.push({
              code: "invalid_format",
              format: "url",
              note: "Invalid URL format",
              input: payload.value,
              inst,
              continue: !def.abort
            });
            return;
          }
        }
        const url2 = new URL(trimmed);
        if (def.hostname) {
          def.hostname.lastIndex = 0;
          if (!def.hostname.test(url2.hostname)) {
            payload.issues.push({
              code: "invalid_format",
              format: "url",
              note: "Invalid hostname",
              pattern: def.hostname.source,
              input: payload.value,
              inst,
              continue: !def.abort
            });
          }
        }
        if (def.protocol) {
          def.protocol.lastIndex = 0;
          if (!def.protocol.test(url2.protocol.endsWith(":") ? url2.protocol.slice(0, -1) : url2.protocol)) {
            payload.issues.push({
              code: "invalid_format",
              format: "url",
              note: "Invalid protocol",
              pattern: def.protocol.source,
              input: payload.value,
              inst,
              continue: !def.abort
            });
          }
        }
        if (def.normalize) {
          payload.value = url2.href;
        } else {
          payload.value = trimmed;
        }
        return;
      } catch (_) {
        payload.issues.push({
          code: "invalid_format",
          format: "url",
          input: payload.value,
          inst,
          continue: !def.abort
        });
      }
    };
  });
  function isValidBase64(data) {
    if (data === "")
      return true;
    if (/\s/.test(data))
      return false;
    if (data.length % 4 !== 0)
      return false;
    try {
      atob(data);
      return true;
    } catch {
      return false;
    }
  }
  const $ZodBase64 = /* @__PURE__ */ $constructor("$ZodBase64", (inst, def) => {
    def.pattern ?? (def.pattern = base64$2);
    $ZodStringFormat.init(inst, def);
    inst._zod.bag.contentEncoding = "base64";
    inst._zod.check = (payload) => {
      if (isValidBase64(payload.value))
        return;
      payload.issues.push({
        code: "invalid_format",
        format: "base64",
        input: payload.value,
        inst,
        continue: !def.abort
      });
    };
  });
  const $ZodNumber = /* @__PURE__ */ $constructor("$ZodNumber", (inst, def) => {
    $ZodType.init(inst, def);
    inst._zod.pattern = inst._zod.bag.pattern ?? number$1;
    inst._zod.parse = (payload, _ctx) => {
      if (def.coerce)
        try {
          payload.value = Number(payload.value);
        } catch (_) {
        }
      const input = payload.value;
      if (typeof input === "number" && !Number.isNaN(input) && Number.isFinite(input)) {
        return payload;
      }
      const received = typeof input === "number" ? Number.isNaN(input) ? "NaN" : !Number.isFinite(input) ? "Infinity" : void 0 : void 0;
      payload.issues.push({
        expected: "number",
        code: "invalid_type",
        input,
        inst,
        ...received ? { received } : {}
      });
      return payload;
    };
  });
  const $ZodNumberFormat = /* @__PURE__ */ $constructor("$ZodNumberFormat", (inst, def) => {
    $ZodCheckNumberFormat.init(inst, def);
    $ZodNumber.init(inst, def);
  });
  const $ZodBoolean = /* @__PURE__ */ $constructor("$ZodBoolean", (inst, def) => {
    $ZodType.init(inst, def);
    inst._zod.pattern = boolean$1;
    inst._zod.parse = (payload, _ctx) => {
      if (def.coerce)
        try {
          payload.value = Boolean(payload.value);
        } catch (_) {
        }
      const input = payload.value;
      if (typeof input === "boolean")
        return payload;
      payload.issues.push({
        expected: "boolean",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    };
  });
  const $ZodBigInt = /* @__PURE__ */ $constructor("$ZodBigInt", (inst, def) => {
    $ZodType.init(inst, def);
    inst._zod.pattern = bigint$1;
    inst._zod.parse = (payload, _ctx) => {
      if (def.coerce)
        try {
          payload.value = BigInt(payload.value);
        } catch (_) {
        }
      if (typeof payload.value === "bigint")
        return payload;
      payload.issues.push({
        expected: "bigint",
        code: "invalid_type",
        input: payload.value,
        inst
      });
      return payload;
    };
  });
  const $ZodUndefined = /* @__PURE__ */ $constructor("$ZodUndefined", (inst, def) => {
    $ZodType.init(inst, def);
    inst._zod.pattern = _undefined$2;
    inst._zod.values = /* @__PURE__ */ new Set([void 0]);
    inst._zod.parse = (payload, _ctx) => {
      const input = payload.value;
      if (typeof input === "undefined")
        return payload;
      payload.issues.push({
        expected: "undefined",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    };
  });
  const $ZodNull = /* @__PURE__ */ $constructor("$ZodNull", (inst, def) => {
    $ZodType.init(inst, def);
    inst._zod.pattern = _null$2;
    inst._zod.values = /* @__PURE__ */ new Set([null]);
    inst._zod.parse = (payload, _ctx) => {
      const input = payload.value;
      if (input === null)
        return payload;
      payload.issues.push({
        expected: "null",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    };
  });
  const $ZodUnknown = /* @__PURE__ */ $constructor("$ZodUnknown", (inst, def) => {
    $ZodType.init(inst, def);
    inst._zod.parse = (payload) => payload;
  });
  const $ZodNever = /* @__PURE__ */ $constructor("$ZodNever", (inst, def) => {
    $ZodType.init(inst, def);
    inst._zod.parse = (payload, _ctx) => {
      payload.issues.push({
        expected: "never",
        code: "invalid_type",
        input: payload.value,
        inst
      });
      return payload;
    };
  });
  function handleArrayResult(result2, final, index) {
    if (result2.issues.length) {
      final.issues.push(...prefixIssues(index, result2.issues));
    }
    final.value[index] = result2.value;
  }
  const $ZodArray = /* @__PURE__ */ $constructor("$ZodArray", (inst, def) => {
    $ZodType.init(inst, def);
    inst._zod.parse = (payload, ctx) => {
      const input = payload.value;
      if (!Array.isArray(input)) {
        payload.issues.push({
          expected: "array",
          code: "invalid_type",
          input,
          inst
        });
        return payload;
      }
      payload.value = Array(input.length);
      const proms = [];
      for (let i = 0; i < input.length; i++) {
        const item = input[i];
        const result2 = def.element._zod.run({
          value: item,
          issues: []
        }, ctx);
        if (result2 instanceof Promise) {
          proms.push(result2.then((result3) => handleArrayResult(result3, payload, i)));
        } else {
          handleArrayResult(result2, payload, i);
        }
      }
      if (proms.length) {
        return Promise.all(proms).then(() => payload);
      }
      return payload;
    };
  });
  function handlePropertyResult(result2, final, key, input, isOptionalIn, isOptionalOut) {
    const isPresent = key in input;
    if (result2.issues.length) {
      if (isOptionalIn && isOptionalOut && !isPresent) {
        return;
      }
      final.issues.push(...prefixIssues(key, result2.issues));
    }
    if (!isPresent && !isOptionalIn) {
      if (!result2.issues.length) {
        final.issues.push({
          code: "invalid_type",
          expected: "nonoptional",
          input: void 0,
          path: [key]
        });
      }
      return;
    }
    if (result2.value === void 0) {
      if (isPresent) {
        final.value[key] = void 0;
      }
    } else {
      final.value[key] = result2.value;
    }
  }
  function normalizeDef(def) {
    const keys2 = Object.keys(def.shape);
    for (const k of keys2) {
      if (!def.shape?.[k]?._zod?.traits?.has("$ZodType")) {
        throw new Error(`Invalid element at key "${k}": expected a Zod schema`);
      }
    }
    const okeys = optionalKeys(def.shape);
    return {
      ...def,
      keys: keys2,
      keySet: new Set(keys2),
      numKeys: keys2.length,
      optionalKeys: new Set(okeys)
    };
  }
  function handleCatchall(proms, input, payload, ctx, def, inst) {
    const unrecognized = [];
    const keySet = def.keySet;
    const _catchall = def.catchall._zod;
    const t = _catchall.def.type;
    const isOptionalIn = _catchall.optin === "optional";
    const isOptionalOut = _catchall.optout === "optional";
    for (const key in input) {
      if (key === "__proto__")
        continue;
      if (keySet.has(key))
        continue;
      if (t === "never") {
        unrecognized.push(key);
        continue;
      }
      const r = _catchall.run({ value: input[key], issues: [] }, ctx);
      if (r instanceof Promise) {
        proms.push(r.then((r2) => handlePropertyResult(r2, payload, key, input, isOptionalIn, isOptionalOut)));
      } else {
        handlePropertyResult(r, payload, key, input, isOptionalIn, isOptionalOut);
      }
    }
    if (unrecognized.length) {
      payload.issues.push({
        code: "unrecognized_keys",
        keys: unrecognized,
        input,
        inst
      });
    }
    if (!proms.length)
      return payload;
    return Promise.all(proms).then(() => {
      return payload;
    });
  }
  const $ZodObject = /* @__PURE__ */ $constructor("$ZodObject", (inst, def) => {
    $ZodType.init(inst, def);
    const desc = Object.getOwnPropertyDescriptor(def, "shape");
    if (!desc?.get) {
      const sh = def.shape;
      Object.defineProperty(def, "shape", {
        get: () => {
          const newSh = { ...sh };
          Object.defineProperty(def, "shape", {
            value: newSh
          });
          return newSh;
        }
      });
    }
    const _normalized = cached(() => normalizeDef(def));
    defineLazy(inst._zod, "propValues", () => {
      const shape = def.shape;
      const propValues = {};
      for (const key in shape) {
        const field = shape[key]._zod;
        if (field.values) {
          propValues[key] ?? (propValues[key] = /* @__PURE__ */ new Set());
          for (const v of field.values)
            propValues[key].add(v);
        }
      }
      return propValues;
    });
    const isObject2 = isObject$1;
    const catchall = def.catchall;
    let value;
    inst._zod.parse = (payload, ctx) => {
      value ?? (value = _normalized.value);
      const input = payload.value;
      if (!isObject2(input)) {
        payload.issues.push({
          expected: "object",
          code: "invalid_type",
          input,
          inst
        });
        return payload;
      }
      payload.value = {};
      const proms = [];
      const shape = value.shape;
      for (const key of value.keys) {
        const el = shape[key];
        const isOptionalIn = el._zod.optin === "optional";
        const isOptionalOut = el._zod.optout === "optional";
        const r = el._zod.run({ value: input[key], issues: [] }, ctx);
        if (r instanceof Promise) {
          proms.push(r.then((r2) => handlePropertyResult(r2, payload, key, input, isOptionalIn, isOptionalOut)));
        } else {
          handlePropertyResult(r, payload, key, input, isOptionalIn, isOptionalOut);
        }
      }
      if (!catchall) {
        return proms.length ? Promise.all(proms).then(() => payload) : payload;
      }
      return handleCatchall(proms, input, payload, ctx, _normalized.value, inst);
    };
  });
  function handleUnionResults(results, final, inst, ctx) {
    for (const result2 of results) {
      if (result2.issues.length === 0) {
        final.value = result2.value;
        return final;
      }
    }
    const nonaborted = results.filter((r) => !aborted(r));
    if (nonaborted.length === 1) {
      final.value = nonaborted[0].value;
      return nonaborted[0];
    }
    final.issues.push({
      code: "invalid_union",
      input: final.value,
      inst,
      errors: results.map((result2) => result2.issues.map((iss) => finalizeIssue(iss, ctx, config())))
    });
    return final;
  }
  const $ZodUnion = /* @__PURE__ */ $constructor("$ZodUnion", (inst, def) => {
    $ZodType.init(inst, def);
    defineLazy(inst._zod, "optin", () => def.options.some((o) => o._zod.optin === "optional") ? "optional" : void 0);
    defineLazy(inst._zod, "optout", () => def.options.some((o) => o._zod.optout === "optional") ? "optional" : void 0);
    defineLazy(inst._zod, "values", () => {
      if (def.options.every((o) => o._zod.values)) {
        return new Set(def.options.flatMap((option) => Array.from(option._zod.values)));
      }
      return void 0;
    });
    defineLazy(inst._zod, "pattern", () => {
      if (def.options.every((o) => o._zod.pattern)) {
        const patterns = def.options.map((o) => o._zod.pattern);
        return new RegExp(`^(${patterns.map((p) => cleanRegex(p.source)).join("|")})$`);
      }
      return void 0;
    });
    const first = def.options.length === 1 ? def.options[0]._zod.run : null;
    inst._zod.parse = (payload, ctx) => {
      if (first) {
        return first(payload, ctx);
      }
      let async = false;
      const results = [];
      for (const option of def.options) {
        const result2 = option._zod.run({
          value: payload.value,
          issues: []
        }, ctx);
        if (result2 instanceof Promise) {
          results.push(result2);
          async = true;
        } else {
          if (result2.issues.length === 0)
            return result2;
          results.push(result2);
        }
      }
      if (!async)
        return handleUnionResults(results, payload, inst, ctx);
      return Promise.all(results).then((results2) => {
        return handleUnionResults(results2, payload, inst, ctx);
      });
    };
  });
  const $ZodDiscriminatedUnion = /* @__PURE__ */ $constructor("$ZodDiscriminatedUnion", (inst, def) => {
    def.inclusive = false;
    $ZodUnion.init(inst, def);
    const _super = inst._zod.parse;
    defineLazy(inst._zod, "propValues", () => {
      const propValues = {};
      for (const option of def.options) {
        const pv = option._zod.propValues;
        if (!pv || Object.keys(pv).length === 0)
          throw new Error(`Invalid discriminated union option at index "${def.options.indexOf(option)}"`);
        for (const [k, v] of Object.entries(pv)) {
          if (!propValues[k])
            propValues[k] = /* @__PURE__ */ new Set();
          for (const val of v) {
            propValues[k].add(val);
          }
        }
      }
      return propValues;
    });
    const disc = cached(() => {
      const opts = def.options;
      const map = /* @__PURE__ */ new Map();
      for (const o of opts) {
        const values = o._zod.propValues?.[def.discriminator];
        if (!values || values.size === 0)
          throw new Error(`Invalid discriminated union option at index "${def.options.indexOf(o)}"`);
        for (const v of values) {
          if (map.has(v)) {
            throw new Error(`Duplicate discriminator value "${String(v)}"`);
          }
          map.set(v, o);
        }
      }
      return map;
    });
    inst._zod.parse = (payload, ctx) => {
      const input = payload.value;
      if (!isObject$1(input)) {
        payload.issues.push({
          code: "invalid_type",
          expected: "object",
          input,
          inst
        });
        return payload;
      }
      const opt = disc.value.get(input?.[def.discriminator]);
      if (opt) {
        return opt._zod.run(payload, ctx);
      }
      if (def.unionFallback || ctx.direction === "backward") {
        return _super(payload, ctx);
      }
      payload.issues.push({
        code: "invalid_union",
        errors: [],
        note: "No matching discriminator",
        discriminator: def.discriminator,
        options: Array.from(disc.value.keys()),
        input,
        path: [def.discriminator],
        inst
      });
      return payload;
    };
  });
  const $ZodIntersection = /* @__PURE__ */ $constructor("$ZodIntersection", (inst, def) => {
    $ZodType.init(inst, def);
    inst._zod.parse = (payload, ctx) => {
      const input = payload.value;
      const left = def.left._zod.run({ value: input, issues: [] }, ctx);
      const right = def.right._zod.run({ value: input, issues: [] }, ctx);
      const async = left instanceof Promise || right instanceof Promise;
      if (async) {
        return Promise.all([left, right]).then(([left2, right2]) => {
          return handleIntersectionResults(payload, left2, right2);
        });
      }
      return handleIntersectionResults(payload, left, right);
    };
  });
  function mergeValues(a, b) {
    if (a === b) {
      return { valid: true, data: a };
    }
    if (a instanceof Date && b instanceof Date && +a === +b) {
      return { valid: true, data: a };
    }
    if (isPlainObject$1(a) && isPlainObject$1(b)) {
      const bKeys = Object.keys(b);
      const sharedKeys = Object.keys(a).filter((key) => bKeys.indexOf(key) !== -1);
      const newObj = { ...a, ...b };
      for (const key of sharedKeys) {
        const sharedValue = mergeValues(a[key], b[key]);
        if (!sharedValue.valid) {
          return {
            valid: false,
            mergeErrorPath: [key, ...sharedValue.mergeErrorPath]
          };
        }
        newObj[key] = sharedValue.data;
      }
      return { valid: true, data: newObj };
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) {
        return { valid: false, mergeErrorPath: [] };
      }
      const newArray = [];
      for (let index = 0; index < a.length; index++) {
        const itemA = a[index];
        const itemB = b[index];
        const sharedValue = mergeValues(itemA, itemB);
        if (!sharedValue.valid) {
          return {
            valid: false,
            mergeErrorPath: [index, ...sharedValue.mergeErrorPath]
          };
        }
        newArray.push(sharedValue.data);
      }
      return { valid: true, data: newArray };
    }
    return { valid: false, mergeErrorPath: [] };
  }
  function handleIntersectionResults(result2, left, right) {
    const unrecKeys = /* @__PURE__ */ new Map();
    let unrecIssue;
    for (const iss of left.issues) {
      if (iss.code === "unrecognized_keys") {
        unrecIssue ?? (unrecIssue = iss);
        for (const k of iss.keys) {
          if (!unrecKeys.has(k))
            unrecKeys.set(k, {});
          unrecKeys.get(k).l = true;
        }
      } else {
        result2.issues.push(iss);
      }
    }
    for (const iss of right.issues) {
      if (iss.code === "unrecognized_keys") {
        for (const k of iss.keys) {
          if (!unrecKeys.has(k))
            unrecKeys.set(k, {});
          unrecKeys.get(k).r = true;
        }
      } else {
        result2.issues.push(iss);
      }
    }
    const bothKeys = [...unrecKeys].filter(([, f]) => f.l && f.r).map(([k]) => k);
    if (bothKeys.length && unrecIssue) {
      result2.issues.push({ ...unrecIssue, keys: bothKeys });
    }
    if (aborted(result2))
      return result2;
    const merged = mergeValues(left.value, right.value);
    if (!merged.valid) {
      throw new Error(`Unmergable intersection. Error path: ${JSON.stringify(merged.mergeErrorPath)}`);
    }
    result2.value = merged.data;
    return result2;
  }
  const $ZodTuple = /* @__PURE__ */ $constructor("$ZodTuple", (inst, def) => {
    $ZodType.init(inst, def);
    const items = def.items;
    inst._zod.parse = (payload, ctx) => {
      const input = payload.value;
      if (!Array.isArray(input)) {
        payload.issues.push({
          input,
          inst,
          expected: "tuple",
          code: "invalid_type"
        });
        return payload;
      }
      payload.value = [];
      const proms = [];
      const optinStart = getTupleOptStart(items, "optin");
      const optoutStart = getTupleOptStart(items, "optout");
      if (!def.rest) {
        if (input.length < optinStart) {
          payload.issues.push({
            code: "too_small",
            minimum: optinStart,
            inclusive: true,
            input,
            inst,
            origin: "array"
          });
          return payload;
        }
        if (input.length > items.length) {
          payload.issues.push({
            code: "too_big",
            maximum: items.length,
            inclusive: true,
            input,
            inst,
            origin: "array"
          });
        }
      }
      const itemResults = new Array(items.length);
      for (let i = 0; i < items.length; i++) {
        const r = items[i]._zod.run({ value: input[i], issues: [] }, ctx);
        if (r instanceof Promise) {
          proms.push(r.then((rr) => {
            itemResults[i] = rr;
          }));
        } else {
          itemResults[i] = r;
        }
      }
      if (def.rest) {
        let i = items.length - 1;
        const rest = input.slice(items.length);
        for (const el of rest) {
          i++;
          const result2 = def.rest._zod.run({ value: el, issues: [] }, ctx);
          if (result2 instanceof Promise) {
            proms.push(result2.then((r) => handleTupleResult(r, payload, i)));
          } else {
            handleTupleResult(result2, payload, i);
          }
        }
      }
      if (proms.length) {
        return Promise.all(proms).then(() => handleTupleResults(itemResults, payload, items, input, optoutStart));
      }
      return handleTupleResults(itemResults, payload, items, input, optoutStart);
    };
  });
  function getTupleOptStart(items, key) {
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i]._zod[key] !== "optional")
        return i + 1;
    }
    return 0;
  }
  function handleTupleResult(result2, final, index) {
    if (result2.issues.length) {
      final.issues.push(...prefixIssues(index, result2.issues));
    }
    final.value[index] = result2.value;
  }
  function handleTupleResults(itemResults, final, items, input, optoutStart) {
    for (let i = 0; i < items.length; i++) {
      const r = itemResults[i];
      const isPresent = i < input.length;
      if (r.issues.length) {
        if (!isPresent && i >= optoutStart) {
          final.value.length = i;
          break;
        }
        final.issues.push(...prefixIssues(i, r.issues));
      }
      final.value[i] = r.value;
    }
    for (let i = final.value.length - 1; i >= input.length; i--) {
      if (items[i]._zod.optout === "optional" && final.value[i] === void 0) {
        final.value.length = i;
      } else {
        break;
      }
    }
    return final;
  }
  const $ZodRecord = /* @__PURE__ */ $constructor("$ZodRecord", (inst, def) => {
    $ZodType.init(inst, def);
    inst._zod.parse = (payload, ctx) => {
      const input = payload.value;
      if (!isPlainObject$1(input)) {
        payload.issues.push({
          expected: "record",
          code: "invalid_type",
          input,
          inst
        });
        return payload;
      }
      const proms = [];
      const values = def.keyType._zod.values;
      if (values) {
        payload.value = {};
        const recordKeys = /* @__PURE__ */ new Set();
        for (const key of values) {
          if (typeof key === "string" || typeof key === "number" || typeof key === "symbol") {
            recordKeys.add(typeof key === "number" ? key.toString() : key);
            const keyResult = def.keyType._zod.run({ value: key, issues: [] }, ctx);
            if (keyResult instanceof Promise) {
              throw new Error("Async schemas not supported in object keys currently");
            }
            if (keyResult.issues.length) {
              payload.issues.push({
                code: "invalid_key",
                origin: "record",
                issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config())),
                input: key,
                path: [key],
                inst
              });
              continue;
            }
            const outKey = keyResult.value;
            const result2 = def.valueType._zod.run({ value: input[key], issues: [] }, ctx);
            if (result2 instanceof Promise) {
              proms.push(result2.then((result3) => {
                if (result3.issues.length) {
                  payload.issues.push(...prefixIssues(key, result3.issues));
                }
                payload.value[outKey] = result3.value;
              }));
            } else {
              if (result2.issues.length) {
                payload.issues.push(...prefixIssues(key, result2.issues));
              }
              payload.value[outKey] = result2.value;
            }
          }
        }
        let unrecognized;
        for (const key in input) {
          if (!recordKeys.has(key)) {
            unrecognized = unrecognized ?? [];
            unrecognized.push(key);
          }
        }
        if (unrecognized && unrecognized.length > 0) {
          payload.issues.push({
            code: "unrecognized_keys",
            input,
            inst,
            keys: unrecognized
          });
        }
      } else {
        payload.value = {};
        for (const key of Reflect.ownKeys(input)) {
          if (key === "__proto__")
            continue;
          if (!Object.prototype.propertyIsEnumerable.call(input, key))
            continue;
          let keyResult = def.keyType._zod.run({ value: key, issues: [] }, ctx);
          if (keyResult instanceof Promise) {
            throw new Error("Async schemas not supported in object keys currently");
          }
          const checkNumericKey = typeof key === "string" && number$1.test(key) && keyResult.issues.length;
          if (checkNumericKey) {
            const retryResult = def.keyType._zod.run({ value: Number(key), issues: [] }, ctx);
            if (retryResult instanceof Promise) {
              throw new Error("Async schemas not supported in object keys currently");
            }
            if (retryResult.issues.length === 0) {
              keyResult = retryResult;
            }
          }
          if (keyResult.issues.length) {
            if (def.mode === "loose") {
              payload.value[key] = input[key];
            } else {
              payload.issues.push({
                code: "invalid_key",
                origin: "record",
                issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config())),
                input: key,
                path: [key],
                inst
              });
            }
            continue;
          }
          const result2 = def.valueType._zod.run({ value: input[key], issues: [] }, ctx);
          if (result2 instanceof Promise) {
            proms.push(result2.then((result3) => {
              if (result3.issues.length) {
                payload.issues.push(...prefixIssues(key, result3.issues));
              }
              payload.value[keyResult.value] = result3.value;
            }));
          } else {
            if (result2.issues.length) {
              payload.issues.push(...prefixIssues(key, result2.issues));
            }
            payload.value[keyResult.value] = result2.value;
          }
        }
      }
      if (proms.length) {
        return Promise.all(proms).then(() => payload);
      }
      return payload;
    };
  });
  const $ZodEnum = /* @__PURE__ */ $constructor("$ZodEnum", (inst, def) => {
    $ZodType.init(inst, def);
    const values = getEnumValues(def.entries);
    const valuesSet = new Set(values);
    inst._zod.values = valuesSet;
    inst._zod.pattern = new RegExp(`^(${values.filter((k) => propertyKeyTypes.has(typeof k)).map((o) => typeof o === "string" ? escapeRegex(o) : o.toString()).join("|")})$`);
    inst._zod.parse = (payload, _ctx) => {
      const input = payload.value;
      if (valuesSet.has(input)) {
        return payload;
      }
      payload.issues.push({
        code: "invalid_value",
        values,
        input,
        inst
      });
      return payload;
    };
  });
  const $ZodLiteral = /* @__PURE__ */ $constructor("$ZodLiteral", (inst, def) => {
    $ZodType.init(inst, def);
    if (def.values.length === 0) {
      throw new Error("Cannot create literal schema with no valid values");
    }
    const values = new Set(def.values);
    inst._zod.values = values;
    inst._zod.pattern = new RegExp(`^(${def.values.map((o) => typeof o === "string" ? escapeRegex(o) : o ? escapeRegex(o.toString()) : String(o)).join("|")})$`);
    inst._zod.parse = (payload, _ctx) => {
      const input = payload.value;
      if (values.has(input)) {
        return payload;
      }
      payload.issues.push({
        code: "invalid_value",
        values: def.values,
        input,
        inst
      });
      return payload;
    };
  });
  const $ZodTransform = /* @__PURE__ */ $constructor("$ZodTransform", (inst, def) => {
    $ZodType.init(inst, def);
    inst._zod.optin = "optional";
    inst._zod.parse = (payload, ctx) => {
      if (ctx.direction === "backward") {
        throw new $ZodEncodeError(inst.constructor.name);
      }
      const _out = def.transform(payload.value, payload);
      if (ctx.async) {
        const output = _out instanceof Promise ? _out : Promise.resolve(_out);
        return output.then((output2) => {
          payload.value = output2;
          payload.fallback = true;
          return payload;
        });
      }
      if (_out instanceof Promise) {
        throw new $ZodAsyncError();
      }
      payload.value = _out;
      payload.fallback = true;
      return payload;
    };
  });
  function handleOptionalResult(result2, input) {
    if (input === void 0 && (result2.issues.length || result2.fallback)) {
      return { issues: [], value: void 0 };
    }
    return result2;
  }
  const $ZodOptional = /* @__PURE__ */ $constructor("$ZodOptional", (inst, def) => {
    $ZodType.init(inst, def);
    inst._zod.optin = "optional";
    inst._zod.optout = "optional";
    defineLazy(inst._zod, "values", () => {
      return def.innerType._zod.values ? /* @__PURE__ */ new Set([...def.innerType._zod.values, void 0]) : void 0;
    });
    defineLazy(inst._zod, "pattern", () => {
      const pattern = def.innerType._zod.pattern;
      return pattern ? new RegExp(`^(${cleanRegex(pattern.source)})?$`) : void 0;
    });
    inst._zod.parse = (payload, ctx) => {
      if (def.innerType._zod.optin === "optional") {
        const input = payload.value;
        const result2 = def.innerType._zod.run(payload, ctx);
        if (result2 instanceof Promise)
          return result2.then((r) => handleOptionalResult(r, input));
        return handleOptionalResult(result2, input);
      }
      if (payload.value === void 0) {
        return payload;
      }
      return def.innerType._zod.run(payload, ctx);
    };
  });
  const $ZodPipe = /* @__PURE__ */ $constructor("$ZodPipe", (inst, def) => {
    $ZodType.init(inst, def);
    defineLazy(inst._zod, "values", () => def.in._zod.values);
    defineLazy(inst._zod, "optin", () => def.in._zod.optin);
    defineLazy(inst._zod, "optout", () => def.out._zod.optout);
    defineLazy(inst._zod, "propValues", () => def.in._zod.propValues);
    inst._zod.parse = (payload, ctx) => {
      if (ctx.direction === "backward") {
        const right = def.out._zod.run(payload, ctx);
        if (right instanceof Promise) {
          return right.then((right2) => handlePipeResult(right2, def.in, ctx));
        }
        return handlePipeResult(right, def.in, ctx);
      }
      const left = def.in._zod.run(payload, ctx);
      if (left instanceof Promise) {
        return left.then((left2) => handlePipeResult(left2, def.out, ctx));
      }
      return handlePipeResult(left, def.out, ctx);
    };
  });
  function handlePipeResult(left, next, ctx) {
    if (left.issues.length) {
      left.aborted = true;
      return left;
    }
    return next._zod.run({ value: left.value, issues: left.issues, fallback: left.fallback }, ctx);
  }
  const $ZodLazy = /* @__PURE__ */ $constructor("$ZodLazy", (inst, def) => {
    $ZodType.init(inst, def);
    defineLazy(inst._zod, "innerType", () => {
      const d = def;
      if (!d._cachedInner)
        d._cachedInner = def.getter();
      return d._cachedInner;
    });
    defineLazy(inst._zod, "pattern", () => inst._zod.innerType?._zod?.pattern);
    defineLazy(inst._zod, "propValues", () => inst._zod.innerType?._zod?.propValues);
    defineLazy(inst._zod, "optin", () => inst._zod.innerType?._zod?.optin ?? void 0);
    defineLazy(inst._zod, "optout", () => inst._zod.innerType?._zod?.optout ?? void 0);
    inst._zod.parse = (payload, ctx) => {
      const inner = inst._zod.innerType;
      return inner._zod.run(payload, ctx);
    };
  });
  const $ZodCustom = /* @__PURE__ */ $constructor("$ZodCustom", (inst, def) => {
    $ZodCheck.init(inst, def);
    $ZodType.init(inst, def);
    inst._zod.parse = (payload, _) => {
      return payload;
    };
    inst._zod.check = (payload) => {
      const input = payload.value;
      const r = def.fn(input);
      if (r instanceof Promise) {
        return r.then((r2) => handleRefineResult(r2, payload, input, inst));
      }
      handleRefineResult(r, payload, input, inst);
      return;
    };
  });
  function handleRefineResult(result2, payload, input, inst) {
    if (!result2) {
      const _iss = {
        code: "custom",
        input,
        inst,
        // incorporates params.error into issue reporting
        path: [...inst._zod.def.path ?? []],
        // incorporates params.error into issue reporting
        continue: !inst._zod.def.abort
        // params: inst._zod.def.params,
      };
      if (inst._zod.def.params)
        _iss.params = inst._zod.def.params;
      payload.issues.push(issue(_iss));
    }
  }
  // @__NO_SIDE_EFFECTS__
  function _string(Class, params) {
    return new Class({
      type: "string",
      ...normalizeParams(params)
    });
  }
  // @__NO_SIDE_EFFECTS__
  function _url(Class, params) {
    return new Class({
      type: "string",
      format: "url",
      check: "string_format",
      abort: false,
      ...normalizeParams(params)
    });
  }
  // @__NO_SIDE_EFFECTS__
  function _base64(Class, params) {
    return new Class({
      type: "string",
      format: "base64",
      check: "string_format",
      abort: false,
      ...normalizeParams(params)
    });
  }
  // @__NO_SIDE_EFFECTS__
  function _number(Class, params) {
    return new Class({
      type: "number",
      checks: [],
      ...normalizeParams(params)
    });
  }
  // @__NO_SIDE_EFFECTS__
  function _int(Class, params) {
    return new Class({
      type: "number",
      check: "number_format",
      abort: false,
      format: "safeint",
      ...normalizeParams(params)
    });
  }
  // @__NO_SIDE_EFFECTS__
  function _boolean(Class, params) {
    return new Class({
      type: "boolean",
      ...normalizeParams(params)
    });
  }
  // @__NO_SIDE_EFFECTS__
  function _bigint(Class, params) {
    return new Class({
      type: "bigint",
      ...normalizeParams(params)
    });
  }
  // @__NO_SIDE_EFFECTS__
  function _undefined$1(Class, params) {
    return new Class({
      type: "undefined",
      ...normalizeParams(params)
    });
  }
  // @__NO_SIDE_EFFECTS__
  function _null$1(Class, params) {
    return new Class({
      type: "null",
      ...normalizeParams(params)
    });
  }
  // @__NO_SIDE_EFFECTS__
  function _unknown(Class) {
    return new Class({
      type: "unknown"
    });
  }
  // @__NO_SIDE_EFFECTS__
  function _never(Class, params) {
    return new Class({
      type: "never",
      ...normalizeParams(params)
    });
  }
  // @__NO_SIDE_EFFECTS__
  function _gte(value, params) {
    return new $ZodCheckGreaterThan({
      check: "greater_than",
      ...normalizeParams(params),
      value,
      inclusive: true
    });
  }
  // @__NO_SIDE_EFFECTS__
  function _nonnegative(params) {
    return /* @__PURE__ */ _gte(0, params);
  }
  // @__NO_SIDE_EFFECTS__
  function _maxLength(maximum, params) {
    const ch = new $ZodCheckMaxLength({
      check: "max_length",
      ...normalizeParams(params),
      maximum
    });
    return ch;
  }
  // @__NO_SIDE_EFFECTS__
  function _minLength(minimum, params) {
    return new $ZodCheckMinLength({
      check: "min_length",
      ...normalizeParams(params),
      minimum
    });
  }
  // @__NO_SIDE_EFFECTS__
  function _length(length, params) {
    return new $ZodCheckLengthEquals({
      check: "length_equals",
      ...normalizeParams(params),
      length
    });
  }
  // @__NO_SIDE_EFFECTS__
  function _regex(pattern, params) {
    return new $ZodCheckRegex({
      check: "string_format",
      format: "regex",
      ...normalizeParams(params),
      pattern
    });
  }
  // @__NO_SIDE_EFFECTS__
  function _custom(Class, fn, _params) {
    const norm = normalizeParams(_params);
    norm.abort ?? (norm.abort = true);
    const schema = new Class({
      type: "custom",
      check: "custom",
      fn,
      ...norm
    });
    return schema;
  }
  // @__NO_SIDE_EFFECTS__
  function _refine(Class, fn, _params) {
    const schema = new Class({
      type: "custom",
      check: "custom",
      fn,
      ...normalizeParams(_params)
    });
    return schema;
  }
  const ZodMiniType = /* @__PURE__ */ $constructor("ZodMiniType", (inst, def) => {
    if (!inst._zod)
      throw new Error("Uninitialized schema in ZodMiniType.");
    $ZodType.init(inst, def);
    inst.def = def;
    inst.type = def.type;
    inst.parse = (data, params) => parse(inst, data, params, { callee: inst.parse });
    inst.safeParse = (data, params) => safeParse(inst, data, params);
    inst.parseAsync = async (data, params) => parseAsync(inst, data, params, { callee: inst.parseAsync });
    inst.safeParseAsync = async (data, params) => safeParseAsync(inst, data, params);
    inst.check = (...checks) => {
      return inst.clone({
        ...def,
        checks: [
          ...def.checks ?? [],
          ...checks.map((ch) => typeof ch === "function" ? {
            _zod: { check: ch, def: { check: "custom" }, onattach: [] }
          } : ch)
        ]
      }, { parent: true });
    };
    inst.with = inst.check;
    inst.clone = (_def, params) => clone(inst, _def, params);
    inst.brand = () => inst;
    inst.register = ((reg, meta) => {
      reg.add(inst, meta);
      return inst;
    });
    inst.apply = (fn) => fn(inst);
  });
  const ZodMiniString = /* @__PURE__ */ $constructor("ZodMiniString", (inst, def) => {
    $ZodString.init(inst, def);
    ZodMiniType.init(inst, def);
  });
  // @__NO_SIDE_EFFECTS__
  function string(params) {
    return /* @__PURE__ */ _string(ZodMiniString, params);
  }
  const ZodMiniStringFormat = /* @__PURE__ */ $constructor("ZodMiniStringFormat", (inst, def) => {
    $ZodStringFormat.init(inst, def);
    ZodMiniString.init(inst, def);
  });
  const ZodMiniURL = /* @__PURE__ */ $constructor("ZodMiniURL", (inst, def) => {
    $ZodURL.init(inst, def);
    ZodMiniStringFormat.init(inst, def);
  });
  // @__NO_SIDE_EFFECTS__
  function url(params) {
    return /* @__PURE__ */ _url(ZodMiniURL, params);
  }
  const ZodMiniBase64 = /* @__PURE__ */ $constructor("ZodMiniBase64", (inst, def) => {
    $ZodBase64.init(inst, def);
    ZodMiniStringFormat.init(inst, def);
  });
  // @__NO_SIDE_EFFECTS__
  function base64$1(params) {
    return /* @__PURE__ */ _base64(ZodMiniBase64, params);
  }
  const ZodMiniNumber = /* @__PURE__ */ $constructor("ZodMiniNumber", (inst, def) => {
    $ZodNumber.init(inst, def);
    ZodMiniType.init(inst, def);
  });
  // @__NO_SIDE_EFFECTS__
  function number(params) {
    return /* @__PURE__ */ _number(ZodMiniNumber, params);
  }
  const ZodMiniNumberFormat = /* @__PURE__ */ $constructor("ZodMiniNumberFormat", (inst, def) => {
    $ZodNumberFormat.init(inst, def);
    ZodMiniNumber.init(inst, def);
  });
  // @__NO_SIDE_EFFECTS__
  function int(params) {
    return /* @__PURE__ */ _int(ZodMiniNumberFormat, params);
  }
  const ZodMiniBoolean = /* @__PURE__ */ $constructor("ZodMiniBoolean", (inst, def) => {
    $ZodBoolean.init(inst, def);
    ZodMiniType.init(inst, def);
  });
  // @__NO_SIDE_EFFECTS__
  function boolean(params) {
    return /* @__PURE__ */ _boolean(ZodMiniBoolean, params);
  }
  const ZodMiniBigInt = /* @__PURE__ */ $constructor("ZodMiniBigInt", (inst, def) => {
    $ZodBigInt.init(inst, def);
    ZodMiniType.init(inst, def);
  });
  // @__NO_SIDE_EFFECTS__
  function bigint(params) {
    return /* @__PURE__ */ _bigint(ZodMiniBigInt, params);
  }
  const ZodMiniUndefined = /* @__PURE__ */ $constructor("ZodMiniUndefined", (inst, def) => {
    $ZodUndefined.init(inst, def);
    ZodMiniType.init(inst, def);
  });
  // @__NO_SIDE_EFFECTS__
  function _undefined(params) {
    return /* @__PURE__ */ _undefined$1(ZodMiniUndefined, params);
  }
  const ZodMiniNull = /* @__PURE__ */ $constructor("ZodMiniNull", (inst, def) => {
    $ZodNull.init(inst, def);
    ZodMiniType.init(inst, def);
  });
  // @__NO_SIDE_EFFECTS__
  function _null(params) {
    return /* @__PURE__ */ _null$1(ZodMiniNull, params);
  }
  const ZodMiniUnknown = /* @__PURE__ */ $constructor("ZodMiniUnknown", (inst, def) => {
    $ZodUnknown.init(inst, def);
    ZodMiniType.init(inst, def);
  });
  // @__NO_SIDE_EFFECTS__
  function unknown() {
    return /* @__PURE__ */ _unknown(ZodMiniUnknown);
  }
  const ZodMiniNever = /* @__PURE__ */ $constructor("ZodMiniNever", (inst, def) => {
    $ZodNever.init(inst, def);
    ZodMiniType.init(inst, def);
  });
  // @__NO_SIDE_EFFECTS__
  function never(params) {
    return /* @__PURE__ */ _never(ZodMiniNever, params);
  }
  const ZodMiniArray = /* @__PURE__ */ $constructor("ZodMiniArray", (inst, def) => {
    $ZodArray.init(inst, def);
    ZodMiniType.init(inst, def);
  });
  // @__NO_SIDE_EFFECTS__
  function array(element, params) {
    return new ZodMiniArray({
      type: "array",
      element,
      ...normalizeParams(params)
    });
  }
  const ZodMiniObject = /* @__PURE__ */ $constructor("ZodMiniObject", (inst, def) => {
    $ZodObject.init(inst, def);
    ZodMiniType.init(inst, def);
    defineLazy(inst, "shape", () => def.shape);
  });
  // @__NO_SIDE_EFFECTS__
  function object(shape, params) {
    const def = {
      type: "object",
      shape: shape ?? {},
      ...normalizeParams(params)
    };
    return new ZodMiniObject(def);
  }
  // @__NO_SIDE_EFFECTS__
  function partial(schema, mask) {
    return partial$1(ZodMiniOptional, schema);
  }
  const ZodMiniUnion = /* @__PURE__ */ $constructor("ZodMiniUnion", (inst, def) => {
    $ZodUnion.init(inst, def);
    ZodMiniType.init(inst, def);
  });
  // @__NO_SIDE_EFFECTS__
  function union(options, params) {
    return new ZodMiniUnion({
      type: "union",
      options,
      ...normalizeParams(params)
    });
  }
  const ZodMiniDiscriminatedUnion = /* @__PURE__ */ $constructor("ZodMiniDiscriminatedUnion", (inst, def) => {
    $ZodDiscriminatedUnion.init(inst, def);
    ZodMiniType.init(inst, def);
  });
  // @__NO_SIDE_EFFECTS__
  function discriminatedUnion(discriminator, options, params) {
    return new ZodMiniDiscriminatedUnion({
      type: "union",
      options,
      discriminator,
      ...normalizeParams(params)
    });
  }
  const ZodMiniIntersection = /* @__PURE__ */ $constructor("ZodMiniIntersection", (inst, def) => {
    $ZodIntersection.init(inst, def);
    ZodMiniType.init(inst, def);
  });
  // @__NO_SIDE_EFFECTS__
  function intersection(left, right) {
    return new ZodMiniIntersection({
      type: "intersection",
      left,
      right
    });
  }
  const ZodMiniTuple = /* @__PURE__ */ $constructor("ZodMiniTuple", (inst, def) => {
    $ZodTuple.init(inst, def);
    ZodMiniType.init(inst, def);
  });
  // @__NO_SIDE_EFFECTS__
  function tuple(items, _paramsOrRest, _params) {
    const hasRest = _paramsOrRest instanceof $ZodType;
    const params = hasRest ? _params : _paramsOrRest;
    const rest = hasRest ? _paramsOrRest : null;
    return new ZodMiniTuple({
      type: "tuple",
      items,
      rest,
      ...normalizeParams(params)
    });
  }
  const ZodMiniRecord = /* @__PURE__ */ $constructor("ZodMiniRecord", (inst, def) => {
    $ZodRecord.init(inst, def);
    ZodMiniType.init(inst, def);
  });
  // @__NO_SIDE_EFFECTS__
  function record(keyType, valueType, params) {
    if (!valueType || !valueType._zod) {
      return new ZodMiniRecord({
        type: "record",
        keyType: /* @__PURE__ */ string(),
        valueType: keyType,
        ...normalizeParams(valueType)
      });
    }
    return new ZodMiniRecord({
      type: "record",
      keyType,
      valueType,
      ...normalizeParams(params)
    });
  }
  const ZodMiniEnum = /* @__PURE__ */ $constructor("ZodMiniEnum", (inst, def) => {
    $ZodEnum.init(inst, def);
    ZodMiniType.init(inst, def);
    inst.options = Object.values(def.entries);
  });
  // @__NO_SIDE_EFFECTS__
  function _enum(values, params) {
    const entries = Array.isArray(values) ? Object.fromEntries(values.map((v) => [v, v])) : values;
    return new ZodMiniEnum({
      type: "enum",
      entries,
      ...normalizeParams(params)
    });
  }
  const ZodMiniLiteral = /* @__PURE__ */ $constructor("ZodMiniLiteral", (inst, def) => {
    $ZodLiteral.init(inst, def);
    ZodMiniType.init(inst, def);
  });
  // @__NO_SIDE_EFFECTS__
  function literal(value, params) {
    return new ZodMiniLiteral({
      type: "literal",
      values: Array.isArray(value) ? value : [value],
      ...normalizeParams(params)
    });
  }
  const ZodMiniTransform = /* @__PURE__ */ $constructor("ZodMiniTransform", (inst, def) => {
    $ZodTransform.init(inst, def);
    ZodMiniType.init(inst, def);
  });
  // @__NO_SIDE_EFFECTS__
  function transform(fn) {
    return new ZodMiniTransform({
      type: "transform",
      transform: fn
    });
  }
  const ZodMiniOptional = /* @__PURE__ */ $constructor("ZodMiniOptional", (inst, def) => {
    $ZodOptional.init(inst, def);
    ZodMiniType.init(inst, def);
  });
  // @__NO_SIDE_EFFECTS__
  function optional(innerType) {
    return new ZodMiniOptional({
      type: "optional",
      innerType
    });
  }
  const ZodMiniPipe = /* @__PURE__ */ $constructor("ZodMiniPipe", (inst, def) => {
    $ZodPipe.init(inst, def);
    ZodMiniType.init(inst, def);
  });
  // @__NO_SIDE_EFFECTS__
  function pipe(in_, out) {
    return new ZodMiniPipe({
      type: "pipe",
      in: in_,
      out
    });
  }
  const ZodMiniLazy = /* @__PURE__ */ $constructor("ZodMiniLazy", (inst, def) => {
    $ZodLazy.init(inst, def);
    ZodMiniType.init(inst, def);
  });
  // @__NO_SIDE_EFFECTS__
  function _lazy(getter) {
    return new ZodMiniLazy({
      type: "lazy",
      getter
    });
  }
  const ZodMiniCustom = /* @__PURE__ */ $constructor("ZodMiniCustom", (inst, def) => {
    $ZodCustom.init(inst, def);
    ZodMiniType.init(inst, def);
  });
  // @__NO_SIDE_EFFECTS__
  function custom(fn, _params) {
    return /* @__PURE__ */ _custom(ZodMiniCustom, fn ?? (() => true), _params);
  }
  // @__NO_SIDE_EFFECTS__
  function refine(fn, _params = {}) {
    return /* @__PURE__ */ _refine(ZodMiniCustom, fn, _params);
  }
  // @__NO_SIDE_EFFECTS__
  function _instanceof(cls, params = {}) {
    const inst = /* @__PURE__ */ custom((data) => data instanceof cls, params);
    inst._zod.bag.Class = cls;
    inst._zod.check = (payload) => {
      if (!(payload.value instanceof cls)) {
        payload.issues.push({
          code: "invalid_type",
          expected: cls.name,
          input: payload.value,
          inst,
          path: [...inst._zod.def.path ?? []]
        });
      }
    };
    return inst;
  }
  // @__NO_SIDE_EFFECTS__
  function json() {
    const jsonSchema = /* @__PURE__ */ _lazy(() => {
      return /* @__PURE__ */ union([/* @__PURE__ */ string(), /* @__PURE__ */ number(), /* @__PURE__ */ boolean(), /* @__PURE__ */ _null(), /* @__PURE__ */ array(jsonSchema), /* @__PURE__ */ record(/* @__PURE__ */ string(), jsonSchema)]);
    });
    return jsonSchema;
  }
  function isBytes$4(a) {
    return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array" && "BYTES_PER_ELEMENT" in a && a.BYTES_PER_ELEMENT === 1;
  }
  function abytes$4(b) {
    if (!isBytes$4(b))
      throw new TypeError("Uint8Array expected");
  }
  function isArrayOf(isString, arr) {
    if (!Array.isArray(arr))
      return false;
    if (arr.length === 0)
      return true;
    if (isString) {
      return arr.every((item) => typeof item === "string");
    } else {
      return arr.every((item) => Number.isSafeInteger(item));
    }
  }
  function afn(input) {
    if (typeof input !== "function")
      throw new TypeError("function expected");
    return true;
  }
  function astr(label, input) {
    if (typeof input !== "string")
      throw new TypeError(`${label}: string expected`);
    return true;
  }
  function anumber$2(n) {
    if (typeof n !== "number")
      throw new TypeError(`number expected, got ${typeof n}`);
    if (!Number.isSafeInteger(n))
      throw new RangeError(`invalid integer: ${n}`);
  }
  function aArr(input) {
    if (!Array.isArray(input))
      throw new TypeError("array expected");
  }
  function astrArr(label, input) {
    if (!isArrayOf(true, input))
      throw new TypeError(`${label}: array of strings expected`);
  }
  function anumArr(label, input) {
    if (!isArrayOf(false, input))
      throw new TypeError(`${label}: array of numbers expected`);
  }
  // @__NO_SIDE_EFFECTS__
  function chain(...args) {
    const id = (a) => a;
    const wrap = (a, b) => (c) => a(b(c));
    const encode = args.map((x) => x.encode).reduceRight(wrap, id);
    const decode = args.map((x) => x.decode).reduce(wrap, id);
    return { encode, decode };
  }
  // @__NO_SIDE_EFFECTS__
  function alphabet(letters) {
    const lettersA = typeof letters === "string" ? letters.split("") : letters;
    const len = lettersA.length;
    astrArr("alphabet", lettersA);
    const indexes = new Map(lettersA.map((l, i) => [l, i]));
    return {
      encode: (digits) => {
        aArr(digits);
        return digits.map((i) => {
          if (!Number.isSafeInteger(i) || i < 0 || i >= len)
            throw new Error(`alphabet.encode: digit index outside alphabet "${i}". Allowed: ${letters}`);
          return lettersA[i];
        });
      },
      decode: (input) => {
        aArr(input);
        return input.map((letter) => {
          astr("alphabet.decode", letter);
          const i = indexes.get(letter);
          if (i === void 0)
            throw new Error(`Unknown letter: "${letter}". Allowed: ${letters}`);
          return i;
        });
      }
    };
  }
  // @__NO_SIDE_EFFECTS__
  function join(separator = "") {
    astr("join", separator);
    return {
      encode: (from) => {
        astrArr("join.decode", from);
        return from.join(separator);
      },
      decode: (to) => {
        astr("join.decode", to);
        return to.split(separator);
      }
    };
  }
  // @__NO_SIDE_EFFECTS__
  function padding(bits, chr = "=") {
    anumber$2(bits);
    astr("padding", chr);
    return {
      encode(data) {
        astrArr("padding.encode", data);
        while (data.length * bits % 8)
          data.push(chr);
        return data;
      },
      decode(input) {
        astrArr("padding.decode", input);
        let end = input.length;
        if (end * bits % 8)
          throw new Error("padding: invalid, string should have whole number of bytes");
        for (; end > 0 && input[end - 1] === chr; end--) {
          const last = end - 1;
          const byte = last * bits;
          if (byte % 8 === 0)
            throw new Error("padding: invalid, string has too much padding");
        }
        return input.slice(0, end);
      }
    };
  }
  // @__NO_SIDE_EFFECTS__
  function normalize(fn) {
    afn(fn);
    return { encode: (from) => from, decode: (to) => fn(to) };
  }
  function convertRadix(data, from, to) {
    if (from < 2)
      throw new RangeError(`convertRadix: invalid from=${from}, base cannot be less than 2`);
    if (to < 2)
      throw new RangeError(`convertRadix: invalid to=${to}, base cannot be less than 2`);
    aArr(data);
    if (!data.length)
      return [];
    let pos = 0;
    const res = [];
    const digits = Array.from(data, (d) => {
      anumber$2(d);
      if (d < 0 || d >= from)
        throw new Error(`invalid integer: ${d}`);
      return d;
    });
    const dlen = digits.length;
    while (true) {
      let carry = 0;
      let done = true;
      for (let i = pos; i < dlen; i++) {
        const digit = digits[i];
        const fromCarry = from * carry;
        const digitBase = fromCarry + digit;
        if (!Number.isSafeInteger(digitBase) || fromCarry / from !== carry || digitBase - digit !== fromCarry) {
          throw new Error("convertRadix: carry overflow");
        }
        const div = digitBase / to;
        carry = digitBase % to;
        const rounded = Math.floor(div);
        digits[i] = rounded;
        if (!Number.isSafeInteger(rounded) || rounded * to + carry !== digitBase)
          throw new Error("convertRadix: carry overflow");
        if (!done)
          continue;
        else if (!rounded)
          pos = i;
        else
          done = false;
      }
      res.push(carry);
      if (done)
        break;
    }
    for (let i = 0; i < data.length - 1 && data[i] === 0; i++)
      res.push(0);
    return res.reverse();
  }
  const gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
  const radix2carry = /* @__NO_SIDE_EFFECTS__ */ (from, to) => from + (to - gcd(from, to));
  const powers = /* @__PURE__ */ (() => {
    let res = [];
    for (let i = 0; i < 40; i++)
      res.push(2 ** i);
    return res;
  })();
  function convertRadix2(data, from, to, padding2) {
    aArr(data);
    if (from <= 0 || from > 32)
      throw new RangeError(`convertRadix2: wrong from=${from}`);
    if (to <= 0 || to > 32)
      throw new RangeError(`convertRadix2: wrong to=${to}`);
    if (/* @__PURE__ */ radix2carry(from, to) > 32) {
      throw new Error(`convertRadix2: carry overflow from=${from} to=${to} carryBits=${/* @__PURE__ */ radix2carry(from, to)}`);
    }
    let carry = 0;
    let pos = 0;
    const max = powers[from];
    const mask = powers[to] - 1;
    const res = [];
    for (const n of data) {
      anumber$2(n);
      if (n >= max)
        throw new Error(`convertRadix2: invalid data word=${n} from=${from}`);
      carry = carry << from | n;
      if (pos + from > 32)
        throw new Error(`convertRadix2: carry overflow pos=${pos} from=${from}`);
      pos += from;
      for (; pos >= to; pos -= to)
        res.push((carry >> pos - to & mask) >>> 0);
      const pow = powers[pos];
      if (pow === void 0)
        throw new Error("invalid carry");
      carry &= pow - 1;
    }
    carry = carry << to - pos & mask;
    if (!padding2 && pos >= from)
      throw new Error("Excess padding");
    if (!padding2 && carry > 0)
      throw new Error(`Non-zero padding: ${carry}`);
    if (padding2 && pos > 0)
      res.push(carry >>> 0);
    return res;
  }
  // @__NO_SIDE_EFFECTS__
  function radix(num) {
    anumber$2(num);
    const _256 = 2 ** 8;
    return {
      encode: (bytes) => {
        if (!isBytes$4(bytes))
          throw new TypeError("radix.encode input should be Uint8Array");
        return convertRadix(Array.from(bytes), _256, num);
      },
      decode: (digits) => {
        anumArr("radix.decode", digits);
        return Uint8Array.from(convertRadix(digits, num, _256));
      }
    };
  }
  // @__NO_SIDE_EFFECTS__
  function radix2(bits, revPadding = false) {
    anumber$2(bits);
    if (bits <= 0 || bits > 32)
      throw new RangeError("radix2: bits should be in (0..32]");
    if (/* @__PURE__ */ radix2carry(8, bits) > 32 || /* @__PURE__ */ radix2carry(bits, 8) > 32)
      throw new RangeError("radix2: carry overflow");
    return {
      encode: (bytes) => {
        if (!isBytes$4(bytes))
          throw new TypeError("radix2.encode input should be Uint8Array");
        return convertRadix2(Array.from(bytes), 8, bits, !revPadding);
      },
      decode: (digits) => {
        anumArr("radix2.decode", digits);
        return Uint8Array.from(convertRadix2(digits, bits, 8, revPadding));
      }
    };
  }
  const hasBase64Builtin = /* @__PURE__ */ (() => typeof Uint8Array.from([]).toBase64 === "function" && typeof Uint8Array.fromBase64 === "function")();
  const ASCII_WHITESPACE = /[\t\n\f\r ]/;
  const decodeBase64Builtin = (s, isUrl) => {
    astr("base64", s);
    const alphabet2 = "base64";
    if (s.length > 0 && ASCII_WHITESPACE.test(s))
      throw new Error("invalid base64");
    return Uint8Array.fromBase64(s, { alphabet: alphabet2, lastChunkHandling: "strict" });
  };
  const base64 = /* @__PURE__ */ Object.freeze(hasBase64Builtin ? {
    encode(b) {
      abytes$4(b);
      return b.toBase64();
    },
    decode(s) {
      return decodeBase64Builtin(s);
    }
  } : /* @__PURE__ */ chain(/* @__PURE__ */ radix2(6), /* @__PURE__ */ alphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"), /* @__PURE__ */ padding(6), /* @__PURE__ */ join("")));
  const base64urlnopad = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ chain(/* @__PURE__ */ radix2(6), /* @__PURE__ */ alphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"), /* @__PURE__ */ join("")));
  const genBase58 = /* @__NO_SIDE_EFFECTS__ */ (abc) => /* @__PURE__ */ chain(/* @__PURE__ */ radix(58), /* @__PURE__ */ alphabet(abc), /* @__PURE__ */ join(""));
  const base58 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ genBase58("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"));
  const hasHexBuiltin$1 = /* @__PURE__ */ (() => (
    // Require both directions before enabling the native hex path so encode/decode stay symmetric.
    typeof Uint8Array.from([]).toHex === "function" && typeof Uint8Array.fromHex === "function"
  ))();
  const hexBuiltin = {
    // Keep local type guards so the native path preserves library-level input errors.
    // Native toHex emits lowercase hex, matching the fallback alphabet and Node's hex strings.
    encode(data) {
      abytes$4(data);
      return data.toHex();
    },
    // Native fromHex accepts either hex case and rejects odd-length / non-hex syntax.
    decode(s) {
      astr("hex", s);
      return Uint8Array.fromHex(s);
    }
  };
  const hex = /* @__PURE__ */ Object.freeze(hasHexBuiltin$1 ? hexBuiltin : /* @__PURE__ */ chain(/* @__PURE__ */ radix2(4), /* @__PURE__ */ alphabet("0123456789abcdef"), /* @__PURE__ */ join(""), /* @__PURE__ */ normalize((s) => {
    if (typeof s !== "string" || s.length % 2 !== 0)
      throw new TypeError(`hex.decode: expected string, got ${typeof s} with length ${s.length}`);
    return s.toLowerCase();
  })));
  var freeGlobal = typeof global == "object" && global && global.Object === Object && global;
  var freeSelf = typeof self == "object" && self && self.Object === Object && self;
  var root$1 = freeGlobal || freeSelf || Function("return this")();
  var Symbol$1 = root$1.Symbol;
  var objectProto$d = Object.prototype;
  var hasOwnProperty$a = objectProto$d.hasOwnProperty;
  var nativeObjectToString$1 = objectProto$d.toString;
  var symToStringTag$1 = Symbol$1 ? Symbol$1.toStringTag : void 0;
  function getRawTag(value) {
    var isOwn = hasOwnProperty$a.call(value, symToStringTag$1), tag = value[symToStringTag$1];
    try {
      value[symToStringTag$1] = void 0;
      var unmasked = true;
    } catch (e) {
    }
    var result2 = nativeObjectToString$1.call(value);
    if (unmasked) {
      if (isOwn) {
        value[symToStringTag$1] = tag;
      } else {
        delete value[symToStringTag$1];
      }
    }
    return result2;
  }
  var objectProto$c = Object.prototype;
  var nativeObjectToString = objectProto$c.toString;
  function objectToString(value) {
    return nativeObjectToString.call(value);
  }
  var nullTag = "[object Null]", undefinedTag = "[object Undefined]";
  var symToStringTag = Symbol$1 ? Symbol$1.toStringTag : void 0;
  function baseGetTag(value) {
    if (value == null) {
      return value === void 0 ? undefinedTag : nullTag;
    }
    return symToStringTag && symToStringTag in Object(value) ? getRawTag(value) : objectToString(value);
  }
  function isObjectLike(value) {
    return value != null && typeof value == "object";
  }
  var isArray = Array.isArray;
  function isObject(value) {
    var type = typeof value;
    return value != null && (type == "object" || type == "function");
  }
  function identity(value) {
    return value;
  }
  var asyncTag = "[object AsyncFunction]", funcTag$2 = "[object Function]", genTag$1 = "[object GeneratorFunction]", proxyTag = "[object Proxy]";
  function isFunction(value) {
    if (!isObject(value)) {
      return false;
    }
    var tag = baseGetTag(value);
    return tag == funcTag$2 || tag == genTag$1 || tag == asyncTag || tag == proxyTag;
  }
  var coreJsData = root$1["__core-js_shared__"];
  var maskSrcKey = (function() {
    var uid = /[^.]+$/.exec(coreJsData && coreJsData.keys && coreJsData.keys.IE_PROTO || "");
    return uid ? "Symbol(src)_1." + uid : "";
  })();
  function isMasked(func) {
    return !!maskSrcKey && maskSrcKey in func;
  }
  var funcProto$2 = Function.prototype;
  var funcToString$2 = funcProto$2.toString;
  function toSource(func) {
    if (func != null) {
      try {
        return funcToString$2.call(func);
      } catch (e) {
      }
      try {
        return func + "";
      } catch (e) {
      }
    }
    return "";
  }
  var reRegExpChar = /[\\^$.*+?()[\]{}|]/g;
  var reIsHostCtor = /^\[object .+?Constructor\]$/;
  var funcProto$1 = Function.prototype, objectProto$b = Object.prototype;
  var funcToString$1 = funcProto$1.toString;
  var hasOwnProperty$9 = objectProto$b.hasOwnProperty;
  var reIsNative = RegExp(
    "^" + funcToString$1.call(hasOwnProperty$9).replace(reRegExpChar, "\\$&").replace(/hasOwnProperty|(function).*?(?=\\\()| for .+?(?=\\\])/g, "$1.*?") + "$"
  );
  function baseIsNative(value) {
    if (!isObject(value) || isMasked(value)) {
      return false;
    }
    var pattern = isFunction(value) ? reIsNative : reIsHostCtor;
    return pattern.test(toSource(value));
  }
  function getValue(object2, key) {
    return object2 == null ? void 0 : object2[key];
  }
  function getNative(object2, key) {
    var value = getValue(object2, key);
    return baseIsNative(value) ? value : void 0;
  }
  var WeakMap$1 = getNative(root$1, "WeakMap");
  var objectCreate = Object.create;
  var baseCreate = /* @__PURE__ */ (function() {
    function object2() {
    }
    return function(proto) {
      if (!isObject(proto)) {
        return {};
      }
      if (objectCreate) {
        return objectCreate(proto);
      }
      object2.prototype = proto;
      var result2 = new object2();
      object2.prototype = void 0;
      return result2;
    };
  })();
  function apply(func, thisArg, args) {
    switch (args.length) {
      case 0:
        return func.call(thisArg);
      case 1:
        return func.call(thisArg, args[0]);
      case 2:
        return func.call(thisArg, args[0], args[1]);
      case 3:
        return func.call(thisArg, args[0], args[1], args[2]);
    }
    return func.apply(thisArg, args);
  }
  function copyArray(source, array2) {
    var index = -1, length = source.length;
    array2 || (array2 = Array(length));
    while (++index < length) {
      array2[index] = source[index];
    }
    return array2;
  }
  var HOT_COUNT = 800, HOT_SPAN = 16;
  var nativeNow = Date.now;
  function shortOut(func) {
    var count = 0, lastCalled = 0;
    return function() {
      var stamp = nativeNow(), remaining = HOT_SPAN - (stamp - lastCalled);
      lastCalled = stamp;
      if (remaining > 0) {
        if (++count >= HOT_COUNT) {
          return arguments[0];
        }
      } else {
        count = 0;
      }
      return func.apply(void 0, arguments);
    };
  }
  function constant(value) {
    return function() {
      return value;
    };
  }
  var defineProperty = (function() {
    try {
      var func = getNative(Object, "defineProperty");
      func({}, "", {});
      return func;
    } catch (e) {
    }
  })();
  var baseSetToString = !defineProperty ? identity : function(func, string2) {
    return defineProperty(func, "toString", {
      "configurable": true,
      "enumerable": false,
      "value": constant(string2),
      "writable": true
    });
  };
  var setToString = shortOut(baseSetToString);
  function arrayEach(array2, iteratee) {
    var index = -1, length = array2 == null ? 0 : array2.length;
    while (++index < length) {
      if (iteratee(array2[index], index, array2) === false) {
        break;
      }
    }
    return array2;
  }
  var MAX_SAFE_INTEGER$1 = 9007199254740991;
  var reIsUint = /^(?:0|[1-9]\d*)$/;
  function isIndex(value, length) {
    var type = typeof value;
    length = length == null ? MAX_SAFE_INTEGER$1 : length;
    return !!length && (type == "number" || type != "symbol" && reIsUint.test(value)) && (value > -1 && value % 1 == 0 && value < length);
  }
  function baseAssignValue(object2, key, value) {
    if (key == "__proto__" && defineProperty) {
      defineProperty(object2, key, {
        "configurable": true,
        "enumerable": true,
        "value": value,
        "writable": true
      });
    } else {
      object2[key] = value;
    }
  }
  function eq(value, other) {
    return value === other || value !== value && other !== other;
  }
  var objectProto$a = Object.prototype;
  var hasOwnProperty$8 = objectProto$a.hasOwnProperty;
  function assignValue(object2, key, value) {
    var objValue = object2[key];
    if (!(hasOwnProperty$8.call(object2, key) && eq(objValue, value)) || value === void 0 && !(key in object2)) {
      baseAssignValue(object2, key, value);
    }
  }
  function copyObject(source, props, object2, customizer) {
    var isNew = !object2;
    object2 || (object2 = {});
    var index = -1, length = props.length;
    while (++index < length) {
      var key = props[index];
      var newValue = void 0;
      if (newValue === void 0) {
        newValue = source[key];
      }
      if (isNew) {
        baseAssignValue(object2, key, newValue);
      } else {
        assignValue(object2, key, newValue);
      }
    }
    return object2;
  }
  var nativeMax = Math.max;
  function overRest(func, start, transform2) {
    start = nativeMax(start === void 0 ? func.length - 1 : start, 0);
    return function() {
      var args = arguments, index = -1, length = nativeMax(args.length - start, 0), array2 = Array(length);
      while (++index < length) {
        array2[index] = args[start + index];
      }
      index = -1;
      var otherArgs = Array(start + 1);
      while (++index < start) {
        otherArgs[index] = args[index];
      }
      otherArgs[start] = transform2(array2);
      return apply(func, this, otherArgs);
    };
  }
  function baseRest(func, start) {
    return setToString(overRest(func, start, identity), func + "");
  }
  var MAX_SAFE_INTEGER = 9007199254740991;
  function isLength(value) {
    return typeof value == "number" && value > -1 && value % 1 == 0 && value <= MAX_SAFE_INTEGER;
  }
  function isArrayLike$1(value) {
    return value != null && isLength(value.length) && !isFunction(value);
  }
  function isIterateeCall(value, index, object2) {
    if (!isObject(object2)) {
      return false;
    }
    var type = typeof index;
    if (type == "number" ? isArrayLike$1(object2) && isIndex(index, object2.length) : type == "string" && index in object2) {
      return eq(object2[index], value);
    }
    return false;
  }
  function createAssigner(assigner) {
    return baseRest(function(object2, sources) {
      var index = -1, length = sources.length, customizer = length > 1 ? sources[length - 1] : void 0, guard = length > 2 ? sources[2] : void 0;
      customizer = assigner.length > 3 && typeof customizer == "function" ? (length--, customizer) : void 0;
      if (guard && isIterateeCall(sources[0], sources[1], guard)) {
        customizer = length < 3 ? void 0 : customizer;
        length = 1;
      }
      object2 = Object(object2);
      while (++index < length) {
        var source = sources[index];
        if (source) {
          assigner(object2, source, index, customizer);
        }
      }
      return object2;
    });
  }
  var objectProto$9 = Object.prototype;
  function isPrototype(value) {
    var Ctor = value && value.constructor, proto = typeof Ctor == "function" && Ctor.prototype || objectProto$9;
    return value === proto;
  }
  function baseTimes(n, iteratee) {
    var index = -1, result2 = Array(n);
    while (++index < n) {
      result2[index] = iteratee(index);
    }
    return result2;
  }
  var argsTag$2 = "[object Arguments]";
  function baseIsArguments(value) {
    return isObjectLike(value) && baseGetTag(value) == argsTag$2;
  }
  var objectProto$8 = Object.prototype;
  var hasOwnProperty$7 = objectProto$8.hasOwnProperty;
  var propertyIsEnumerable$1 = objectProto$8.propertyIsEnumerable;
  var isArguments = baseIsArguments(/* @__PURE__ */ (function() {
    return arguments;
  })()) ? baseIsArguments : function(value) {
    return isObjectLike(value) && hasOwnProperty$7.call(value, "callee") && !propertyIsEnumerable$1.call(value, "callee");
  };
  function stubFalse() {
    return false;
  }
  var freeExports$2 = typeof exports == "object" && exports && !exports.nodeType && exports;
  var freeModule$2 = freeExports$2 && typeof module == "object" && module && !module.nodeType && module;
  var moduleExports$2 = freeModule$2 && freeModule$2.exports === freeExports$2;
  var Buffer$1 = moduleExports$2 ? root$1.Buffer : void 0;
  var nativeIsBuffer = Buffer$1 ? Buffer$1.isBuffer : void 0;
  var isBuffer = nativeIsBuffer || stubFalse;
  var argsTag$1 = "[object Arguments]", arrayTag$1 = "[object Array]", boolTag$2 = "[object Boolean]", dateTag$2 = "[object Date]", errorTag$1 = "[object Error]", funcTag$1 = "[object Function]", mapTag$4 = "[object Map]", numberTag$2 = "[object Number]", objectTag$3 = "[object Object]", regexpTag$2 = "[object RegExp]", setTag$4 = "[object Set]", stringTag$2 = "[object String]", weakMapTag$2 = "[object WeakMap]";
  var arrayBufferTag$2 = "[object ArrayBuffer]", dataViewTag$3 = "[object DataView]", float32Tag$2 = "[object Float32Array]", float64Tag$2 = "[object Float64Array]", int8Tag$2 = "[object Int8Array]", int16Tag$2 = "[object Int16Array]", int32Tag$2 = "[object Int32Array]", uint8Tag$2 = "[object Uint8Array]", uint8ClampedTag$2 = "[object Uint8ClampedArray]", uint16Tag$2 = "[object Uint16Array]", uint32Tag$2 = "[object Uint32Array]";
  var typedArrayTags = {};
  typedArrayTags[float32Tag$2] = typedArrayTags[float64Tag$2] = typedArrayTags[int8Tag$2] = typedArrayTags[int16Tag$2] = typedArrayTags[int32Tag$2] = typedArrayTags[uint8Tag$2] = typedArrayTags[uint8ClampedTag$2] = typedArrayTags[uint16Tag$2] = typedArrayTags[uint32Tag$2] = true;
  typedArrayTags[argsTag$1] = typedArrayTags[arrayTag$1] = typedArrayTags[arrayBufferTag$2] = typedArrayTags[boolTag$2] = typedArrayTags[dataViewTag$3] = typedArrayTags[dateTag$2] = typedArrayTags[errorTag$1] = typedArrayTags[funcTag$1] = typedArrayTags[mapTag$4] = typedArrayTags[numberTag$2] = typedArrayTags[objectTag$3] = typedArrayTags[regexpTag$2] = typedArrayTags[setTag$4] = typedArrayTags[stringTag$2] = typedArrayTags[weakMapTag$2] = false;
  function baseIsTypedArray(value) {
    return isObjectLike(value) && isLength(value.length) && !!typedArrayTags[baseGetTag(value)];
  }
  function baseUnary(func) {
    return function(value) {
      return func(value);
    };
  }
  var freeExports$1 = typeof exports == "object" && exports && !exports.nodeType && exports;
  var freeModule$1 = freeExports$1 && typeof module == "object" && module && !module.nodeType && module;
  var moduleExports$1 = freeModule$1 && freeModule$1.exports === freeExports$1;
  var freeProcess = moduleExports$1 && freeGlobal.process;
  var nodeUtil = (function() {
    try {
      var types = freeModule$1 && freeModule$1.require && freeModule$1.require("util").types;
      if (types) {
        return types;
      }
      return freeProcess && freeProcess.binding && freeProcess.binding("util");
    } catch (e) {
    }
  })();
  var nodeIsTypedArray = nodeUtil && nodeUtil.isTypedArray;
  var isTypedArray = nodeIsTypedArray ? baseUnary(nodeIsTypedArray) : baseIsTypedArray;
  var objectProto$7 = Object.prototype;
  var hasOwnProperty$6 = objectProto$7.hasOwnProperty;
  function arrayLikeKeys(value, inherited) {
    var isArr = isArray(value), isArg = !isArr && isArguments(value), isBuff = !isArr && !isArg && isBuffer(value), isType = !isArr && !isArg && !isBuff && isTypedArray(value), skipIndexes = isArr || isArg || isBuff || isType, result2 = skipIndexes ? baseTimes(value.length, String) : [], length = result2.length;
    for (var key in value) {
      if ((inherited || hasOwnProperty$6.call(value, key)) && !(skipIndexes && // Safari 9 has enumerable `arguments.length` in strict mode.
      (key == "length" || // Node.js 0.10 has enumerable non-index properties on buffers.
      isBuff && (key == "offset" || key == "parent") || // PhantomJS 2 has enumerable non-index properties on typed arrays.
      isType && (key == "buffer" || key == "byteLength" || key == "byteOffset") || // Skip index properties.
      isIndex(key, length)))) {
        result2.push(key);
      }
    }
    return result2;
  }
  function overArg(func, transform2) {
    return function(arg) {
      return func(transform2(arg));
    };
  }
  var nativeKeys = overArg(Object.keys, Object);
  var objectProto$6 = Object.prototype;
  var hasOwnProperty$5 = objectProto$6.hasOwnProperty;
  function baseKeys(object2) {
    if (!isPrototype(object2)) {
      return nativeKeys(object2);
    }
    var result2 = [];
    for (var key in Object(object2)) {
      if (hasOwnProperty$5.call(object2, key) && key != "constructor") {
        result2.push(key);
      }
    }
    return result2;
  }
  function keys(object2) {
    return isArrayLike$1(object2) ? arrayLikeKeys(object2) : baseKeys(object2);
  }
  function nativeKeysIn(object2) {
    var result2 = [];
    if (object2 != null) {
      for (var key in Object(object2)) {
        result2.push(key);
      }
    }
    return result2;
  }
  var objectProto$5 = Object.prototype;
  var hasOwnProperty$4 = objectProto$5.hasOwnProperty;
  function baseKeysIn(object2) {
    if (!isObject(object2)) {
      return nativeKeysIn(object2);
    }
    var isProto = isPrototype(object2), result2 = [];
    for (var key in object2) {
      if (!(key == "constructor" && (isProto || !hasOwnProperty$4.call(object2, key)))) {
        result2.push(key);
      }
    }
    return result2;
  }
  function keysIn(object2) {
    return isArrayLike$1(object2) ? arrayLikeKeys(object2, true) : baseKeysIn(object2);
  }
  var nativeCreate = getNative(Object, "create");
  function hashClear() {
    this.__data__ = nativeCreate ? nativeCreate(null) : {};
    this.size = 0;
  }
  function hashDelete(key) {
    var result2 = this.has(key) && delete this.__data__[key];
    this.size -= result2 ? 1 : 0;
    return result2;
  }
  var HASH_UNDEFINED$1 = "__lodash_hash_undefined__";
  var objectProto$4 = Object.prototype;
  var hasOwnProperty$3 = objectProto$4.hasOwnProperty;
  function hashGet(key) {
    var data = this.__data__;
    if (nativeCreate) {
      var result2 = data[key];
      return result2 === HASH_UNDEFINED$1 ? void 0 : result2;
    }
    return hasOwnProperty$3.call(data, key) ? data[key] : void 0;
  }
  var objectProto$3 = Object.prototype;
  var hasOwnProperty$2 = objectProto$3.hasOwnProperty;
  function hashHas(key) {
    var data = this.__data__;
    return nativeCreate ? data[key] !== void 0 : hasOwnProperty$2.call(data, key);
  }
  var HASH_UNDEFINED = "__lodash_hash_undefined__";
  function hashSet(key, value) {
    var data = this.__data__;
    this.size += this.has(key) ? 0 : 1;
    data[key] = nativeCreate && value === void 0 ? HASH_UNDEFINED : value;
    return this;
  }
  function Hash(entries) {
    var index = -1, length = entries == null ? 0 : entries.length;
    this.clear();
    while (++index < length) {
      var entry = entries[index];
      this.set(entry[0], entry[1]);
    }
  }
  Hash.prototype.clear = hashClear;
  Hash.prototype["delete"] = hashDelete;
  Hash.prototype.get = hashGet;
  Hash.prototype.has = hashHas;
  Hash.prototype.set = hashSet;
  function listCacheClear() {
    this.__data__ = [];
    this.size = 0;
  }
  function assocIndexOf(array2, key) {
    var length = array2.length;
    while (length--) {
      if (eq(array2[length][0], key)) {
        return length;
      }
    }
    return -1;
  }
  var arrayProto = Array.prototype;
  var splice = arrayProto.splice;
  function listCacheDelete(key) {
    var data = this.__data__, index = assocIndexOf(data, key);
    if (index < 0) {
      return false;
    }
    var lastIndex = data.length - 1;
    if (index == lastIndex) {
      data.pop();
    } else {
      splice.call(data, index, 1);
    }
    --this.size;
    return true;
  }
  function listCacheGet(key) {
    var data = this.__data__, index = assocIndexOf(data, key);
    return index < 0 ? void 0 : data[index][1];
  }
  function listCacheHas(key) {
    return assocIndexOf(this.__data__, key) > -1;
  }
  function listCacheSet(key, value) {
    var data = this.__data__, index = assocIndexOf(data, key);
    if (index < 0) {
      ++this.size;
      data.push([key, value]);
    } else {
      data[index][1] = value;
    }
    return this;
  }
  function ListCache(entries) {
    var index = -1, length = entries == null ? 0 : entries.length;
    this.clear();
    while (++index < length) {
      var entry = entries[index];
      this.set(entry[0], entry[1]);
    }
  }
  ListCache.prototype.clear = listCacheClear;
  ListCache.prototype["delete"] = listCacheDelete;
  ListCache.prototype.get = listCacheGet;
  ListCache.prototype.has = listCacheHas;
  ListCache.prototype.set = listCacheSet;
  var Map$1 = getNative(root$1, "Map");
  function mapCacheClear() {
    this.size = 0;
    this.__data__ = {
      "hash": new Hash(),
      "map": new (Map$1 || ListCache)(),
      "string": new Hash()
    };
  }
  function isKeyable(value) {
    var type = typeof value;
    return type == "string" || type == "number" || type == "symbol" || type == "boolean" ? value !== "__proto__" : value === null;
  }
  function getMapData(map, key) {
    var data = map.__data__;
    return isKeyable(key) ? data[typeof key == "string" ? "string" : "hash"] : data.map;
  }
  function mapCacheDelete(key) {
    var result2 = getMapData(this, key)["delete"](key);
    this.size -= result2 ? 1 : 0;
    return result2;
  }
  function mapCacheGet(key) {
    return getMapData(this, key).get(key);
  }
  function mapCacheHas(key) {
    return getMapData(this, key).has(key);
  }
  function mapCacheSet(key, value) {
    var data = getMapData(this, key), size = data.size;
    data.set(key, value);
    this.size += data.size == size ? 0 : 1;
    return this;
  }
  function MapCache(entries) {
    var index = -1, length = entries == null ? 0 : entries.length;
    this.clear();
    while (++index < length) {
      var entry = entries[index];
      this.set(entry[0], entry[1]);
    }
  }
  MapCache.prototype.clear = mapCacheClear;
  MapCache.prototype["delete"] = mapCacheDelete;
  MapCache.prototype.get = mapCacheGet;
  MapCache.prototype.has = mapCacheHas;
  MapCache.prototype.set = mapCacheSet;
  function arrayPush(array2, values) {
    var index = -1, length = values.length, offset = array2.length;
    while (++index < length) {
      array2[offset + index] = values[index];
    }
    return array2;
  }
  var getPrototype = overArg(Object.getPrototypeOf, Object);
  var objectTag$2 = "[object Object]";
  var funcProto = Function.prototype, objectProto$2 = Object.prototype;
  var funcToString = funcProto.toString;
  var hasOwnProperty$1 = objectProto$2.hasOwnProperty;
  var objectCtorString = funcToString.call(Object);
  function isPlainObject(value) {
    if (!isObjectLike(value) || baseGetTag(value) != objectTag$2) {
      return false;
    }
    var proto = getPrototype(value);
    if (proto === null) {
      return true;
    }
    var Ctor = hasOwnProperty$1.call(proto, "constructor") && proto.constructor;
    return typeof Ctor == "function" && Ctor instanceof Ctor && funcToString.call(Ctor) == objectCtorString;
  }
  function stackClear() {
    this.__data__ = new ListCache();
    this.size = 0;
  }
  function stackDelete(key) {
    var data = this.__data__, result2 = data["delete"](key);
    this.size = data.size;
    return result2;
  }
  function stackGet(key) {
    return this.__data__.get(key);
  }
  function stackHas(key) {
    return this.__data__.has(key);
  }
  var LARGE_ARRAY_SIZE = 200;
  function stackSet(key, value) {
    var data = this.__data__;
    if (data instanceof ListCache) {
      var pairs = data.__data__;
      if (!Map$1 || pairs.length < LARGE_ARRAY_SIZE - 1) {
        pairs.push([key, value]);
        this.size = ++data.size;
        return this;
      }
      data = this.__data__ = new MapCache(pairs);
    }
    data.set(key, value);
    this.size = data.size;
    return this;
  }
  function Stack(entries) {
    var data = this.__data__ = new ListCache(entries);
    this.size = data.size;
  }
  Stack.prototype.clear = stackClear;
  Stack.prototype["delete"] = stackDelete;
  Stack.prototype.get = stackGet;
  Stack.prototype.has = stackHas;
  Stack.prototype.set = stackSet;
  var freeExports = typeof exports == "object" && exports && !exports.nodeType && exports;
  var freeModule = freeExports && typeof module == "object" && module && !module.nodeType && module;
  var moduleExports = freeModule && freeModule.exports === freeExports;
  var Buffer = moduleExports ? root$1.Buffer : void 0, allocUnsafe = Buffer ? Buffer.allocUnsafe : void 0;
  function cloneBuffer(buffer, isDeep) {
    if (isDeep) {
      return buffer.slice();
    }
    var length = buffer.length, result2 = allocUnsafe ? allocUnsafe(length) : new buffer.constructor(length);
    buffer.copy(result2);
    return result2;
  }
  function arrayFilter(array2, predicate) {
    var index = -1, length = array2 == null ? 0 : array2.length, resIndex = 0, result2 = [];
    while (++index < length) {
      var value = array2[index];
      if (predicate(value, index, array2)) {
        result2[resIndex++] = value;
      }
    }
    return result2;
  }
  function stubArray() {
    return [];
  }
  var objectProto$1 = Object.prototype;
  var propertyIsEnumerable = objectProto$1.propertyIsEnumerable;
  var nativeGetSymbols = Object.getOwnPropertySymbols;
  var getSymbols = !nativeGetSymbols ? stubArray : function(object2) {
    if (object2 == null) {
      return [];
    }
    object2 = Object(object2);
    return arrayFilter(nativeGetSymbols(object2), function(symbol) {
      return propertyIsEnumerable.call(object2, symbol);
    });
  };
  function baseGetAllKeys(object2, keysFunc, symbolsFunc) {
    var result2 = keysFunc(object2);
    return isArray(object2) ? result2 : arrayPush(result2, symbolsFunc(object2));
  }
  function getAllKeys(object2) {
    return baseGetAllKeys(object2, keys, getSymbols);
  }
  var DataView$1 = getNative(root$1, "DataView");
  var Promise$1 = getNative(root$1, "Promise");
  var Set$1 = getNative(root$1, "Set");
  var mapTag$3 = "[object Map]", objectTag$1 = "[object Object]", promiseTag = "[object Promise]", setTag$3 = "[object Set]", weakMapTag$1 = "[object WeakMap]";
  var dataViewTag$2 = "[object DataView]";
  var dataViewCtorString = toSource(DataView$1), mapCtorString = toSource(Map$1), promiseCtorString = toSource(Promise$1), setCtorString = toSource(Set$1), weakMapCtorString = toSource(WeakMap$1);
  var getTag = baseGetTag;
  if (DataView$1 && getTag(new DataView$1(new ArrayBuffer(1))) != dataViewTag$2 || Map$1 && getTag(new Map$1()) != mapTag$3 || Promise$1 && getTag(Promise$1.resolve()) != promiseTag || Set$1 && getTag(new Set$1()) != setTag$3 || WeakMap$1 && getTag(new WeakMap$1()) != weakMapTag$1) {
    getTag = function(value) {
      var result2 = baseGetTag(value), Ctor = result2 == objectTag$1 ? value.constructor : void 0, ctorString = Ctor ? toSource(Ctor) : "";
      if (ctorString) {
        switch (ctorString) {
          case dataViewCtorString:
            return dataViewTag$2;
          case mapCtorString:
            return mapTag$3;
          case promiseCtorString:
            return promiseTag;
          case setCtorString:
            return setTag$3;
          case weakMapCtorString:
            return weakMapTag$1;
        }
      }
      return result2;
    };
  }
  var objectProto = Object.prototype;
  var hasOwnProperty = objectProto.hasOwnProperty;
  function initCloneArray(array2) {
    var length = array2.length, result2 = new array2.constructor(length);
    if (length && typeof array2[0] == "string" && hasOwnProperty.call(array2, "index")) {
      result2.index = array2.index;
      result2.input = array2.input;
    }
    return result2;
  }
  var Uint8Array$1 = root$1.Uint8Array;
  function cloneArrayBuffer(arrayBuffer) {
    var result2 = new arrayBuffer.constructor(arrayBuffer.byteLength);
    new Uint8Array$1(result2).set(new Uint8Array$1(arrayBuffer));
    return result2;
  }
  function cloneDataView(dataView, isDeep) {
    var buffer = cloneArrayBuffer(dataView.buffer);
    return new dataView.constructor(buffer, dataView.byteOffset, dataView.byteLength);
  }
  var reFlags = /\w*$/;
  function cloneRegExp(regexp) {
    var result2 = new regexp.constructor(regexp.source, reFlags.exec(regexp));
    result2.lastIndex = regexp.lastIndex;
    return result2;
  }
  var symbolProto = Symbol$1 ? Symbol$1.prototype : void 0, symbolValueOf = symbolProto ? symbolProto.valueOf : void 0;
  function cloneSymbol(symbol) {
    return symbolValueOf ? Object(symbolValueOf.call(symbol)) : {};
  }
  function cloneTypedArray(typedArray, isDeep) {
    var buffer = isDeep ? cloneArrayBuffer(typedArray.buffer) : typedArray.buffer;
    return new typedArray.constructor(buffer, typedArray.byteOffset, typedArray.length);
  }
  var boolTag$1 = "[object Boolean]", dateTag$1 = "[object Date]", mapTag$2 = "[object Map]", numberTag$1 = "[object Number]", regexpTag$1 = "[object RegExp]", setTag$2 = "[object Set]", stringTag$1 = "[object String]", symbolTag$1 = "[object Symbol]";
  var arrayBufferTag$1 = "[object ArrayBuffer]", dataViewTag$1 = "[object DataView]", float32Tag$1 = "[object Float32Array]", float64Tag$1 = "[object Float64Array]", int8Tag$1 = "[object Int8Array]", int16Tag$1 = "[object Int16Array]", int32Tag$1 = "[object Int32Array]", uint8Tag$1 = "[object Uint8Array]", uint8ClampedTag$1 = "[object Uint8ClampedArray]", uint16Tag$1 = "[object Uint16Array]", uint32Tag$1 = "[object Uint32Array]";
  function initCloneByTag(object2, tag, isDeep) {
    var Ctor = object2.constructor;
    switch (tag) {
      case arrayBufferTag$1:
        return cloneArrayBuffer(object2);
      case boolTag$1:
      case dateTag$1:
        return new Ctor(+object2);
      case dataViewTag$1:
        return cloneDataView(object2);
      case float32Tag$1:
      case float64Tag$1:
      case int8Tag$1:
      case int16Tag$1:
      case int32Tag$1:
      case uint8Tag$1:
      case uint8ClampedTag$1:
      case uint16Tag$1:
      case uint32Tag$1:
        return cloneTypedArray(object2, isDeep);
      case mapTag$2:
        return new Ctor();
      case numberTag$1:
      case stringTag$1:
        return new Ctor(object2);
      case regexpTag$1:
        return cloneRegExp(object2);
      case setTag$2:
        return new Ctor();
      case symbolTag$1:
        return cloneSymbol(object2);
    }
  }
  function initCloneObject(object2) {
    return typeof object2.constructor == "function" && !isPrototype(object2) ? baseCreate(getPrototype(object2)) : {};
  }
  var mapTag$1 = "[object Map]";
  function baseIsMap(value) {
    return isObjectLike(value) && getTag(value) == mapTag$1;
  }
  var nodeIsMap = nodeUtil && nodeUtil.isMap;
  var isMap = nodeIsMap ? baseUnary(nodeIsMap) : baseIsMap;
  var setTag$1 = "[object Set]";
  function baseIsSet(value) {
    return isObjectLike(value) && getTag(value) == setTag$1;
  }
  var nodeIsSet = nodeUtil && nodeUtil.isSet;
  var isSet = nodeIsSet ? baseUnary(nodeIsSet) : baseIsSet;
  var CLONE_DEEP_FLAG$1 = 1;
  var argsTag = "[object Arguments]", arrayTag = "[object Array]", boolTag = "[object Boolean]", dateTag = "[object Date]", errorTag = "[object Error]", funcTag = "[object Function]", genTag = "[object GeneratorFunction]", mapTag = "[object Map]", numberTag = "[object Number]", objectTag = "[object Object]", regexpTag = "[object RegExp]", setTag = "[object Set]", stringTag = "[object String]", symbolTag = "[object Symbol]", weakMapTag = "[object WeakMap]";
  var arrayBufferTag = "[object ArrayBuffer]", dataViewTag = "[object DataView]", float32Tag = "[object Float32Array]", float64Tag = "[object Float64Array]", int8Tag = "[object Int8Array]", int16Tag = "[object Int16Array]", int32Tag = "[object Int32Array]", uint8Tag = "[object Uint8Array]", uint8ClampedTag = "[object Uint8ClampedArray]", uint16Tag = "[object Uint16Array]", uint32Tag = "[object Uint32Array]";
  var cloneableTags = {};
  cloneableTags[argsTag] = cloneableTags[arrayTag] = cloneableTags[arrayBufferTag] = cloneableTags[dataViewTag] = cloneableTags[boolTag] = cloneableTags[dateTag] = cloneableTags[float32Tag] = cloneableTags[float64Tag] = cloneableTags[int8Tag] = cloneableTags[int16Tag] = cloneableTags[int32Tag] = cloneableTags[mapTag] = cloneableTags[numberTag] = cloneableTags[objectTag] = cloneableTags[regexpTag] = cloneableTags[setTag] = cloneableTags[stringTag] = cloneableTags[symbolTag] = cloneableTags[uint8Tag] = cloneableTags[uint8ClampedTag] = cloneableTags[uint16Tag] = cloneableTags[uint32Tag] = true;
  cloneableTags[errorTag] = cloneableTags[funcTag] = cloneableTags[weakMapTag] = false;
  function baseClone(value, bitmask, customizer, key, object2, stack) {
    var result2, isDeep = bitmask & CLONE_DEEP_FLAG$1;
    if (result2 !== void 0) {
      return result2;
    }
    if (!isObject(value)) {
      return value;
    }
    var isArr = isArray(value);
    if (isArr) {
      result2 = initCloneArray(value);
    } else {
      var tag = getTag(value), isFunc = tag == funcTag || tag == genTag;
      if (isBuffer(value)) {
        return cloneBuffer(value, isDeep);
      }
      if (tag == objectTag || tag == argsTag || isFunc && !object2) {
        result2 = isFunc ? {} : initCloneObject(value);
      } else {
        if (!cloneableTags[tag]) {
          return object2 ? value : {};
        }
        result2 = initCloneByTag(value, tag, isDeep);
      }
    }
    stack || (stack = new Stack());
    var stacked = stack.get(value);
    if (stacked) {
      return stacked;
    }
    stack.set(value, result2);
    if (isSet(value)) {
      value.forEach(function(subValue) {
        result2.add(baseClone(subValue, bitmask, customizer, subValue, value, stack));
      });
    } else if (isMap(value)) {
      value.forEach(function(subValue, key2) {
        result2.set(key2, baseClone(subValue, bitmask, customizer, key2, value, stack));
      });
    }
    var keysFunc = getAllKeys;
    var props = isArr ? void 0 : keysFunc(value);
    arrayEach(props || value, function(subValue, key2) {
      if (props) {
        key2 = subValue;
        subValue = value[key2];
      }
      assignValue(result2, key2, baseClone(subValue, bitmask, customizer, key2, value, stack));
    });
    return result2;
  }
  var CLONE_DEEP_FLAG = 1, CLONE_SYMBOLS_FLAG = 4;
  function cloneDeep(value) {
    return baseClone(value, CLONE_DEEP_FLAG | CLONE_SYMBOLS_FLAG);
  }
  function createBaseFor(fromRight) {
    return function(object2, iteratee, keysFunc) {
      var index = -1, iterable = Object(object2), props = keysFunc(object2), length = props.length;
      while (length--) {
        var key = props[++index];
        if (iteratee(iterable[key], key, iterable) === false) {
          break;
        }
      }
      return object2;
    };
  }
  var baseFor = createBaseFor();
  function assignMergeValue(object2, key, value) {
    if (value !== void 0 && !eq(object2[key], value) || value === void 0 && !(key in object2)) {
      baseAssignValue(object2, key, value);
    }
  }
  function isArrayLikeObject(value) {
    return isObjectLike(value) && isArrayLike$1(value);
  }
  function safeGet(object2, key) {
    if (key === "constructor" && typeof object2[key] === "function") {
      return;
    }
    if (key == "__proto__") {
      return;
    }
    return object2[key];
  }
  function toPlainObject(value) {
    return copyObject(value, keysIn(value));
  }
  function baseMergeDeep(object2, source, key, srcIndex, mergeFunc, customizer, stack) {
    var objValue = safeGet(object2, key), srcValue = safeGet(source, key), stacked = stack.get(srcValue);
    if (stacked) {
      assignMergeValue(object2, key, stacked);
      return;
    }
    var newValue = customizer ? customizer(objValue, srcValue, key + "", object2, source, stack) : void 0;
    var isCommon = newValue === void 0;
    if (isCommon) {
      var isArr = isArray(srcValue), isBuff = !isArr && isBuffer(srcValue), isTyped = !isArr && !isBuff && isTypedArray(srcValue);
      newValue = srcValue;
      if (isArr || isBuff || isTyped) {
        if (isArray(objValue)) {
          newValue = objValue;
        } else if (isArrayLikeObject(objValue)) {
          newValue = copyArray(objValue);
        } else if (isBuff) {
          isCommon = false;
          newValue = cloneBuffer(srcValue, true);
        } else if (isTyped) {
          isCommon = false;
          newValue = cloneTypedArray(srcValue, true);
        } else {
          newValue = [];
        }
      } else if (isPlainObject(srcValue) || isArguments(srcValue)) {
        newValue = objValue;
        if (isArguments(objValue)) {
          newValue = toPlainObject(objValue);
        } else if (!isObject(objValue) || isFunction(objValue)) {
          newValue = initCloneObject(srcValue);
        }
      } else {
        isCommon = false;
      }
    }
    if (isCommon) {
      stack.set(srcValue, newValue);
      mergeFunc(newValue, srcValue, srcIndex, customizer, stack);
      stack["delete"](srcValue);
    }
    assignMergeValue(object2, key, newValue);
  }
  function baseMerge(object2, source, srcIndex, customizer, stack) {
    if (object2 === source) {
      return;
    }
    baseFor(source, function(srcValue, key) {
      stack || (stack = new Stack());
      if (isObject(srcValue)) {
        baseMergeDeep(object2, source, key, srcIndex, baseMerge, customizer, stack);
      } else {
        var newValue = customizer ? customizer(safeGet(object2, key), srcValue, key + "", object2, source, stack) : void 0;
        if (newValue === void 0) {
          newValue = srcValue;
        }
        assignMergeValue(object2, key, newValue);
      }
    }, keysIn);
  }
  var mergeWith = createAssigner(function(object2, source, srcIndex, customizer) {
    baseMerge(object2, source, srcIndex, customizer);
  });
  var AccessKeySchema = () => /* @__PURE__ */ object({
    nonce: /* @__PURE__ */ number(),
    permission: /* @__PURE__ */ _lazy(() => AccessKeyPermissionSchema())
  });
  var AccessKeyInfoViewSchema = () => /* @__PURE__ */ object({
    accessKey: /* @__PURE__ */ _lazy(() => AccessKeyViewSchema()),
    publicKey: /* @__PURE__ */ _lazy(() => PublicKeyHandleSchema())
  });
  var AccessKeyListSchema = () => /* @__PURE__ */ object({
    keys: /* @__PURE__ */ array(/* @__PURE__ */ _lazy(() => AccessKeyInfoViewSchema()))
  });
  var AccessKeyPermissionSchema = () => /* @__PURE__ */ union([
    /* @__PURE__ */ object({
      FunctionCall: /* @__PURE__ */ _lazy(() => FunctionCallPermissionSchema())
    }),
    /* @__PURE__ */ _enum(["FullAccess"]),
    /* @__PURE__ */ object({
      GasKeyFunctionCall: /* @__PURE__ */ array(/* @__PURE__ */ unknown())
    }),
    /* @__PURE__ */ object({
      GasKeyFullAccess: /* @__PURE__ */ _lazy(() => GasKeyInfoSchema())
    })
  ]);
  var AccessKeyPermissionViewSchema = () => /* @__PURE__ */ union([
    /* @__PURE__ */ _enum(["FullAccess"]),
    /* @__PURE__ */ object({
      FunctionCall: /* @__PURE__ */ object({
        allowance: /* @__PURE__ */ optional(
          /* @__PURE__ */ union([/* @__PURE__ */ _lazy(() => NearTokenSchema()), /* @__PURE__ */ _null()])
        ),
        methodNames: /* @__PURE__ */ array(/* @__PURE__ */ string()),
        receiverId: /* @__PURE__ */ string()
      })
    }),
    /* @__PURE__ */ object({
      GasKeyFunctionCall: /* @__PURE__ */ object({
        allowance: /* @__PURE__ */ optional(
          /* @__PURE__ */ union([/* @__PURE__ */ _lazy(() => NearTokenSchema()), /* @__PURE__ */ _null()])
        ),
        balance: /* @__PURE__ */ _lazy(() => NearTokenSchema()),
        methodNames: /* @__PURE__ */ array(/* @__PURE__ */ string()),
        numNonces: /* @__PURE__ */ number(),
        receiverId: /* @__PURE__ */ string()
      })
    }),
    /* @__PURE__ */ object({
      GasKeyFullAccess: /* @__PURE__ */ object({
        balance: /* @__PURE__ */ _lazy(() => NearTokenSchema()),
        numNonces: /* @__PURE__ */ number()
      })
    })
  ]);
  var AccessKeyViewSchema = () => /* @__PURE__ */ object({
    nonce: /* @__PURE__ */ number(),
    permission: /* @__PURE__ */ _lazy(() => AccessKeyPermissionViewSchema())
  });
  var AccountContractViewSchema = () => /* @__PURE__ */ union([
    /* @__PURE__ */ object({
      local: /* @__PURE__ */ _lazy(() => CryptoHashSchema())
    }),
    /* @__PURE__ */ object({
      globalHash: /* @__PURE__ */ _lazy(() => CryptoHashSchema())
    }),
    /* @__PURE__ */ object({
      globalAccountId: /* @__PURE__ */ _lazy(() => AccountIdSchema())
    })
  ]);
  var AccountIdSchema = () => /* @__PURE__ */ string();
  var AccountViewSchema = () => /* @__PURE__ */ object({
    amount: /* @__PURE__ */ _lazy(() => NearTokenSchema()),
    codeHash: /* @__PURE__ */ _lazy(() => CryptoHashSchema()),
    globalContractAccountId: /* @__PURE__ */ optional(
      /* @__PURE__ */ union([/* @__PURE__ */ _lazy(() => AccountIdSchema()), /* @__PURE__ */ _null()])
    ),
    globalContractHash: /* @__PURE__ */ optional(
      /* @__PURE__ */ union([/* @__PURE__ */ _lazy(() => CryptoHashSchema()), /* @__PURE__ */ _null()])
    ),
    locked: /* @__PURE__ */ _lazy(() => NearTokenSchema()),
    storagePaidAt: /* @__PURE__ */ optional(/* @__PURE__ */ number()),
    storageUsage: /* @__PURE__ */ number()
  });
  var ActionErrorSchema = () => /* @__PURE__ */ object({
    index: /* @__PURE__ */ optional(/* @__PURE__ */ union([/* @__PURE__ */ union([/* @__PURE__ */ number(), /* @__PURE__ */ _null()]), /* @__PURE__ */ _null()])),
    kind: /* @__PURE__ */ _lazy(() => ActionErrorKindSchema())
  });
  var ActionErrorKindSchema = () => /* @__PURE__ */ union([
    /* @__PURE__ */ object({
      AccountAlreadyExists: /* @__PURE__ */ object({
        accountId: /* @__PURE__ */ _lazy(() => AccountIdSchema())
      })
    }),
    /* @__PURE__ */ object({
      AccountDoesNotExist: /* @__PURE__ */ object({
        accountId: /* @__PURE__ */ _lazy(() => AccountIdSchema())
      })
    }),
    /* @__PURE__ */ object({
      CreateAccountOnlyByRegistrar: /* @__PURE__ */ object({
        accountId: /* @__PURE__ */ _lazy(() => AccountIdSchema()),
        predecessorId: /* @__PURE__ */ _lazy(() => AccountIdSchema()),
        registrarAccountId: /* @__PURE__ */ _lazy(() => AccountIdSchema())
      })
    }),
    /* @__PURE__ */ object({
      CreateAccountNotAllowed: /* @__PURE__ */ object({
        accountId: /* @__PURE__ */ _lazy(() => AccountIdSchema()),
        predecessorId: /* @__PURE__ */ _lazy(() => AccountIdSchema())
      })
    }),
    /* @__PURE__ */ object({
      ActorNoPermission: /* @__PURE__ */ object({
        accountId: /* @__PURE__ */ _lazy(() => AccountIdSchema()),
        actorId: /* @__PURE__ */ _lazy(() => AccountIdSchema())
      })
    }),
    /* @__PURE__ */ object({
      DeleteKeyDoesNotExist: /* @__PURE__ */ object({
        accountId: /* @__PURE__ */ _lazy(() => AccountIdSchema()),
        publicKey: /* @__PURE__ */ _lazy(() => PublicKeySchema())
      })
    }),
    /* @__PURE__ */ object({
      AddKeyAlreadyExists: /* @__PURE__ */ object({
        accountId: /* @__PURE__ */ _lazy(() => AccountIdSchema()),
        publicKey: /* @__PURE__ */ _lazy(() => PublicKeySchema())
      })
    }),
    /* @__PURE__ */ object({
      DeleteAccountStaking: /* @__PURE__ */ object({
        accountId: /* @__PURE__ */ _lazy(() => AccountIdSchema())
      })
    }),
    /* @__PURE__ */ object({
      LackBalanceForState: /* @__PURE__ */ object({
        accountId: /* @__PURE__ */ _lazy(() => AccountIdSchema()),
        amount: /* @__PURE__ */ _lazy(() => NearTokenSchema())
      })
    }),
    /* @__PURE__ */ object({
      TriesToUnstake: /* @__PURE__ */ object({
        accountId: /* @__PURE__ */ _lazy(() => AccountIdSchema())
      })
    }),
    /* @__PURE__ */ object({
      TriesToStake: /* @__PURE__ */ object({
        accountId: /* @__PURE__ */ _lazy(() => AccountIdSchema()),
        balance: /* @__PURE__ */ _lazy(() => NearTokenSchema()),
        locked: /* @__PURE__ */ _lazy(() => NearTokenSchema()),
        stake: /* @__PURE__ */ _lazy(() => NearTokenSchema())
      })
    }),
    /* @__PURE__ */ object({
      InsufficientStake: /* @__PURE__ */ object({
        accountId: /* @__PURE__ */ _lazy(() => AccountIdSchema()),
        minimumStake: /* @__PURE__ */ _lazy(() => NearTokenSchema()),
        stake: /* @__PURE__ */ _lazy(() => NearTokenSchema())
      })
    }),
    /* @__PURE__ */ object({
      FunctionCallError: /* @__PURE__ */ _lazy(() => FunctionCallErrorSchema())
    }),
    /* @__PURE__ */ object({
      NewReceiptValidationError: /* @__PURE__ */ _lazy(() => ReceiptValidationErrorSchema())
    }),
    /* @__PURE__ */ object({
      OnlyImplicitAccountCreationAllowed: /* @__PURE__ */ object({
        accountId: /* @__PURE__ */ _lazy(() => AccountIdSchema())
      })
    }),
    /* @__PURE__ */ object({
      DeleteAccountWithLargeState: /* @__PURE__ */ object({
        accountId: /* @__PURE__ */ _lazy(() => AccountIdSchema())
      })
    }),
    /* @__PURE__ */ _enum(["DelegateActionInvalidSignature"]),
    /* @__PURE__ */ object({
      DelegateActionSenderDoesNotMatchTxReceiver: /* @__PURE__ */ object({
        receiverId: /* @__PURE__ */ _lazy(() => AccountIdSchema()),
        senderId: /* @__PURE__ */ _lazy(() => AccountIdSchema())
      })
    }),
    /* @__PURE__ */ _enum(["DelegateActionExpired"]),
    /* @__PURE__ */ object({
      DelegateActionAccessKeyError: /* @__PURE__ */ _lazy(() => InvalidAccessKeyErrorSchema())
    }),
    /* @__PURE__ */ object({
      DelegateActionInvalidNonce: /* @__PURE__ */ object({
        akNonce: /* @__PURE__ */ number(),
        delegateNonce: /* @__PURE__ */ number()
      })
    }),
    /* @__PURE__ */ object({
      DelegateActionNonceTooLarge: /* @__PURE__ */ object({
        delegateNonce: /* @__PURE__ */ number(),
        upperBound: /* @__PURE__ */ number()
      })
    }),
    /* @__PURE__ */ object({
      GlobalContractDoesNotExist: /* @__PURE__ */ object({
        identifier: /* @__PURE__ */ _lazy(() => GlobalContractIdentifierSchema())
      })
    }),
    /* @__PURE__ */ object({
      GasKeyDoesNotExist: /* @__PURE__ */ object({
        accountId: /* @__PURE__ */ _lazy(() => AccountIdSchema()),
        publicKey: /* @__PURE__ */ _lazy(() => PublicKeySchema())
      })
    }),
    /* @__PURE__ */ object({
      InsufficientGasKeyBalance: /* @__PURE__ */ object({
        accountId: /* @__PURE__ */ _lazy(() => AccountIdSchema()),
        balance: /* @__PURE__ */ _lazy(() => NearTokenSchema()),
        publicKey: /* @__PURE__ */ _lazy(() => PublicKeySchema()),
        required: /* @__PURE__ */ _lazy(() => NearTokenSchema())
      })
    }),
    /* @__PURE__ */ object({
      GasKeyBalanceTooHigh: /* @__PURE__ */ object({
        accountId: /* @__PURE__ */ _lazy(() => AccountIdSchema()),
        balance: /* @__PURE__ */ _lazy(() => NearTokenSchema()),
        publicKey: /* @__PURE__ */ optional(
          /* @__PURE__ */ union([/* @__PURE__ */ _lazy(() => PublicKeySchema()), /* @__PURE__ */ _null()])
        )
      })
    }),
    /* @__PURE__ */ object({
      DelegateActionInvalidNonceIndex: /* @__PURE__ */ object({
        nonceIndex: /* @__PURE__ */ number(),
        numNonces: /* @__PURE__ */ number()
      })
    })
  ]);
  var ActionViewSchema = () => /* @__PURE__ */ union([
    /* @__PURE__ */ _enum(["CreateAccount"]),
    /* @__PURE__ */ object({
      DeployContract: /* @__PURE__ */ object({
        code: /* @__PURE__ */ string()
      })
    }),
    /* @__PURE__ */ object({
      FunctionCall: /* @__PURE__ */ object({
        args: /* @__PURE__ */ _lazy(() => FunctionArgsSchema()),
        deposit: /* @__PURE__ */ _lazy(() => NearTokenSchema()),
        gas: /* @__PURE__ */ _lazy(() => NearGasSchema()),
        methodName: /* @__PURE__ */ string()
      })
    }),
    /* @__PURE__ */ object({
      Transfer: /* @__PURE__ */ object({
        deposit: /* @__PURE__ */ _lazy(() => NearTokenSchema())
      })
    }),
    /* @__PURE__ */ object({
      Stake: /* @__PURE__ */ object({
        publicKey: /* @__PURE__ */ _lazy(() => PublicKeySchema()),
        stake: /* @__PURE__ */ _lazy(() => NearTokenSchema())
      })
    }),
    /* @__PURE__ */ object({
      AddKey: /* @__PURE__ */ object({
        accessKey: /* @__PURE__ */ _lazy(() => AccessKeyViewSchema()),
        publicKey: /* @__PURE__ */ _lazy(() => PublicKeySchema())
      })
    }),
    /* @__PURE__ */ object({
      DeleteKey: /* @__PURE__ */ object({
        publicKey: /* @__PURE__ */ _lazy(() => PublicKeySchema())
      })
    }),
    /* @__PURE__ */ object({
      DeleteAccount: /* @__PURE__ */ object({
        beneficiaryId: /* @__PURE__ */ _lazy(() => AccountIdSchema())
      })
    }),
    /* @__PURE__ */ object({
      Delegate: /* @__PURE__ */ object({
        delegateAction: /* @__PURE__ */ _lazy(() => DelegateActionSchema()),
        signature: /* @__PURE__ */ _lazy(() => SignatureSchema())
      })
    }),
    /* @__PURE__ */ object({
      DelegateV2: /* @__PURE__ */ object({
        delegateAction: /* @__PURE__ */ _lazy(() => VersionedDelegateActionPayloadSchema()),
        signature: /* @__PURE__ */ _lazy(() => SignatureSchema())
      })
    }),
    /* @__PURE__ */ object({
      DeployGlobalContract: /* @__PURE__ */ object({
        code: /* @__PURE__ */ string()
      })
    }),
    /* @__PURE__ */ object({
      DeployGlobalContractByAccountId: /* @__PURE__ */ object({
        code: /* @__PURE__ */ string()
      })
    }),
    /* @__PURE__ */ object({
      UseGlobalContract: /* @__PURE__ */ object({
        codeHash: /* @__PURE__ */ _lazy(() => CryptoHashSchema())
      })
    }),
    /* @__PURE__ */ object({
      UseGlobalContractByAccountId: /* @__PURE__ */ object({
        accountId: /* @__PURE__ */ _lazy(() => AccountIdSchema())
      })
    }),
    /* @__PURE__ */ object({
      DeterministicStateInit: /* @__PURE__ */ object({
        code: /* @__PURE__ */ _lazy(() => GlobalContractIdentifierViewSchema()),
        data: /* @__PURE__ */ record(/* @__PURE__ */ string(), /* @__PURE__ */ string()),
        deposit: /* @__PURE__ */ _lazy(() => NearTokenSchema())
      })
    }),
    /* @__PURE__ */ object({
      TransferToGasKey: /* @__PURE__ */ object({
        deposit: /* @__PURE__ */ _lazy(() => NearTokenSchema()),
        publicKey: /* @__PURE__ */ _lazy(() => PublicKeySchema())
      })
    }),
    /* @__PURE__ */ object({
      WithdrawFromGasKey: /* @__PURE__ */ object({
        amount: /* @__PURE__ */ _lazy(() => NearTokenSchema()),
        publicKey: /* @__PURE__ */ _lazy(() => PublicKeySchema())
      })
    })
  ]);
  var ActionsValidationErrorSchema = () => /* @__PURE__ */ union([
    /* @__PURE__ */ _enum(["DeleteActionMustBeFinal"]),
    /* @__PURE__ */ object({
      TotalPrepaidGasExceeded: /* @__PURE__ */ object({
        limit: /* @__PURE__ */ _lazy(() => NearGasSchema()),
        totalPrepaidGas: /* @__PURE__ */ _lazy(() => NearGasSchema())
      })
    }),
    /* @__PURE__ */ object({
      TotalNumberOfActionsExceeded: /* @__PURE__ */ object({
        limit: /* @__PURE__ */ number(),
        totalNumberOfActions: /* @__PURE__ */ number()
      })
    }),
    /* @__PURE__ */ object({
      AddKeyMethodNamesNumberOfBytesExceeded: /* @__PURE__ */ object({
        limit: /* @__PURE__ */ number(),
        totalNumberOfBytes: /* @__PURE__ */ number()
      })
    }),
    /* @__PURE__ */ object({
      AddKeyMethodNameLengthExceeded: /* @__PURE__ */ object({
        length: /* @__PURE__ */ number(),
        limit: /* @__PURE__ */ number()
      })
    }),
    /* @__PURE__ */ _enum(["IntegerOverflow"]),
    /* @__PURE__ */ object({
      InvalidAccountId: /* @__PURE__ */ object({
        accountId: /* @__PURE__ */ string()
      })
    }),
    /* @__PURE__ */ object({
      ContractSizeExceeded: /* @__PURE__ */ object({
        limit: /* @__PURE__ */ number(),
        size: /* @__PURE__ */ number()
      })
    }),
    /* @__PURE__ */ object({
      FunctionCallMethodNameLengthExceeded: /* @__PURE__ */ object({
        length: /* @__PURE__ */ number(),
        limit: /* @__PURE__ */ number()
      })
    }),
    /* @__PURE__ */ object({
      FunctionCallArgumentsLengthExceeded: /* @__PURE__ */ object({
        length: /* @__PURE__ */ number(),
        limit: /* @__PURE__ */ number()
      })
    }),
    /* @__PURE__ */ object({
      UnsuitableStakingKey: /* @__PURE__ */ object({
        publicKey: /* @__PURE__ */ _lazy(() => PublicKeySchema())
      })
    }),
    /* @__PURE__ */ _enum(["FunctionCallZeroAttachedGas"]),
    /* @__PURE__ */ _enum(["DelegateActionMustBeOnlyOne"]),
    /* @__PURE__ */ object({
      UnsupportedProtocolFeature: /* @__PURE__ */ object({
        protocolFeature: /* @__PURE__ */ string(),
        version: /* @__PURE__ */ number()
      })
    }),
    /* @__PURE__ */ object({
      InvalidDeterministicStateInitReceiver: /* @__PURE__ */ object({
        derivedId: /* @__PURE__ */ _lazy(() => AccountIdSchema()),
        receiverId: /* @__PURE__ */ _lazy(() => AccountIdSchema())
      })
    }),
    /* @__PURE__ */ object({
      DeterministicStateInitKeyLengthExceeded: /* @__PURE__ */ object({
        length: /* @__PURE__ */ number(),
        limit: /* @__PURE__ */ number()
      })
    }),
    /* @__PURE__ */ object({
      DeterministicStateInitValueLengthExceeded: /* @__PURE__ */ object({
        length: /* @__PURE__ */ number(),
        limit: /* @__PURE__ */ number()
      })
    }),
    /* @__PURE__ */ object({
      GasKeyInvalidNumNonces: /* @__PURE__ */ object({
        limit: /* @__PURE__ */ number(),
        requestedNonces: /* @__PURE__ */ number()
      })
    }),
    /* @__PURE__ */ object({
      AddGasKeyWithNonZeroBalance: /* @__PURE__ */ object({
        balance: /* @__PURE__ */ _lazy(() => NearTokenSchema())
      })
    }),
    /* @__PURE__ */ _enum(["GasKeyFunctionCallAllowanceNotAllowed"]),
    /* @__PURE__ */ object({
      TotalNumberOfDeployActionsExceeded: /* @__PURE__ */ object({
        limit: /* @__PURE__ */ number(),
        numberOfDeployActions: /* @__PURE__ */ number()
      })
    })
  ]);
  var AddKeyActionSchema = () => /* @__PURE__ */ object({
    accessKey: /* @__PURE__ */ _lazy(() => AccessKeySchema()),
    publicKey: /* @__PURE__ */ _lazy(() => PublicKeySchema())
  });
  var BandwidthRequestSchema = () => /* @__PURE__ */ object({
    requestedValuesBitmap: /* @__PURE__ */ _lazy(() => BandwidthRequestBitmapSchema()),
    toShard: /* @__PURE__ */ number()
  });
  var BandwidthRequestBitmapSchema = () => /* @__PURE__ */ object({
    data: /* @__PURE__ */ array(/* @__PURE__ */ number())
  });
  var BandwidthRequestsSchema = () => /* @__PURE__ */ object({
    V1: /* @__PURE__ */ _lazy(() => BandwidthRequestsV1Schema())
  });
  var BandwidthRequestsV1Schema = () => /* @__PURE__ */ object({
    requests: /* @__PURE__ */ array(/* @__PURE__ */ _lazy(() => BandwidthRequestSchema()))
  });
  var BlockHeaderViewSchema = () => /* @__PURE__ */ object({
    approvals: /* @__PURE__ */ array(/* @__PURE__ */ union([/* @__PURE__ */ _lazy(() => SignatureSchema()), /* @__PURE__ */ _null()])),
    blockBodyHash: /* @__PURE__ */ optional(
      /* @__PURE__ */ union([/* @__PURE__ */ _lazy(() => CryptoHashSchema()), /* @__PURE__ */ _null()])
    ),
    blockMerkleRoot: /* @__PURE__ */ _lazy(() => CryptoHashSchema()),
    blockOrdinal: /* @__PURE__ */ optional(
      /* @__PURE__ */ union([/* @__PURE__ */ union([/* @__PURE__ */ number(), /* @__PURE__ */ _null()]), /* @__PURE__ */ _null()])
    ),
    challengesResult: /* @__PURE__ */ array(/* @__PURE__ */ _lazy(() => SlashedValidatorSchema())),
    challengesRoot: /* @__PURE__ */ _lazy(() => CryptoHashSchema()),
    chunkEndorsements: /* @__PURE__ */ optional(
      /* @__PURE__ */ union([/* @__PURE__ */ union([/* @__PURE__ */ array(/* @__PURE__ */ array(/* @__PURE__ */ number())), /* @__PURE__ */ _null()]), /* @__PURE__ */ _null()])
    ),
    chunkHeadersRoot: /* @__PURE__ */ _lazy(() => CryptoHashSchema()),
    chunkMask: /* @__PURE__ */ array(/* @__PURE__ */ boolean()),
    chunkReceiptsRoot: /* @__PURE__ */ _lazy(() => CryptoHashSchema()),
    chunkTxRoot: /* @__PURE__ */ _lazy(() => CryptoHashSchema()),
    chunksIncluded: /* @__PURE__ */ number(),
    epochId: /* @__PURE__ */ _lazy(() => CryptoHashSchema()),
    epochSyncDataHash: /* @__PURE__ */ optional(
      /* @__PURE__ */ union([/* @__PURE__ */ _lazy(() => CryptoHashSchema()), /* @__PURE__ */ _null()])
    ),
    gasPrice: /* @__PURE__ */ _lazy(() => NearTokenSchema()),
    hash: /* @__PURE__ */ _lazy(() => CryptoHashSchema()),
    height: /* @__PURE__ */ number(),
    lastDsFinalBlock: /* @__PURE__ */ _lazy(() => CryptoHashSchema()),
    lastFinalBlock: /* @__PURE__ */ _lazy(() => CryptoHashSchema()),
    latestProtocolVersion: /* @__PURE__ */ number(),
    nextBpHash: /* @__PURE__ */ _lazy(() => CryptoHashSchema()),
    nextEpochId: /* @__PURE__ */ _lazy(() => CryptoHashSchema()),
    outcomeRoot: /* @__PURE__ */ _lazy(() => CryptoHashSchema()),
    prevHash: /* @__PURE__ */ _lazy(() => CryptoHashSchema()),
    prevHeight: /* @__PURE__ */ optional(
      /* @__PURE__ */ union([/* @__PURE__ */ union([/* @__PURE__ */ number(), /* @__PURE__ */ _null()]), /* @__PURE__ */ _null()])
    ),
    prevLastCertifiedBlockEpochId: /* @__PURE__ */ optional(
      /* @__PURE__ */ union([/* @__PURE__ */ _lazy(() => EpochIdSchema()), /* @__PURE__ */ _null()])
    ),
    prevStateRoot: /* @__PURE__ */ _lazy(() => CryptoHashSchema()),
    randomValue: /* @__PURE__ */ _lazy(() => CryptoHashSchema()),
    rentPaid: /* @__PURE__ */ optional(/* @__PURE__ */ _lazy(() => NearTokenSchema())),
    shardSplit: /* @__PURE__ */ optional(
      /* @__PURE__ */ union([/* @__PURE__ */ union([/* @__PURE__ */ array(/* @__PURE__ */ unknown()), /* @__PURE__ */ _null()]), /* @__PURE__ */ _null()])
    ),
    signature: /* @__PURE__ */ _lazy(() => SignatureSchema()),
    spiceChunkEndorsementStats: /* @__PURE__ */ optional(
      /* @__PURE__ */ union([
        /* @__PURE__ */ union([
          /* @__PURE__ */ array(/* @__PURE__ */ _lazy(() => SpiceChunkEndorsementStatsSchema())),
          /* @__PURE__ */ _null()
        ]),
        /* @__PURE__ */ _null()
      ])
    ),
    timestamp: /* @__PURE__ */ number(),
    timestampNanosec: /* @__PURE__ */ string(),
    totalSupply: /* @__PURE__ */ _lazy(() => NearTokenSchema()),
    validatorProposals: /* @__PURE__ */ array(/* @__PURE__ */ _lazy(() => ValidatorStakeViewSchema())),
    validatorReward: /* @__PURE__ */ optional(/* @__PURE__ */ _lazy(() => NearTokenSchema()))
  });
  var BlockIdSchema = () => /* @__PURE__ */ union([/* @__PURE__ */ number(), /* @__PURE__ */ _lazy(() => CryptoHashSchema())]);
  var BlockReferenceSchema = () => /* @__PURE__ */ union([
    /* @__PURE__ */ object({
      blockId: /* @__PURE__ */ _lazy(() => BlockIdSchema())
    }),
    /* @__PURE__ */ object({
      finality: /* @__PURE__ */ _lazy(() => FinalitySchema())
    }),
    /* @__PURE__ */ object({
      syncCheckpoint: /* @__PURE__ */ _lazy(() => SyncCheckpointSchema())
    })
  ]);
  var ChunkHeaderViewSchema = () => /* @__PURE__ */ object({
    balanceBurnt: /* @__PURE__ */ _lazy(() => NearTokenSchema()),
    bandwidthRequests: /* @__PURE__ */ optional(
      /* @__PURE__ */ union([/* @__PURE__ */ _lazy(() => BandwidthRequestsSchema()), /* @__PURE__ */ _null()])
    ),
    chunkHash: /* @__PURE__ */ _lazy(() => CryptoHashSchema()),
    congestionInfo: /* @__PURE__ */ optional(
      /* @__PURE__ */ union([/* @__PURE__ */ _lazy(() => CongestionInfoViewSchema()), /* @__PURE__ */ _null()])
    ),
    encodedLength: /* @__PURE__ */ number(),
    encodedMerkleRoot: /* @__PURE__ */ _lazy(() => CryptoHashSchema()),
    gasLimit: /* @__PURE__ */ _lazy(() => NearGasSchema()),
    gasUsed: /* @__PURE__ */ _lazy(() => NearGasSchema()),
    heightCreated: /* @__PURE__ */ number(),
    heightIncluded: /* @__PURE__ */ number(),
    outcomeRoot: /* @__PURE__ */ _lazy(() => CryptoHashSchema()),
    outgoingReceiptsRoot: /* @__PURE__ */ _lazy(() => CryptoHashSchema()),
    prevBlockHash: /* @__PURE__ */ _lazy(() => CryptoHashSchema()),
    prevStateRoot: /* @__PURE__ */ _lazy(() => CryptoHashSchema()),
    proposedSplit: /* @__PURE__ */ optional(
      /* @__PURE__ */ union([/* @__PURE__ */ _lazy(() => TrieSplitSchema()), /* @__PURE__ */ _null()])
    ),
    rentPaid: /* @__PURE__ */ optional(/* @__PURE__ */ _lazy(() => NearTokenSchema())),
    shardId: /* @__PURE__ */ _lazy(() => ShardIdSchema()),
    signature: /* @__PURE__ */ _lazy(() => SignatureSchema()),
    txRoot: /* @__PURE__ */ _lazy(() => CryptoHashSchema()),
    validatorProposals: /* @__PURE__ */ array(/* @__PURE__ */ _lazy(() => ValidatorStakeViewSchema())),
    validatorReward: /* @__PURE__ */ optional(/* @__PURE__ */ _lazy(() => NearTokenSchema()))
  });
  var CompilationErrorSchema = () => /* @__PURE__ */ union([
    /* @__PURE__ */ object({
      CodeDoesNotExist: /* @__PURE__ */ object({
        accountId: /* @__PURE__ */ _lazy(() => AccountIdSchema())
      })
    }),
    /* @__PURE__ */ object({
      PrepareError: /* @__PURE__ */ _lazy(() => PrepareErrorSchema())
    }),
    /* @__PURE__ */ object({
      WasmerCompileError: /* @__PURE__ */ object({
        msg: /* @__PURE__ */ string()
      })
    })
  ]);
  var CongestionInfoViewSchema = () => /* @__PURE__ */ object({
    allowedShard: /* @__PURE__ */ number(),
    bufferedReceiptsGas: /* @__PURE__ */ string(),
    delayedReceiptsGas: /* @__PURE__ */ string(),
    receiptBytes: /* @__PURE__ */ number()
  });
  var CostGasUsedSchema = () => /* @__PURE__ */ object({
    cost: /* @__PURE__ */ string(),
    costCategory: /* @__PURE__ */ string(),
    gasUsed: /* @__PURE__ */ string()
  });
  var CreateAccountActionSchema = () => /* @__PURE__ */ record(/* @__PURE__ */ string(), /* @__PURE__ */ unknown());
  var CryptoHashSchema = () => /* @__PURE__ */ string();
  var DataReceiverViewSchema = () => /* @__PURE__ */ object({
    dataId: /* @__PURE__ */ _lazy(() => CryptoHashSchema()),
    receiverId: /* @__PURE__ */ _lazy(() => AccountIdSchema())
  });
  var DelegateActionSchema = () => /* @__PURE__ */ object({
    actions: /* @__PURE__ */ array(/* @__PURE__ */ _lazy(() => NonDelegateActionSchema())),
    maxBlockHeight: /* @__PURE__ */ number(),
    nonce: /* @__PURE__ */ number(),
    publicKey: /* @__PURE__ */ _lazy(() => PublicKeySchema()),
    receiverId: /* @__PURE__ */ _lazy(() => AccountIdSchema()),
    senderId: /* @__PURE__ */ _lazy(() => AccountIdSchema())
  });
  var DelegateActionV2Schema = () => /* @__PURE__ */ object({
    actions: /* @__PURE__ */ array(/* @__PURE__ */ _lazy(() => NonDelegateActionSchema())),
    maxBlockHeight: /* @__PURE__ */ number(),
    nonce: /* @__PURE__ */ _lazy(() => TransactionNonceSchema()),
    publicKey: /* @__PURE__ */ _lazy(() => PublicKeySchema()),
    receiverId: /* @__PURE__ */ _lazy(() => AccountIdSchema()),
    senderId: /* @__PURE__ */ _lazy(() => AccountIdSchema())
  });
  var DeleteAccountActionSchema = () => /* @__PURE__ */ object({
    beneficiaryId: /* @__PURE__ */ _lazy(() => AccountIdSchema())
  });
  var DeleteKeyActionSchema = () => /* @__PURE__ */ object({
    publicKey: /* @__PURE__ */ _lazy(() => PublicKeySchema())
  });
  var DeployContractActionSchema = () => /* @__PURE__ */ object({
    code: /* @__PURE__ */ string()
  });
  var DeployGlobalContractActionSchema = () => /* @__PURE__ */ object({
    code: /* @__PURE__ */ string(),
    deployMode: /* @__PURE__ */ _lazy(() => GlobalContractDeployModeSchema())
  });
  var DepositCostFailureReasonSchema = () => /* @__PURE__ */ _enum(["NotEnoughBalance", "LackBalanceForState"]);
  var DeterministicAccountStateInitSchema = () => /* @__PURE__ */ object({
    V1: /* @__PURE__ */ _lazy(() => DeterministicAccountStateInitV1Schema())
  });
  var DeterministicAccountStateInitV1Schema = () => /* @__PURE__ */ object({
    code: /* @__PURE__ */ _lazy(() => GlobalContractIdentifierSchema()),
    data: /* @__PURE__ */ record(/* @__PURE__ */ string(), /* @__PURE__ */ string())
  });
  var DeterministicStateInitActionSchema = () => /* @__PURE__ */ object({
    deposit: /* @__PURE__ */ _lazy(() => NearTokenSchema()),
    stateInit: /* @__PURE__ */ _lazy(() => DeterministicAccountStateInitSchema())
  });
  var DirectionSchema = () => /* @__PURE__ */ _enum(["Left", "Right"]);
  var EpochIdSchema = () => /* @__PURE__ */ _lazy(() => CryptoHashSchema());
  var ErrorWrapperFor_RpcBlockErrorSchema = () => /* @__PURE__ */ union([
    /* @__PURE__ */ object({
      cause: /* @__PURE__ */ _lazy(() => RpcRequestValidationErrorKindSchema()),
      name: /* @__PURE__ */ _enum(["REQUEST_VALIDATION_ERROR"])
    }),
    /* @__PURE__ */ object({
      cause: /* @__PURE__ */ _lazy(() => RpcBlockErrorSchema()),
      name: /* @__PURE__ */ _enum(["HANDLER_ERROR"])
    }),
    /* @__PURE__ */ object({
      cause: /* @__PURE__ */ _lazy(() => InternalErrorSchema()),
      name: /* @__PURE__ */ _enum(["INTERNAL_ERROR"])
    })
  ]);
  var ErrorWrapperFor_RpcQueryErrorSchema = () => /* @__PURE__ */ union([
    /* @__PURE__ */ object({
      cause: /* @__PURE__ */ _lazy(() => RpcRequestValidationErrorKindSchema()),
      name: /* @__PURE__ */ _enum(["REQUEST_VALIDATION_ERROR"])
    }),
    /* @__PURE__ */ object({
      cause: /* @__PURE__ */ _lazy(() => RpcQueryErrorSchema()),
      name: /* @__PURE__ */ _enum(["HANDLER_ERROR"])
    }),
    /* @__PURE__ */ object({
      cause: /* @__PURE__ */ _lazy(() => InternalErrorSchema()),
      name: /* @__PURE__ */ _enum(["INTERNAL_ERROR"])
    })
  ]);
  var ErrorWrapperFor_RpcTransactionErrorSchema = () => /* @__PURE__ */ union([
    /* @__PURE__ */ object({
      cause: /* @__PURE__ */ _lazy(() => RpcRequestValidationErrorKindSchema()),
      name: /* @__PURE__ */ _enum(["REQUEST_VALIDATION_ERROR"])
    }),
    /* @__PURE__ */ object({
      cause: /* @__PURE__ */ _lazy(() => RpcTransactionErrorSchema()),
      name: /* @__PURE__ */ _enum(["HANDLER_ERROR"])
    }),
    /* @__PURE__ */ object({
      cause: /* @__PURE__ */ _lazy(() => InternalErrorSchema()),
      name: /* @__PURE__ */ _enum(["INTERNAL_ERROR"])
    })
  ]);
  var ExecutionMetadataViewSchema = () => /* @__PURE__ */ object({
    contracts: /* @__PURE__ */ optional(
      /* @__PURE__ */ union([
        /* @__PURE__ */ union([
          /* @__PURE__ */ array(
            /* @__PURE__ */ union([/* @__PURE__ */ _lazy(() => AccountContractViewSchema()), /* @__PURE__ */ _null()])
          ),
          /* @__PURE__ */ _null()
        ]),
        /* @__PURE__ */ _null()
      ])
    ),
    gasProfile: /* @__PURE__ */ optional(
      /* @__PURE__ */ union([
        /* @__PURE__ */ union([/* @__PURE__ */ array(/* @__PURE__ */ _lazy(() => CostGasUsedSchema())), /* @__PURE__ */ _null()]),
        /* @__PURE__ */ _null()
      ])
    ),
    version: /* @__PURE__ */ number()
  });
  var ExecutionOutcomeViewSchema = () => /* @__PURE__ */ object({
    executorId: /* @__PURE__ */ _lazy(() => AccountIdSchema()),
    gasBurnt: /* @__PURE__ */ _lazy(() => NearGasSchema()),
    logs: /* @__PURE__ */ array(/* @__PURE__ */ string()),
    metadata: /* @__PURE__ */ optional(/* @__PURE__ */ _lazy(() => ExecutionMetadataViewSchema())),
    receiptIds: /* @__PURE__ */ array(/* @__PURE__ */ _lazy(() => CryptoHashSchema())),
    status: /* @__PURE__ */ _lazy(() => ExecutionStatusViewSchema()),
    tokensBurnt: /* @__PURE__ */ _lazy(() => NearTokenSchema())
  });
  var ExecutionOutcomeWithIdViewSchema = () => /* @__PURE__ */ object({
    blockHash: /* @__PURE__ */ _lazy(() => CryptoHashSchema()),
    id: /* @__PURE__ */ _lazy(() => CryptoHashSchema()),
    outcome: /* @__PURE__ */ _lazy(() => ExecutionOutcomeViewSchema()),
    proof: /* @__PURE__ */ array(/* @__PURE__ */ _lazy(() => MerklePathItemSchema()))
  });
  var ExecutionStatusViewSchema = () => /* @__PURE__ */ union([
    /* @__PURE__ */ _enum(["Unknown"]),
    /* @__PURE__ */ object({
      Failure: /* @__PURE__ */ _lazy(() => TxExecutionErrorSchema())
    }),
    /* @__PURE__ */ object({
      SuccessValue: /* @__PURE__ */ string()
    }),
    /* @__PURE__ */ object({
      SuccessReceiptId: /* @__PURE__ */ _lazy(() => CryptoHashSchema())
    })
  ]);
  var FinalExecutionOutcomeViewSchema = () => /* @__PURE__ */ object({
    receiptsOutcome: /* @__PURE__ */ array(/* @__PURE__ */ _lazy(() => ExecutionOutcomeWithIdViewSchema())),
    status: /* @__PURE__ */ _lazy(() => FinalExecutionStatusSchema()),
    transaction: /* @__PURE__ */ _lazy(() => SignedTransactionViewSchema()),
    transactionOutcome: /* @__PURE__ */ _lazy(() => ExecutionOutcomeWithIdViewSchema())
  });
  var FinalExecutionOutcomeWithReceiptViewSchema = () => /* @__PURE__ */ object({
    receipts: /* @__PURE__ */ array(/* @__PURE__ */ _lazy(() => ReceiptViewSchema())),
    receiptsOutcome: /* @__PURE__ */ array(/* @__PURE__ */ _lazy(() => ExecutionOutcomeWithIdViewSchema())),
    status: /* @__PURE__ */ _lazy(() => FinalExecutionStatusSchema()),
    transaction: /* @__PURE__ */ _lazy(() => SignedTransactionViewSchema()),
    transactionOutcome: /* @__PURE__ */ _lazy(() => ExecutionOutcomeWithIdViewSchema())
  });
  var FinalExecutionStatusSchema = () => /* @__PURE__ */ union([
    /* @__PURE__ */ _enum(["NotStarted"]),
    /* @__PURE__ */ _enum(["Started"]),
    /* @__PURE__ */ object({
      Failure: /* @__PURE__ */ _lazy(() => TxExecutionErrorSchema())
    }),
    /* @__PURE__ */ object({
      SuccessValue: /* @__PURE__ */ string()
    })
  ]);
  var FinalitySchema = () => /* @__PURE__ */ _enum(["optimistic", "near-final", "final"]);
  var FunctionArgsSchema = () => /* @__PURE__ */ string();
  var FunctionCallActionSchema = () => /* @__PURE__ */ object({
    args: /* @__PURE__ */ string(),
    deposit: /* @__PURE__ */ _lazy(() => NearTokenSchema()),
    gas: /* @__PURE__ */ _lazy(() => NearGasSchema()),
    methodName: /* @__PURE__ */ string()
  });
  var FunctionCallErrorSchema = () => /* @__PURE__ */ union([
    /* @__PURE__ */ _enum(["WasmUnknownError", "_EVMError"]),
    /* @__PURE__ */ object({
      CompilationError: /* @__PURE__ */ _lazy(() => CompilationErrorSchema())
    }),
    /* @__PURE__ */ object({
      LinkError: /* @__PURE__ */ object({
        msg: /* @__PURE__ */ string()
      })
    }),
    /* @__PURE__ */ object({
      MethodResolveError: /* @__PURE__ */ _lazy(() => MethodResolveErrorSchema())
    }),
    /* @__PURE__ */ object({
      WasmTrap: /* @__PURE__ */ _lazy(() => WasmTrapSchema())
    }),
    /* @__PURE__ */ object({
      HostError: /* @__PURE__ */ _lazy(() => HostErrorSchema())
    }),
    /* @__PURE__ */ object({
      ExecutionError: /* @__PURE__ */ string()
    })
  ]);
  var FunctionCallPermissionSchema = () => /* @__PURE__ */ object({
    allowance: /* @__PURE__ */ optional(/* @__PURE__ */ union([/* @__PURE__ */ _lazy(() => NearTokenSchema()), /* @__PURE__ */ _null()])),
    methodNames: /* @__PURE__ */ array(/* @__PURE__ */ string()),
    receiverId: /* @__PURE__ */ string()
  });
  var GasKeyInfoSchema = () => /* @__PURE__ */ object({
    balance: /* @__PURE__ */ _lazy(() => NearTokenSchema()),
    numNonces: /* @__PURE__ */ number()
  });
  var GlobalContractDeployModeSchema = () => /* @__PURE__ */ union([/* @__PURE__ */ _enum(["CodeHash"]), /* @__PURE__ */ _enum(["AccountId"])]);
  var GlobalContractIdentifierSchema = () => /* @__PURE__ */ union([
    /* @__PURE__ */ object({
      hash: /* @__PURE__ */ _lazy(() => CryptoHashSchema())
    }),
    /* @__PURE__ */ object({
      accountId: /* @__PURE__ */ _lazy(() => AccountIdSchema())
    })
  ]);
  var GlobalContractIdentifierViewSchema = () => /* @__PURE__ */ union([
    /* @__PURE__ */ object({
      hash: /* @__PURE__ */ _lazy(() => CryptoHashSchema())
    }),
    /* @__PURE__ */ object({
      accountId: /* @__PURE__ */ _lazy(() => AccountIdSchema())
    })
  ]);
  var HostErrorSchema = () => /* @__PURE__ */ union([
    /* @__PURE__ */ _enum(["BadUTF16"]),
    /* @__PURE__ */ _enum(["BadUTF8"]),
    /* @__PURE__ */ _enum(["GasExceeded"]),
    /* @__PURE__ */ _enum(["GasLimitExceeded"]),
    /* @__PURE__ */ _enum(["BalanceExceeded"]),
    /* @__PURE__ */ _enum(["EmptyMethodName"]),
    /* @__PURE__ */ object({
      GuestPanic: /* @__PURE__ */ object({
        panicMsg: /* @__PURE__ */ string()
      })
    }),
    /* @__PURE__ */ _enum(["IntegerOverflow"]),
    /* @__PURE__ */ object({
      InvalidPromiseIndex: /* @__PURE__ */ object({
        promiseIdx: /* @__PURE__ */ number()
      })
    }),
    /* @__PURE__ */ _enum(["CannotAppendActionToJointPromise"]),
    /* @__PURE__ */ _enum(["CannotReturnJointPromise"]),
    /* @__PURE__ */ object({
      InvalidPromiseResultIndex: /* @__PURE__ */ object({
        resultIdx: /* @__PURE__ */ number()
      })
    }),
    /* @__PURE__ */ object({
      InvalidRegisterId: /* @__PURE__ */ object({
        registerId: /* @__PURE__ */ number()
      })
    }),
    /* @__PURE__ */ object({
      IteratorWasInvalidated: /* @__PURE__ */ object({
        iteratorIndex: /* @__PURE__ */ number()
      })
    }),
    /* @__PURE__ */ _enum(["MemoryAccessViolation"]),
    /* @__PURE__ */ object({
      InvalidReceiptIndex: /* @__PURE__ */ object({
        receiptIndex: /* @__PURE__ */ number()
      })
    }),
    /* @__PURE__ */ object({
      InvalidIteratorIndex: /* @__PURE__ */ object({
        iteratorIndex: /* @__PURE__ */ number()
      })
    }),
    /* @__PURE__ */ _enum(["InvalidAccountId"]),
    /* @__PURE__ */ _enum(["InvalidMethodName"]),
    /* @__PURE__ */ _enum(["InvalidPublicKey"]),
    /* @__PURE__ */ object({
      ProhibitedInView: /* @__PURE__ */ object({
        methodName: /* @__PURE__ */ string()
      })
    }),
    /* @__PURE__ */ object({
      NumberOfLogsExceeded: /* @__PURE__ */ object({
        limit: /* @__PURE__ */ number()
      })
    }),
    /* @__PURE__ */ object({
      KeyLengthExceeded: /* @__PURE__ */ object({
        length: /* @__PURE__ */ number(),
        limit: /* @__PURE__ */ number()
      })
    }),
    /* @__PURE__ */ object({
      ValueLengthExceeded: /* @__PURE__ */ object({
        length: /* @__PURE__ */ number(),
        limit: /* @__PURE__ */ number()
      })
    }),
    /* @__PURE__ */ object({
      TotalLogLengthExceeded: /* @__PURE__ */ object({
        length: /* @__PURE__ */ number(),
        limit: /* @__PURE__ */ number()
      })
    }),
    /* @__PURE__ */ object({
      NumberPromisesExceeded: /* @__PURE__ */ object({
        limit: /* @__PURE__ */ number(),
        numberOfPromises: /* @__PURE__ */ number()
      })
    }),
    /* @__PURE__ */ object({
      NumberInputDataDependenciesExceeded: /* @__PURE__ */ object({
        limit: /* @__PURE__ */ number(),
        numberOfInputDataDependencies: /* @__PURE__ */ number()
      })
    }),
    /* @__PURE__ */ object({
      ReturnedValueLengthExceeded: /* @__PURE__ */ object({
        length: /* @__PURE__ */ number(),
        limit: /* @__PURE__ */ number()
      })
    }),
    /* @__PURE__ */ object({
      ContractSizeExceeded: /* @__PURE__ */ object({
        limit: /* @__PURE__ */ number(),
        size: /* @__PURE__ */ number()
      })
    }),
    /* @__PURE__ */ object({
      Deprecated: /* @__PURE__ */ object({
        methodName: /* @__PURE__ */ string()
      })
    }),
    /* @__PURE__ */ object({
      ECRecoverError: /* @__PURE__ */ object({
        msg: /* @__PURE__ */ string()
      })
    }),
    /* @__PURE__ */ object({
      AltBn128InvalidInput: /* @__PURE__ */ object({
        msg: /* @__PURE__ */ string()
      })
    }),
    /* @__PURE__ */ object({
      Ed25519VerifyInvalidInput: /* @__PURE__ */ object({
        msg: /* @__PURE__ */ string()
      })
    }),
    /* @__PURE__ */ object({
      P256VerifyInvalidInput: /* @__PURE__ */ object({
        msg: /* @__PURE__ */ string()
      })
    })
  ]);
  var InternalErrorSchema = () => /* @__PURE__ */ object({
    info: /* @__PURE__ */ object({
      errorMessage: /* @__PURE__ */ string()
    }),
    name: /* @__PURE__ */ _enum(["INTERNAL_ERROR"])
  });
  var InvalidAccessKeyErrorSchema = () => /* @__PURE__ */ union([
    /* @__PURE__ */ object({
      AccessKeyNotFound: /* @__PURE__ */ object({
        accountId: /* @__PURE__ */ _lazy(() => AccountIdSchema()),
        publicKey: /* @__PURE__ */ _lazy(() => PublicKeySchema())
      })
    }),
    /* @__PURE__ */ object({
      ReceiverMismatch: /* @__PURE__ */ object({
        akReceiver: /* @__PURE__ */ string(),
        txReceiver: /* @__PURE__ */ _lazy(() => AccountIdSchema())
      })
    }),
    /* @__PURE__ */ object({
      MethodNameMismatch: /* @__PURE__ */ object({
        methodName: /* @__PURE__ */ string()
      })
    }),
    /* @__PURE__ */ _enum(["RequiresFullAccess"]),
    /* @__PURE__ */ object({
      NotEnoughAllowance: /* @__PURE__ */ object({
        accountId: /* @__PURE__ */ _lazy(() => AccountIdSchema()),
        allowance: /* @__PURE__ */ _lazy(() => NearTokenSchema()),
        cost: /* @__PURE__ */ _lazy(() => NearTokenSchema()),
        publicKey: /* @__PURE__ */ _lazy(() => PublicKeySchema())
      })
    }),
    /* @__PURE__ */ _enum(["DepositWithFunctionCall"]),
    /* @__PURE__ */ _enum(["DelegateActionRequiresNonGasKey"]),
    /* @__PURE__ */ _enum(["DelegateActionRequiresGasKey"])
  ]);
  var InvalidTxErrorSchema = () => /* @__PURE__ */ union([
    /* @__PURE__ */ object({
      InvalidAccessKeyError: /* @__PURE__ */ _lazy(() => InvalidAccessKeyErrorSchema())
    }),
    /* @__PURE__ */ object({
      InvalidSignerId: /* @__PURE__ */ object({
        signerId: /* @__PURE__ */ string()
      })
    }),
    /* @__PURE__ */ object({
      SignerDoesNotExist: /* @__PURE__ */ object({
        signerId: /* @__PURE__ */ _lazy(() => AccountIdSchema())
      })
    }),
    /* @__PURE__ */ object({
      InvalidNonce: /* @__PURE__ */ object({
        akNonce: /* @__PURE__ */ number(),
        txNonce: /* @__PURE__ */ number()
      })
    }),
    /* @__PURE__ */ object({
      NonceTooLarge: /* @__PURE__ */ object({
        txNonce: /* @__PURE__ */ number(),
        upperBound: /* @__PURE__ */ number()
      })
    }),
    /* @__PURE__ */ object({
      InvalidReceiverId: /* @__PURE__ */ object({
        receiverId: /* @__PURE__ */ string()
      })
    }),
    /* @__PURE__ */ _enum(["InvalidSignature"]),
    /* @__PURE__ */ object({
      NotEnoughBalance: /* @__PURE__ */ object({
        balance: /* @__PURE__ */ _lazy(() => NearTokenSchema()),
        cost: /* @__PURE__ */ _lazy(() => NearTokenSchema()),
        signerId: /* @__PURE__ */ _lazy(() => AccountIdSchema())
      })
    }),
    /* @__PURE__ */ object({
      LackBalanceForState: /* @__PURE__ */ object({
        amount: /* @__PURE__ */ _lazy(() => NearTokenSchema()),
        signerId: /* @__PURE__ */ _lazy(() => AccountIdSchema())
      })
    }),
    /* @__PURE__ */ _enum(["CostOverflow"]),
    /* @__PURE__ */ _enum(["InvalidChain"]),
    /* @__PURE__ */ _enum(["Expired"]),
    /* @__PURE__ */ object({
      ActionsValidation: /* @__PURE__ */ _lazy(() => ActionsValidationErrorSchema())
    }),
    /* @__PURE__ */ object({
      TransactionSizeExceeded: /* @__PURE__ */ object({
        limit: /* @__PURE__ */ number(),
        size: /* @__PURE__ */ number()
      })
    }),
    /* @__PURE__ */ _enum(["InvalidTransactionVersion"]),
    /* @__PURE__ */ object({
      StorageError: /* @__PURE__ */ _lazy(() => StorageErrorSchema())
    }),
    /* @__PURE__ */ object({
      ShardCongested: /* @__PURE__ */ object({
        congestionLevel: /* @__PURE__ */ number(),
        shardId: /* @__PURE__ */ number()
      })
    }),
    /* @__PURE__ */ object({
      ShardStuck: /* @__PURE__ */ object({
        missedChunks: /* @__PURE__ */ number(),
        shardId: /* @__PURE__ */ number()
      })
    }),
    /* @__PURE__ */ object({
      InvalidNonceIndex: /* @__PURE__ */ object({
        numNonces: /* @__PURE__ */ number(),
        txNonceIndex: /* @__PURE__ */ optional(
          /* @__PURE__ */ union([/* @__PURE__ */ union([/* @__PURE__ */ number(), /* @__PURE__ */ _null()]), /* @__PURE__ */ _null()])
        )
      })
    }),
    /* @__PURE__ */ object({
      NotEnoughGasKeyBalance: /* @__PURE__ */ object({
        balance: /* @__PURE__ */ _lazy(() => NearTokenSchema()),
        cost: /* @__PURE__ */ _lazy(() => NearTokenSchema()),
        signerId: /* @__PURE__ */ _lazy(() => AccountIdSchema())
      })
    }),
    /* @__PURE__ */ object({
      NotEnoughBalanceForDeposit: /* @__PURE__ */ object({
        balance: /* @__PURE__ */ _lazy(() => NearTokenSchema()),
        cost: /* @__PURE__ */ _lazy(() => NearTokenSchema()),
        reason: /* @__PURE__ */ _lazy(() => DepositCostFailureReasonSchema()),
        signerId: /* @__PURE__ */ _lazy(() => AccountIdSchema())
      })
    })
  ]);
  var MerklePathItemSchema = () => /* @__PURE__ */ object({
    direction: /* @__PURE__ */ _lazy(() => DirectionSchema()),
    hash: /* @__PURE__ */ _lazy(() => CryptoHashSchema())
  });
  var MethodResolveErrorSchema = () => /* @__PURE__ */ _enum(["MethodEmptyName", "MethodNotFound", "MethodInvalidSignature"]);
  var MissingTrieValueSchema = () => /* @__PURE__ */ object({
    context: /* @__PURE__ */ _lazy(() => MissingTrieValueContextSchema()),
    hash: /* @__PURE__ */ _lazy(() => CryptoHashSchema())
  });
  var MissingTrieValueContextSchema = () => /* @__PURE__ */ union([
    /* @__PURE__ */ _enum(["TrieIterator"]),
    /* @__PURE__ */ _enum(["TriePrefetchingStorage"]),
    /* @__PURE__ */ _enum(["TrieMemoryPartialStorage"]),
    /* @__PURE__ */ _enum(["TrieStorage"])
  ]);
  var NearGasSchema = () => /* @__PURE__ */ number();
  var NearTokenSchema = () => /* @__PURE__ */ string();
  var NonDelegateActionSchema = () => /* @__PURE__ */ union([
    /* @__PURE__ */ object({
      CreateAccount: /* @__PURE__ */ _lazy(() => CreateAccountActionSchema())
    }),
    /* @__PURE__ */ object({
      DeployContract: /* @__PURE__ */ _lazy(() => DeployContractActionSchema())
    }),
    /* @__PURE__ */ object({
      FunctionCall: /* @__PURE__ */ _lazy(() => FunctionCallActionSchema())
    }),
    /* @__PURE__ */ object({
      Transfer: /* @__PURE__ */ _lazy(() => TransferActionSchema())
    }),
    /* @__PURE__ */ object({
      Stake: /* @__PURE__ */ _lazy(() => StakeActionSchema())
    }),
    /* @__PURE__ */ object({
      AddKey: /* @__PURE__ */ _lazy(() => AddKeyActionSchema())
    }),
    /* @__PURE__ */ object({
      DeleteKey: /* @__PURE__ */ _lazy(() => DeleteKeyActionSchema())
    }),
    /* @__PURE__ */ object({
      DeleteAccount: /* @__PURE__ */ _lazy(() => DeleteAccountActionSchema())
    }),
    /* @__PURE__ */ object({
      DeployGlobalContract: /* @__PURE__ */ _lazy(() => DeployGlobalContractActionSchema())
    }),
    /* @__PURE__ */ object({
      UseGlobalContract: /* @__PURE__ */ _lazy(() => UseGlobalContractActionSchema())
    }),
    /* @__PURE__ */ object({
      DeterministicStateInit: /* @__PURE__ */ _lazy(
        () => DeterministicStateInitActionSchema()
      )
    }),
    /* @__PURE__ */ object({
      TransferToGasKey: /* @__PURE__ */ _lazy(() => TransferToGasKeyActionSchema())
    }),
    /* @__PURE__ */ object({
      WithdrawFromGasKey: /* @__PURE__ */ _lazy(() => WithdrawFromGasKeyActionSchema())
    })
  ]);
  var NonceModeSchema = () => /* @__PURE__ */ union([/* @__PURE__ */ _enum(["monotonic"]), /* @__PURE__ */ _enum(["strict"])]);
  var PrepareErrorSchema = () => /* @__PURE__ */ union([
    /* @__PURE__ */ _enum(["Serialization"]),
    /* @__PURE__ */ _enum(["Deserialization"]),
    /* @__PURE__ */ _enum(["InternalMemoryDeclared"]),
    /* @__PURE__ */ _enum(["GasInstrumentation"]),
    /* @__PURE__ */ _enum(["StackHeightInstrumentation"]),
    /* @__PURE__ */ _enum(["Instantiate"]),
    /* @__PURE__ */ _enum(["Memory"]),
    /* @__PURE__ */ _enum(["TooManyFunctions"]),
    /* @__PURE__ */ _enum(["TooManyLocals"]),
    /* @__PURE__ */ _enum(["TooManyTables"]),
    /* @__PURE__ */ _enum(["TooManyTableElements"]),
    /* @__PURE__ */ _enum(["FunctionBodyTooLarge"]),
    /* @__PURE__ */ _enum(["InstrumentedCodeTooLarge"]),
    /* @__PURE__ */ _enum(["TooManyBlocksPerFunction"]),
    /* @__PURE__ */ _enum(["TooManyBlocksPerContract"]),
    /* @__PURE__ */ _enum(["TooManyTypes"]),
    /* @__PURE__ */ _enum(["TooManyParamsPerFunction"]),
    /* @__PURE__ */ _enum(["TooManyParamsPerContract"]),
    /* @__PURE__ */ _enum(["OperandStackTooLarge"])
  ]);
  var PublicKeySchema = () => /* @__PURE__ */ string();
  var PublicKeyHandleSchema = () => /* @__PURE__ */ string();
  var ReceiptEnumViewSchema = () => /* @__PURE__ */ union([
    /* @__PURE__ */ object({
      Action: /* @__PURE__ */ object({
        actions: /* @__PURE__ */ array(/* @__PURE__ */ _lazy(() => ActionViewSchema())),
        gasPrice: /* @__PURE__ */ _lazy(() => NearTokenSchema()),
        inputDataIds: /* @__PURE__ */ array(/* @__PURE__ */ _lazy(() => CryptoHashSchema())),
        isPromiseYield: /* @__PURE__ */ optional(/* @__PURE__ */ boolean()),
        outputDataReceivers: /* @__PURE__ */ array(/* @__PURE__ */ _lazy(() => DataReceiverViewSchema())),
        refundTo: /* @__PURE__ */ optional(
          /* @__PURE__ */ union([/* @__PURE__ */ _lazy(() => AccountIdSchema()), /* @__PURE__ */ _null()])
        ),
        signerId: /* @__PURE__ */ _lazy(() => AccountIdSchema()),
        signerPublicKey: /* @__PURE__ */ _lazy(() => PublicKeySchema())
      })
    }),
    /* @__PURE__ */ object({
      Data: /* @__PURE__ */ object({
        data: /* @__PURE__ */ optional(/* @__PURE__ */ union([/* @__PURE__ */ union([/* @__PURE__ */ string(), /* @__PURE__ */ _null()]), /* @__PURE__ */ _null()])),
        dataId: /* @__PURE__ */ _lazy(() => CryptoHashSchema()),
        isPromiseResume: /* @__PURE__ */ optional(/* @__PURE__ */ boolean())
      })
    }),
    /* @__PURE__ */ object({
      GlobalContractDistribution: /* @__PURE__ */ object({
        alreadyDeliveredShards: /* @__PURE__ */ array(/* @__PURE__ */ _lazy(() => ShardIdSchema())),
        code: /* @__PURE__ */ string(),
        id: /* @__PURE__ */ _lazy(() => GlobalContractIdentifierSchema()),
        nonce: /* @__PURE__ */ optional(/* @__PURE__ */ union([/* @__PURE__ */ union([/* @__PURE__ */ number(), /* @__PURE__ */ _null()]), /* @__PURE__ */ _null()])),
        targetShard: /* @__PURE__ */ _lazy(() => ShardIdSchema())
      })
    })
  ]);
  var ReceiptValidationErrorSchema = () => /* @__PURE__ */ union([
    /* @__PURE__ */ object({
      InvalidPredecessorId: /* @__PURE__ */ object({
        accountId: /* @__PURE__ */ string()
      })
    }),
    /* @__PURE__ */ object({
      InvalidReceiverId: /* @__PURE__ */ object({
        accountId: /* @__PURE__ */ string()
      })
    }),
    /* @__PURE__ */ object({
      InvalidSignerId: /* @__PURE__ */ object({
        accountId: /* @__PURE__ */ string()
      })
    }),
    /* @__PURE__ */ object({
      InvalidDataReceiverId: /* @__PURE__ */ object({
        accountId: /* @__PURE__ */ string()
      })
    }),
    /* @__PURE__ */ object({
      ReturnedValueLengthExceeded: /* @__PURE__ */ object({
        length: /* @__PURE__ */ number(),
        limit: /* @__PURE__ */ number()
      })
    }),
    /* @__PURE__ */ object({
      NumberInputDataDependenciesExceeded: /* @__PURE__ */ object({
        limit: /* @__PURE__ */ number(),
        numberOfInputDataDependencies: /* @__PURE__ */ number()
      })
    }),
    /* @__PURE__ */ object({
      ActionsValidation: /* @__PURE__ */ _lazy(() => ActionsValidationErrorSchema())
    }),
    /* @__PURE__ */ object({
      ReceiptSizeExceeded: /* @__PURE__ */ object({
        limit: /* @__PURE__ */ number(),
        size: /* @__PURE__ */ number()
      })
    }),
    /* @__PURE__ */ object({
      InvalidRefundTo: /* @__PURE__ */ object({
        accountId: /* @__PURE__ */ string()
      })
    })
  ]);
  var ReceiptViewSchema = () => /* @__PURE__ */ object({
    predecessorId: /* @__PURE__ */ _lazy(() => AccountIdSchema()),
    priority: /* @__PURE__ */ optional(/* @__PURE__ */ number()),
    receipt: /* @__PURE__ */ _lazy(() => ReceiptEnumViewSchema()),
    receiptId: /* @__PURE__ */ _lazy(() => CryptoHashSchema()),
    receiverId: /* @__PURE__ */ _lazy(() => AccountIdSchema())
  });
  var RpcBlockErrorSchema = () => /* @__PURE__ */ union([
    /* @__PURE__ */ object({
      info: /* @__PURE__ */ record(/* @__PURE__ */ string(), /* @__PURE__ */ unknown()),
      name: /* @__PURE__ */ _enum(["UNKNOWN_BLOCK"])
    }),
    /* @__PURE__ */ object({
      name: /* @__PURE__ */ _enum(["NOT_SYNCED_YET"])
    }),
    /* @__PURE__ */ object({
      info: /* @__PURE__ */ object({
        errorMessage: /* @__PURE__ */ string()
      }),
      name: /* @__PURE__ */ _enum(["INTERNAL_ERROR"])
    })
  ]);
  var RpcBlockResponseSchema = () => /* @__PURE__ */ object({
    author: /* @__PURE__ */ _lazy(() => AccountIdSchema()),
    chunks: /* @__PURE__ */ array(/* @__PURE__ */ _lazy(() => ChunkHeaderViewSchema())),
    header: /* @__PURE__ */ _lazy(() => BlockHeaderViewSchema())
  });
  var RpcQueryErrorSchema = () => /* @__PURE__ */ union([
    /* @__PURE__ */ object({
      name: /* @__PURE__ */ _enum(["NO_SYNCED_BLOCKS"])
    }),
    /* @__PURE__ */ object({
      info: /* @__PURE__ */ object({
        requestedShardId: /* @__PURE__ */ _lazy(() => ShardIdSchema())
      }),
      name: /* @__PURE__ */ _enum(["UNAVAILABLE_SHARD"])
    }),
    /* @__PURE__ */ object({
      info: /* @__PURE__ */ object({
        blockHash: /* @__PURE__ */ _lazy(() => CryptoHashSchema()),
        blockHeight: /* @__PURE__ */ number()
      }),
      name: /* @__PURE__ */ _enum(["GARBAGE_COLLECTED_BLOCK"])
    }),
    /* @__PURE__ */ object({
      info: /* @__PURE__ */ object({
        blockReference: /* @__PURE__ */ _lazy(() => BlockReferenceSchema())
      }),
      name: /* @__PURE__ */ _enum(["UNKNOWN_BLOCK"])
    }),
    /* @__PURE__ */ object({
      info: /* @__PURE__ */ object({
        blockHash: /* @__PURE__ */ _lazy(() => CryptoHashSchema()),
        blockHeight: /* @__PURE__ */ number(),
        requestedAccountId: /* @__PURE__ */ _lazy(() => AccountIdSchema())
      }),
      name: /* @__PURE__ */ _enum(["INVALID_ACCOUNT"])
    }),
    /* @__PURE__ */ object({
      info: /* @__PURE__ */ object({
        blockHash: /* @__PURE__ */ _lazy(() => CryptoHashSchema()),
        blockHeight: /* @__PURE__ */ number(),
        requestedAccountId: /* @__PURE__ */ _lazy(() => AccountIdSchema())
      }),
      name: /* @__PURE__ */ _enum(["UNKNOWN_ACCOUNT"])
    }),
    /* @__PURE__ */ object({
      info: /* @__PURE__ */ object({
        blockHash: /* @__PURE__ */ _lazy(() => CryptoHashSchema()),
        blockHeight: /* @__PURE__ */ number(),
        contractAccountId: /* @__PURE__ */ _lazy(() => AccountIdSchema())
      }),
      name: /* @__PURE__ */ _enum(["NO_CONTRACT_CODE"])
    }),
    /* @__PURE__ */ object({
      info: /* @__PURE__ */ object({
        blockHash: /* @__PURE__ */ _lazy(() => CryptoHashSchema()),
        blockHeight: /* @__PURE__ */ number(),
        contractAccountId: /* @__PURE__ */ _lazy(() => AccountIdSchema())
      }),
      name: /* @__PURE__ */ _enum(["TOO_LARGE_CONTRACT_STATE"])
    }),
    /* @__PURE__ */ object({
      info: /* @__PURE__ */ object({
        blockHash: /* @__PURE__ */ _lazy(() => CryptoHashSchema()),
        blockHeight: /* @__PURE__ */ number(),
        publicKey: /* @__PURE__ */ _lazy(() => PublicKeySchema())
      }),
      name: /* @__PURE__ */ _enum(["UNKNOWN_ACCESS_KEY"])
    }),
    /* @__PURE__ */ object({
      info: /* @__PURE__ */ object({
        blockHash: /* @__PURE__ */ _lazy(() => CryptoHashSchema()),
        blockHeight: /* @__PURE__ */ number(),
        publicKey: /* @__PURE__ */ _lazy(() => PublicKeySchema())
      }),
      name: /* @__PURE__ */ _enum(["UNKNOWN_GAS_KEY"])
    }),
    /* @__PURE__ */ object({
      info: /* @__PURE__ */ object({
        blockHash: /* @__PURE__ */ _lazy(() => CryptoHashSchema()),
        blockHeight: /* @__PURE__ */ number(),
        error: /* @__PURE__ */ _lazy(() => FunctionCallErrorSchema()),
        vmError: /* @__PURE__ */ string()
      }),
      name: /* @__PURE__ */ _enum(["CONTRACT_EXECUTION_ERROR"])
    }),
    /* @__PURE__ */ object({
      info: /* @__PURE__ */ object({
        blockHash: /* @__PURE__ */ _lazy(() => CryptoHashSchema()),
        blockHeight: /* @__PURE__ */ number(),
        identifier: /* @__PURE__ */ _lazy(() => GlobalContractIdentifierSchema())
      }),
      name: /* @__PURE__ */ _enum(["NO_GLOBAL_CONTRACT_CODE"])
    }),
    /* @__PURE__ */ object({
      info: /* @__PURE__ */ object({
        errorMessage: /* @__PURE__ */ string()
      }),
      name: /* @__PURE__ */ _enum(["INTERNAL_ERROR"])
    })
  ]);
  var RpcRequestValidationErrorKindSchema = () => /* @__PURE__ */ union([
    /* @__PURE__ */ object({
      info: /* @__PURE__ */ object({
        methodName: /* @__PURE__ */ string()
      }),
      name: /* @__PURE__ */ _enum(["METHOD_NOT_FOUND"])
    }),
    /* @__PURE__ */ object({
      info: /* @__PURE__ */ object({
        errorMessage: /* @__PURE__ */ string()
      }),
      name: /* @__PURE__ */ _enum(["PARSE_ERROR"])
    })
  ]);
  var RpcTransactionErrorSchema = () => /* @__PURE__ */ union([
    /* @__PURE__ */ object({
      info: /* @__PURE__ */ record(/* @__PURE__ */ string(), /* @__PURE__ */ unknown()),
      name: /* @__PURE__ */ _enum(["INVALID_TRANSACTION"])
    }),
    /* @__PURE__ */ object({
      name: /* @__PURE__ */ _enum(["DOES_NOT_TRACK_SHARD"])
    }),
    /* @__PURE__ */ object({
      info: /* @__PURE__ */ object({
        transactionHash: /* @__PURE__ */ _lazy(() => CryptoHashSchema())
      }),
      name: /* @__PURE__ */ _enum(["REQUEST_ROUTED"])
    }),
    /* @__PURE__ */ object({
      info: /* @__PURE__ */ object({
        requestedTransactionHash: /* @__PURE__ */ _lazy(() => CryptoHashSchema())
      }),
      name: /* @__PURE__ */ _enum(["UNKNOWN_TRANSACTION"])
    }),
    /* @__PURE__ */ object({
      info: /* @__PURE__ */ object({
        debugInfo: /* @__PURE__ */ string()
      }),
      name: /* @__PURE__ */ _enum(["INTERNAL_ERROR"])
    }),
    /* @__PURE__ */ object({
      name: /* @__PURE__ */ _enum(["TIMEOUT_ERROR"])
    })
  ]);
  var RpcTransactionResponseSchema = () => /* @__PURE__ */ intersection(
    /* @__PURE__ */ union([
      /* @__PURE__ */ _lazy(() => FinalExecutionOutcomeWithReceiptViewSchema()),
      /* @__PURE__ */ _lazy(() => FinalExecutionOutcomeViewSchema())
    ]),
    /* @__PURE__ */ object({
      finalExecutionStatus: /* @__PURE__ */ _lazy(() => TxExecutionStatusSchema())
    })
  );
  var ShardIdSchema = () => /* @__PURE__ */ number();
  var SignatureSchema = () => /* @__PURE__ */ string();
  var SignedTransactionViewSchema = () => /* @__PURE__ */ object({
    actions: /* @__PURE__ */ array(/* @__PURE__ */ _lazy(() => ActionViewSchema())),
    hash: /* @__PURE__ */ _lazy(() => CryptoHashSchema()),
    nonce: /* @__PURE__ */ number(),
    nonceIndex: /* @__PURE__ */ optional(
      /* @__PURE__ */ union([/* @__PURE__ */ union([/* @__PURE__ */ number(), /* @__PURE__ */ _null()]), /* @__PURE__ */ _null()])
    ),
    nonceMode: /* @__PURE__ */ optional(/* @__PURE__ */ union([/* @__PURE__ */ _lazy(() => NonceModeSchema()), /* @__PURE__ */ _null()])),
    priorityFee: /* @__PURE__ */ optional(/* @__PURE__ */ number()),
    publicKey: /* @__PURE__ */ _lazy(() => PublicKeySchema()),
    receiverId: /* @__PURE__ */ _lazy(() => AccountIdSchema()),
    signature: /* @__PURE__ */ _lazy(() => SignatureSchema()),
    signerId: /* @__PURE__ */ _lazy(() => AccountIdSchema())
  });
  var SlashedValidatorSchema = () => /* @__PURE__ */ object({
    accountId: /* @__PURE__ */ _lazy(() => AccountIdSchema()),
    isDoubleSign: /* @__PURE__ */ boolean()
  });
  var SpiceChunkEndorsementStatsSchema = () => /* @__PURE__ */ object({
    expected: /* @__PURE__ */ number(),
    produced: /* @__PURE__ */ number()
  });
  var StakeActionSchema = () => /* @__PURE__ */ object({
    publicKey: /* @__PURE__ */ _lazy(() => PublicKeySchema()),
    stake: /* @__PURE__ */ _lazy(() => NearTokenSchema())
  });
  var StorageErrorSchema = () => /* @__PURE__ */ union([
    /* @__PURE__ */ _enum(["StorageInternalError"]),
    /* @__PURE__ */ object({
      MissingTrieValue: /* @__PURE__ */ _lazy(() => MissingTrieValueSchema())
    }),
    /* @__PURE__ */ _enum(["UnexpectedTrieValue"]),
    /* @__PURE__ */ object({
      StorageInconsistentState: /* @__PURE__ */ string()
    }),
    /* @__PURE__ */ object({
      FlatStorageBlockNotSupported: /* @__PURE__ */ string()
    }),
    /* @__PURE__ */ object({
      MemTrieLoadingError: /* @__PURE__ */ string()
    })
  ]);
  var SyncCheckpointSchema = () => /* @__PURE__ */ _enum(["genesis", "earliest_available"]);
  var TransactionNonceSchema = () => /* @__PURE__ */ union([
    /* @__PURE__ */ object({
      Nonce: /* @__PURE__ */ object({
        nonce: /* @__PURE__ */ number()
      })
    }),
    /* @__PURE__ */ object({
      GasKeyNonce: /* @__PURE__ */ object({
        nonce: /* @__PURE__ */ number(),
        nonceIndex: /* @__PURE__ */ number()
      })
    })
  ]);
  var TransferActionSchema = () => /* @__PURE__ */ object({
    deposit: /* @__PURE__ */ _lazy(() => NearTokenSchema())
  });
  var TransferToGasKeyActionSchema = () => /* @__PURE__ */ object({
    deposit: /* @__PURE__ */ _lazy(() => NearTokenSchema()),
    publicKey: /* @__PURE__ */ _lazy(() => PublicKeySchema())
  });
  var TrieSplitSchema = () => /* @__PURE__ */ object({
    boundaryAccount: /* @__PURE__ */ _lazy(() => AccountIdSchema()),
    leftMemory: /* @__PURE__ */ number(),
    rightMemory: /* @__PURE__ */ number()
  });
  var TxExecutionErrorSchema = () => /* @__PURE__ */ union([
    /* @__PURE__ */ object({
      ActionError: /* @__PURE__ */ _lazy(() => ActionErrorSchema())
    }),
    /* @__PURE__ */ object({
      InvalidTxError: /* @__PURE__ */ _lazy(() => InvalidTxErrorSchema())
    })
  ]);
  var TxExecutionStatusSchema = () => /* @__PURE__ */ union([
    /* @__PURE__ */ _enum(["NONE"]),
    /* @__PURE__ */ _enum(["INCLUDED"]),
    /* @__PURE__ */ _enum(["EXECUTED_OPTIMISTIC"]),
    /* @__PURE__ */ _enum(["INCLUDED_FINAL"]),
    /* @__PURE__ */ _enum(["EXECUTED"]),
    /* @__PURE__ */ _enum(["FINAL"])
  ]);
  var UseGlobalContractActionSchema = () => /* @__PURE__ */ object({
    contractIdentifier: /* @__PURE__ */ _lazy(() => GlobalContractIdentifierSchema())
  });
  var ValidatorStakeViewSchema = () => /* @__PURE__ */ _lazy(() => ValidatorStakeViewV1Schema());
  var ValidatorStakeViewV1Schema = () => /* @__PURE__ */ object({
    accountId: /* @__PURE__ */ _lazy(() => AccountIdSchema()),
    publicKey: /* @__PURE__ */ _lazy(() => PublicKeySchema()),
    stake: /* @__PURE__ */ _lazy(() => NearTokenSchema())
  });
  var VersionedDelegateActionPayloadSchema = () => /* @__PURE__ */ object({
    V2: /* @__PURE__ */ _lazy(() => DelegateActionV2Schema())
  });
  var WasmTrapSchema = () => /* @__PURE__ */ union([
    /* @__PURE__ */ _enum(["Unreachable"]),
    /* @__PURE__ */ _enum(["IncorrectCallIndirectSignature"]),
    /* @__PURE__ */ _enum(["MemoryOutOfBounds"]),
    /* @__PURE__ */ _enum(["CallIndirectOOB"]),
    /* @__PURE__ */ _enum(["IllegalArithmetic"]),
    /* @__PURE__ */ _enum(["MisalignedAtomicAccess"]),
    /* @__PURE__ */ _enum(["IndirectCallToNull"]),
    /* @__PURE__ */ _enum(["StackOverflow"]),
    /* @__PURE__ */ _enum(["GenericTrap"])
  ]);
  var WithdrawFromGasKeyActionSchema = () => /* @__PURE__ */ object({
    amount: /* @__PURE__ */ _lazy(() => NearTokenSchema()),
    publicKey: /* @__PURE__ */ _lazy(() => PublicKeySchema())
  });
  var PATH_TO_METHOD_MAP = {
    "/EXPERIMENTAL_call_function": "EXPERIMENTAL_call_function",
    "/EXPERIMENTAL_changes": "EXPERIMENTAL_changes",
    "/EXPERIMENTAL_changes_in_block": "EXPERIMENTAL_changes_in_block",
    "/EXPERIMENTAL_congestion_level": "EXPERIMENTAL_congestion_level",
    "/EXPERIMENTAL_genesis_config": "EXPERIMENTAL_genesis_config",
    "/EXPERIMENTAL_light_client_block_proof": "EXPERIMENTAL_light_client_block_proof",
    "/EXPERIMENTAL_light_client_proof": "EXPERIMENTAL_light_client_proof",
    "/EXPERIMENTAL_maintenance_windows": "EXPERIMENTAL_maintenance_windows",
    "/EXPERIMENTAL_protocol_config": "EXPERIMENTAL_protocol_config",
    "/EXPERIMENTAL_receipt": "EXPERIMENTAL_receipt",
    "/EXPERIMENTAL_receipt_to_tx": "EXPERIMENTAL_receipt_to_tx",
    "/EXPERIMENTAL_split_storage_info": "EXPERIMENTAL_split_storage_info",
    "/EXPERIMENTAL_tx_status": "EXPERIMENTAL_tx_status",
    "/EXPERIMENTAL_validators_ordered": "EXPERIMENTAL_validators_ordered",
    "/EXPERIMENTAL_view_access_key": "EXPERIMENTAL_view_access_key",
    "/EXPERIMENTAL_view_access_key_list": "EXPERIMENTAL_view_access_key_list",
    "/EXPERIMENTAL_view_account": "EXPERIMENTAL_view_account",
    "/EXPERIMENTAL_view_code": "EXPERIMENTAL_view_code",
    "/EXPERIMENTAL_view_state": "EXPERIMENTAL_view_state",
    "/block": "block",
    "/block_effects": "block_effects",
    "/broadcast_tx_async": "broadcast_tx_async",
    "/broadcast_tx_commit": "broadcast_tx_commit",
    "/changes": "changes",
    "/chunk": "chunk",
    "/client_config": "client_config",
    "/gas_price": "gas_price",
    "/genesis_config": "genesis_config",
    "/health": "health",
    "/light_client_proof": "light_client_proof",
    "/maintenance_windows": "maintenance_windows",
    "/network_info": "network_info",
    "/next_light_client_block": "next_light_client_block",
    "/query": "query",
    "/send_tx": "send_tx",
    "/status": "status",
    "/tx": "tx",
    "/validators": "validators"
  };
  Object.entries(PATH_TO_METHOD_MAP).forEach(([path, method]) => {
  });
  var integers = ["u8", "u16", "u32", "u64", "u128", "i8", "i16", "i32", "i64", "i128", "f32", "f64"];
  var EncodeBuffer = (
    /** @class */
    (function() {
      function EncodeBuffer2() {
        this.offset = 0;
        this.buffer_size = 256;
        this.buffer = new ArrayBuffer(this.buffer_size);
        this.view = new DataView(this.buffer);
      }
      EncodeBuffer2.prototype.resize_if_necessary = function(needed_space) {
        if (this.buffer_size - this.offset < needed_space) {
          this.buffer_size = Math.max(this.buffer_size * 2, this.buffer_size + needed_space);
          var new_buffer = new ArrayBuffer(this.buffer_size);
          new Uint8Array(new_buffer).set(new Uint8Array(this.buffer));
          this.buffer = new_buffer;
          this.view = new DataView(new_buffer);
        }
      };
      EncodeBuffer2.prototype.get_used_buffer = function() {
        return new Uint8Array(this.buffer).slice(0, this.offset);
      };
      EncodeBuffer2.prototype.store_value = function(value, type) {
        var bSize = type.substring(1);
        var size = parseInt(bSize) / 8;
        this.resize_if_necessary(size);
        var toCall = type[0] === "f" ? "setFloat".concat(bSize) : type[0] === "i" ? "setInt".concat(bSize) : "setUint".concat(bSize);
        this.view[toCall](this.offset, value, true);
        this.offset += size;
      };
      EncodeBuffer2.prototype.store_bytes = function(from) {
        this.resize_if_necessary(from.length);
        new Uint8Array(this.buffer).set(new Uint8Array(from), this.offset);
        this.offset += from.length;
      };
      return EncodeBuffer2;
    })()
  );
  var __extends = /* @__PURE__ */ (function() {
    var extendStatics = function(d, b) {
      extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d2, b2) {
        d2.__proto__ = b2;
      } || function(d2, b2) {
        for (var p in b2) if (Object.prototype.hasOwnProperty.call(b2, p)) d2[p] = b2[p];
      };
      return extendStatics(d, b);
    };
    return function(d, b) {
      if (typeof b !== "function" && b !== null)
        throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
      extendStatics(d, b);
      function __() {
        this.constructor = d;
      }
      d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
  })();
  function isArrayLike(value) {
    return Array.isArray(value) || !!value && typeof value === "object" && "length" in value && typeof value.length === "number" && (value.length === 0 || value.length > 0 && value.length - 1 in value);
  }
  function expect_type(value, type, fieldPath) {
    if (typeof value !== type) {
      throw new Error("Expected ".concat(type, " not ").concat(typeof value, "(").concat(value, ") at ").concat(fieldPath.join(".")));
    }
  }
  function expect_bigint(value, fieldPath) {
    var basicType = ["number", "string", "bigint", "boolean"].includes(typeof value);
    var strObject = typeof value === "object" && value !== null && "toString" in value;
    if (!basicType && !strObject) {
      throw new Error("Expected bigint, number, boolean or string not ".concat(typeof value, "(").concat(value, ") at ").concat(fieldPath.join(".")));
    }
  }
  function expect_same_size(length, expected, fieldPath) {
    if (length !== expected) {
      throw new Error("Array length ".concat(length, " does not match schema length ").concat(expected, " at ").concat(fieldPath.join(".")));
    }
  }
  function expect_enum(value, fieldPath) {
    if (typeof value !== "object" || value === null) {
      throw new Error("Expected object not ".concat(typeof value, "(").concat(value, ") at ").concat(fieldPath.join(".")));
    }
  }
  var VALID_STRING_TYPES = integers.concat(["bool", "string"]);
  var VALID_OBJECT_KEYS = ["option", "enum", "array", "set", "map", "struct"];
  var ErrorSchema = (
    /** @class */
    (function(_super) {
      __extends(ErrorSchema2, _super);
      function ErrorSchema2(schema, expected) {
        var message = "Invalid schema: ".concat(JSON.stringify(schema), " expected ").concat(expected);
        return _super.call(this, message) || this;
      }
      return ErrorSchema2;
    })(Error)
  );
  function validate_schema(schema) {
    if (typeof schema === "string" && VALID_STRING_TYPES.includes(schema)) {
      return;
    }
    if (schema && typeof schema === "object") {
      var keys2 = Object.keys(schema);
      if (keys2.length === 1 && VALID_OBJECT_KEYS.includes(keys2[0])) {
        var key = keys2[0];
        if (key === "option")
          return validate_schema(schema[key]);
        if (key === "enum")
          return validate_enum_schema(schema[key]);
        if (key === "array")
          return validate_array_schema(schema[key]);
        if (key === "set")
          return validate_schema(schema[key]);
        if (key === "map")
          return validate_map_schema(schema[key]);
        if (key === "struct")
          return validate_struct_schema(schema[key]);
      }
    }
    throw new ErrorSchema(schema, VALID_OBJECT_KEYS.join(", ") + " or " + VALID_STRING_TYPES.join(", "));
  }
  function validate_enum_schema(schema) {
    if (!Array.isArray(schema))
      throw new ErrorSchema(schema, "Array");
    for (var _i = 0, schema_1 = schema; _i < schema_1.length; _i++) {
      var sch = schema_1[_i];
      if (typeof sch !== "object" || !("struct" in sch)) {
        throw new Error('Missing "struct" key in enum schema');
      }
      if (typeof sch.struct !== "object" || Object.keys(sch.struct).length !== 1) {
        throw new Error('The "struct" in each enum must have a single key');
      }
      validate_schema({ struct: sch.struct });
    }
  }
  function validate_array_schema(schema) {
    if (typeof schema !== "object")
      throw new ErrorSchema(schema, "{ type, len? }");
    if (schema.len && typeof schema.len !== "number") {
      throw new Error("Invalid schema: ".concat(schema));
    }
    if ("type" in schema)
      return validate_schema(schema.type);
    throw new ErrorSchema(schema, "{ type, len? }");
  }
  function validate_map_schema(schema) {
    if (typeof schema === "object" && "key" in schema && "value" in schema) {
      validate_schema(schema.key);
      validate_schema(schema.value);
    } else {
      throw new ErrorSchema(schema, "{ key, value }");
    }
  }
  function validate_struct_schema(schema) {
    if (typeof schema !== "object")
      throw new ErrorSchema(schema, "object");
    for (var key in schema) {
      validate_schema(schema[key]);
    }
  }
  var BorshSerializer = (
    /** @class */
    (function() {
      function BorshSerializer2(checkTypes) {
        this.encoded = new EncodeBuffer();
        this.fieldPath = ["value"];
        this.checkTypes = checkTypes;
      }
      BorshSerializer2.prototype.encode = function(value, schema) {
        this.encode_value(value, schema);
        return this.encoded.get_used_buffer();
      };
      BorshSerializer2.prototype.encode_value = function(value, schema) {
        if (typeof schema === "string") {
          if (integers.includes(schema))
            return this.encode_integer(value, schema);
          if (schema === "string")
            return this.encode_string(value);
          if (schema === "bool")
            return this.encode_boolean(value);
        }
        if (typeof schema === "object") {
          if ("option" in schema)
            return this.encode_option(value, schema);
          if ("enum" in schema)
            return this.encode_enum(value, schema);
          if ("array" in schema)
            return this.encode_array(value, schema);
          if ("set" in schema)
            return this.encode_set(value, schema);
          if ("map" in schema)
            return this.encode_map(value, schema);
          if ("struct" in schema)
            return this.encode_struct(value, schema);
        }
      };
      BorshSerializer2.prototype.encode_integer = function(value, schema) {
        var size = parseInt(schema.substring(1));
        if (size <= 32 || schema == "f64") {
          this.checkTypes && expect_type(value, "number", this.fieldPath);
          this.encoded.store_value(value, schema);
        } else {
          this.checkTypes && expect_bigint(value, this.fieldPath);
          this.encode_bigint(BigInt(value), size);
        }
      };
      BorshSerializer2.prototype.encode_bigint = function(value, size) {
        var buffer_len = size / 8;
        var buffer = new Uint8Array(buffer_len);
        for (var i = 0; i < buffer_len; i++) {
          buffer[i] = Number(value & BigInt(255));
          value = value >> BigInt(8);
        }
        this.encoded.store_bytes(new Uint8Array(buffer));
      };
      BorshSerializer2.prototype.encode_string = function(value) {
        this.checkTypes && expect_type(value, "string", this.fieldPath);
        var _value = value;
        var utf8Bytes = [];
        for (var i = 0; i < _value.length; i++) {
          var charCode = _value.charCodeAt(i);
          if (charCode < 128) {
            utf8Bytes.push(charCode);
          } else if (charCode < 2048) {
            utf8Bytes.push(192 | charCode >> 6, 128 | charCode & 63);
          } else if (charCode < 55296 || charCode >= 57344) {
            utf8Bytes.push(224 | charCode >> 12, 128 | charCode >> 6 & 63, 128 | charCode & 63);
          } else {
            i++;
            charCode = 65536 + ((charCode & 1023) << 10 | _value.charCodeAt(i) & 1023);
            utf8Bytes.push(240 | charCode >> 18, 128 | charCode >> 12 & 63, 128 | charCode >> 6 & 63, 128 | charCode & 63);
          }
        }
        this.encoded.store_value(utf8Bytes.length, "u32");
        this.encoded.store_bytes(new Uint8Array(utf8Bytes));
      };
      BorshSerializer2.prototype.encode_boolean = function(value) {
        this.checkTypes && expect_type(value, "boolean", this.fieldPath);
        this.encoded.store_value(value ? 1 : 0, "u8");
      };
      BorshSerializer2.prototype.encode_option = function(value, schema) {
        if (value === null || value === void 0) {
          this.encoded.store_value(0, "u8");
        } else {
          this.encoded.store_value(1, "u8");
          this.encode_value(value, schema.option);
        }
      };
      BorshSerializer2.prototype.encode_enum = function(value, schema) {
        this.checkTypes && expect_enum(value, this.fieldPath);
        var valueKey = Object.keys(value)[0];
        for (var i = 0; i < schema["enum"].length; i++) {
          var valueSchema = schema["enum"][i];
          if (valueKey === Object.keys(valueSchema.struct)[0]) {
            this.encoded.store_value(i, "u8");
            return this.encode_struct(value, valueSchema);
          }
        }
        throw new Error("Enum key (".concat(valueKey, ") not found in enum schema: ").concat(JSON.stringify(schema), " at ").concat(this.fieldPath.join(".")));
      };
      BorshSerializer2.prototype.encode_array = function(value, schema) {
        if (isArrayLike(value))
          return this.encode_arraylike(value, schema);
        if (value instanceof ArrayBuffer)
          return this.encode_buffer(value, schema);
        throw new Error("Expected Array-like not ".concat(typeof value, "(").concat(value, ") at ").concat(this.fieldPath.join(".")));
      };
      BorshSerializer2.prototype.encode_arraylike = function(value, schema) {
        if (schema.array.len) {
          expect_same_size(value.length, schema.array.len, this.fieldPath);
        } else {
          this.encoded.store_value(value.length, "u32");
        }
        for (var i = 0; i < value.length; i++) {
          this.encode_value(value[i], schema.array.type);
        }
      };
      BorshSerializer2.prototype.encode_buffer = function(value, schema) {
        if (schema.array.len) {
          expect_same_size(value.byteLength, schema.array.len, this.fieldPath);
        } else {
          this.encoded.store_value(value.byteLength, "u32");
        }
        this.encoded.store_bytes(new Uint8Array(value));
      };
      BorshSerializer2.prototype.encode_set = function(value, schema) {
        this.checkTypes && expect_type(value, "object", this.fieldPath);
        var isSet2 = value instanceof Set;
        var values = isSet2 ? Array.from(value.values()) : Object.values(value);
        this.encoded.store_value(values.length, "u32");
        for (var _i = 0, values_1 = values; _i < values_1.length; _i++) {
          var value_1 = values_1[_i];
          this.encode_value(value_1, schema.set);
        }
      };
      BorshSerializer2.prototype.encode_map = function(value, schema) {
        this.checkTypes && expect_type(value, "object", this.fieldPath);
        var isMap2 = value instanceof Map;
        var keys2 = isMap2 ? Array.from(value.keys()) : Object.keys(value);
        this.encoded.store_value(keys2.length, "u32");
        for (var _i = 0, keys_1 = keys2; _i < keys_1.length; _i++) {
          var key = keys_1[_i];
          this.encode_value(key, schema.map.key);
          this.encode_value(isMap2 ? value.get(key) : value[key], schema.map.value);
        }
      };
      BorshSerializer2.prototype.encode_struct = function(value, schema) {
        this.checkTypes && expect_type(value, "object", this.fieldPath);
        for (var _i = 0, _a2 = Object.keys(schema.struct); _i < _a2.length; _i++) {
          var key = _a2[_i];
          this.fieldPath.push(key);
          this.encode_value(value[key], schema.struct[key]);
          this.fieldPath.pop();
        }
      };
      return BorshSerializer2;
    })()
  );
  function serialize(schema, value, validate) {
    if (validate === void 0) {
      validate = true;
    }
    if (validate)
      validate_schema(schema);
    var serializer = new BorshSerializer(validate);
    return serializer.encode(value, schema);
  }
  const ed25519_CURVE$1 = Object.freeze({
    p: 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffedn,
    n: 0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3edn,
    h: 8n,
    a: 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffecn,
    d: 0x52036cee2b6ffe738cc740797779e89800700a4d4141d8ab75eb4dca135978a3n,
    Gx: 0x216936d3cd6e53fec0a4e231fdd6dc5c692cc7609525a7b2c9562d608f25d51an,
    Gy: 0x6666666666666666666666666666666666666666666666666666666666666658n
  });
  const { p: P$1, n: N$1, Gx: Gx$1, Gy: Gy$1, a: _a, d: _d, h } = ed25519_CURVE$1;
  const L$1 = 32;
  const captureTrace = (...args) => {
    if ("captureStackTrace" in Error && typeof Error.captureStackTrace === "function") {
      Error.captureStackTrace(...args);
    }
  };
  const err$1 = (message = "") => {
    const e = new Error(message);
    captureTrace(e, err$1);
    throw e;
  };
  const isBig = (n) => typeof n === "bigint";
  const isStr = (s) => typeof s === "string";
  const isBytes$3 = (a) => a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array" && "BYTES_PER_ELEMENT" in a && a.BYTES_PER_ELEMENT === 1;
  const abytes$3 = (value, length, title = "") => {
    const bytes = isBytes$3(value);
    const len = value?.length;
    const needsLen = length !== void 0;
    if (!bytes || needsLen && len !== length) {
      const prefix2 = title && `"${title}" `;
      const ofLen = needsLen ? ` of length ${length}` : "";
      const got = bytes ? `length=${len}` : `type=${typeof value}`;
      const msg = prefix2 + "expected Uint8Array" + ofLen + ", got " + got;
      throw bytes ? new RangeError(msg) : new TypeError(msg);
    }
    return value;
  };
  const u8n$1 = (len) => new Uint8Array(len);
  const u8fr = (buf) => Uint8Array.from(buf);
  const padh$1 = (n, pad) => n.toString(16).padStart(pad, "0");
  const bytesToHex$3 = (b) => Array.from(abytes$3(b)).map((e) => padh$1(e, 2)).join("");
  const C$1 = { _0: 48, _9: 57, A: 65, F: 70, a: 97, f: 102 };
  const _ch$1 = (ch) => {
    if (ch >= C$1._0 && ch <= C$1._9)
      return ch - C$1._0;
    if (ch >= C$1.A && ch <= C$1.F)
      return ch - (C$1.A - 10);
    if (ch >= C$1.a && ch <= C$1.f)
      return ch - (C$1.a - 10);
    return;
  };
  const hexToBytes$3 = (hex2) => {
    const e = "hex invalid";
    if (!isStr(hex2))
      return err$1(e);
    const hl = hex2.length;
    const al = hl / 2;
    if (hl % 2)
      return err$1(e);
    const array2 = u8n$1(al);
    for (let ai = 0, hi = 0; ai < al; ai++, hi += 2) {
      const n1 = _ch$1(hex2.charCodeAt(hi));
      const n2 = _ch$1(hex2.charCodeAt(hi + 1));
      if (n1 === void 0 || n2 === void 0)
        return err$1(e);
      array2[ai] = n1 * 16 + n2;
    }
    return array2;
  };
  const cr = () => globalThis?.crypto;
  const subtle$1 = () => cr()?.subtle ?? err$1("crypto.subtle must be defined, consider polyfill");
  const concatBytes$4 = (...arrs) => {
    let len = 0;
    for (const a of arrs)
      len += abytes$3(a).length;
    const r = u8n$1(len);
    let pad = 0;
    arrs.forEach((a) => {
      r.set(a, pad);
      pad += a.length;
    });
    return r;
  };
  const big$1 = BigInt;
  const assertRange = (n, min, max, msg = "bad number: out of range") => {
    if (!isBig(n))
      throw new TypeError(msg);
    if (min <= n && n < max)
      return n;
    throw new RangeError(msg);
  };
  const M$1 = (a, b = P$1) => {
    const r = a % b;
    return r >= 0n ? r : b + r;
  };
  const P_MASK = (1n << 255n) - 1n;
  const modP = (num) => {
    if (num < 0n)
      err$1("negative coordinate");
    let r = (num >> 255n) * 19n + (num & P_MASK);
    r = (r >> 255n) * 19n + (r & P_MASK);
    return r % P$1;
  };
  const modN$1 = (a) => M$1(a, N$1);
  const invert$2 = (num, md) => {
    if (num === 0n || md <= 0n)
      err$1("no inverse n=" + num + " mod=" + md);
    let a = M$1(num, md), b = md, x = 0n, u = 1n;
    while (a !== 0n) {
      const q = b / a, r = b % a;
      const m = x - u * q;
      b = a, a = r, x = u, u = m;
    }
    return b === 1n ? M$1(x, md) : err$1("no inverse");
  };
  const callHash$1 = (name) => {
    const fn = hashes$1[name];
    if (typeof fn !== "function")
      err$1("hashes." + name + " not set");
    return fn;
  };
  const checkDigest = (value) => abytes$3(value, 64, "digest");
  const apoint$1 = (p) => p instanceof Point$1 ? p : err$1("Point expected");
  const B256$1 = 2n ** 256n;
  let Point$1 = class Point2 {
    static BASE;
    static ZERO;
    X;
    Y;
    Z;
    T;
    // Constructor only bounds-checks and freezes XYZT coordinates; it does not prove the point is
    // on-curve or that T matches X*Y/Z.
    constructor(X, Y, Z, T) {
      const max = B256$1;
      this.X = assertRange(X, 0n, max);
      this.Y = assertRange(Y, 0n, max);
      this.Z = assertRange(Z, 1n, max);
      this.T = assertRange(T, 0n, max);
      Object.freeze(this);
    }
    static CURVE() {
      return ed25519_CURVE$1;
    }
    static fromAffine(p) {
      return new Point2(p.x, p.y, 1n, modP(p.x * p.y));
    }
    /** RFC8032 5.1.3: Bytes to Point. */
    static fromBytes(hex2, zip215 = false) {
      const d = _d;
      const normed = u8fr(abytes$3(hex2, L$1));
      const lastByte = hex2[31];
      normed[31] = lastByte & -129;
      const y = bytesToNumberLE$1(normed);
      const max = zip215 ? B256$1 : P$1;
      assertRange(y, 0n, max);
      const y2 = modP(y * y);
      const u = M$1(y2 - 1n);
      const v = modP(d * y2 + 1n);
      let { isValid, value: x } = uvRatio$1(u, v);
      if (!isValid)
        err$1("bad point: y not sqrt");
      const isXOdd = (x & 1n) === 1n;
      const isLastByteOdd = (lastByte & 128) !== 0;
      if (!zip215 && x === 0n && isLastByteOdd)
        err$1("bad point: x==0, isLastByteOdd");
      if (isLastByteOdd !== isXOdd)
        x = M$1(-x);
      return new Point2(x, y, 1n, modP(x * y));
    }
    static fromHex(hex2, zip215) {
      return Point2.fromBytes(hexToBytes$3(hex2), zip215);
    }
    get x() {
      return this.toAffine().x;
    }
    get y() {
      return this.toAffine().y;
    }
    /** Checks if the point is valid and on-curve. */
    assertValidity() {
      const a = _a;
      const d = _d;
      const p = this;
      if (p.is0())
        return err$1("bad point: ZERO");
      const { X, Y, Z, T } = p;
      const X2 = modP(X * X);
      const Y2 = modP(Y * Y);
      const Z2 = modP(Z * Z);
      const Z4 = modP(Z2 * Z2);
      const aX2 = modP(X2 * a);
      const left = modP(Z2 * (aX2 + Y2));
      const right = M$1(Z4 + modP(d * modP(X2 * Y2)));
      if (left !== right)
        return err$1("bad point: equation left != right (1)");
      const XY = modP(X * Y);
      const ZT = modP(Z * T);
      if (XY !== ZT)
        return err$1("bad point: equation left != right (2)");
      return this;
    }
    /** Equality check: compare points P&Q. */
    equals(other) {
      const { X: X1, Y: Y1, Z: Z1 } = this;
      const { X: X2, Y: Y2, Z: Z2 } = apoint$1(other);
      const X1Z2 = modP(X1 * Z2);
      const X2Z1 = modP(X2 * Z1);
      const Y1Z2 = modP(Y1 * Z2);
      const Y2Z1 = modP(Y2 * Z1);
      return X1Z2 === X2Z1 && Y1Z2 === Y2Z1;
    }
    is0() {
      return this.equals(I$1);
    }
    /** Flip point over y coordinate. */
    negate() {
      return new Point2(M$1(-this.X), this.Y, this.Z, M$1(-this.T));
    }
    /** Point doubling. Complete formula. Cost: `4M + 4S + 1*a + 6add + 1*2`. */
    double() {
      const { X: X1, Y: Y1, Z: Z1 } = this;
      const a = _a;
      const A = modP(X1 * X1);
      const B = modP(Y1 * Y1);
      const C2 = modP(2n * Z1 * Z1);
      const D = modP(a * A);
      const x1y1 = M$1(X1 + Y1);
      const E = M$1(modP(x1y1 * x1y1) - A - B);
      const G2 = M$1(D + B);
      const F = M$1(G2 - C2);
      const H = M$1(D - B);
      const X3 = modP(E * F);
      const Y3 = modP(G2 * H);
      const T3 = modP(E * H);
      const Z3 = modP(F * G2);
      return new Point2(X3, Y3, Z3, T3);
    }
    /** Point addition. Complete formula. Cost: `8M + 1*k + 8add + 1*2`. */
    add(other) {
      const { X: X1, Y: Y1, Z: Z1, T: T1 } = this;
      const { X: X2, Y: Y2, Z: Z2, T: T2 } = apoint$1(other);
      const a = _a;
      const d = _d;
      const A = modP(X1 * X2);
      const B = modP(Y1 * Y2);
      const C2 = modP(modP(T1 * d) * T2);
      const D = modP(Z1 * Z2);
      const E = M$1(modP(M$1(X1 + Y1) * M$1(X2 + Y2)) - A - B);
      const F = M$1(D - C2);
      const G2 = M$1(D + C2);
      const H = M$1(B - modP(a * A));
      const X3 = modP(E * F);
      const Y3 = modP(G2 * H);
      const T3 = modP(E * H);
      const Z3 = modP(F * G2);
      return new Point2(X3, Y3, Z3, T3);
    }
    subtract(other) {
      return this.add(apoint$1(other).negate());
    }
    /**
     * Point-by-scalar multiplication. Safe mode requires `1 <= n < CURVE.n`.
     * Unsafe mode additionally permits `n = 0` and returns the identity point for that case.
     * Uses {@link wNAF} for base point.
     * Uses fake point to mitigate side-channel leakage.
     * @param n - scalar by which point is multiplied
     * @param safe - safe mode guards against timing attacks; unsafe mode is faster
     */
    multiply(n, safe = true) {
      if (!safe && n === 0n)
        return I$1;
      assertRange(n, 1n, N$1);
      if (!safe && this.is0())
        return I$1;
      if (n === 1n)
        return this;
      if (this.equals(G$1))
        return wNAF$2(n).p;
      let p = I$1;
      let f = G$1;
      for (let d = this; n > 0n; d = d.double(), n >>= 1n) {
        if (n & 1n)
          p = p.add(d);
        else if (safe)
          f = f.add(d);
      }
      return p;
    }
    multiplyUnsafe(scalar) {
      return this.multiply(scalar, false);
    }
    /** Convert point to 2d xy affine point. (X, Y, Z) ∋ (x=X/Z, y=Y/Z) */
    toAffine() {
      const { X, Y, Z } = this;
      if (this.equals(I$1))
        return { x: 0n, y: 1n };
      const iz = invert$2(Z, P$1);
      if (modP(Z * iz) !== 1n)
        err$1("invalid inverse");
      const x = modP(X * iz);
      const y = modP(Y * iz);
      return { x, y };
    }
    toBytes() {
      const { x, y } = this.toAffine();
      const b = numTo32bLE(y);
      b[31] |= x & 1n ? 128 : 0;
      return b;
    }
    toHex() {
      return bytesToHex$3(this.toBytes());
    }
    clearCofactor() {
      return this.multiply(big$1(h), false);
    }
    isSmallOrder() {
      return this.clearCofactor().is0();
    }
    isTorsionFree() {
      let p = this.multiply(N$1 / 2n, false).double();
      if (N$1 % 2n)
        p = p.add(this);
      return p.is0();
    }
  };
  const G$1 = new Point$1(Gx$1, Gy$1, 1n, M$1(Gx$1 * Gy$1));
  const I$1 = new Point$1(0n, 1n, 1n, 0n);
  Point$1.BASE = G$1;
  Point$1.ZERO = I$1;
  const numTo32bLE = (num) => hexToBytes$3(padh$1(assertRange(num, 0n, B256$1), 64)).reverse();
  const bytesToNumberLE$1 = (b) => big$1("0x" + bytesToHex$3(u8fr(abytes$3(b)).reverse()));
  const pow2$1 = (x, power) => {
    let r = x;
    while (power-- > 0n) {
      r = modP(r * r);
    }
    return r;
  };
  const pow_2_252_3 = (x) => {
    const x2 = modP(x * x);
    const b2 = modP(x2 * x);
    const b4 = modP(pow2$1(b2, 2n) * b2);
    const b5 = modP(pow2$1(b4, 1n) * x);
    const b10 = modP(pow2$1(b5, 5n) * b5);
    const b20 = modP(pow2$1(b10, 10n) * b10);
    const b40 = modP(pow2$1(b20, 20n) * b20);
    const b80 = modP(pow2$1(b40, 40n) * b40);
    const b160 = modP(pow2$1(b80, 80n) * b80);
    const b240 = modP(pow2$1(b160, 80n) * b80);
    const b250 = modP(pow2$1(b240, 10n) * b10);
    const pow_p_5_8 = modP(pow2$1(b250, 2n) * x);
    return { pow_p_5_8, b2 };
  };
  const RM1 = 0x2b8324804fc1df0b2b4d00993dfbd7a72f431806ad2fe478c4ee1b274a0ea0b0n;
  const uvRatio$1 = (u, v) => {
    const v3 = modP(v * modP(v * v));
    const v7 = modP(modP(v3 * v3) * v);
    const pow = pow_2_252_3(modP(u * v7)).pow_p_5_8;
    let x = modP(u * modP(v3 * pow));
    const vx2 = modP(v * modP(x * x));
    const root1 = x;
    const root2 = modP(x * RM1);
    const useRoot1 = vx2 === u;
    const useRoot2 = vx2 === M$1(-u);
    const noRoot = vx2 === M$1(-u * RM1);
    if (useRoot1)
      x = root1;
    if (useRoot2 || noRoot)
      x = root2;
    if ((M$1(x) & 1n) === 1n)
      x = M$1(-x);
    return { isValid: useRoot1 || useRoot2, value: x };
  };
  const modL_LE = (hash) => modN$1(bytesToNumberLE$1(hash));
  const sha512s = (...m) => checkDigest(callHash$1("sha512")(concatBytes$4(...m)));
  const hash2extK = (hashed) => {
    const copy = u8fr(hashed);
    const head = copy.slice(0, 32);
    head[0] &= 248;
    head[31] &= 127;
    head[31] |= 64;
    const prefix2 = copy.slice(32, 64);
    const scalar = modL_LE(head);
    const point = G$1.multiply(scalar);
    const pointBytes = point.toBytes();
    return { head, prefix: prefix2, scalar, point, pointBytes };
  };
  const getExtendedPublicKey = (secretKey) => hash2extK(sha512s(abytes$3(secretKey, L$1)));
  const hashFinishS = (res) => res.finish(sha512s(res.hashable));
  const _sign$1 = (e, rBytes, msg) => {
    const { pointBytes: P2, scalar: s } = e;
    const r = modL_LE(rBytes);
    const R = G$1.multiply(r).toBytes();
    const hashable = concatBytes$4(R, P2, msg);
    const finish = (hashed) => {
      const S = modN$1(r + modL_LE(hashed) * s);
      return abytes$3(concatBytes$4(R, numTo32bLE(S)), 64);
    };
    return { hashable, finish };
  };
  const sign$1 = (message, secretKey) => {
    const m = abytes$3(message);
    const e = getExtendedPublicKey(secretKey);
    const rBytes = sha512s(e.prefix, m);
    return hashFinishS(_sign$1(e, rBytes, m));
  };
  const hashes$1 = {
    sha512Async: async (message) => {
      const s = subtle$1();
      const m = concatBytes$4(message);
      return u8n$1(await s.digest("SHA-512", m.buffer));
    },
    sha512: void 0
  };
  const W$1 = 8;
  const scalarBits$1 = 256;
  const pwindows$1 = Math.ceil(scalarBits$1 / W$1) + 1;
  const pwindowSize$1 = 2 ** (W$1 - 1);
  const precompute$1 = () => {
    const points = [];
    let p = G$1;
    let b = p;
    for (let w = 0; w < pwindows$1; w++) {
      b = p;
      points.push(b);
      for (let i = 1; i < pwindowSize$1; i++) {
        b = b.add(p);
        points.push(b);
      }
      p = b.double();
    }
    return points;
  };
  let Gpows$1 = void 0;
  const ctneg$1 = (cnd, p) => {
    const n = p.negate();
    return cnd ? n : p;
  };
  const wNAF$2 = (n) => {
    const comp = Gpows$1 || (Gpows$1 = precompute$1());
    let p = I$1;
    let f = G$1;
    const pow_2_w = 2 ** W$1;
    const maxNum = pow_2_w;
    const mask = big$1(pow_2_w - 1);
    const shiftBy = big$1(W$1);
    for (let w = 0; w < pwindows$1; w++) {
      let wbits = Number(n & mask);
      n >>= shiftBy;
      if (wbits > pwindowSize$1) {
        wbits -= maxNum;
        n += 1n;
      }
      const off = w * pwindowSize$1;
      const offF = off;
      const offP = off + Math.abs(wbits) - 1;
      const isEven2 = w % 2 !== 0;
      const isNeg = wbits < 0;
      if (wbits === 0) {
        f = f.add(ctneg$1(isEven2, comp[offF]));
      } else {
        p = p.add(ctneg$1(isNeg, comp[offP]));
      }
    }
    if (n !== 0n)
      err$1("invalid wnaf");
    return { p, f };
  };
  function isBytes$2(a) {
    return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array" && "BYTES_PER_ELEMENT" in a && a.BYTES_PER_ELEMENT === 1;
  }
  function anumber$1(n, title = "") {
    if (typeof n !== "number") {
      const prefix2 = title && `"${title}" `;
      throw new TypeError(`${prefix2}expected number, got ${typeof n}`);
    }
    if (!Number.isSafeInteger(n) || n < 0) {
      const prefix2 = title && `"${title}" `;
      throw new RangeError(`${prefix2}expected integer >= 0, got ${n}`);
    }
  }
  function abytes$2(value, length, title = "") {
    const bytes = isBytes$2(value);
    const len = value?.length;
    const needsLen = length !== void 0;
    if (!bytes || needsLen && len !== length) {
      const prefix2 = title && `"${title}" `;
      const ofLen = needsLen ? ` of length ${length}` : "";
      const got = bytes ? `length=${len}` : `type=${typeof value}`;
      const message = prefix2 + "expected Uint8Array" + ofLen + ", got " + got;
      if (!bytes)
        throw new TypeError(message);
      throw new RangeError(message);
    }
    return value;
  }
  function ahash(h2) {
    if (typeof h2 !== "function" || typeof h2.create !== "function")
      throw new TypeError("Hash must wrapped by utils.createHasher");
    anumber$1(h2.outputLen);
    anumber$1(h2.blockLen);
    if (h2.outputLen < 1)
      throw new Error('"outputLen" must be >= 1');
    if (h2.blockLen < 1)
      throw new Error('"blockLen" must be >= 1');
  }
  function aexists(instance, checkFinished = true) {
    if (instance.destroyed)
      throw new Error("Hash instance has been destroyed");
    if (checkFinished && instance.finished)
      throw new Error("Hash#digest() has already been called");
  }
  function aoutput(out, instance) {
    abytes$2(out, void 0, "digestInto() output");
    const min = instance.outputLen;
    if (out.length < min) {
      throw new RangeError('"digestInto() output" expected to be of length >=' + min);
    }
  }
  function u32(arr) {
    return new Uint32Array(arr.buffer, arr.byteOffset, Math.floor(arr.byteLength / 4));
  }
  function clean(...arrays) {
    for (let i = 0; i < arrays.length; i++) {
      arrays[i].fill(0);
    }
  }
  function createView(arr) {
    return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
  }
  function rotr(word, shift) {
    return word << 32 - shift | word >>> shift;
  }
  const isLE = /* @__PURE__ */ (() => new Uint8Array(new Uint32Array([287454020]).buffer)[0] === 68)();
  function byteSwap(word) {
    return word << 24 & 4278190080 | word << 8 & 16711680 | word >>> 8 & 65280 | word >>> 24 & 255;
  }
  function byteSwap32(arr) {
    for (let i = 0; i < arr.length; i++) {
      arr[i] = byteSwap(arr[i]);
    }
    return arr;
  }
  const swap32IfBE = isLE ? (u) => u : byteSwap32;
  const hasHexBuiltin = /* @__PURE__ */ (() => (
    // @ts-ignore
    typeof Uint8Array.from([]).toHex === "function" && typeof Uint8Array.fromHex === "function"
  ))();
  const hexes = /* @__PURE__ */ Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
  function bytesToHex$2(bytes) {
    abytes$2(bytes);
    if (hasHexBuiltin)
      return bytes.toHex();
    let hex2 = "";
    for (let i = 0; i < bytes.length; i++) {
      hex2 += hexes[bytes[i]];
    }
    return hex2;
  }
  const asciis = { _0: 48, _9: 57, A: 65, F: 70, a: 97, f: 102 };
  function asciiToBase16(ch) {
    if (ch >= asciis._0 && ch <= asciis._9)
      return ch - asciis._0;
    if (ch >= asciis.A && ch <= asciis.F)
      return ch - (asciis.A - 10);
    if (ch >= asciis.a && ch <= asciis.f)
      return ch - (asciis.a - 10);
    return;
  }
  function hexToBytes$2(hex2) {
    if (typeof hex2 !== "string")
      throw new TypeError("hex string expected, got " + typeof hex2);
    if (hasHexBuiltin) {
      try {
        return Uint8Array.fromHex(hex2);
      } catch (error) {
        if (error instanceof SyntaxError)
          throw new RangeError(error.message);
        throw error;
      }
    }
    const hl = hex2.length;
    const al = hl / 2;
    if (hl % 2)
      throw new RangeError("hex string expected, got unpadded hex of length " + hl);
    const array2 = new Uint8Array(al);
    for (let ai = 0, hi = 0; ai < al; ai++, hi += 2) {
      const n1 = asciiToBase16(hex2.charCodeAt(hi));
      const n2 = asciiToBase16(hex2.charCodeAt(hi + 1));
      if (n1 === void 0 || n2 === void 0) {
        const char = hex2[hi] + hex2[hi + 1];
        throw new RangeError('hex string expected, got non-hex character "' + char + '" at index ' + hi);
      }
      array2[ai] = n1 * 16 + n2;
    }
    return array2;
  }
  function concatBytes$3(...arrays) {
    let sum = 0;
    for (let i = 0; i < arrays.length; i++) {
      const a = arrays[i];
      abytes$2(a);
      sum += a.length;
    }
    const res = new Uint8Array(sum);
    for (let i = 0, pad = 0; i < arrays.length; i++) {
      const a = arrays[i];
      res.set(a, pad);
      pad += a.length;
    }
    return res;
  }
  function createHasher(hashCons, info = {}) {
    const hashC = (msg, opts) => hashCons(opts).update(msg).digest();
    const tmp = hashCons(void 0);
    hashC.outputLen = tmp.outputLen;
    hashC.blockLen = tmp.blockLen;
    hashC.canXOF = tmp.canXOF;
    hashC.create = (opts) => hashCons(opts);
    Object.assign(hashC, info);
    return Object.freeze(hashC);
  }
  function randomBytes$3(bytesLength = 32) {
    anumber$1(bytesLength, "bytesLength");
    const cr2 = typeof globalThis === "object" ? globalThis.crypto : null;
    if (typeof cr2?.getRandomValues !== "function")
      throw new Error("crypto.getRandomValues must be defined");
    if (bytesLength > 65536)
      throw new RangeError(`"bytesLength" expected <= 65536, got ${bytesLength}`);
    return cr2.getRandomValues(new Uint8Array(bytesLength));
  }
  const oidNist = (suffix) => ({
    // Current NIST hashAlgs suffixes used here fit in one DER subidentifier octet.
    // Larger suffix values would need base-128 OID encoding and a different length byte.
    oid: Uint8Array.from([6, 9, 96, 134, 72, 1, 101, 3, 4, 2, suffix])
  });
  function Chi(a, b, c) {
    return a & b ^ ~a & c;
  }
  function Maj(a, b, c) {
    return a & b ^ a & c ^ b & c;
  }
  class HashMD {
    blockLen;
    outputLen;
    canXOF = false;
    padOffset;
    isLE;
    // For partial updates less than block size
    buffer;
    view;
    finished = false;
    length = 0;
    pos = 0;
    destroyed = false;
    constructor(blockLen, outputLen, padOffset, isLE2) {
      this.blockLen = blockLen;
      this.outputLen = outputLen;
      this.padOffset = padOffset;
      this.isLE = isLE2;
      this.buffer = new Uint8Array(blockLen);
      this.view = createView(this.buffer);
    }
    update(data) {
      aexists(this);
      abytes$2(data);
      const { view, buffer, blockLen } = this;
      const len = data.length;
      for (let pos = 0; pos < len; ) {
        const take = Math.min(blockLen - this.pos, len - pos);
        if (take === blockLen) {
          const dataView = createView(data);
          for (; blockLen <= len - pos; pos += blockLen)
            this.process(dataView, pos);
          continue;
        }
        buffer.set(data.subarray(pos, pos + take), this.pos);
        this.pos += take;
        pos += take;
        if (this.pos === blockLen) {
          this.process(view, 0);
          this.pos = 0;
        }
      }
      this.length += data.length;
      this.roundClean();
      return this;
    }
    digestInto(out) {
      aexists(this);
      aoutput(out, this);
      this.finished = true;
      const { buffer, view, blockLen, isLE: isLE2 } = this;
      let { pos } = this;
      buffer[pos++] = 128;
      clean(this.buffer.subarray(pos));
      if (this.padOffset > blockLen - pos) {
        this.process(view, 0);
        pos = 0;
      }
      for (let i = pos; i < blockLen; i++)
        buffer[i] = 0;
      view.setBigUint64(blockLen - 8, BigInt(this.length * 8), isLE2);
      this.process(view, 0);
      const oview = createView(out);
      const len = this.outputLen;
      if (len % 4)
        throw new Error("_sha2: outputLen must be aligned to 32bit");
      const outLen = len / 4;
      const state = this.get();
      if (outLen > state.length)
        throw new Error("_sha2: outputLen bigger than state");
      for (let i = 0; i < outLen; i++)
        oview.setUint32(4 * i, state[i], isLE2);
    }
    digest() {
      const { buffer, outputLen } = this;
      this.digestInto(buffer);
      const res = buffer.slice(0, outputLen);
      this.destroy();
      return res;
    }
    _cloneInto(to) {
      to ||= new this.constructor();
      to.set(...this.get());
      const { blockLen, buffer, length, finished, destroyed, pos } = this;
      to.destroyed = destroyed;
      to.finished = finished;
      to.length = length;
      to.pos = pos;
      if (length % blockLen)
        to.buffer.set(buffer);
      return to;
    }
    clone() {
      return this._cloneInto();
    }
  }
  const SHA256_IV = /* @__PURE__ */ Uint32Array.from([
    1779033703,
    3144134277,
    1013904242,
    2773480762,
    1359893119,
    2600822924,
    528734635,
    1541459225
  ]);
  const SHA512_IV = /* @__PURE__ */ Uint32Array.from([
    1779033703,
    4089235720,
    3144134277,
    2227873595,
    1013904242,
    4271175723,
    2773480762,
    1595750129,
    1359893119,
    2917565137,
    2600822924,
    725511199,
    528734635,
    4215389547,
    1541459225,
    327033209
  ]);
  const U32_MASK64 = /* @__PURE__ */ BigInt(2 ** 32 - 1);
  const _32n = /* @__PURE__ */ BigInt(32);
  function fromBig(n, le = false) {
    if (le)
      return { h: Number(n & U32_MASK64), l: Number(n >> _32n & U32_MASK64) };
    return { h: Number(n >> _32n & U32_MASK64) | 0, l: Number(n & U32_MASK64) | 0 };
  }
  function split(lst, le = false) {
    const len = lst.length;
    let Ah = new Uint32Array(len);
    let Al = new Uint32Array(len);
    for (let i = 0; i < len; i++) {
      const { h: h2, l } = fromBig(lst[i], le);
      [Ah[i], Al[i]] = [h2, l];
    }
    return [Ah, Al];
  }
  const shrSH = (h2, _l, s) => h2 >>> s;
  const shrSL = (h2, l, s) => h2 << 32 - s | l >>> s;
  const rotrSH = (h2, l, s) => h2 >>> s | l << 32 - s;
  const rotrSL = (h2, l, s) => h2 << 32 - s | l >>> s;
  const rotrBH = (h2, l, s) => h2 << 64 - s | l >>> s - 32;
  const rotrBL = (h2, l, s) => h2 >>> s - 32 | l << 64 - s;
  const rotlSH = (h2, l, s) => h2 << s | l >>> 32 - s;
  const rotlSL = (h2, l, s) => l << s | h2 >>> 32 - s;
  const rotlBH = (h2, l, s) => l << s - 32 | h2 >>> 64 - s;
  const rotlBL = (h2, l, s) => h2 << s - 32 | l >>> 64 - s;
  function add(Ah, Al, Bh, Bl) {
    const l = (Al >>> 0) + (Bl >>> 0);
    return { h: Ah + Bh + (l / 2 ** 32 | 0) | 0, l: l | 0 };
  }
  const add3L = (Al, Bl, Cl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0);
  const add3H = (low, Ah, Bh, Ch) => Ah + Bh + Ch + (low / 2 ** 32 | 0) | 0;
  const add4L = (Al, Bl, Cl, Dl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0);
  const add4H = (low, Ah, Bh, Ch, Dh) => Ah + Bh + Ch + Dh + (low / 2 ** 32 | 0) | 0;
  const add5L = (Al, Bl, Cl, Dl, El) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0) + (El >>> 0);
  const add5H = (low, Ah, Bh, Ch, Dh, Eh) => Ah + Bh + Ch + Dh + Eh + (low / 2 ** 32 | 0) | 0;
  const SHA256_K = /* @__PURE__ */ Uint32Array.from([
    1116352408,
    1899447441,
    3049323471,
    3921009573,
    961987163,
    1508970993,
    2453635748,
    2870763221,
    3624381080,
    310598401,
    607225278,
    1426881987,
    1925078388,
    2162078206,
    2614888103,
    3248222580,
    3835390401,
    4022224774,
    264347078,
    604807628,
    770255983,
    1249150122,
    1555081692,
    1996064986,
    2554220882,
    2821834349,
    2952996808,
    3210313671,
    3336571891,
    3584528711,
    113926993,
    338241895,
    666307205,
    773529912,
    1294757372,
    1396182291,
    1695183700,
    1986661051,
    2177026350,
    2456956037,
    2730485921,
    2820302411,
    3259730800,
    3345764771,
    3516065817,
    3600352804,
    4094571909,
    275423344,
    430227734,
    506948616,
    659060556,
    883997877,
    958139571,
    1322822218,
    1537002063,
    1747873779,
    1955562222,
    2024104815,
    2227730452,
    2361852424,
    2428436474,
    2756734187,
    3204031479,
    3329325298
  ]);
  const SHA256_W = /* @__PURE__ */ new Uint32Array(64);
  class SHA2_32B extends HashMD {
    constructor(outputLen) {
      super(64, outputLen, 8, false);
    }
    get() {
      const { A, B, C: C2, D, E, F, G: G2, H } = this;
      return [A, B, C2, D, E, F, G2, H];
    }
    // prettier-ignore
    set(A, B, C2, D, E, F, G2, H) {
      this.A = A | 0;
      this.B = B | 0;
      this.C = C2 | 0;
      this.D = D | 0;
      this.E = E | 0;
      this.F = F | 0;
      this.G = G2 | 0;
      this.H = H | 0;
    }
    process(view, offset) {
      for (let i = 0; i < 16; i++, offset += 4)
        SHA256_W[i] = view.getUint32(offset, false);
      for (let i = 16; i < 64; i++) {
        const W15 = SHA256_W[i - 15];
        const W2 = SHA256_W[i - 2];
        const s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ W15 >>> 3;
        const s1 = rotr(W2, 17) ^ rotr(W2, 19) ^ W2 >>> 10;
        SHA256_W[i] = s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16] | 0;
      }
      let { A, B, C: C2, D, E, F, G: G2, H } = this;
      for (let i = 0; i < 64; i++) {
        const sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
        const T1 = H + sigma1 + Chi(E, F, G2) + SHA256_K[i] + SHA256_W[i] | 0;
        const sigma0 = rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22);
        const T2 = sigma0 + Maj(A, B, C2) | 0;
        H = G2;
        G2 = F;
        F = E;
        E = D + T1 | 0;
        D = C2;
        C2 = B;
        B = A;
        A = T1 + T2 | 0;
      }
      A = A + this.A | 0;
      B = B + this.B | 0;
      C2 = C2 + this.C | 0;
      D = D + this.D | 0;
      E = E + this.E | 0;
      F = F + this.F | 0;
      G2 = G2 + this.G | 0;
      H = H + this.H | 0;
      this.set(A, B, C2, D, E, F, G2, H);
    }
    roundClean() {
      clean(SHA256_W);
    }
    destroy() {
      this.destroyed = true;
      this.set(0, 0, 0, 0, 0, 0, 0, 0);
      clean(this.buffer);
    }
  }
  class _SHA256 extends SHA2_32B {
    // We cannot use array here since array allows indexing by variable
    // which means optimizer/compiler cannot use registers.
    A = SHA256_IV[0] | 0;
    B = SHA256_IV[1] | 0;
    C = SHA256_IV[2] | 0;
    D = SHA256_IV[3] | 0;
    E = SHA256_IV[4] | 0;
    F = SHA256_IV[5] | 0;
    G = SHA256_IV[6] | 0;
    H = SHA256_IV[7] | 0;
    constructor() {
      super(32);
    }
  }
  const K512 = /* @__PURE__ */ (() => split([
    "0x428a2f98d728ae22",
    "0x7137449123ef65cd",
    "0xb5c0fbcfec4d3b2f",
    "0xe9b5dba58189dbbc",
    "0x3956c25bf348b538",
    "0x59f111f1b605d019",
    "0x923f82a4af194f9b",
    "0xab1c5ed5da6d8118",
    "0xd807aa98a3030242",
    "0x12835b0145706fbe",
    "0x243185be4ee4b28c",
    "0x550c7dc3d5ffb4e2",
    "0x72be5d74f27b896f",
    "0x80deb1fe3b1696b1",
    "0x9bdc06a725c71235",
    "0xc19bf174cf692694",
    "0xe49b69c19ef14ad2",
    "0xefbe4786384f25e3",
    "0x0fc19dc68b8cd5b5",
    "0x240ca1cc77ac9c65",
    "0x2de92c6f592b0275",
    "0x4a7484aa6ea6e483",
    "0x5cb0a9dcbd41fbd4",
    "0x76f988da831153b5",
    "0x983e5152ee66dfab",
    "0xa831c66d2db43210",
    "0xb00327c898fb213f",
    "0xbf597fc7beef0ee4",
    "0xc6e00bf33da88fc2",
    "0xd5a79147930aa725",
    "0x06ca6351e003826f",
    "0x142929670a0e6e70",
    "0x27b70a8546d22ffc",
    "0x2e1b21385c26c926",
    "0x4d2c6dfc5ac42aed",
    "0x53380d139d95b3df",
    "0x650a73548baf63de",
    "0x766a0abb3c77b2a8",
    "0x81c2c92e47edaee6",
    "0x92722c851482353b",
    "0xa2bfe8a14cf10364",
    "0xa81a664bbc423001",
    "0xc24b8b70d0f89791",
    "0xc76c51a30654be30",
    "0xd192e819d6ef5218",
    "0xd69906245565a910",
    "0xf40e35855771202a",
    "0x106aa07032bbd1b8",
    "0x19a4c116b8d2d0c8",
    "0x1e376c085141ab53",
    "0x2748774cdf8eeb99",
    "0x34b0bcb5e19b48a8",
    "0x391c0cb3c5c95a63",
    "0x4ed8aa4ae3418acb",
    "0x5b9cca4f7763e373",
    "0x682e6ff3d6b2b8a3",
    "0x748f82ee5defb2fc",
    "0x78a5636f43172f60",
    "0x84c87814a1f0ab72",
    "0x8cc702081a6439ec",
    "0x90befffa23631e28",
    "0xa4506cebde82bde9",
    "0xbef9a3f7b2c67915",
    "0xc67178f2e372532b",
    "0xca273eceea26619c",
    "0xd186b8c721c0c207",
    "0xeada7dd6cde0eb1e",
    "0xf57d4f7fee6ed178",
    "0x06f067aa72176fba",
    "0x0a637dc5a2c898a6",
    "0x113f9804bef90dae",
    "0x1b710b35131c471b",
    "0x28db77f523047d84",
    "0x32caab7b40c72493",
    "0x3c9ebe0a15c9bebc",
    "0x431d67c49c100d4c",
    "0x4cc5d4becb3e42b6",
    "0x597f299cfc657e2a",
    "0x5fcb6fab3ad6faec",
    "0x6c44198c4a475817"
  ].map((n) => BigInt(n))))();
  const SHA512_Kh = /* @__PURE__ */ (() => K512[0])();
  const SHA512_Kl = /* @__PURE__ */ (() => K512[1])();
  const SHA512_W_H = /* @__PURE__ */ new Uint32Array(80);
  const SHA512_W_L = /* @__PURE__ */ new Uint32Array(80);
  class SHA2_64B extends HashMD {
    constructor(outputLen) {
      super(128, outputLen, 16, false);
    }
    // prettier-ignore
    get() {
      const { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
      return [Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl];
    }
    // prettier-ignore
    set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl) {
      this.Ah = Ah | 0;
      this.Al = Al | 0;
      this.Bh = Bh | 0;
      this.Bl = Bl | 0;
      this.Ch = Ch | 0;
      this.Cl = Cl | 0;
      this.Dh = Dh | 0;
      this.Dl = Dl | 0;
      this.Eh = Eh | 0;
      this.El = El | 0;
      this.Fh = Fh | 0;
      this.Fl = Fl | 0;
      this.Gh = Gh | 0;
      this.Gl = Gl | 0;
      this.Hh = Hh | 0;
      this.Hl = Hl | 0;
    }
    process(view, offset) {
      for (let i = 0; i < 16; i++, offset += 4) {
        SHA512_W_H[i] = view.getUint32(offset);
        SHA512_W_L[i] = view.getUint32(offset += 4);
      }
      for (let i = 16; i < 80; i++) {
        const W15h = SHA512_W_H[i - 15] | 0;
        const W15l = SHA512_W_L[i - 15] | 0;
        const s0h = rotrSH(W15h, W15l, 1) ^ rotrSH(W15h, W15l, 8) ^ shrSH(W15h, W15l, 7);
        const s0l = rotrSL(W15h, W15l, 1) ^ rotrSL(W15h, W15l, 8) ^ shrSL(W15h, W15l, 7);
        const W2h = SHA512_W_H[i - 2] | 0;
        const W2l = SHA512_W_L[i - 2] | 0;
        const s1h = rotrSH(W2h, W2l, 19) ^ rotrBH(W2h, W2l, 61) ^ shrSH(W2h, W2l, 6);
        const s1l = rotrSL(W2h, W2l, 19) ^ rotrBL(W2h, W2l, 61) ^ shrSL(W2h, W2l, 6);
        const SUMl = add4L(s0l, s1l, SHA512_W_L[i - 7], SHA512_W_L[i - 16]);
        const SUMh = add4H(SUMl, s0h, s1h, SHA512_W_H[i - 7], SHA512_W_H[i - 16]);
        SHA512_W_H[i] = SUMh | 0;
        SHA512_W_L[i] = SUMl | 0;
      }
      let { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
      for (let i = 0; i < 80; i++) {
        const sigma1h = rotrSH(Eh, El, 14) ^ rotrSH(Eh, El, 18) ^ rotrBH(Eh, El, 41);
        const sigma1l = rotrSL(Eh, El, 14) ^ rotrSL(Eh, El, 18) ^ rotrBL(Eh, El, 41);
        const CHIh = Eh & Fh ^ ~Eh & Gh;
        const CHIl = El & Fl ^ ~El & Gl;
        const T1ll = add5L(Hl, sigma1l, CHIl, SHA512_Kl[i], SHA512_W_L[i]);
        const T1h = add5H(T1ll, Hh, sigma1h, CHIh, SHA512_Kh[i], SHA512_W_H[i]);
        const T1l = T1ll | 0;
        const sigma0h = rotrSH(Ah, Al, 28) ^ rotrBH(Ah, Al, 34) ^ rotrBH(Ah, Al, 39);
        const sigma0l = rotrSL(Ah, Al, 28) ^ rotrBL(Ah, Al, 34) ^ rotrBL(Ah, Al, 39);
        const MAJh = Ah & Bh ^ Ah & Ch ^ Bh & Ch;
        const MAJl = Al & Bl ^ Al & Cl ^ Bl & Cl;
        Hh = Gh | 0;
        Hl = Gl | 0;
        Gh = Fh | 0;
        Gl = Fl | 0;
        Fh = Eh | 0;
        Fl = El | 0;
        ({ h: Eh, l: El } = add(Dh | 0, Dl | 0, T1h | 0, T1l | 0));
        Dh = Ch | 0;
        Dl = Cl | 0;
        Ch = Bh | 0;
        Cl = Bl | 0;
        Bh = Ah | 0;
        Bl = Al | 0;
        const All = add3L(T1l, sigma0l, MAJl);
        Ah = add3H(All, T1h, sigma0h, MAJh);
        Al = All | 0;
      }
      ({ h: Ah, l: Al } = add(this.Ah | 0, this.Al | 0, Ah | 0, Al | 0));
      ({ h: Bh, l: Bl } = add(this.Bh | 0, this.Bl | 0, Bh | 0, Bl | 0));
      ({ h: Ch, l: Cl } = add(this.Ch | 0, this.Cl | 0, Ch | 0, Cl | 0));
      ({ h: Dh, l: Dl } = add(this.Dh | 0, this.Dl | 0, Dh | 0, Dl | 0));
      ({ h: Eh, l: El } = add(this.Eh | 0, this.El | 0, Eh | 0, El | 0));
      ({ h: Fh, l: Fl } = add(this.Fh | 0, this.Fl | 0, Fh | 0, Fl | 0));
      ({ h: Gh, l: Gl } = add(this.Gh | 0, this.Gl | 0, Gh | 0, Gl | 0));
      ({ h: Hh, l: Hl } = add(this.Hh | 0, this.Hl | 0, Hh | 0, Hl | 0));
      this.set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl);
    }
    roundClean() {
      clean(SHA512_W_H, SHA512_W_L);
    }
    destroy() {
      this.destroyed = true;
      clean(this.buffer);
      this.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    }
  }
  class _SHA512 extends SHA2_64B {
    Ah = SHA512_IV[0] | 0;
    Al = SHA512_IV[1] | 0;
    Bh = SHA512_IV[2] | 0;
    Bl = SHA512_IV[3] | 0;
    Ch = SHA512_IV[4] | 0;
    Cl = SHA512_IV[5] | 0;
    Dh = SHA512_IV[6] | 0;
    Dl = SHA512_IV[7] | 0;
    Eh = SHA512_IV[8] | 0;
    El = SHA512_IV[9] | 0;
    Fh = SHA512_IV[10] | 0;
    Fl = SHA512_IV[11] | 0;
    Gh = SHA512_IV[12] | 0;
    Gl = SHA512_IV[13] | 0;
    Hh = SHA512_IV[14] | 0;
    Hl = SHA512_IV[15] | 0;
    constructor() {
      super(64);
    }
  }
  const sha256 = /* @__PURE__ */ createHasher(
    () => new _SHA256(),
    /* @__PURE__ */ oidNist(1)
  );
  const sha512 = /* @__PURE__ */ createHasher(
    () => new _SHA512(),
    /* @__PURE__ */ oidNist(3)
  );
  class _HMAC {
    oHash;
    iHash;
    blockLen;
    outputLen;
    canXOF = false;
    finished = false;
    destroyed = false;
    constructor(hash, key) {
      ahash(hash);
      abytes$2(key, void 0, "key");
      this.iHash = hash.create();
      if (typeof this.iHash.update !== "function")
        throw new Error("Expected instance of class which extends utils.Hash");
      this.blockLen = this.iHash.blockLen;
      this.outputLen = this.iHash.outputLen;
      const blockLen = this.blockLen;
      const pad = new Uint8Array(blockLen);
      pad.set(key.length > blockLen ? hash.create().update(key).digest() : key);
      for (let i = 0; i < pad.length; i++)
        pad[i] ^= 54;
      this.iHash.update(pad);
      this.oHash = hash.create();
      for (let i = 0; i < pad.length; i++)
        pad[i] ^= 54 ^ 92;
      this.oHash.update(pad);
      clean(pad);
    }
    update(buf) {
      aexists(this);
      this.iHash.update(buf);
      return this;
    }
    digestInto(out) {
      aexists(this);
      aoutput(out, this);
      this.finished = true;
      const buf = out.subarray(0, this.outputLen);
      this.iHash.digestInto(buf);
      this.oHash.update(buf);
      this.oHash.digestInto(buf);
      this.destroy();
    }
    digest() {
      const out = new Uint8Array(this.oHash.outputLen);
      this.digestInto(out);
      return out;
    }
    _cloneInto(to) {
      to ||= Object.create(Object.getPrototypeOf(this), {});
      const { oHash, iHash, finished, destroyed, blockLen, outputLen } = this;
      to = to;
      to.finished = finished;
      to.destroyed = destroyed;
      to.blockLen = blockLen;
      to.outputLen = outputLen;
      to.oHash = oHash._cloneInto(to.oHash);
      to.iHash = iHash._cloneInto(to.iHash);
      return to;
    }
    clone() {
      return this._cloneInto();
    }
    destroy() {
      this.destroyed = true;
      this.oHash.destroy();
      this.iHash.destroy();
    }
  }
  const hmac = /* @__PURE__ */ (() => {
    const hmac_ = ((hash, key, message) => new _HMAC(hash, key).update(message).digest());
    hmac_.create = (hash, key) => new _HMAC(hash, key);
    return hmac_;
  })();
  const secp256k1_CURVE = Object.freeze({
    p: 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn,
    n: 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n,
    h: 1n,
    a: 0n,
    b: 7n,
    Gx: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
    Gy: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n
  });
  const { p: P, n: N, Gx, Gy, b: _b } = secp256k1_CURVE;
  const L = 32;
  const L2 = 64;
  const lengths = {
    publicKey: L + 1,
    publicKeyUncompressed: L2 + 1,
    signature: L2
  };
  const err = (message = "", E = Error) => {
    const e = new E(message);
    const { captureStackTrace: captureStackTrace2 } = Error;
    if (typeof captureStackTrace2 === "function")
      captureStackTrace2(e, err);
    throw e;
  };
  const isBytes$1 = (a) => a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array" && a.BYTES_PER_ELEMENT === 1;
  const abytes$1 = (value, length, title = "") => {
    const bytes = isBytes$1(value);
    const len = value?.length;
    const needsLen = length !== void 0;
    if (!bytes || needsLen && len !== length) {
      const prefix2 = title && `"${title}" `;
      const ofLen = needsLen ? ` of length ${length}` : "";
      const got = bytes ? `length=${len}` : `type=${typeof value}`;
      const msg = prefix2 + "expected Uint8Array" + ofLen + ", got " + got;
      return bytes ? err(msg, RangeError) : err(msg, TypeError);
    }
    return value;
  };
  const u8n = (len) => new Uint8Array(len);
  const padh = (n, pad) => n.toString(16).padStart(pad, "0");
  const bytesToHex$1 = (b) => {
    let hex2 = "";
    for (const e of abytes$1(b))
      hex2 += padh(e, 2);
    return hex2;
  };
  const C = { _0: 48, _9: 57, A: 65, F: 70, a: 97, f: 102 };
  const _ch = (ch) => ch >= C._0 && ch <= C._9 ? ch - C._0 : ch >= C.A && ch <= C.F ? ch - (C.A - 10) : ch >= C.a && ch <= C.f ? ch - (C.a - 10) : void 0;
  const hexToBytes$1 = (hex2) => {
    const e = "hex invalid";
    if (typeof hex2 !== "string")
      return err(e);
    const hl = hex2.length;
    const al = hl / 2;
    if (hl % 2)
      return err(e);
    const array2 = u8n(al);
    for (let ai = 0, hi = 0; ai < al; ai++, hi += 2) {
      const n1 = _ch(hex2.charCodeAt(hi));
      const n2 = _ch(hex2.charCodeAt(hi + 1));
      if (n1 === void 0 || n2 === void 0)
        return err(e);
      array2[ai] = n1 * 16 + n2;
    }
    return array2;
  };
  const subtle = () => globalThis?.crypto?.subtle ?? err("crypto.subtle must be defined, consider polyfill");
  const concatBytes$2 = (...arrs) => {
    let len = 0;
    for (const a of arrs)
      len += abytes$1(a).length;
    const r = u8n(len);
    let pad = 0;
    for (const a of arrs)
      r.set(a, pad), pad += a.length;
    return r;
  };
  const randomBytes$2 = (len = L) => (globalThis?.crypto).getRandomValues(u8n(len));
  const big = BigInt;
  const arange = (n, min, max, msg = "bad number: out of range") => {
    if (typeof n !== "bigint")
      return err(msg, TypeError);
    if (min <= n && n < max)
      return n;
    return err(msg, RangeError);
  };
  const M = (a, b = P) => {
    const r = a % b;
    return r >= 0n ? r : b + r;
  };
  const modN = (a) => M(a, N);
  const invert$1 = (num, md) => {
    if (num === 0n || md <= 0n)
      err("no inverse n=" + num + " mod=" + md);
    let a = M(num, md), b = md, x = 0n, u = 1n;
    while (a !== 0n) {
      const q = b / a, r = b % a;
      const m = x - u * q;
      b = a, a = r, x = u, u = m;
    }
    return b === 1n ? M(x, md) : err("no inverse");
  };
  const callHash = (name) => {
    const fn = hashes[name];
    if (typeof fn !== "function")
      err("hashes." + name + " not set");
    return fn;
  };
  const gh = (name, a, b) => abytes$1(callHash(name)(a, b), L, "digest");
  const apoint = (p) => p instanceof Point ? p : err("Point expected");
  const koblitz = (x) => M(M(x * x) * x + _b);
  const FpIsValid = (n) => arange(n, 0n, P);
  const FpIsValidNot0 = (n) => arange(n, 1n, P);
  const FnIsValidNot0 = (n) => arange(n, 1n, N);
  const isEven = (y) => !(y & 1n);
  const u8of = (n) => Uint8Array.of(n);
  const getPrefix = (y) => u8of(isEven(y) ? 2 : 3);
  const lift_x = (x) => {
    const c = koblitz(FpIsValidNot0(x));
    let r = 1n;
    for (let num = c, e = (P + 1n) / 4n; e > 0n; e >>= 1n) {
      if (e & 1n)
        r = r * num % P;
      num = num * num % P;
    }
    if (M(r * r) !== c)
      err("sqrt invalid");
    return isEven(r) ? r : M(-r);
  };
  class Point {
    static BASE;
    static ZERO;
    X;
    Y;
    Z;
    constructor(X, Y, Z) {
      this.X = FpIsValid(X);
      this.Y = FpIsValidNot0(Y);
      this.Z = FpIsValid(Z);
      Object.freeze(this);
    }
    /** Returns the shared curve metadata object by reference.
     * It is readonly only at type level, and mutating it won't retarget arithmetic,
     * which already uses module-load snapshots. */
    static CURVE() {
      return secp256k1_CURVE;
    }
    /** Create 3d xyz point from 2d xy. (0, 0) => (0, 1, 0), not (0, 0, 1) */
    static fromAffine(ap) {
      const { x, y } = ap;
      return x === 0n && y === 0n ? I : new Point(x, y, 1n);
    }
    /** Convert Uint8Array or hex string to Point. */
    static fromBytes(bytes) {
      abytes$1(bytes);
      const { publicKey: comp, publicKeyUncompressed: uncomp } = lengths;
      let p = void 0;
      const length = bytes.length;
      const head = bytes[0];
      const tail = bytes.subarray(1);
      const x = sliceBytesNumBE(tail, 0, L);
      if (length === comp && (head === 2 || head === 3)) {
        let y = lift_x(x);
        if (head === 3)
          y = M(-y);
        p = new Point(x, y, 1n);
      }
      if (length === uncomp && head === 4)
        p = new Point(x, sliceBytesNumBE(tail, L, L2), 1n);
      return p ? p.assertValidity() : err("bad point: not on curve");
    }
    static fromHex(hex2) {
      return Point.fromBytes(hexToBytes$1(hex2));
    }
    get x() {
      return this.toAffine().x;
    }
    get y() {
      return this.toAffine().y;
    }
    /** Equality check: compare points P&Q. */
    equals(other) {
      const { X: X1, Y: Y1, Z: Z1 } = this;
      const { X: X2, Y: Y2, Z: Z2 } = apoint(other);
      const X1Z2 = M(X1 * Z2);
      const X2Z1 = M(X2 * Z1);
      const Y1Z2 = M(Y1 * Z2);
      const Y2Z1 = M(Y2 * Z1);
      return X1Z2 === X2Z1 && Y1Z2 === Y2Z1;
    }
    is0() {
      return this.equals(I);
    }
    /** Flip point over y coordinate. */
    negate() {
      return new Point(this.X, M(-this.Y), this.Z);
    }
    /** Point doubling: P+P, complete formula. */
    double() {
      return this.add(this);
    }
    /**
     * Point addition: P+Q, complete, exception-free formula
     * (Renes-Costello-Batina, algo 1 of [2015/1060](https://eprint.iacr.org/2015/1060)).
     * Cost: `12M + 0S + 3*a + 3*b3 + 23add`.
     */
    // prettier-ignore
    add(other) {
      const { X: X1, Y: Y1, Z: Z1 } = this;
      const { X: X2, Y: Y2, Z: Z2 } = apoint(other);
      const a = 0n;
      const b = _b;
      let X3 = 0n, Y3 = 0n, Z3 = 0n;
      const b3 = M(b * 3n);
      let t0 = M(X1 * X2), t1 = M(Y1 * Y2), t2 = M(Z1 * Z2), t3 = M(X1 + Y1);
      let t4 = M(X2 + Y2);
      t3 = M(t3 * t4);
      t4 = M(t0 + t1);
      t3 = M(t3 - t4);
      t4 = M(X1 + Z1);
      let t5 = M(X2 + Z2);
      t4 = M(t4 * t5);
      t5 = M(t0 + t2);
      t4 = M(t4 - t5);
      t5 = M(Y1 + Z1);
      X3 = M(Y2 + Z2);
      t5 = M(t5 * X3);
      X3 = M(t1 + t2);
      t5 = M(t5 - X3);
      Z3 = M(a * t4);
      X3 = M(b3 * t2);
      Z3 = M(X3 + Z3);
      X3 = M(t1 - Z3);
      Z3 = M(t1 + Z3);
      Y3 = M(X3 * Z3);
      t1 = M(t0 + t0);
      t1 = M(t1 + t0);
      t2 = M(a * t2);
      t4 = M(b3 * t4);
      t1 = M(t1 + t2);
      t2 = M(t0 - t2);
      t2 = M(a * t2);
      t4 = M(t4 + t2);
      t0 = M(t1 * t4);
      Y3 = M(Y3 + t0);
      t0 = M(t5 * t4);
      X3 = M(t3 * X3);
      X3 = M(X3 - t0);
      t0 = M(t3 * t1);
      Z3 = M(t5 * Z3);
      Z3 = M(Z3 + t0);
      return new Point(X3, Y3, Z3);
    }
    subtract(other) {
      return this.add(apoint(other).negate());
    }
    /**
     * Point-by-scalar multiplication. Scalar must be in range 1 <= n < CURVE.n.
     * Uses {@link wNAF} for base point.
     * Uses fake point to mitigate leakage shape in JS, not as a hard constant-time guarantee.
     * @param n scalar by which point is multiplied
     * @param safe safe mode guards against timing attacks; unsafe mode is faster
     */
    multiply(n, safe = true) {
      if (!safe && n === 0n)
        return I;
      FnIsValidNot0(n);
      if (n === 1n)
        return this;
      if (this.equals(G))
        return wNAF$1(n).p;
      let p = I;
      let f = G;
      for (let d = this; n > 0n; d = d.double(), n >>= 1n) {
        if (n & 1n)
          p = p.add(d);
        else if (safe)
          f = f.add(d);
      }
      return p;
    }
    multiplyUnsafe(scalar) {
      return this.multiply(scalar, false);
    }
    /** Convert point to 2d xy affine point. (X, Y, Z) ∋ (x=X/Z, y=Y/Z) */
    toAffine() {
      const { X: x, Y: y, Z: z } = this;
      if (this.equals(I))
        return { x: 0n, y: 0n };
      if (z === 1n)
        return { x, y };
      const iz = invert$1(z, P);
      if (M(z * iz) !== 1n)
        err("inverse invalid");
      return { x: M(x * iz), y: M(y * iz) };
    }
    /** Checks if the point is valid and on-curve. */
    assertValidity() {
      const { x, y } = this.toAffine();
      FpIsValidNot0(x);
      FpIsValidNot0(y);
      return M(y * y) === koblitz(x) ? this : err("bad point: not on curve");
    }
    /** Converts point to 33/65-byte Uint8Array. */
    toBytes(isCompressed = true) {
      const { x, y } = this.assertValidity().toAffine();
      const x32b = numTo32b(x);
      if (isCompressed)
        return concatBytes$2(getPrefix(y), x32b);
      return concatBytes$2(u8of(4), x32b, numTo32b(y));
    }
    toHex(isCompressed) {
      return bytesToHex$1(this.toBytes(isCompressed));
    }
  }
  const G = new Point(Gx, Gy, 1n);
  const I = new Point(0n, 1n, 0n);
  Point.BASE = G;
  Point.ZERO = I;
  const bytesToNumBE = (b) => big("0x" + (bytesToHex$1(b) || "0"));
  const sliceBytesNumBE = (b, from, to) => bytesToNumBE(b.subarray(from, to));
  const B256 = 2n ** 256n;
  const numTo32b = (num) => hexToBytes$1(padh(arange(num, 0n, B256), L2));
  const secretKeyToScalar = (secretKey) => {
    const num = bytesToNumBE(abytes$1(secretKey, L, "secret key"));
    return arange(num, 1n, N, "invalid secret key: outside of range");
  };
  const highS = (n) => n > N >> 1n;
  const assertRecoveryBit = (recovery) => [0, 1, 2, 3].includes(recovery) ? recovery : err("invalid recovery id");
  const assertSigFormat = (format) => {
    if (format === SIG_DER)
      err('Signature format "der" is not supported: switch to noble-curves');
    if (format != null && format !== SIG_COMPACT && format !== SIG_RECOVERED)
      err("Signature format must be one of: compact, recovered, der");
  };
  const assertSigLength = (sig, format = SIG_COMPACT) => {
    assertSigFormat(format);
    const len = lengths.signature + Number(format === SIG_RECOVERED);
    if (sig.length !== len)
      err(`Signature format "${format}" expects Uint8Array with length ${len}`);
  };
  class Signature {
    r;
    s;
    recovery;
    constructor(r, s, recovery) {
      this.r = FnIsValidNot0(r);
      this.s = FnIsValidNot0(s);
      if (recovery != null)
        this.recovery = assertRecoveryBit(recovery);
      Object.freeze(this);
    }
    static fromBytes(b, format = SIG_COMPACT) {
      assertSigLength(b, format);
      let rec;
      if (format === SIG_RECOVERED) {
        rec = b[0];
        b = b.subarray(1);
      }
      const r = sliceBytesNumBE(b, 0, L);
      const s = sliceBytesNumBE(b, L, L2);
      return new Signature(r, s, rec);
    }
    addRecoveryBit(bit) {
      return new Signature(this.r, this.s, bit);
    }
    hasHighS() {
      return highS(this.s);
    }
    toBytes(format = SIG_COMPACT) {
      assertSigFormat(format);
      const { r, s, recovery } = this;
      const res = concatBytes$2(numTo32b(r), numTo32b(s));
      if (format === SIG_RECOVERED) {
        return concatBytes$2(u8of(assertRecoveryBit(recovery)), res);
      }
      return res;
    }
  }
  const bits2int = (bytes) => {
    if (bytes.length > 8192)
      err("input is too large");
    const delta = bytes.length * 8 - 256;
    const num = bytesToNumBE(bytes);
    return delta > 0 ? num >> big(delta) : num;
  };
  const bits2int_modN = (bytes) => modN(bits2int(abytes$1(bytes)));
  const SIG_COMPACT = "compact";
  const SIG_RECOVERED = "recovered";
  const SIG_DER = "der";
  const _sha = "SHA-256";
  const hashes = {
    hmacSha256Async: async (key, message) => {
      const s = subtle();
      const name = "HMAC";
      const k = await s.importKey("raw", key, { name, hash: { name: _sha } }, false, ["sign"]);
      return u8n(await s.sign(name, k, message));
    },
    hmacSha256: void 0,
    sha256Async: async (msg) => u8n(await subtle().digest(_sha, msg)),
    sha256: void 0
  };
  const prepMsg = (msg, opts, async_) => {
    const message = abytes$1(msg, void 0, "message");
    if (!opts.prehash)
      return message;
    return gh("sha256", message);
  };
  const NULL = /* @__PURE__ */ u8n(0);
  const byte0 = /* @__PURE__ */ u8of(0);
  const byte1 = /* @__PURE__ */ u8of(1);
  const _maxDrbgIters = 1e3;
  const _drbgErr = "drbg: tried max amount of iterations";
  const hmacDrbg = (seed, pred) => {
    let v = u8n(L);
    let k = u8n(L);
    let i = 0;
    const reset = () => {
      v.fill(1);
      k.fill(0);
    };
    const h2 = (...b) => gh("hmacSha256", k, concatBytes$2(v, ...b));
    const reseed = (seed2 = NULL) => {
      k = h2(byte0, seed2);
      v = h2();
      if (seed2.length === 0)
        return;
      k = h2(byte1, seed2);
      v = h2();
    };
    const gen = () => {
      if (i++ >= _maxDrbgIters)
        err(_drbgErr);
      v = h2();
      return v;
    };
    reset();
    reseed(seed);
    let res = void 0;
    while (!(res = pred(gen())))
      reseed();
    reset();
    return res;
  };
  const _sign = (messageHash, secretKey, opts, hmacDrbg2) => {
    let { lowS, extraEntropy } = opts;
    const int2octets = numTo32b;
    const h1i = bits2int_modN(messageHash);
    const h1o = int2octets(h1i);
    const d = secretKeyToScalar(secretKey);
    const seedArgs = [int2octets(d), h1o];
    if (extraEntropy != null && extraEntropy !== false) {
      const e = extraEntropy === true ? randomBytes$2(L) : extraEntropy;
      seedArgs.push(abytes$1(e, void 0, "extraEntropy"));
    }
    const seed = concatBytes$2(...seedArgs);
    const m = h1i;
    const k2sig = (kBytes) => {
      const k = bits2int(kBytes);
      if (!(1n <= k && k < N))
        return;
      const ik = invert$1(k, N);
      const q = G.multiply(k).toAffine();
      const r = modN(q.x);
      if (r === 0n)
        return;
      const s = modN(ik * modN(m + r * d));
      if (s === 0n)
        return;
      let recovery = (q.x === r ? 0 : 2) | Number(q.y & 1n);
      let normS = s;
      if (lowS && highS(s)) {
        normS = modN(-s);
        recovery ^= 1;
      }
      const sig = new Signature(r, normS, recovery);
      return sig.toBytes(opts.format);
    };
    return hmacDrbg2(seed, k2sig);
  };
  const setDefaults = (opts) => {
    return {
      lowS: opts.lowS ?? true,
      prehash: opts.prehash ?? true,
      format: opts.format ?? SIG_COMPACT,
      extraEntropy: opts.extraEntropy ?? false
    };
  };
  const sign = (message, secretKey, opts = {}) => {
    opts = setDefaults(opts);
    assertSigFormat(opts.format);
    const msg = prepMsg(message, opts);
    return _sign(msg, secretKey, opts, hmacDrbg);
  };
  const W = 8;
  const scalarBits = 256;
  const pwindows = Math.ceil(scalarBits / W) + 1;
  const pwindowSize = 2 ** (W - 1);
  const precompute = () => {
    const points = [];
    let p = G;
    let b = p;
    for (let w = 0; w < pwindows; w++) {
      b = p;
      points.push(b);
      for (let i = 1; i < pwindowSize; i++) {
        b = b.add(p);
        points.push(b);
      }
      p = b.double();
    }
    return points;
  };
  let Gpows = void 0;
  const ctneg = (cnd, p) => {
    const n = p.negate();
    return cnd ? n : p;
  };
  const wNAF$1 = (n) => {
    const comp = Gpows || (Gpows = precompute());
    let p = I;
    let f = G;
    const pow_2_w = 2 ** W;
    const maxNum = pow_2_w;
    const mask = big(pow_2_w - 1);
    const shiftBy = big(W);
    for (let w = 0; w < pwindows; w++) {
      let wbits = Number(n & mask);
      n >>= shiftBy;
      if (wbits > pwindowSize) {
        wbits -= maxNum;
        n += 1n;
      }
      const off = w * pwindowSize;
      const offF = off;
      const offP = off + Math.abs(wbits) - 1;
      const isEven2 = w % 2 !== 0;
      const isNeg = wbits < 0;
      if (wbits === 0) {
        f = f.add(ctneg(isEven2, comp[offF]));
      } else {
        p = p.add(ctneg(isNeg, comp[offP]));
      }
    }
    if (n !== 0n)
      err("invalid wnaf");
    return { p, f };
  };
  const BinaryLengths = {
    Ed25519: {
      PrivateKey: 64,
      SecretKey: 32,
      PublicKey: 32,
      Signature: 64
    },
    Secp256k1: {
      PrivateKey: 96,
      SecretKey: 32,
      PublicKey: 64,
      Signature: 65
    }
  };
  const Nep413Message = {
    NonceLength: 32
  };
  const result = {
    ok: (value) => ({
      ok: true,
      value
    }),
    err: (error) => ({
      ok: false,
      error
    })
  };
  const NatErrorBrand = /* @__PURE__ */ Symbol("NatError");
  var NatError = class extends Error {
    [NatErrorBrand] = true;
    kind;
    context;
    constructor(args) {
      super(`<${args.kind}>`);
      this.name = "NatError";
      this.kind = args.kind;
      this.context = args.context;
    }
  };
  const createNatError = (args) => new NatError(args);
  const resultNatError = (kind, context) => result.err(new NatError({
    kind,
    context
  }));
  const isNatError = (error, kind) => {
    const isNatErr = typeof error === "object" && error !== null && NatErrorBrand in error;
    return isNatErr && error?.kind === kind;
  };
  const isNatErrorOf = (error, kinds) => {
    if (!(typeof error === "object" && error !== null && NatErrorBrand in error)) return false;
    return kinds.includes(error.kind);
  };
  const oneLine = (msg) => msg.replace(/\s+/g, " ").trim();
  const nodeInspectSymbol = typeof process !== "undefined" && process.versions != null && process.versions.node != null ? /* @__PURE__ */ Symbol.for("nodejs.util.inspect.custom") : void 0;
  const toJsonBytes = (value) => new TextEncoder().encode(JSON.stringify(value));
  const fromJsonBytes = (bytes) => {
    const u8 = Array.isArray(bytes) ? new Uint8Array(bytes) : bytes;
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(u8));
  };
  const combineAbortSignals = (signals) => AbortSignal.any(signals.filter((signal) => typeof signal !== "undefined"));
  const randomBetween = (min, max) => Math.random() * (max - min) + min;
  const AccountIdZodSchema = (/* @__PURE__ */ string()).check(/* @__PURE__ */ _minLength(2), /* @__PURE__ */ _maxLength(64), /* @__PURE__ */ _regex(/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/, { error: oneLine(`Account ID may contain only lowercase letters (a–z), 
    digits (0–9), and separators (., -, _).`) }));
  const Base64StringZodSchema = (/* @__PURE__ */ string()).check(/* @__PURE__ */ _regex(/^[A-Za-z0-9+/]*={0,2}$/, oneLine(`Base64 string contains invalid characters. Allowed characters:
    ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=`)), /* @__PURE__ */ refine((val) => val.length % 4 === 0, "Base64 string length must be a multiple of 4"));
  const CurveStringZodSchema = /* @__PURE__ */ pipe((/* @__PURE__ */ string()).check(/* @__PURE__ */ _regex(/^(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]+$/, oneLine(`Curve strings should use the 
      ed25519:<base58String> or secp256k1:<base58String> format.`))), /* @__PURE__ */ transform((curveString) => {
    const [curve, dataBase58] = curveString.split(":");
    return {
      curveString,
      curve,
      dataU8: base58.decode(dataBase58)
    };
  }));
  const { Ed25519: Ed25519$3, Secp256k1: Secp256k1$3 } = BinaryLengths;
  const PublicKeyZodSchema = (/* @__PURE__ */ pipe(CurveStringZodSchema, /* @__PURE__ */ transform((val) => ({
    publicKey: val.curveString,
    publicKeyU8: val.dataU8,
    curve: val.curve
  })))).check(/* @__PURE__ */ refine(({ curve, publicKeyU8 }) => curve === "ed25519" ? publicKeyU8.length === Ed25519$3.PublicKey : publicKeyU8.length === Secp256k1$3.PublicKey, { error: "Invalid public key length" }));
  const { Ed25519: Ed25519$2, Secp256k1: Secp256k1$2 } = BinaryLengths;
  const SignatureZodSchema = (/* @__PURE__ */ pipe(CurveStringZodSchema, /* @__PURE__ */ transform((val) => ({
    signature: val.curveString,
    signatureU8: val.dataU8,
    curve: val.curve
  })))).check(/* @__PURE__ */ refine(({ curve, signatureU8 }) => curve === "ed25519" ? signatureU8.length === Ed25519$2.Signature : signatureU8.length === Secp256k1$2.Signature, { error: "Invalid signature length" }));
  (/* @__PURE__ */ pipe(Base64StringZodSchema, /* @__PURE__ */ transform((nonce) => {
    return {
      nonce,
      nonceU8: Uint8Array.fromBase64(nonce)
    };
  }))).check(/* @__PURE__ */ refine(({ nonceU8 }) => nonceU8.length === 32, { error: "Binary nonce length should be 32 bytes" }));
  const toEd25519CurveString = (dataU8) => `ed25519:${base58.encode(dataU8)}`;
  const toSecp256k1CurveString = (dataU8) => `secp256k1:${base58.encode(dataU8)}`;
  const asThrowable = (safeFn) => {
    return (...args) => {
      const result2 = safeFn(...args);
      if (result2 instanceof Promise) return result2.then((res) => {
        if (res.ok) return res.value;
        throw res.error;
      });
      if (result2.ok) return result2.value;
      throw result2.error;
    };
  };
  const returnError = (e, kind) => result.err(createNatError({
    kind,
    context: { cause: e }
  }));
  const wrapInternalError = (kind, fn) => (...args) => {
    try {
      const res = fn(...args);
      if (res instanceof Promise) return res.catch((e) => returnError(e, kind));
      return res;
    } catch (e) {
      return returnError(e, kind);
    }
  };
  const Base58StringZodSchema = (/* @__PURE__ */ string()).check(/* @__PURE__ */ _regex(/^[1-9A-HJ-NP-Za-km-z]+$/, oneLine(`Base58 string contains invalid characters. Allowed characters:
    123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz`)));
  const CryptoHashZodSchema = (/* @__PURE__ */ pipe(Base58StringZodSchema, /* @__PURE__ */ transform((cryptoHash) => {
    return {
      cryptoHash,
      cryptoHashU8: base58.decode(cryptoHash)
    };
  }))).check(/* @__PURE__ */ refine(({ cryptoHashU8 }) => cryptoHashU8.length === 32, { error: "Crypto hash length should be 32 bytes" }));
  const BlockHashZodSchema = CryptoHashZodSchema;
  const BlockHeightZodSchema = (/* @__PURE__ */ number()).check(/* @__PURE__ */ _nonnegative());
  const TransactionNonceZodSchema = (/* @__PURE__ */ number()).check(/* @__PURE__ */ int(), /* @__PURE__ */ _nonnegative());
  const ContractFunctionNameZodSchema = (/* @__PURE__ */ string()).check(/* @__PURE__ */ _minLength(1), /* @__PURE__ */ _maxLength(256));
  const JsonValueZodSchema = /* @__PURE__ */ json();
  const repackError = ({ error, originPrefix, targetPrefix }) => {
    const newKind = `${targetPrefix}.${error.kind.slice(originPrefix.length + 1)}`;
    return result.err(createNatError({
      kind: newKind,
      context: error.context
    }));
  };
  const PartialBlockResultSchema = /* @__PURE__ */ object({ header: /* @__PURE__ */ object({ hash: BlockHashZodSchema }) });
  const GetRecentBlockHashArgsSchema = /* @__PURE__ */ optional(/* @__PURE__ */ object({ options: /* @__PURE__ */ optional(/* @__PURE__ */ object({
    refreshCache: /* @__PURE__ */ optional(/* @__PURE__ */ boolean()),
    signal: /* @__PURE__ */ optional(/* @__PURE__ */ _instanceof(AbortSignal))
  })) }));
  const createGetRecentBlockHash = (transport, state) => wrapInternalError("Client.GetRecentBlockHash.Internal", async (args) => {
    const validArgs = GetRecentBlockHashArgsSchema.safeParse(args);
    if (!validArgs.success) return result.err(createNatError({
      kind: "Client.GetRecentBlockHash.Args.InvalidSchema",
      context: { zodError: validArgs.error }
    }));
    if (!args?.options?.refreshCache && state.recentBlockHash.value !== void 0 && state.recentBlockHash.validUntil > Date.now()) return result.ok(state.recentBlockHash.value);
    const rpcResponse = await transport.sendRequest({
      method: "block",
      params: { finality: "near-final" },
      signal: args?.options?.signal
    });
    if (!rpcResponse.ok && rpcResponse.error.kind === "SendRequest.PreferredRpc.NotFound") throw rpcResponse.error;
    if (!rpcResponse.ok) return repackError({
      error: rpcResponse.error,
      originPrefix: "SendRequest",
      targetPrefix: "Client.GetRecentBlockHash"
    });
    if (rpcResponse.value.error) return result.err(createNatError({
      kind: "Client.GetRecentBlockHash.Internal",
      context: { cause: rpcResponse.value }
    }));
    const rpcResult = PartialBlockResultSchema.safeParse(rpcResponse.value.result);
    if (!rpcResult.success) return result.err(createNatError({
      kind: "Client.GetRecentBlockHash.Exhausted",
      context: { lastError: createNatError({
        kind: "SendRequest.Attempt.Response.InvalidSchema",
        context: { zodError: rpcResult.error }
      }) }
    }));
    state.recentBlockHash.value = rpcResult.data.header.hash.cryptoHash;
    state.recentBlockHash.validUntil = Date.now() + 36e5;
    return result.ok(state.recentBlockHash.value);
  });
  const PartialProtocolConfigResultSchema = /* @__PURE__ */ object({ runtimeConfig: /* @__PURE__ */ object({ storageAmountPerByte: /* @__PURE__ */ string() }) });
  const createGetStoragePricePerByte = (transport, state) => async (args) => {
    if (!args?.refreshCache && state.storagePricePerByte.value !== void 0 && state.storagePricePerByte.validUntil > Date.now()) return result.ok(state.storagePricePerByte.value);
    const protocolConfig = await transport.sendRequest({
      method: "EXPERIMENTAL_protocol_config",
      params: { finality: "near-final" },
      signal: args?.signal
    });
    if (!protocolConfig.ok) return protocolConfig;
    const rpcResult = PartialProtocolConfigResultSchema.safeParse(protocolConfig.value.result);
    if (!rpcResult.success) return result.err(createNatError({
      kind: "SendRequest.Exhausted",
      context: { lastError: createNatError({
        kind: "SendRequest.Attempt.Response.InvalidSchema",
        context: { zodError: rpcResult.error }
      }) }
    }));
    state.storagePricePerByte.value = throwableYoctoNear(rpcResult.data.runtimeConfig.storageAmountPerByte);
    state.storagePricePerByte.validUntil = Date.now() + 36e5;
    return result.ok(state.storagePricePerByte.value);
  };
  const createCache = (args) => {
    const state = {
      storagePricePerByte: { validUntil: 0 },
      recentBlockHash: { validUntil: 0 }
    };
    return {
      getStoragePricePerByte: createGetStoragePricePerByte(args.transport, state),
      getRecentBlockHash: createGetRecentBlockHash(args.transport, state)
    };
  };
  const Regular = /* @__PURE__ */ literal("Regular");
  const Archival = /* @__PURE__ */ literal("Archival");
  const RpcTypePreferencesZodSchema = /* @__PURE__ */ union([
    /* @__PURE__ */ tuple([Regular]),
    /* @__PURE__ */ tuple([Archival]),
    /* @__PURE__ */ tuple([Regular, Archival]),
    /* @__PURE__ */ tuple([Archival, Regular])
  ]);
  const TransportPolicyZodSchema = /* @__PURE__ */ object({
    rpcTypePreferences: RpcTypePreferencesZodSchema,
    timeouts: /* @__PURE__ */ partial(/* @__PURE__ */ object({
      requestMs: (/* @__PURE__ */ number()).check(/* @__PURE__ */ int(), /* @__PURE__ */ _gte(100)),
      attemptMs: (/* @__PURE__ */ number()).check(/* @__PURE__ */ int(), /* @__PURE__ */ _gte(100))
    })),
    rpc: /* @__PURE__ */ partial(/* @__PURE__ */ object({
      maxAttempts: (/* @__PURE__ */ number()).check(/* @__PURE__ */ int(), /* @__PURE__ */ _gte(1)),
      retryBackoff: /* @__PURE__ */ partial(/* @__PURE__ */ object({
        minDelayMs: (/* @__PURE__ */ number()).check(/* @__PURE__ */ int(), /* @__PURE__ */ _nonnegative()),
        maxDelayMs: (/* @__PURE__ */ number()).check(/* @__PURE__ */ int(), /* @__PURE__ */ _nonnegative()),
        multiplier: (/* @__PURE__ */ number()).check(/* @__PURE__ */ int(), /* @__PURE__ */ _gte(1))
      }))
    })),
    failover: /* @__PURE__ */ partial(/* @__PURE__ */ object({
      maxRounds: (/* @__PURE__ */ number()).check(/* @__PURE__ */ int(), /* @__PURE__ */ _gte(1)),
      nextRpcDelayMs: (/* @__PURE__ */ number()).check(/* @__PURE__ */ int(), /* @__PURE__ */ _nonnegative()),
      nextRoundDelayMs: (/* @__PURE__ */ number()).check(/* @__PURE__ */ int(), /* @__PURE__ */ _nonnegative())
    }))
  });
  const PartialTransportPolicyZodSchema = /* @__PURE__ */ optional(/* @__PURE__ */ partial(TransportPolicyZodSchema));
  const defaultTransportPolicy = {
    rpcTypePreferences: ["Regular", "Archival"],
    timeouts: {
      requestMs: 3e4,
      attemptMs: 5e3
    },
    rpc: {
      maxAttempts: 2,
      retryBackoff: {
        minDelayMs: 100,
        maxDelayMs: 500,
        multiplier: 3
      }
    },
    failover: {
      maxRounds: 2,
      nextRpcDelayMs: 200,
      nextRoundDelayMs: 200
    }
  };
  const mergeTransportPolicy = (base, next = {}) => mergeWith({}, cloneDeep(base), cloneDeep(next), (_objValue, srcValue, key) => {
    if (key === "rpcTypePreferences" && Array.isArray(srcValue)) return srcValue;
  });
  const PoliciesZodSchema = /* @__PURE__ */ optional(/* @__PURE__ */ object({ transport: PartialTransportPolicyZodSchema }));
  const BaseOptionsZodSchema = /* @__PURE__ */ optional(/* @__PURE__ */ object({ signal: /* @__PURE__ */ optional(/* @__PURE__ */ _instanceof(AbortSignal)) }));
  const BlockReferenceZodSchema = /* @__PURE__ */ union([
    /* @__PURE__ */ literal("LatestOptimisticBlock"),
    /* @__PURE__ */ literal("LatestNearFinalBlock"),
    /* @__PURE__ */ literal("LatestFinalBlock"),
    /* @__PURE__ */ literal("EarliestAvailableBlock"),
    /* @__PURE__ */ literal("GenesisBlock"),
    /* @__PURE__ */ object({
      blockHash: BlockHashZodSchema,
      blockHeight: /* @__PURE__ */ optional(/* @__PURE__ */ never())
    }),
    /* @__PURE__ */ object({
      blockHash: /* @__PURE__ */ optional(/* @__PURE__ */ never()),
      blockHeight: BlockHeightZodSchema
    })
  ]);
  const toNativeBlockReference = (blockReference) => {
    if (blockReference === "LatestOptimisticBlock") return { finality: "optimistic" };
    if (blockReference === "LatestNearFinalBlock") return { finality: "near-final" };
    if (blockReference === "LatestFinalBlock") return { finality: "final" };
    if (blockReference === "EarliestAvailableBlock") return { sync_checkpoint: "earliest_available" };
    if (blockReference === "GenesisBlock") return { sync_checkpoint: "genesis" };
    if (blockReference && "blockHash" in blockReference) return { block_id: blockReference.blockHash };
    if (blockReference && "blockHeight" in blockReference) return { block_id: blockReference.blockHeight };
    return { finality: "optimistic" };
  };
  const handleError$5 = (rpcResponse) => {
    const rpcError = ErrorWrapperFor_RpcQueryErrorSchema().safeParse(rpcResponse.error);
    if (!rpcError.success) return result.err(createNatError({
      kind: "Client.GetAccountAccessKey.Exhausted",
      context: { lastError: createNatError({
        kind: "SendRequest.Attempt.Response.InvalidSchema",
        context: { zodError: rpcError.error }
      }) }
    }));
    const { name, cause } = rpcError.data;
    if (name === "HANDLER_ERROR") {
      if (cause.name === "NO_SYNCED_BLOCKS") return result.err(createNatError({
        kind: `Client.GetAccountAccessKey.Rpc.NotSynced`,
        context: null
      }));
      if (cause.name === "UNAVAILABLE_SHARD") return result.err(createNatError({
        kind: `Client.GetAccountAccessKey.Rpc.Shard.NotTracked`,
        context: { shardId: cause.info.requestedShardId }
      }));
      if (cause.name === "GARBAGE_COLLECTED_BLOCK") return result.err(createNatError({
        kind: `Client.GetAccountAccessKey.Rpc.Block.GarbageCollected`,
        context: {
          blockHash: cause.info.blockHash,
          blockHeight: cause.info.blockHeight
        }
      }));
      if (cause.name === "UNKNOWN_BLOCK" && "blockId" in cause.info.blockReference) return result.err(createNatError({
        kind: `Client.GetAccountAccessKey.Rpc.Block.NotFound`,
        context: { blockId: cause.info.blockReference.blockId }
      }));
    }
    return result.err(createNatError({
      kind: "Client.GetAccountAccessKey.Internal",
      context: { cause: rpcResponse }
    }));
  };
  const createTokensInputZodSchema = (decimals) => (/* @__PURE__ */ string()).check(/* @__PURE__ */ refine((val) => {
    return new RegExp(`^\\d+(?:\\.\\d{1,${decimals}})?$`).test(val);
  }, { message: `Must be a valid number with up to ${decimals} decimal places` }));
  const NearInputZodSchema = createTokensInputZodSchema(24);
  const BigintStringZodSchema = /* @__PURE__ */ pipe((/* @__PURE__ */ string()).check(/* @__PURE__ */ _regex(/^\d+$/, "Must contain only digits")), /* @__PURE__ */ transform((v) => BigInt(v)));
  const YoctoNearInputZodSchema = /* @__PURE__ */ union([/* @__PURE__ */ bigint(), BigintStringZodSchema]);
  const NearTokenArgsZodSchema = /* @__PURE__ */ union([/* @__PURE__ */ object({ near: NearInputZodSchema }), /* @__PURE__ */ object({ yoctoNear: YoctoNearInputZodSchema })]);
  const POW10_CACHE = {};
  const pow10 = (decimals) => {
    const cached2 = POW10_CACHE[decimals];
    if (cached2 !== void 0) return cached2;
    const value = 10n ** BigInt(decimals);
    POW10_CACHE[decimals] = value;
    return value;
  };
  const convertTokensToUnits = (tokens, decimals) => {
    const [integerPartRaw, fractionalPartRaw = ""] = tokens.split(".");
    const isNegative = integerPartRaw.startsWith("-");
    const scale = pow10(decimals);
    const integerUnits = BigInt(integerPartRaw) * scale;
    const fractionalUnits = fractionalPartRaw.length > 0 ? BigInt(fractionalPartRaw.padEnd(decimals, "0")) : 0n;
    return isNegative ? integerUnits - fractionalUnits : integerUnits + fractionalUnits;
  };
  const convertUnitsToTokens = (units, decimals) => {
    const scale = pow10(decimals);
    const isNegative = units < 0n;
    const sign2 = isNegative ? "-" : "";
    const wholePart = isNegative ? -(units / scale) : units / scale;
    const fractionalRemainder = isNegative ? -(units % scale) : units % scale;
    if (fractionalRemainder === 0n) return `${sign2}${wholePart.toString()}`;
    const fractionalDigits = fractionalRemainder.toString().padStart(decimals, "0").replace(/0+$/, "");
    if (fractionalDigits.length === 0) return `${sign2}${wholePart.toString()}`;
    return `${sign2}${wholePart.toString()}.${fractionalDigits}`;
  };
  const NearTokenBrand = /* @__PURE__ */ Symbol("NearToken");
  const cache$1 = {
    yoctoNear: /* @__PURE__ */ new WeakMap(),
    near: /* @__PURE__ */ new WeakMap()
  };
  const isNearToken = (value) => typeof value === "object" && value !== null && NearTokenBrand in value;
  const toYoctoNear = (x) => {
    if (isNearToken(x)) return result.ok(x.yoctoNear);
    const nearToken = safeNearToken(x);
    return nearToken.ok ? result.ok(nearToken.value.yoctoNear) : nearToken;
  };
  const nearTokenProto = {
    [NearTokenBrand]: true,
    get near() {
      const maybeValue = cache$1.near.get(this);
      if (maybeValue) return maybeValue;
      const value = convertUnitsToTokens(this.yoctoNear, 24);
      cache$1.near.set(this, value);
      return value;
    },
    get yoctoNear() {
      const maybeValue = cache$1.yoctoNear.get(this);
      if (maybeValue) return maybeValue;
      const value = convertTokensToUnits(this.near, 24);
      cache$1.yoctoNear.set(this, value);
      return value;
    },
    safeAdd(value) {
      return wrapInternalError("CreateNearToken.Internal", () => {
        const yoctoNear = toYoctoNear(value);
        return yoctoNear.ok ? safeNearToken({ yoctoNear: this.yoctoNear + yoctoNear.value }) : yoctoNear;
      })();
    },
    add(value) {
      return asThrowable(this.safeAdd.bind(this))(value);
    },
    safeSub(value) {
      return wrapInternalError("CreateNearToken.Internal", () => {
        const yoctoNear = toYoctoNear(value);
        return yoctoNear.ok ? safeNearToken({ yoctoNear: this.yoctoNear - yoctoNear.value }) : yoctoNear;
      })();
    },
    sub(value) {
      return asThrowable(this.safeSub.bind(this))(value);
    },
    safeGt(value) {
      return wrapInternalError("CreateNearToken.Internal", () => {
        const yoctoNear = toYoctoNear(value);
        return yoctoNear.ok ? result.ok(this.yoctoNear > yoctoNear.value) : yoctoNear;
      })();
    },
    gt(value) {
      return asThrowable(this.safeGt.bind(this))(value);
    },
    safeLt(value) {
      return wrapInternalError("CreateNearToken.Internal", () => {
        const yoctoNear = toYoctoNear(value);
        return yoctoNear.ok ? result.ok(this.yoctoNear < yoctoNear.value) : yoctoNear;
      })();
    },
    lt(value) {
      return asThrowable(this.safeLt.bind(this))(value);
    },
    toString() {
      return JSON.stringify({
        near: this.near,
        yoctoNear: this.yoctoNear.toString()
      });
    },
    ...nodeInspectSymbol && { [nodeInspectSymbol](_depth, _opts) {
      return {
        near: this.near,
        yoctoNear: this.yoctoNear
      };
    } }
  };
  const safeYoctoNear = wrapInternalError("CreateNearTokenFromYoctoNear.Internal", (yoctoNear) => {
    const validYoctoNear = YoctoNearInputZodSchema.safeParse(yoctoNear);
    if (!validYoctoNear.success) return result.err(createNatError({
      kind: "CreateNearTokenFromYoctoNear.Args.InvalidSchema",
      context: { zodError: validYoctoNear.error }
    }));
    const nearToken = Object.create(nearTokenProto);
    Object.defineProperty(nearToken, "yoctoNear", {
      value: validYoctoNear.data,
      enumerable: true
    });
    return result.ok(Object.freeze(nearToken));
  });
  const throwableYoctoNear = asThrowable(safeYoctoNear);
  const safeNear = wrapInternalError("CreateNearTokenFromNear.Internal", (near) => {
    const validNear = NearInputZodSchema.safeParse(near);
    if (!validNear.success) return result.err(createNatError({
      kind: "CreateNearTokenFromNear.Args.InvalidSchema",
      context: { zodError: validNear.error }
    }));
    const nearToken = Object.create(nearTokenProto);
    Object.defineProperty(nearToken, "near", {
      value: validNear.data,
      enumerable: true
    });
    return result.ok(Object.freeze(nearToken));
  });
  const throwableNear = asThrowable(safeNear);
  const safeNearToken = wrapInternalError("CreateNearToken.Internal", (args) => {
    const validArgs = NearTokenArgsZodSchema.safeParse(args);
    if (!validArgs.success) return result.err(createNatError({
      kind: "CreateNearToken.Args.InvalidSchema",
      context: { zodError: validArgs.error }
    }));
    return "yoctoNear" in args ? result.ok(throwableYoctoNear(args.yoctoNear)) : result.ok(throwableNear(args.near));
  });
  const throwableNearToken = asThrowable(safeNearToken);
  const transformAccessKey = (key) => {
    const publicKey = key.publicKey;
    const nonce = key.accessKey.nonce;
    if (key.accessKey.permission === "FullAccess") return {
      accessType: "FullAccess",
      publicKey,
      nonce
    };
    if ("FunctionCall" in key.accessKey.permission) {
      const { receiverId, methodNames, allowance } = key.accessKey.permission.FunctionCall;
      return {
        accessType: "FunctionCall",
        publicKey,
        nonce,
        contractAccountId: receiverId,
        gasBudget: typeof allowance === "string" ? throwableYoctoNear(allowance) : "Unlimited",
        allowedFunctions: methodNames.length > 0 ? methodNames : "AllNonPayable"
      };
    }
    throw new Error("Unsupported access key permission", { cause: key });
  };
  const UnknownKeySchema = /* @__PURE__ */ object({
    blockHash: /* @__PURE__ */ string(),
    blockHeight: /* @__PURE__ */ number(),
    error: /* @__PURE__ */ string(),
    logs: /* @__PURE__ */ array(/* @__PURE__ */ string())
  });
  const RpcQueryViewAccessKeyOkResultSchema = /* @__PURE__ */ object({
    blockHash: /* @__PURE__ */ string(),
    blockHeight: /* @__PURE__ */ number(),
    ...AccessKeyViewSchema().shape
  });
  const RpcQueryViewAccessKeyResultSchema = /* @__PURE__ */ union([RpcQueryViewAccessKeyOkResultSchema, UnknownKeySchema]);
  const handleResult$5 = (rpcResponse, args) => {
    const rpcResult = RpcQueryViewAccessKeyResultSchema.safeParse(rpcResponse.result);
    if (!rpcResult.success) return result.err(createNatError({
      kind: "Client.GetAccountAccessKey.Exhausted",
      context: { lastError: createNatError({
        kind: "SendRequest.Attempt.Response.InvalidSchema",
        context: { zodError: rpcResult.error }
      }) }
    }));
    const { blockHash, blockHeight } = rpcResult.data;
    if ("error" in rpcResult.data) return result.err(createNatError({
      kind: "Client.GetAccountAccessKey.Rpc.AccountAccessKey.NotFound",
      context: {
        accountId: args.accountId,
        publicKey: args.publicKey,
        blockHash,
        blockHeight
      }
    }));
    const output = {
      blockHash,
      blockHeight,
      accountId: args.accountId,
      accountAccessKey: transformAccessKey({
        accessKey: rpcResult.data,
        publicKey: args.publicKey
      }),
      rawRpcResult: rpcResult.data
    };
    return result.ok(output);
  };
  const GetAccountAccessKeyArgsSchema$1 = /* @__PURE__ */ object({
    accountId: AccountIdZodSchema,
    publicKey: PublicKeyZodSchema,
    atMomentOf: /* @__PURE__ */ optional(BlockReferenceZodSchema),
    policies: PoliciesZodSchema,
    options: BaseOptionsZodSchema
  });
  const createSafeGetAccountAccessKey = (context) => wrapInternalError("Client.GetAccountAccessKey.Internal", async (args) => {
    const validArgs = GetAccountAccessKeyArgsSchema$1.safeParse(args);
    if (!validArgs.success) return result.err(createNatError({
      kind: "Client.GetAccountAccessKey.Args.InvalidSchema",
      context: { zodError: validArgs.error }
    }));
    const rpcResponse = await context.sendRequest({
      method: "query",
      params: {
        request_type: "view_access_key",
        account_id: args.accountId,
        public_key: args.publicKey,
        ...toNativeBlockReference(args.atMomentOf)
      },
      transportPolicy: args.policies?.transport,
      signal: args.options?.signal
    });
    if (!rpcResponse.ok) return repackError({
      error: rpcResponse.error,
      originPrefix: "SendRequest",
      targetPrefix: "Client.GetAccountAccessKey"
    });
    return rpcResponse.value.error ? handleError$5(rpcResponse.value) : handleResult$5(rpcResponse.value, args);
  });
  const handleError$4 = (rpcResponse) => {
    const rpcError = ErrorWrapperFor_RpcQueryErrorSchema().safeParse(rpcResponse.error);
    if (!rpcError.success) return result.err(createNatError({
      kind: "Client.GetAccountAccessKeys.Exhausted",
      context: { lastError: createNatError({
        kind: "SendRequest.Attempt.Response.InvalidSchema",
        context: { zodError: rpcError.error }
      }) }
    }));
    const { name, cause } = rpcError.data;
    if (name === "HANDLER_ERROR") {
      if (cause.name === "NO_SYNCED_BLOCKS") return result.err(createNatError({
        kind: `Client.GetAccountAccessKeys.Rpc.NotSynced`,
        context: null
      }));
      if (cause.name === "UNAVAILABLE_SHARD") return result.err(createNatError({
        kind: `Client.GetAccountAccessKeys.Rpc.Shard.NotTracked`,
        context: { shardId: cause.info.requestedShardId }
      }));
      if (cause.name === "GARBAGE_COLLECTED_BLOCK") return result.err(createNatError({
        kind: `Client.GetAccountAccessKeys.Rpc.Block.GarbageCollected`,
        context: {
          blockHash: cause.info.blockHash,
          blockHeight: cause.info.blockHeight
        }
      }));
      if (cause.name === "UNKNOWN_BLOCK" && "blockId" in cause.info.blockReference) return result.err(createNatError({
        kind: `Client.GetAccountAccessKeys.Rpc.Block.NotFound`,
        context: { blockId: cause.info.blockReference.blockId }
      }));
    }
    return result.err(createNatError({
      kind: "Client.GetAccountAccessKeys.Internal",
      context: { cause: rpcResponse }
    }));
  };
  const RpcQueryAccessKeyListResultSchema = /* @__PURE__ */ object({
    ...AccessKeyListSchema().shape,
    blockHash: /* @__PURE__ */ string(),
    blockHeight: /* @__PURE__ */ number()
  });
  const handleResult$4 = (rpcResponse, args) => {
    const rpcResult = RpcQueryAccessKeyListResultSchema.safeParse(rpcResponse.result);
    if (!rpcResult.success) return result.err(createNatError({
      kind: "Client.GetAccountAccessKeys.Exhausted",
      context: { lastError: createNatError({
        kind: "SendRequest.Attempt.Response.InvalidSchema",
        context: { zodError: rpcResult.error }
      }) }
    }));
    const { blockHash, blockHeight } = rpcResult.data;
    const output = {
      blockHash,
      blockHeight,
      accountId: args.accountId,
      accountAccessKeys: rpcResult.data.keys.map(transformAccessKey),
      rawRpcResult: rpcResult.data
    };
    return result.ok(output);
  };
  const GetAccountAccessKeysArgsSchema = /* @__PURE__ */ object({
    accountId: AccountIdZodSchema,
    atMomentOf: /* @__PURE__ */ optional(BlockReferenceZodSchema),
    policies: PoliciesZodSchema,
    options: BaseOptionsZodSchema
  });
  const createSafeGetAccountAccessKeys = (context) => wrapInternalError("Client.GetAccountAccessKeys.Internal", async (args) => {
    const validArgs = GetAccountAccessKeysArgsSchema.safeParse(args);
    if (!validArgs.success) return result.err(createNatError({
      kind: "Client.GetAccountAccessKeys.Args.InvalidSchema",
      context: { zodError: validArgs.error }
    }));
    const rpcResponse = await context.sendRequest({
      method: "query",
      params: {
        request_type: "view_access_key_list",
        account_id: args.accountId,
        ...toNativeBlockReference(args.atMomentOf)
      },
      transportPolicy: args.policies?.transport,
      signal: args.options?.signal
    });
    if (!rpcResponse.ok) return repackError({
      error: rpcResponse.error,
      originPrefix: "SendRequest",
      targetPrefix: "Client.GetAccountAccessKeys"
    });
    return rpcResponse.value.error ? handleError$4(rpcResponse.value) : handleResult$4(rpcResponse.value, args);
  });
  const handleError$3 = (rpcResponse) => {
    const rpcError = ErrorWrapperFor_RpcQueryErrorSchema().safeParse(rpcResponse.error);
    if (!rpcError.success) return result.err(createNatError({
      kind: "Client.GetAccountInfo.Exhausted",
      context: { lastError: createNatError({
        kind: "SendRequest.Attempt.Response.InvalidSchema",
        context: { zodError: rpcError.error }
      }) }
    }));
    const { name, cause } = rpcError.data;
    if (name === "HANDLER_ERROR") {
      if (cause.name === "NO_SYNCED_BLOCKS") return result.err(createNatError({
        kind: `Client.GetAccountInfo.Rpc.NotSynced`,
        context: null
      }));
      if (cause.name === "GARBAGE_COLLECTED_BLOCK") return result.err(createNatError({
        kind: `Client.GetAccountInfo.Rpc.Block.GarbageCollected`,
        context: {
          blockHash: cause.info.blockHash,
          blockHeight: cause.info.blockHeight
        }
      }));
      if (cause.name === "UNKNOWN_BLOCK" && "blockId" in cause.info.blockReference) return result.err(createNatError({
        kind: `Client.GetAccountInfo.Rpc.Block.NotFound`,
        context: { blockId: cause.info.blockReference.blockId }
      }));
    }
    if (cause.name === "UNKNOWN_ACCOUNT") return result.err(createNatError({
      kind: `Client.GetAccountInfo.Rpc.Account.NotFound`,
      context: {
        accountId: cause.info.requestedAccountId,
        blockHash: cause.info.blockHash,
        blockHeight: cause.info.blockHeight
      }
    }));
    return result.err(createNatError({
      kind: "Client.GetAccountInfo.Internal",
      context: { cause: rpcResponse }
    }));
  };
  const ZeroBalanceAccountStorageLimit = 770;
  const calculateAccountBalance = (accountInfo, storagePricePerByte) => {
    const validatorStake = throwableYoctoNear(accountInfo.locked);
    const total = throwableYoctoNear(accountInfo.amount).add(validatorStake);
    if (accountInfo.storageUsage <= ZeroBalanceAccountStorageLimit) return {
      total,
      available: total.sub(validatorStake),
      locked: {
        total: validatorStake,
        validatorStake,
        storageDeposit: throwableYoctoNear(0n)
      }
    };
    const storageDeposit = throwableYoctoNear(storagePricePerByte.yoctoNear * BigInt(accountInfo.storageUsage));
    const lockedAmount = validatorStake.gt(storageDeposit) ? validatorStake : storageDeposit;
    return {
      total,
      available: total.sub(lockedAmount),
      locked: {
        total: lockedAmount,
        validatorStake,
        storageDeposit
      }
    };
  };
  const RpcQueryViewAccountResultSchema = /* @__PURE__ */ object({
    ...AccountViewSchema().shape,
    blockHash: /* @__PURE__ */ string(),
    blockHeight: /* @__PURE__ */ number()
  });
  const handleResult$3 = (rpcResponse, storagePricePerByte, args) => {
    const rpcResult = RpcQueryViewAccountResultSchema.safeParse(rpcResponse.result);
    if (!rpcResult.success) return resultNatError("Client.GetAccountInfo.Exhausted", { lastError: createNatError({
      kind: "SendRequest.Attempt.Response.InvalidSchema",
      context: { zodError: rpcResult.error }
    }) });
    const accountInfo = rpcResult.data;
    const contractWasmHash = accountInfo.codeHash !== "11111111111111111111111111111111" ? null : accountInfo.codeHash;
    return result.ok({
      accountId: args.accountId,
      balance: calculateAccountBalance(accountInfo, storagePricePerByte),
      usedStorageBytes: accountInfo.storageUsage,
      contractWasmHash,
      globalContractWasmHash: accountInfo.globalContractHash ?? null,
      globalContractAccountId: accountInfo.globalContractAccountId ?? null,
      atMomentOf: {
        blockHash: accountInfo.blockHash,
        blockHeight: accountInfo.blockHeight
      }
    });
  };
  const GetAccountInfoArgsSchema = /* @__PURE__ */ object({
    accountId: AccountIdZodSchema,
    atMomentOf: /* @__PURE__ */ optional(BlockReferenceZodSchema),
    policies: PoliciesZodSchema,
    options: BaseOptionsZodSchema
  });
  const createSafeGetAccountInfo = (context) => wrapInternalError("Client.GetAccountInfo.Internal", async (args) => {
    const validArgs = GetAccountInfoArgsSchema.safeParse(args);
    if (!validArgs.success) return result.err(createNatError({
      kind: "Client.GetAccountInfo.Args.InvalidSchema",
      context: { zodError: validArgs.error }
    }));
    const { accountId, policies, options } = validArgs.data;
    const [rpcResponse, storagePricePerByte] = await Promise.all([context.sendRequest({
      method: "query",
      params: {
        request_type: "view_account",
        account_id: accountId,
        ...toNativeBlockReference(args.atMomentOf)
      },
      transportPolicy: policies?.transport,
      signal: options?.signal
    }), context.cache.getStoragePricePerByte({ signal: options?.signal })]);
    if (!rpcResponse.ok) return repackError({
      error: rpcResponse.error,
      originPrefix: "SendRequest",
      targetPrefix: "Client.GetAccountInfo"
    });
    if (!storagePricePerByte.ok) return result.err(createNatError({
      kind: "Client.GetAccountInfo.StoragePricePerByte.NotLoaded",
      context: { cause: storagePricePerByte.error }
    }));
    return rpcResponse.value.error ? handleError$3(rpcResponse.value) : handleResult$3(rpcResponse.value, storagePricePerByte.value, args);
  });
  const handleError$2 = (rpcResponse) => {
    const rpcError = ErrorWrapperFor_RpcBlockErrorSchema().safeParse(rpcResponse.error);
    if (!rpcError.success) return result.err(createNatError({
      kind: "Client.GetBlock.Exhausted",
      context: { lastError: createNatError({
        kind: "SendRequest.Attempt.Response.InvalidSchema",
        context: { zodError: rpcError.error }
      }) }
    }));
    const { name, cause } = rpcError.data;
    if (name === "HANDLER_ERROR") {
      if (cause.name === "NOT_SYNCED_YET") return result.err(createNatError({
        kind: `Client.GetBlock.Rpc.NotSynced`,
        context: null
      }));
      if (cause.name === "UNKNOWN_BLOCK") return result.err(createNatError({
        kind: `Client.GetBlock.Rpc.Block.NotFound`,
        context: null
      }));
    }
    return result.err(createNatError({
      kind: "Client.GetBlock.Internal",
      context: { cause: rpcResponse }
    }));
  };
  const handleResult$2 = (rpcResponse) => {
    const rpcResult = RpcBlockResponseSchema().safeParse(rpcResponse.result);
    if (!rpcResult.success) return result.err(createNatError({
      kind: "Client.GetBlock.Exhausted",
      context: { lastError: createNatError({
        kind: "SendRequest.Attempt.Response.InvalidSchema",
        context: { zodError: rpcResult.error }
      }) }
    }));
    const output = { rawRpcResult: rpcResult.data };
    return result.ok(output);
  };
  const GetBlockArgsSchema = /* @__PURE__ */ optional(/* @__PURE__ */ object({
    blockReference: /* @__PURE__ */ optional(BlockReferenceZodSchema),
    policies: PoliciesZodSchema,
    options: BaseOptionsZodSchema
  }));
  const createSafeGetBlock = (context) => wrapInternalError("Client.GetBlock.Internal", async (args) => {
    const validArgs = GetBlockArgsSchema.safeParse(args);
    if (!validArgs.success) return result.err(createNatError({
      kind: "Client.GetBlock.Args.InvalidSchema",
      context: { zodError: validArgs.error }
    }));
    const rpcResponse = await context.sendRequest({
      method: "block",
      params: toNativeBlockReference(args?.blockReference),
      transportPolicy: args?.policies?.transport,
      signal: args?.options?.signal
    });
    if (!rpcResponse.ok) return repackError({
      error: rpcResponse.error,
      originPrefix: "SendRequest",
      targetPrefix: "Client.GetBlock"
    });
    return rpcResponse.value.error ? handleError$2(rpcResponse.value) : handleResult$2(rpcResponse.value);
  });
  const handleError$1 = (rpcResponse) => {
    const rpcError = ErrorWrapperFor_RpcQueryErrorSchema().safeParse(rpcResponse.error);
    if (!rpcError.success) return result.err(createNatError({
      kind: "Client.CallContractReadFunction.Exhausted",
      context: { lastError: createNatError({
        kind: "SendRequest.Attempt.Response.InvalidSchema",
        context: { zodError: rpcError.error }
      }) }
    }));
    const { name, cause } = rpcError.data;
    if (name === "HANDLER_ERROR") {
      if (cause.name === "NO_SYNCED_BLOCKS") return result.err(createNatError({
        kind: `Client.CallContractReadFunction.Rpc.NotSynced`,
        context: null
      }));
      if (cause.name === "UNAVAILABLE_SHARD") return result.err(createNatError({
        kind: `Client.CallContractReadFunction.Rpc.Shard.NotTracked`,
        context: { shardId: cause.info.requestedShardId }
      }));
      if (cause.name === "GARBAGE_COLLECTED_BLOCK") return result.err(createNatError({
        kind: `Client.CallContractReadFunction.Rpc.Block.GarbageCollected`,
        context: {
          blockHash: cause.info.blockHash,
          blockHeight: cause.info.blockHeight
        }
      }));
      if (cause.name === "UNKNOWN_BLOCK" && "blockId" in cause.info.blockReference) return result.err(createNatError({
        kind: `Client.CallContractReadFunction.Rpc.Block.NotFound`,
        context: { blockId: cause.info.blockReference.blockId }
      }));
    }
    return result.err(createNatError({
      kind: "Client.CallContractReadFunction.Internal",
      context: { cause: rpcResponse }
    }));
  };
  const deserializeCallResult = (args, rawResult) => {
    if (args.options?.deserializeResult) try {
      result.ok(args.options.deserializeResult({ rawResult }));
    } catch (e) {
      return result.err(createNatError({
        kind: "Client.CallContractReadFunction.DeserializeResult.Failed",
        context: {
          cause: e,
          rawResult
        }
      }));
    }
    try {
      return result.ok(fromJsonBytes(rawResult));
    } catch (e) {
      return result.err(createNatError({
        kind: "Client.CallContractReadFunction.ResultDeserialization.JsonParseFailed",
        context: {
          cause: e,
          rawResult
        }
      }));
    }
  };
  const ContractExecutionErrorSchema = /* @__PURE__ */ object({
    blockHash: /* @__PURE__ */ string(),
    blockHeight: /* @__PURE__ */ number(),
    error: /* @__PURE__ */ string(),
    logs: /* @__PURE__ */ array(/* @__PURE__ */ string())
  });
  const RpcQueryCallReadFunctionOkResultSchema = /* @__PURE__ */ object({
    blockHash: /* @__PURE__ */ string(),
    blockHeight: /* @__PURE__ */ number(),
    result: /* @__PURE__ */ array(/* @__PURE__ */ number()),
    logs: /* @__PURE__ */ array(/* @__PURE__ */ string())
  });
  const RpcQueryCallReadFunctionResultSchema = /* @__PURE__ */ union([RpcQueryCallReadFunctionOkResultSchema, ContractExecutionErrorSchema]);
  const handleResult$1 = (rpcResponse, args) => {
    const rpcResult = RpcQueryCallReadFunctionResultSchema.safeParse(rpcResponse.result);
    if (!rpcResult.success) return result.err(createNatError({
      kind: "Client.CallContractReadFunction.Exhausted",
      context: { lastError: createNatError({
        kind: "SendRequest.Attempt.Response.InvalidSchema",
        context: { zodError: rpcResult.error }
      }) }
    }));
    const { blockHash, blockHeight, logs } = rpcResult.data;
    if ("error" in rpcResult.data) return result.err(createNatError({
      kind: "Client.CallContractReadFunction.Rpc.Execution.Failed",
      context: {
        contractAccountId: args.contractAccountId,
        message: rpcResult.data.error,
        blockHash,
        blockHeight
      }
    }));
    const deserializedResult = deserializeCallResult(args, rpcResult.data.result);
    if (!deserializedResult.ok) return deserializedResult;
    const output = {
      blockHash,
      blockHeight,
      logs,
      result: deserializedResult.value,
      rawResult: rpcResult.data.result
    };
    return result.ok(output);
  };
  const serializeFunctionArgs$1 = (args) => {
    if (args.options?.serializeArgs) try {
      const output = args.options.serializeArgs({ functionArgs: args.functionArgs });
      if (!(output instanceof Uint8Array)) return result.err(createNatError({
        kind: "Client.CallContractReadFunction.SerializeArgs.InvalidOutput",
        context: { output }
      }));
      return result.ok(output);
    } catch (e) {
      return result.err(createNatError({
        kind: "Client.CallContractReadFunction.SerializeArgs.Failed",
        context: {
          cause: e,
          functionArgs: args.functionArgs
        }
      }));
    }
    if (args.functionArgs) {
      const jsonArgs = JsonValueZodSchema.safeParse(args.functionArgs);
      if (!jsonArgs.success) return result.err(createNatError({
        kind: "Client.CallContractReadFunction.Args.InvalidSchema",
        context: { zodError: jsonArgs.error }
      }));
      return result.ok(toJsonBytes(args.functionArgs));
    }
    return result.ok(new Uint8Array());
  };
  const GetAccountAccessKeyArgsSchema = /* @__PURE__ */ object({
    contractAccountId: AccountIdZodSchema,
    functionName: ContractFunctionNameZodSchema,
    functionArgs: /* @__PURE__ */ optional(/* @__PURE__ */ unknown()),
    withStateAt: /* @__PURE__ */ optional(BlockReferenceZodSchema),
    policies: PoliciesZodSchema,
    options: /* @__PURE__ */ optional(/* @__PURE__ */ object({
      serializeArgs: /* @__PURE__ */ optional(/* @__PURE__ */ _instanceof(Function)),
      deserializeResult: /* @__PURE__ */ optional(/* @__PURE__ */ _instanceof(Function)),
      signal: /* @__PURE__ */ optional(/* @__PURE__ */ _instanceof(AbortSignal))
    }))
  });
  const createSafeCallContractReadFunction = (context) => wrapInternalError("Client.CallContractReadFunction.Internal", async (args) => {
    const validArgs = GetAccountAccessKeyArgsSchema.safeParse(args);
    if (!validArgs.success) return result.err(createNatError({
      kind: "Client.CallContractReadFunction.Args.InvalidSchema",
      context: { zodError: validArgs.error }
    }));
    const functionArgs = serializeFunctionArgs$1(args);
    if (!functionArgs.ok) return functionArgs;
    const rpcResponse = await context.sendRequest({
      method: "query",
      params: {
        request_type: "call_function",
        account_id: args.contractAccountId,
        method_name: args.functionName,
        args_base64: functionArgs.value.toBase64(),
        ...toNativeBlockReference(args.withStateAt)
      },
      transportPolicy: args.policies?.transport,
      signal: args.options?.signal
    });
    if (!rpcResponse.ok) return repackError({
      error: rpcResponse.error,
      originPrefix: "SendRequest",
      targetPrefix: "Client.CallContractReadFunction"
    });
    return rpcResponse.value.error ? handleError$1(rpcResponse.value) : handleResult$1(rpcResponse.value, args);
  });
  const handleRpcError = (rpcResponse) => {
    const rpcError = ErrorWrapperFor_RpcTransactionErrorSchema().safeParse(rpcResponse.error);
    if (!rpcError.success) return resultNatError("Client.GetTransactionResult.Exhausted", { lastError: createNatError({
      kind: "SendRequest.Attempt.Response.InvalidSchema",
      context: { zodError: rpcError.error }
    }) });
    const { name, cause } = rpcError.data;
    if (name === "HANDLER_ERROR") {
      if (cause.name === "UNKNOWN_TRANSACTION") return resultNatError("Client.GetTransactionResult.Rpc.Transaction.NotFound", { transactionHash: cause.info.requestedTransactionHash });
    }
    return resultNatError("Client.GetTransactionResult.Internal", { cause: rpcResponse });
  };
  const DataReceiverZodSchema = /* @__PURE__ */ object({
    dataId: /* @__PURE__ */ string(),
    receiverId: AccountIdZodSchema
  });
  const RpcActionReceiptZodSchema = /* @__PURE__ */ object({
    receiptId: /* @__PURE__ */ string(),
    predecessorId: AccountIdZodSchema,
    receiverId: AccountIdZodSchema,
    receipt: /* @__PURE__ */ object({ Action: /* @__PURE__ */ object({
      actions: /* @__PURE__ */ array(ActionViewSchema()),
      gasPrice: /* @__PURE__ */ string(),
      inputDataIds: /* @__PURE__ */ array(/* @__PURE__ */ string()),
      outputDataReceivers: /* @__PURE__ */ array(DataReceiverZodSchema),
      isPromiseYield: /* @__PURE__ */ boolean(),
      signerId: AccountIdZodSchema,
      signerPublicKey: PublicKeyZodSchema
    }) })
  });
  const RpcReceiptOutcomeZodSchema = /* @__PURE__ */ object({
    blockHash: CryptoHashZodSchema,
    id: CryptoHashZodSchema,
    outcome: /* @__PURE__ */ object({
      status: /* @__PURE__ */ union([
        /* @__PURE__ */ object({ SuccessValue: /* @__PURE__ */ base64$1() }),
        /* @__PURE__ */ object({ SuccessReceiptId: CryptoHashZodSchema }),
        /* @__PURE__ */ object({ Failure: /* @__PURE__ */ object({ ActionError: ActionErrorSchema() }) })
      ]),
      executorId: AccountIdZodSchema,
      receiptIds: /* @__PURE__ */ array(CryptoHashZodSchema),
      gasBurnt: /* @__PURE__ */ number(),
      tokensBurnt: /* @__PURE__ */ string(),
      metadata: /* @__PURE__ */ union([/* @__PURE__ */ object({
        version: /* @__PURE__ */ literal(1),
        gasProfile: /* @__PURE__ */ _null()
      }), /* @__PURE__ */ object({
        version: /* @__PURE__ */ union([/* @__PURE__ */ literal(2), /* @__PURE__ */ literal(3)]),
        gasProfile: /* @__PURE__ */ array(/* @__PURE__ */ object({
          cost: /* @__PURE__ */ string(),
          costCategory: /* @__PURE__ */ union([/* @__PURE__ */ literal("ACTION_COST"), /* @__PURE__ */ literal("WASM_HOST_COST")]),
          gasUsed: /* @__PURE__ */ string()
        }))
      })]),
      logs: /* @__PURE__ */ array(/* @__PURE__ */ string())
    }),
    proof: /* @__PURE__ */ array(MerklePathItemSchema())
  });
  const RpcTransactionOutcomeCommonZodSchema = /* @__PURE__ */ object({
    blockHash: CryptoHashZodSchema,
    id: CryptoHashZodSchema,
    outcome: /* @__PURE__ */ object({
      executorId: AccountIdZodSchema,
      gasBurnt: /* @__PURE__ */ number(),
      tokensBurnt: /* @__PURE__ */ string(),
      logs: /* @__PURE__ */ tuple([]),
      metadata: /* @__PURE__ */ object({
        version: /* @__PURE__ */ literal(1),
        gasProfile: /* @__PURE__ */ _null()
      })
    }),
    proof: /* @__PURE__ */ array(MerklePathItemSchema())
  });
  const RpcTransactionOutcomeSuccessZodSchema = /* @__PURE__ */ object({
    ...RpcTransactionOutcomeCommonZodSchema.shape,
    outcome: /* @__PURE__ */ object({
      ...RpcTransactionOutcomeCommonZodSchema.shape.outcome.shape,
      receiptIds: /* @__PURE__ */ tuple([CryptoHashZodSchema]),
      status: /* @__PURE__ */ object({ SuccessReceiptId: CryptoHashZodSchema })
    })
  });
  const RpcTransactionOutcomeFailureZodSchema = /* @__PURE__ */ object({
    ...RpcTransactionOutcomeCommonZodSchema.shape,
    outcome: /* @__PURE__ */ object({
      ...RpcTransactionOutcomeCommonZodSchema.shape.outcome.shape,
      receiptIds: /* @__PURE__ */ tuple([]),
      status: /* @__PURE__ */ object({ Failure: /* @__PURE__ */ object({ InvalidTxError: InvalidTxErrorSchema() }) })
    })
  });
  const isRpcTransactionOutcomeSuccess = (o) => "SuccessReceiptId" in o.outcome.status;
  const isRpcTransactionOutcomeFailure = (o) => "Failure" in o.outcome.status;
  const RpcTransactionSummaryZodSchema = /* @__PURE__ */ object({
    actions: /* @__PURE__ */ array(ActionViewSchema()),
    hash: CryptoHashZodSchema,
    nonce: TransactionNonceZodSchema,
    publicKey: PublicKeyZodSchema,
    receiverId: AccountIdZodSchema,
    signature: SignatureZodSchema,
    signerId: AccountIdZodSchema
  });
  const RpcIncludedTransactionDetailsZodSchema = /* @__PURE__ */ union([/* @__PURE__ */ object({
    finalExecutionStatus: /* @__PURE__ */ literal("INCLUDED"),
    status: /* @__PURE__ */ optional(/* @__PURE__ */ never()),
    transaction: /* @__PURE__ */ optional(/* @__PURE__ */ never()),
    transactionOutcome: /* @__PURE__ */ optional(/* @__PURE__ */ never()),
    receipts: /* @__PURE__ */ optional(/* @__PURE__ */ never()),
    receiptsOutcome: /* @__PURE__ */ optional(/* @__PURE__ */ never())
  }), /* @__PURE__ */ object({
    finalExecutionStatus: /* @__PURE__ */ literal("INCLUDED"),
    status: /* @__PURE__ */ literal("Started"),
    transaction: RpcTransactionSummaryZodSchema,
    transactionOutcome: RpcTransactionOutcomeSuccessZodSchema,
    receipts: /* @__PURE__ */ array(RpcActionReceiptZodSchema),
    receiptsOutcome: /* @__PURE__ */ array(RpcReceiptOutcomeZodSchema)
  })]);
  const RpcIncludedFinalTransactionDetailsZodSchema = /* @__PURE__ */ object({
    finalExecutionStatus: /* @__PURE__ */ literal("INCLUDED_FINAL"),
    status: /* @__PURE__ */ literal("Started"),
    transaction: RpcTransactionSummaryZodSchema,
    transactionOutcome: RpcTransactionOutcomeSuccessZodSchema,
    receipts: /* @__PURE__ */ array(RpcActionReceiptZodSchema),
    receiptsOutcome: /* @__PURE__ */ array(RpcReceiptOutcomeZodSchema)
  });
  const RpcExecutedOptimisticTransactionDetailsZodSchema = /* @__PURE__ */ union([/* @__PURE__ */ object({
    finalExecutionStatus: /* @__PURE__ */ literal("EXECUTED_OPTIMISTIC"),
    status: /* @__PURE__ */ union([/* @__PURE__ */ object({ SuccessValue: /* @__PURE__ */ base64$1() }), /* @__PURE__ */ object({ Failure: /* @__PURE__ */ object({ ActionError: ActionErrorSchema() }) })]),
    transaction: RpcTransactionSummaryZodSchema,
    transactionOutcome: RpcTransactionOutcomeSuccessZodSchema,
    receipts: /* @__PURE__ */ array(RpcActionReceiptZodSchema),
    receiptsOutcome: /* @__PURE__ */ array(RpcReceiptOutcomeZodSchema)
  }), /* @__PURE__ */ object({
    finalExecutionStatus: /* @__PURE__ */ literal("EXECUTED_OPTIMISTIC"),
    status: /* @__PURE__ */ object({ Failure: /* @__PURE__ */ object({ InvalidTxError: InvalidTxErrorSchema() }) }),
    transaction: RpcTransactionSummaryZodSchema,
    transactionOutcome: RpcTransactionOutcomeFailureZodSchema,
    receipts: /* @__PURE__ */ tuple([]),
    receiptsOutcome: /* @__PURE__ */ tuple([])
  })]);
  const RpcExecutedTransactionDetailsZodSchema = /* @__PURE__ */ object({
    finalExecutionStatus: /* @__PURE__ */ literal("EXECUTED"),
    status: /* @__PURE__ */ union([/* @__PURE__ */ object({ SuccessValue: /* @__PURE__ */ base64$1() }), /* @__PURE__ */ object({ Failure: /* @__PURE__ */ object({ ActionError: ActionErrorSchema() }) })]),
    transaction: RpcTransactionSummaryZodSchema,
    transactionOutcome: RpcTransactionOutcomeSuccessZodSchema,
    receipts: /* @__PURE__ */ array(RpcActionReceiptZodSchema),
    receiptsOutcome: /* @__PURE__ */ array(RpcReceiptOutcomeZodSchema)
  });
  const RpcFinalTransactionDetailsZodSchema = /* @__PURE__ */ union([/* @__PURE__ */ object({
    finalExecutionStatus: /* @__PURE__ */ literal("FINAL"),
    status: /* @__PURE__ */ union([/* @__PURE__ */ object({ SuccessValue: /* @__PURE__ */ base64$1() }), /* @__PURE__ */ object({ Failure: /* @__PURE__ */ object({ ActionError: ActionErrorSchema() }) })]),
    transaction: RpcTransactionSummaryZodSchema,
    transactionOutcome: RpcTransactionOutcomeSuccessZodSchema,
    receipts: /* @__PURE__ */ array(RpcActionReceiptZodSchema),
    receiptsOutcome: /* @__PURE__ */ array(RpcReceiptOutcomeZodSchema)
  }), /* @__PURE__ */ object({
    finalExecutionStatus: /* @__PURE__ */ literal("FINAL"),
    status: /* @__PURE__ */ object({ Failure: /* @__PURE__ */ object({ InvalidTxError: InvalidTxErrorSchema() }) }),
    transaction: RpcTransactionSummaryZodSchema,
    transactionOutcome: RpcTransactionOutcomeFailureZodSchema,
    receipts: /* @__PURE__ */ tuple([]),
    receiptsOutcome: /* @__PURE__ */ tuple([])
  })]);
  const getConversionError = (invalidTxError) => invalidTxError;
  const getRawActionSummary = (rpcAction) => {
    if (rpcAction === "CreateAccount") return { actionType: "CreateAccount" };
    if ("Transfer" in rpcAction) {
      const { Transfer } = rpcAction;
      return {
        actionType: "Transfer",
        amount: throwableYoctoNear(Transfer.deposit)
      };
    }
    if ("AddKey" in rpcAction) {
      const { AddKey } = rpcAction;
      if (AddKey.accessKey.permission === "FullAccess") return {
        actionType: "AddKey",
        accessType: "FullAccess",
        publicKey: AddKey.publicKey
      };
      if ("FunctionCall" in AddKey.accessKey.permission) {
        const { allowance, methodNames, receiverId } = AddKey.accessKey.permission.FunctionCall;
        const gasBudget = typeof allowance === "string" ? throwableYoctoNear(allowance) : "Unlimited";
        const allowedFunctions = methodNames.length > 0 ? methodNames : "AllNonPayable";
        return {
          actionType: "AddKey",
          accessType: "FunctionCall",
          publicKey: AddKey.publicKey,
          contractAccountId: receiverId,
          gasBudget,
          allowedFunctions
        };
      }
      throw new Error("Unsupported access key permission", { cause: AddKey });
    }
    if ("DeployContract" in rpcAction) {
      const { DeployContract } = rpcAction;
      return {
        actionType: "DeployContract",
        contractWasmHash: DeployContract.code
      };
    }
    if ("FunctionCall" in rpcAction) {
      const { FunctionCall } = rpcAction;
      return {
        actionType: "FunctionCall",
        functionName: FunctionCall.methodName,
        functionArgs: FunctionCall.args,
        gasLimit: throwableGas(FunctionCall.gas),
        attachedDeposit: throwableYoctoNear(FunctionCall.deposit)
      };
    }
    if ("Stake" in rpcAction) {
      const { Stake } = rpcAction;
      return {
        actionType: "Stake",
        amount: throwableYoctoNear(Stake.stake),
        validatorPublicKey: Stake.publicKey
      };
    }
    if ("DeleteKey" in rpcAction) {
      const { DeleteKey } = rpcAction;
      return {
        actionType: "DeleteKey",
        publicKey: DeleteKey.publicKey
      };
    }
    if ("DeleteAccount" in rpcAction) {
      const { DeleteAccount } = rpcAction;
      return {
        actionType: "DeleteAccount",
        beneficiaryAccountId: DeleteAccount.beneficiaryId
      };
    }
    throw new Error("unreachable");
  };
  const getFunctionArgs = (argsBase64) => {
    try {
      return fromJsonBytes(Uint8Array.fromBase64(argsBase64));
    } catch {
      return argsBase64;
    }
  };
  const baseGetActionSummary = (rawActionSummary) => {
    if (rawActionSummary.actionType === "FunctionCall") return {
      ...rawActionSummary,
      functionArgs: getFunctionArgs(rawActionSummary.functionArgs)
    };
    return rawActionSummary;
  };
  const getActionSummaries = (rpcActions, inputArgs) => {
    const rawActionSummaries = rpcActions.map(getRawActionSummary);
    if (inputArgs.options?.deserializeActionSummaries) try {
      return result.ok(inputArgs.options.deserializeActionSummaries({ rawActionSummaries }));
    } catch (cause) {
      return resultNatError("Client.GetTransactionResult.DeserializeActionSummaries.Failed", {
        cause,
        rawActionSummaries
      });
    }
    return result.ok(rawActionSummaries.map(baseGetActionSummary));
  };
  const getTransactionSummary = (transaction, inputArgs) => {
    const actionSummaries = getActionSummaries(transaction.actions, inputArgs);
    if (!actionSummaries.ok) return actionSummaries;
    return result.ok({
      signerAccountId: transaction.signerId,
      signerPublicKey: transaction.publicKey.publicKey,
      nonce: transaction.nonce,
      receiverAccountId: transaction.receiverId,
      actionSummaries: actionSummaries.value,
      signature: transaction.signature.signature
    });
  };
  const getConversionStepSuccess = (transaction, transactionOutcome, inputArgs) => {
    const transactionSummary = getTransactionSummary(transaction, inputArgs);
    if (!transactionSummary.ok) return transactionSummary;
    return result.ok({
      result: {
        status: "Success",
        firstExecutionStepId: transactionOutcome.outcome.status.SuccessReceiptId.cryptoHash
      },
      executedAt: { blockHash: transactionOutcome.blockHash.cryptoHash },
      transactionSummary: transactionSummary.value,
      gasFee: throwableYoctoNear(transactionOutcome.outcome.tokensBurnt),
      gasUsed: throwableGas(transactionOutcome.outcome.gasBurnt)
    });
  };
  const getConversionStepFailure = (transaction, transactionOutcome, invalidTxError, inputArgs) => {
    const transactionSummary = getTransactionSummary(transaction, inputArgs);
    if (!transactionSummary.ok) return transactionSummary;
    return result.ok({
      result: {
        status: "Error",
        error: getConversionError(invalidTxError)
      },
      executedAt: { blockHash: transactionOutcome.blockHash.cryptoHash },
      transactionSummary: transactionSummary.value,
      gasFee: throwableYoctoNear(transactionOutcome.outcome.tokensBurnt),
      gasUsed: throwableGas(transactionOutcome.outcome.gasBurnt)
    });
  };
  const getTransactionConversionFailure = (transaction, transactionOutcomeFailure, invalidTxError, inputArgs) => {
    const conversionStepError = getConversionStepFailure(transaction, transactionOutcomeFailure, invalidTxError, inputArgs);
    if (!conversionStepError.ok) return conversionStepError;
    return result.ok({
      transactionHash: transaction.hash.cryptoHash,
      result: {
        status: "ConversionError",
        error: getConversionError(invalidTxError)
      },
      processingSteps: {
        conversionStep: conversionStepError.value,
        executionSteps: null,
        refundSteps: null
      }
    });
  };
  const transformHostError = (hostError) => {
    if (typeof hostError === "string") {
      if (hostError === "BadUTF8") return "String encoding is bad UTF-8 sequence.";
      if (hostError === "BadUTF16") return "String encoding is bad UTF-16 sequence.";
      if (hostError === "GasExceeded") return "Exceeded the prepaid gas.";
      if (hostError === "GasLimitExceeded") return "Exceeded the maximum amount of gas allowed to burn per contract.";
      if (hostError === "BalanceExceeded") return "Exceeded the account balance.";
      if (hostError === "EmptyMethodName") return "Tried to call an empty method name.";
      if (hostError === "IntegerOverflow") return "Integer overflow.";
      if (hostError === "CannotAppendActionToJointPromise") return "Actions can only be appended to non-joint promise.";
      if (hostError === "CannotReturnJointPromise") return "Returning joint promise is currently prohibited.";
      if (hostError === "MemoryAccessViolation") return "Accessed memory outside the bounds.";
      if (hostError === "InvalidAccountId") return "VM Logic returned an invalid account id";
      if (hostError === "InvalidMethodName") return "VM Logic returned an invalid method name";
      if (hostError === "InvalidPublicKey") return "VM Logic provided an invalid public key";
    }
    if ("GuestPanic" in hostError) return `Smart contract panicked: ${hostError.GuestPanic.panicMsg}`;
    if ("InvalidPromiseIndex" in hostError) return `${hostError.InvalidPromiseIndex.promiseIdx} does not correspond to existing promises`;
    if ("InvalidPromiseResultIndex" in hostError) return `Accessed invalid promise result index: ${hostError.InvalidPromiseResultIndex.resultIdx}`;
    if ("InvalidRegisterId" in hostError) return `Accessed invalid register id: ${hostError.InvalidRegisterId.registerId}`;
    if ("IteratorWasInvalidated" in hostError) return `Iterator ${hostError.IteratorWasInvalidated.iteratorIndex} was invalidated after its creation by performing a mutable operation on trie`;
    if ("InvalidReceiptIndex" in hostError) return `VM Logic returned an invalid receipt index: ${hostError.InvalidReceiptIndex.receiptIndex}`;
    if ("InvalidIteratorIndex" in hostError) return `Iterator index ${hostError.InvalidIteratorIndex.iteratorIndex} does not exist`;
    if ("ProhibitedInView" in hostError) return `${hostError.ProhibitedInView.methodName} is not allowed in view calls`;
    if ("NumberOfLogsExceeded" in hostError) return `The number of logs will exceed the limit ${hostError.NumberOfLogsExceeded.limit}`;
    if ("KeyLengthExceeded" in hostError) return `The length of a storage key ${hostError.KeyLengthExceeded.length} exceeds the limit ${hostError.KeyLengthExceeded.limit}`;
    if ("ValueLengthExceeded" in hostError) return `The length of a storage value ${hostError.ValueLengthExceeded.length} exceeds the limit ${hostError.ValueLengthExceeded.limit}`;
    if ("TotalLogLengthExceeded" in hostError) return `The length of a log message ${hostError.TotalLogLengthExceeded.length} exceeds the limit ${hostError.TotalLogLengthExceeded.limit}`;
    if ("NumberPromisesExceeded" in hostError) return `The number of promises within a FunctionCall ${hostError.NumberPromisesExceeded.numberOfPromises} exceeds the limit ${hostError.NumberPromisesExceeded.limit}`;
    if ("NumberInputDataDependenciesExceeded" in hostError) return `The number of input data dependencies ${hostError.NumberInputDataDependenciesExceeded.numberOfInputDataDependencies} exceeds the limit ${hostError.NumberInputDataDependenciesExceeded.limit}`;
    if ("ReturnedValueLengthExceeded" in hostError) return `The length of a returned value ${hostError.ReturnedValueLengthExceeded.length} exceeds the limit ${hostError.ReturnedValueLengthExceeded.limit}`;
    if ("ContractSizeExceeded" in hostError) return `The size of a contract code in DeployContract action ${hostError.ContractSizeExceeded.size}exceeds the limit ${hostError.ContractSizeExceeded.limit}`;
    if ("Deprecated" in hostError) return `Attempted to call deprecated host function ${hostError.Deprecated.methodName}`;
    if ("AltBn128InvalidInput" in hostError) return `AltBn128 invalid input: ${hostError.AltBn128InvalidInput.msg}`;
    if ("ECRecoverError" in hostError) return `ECDSA recover error: ${hostError.ECRecoverError.msg}`;
    if ("Ed25519VerifyInvalidInput" in hostError) return `ED25519 signature verification error: ${hostError.Ed25519VerifyInvalidInput.msg}`;
    return JSON.stringify(hostError);
  };
  const transformWasmTrap = (wasmTrap) => {
    if (wasmTrap === "Unreachable") return "An `unreachable` opcode was executed.";
    if (wasmTrap === "MemoryOutOfBounds") return "Memory out of bounds trap.";
    if (wasmTrap === "CallIndirectOOB") return "Call indirect out of bounds trap.";
    if (wasmTrap === "IllegalArithmetic") return "An arithmetic exception, e.g. divided by zero.";
    if (wasmTrap === "MisalignedAtomicAccess") return "Misaligned atomic access trap.";
    if (wasmTrap === "GenericTrap") return "Generic trap.";
    if (wasmTrap === "StackOverflow") return "Stack overflow.";
    if (wasmTrap === "IndirectCallToNull") return "Indirect call to null.";
    if (wasmTrap === "IncorrectCallIndirectSignature") return "Call indirect incorrect signature trap.";
    return JSON.stringify(wasmTrap);
  };
  const transformFunctionCallError = (rpcFunctionCallError) => {
    if (typeof rpcFunctionCallError === "string") {
      if (rpcFunctionCallError === "WasmUnknownError") return {
        kind: "Action.FunctionCall.Execution.Failed",
        context: { cause: rpcFunctionCallError }
      };
      if (rpcFunctionCallError === "_EVMError") throw new Error("Unreachable", { cause: rpcFunctionCallError });
    }
    if ("CompilationError" in rpcFunctionCallError) {
      const { CompilationError } = rpcFunctionCallError;
      if ("CodeDoesNotExist" in CompilationError) return {
        kind: "Action.FunctionCall.Wasm.NotFound",
        context: { contractAccountId: CompilationError.CodeDoesNotExist.accountId }
      };
      if ("PrepareError" in CompilationError) return {
        kind: "Action.FunctionCall.Compilation.Failed",
        context: { cause: CompilationError.PrepareError }
      };
      if ("WasmerCompileError" in CompilationError) return {
        kind: "Action.FunctionCall.Compilation.Failed",
        context: { cause: CompilationError.WasmerCompileError.msg }
      };
    }
    if ("MethodResolveError" in rpcFunctionCallError) {
      const { MethodResolveError } = rpcFunctionCallError;
      if (MethodResolveError === "MethodEmptyName" || MethodResolveError === "MethodNotFound") return {
        kind: "Action.FunctionCall.Function.NotFound",
        context: null
      };
      if (MethodResolveError === "MethodInvalidSignature") return {
        kind: "Action.FunctionCall.Compilation.Failed",
        context: { cause: "InvalidFunctionSignature" }
      };
    }
    if ("LinkError" in rpcFunctionCallError) return {
      kind: "Action.FunctionCall.Execution.Failed",
      context: { cause: `Link Error: ${rpcFunctionCallError.LinkError.msg}` }
    };
    if ("WasmTrap" in rpcFunctionCallError) return {
      kind: "Action.FunctionCall.Execution.Failed",
      context: { cause: transformWasmTrap(rpcFunctionCallError.WasmTrap) }
    };
    if ("HostError" in rpcFunctionCallError) return {
      kind: "Action.FunctionCall.Execution.Failed",
      context: { cause: transformHostError(rpcFunctionCallError.HostError) }
    };
    if ("ExecutionError" in rpcFunctionCallError) return {
      kind: "Action.FunctionCall.Execution.Failed",
      context: { cause: rpcFunctionCallError.ExecutionError }
    };
    throw new Error("Unknown function call error", { cause: rpcFunctionCallError });
  };
  const getExecutionError = (actionError) => {
    if (typeof actionError.kind === "object") {
      const { kind } = actionError;
      if ("AccountDoesNotExist" in kind) return {
        kind: "Executor.NotFound",
        context: { executorAccountId: kind.AccountDoesNotExist.accountId }
      };
      if ("LackBalanceForState" in kind) return {
        kind: "Executor.NotEnoughBalance",
        context: {
          executorAccountId: kind.LackBalanceForState.accountId,
          missingAmount: throwableYoctoNear(kind.LackBalanceForState.amount)
        }
      };
      if ("ActorNoPermission" in kind) return {
        kind: "Action.Forbidden",
        context: {
          stepCreatorAccountId: kind.ActorNoPermission.actorId,
          executorAccountId: kind.ActorNoPermission.accountId
        }
      };
      if ("AccountAlreadyExists" in kind) return {
        kind: "Action.CreateAccount.AlreadyExists",
        context: { newAccountId: kind.AccountAlreadyExists.accountId }
      };
      if ("CreateAccountOnlyByRegistrar" in kind) return {
        kind: "Action.CreateAccount.TopLevelNamespace",
        context: {
          newAccountId: kind.CreateAccountOnlyByRegistrar.accountId,
          creatorAccountId: kind.CreateAccountOnlyByRegistrar.predecessorId,
          registrarAccountId: kind.CreateAccountOnlyByRegistrar.registrarAccountId
        }
      };
      if ("CreateAccountNotAllowed" in kind) return {
        kind: "Action.CreateAccount.ForeignNamespace",
        context: {
          newAccountId: kind.CreateAccountNotAllowed.accountId,
          creatorAccountId: kind.CreateAccountNotAllowed.predecessorId
        }
      };
      if ("OnlyImplicitAccountCreationAllowed" in kind) return {
        kind: "Action.CreateAccount.ImplicitAccount",
        context: { newAccountId: kind.OnlyImplicitAccountCreationAllowed.accountId }
      };
      if ("AddKeyAlreadyExists" in kind) return {
        kind: "Action.AddKey.AlreadyExists",
        context: {
          accountId: kind.AddKeyAlreadyExists.accountId,
          publicKey: kind.AddKeyAlreadyExists.publicKey
        }
      };
      if ("FunctionCallError" in kind) return transformFunctionCallError(kind.FunctionCallError);
      if ("NewReceiptValidationError" in kind) return {
        kind: "Action.FunctionCall.Execution.Failed",
        context: { cause: JSON.stringify(kind) }
      };
      if ("InsufficientStake" in kind) return {
        kind: "Action.Stake.BelowThreshold",
        context: {
          accountId: kind.InsufficientStake.accountId,
          proposedStake: throwableYoctoNear(kind.InsufficientStake.stake),
          minimumStake: throwableYoctoNear(kind.InsufficientStake.minimumStake)
        }
      };
      if ("TriesToStake" in kind) {
        const proposedStake = throwableYoctoNear(kind.TriesToStake.stake);
        const totalBalance = throwableYoctoNear(kind.TriesToStake.balance).add(throwableYoctoNear(kind.TriesToStake.locked));
        const missingAmount = proposedStake.sub(totalBalance);
        return {
          kind: "Action.Stake.NotEnoughBalance",
          context: {
            accountId: kind.TriesToStake.accountId,
            proposedStake,
            totalBalance,
            missingAmount
          }
        };
      }
      if ("TriesToUnstake" in kind) return {
        kind: "Action.Stake.NotFound",
        context: { accountId: kind.TriesToUnstake.accountId }
      };
      if ("DeleteKeyDoesNotExist" in kind) return {
        kind: "Action.DeleteKey.NotFound",
        context: {
          accountId: kind.DeleteKeyDoesNotExist.accountId,
          publicKey: kind.DeleteKeyDoesNotExist.publicKey
        }
      };
      if ("DeleteAccountStaking" in kind) return {
        kind: "Action.DeleteAccount.Staking",
        context: { accountId: kind.DeleteAccountStaking.accountId }
      };
      if ("DeleteAccountWithLargeState" in kind) return {
        kind: "Action.DeleteAccount.LargeState",
        context: { accountId: kind.DeleteAccountWithLargeState.accountId }
      };
    }
    throw new Error("Unknown execution error", { cause: actionError });
  };
  const createReceiptCreationMap = (conversionStep, receiptsWithOutcomes) => {
    const stepTypeMap = receiptsWithOutcomes.reduce((acc, item) => {
      acc[item.receipt.receiptId] = item.receipt.predecessorId === "system" ? "Refund" : "Execution";
      return acc;
    }, {});
    return receiptsWithOutcomes.reduce((acc, { receiptOutcome }) => {
      receiptOutcome.outcome.receiptIds.forEach((createdReceiptId) => {
        acc[createdReceiptId.cryptoHash] = {
          kind: stepTypeMap[createdReceiptId.cryptoHash],
          createdAt: { blockHash: receiptOutcome.blockHash.cryptoHash }
        };
      });
      return acc;
    }, { [conversionStep.result.firstExecutionStepId]: {
      kind: "Execution",
      createdAt: { blockHash: conversionStep.executedAt.blockHash }
    } });
  };
  const tryParseBase64ToObject = (rawData) => {
    if (rawData === "") return null;
    try {
      return fromJsonBytes(Uint8Array.fromBase64(rawData));
    } catch {
      return rawData;
    }
  };
  const getParsedResult = (rawResult) => rawResult.status === "Success" ? {
    status: "Success",
    data: tryParseBase64ToObject(rawResult.data)
  } : rawResult;
  const getParsedExecutionStep = (rawExecutionStep) => ({
    executionStepId: rawExecutionStep.executionStepId,
    result: getParsedResult(rawExecutionStep.result),
    createdAt: rawExecutionStep.createdAt,
    createdBy: rawExecutionStep.createdBy,
    executedAt: rawExecutionStep.executedAt,
    executedBy: rawExecutionStep.executedBy,
    producedSteps: rawExecutionStep.producedSteps,
    actionSummaries: rawExecutionStep.actionSummaries.map(baseGetActionSummary),
    requiredDataIds: rawExecutionStep.requiredDataIds,
    futureDataReceivers: rawExecutionStep.futureDataReceivers,
    isPromiseYield: rawExecutionStep.isPromiseYield,
    gasFee: rawExecutionStep.gasFee,
    gasUsed: rawExecutionStep.gasUsed,
    logs: rawExecutionStep.logs
  });
  const deserializeExecutionSteps = (inputArgs, rawExecutionSteps) => {
    if (inputArgs.options?.deserializeExecutionSteps) try {
      return result.ok(inputArgs.options.deserializeExecutionSteps({ rawExecutionSteps }));
    } catch (cause) {
      return resultNatError("Client.GetTransactionResult.DeserializeExecutionSteps.Failed", {
        cause,
        rawExecutionSteps
      });
    }
    return result.ok(rawExecutionSteps.map(getParsedExecutionStep));
  };
  const getRawExecutionStepResult = (status) => {
    if (typeof status === "object" && "SuccessValue" in status) return {
      status: "Success",
      data: status.SuccessValue
    };
    if (typeof status === "object" && "SuccessReceiptId" in status) return {
      status: "Continuation",
      nextExecutionStepId: status.SuccessReceiptId.cryptoHash
    };
    if (typeof status === "object" && "Failure" in status) return {
      status: "Error",
      error: getExecutionError(status.Failure.ActionError)
    };
    throw new Error(`Unexpected receipt execution outcome status: ${JSON.stringify(status)}`);
  };
  const getRawExecutionStep = (receipt, receiptOutcome, receiptCreationMap) => {
    const { Action } = receipt.receipt;
    const dataReceivers = Action.outputDataReceivers.map(({ dataId, receiverId }) => ({
      dataId,
      receiverAccountId: receiverId
    }));
    const producedSteps = receiptOutcome.outcome.receiptIds.map(({ cryptoHash }) => {
      const { kind } = receiptCreationMap[cryptoHash];
      return kind === "Execution" ? {
        kind,
        executionStepId: cryptoHash
      } : {
        kind,
        refundStepId: cryptoHash
      };
    });
    return {
      executionStepId: receipt.receiptId,
      result: getRawExecutionStepResult(receiptOutcome.outcome.status),
      createdAt: receiptCreationMap[receipt.receiptId].createdAt,
      createdBy: { accountId: receipt.predecessorId },
      executedAt: { blockHash: receiptOutcome.blockHash.cryptoHash },
      executedBy: { accountId: receiptOutcome.outcome.executorId },
      actionSummaries: Action.actions.map(getRawActionSummary),
      producedSteps,
      requiredDataIds: Action.inputDataIds,
      futureDataReceivers: dataReceivers,
      isPromiseYield: Action.isPromiseYield,
      gasFee: throwableYoctoNear(receiptOutcome.outcome.tokensBurnt),
      gasUsed: throwableGas(receiptOutcome.outcome.gasBurnt),
      logs: receiptOutcome.outcome.logs
    };
  };
  const getRawExecutionSteps = (receiptsWithOutcomes, receiptCreationMap) => receiptsWithOutcomes.filter(({ receipt }) => receipt.predecessorId !== "system").map(({ receipt, receiptOutcome }) => getRawExecutionStep(receipt, receiptOutcome, receiptCreationMap));
  const getReceiptsWithOutcomes = (transaction, receipts, receiptsOutcome, conversionStepSuccess) => {
    const fullReceipts = transaction.signerId === transaction.receiverId ? [{
      receiptId: conversionStepSuccess.result.firstExecutionStepId,
      predecessorId: transaction.signerId,
      receiverId: transaction.receiverId,
      receipt: { Action: {
        actions: transaction.actions,
        inputDataIds: [],
        isPromiseYield: false,
        outputDataReceivers: []
      } }
    }, ...receipts] : receipts;
    return receiptsOutcome.map((receiptOutcome, index) => ({
      receipt: fullReceipts[index],
      receiptOutcome
    }));
  };
  const getRefundStepResult = (status) => {
    if (typeof status === "object" && "SuccessValue" in status && status.SuccessValue === "") return { status: "Success" };
    if (typeof status === "object" && "Failure" in status && typeof status.Failure.ActionError.kind === "object" && "AccountDoesNotExist" in status.Failure.ActionError.kind) return {
      status: "Error",
      error: {
        kind: "Receiver.NotFound",
        context: null
      }
    };
    throw new Error(`Unexpected refund receipt outcome status: 
    got: ${JSON.stringify(status)}, 
    but only SuccessValue = '' or Failure.ActionError.kind = AccountDoesNotExist is expected.`);
  };
  const getRefundAmount = (receipt) => {
    const { actions } = receipt.receipt.Action;
    if (actions.length === 1 && typeof actions[0] === "object" && "Transfer" in actions[0]) return throwableYoctoNear(actions[0].Transfer.deposit);
    throw new Error(`Unexpected refund receipt actions: 
    got: ${JSON.stringify(receipt.receipt.Action.actions)}, 
    but only a single Transfer action is expected.`);
  };
  const getRefundStep = (receipt, receiptOutcome, receiptCreationMap) => {
    return {
      refundStepId: receipt.receiptId,
      result: getRefundStepResult(receiptOutcome.outcome.status),
      createdAt: receiptCreationMap[receipt.receiptId].createdAt,
      executedAt: { blockHash: receiptOutcome.blockHash.cryptoHash },
      refundAmount: getRefundAmount(receipt),
      receiverAccountId: receiptOutcome.outcome.executorId
    };
  };
  const getRefundSteps = (receiptsWithOutcomes, receiptCreationMap) => receiptsWithOutcomes.filter(({ receipt }) => receipt.predecessorId === "system").map((receiptOutcome) => getRefundStep(receiptOutcome.receipt, receiptOutcome.receiptOutcome, receiptCreationMap));
  const getNonConversionSteps = (transaction, receipts, receiptsOutcome, conversionStepSuccess, inputArgs) => {
    if (receiptsOutcome.length === 0) {
      const executionSteps2 = deserializeExecutionSteps(inputArgs, []);
      if (!executionSteps2.ok) return executionSteps2;
      return result.ok({
        executionSteps: executionSteps2.value,
        refundSteps: []
      });
    }
    const receiptsWithOutcomes = getReceiptsWithOutcomes(transaction, receipts, receiptsOutcome, conversionStepSuccess);
    const receiptCreationMap = createReceiptCreationMap(conversionStepSuccess, receiptsWithOutcomes);
    const executionSteps = deserializeExecutionSteps(inputArgs, getRawExecutionSteps(receiptsWithOutcomes, receiptCreationMap));
    if (!executionSteps.ok) return executionSteps;
    return result.ok({
      executionSteps: executionSteps.value,
      refundSteps: getRefundSteps(receiptsWithOutcomes, receiptCreationMap)
    });
  };
  const getTransactionExecutionFailure = (transaction, transactionOutcome, receipts, receiptsOutcome, actionError, inputArgs) => {
    const conversionStepSuccess = getConversionStepSuccess(transaction, transactionOutcome, inputArgs);
    if (!conversionStepSuccess.ok) return conversionStepSuccess;
    const nonConversionSteps = getNonConversionSteps(transaction, receipts, receiptsOutcome, conversionStepSuccess.value, inputArgs);
    if (!nonConversionSteps.ok) return nonConversionSteps;
    return result.ok({
      transactionHash: transaction.hash.cryptoHash,
      result: {
        status: "ExecutionError",
        error: getExecutionError(actionError)
      },
      processingSteps: {
        conversionStep: conversionStepSuccess.value,
        ...nonConversionSteps.value
      }
    });
  };
  const deserializeResultData = (rawData, inputArgs) => {
    if (inputArgs.options?.deserializeResultData) try {
      return result.ok(inputArgs.options.deserializeResultData({ rawData }));
    } catch (cause) {
      return resultNatError("Client.GetTransactionResult.DeserializeResultData.Failed", {
        cause,
        rawData
      });
    }
    return result.ok(tryParseBase64ToObject(rawData));
  };
  const getTransactionSuccess = (transaction, transactionOutcomeSuccess, receipts, receiptsOutcome, statusSuccessValue, inputArgs) => {
    const conversionStepSuccess = getConversionStepSuccess(transaction, transactionOutcomeSuccess, inputArgs);
    if (!conversionStepSuccess.ok) return conversionStepSuccess;
    const nonConversionSteps = getNonConversionSteps(transaction, receipts, receiptsOutcome, conversionStepSuccess.value, inputArgs);
    if (!nonConversionSteps.ok) return nonConversionSteps;
    const resultData = deserializeResultData(statusSuccessValue, inputArgs);
    if (!resultData.ok) return resultData;
    return result.ok({
      transactionHash: transaction.hash.cryptoHash,
      result: {
        status: "Success",
        data: resultData.value
      },
      processingSteps: {
        conversionStep: conversionStepSuccess.value,
        ...nonConversionSteps.value
      }
    });
  };
  const getCurrentProcessingStage = (finalExecutionStatus) => {
    if (finalExecutionStatus === "INCLUDED") return "ConvertedOptimistic";
    if (finalExecutionStatus === "INCLUDED_FINAL") return "ConvertedFinal";
    if (finalExecutionStatus === "EXECUTED_OPTIMISTIC") return "ExecutedOptimistic";
    return "ExecutedNearlyFinal";
  };
  const RpcResultZodSchema = /* @__PURE__ */ union([
    RpcIncludedTransactionDetailsZodSchema,
    RpcIncludedFinalTransactionDetailsZodSchema,
    RpcExecutedOptimisticTransactionDetailsZodSchema,
    RpcExecutedTransactionDetailsZodSchema,
    RpcFinalTransactionDetailsZodSchema
  ]);
  const handleRpcResult = (rpcResponse, inputArgs) => {
    const rpcResult = RpcResultZodSchema.safeParse(rpcResponse.result);
    if (!rpcResult.success) return resultNatError("Client.GetTransactionResult.Exhausted", { lastError: createNatError({
      kind: "SendRequest.Attempt.Response.InvalidSchema",
      context: { zodError: rpcResult.error }
    }) });
    const { finalExecutionStatus } = rpcResult.data;
    if (finalExecutionStatus !== "FINAL") return resultNatError("Client.GetTransactionResult.Rpc.Transaction.NotCompleted", {
      transactionHash: inputArgs.transactionHash,
      currentProcessingStage: getCurrentProcessingStage(finalExecutionStatus)
    });
    const { transaction, transactionOutcome, status, receiptsOutcome, receipts } = rpcResult.data;
    if ("SuccessValue" in status && isRpcTransactionOutcomeSuccess(transactionOutcome)) return getTransactionSuccess(transaction, transactionOutcome, receipts, receiptsOutcome, status.SuccessValue, inputArgs);
    if ("Failure" in status && "InvalidTxError" in status.Failure && isRpcTransactionOutcomeFailure(transactionOutcome)) return getTransactionConversionFailure(transaction, transactionOutcome, status.Failure.InvalidTxError, inputArgs);
    if ("Failure" in status && "ActionError" in status.Failure && isRpcTransactionOutcomeSuccess(transactionOutcome)) return getTransactionExecutionFailure(transaction, transactionOutcome, receipts, receiptsOutcome, status.Failure.ActionError, inputArgs);
    throw new Error("Unreachable");
  };
  const GetTransactionResultArgsZodShema = /* @__PURE__ */ object({
    transactionHash: CryptoHashZodSchema,
    policies: PoliciesZodSchema,
    options: /* @__PURE__ */ optional(/* @__PURE__ */ object({
      signal: /* @__PURE__ */ optional(/* @__PURE__ */ _instanceof(AbortSignal)),
      deserializeResultData: /* @__PURE__ */ optional(/* @__PURE__ */ _instanceof(Function)),
      deserializeActionSummaries: /* @__PURE__ */ optional(/* @__PURE__ */ _instanceof(Function)),
      deserializeExecutionSteps: /* @__PURE__ */ optional(/* @__PURE__ */ _instanceof(Function))
    }))
  });
  const createSafeGetTransactionResult = (context) => wrapInternalError("Client.GetTransactionResult.Internal", async (args) => {
    const validArgs = GetTransactionResultArgsZodShema.safeParse(args);
    if (!validArgs.success) return resultNatError("Client.GetTransactionResult.Args.InvalidSchema", { zodError: validArgs.error });
    const rpcResponse = await context.sendRequest({
      method: "EXPERIMENTAL_tx_status",
      params: {
        tx_hash: validArgs.data.transactionHash.cryptoHash,
        sender_account_id: "any",
        wait_until: "NONE"
      },
      transportPolicy: args.policies?.transport,
      signal: args.options?.signal
    });
    if (!rpcResponse.ok) return repackError({
      error: rpcResponse.error,
      originPrefix: "SendRequest",
      targetPrefix: "Client.GetTransactionResult"
    });
    return rpcResponse.value.error ? handleRpcError(rpcResponse.value) : handleRpcResult(rpcResponse.value, args);
  });
  const GasBudgetZodSchema = /* @__PURE__ */ union([/* @__PURE__ */ literal("Unlimited"), NearTokenArgsZodSchema]);
  const AllowedFunctionsSchema = /* @__PURE__ */ union([/* @__PURE__ */ literal("AllNonPayable"), (/* @__PURE__ */ array(ContractFunctionNameZodSchema)).check(/* @__PURE__ */ _minLength(1))]);
  const AddFullAccessKeyActionZodSchema = /* @__PURE__ */ object({
    actionType: /* @__PURE__ */ literal("AddKey"),
    accessType: /* @__PURE__ */ literal("FullAccess"),
    publicKey: PublicKeyZodSchema
  });
  const AddFunctionCallKeyActionZodSchema = /* @__PURE__ */ object({
    actionType: /* @__PURE__ */ literal("AddKey"),
    accessType: /* @__PURE__ */ literal("FunctionCall"),
    publicKey: PublicKeyZodSchema,
    contractAccountId: AccountIdZodSchema,
    gasBudget: GasBudgetZodSchema,
    allowedFunctions: AllowedFunctionsSchema
  });
  const AddKeyActionZodSchema = /* @__PURE__ */ union([AddFullAccessKeyActionZodSchema, AddFunctionCallKeyActionZodSchema]);
  const CreateAccountActionZodSchema = /* @__PURE__ */ object({ actionType: /* @__PURE__ */ literal("CreateAccount") });
  const DeleteAccountActionZodSchema = /* @__PURE__ */ object({
    actionType: /* @__PURE__ */ literal("DeleteAccount"),
    beneficiaryAccountId: AccountIdZodSchema
  });
  const DeleteKeyActionZodSchema = /* @__PURE__ */ object({
    actionType: /* @__PURE__ */ literal("DeleteKey"),
    publicKey: PublicKeyZodSchema
  });
  const DeployContractActionZodSchema = /* @__PURE__ */ object({
    actionType: /* @__PURE__ */ literal("DeployContract"),
    wasmBytes: /* @__PURE__ */ _instanceof(Uint8Array)
  });
  const GasInputZodSchema = /* @__PURE__ */ union([/* @__PURE__ */ bigint(), /* @__PURE__ */ pipe((/* @__PURE__ */ number()).check(/* @__PURE__ */ int()), /* @__PURE__ */ transform((v) => BigInt(v)))]);
  const createTeraGasInputZodSchema = (decimals) => (/* @__PURE__ */ string()).check(/* @__PURE__ */ refine((val) => {
    return new RegExp(`^\\d+(?:\\.\\d{1,${decimals}})?$`).test(val);
  }, { message: `Must be a valid number with up to ${decimals} decimal places` }));
  const TeraGasInputZodSchema = createTeraGasInputZodSchema(12);
  const NearGasArgsZodSchema = /* @__PURE__ */ union([/* @__PURE__ */ object({ gas: GasInputZodSchema }), /* @__PURE__ */ object({ teraGas: TeraGasInputZodSchema })]);
  const FunctionCallActionZodSchema = /* @__PURE__ */ object({
    actionType: /* @__PURE__ */ literal("FunctionCall"),
    functionName: ContractFunctionNameZodSchema,
    functionArgs: /* @__PURE__ */ _instanceof(Uint8Array),
    gasLimit: NearGasArgsZodSchema,
    attachedDeposit: /* @__PURE__ */ optional(NearTokenArgsZodSchema)
  });
  const StakeActionZodSchema = /* @__PURE__ */ object({
    actionType: /* @__PURE__ */ literal("Stake"),
    amount: NearTokenArgsZodSchema,
    validatorPublicKey: PublicKeyZodSchema
  });
  const TransferActionZodSchema = /* @__PURE__ */ object({
    actionType: /* @__PURE__ */ literal("Transfer"),
    amount: NearTokenArgsZodSchema
  });
  const ActionZodSchema = /* @__PURE__ */ union([
    CreateAccountActionZodSchema,
    TransferActionZodSchema,
    AddKeyActionZodSchema,
    DeployContractActionZodSchema,
    FunctionCallActionZodSchema,
    StakeActionZodSchema,
    DeleteKeyActionZodSchema,
    DeleteAccountActionZodSchema
  ]);
  const TransactionBaseZodSchema = /* @__PURE__ */ object({
    signerAccountId: AccountIdZodSchema,
    signerPublicKey: PublicKeyZodSchema,
    receiverAccountId: AccountIdZodSchema,
    nonce: TransactionNonceZodSchema,
    blockHash: BlockHashZodSchema
  });
  const TransactionSingleActionZodSchema = /* @__PURE__ */ object({
    action: ActionZodSchema,
    actions: /* @__PURE__ */ optional(/* @__PURE__ */ never())
  });
  const SingleActionTransactionZodSchema = /* @__PURE__ */ object({
    ...TransactionBaseZodSchema.shape,
    ...TransactionSingleActionZodSchema.shape
  });
  const TransactionMultiActionsZodSchema = /* @__PURE__ */ object({
    action: /* @__PURE__ */ optional(/* @__PURE__ */ never()),
    actions: (/* @__PURE__ */ array(ActionZodSchema)).check(/* @__PURE__ */ _minLength(1))
  });
  const MultiActionsTransactionZodSchema = /* @__PURE__ */ object({
    ...TransactionBaseZodSchema.shape,
    ...TransactionMultiActionsZodSchema.shape
  });
  const TransactionZodSchema = /* @__PURE__ */ union([SingleActionTransactionZodSchema, MultiActionsTransactionZodSchema]);
  const SingleActionTransactionIntentZodSchema = /* @__PURE__ */ object({
    ...TransactionSingleActionZodSchema.shape,
    receiverAccountId: AccountIdZodSchema
  });
  const MultiActionsTransactionIntentZodSchema = /* @__PURE__ */ object({
    ...TransactionMultiActionsZodSchema.shape,
    receiverAccountId: AccountIdZodSchema
  });
  const TransactionIntentZodSchema = /* @__PURE__ */ union([SingleActionTransactionIntentZodSchema, MultiActionsTransactionIntentZodSchema]);
  const SignedTransactionZodSchema = /* @__PURE__ */ object({
    transaction: TransactionZodSchema,
    transactionHash: CryptoHashZodSchema,
    signature: SignatureZodSchema
  });
  const PublicKeyBorshSchema = { enum: [{ struct: { ed25519Key: { struct: { data: { array: {
    type: "u8",
    len: 32
  } } } } } }, { struct: { secp256k1Key: { struct: { data: { array: {
    type: "u8",
    len: 64
  } } } } } }] };
  const addKeyActionBorshSchema = { struct: { addKey: { struct: {
    publicKey: PublicKeyBorshSchema,
    accessKey: { struct: {
      nonce: "u64",
      permission: { enum: [{ struct: { functionCall: { struct: {
        allowance: { option: "u128" },
        receiverId: "string",
        methodNames: { array: { type: "string" } }
      } } } }, { struct: { fullAccess: { struct: {} } } }] }
    } }
  } } } };
  const createAccountActionBorshSchema = { struct: { createAccount: { struct: {} } } };
  const deleteAccountActionBorshSchema = { struct: { deleteAccount: { struct: { beneficiaryId: "string" } } } };
  const deleteKeyActionBorshSchema = { struct: { deleteKey: { struct: { publicKey: PublicKeyBorshSchema } } } };
  const deployContractActionBorshSchema = { struct: { deployContract: { struct: { code: { array: { type: "u8" } } } } } };
  const deployGlobalContractActionBorshSchema = { struct: { deployGlobalContract: { struct: {
    code: { array: { type: "u8" } },
    deployMode: { enum: [{ struct: { CodeHash: { struct: {} } } }, { struct: { AccountId: { struct: {} } } }] }
  } } } };
  const functionCallActionBorshSchema = { struct: { functionCall: { struct: {
    methodName: "string",
    args: { array: { type: "u8" } },
    gas: "u64",
    deposit: "u128"
  } } } };
  const stakeActionBorshSchema = { struct: { stake: { struct: {
    stake: "u128",
    publicKey: PublicKeyBorshSchema
  } } } };
  const transferActionBorshSchema = { struct: { transfer: { struct: { deposit: "u128" } } } };
  const useGlobalContractActionBorshSchema = { struct: { useGlobalContract: { struct: { contractIdentifier: { enum: [{ struct: { CodeHash: { array: {
    type: "u8",
    len: 32
  } } } }, { struct: { AccountId: "string" } }] } } } } };
  const SignatureBorshSchema = { enum: [{ struct: { ed25519Signature: { struct: { data: { array: {
    type: "u8",
    len: 64
  } } } } } }, { struct: { secp256k1Signature: { struct: { data: { array: {
    type: "u8",
    len: 65
  } } } } } }] };
  const TransactionBorshSchema = { struct: {
    signerId: "string",
    publicKey: PublicKeyBorshSchema,
    nonce: "u64",
    receiverId: "string",
    blockHash: { array: {
      type: "u8",
      len: 32
    } },
    actions: { array: { type: { enum: [
      createAccountActionBorshSchema,
      deployContractActionBorshSchema,
      functionCallActionBorshSchema,
      transferActionBorshSchema,
      stakeActionBorshSchema,
      addKeyActionBorshSchema,
      deleteKeyActionBorshSchema,
      deleteAccountActionBorshSchema,
      { struct: { delegate: { struct: {
        delegateAction: { struct: {
          senderId: "string",
          receiverId: "string",
          actions: { array: { type: { enum: [
            createAccountActionBorshSchema,
            deployContractActionBorshSchema,
            functionCallActionBorshSchema,
            transferActionBorshSchema,
            stakeActionBorshSchema,
            addKeyActionBorshSchema,
            deleteKeyActionBorshSchema,
            deleteAccountActionBorshSchema,
            { struct: { delegate: "bool" } },
            deployGlobalContractActionBorshSchema,
            useGlobalContractActionBorshSchema
          ] } } },
          nonce: "u64",
          maxBlockHeight: "u64",
          publicKey: PublicKeyBorshSchema
        } },
        signature: SignatureBorshSchema
      } } } },
      deployGlobalContractActionBorshSchema,
      useGlobalContractActionBorshSchema
    ] } } }
  } };
  const SignedTransactionBorshSchema = { struct: {
    transaction: TransactionBorshSchema,
    signature: SignatureBorshSchema
  } };
  const toNativePublicKey = ({ publicKeyU8, curve }) => curve === "ed25519" ? { ed25519Key: { data: publicKeyU8 } } : { secp256k1Key: { data: publicKeyU8 } };
  const getPermission = (action) => {
    if (action.accessType === "FullAccess") return { fullAccess: {} };
    const { contractAccountId, gasBudget, allowedFunctions } = action;
    return { functionCall: {
      receiverId: contractAccountId,
      allowance: gasBudget === "Unlimited" ? null : throwableNearToken(gasBudget).yoctoNear,
      methodNames: allowedFunctions === "AllNonPayable" ? [] : allowedFunctions
    } };
  };
  const toNativeAddKeyAction = (action) => ({ addKey: {
    publicKey: toNativePublicKey(action.publicKey),
    accessKey: {
      nonce: 0n,
      permission: getPermission(action)
    }
  } });
  const toNativeCreateAccountAction = () => ({ createAccount: {} });
  const toNativeDeleteAccountAction = (action) => ({ deleteAccount: { beneficiaryId: action.beneficiaryAccountId } });
  const toNativeDeleteKeyAction = (action) => ({ deleteKey: { publicKey: toNativePublicKey(action.publicKey) } });
  const toNativeDeployContractAction = (action) => ({ deployContract: { code: action.wasmBytes } });
  const NearGasBrand = /* @__PURE__ */ Symbol("NearGas");
  const cache = {
    gas: /* @__PURE__ */ new WeakMap(),
    teraGas: /* @__PURE__ */ new WeakMap()
  };
  const isNearGas = (value) => typeof value === "object" && value !== null && NearGasBrand in value;
  const toGas = (x) => {
    if (isNearGas(x)) return result.ok(x.gas);
    const nearGas = safeNearGas(x);
    return nearGas.ok ? result.ok(nearGas.value.gas) : nearGas;
  };
  const nearGasProto = {
    [NearGasBrand]: true,
    get teraGas() {
      const maybeValue = cache.teraGas.get(this);
      if (maybeValue) return maybeValue;
      const value = convertUnitsToTokens(this.gas, 12);
      cache.teraGas.set(this, value);
      return value;
    },
    get gas() {
      const maybeValue = cache.gas.get(this);
      if (maybeValue) return maybeValue;
      const value = convertTokensToUnits(this.teraGas, 12);
      cache.gas.set(this, value);
      return value;
    },
    safeAdd(value) {
      return wrapInternalError("CreateNearGas.Internal", () => {
        const gas = toGas(value);
        return gas.ok ? safeNearGas({ gas: this.gas + gas.value }) : gas;
      })();
    },
    add(value) {
      return asThrowable(this.safeAdd.bind(this))(value);
    },
    safeSub(value) {
      return wrapInternalError("CreateNearGas.Internal", () => {
        const gas = toGas(value);
        return gas.ok ? safeNearGas({ gas: this.gas - gas.value }) : gas;
      })();
    },
    sub(value) {
      return asThrowable(this.safeSub.bind(this))(value);
    },
    safeGt(value) {
      return wrapInternalError("CreateNearGas.Internal", () => {
        const gas = toGas(value);
        return gas.ok ? result.ok(this.gas > gas.value) : gas;
      })();
    },
    gt(value) {
      return asThrowable(this.safeGt.bind(this))(value);
    },
    safeLt(value) {
      return wrapInternalError("CreateNearGas.Internal", () => {
        const gas = toGas(value);
        return gas.ok ? result.ok(this.gas < gas.value) : gas;
      })();
    },
    lt(value) {
      return asThrowable(this.safeLt.bind(this))(value);
    },
    toString() {
      return JSON.stringify({
        teraGas: this.teraGas,
        gas: this.gas.toString()
      });
    },
    ...nodeInspectSymbol && { [nodeInspectSymbol](_depth, _opts) {
      return {
        teraGas: this.teraGas,
        gas: this.gas
      };
    } }
  };
  const safeGas = wrapInternalError("CreateNearGasFromGas.Internal", (gas) => {
    const validGas = GasInputZodSchema.safeParse(gas);
    if (!validGas.success) return result.err(createNatError({
      kind: "CreateNearGasFromGas.Args.InvalidSchema",
      context: { zodError: validGas.error }
    }));
    const nearGas = Object.create(nearGasProto);
    Object.defineProperty(nearGas, "gas", {
      value: validGas.data,
      enumerable: true
    });
    return result.ok(Object.freeze(nearGas));
  });
  const throwableGas = asThrowable(safeGas);
  const safeTeraGas = wrapInternalError("CreateNearGasFromTeraGas.Internal", (teraGas) => {
    const validTeraGas = TeraGasInputZodSchema.safeParse(teraGas);
    if (!validTeraGas.success) return result.err(createNatError({
      kind: "CreateNearGasFromTeraGas.Args.InvalidSchema",
      context: { zodError: validTeraGas.error }
    }));
    const nearGas = Object.create(nearGasProto);
    Object.defineProperty(nearGas, "teraGas", {
      value: validTeraGas.data,
      enumerable: true
    });
    return result.ok(Object.freeze(nearGas));
  });
  const throwableTeraGas = asThrowable(safeTeraGas);
  const safeNearGas = wrapInternalError("CreateNearGas.Internal", (args) => {
    const validArgs = NearGasArgsZodSchema.safeParse(args);
    if (!validArgs.success) return result.err(createNatError({
      kind: "CreateNearGas.Args.InvalidSchema",
      context: { zodError: validArgs.error }
    }));
    return "gas" in args ? result.ok(throwableGas(args.gas)) : result.ok(throwableTeraGas(args.teraGas));
  });
  const throwableNearGas = asThrowable(safeNearGas);
  const toNativeFunctionCallAction = (action) => {
    const { functionName, attachedDeposit, gasLimit, functionArgs } = action;
    return { functionCall: {
      methodName: functionName,
      args: functionArgs,
      gas: throwableNearGas(gasLimit).gas,
      deposit: attachedDeposit ? throwableNearToken(attachedDeposit).yoctoNear : 0n
    } };
  };
  const toNativeStakeAction = (action) => ({ stake: {
    stake: throwableNearToken(action.amount).yoctoNear,
    publicKey: toNativePublicKey(action.validatorPublicKey)
  } });
  const toNativeTransferAction = (action) => ({ transfer: { deposit: throwableNearToken(action.amount).yoctoNear } });
  const toNativeSignature = ({ signatureU8, curve }) => curve === "ed25519" ? { ed25519Signature: { data: signatureU8 } } : { secp256k1Signature: { data: signatureU8 } };
  const toNativeAction = (action) => {
    if (action.actionType === "Transfer") return toNativeTransferAction(action);
    if (action.actionType === "CreateAccount") return toNativeCreateAccountAction();
    if (action.actionType === "AddKey") return toNativeAddKeyAction(action);
    if (action.actionType === "DeployContract") return toNativeDeployContractAction(action);
    if (action.actionType === "Stake") return toNativeStakeAction(action);
    if (action.actionType === "FunctionCall") return toNativeFunctionCallAction(action);
    if (action.actionType === "DeleteKey") return toNativeDeleteKeyAction(action);
    return toNativeDeleteAccountAction(action);
  };
  const toNativeActions = (actions) => {
    if (actions.action) return [toNativeAction(actions.action)];
    if (actions.actions) return actions.actions.map((action) => toNativeAction(action));
    return [];
  };
  const toNativeTransaction = (transaction) => ({
    signerId: transaction.signerAccountId,
    publicKey: toNativePublicKey(transaction.signerPublicKey),
    actions: toNativeActions(transaction),
    receiverId: transaction.receiverAccountId,
    nonce: BigInt(transaction.nonce),
    blockHash: transaction.blockHash.cryptoHashU8
  });
  const toNativeSignedTransaction = (signedTransaction) => ({
    transaction: toNativeTransaction(signedTransaction.transaction),
    signature: toNativeSignature(signedTransaction.signature)
  });
  const toBorshTransaction = (transaction) => {
    return serialize(TransactionBorshSchema, toNativeTransaction(transaction));
  };
  const toBorshSignedTransaction = (signedTransaction) => {
    return serialize(SignedTransactionBorshSchema, toNativeSignedTransaction(signedTransaction));
  };
  const InvalidTransactionErrorSchema = /* @__PURE__ */ object({ TxExecutionError: /* @__PURE__ */ object({ InvalidTxError: InvalidTxErrorSchema() }) });
  const handleInvalidTransaction = (rpcResponse) => {
    const invalidTransactionError = InvalidTransactionErrorSchema.safeParse(rpcResponse.error?.data);
    if (!invalidTransactionError.success) return result.err(createNatError({
      kind: "Client.SendSignedTransaction.Exhausted",
      context: { lastError: createNatError({
        kind: "SendRequest.Attempt.Response.InvalidSchema",
        context: { zodError: invalidTransactionError.error }
      }) }
    }));
    const { InvalidTxError } = invalidTransactionError.data.TxExecutionError;
    if (typeof InvalidTxError === "string") {
      if (InvalidTxError === "Expired") return result.err(createNatError({
        kind: "Client.SendSignedTransaction.Rpc.Transaction.Expired",
        context: null
      }));
      if (InvalidTxError === "InvalidSignature") return result.err(createNatError({
        kind: "Client.SendSignedTransaction.Rpc.Transaction.Signature.Invalid",
        context: null
      }));
    }
    if (typeof InvalidTxError === "object") {
      if ("InvalidNonce" in InvalidTxError) {
        const { akNonce, txNonce } = InvalidTxError.InvalidNonce;
        return result.err(createNatError({
          kind: "Client.SendSignedTransaction.Rpc.Transaction.Nonce.Invalid",
          context: {
            accessKeyNonce: akNonce,
            transactionNonce: txNonce
          }
        }));
      }
      if ("SignerDoesNotExist" in InvalidTxError) return result.err(createNatError({
        kind: "Client.SendSignedTransaction.Rpc.Transaction.Signer.NotFound",
        context: { signerAccountId: InvalidTxError.SignerDoesNotExist.signerId }
      }));
      if ("NotEnoughBalance" in InvalidTxError) {
        const { signerId, cost } = InvalidTxError.NotEnoughBalance;
        return result.err(createNatError({
          kind: "Client.SendSignedTransaction.Rpc.Transaction.Signer.Balance.TooLow",
          context: {
            transactionCost: throwableYoctoNear(cost),
            signerAccountId: signerId
          }
        }));
      }
    }
    return result.err(createNatError({
      kind: "Client.SendSignedTransaction.Internal",
      context: { cause: rpcResponse }
    }));
  };
  const handleError = (rpcResponse) => {
    const rpcError = ErrorWrapperFor_RpcTransactionErrorSchema().safeParse(rpcResponse.error);
    if (!rpcError.success) return result.err(createNatError({
      kind: "Client.SendSignedTransaction.Exhausted",
      context: { lastError: createNatError({
        kind: "SendRequest.Attempt.Response.InvalidSchema",
        context: { zodError: rpcError.error }
      }) }
    }));
    const { name, cause } = rpcError.data;
    if (name === "HANDLER_ERROR") {
      if (cause.name === "TIMEOUT_ERROR") return result.err(createNatError({
        kind: `Client.SendSignedTransaction.Rpc.Transaction.Timeout`,
        context: null
      }));
      if (cause.name === "INVALID_TRANSACTION") return handleInvalidTransaction(rpcResponse);
    }
    return result.err(createNatError({
      kind: "Client.SendSignedTransaction.Internal",
      context: { cause: rpcResponse }
    }));
  };
  const handleActionError = (actionError, rpcResponse, inputArgs) => {
    const { transactionHash: transactionHash2 } = inputArgs.signedTransaction;
    const { kind, index: actionIndex } = actionError;
    if (typeof actionIndex !== "number") return result.err(createNatError({
      kind: "Client.SendSignedTransaction.Internal",
      context: { cause: createNatError({
        kind: "Client.SendSignedTransaction.Rpc.Transaction.Action.InvalidIndex",
        context: { rpcResponse }
      }) }
    }));
    if (typeof kind === "object") {
      if ("AccountDoesNotExist" in kind) return result.err(createNatError({
        kind: "Client.SendSignedTransaction.Rpc.Transaction.Receiver.NotFound",
        context: {
          receiverAccountId: kind.AccountDoesNotExist.accountId,
          actionIndex,
          transactionHash: transactionHash2
        }
      }));
      if ("AccountAlreadyExists" in kind) return result.err(createNatError({
        kind: "Client.SendSignedTransaction.Rpc.Transaction.Action.CreateAccount.AlreadyExist",
        context: {
          accountId: kind.AccountAlreadyExists.accountId,
          actionIndex,
          transactionHash: transactionHash2
        }
      }));
      if ("InsufficientStake" in kind) return result.err(createNatError({
        kind: "Client.SendSignedTransaction.Rpc.Transaction.Action.Stake.BelowThreshold",
        context: {
          accountId: kind.InsufficientStake.accountId,
          proposedStake: throwableYoctoNear(kind.InsufficientStake.stake),
          minimumStake: throwableYoctoNear(kind.InsufficientStake.minimumStake),
          actionIndex,
          transactionHash: transactionHash2
        }
      }));
      if ("TriesToStake" in kind) {
        const proposedStake = throwableYoctoNear(kind.TriesToStake.stake);
        const totalBalance = throwableYoctoNear(kind.TriesToStake.balance).add(throwableYoctoNear(kind.TriesToStake.locked));
        const missingAmount = proposedStake.sub(totalBalance);
        return result.err(createNatError({
          kind: "Client.SendSignedTransaction.Rpc.Transaction.Action.Stake.Balance.TooLow",
          context: {
            accountId: kind.TriesToStake.accountId,
            proposedStake,
            totalBalance,
            missingAmount,
            actionIndex,
            transactionHash: transactionHash2
          }
        }));
      }
      if ("TriesToUnstake" in kind) return result.err(createNatError({
        kind: "Client.SendSignedTransaction.Rpc.Transaction.Action.Stake.NotFound",
        context: {
          accountId: kind.TriesToUnstake.accountId,
          actionIndex,
          transactionHash: transactionHash2
        }
      }));
    }
    return result.err(createNatError({
      kind: "Client.SendSignedTransaction.Internal",
      context: { cause: rpcResponse }
    }));
  };
  const handleResult = (rpcResponse, inputArgs) => {
    const rpcResult = RpcTransactionResponseSchema().safeParse(rpcResponse.result);
    if (!rpcResult.success) return result.err(createNatError({
      kind: "Client.SendSignedTransaction.Exhausted",
      context: { lastError: createNatError({
        kind: "SendRequest.Attempt.Response.InvalidSchema",
        context: { zodError: rpcResult.error }
      }) }
    }));
    if (typeof rpcResult.data.status === "object" && "Failure" in rpcResult.data.status && "ActionError" in rpcResult.data.status.Failure) return handleActionError(rpcResult.data.status.Failure.ActionError, rpcResponse, inputArgs);
    const output = { rawRpcResult: rpcResult.data };
    return result.ok(output);
  };
  const SendSignedTransactionArgsShema = /* @__PURE__ */ object({
    signedTransaction: SignedTransactionZodSchema,
    policies: PoliciesZodSchema,
    options: BaseOptionsZodSchema
  });
  const createSafeSendSignedTransaction = (context) => wrapInternalError("Client.SendSignedTransaction.Internal", async (args) => {
    const validArgs = SendSignedTransactionArgsShema.safeParse(args);
    if (!validArgs.success) return result.err(createNatError({
      kind: "Client.SendSignedTransaction.Args.InvalidSchema",
      context: { zodError: validArgs.error }
    }));
    const rpcResponse = await context.sendRequest({
      method: "send_tx",
      params: {
        signed_tx_base64: toBorshSignedTransaction(validArgs.data.signedTransaction).toBase64(),
        wait_until: "EXECUTED_OPTIMISTIC"
      },
      transportPolicy: args.policies?.transport,
      signal: args.options?.signal
    });
    if (!rpcResponse.ok) return repackError({
      error: rpcResponse.error,
      originPrefix: "SendRequest",
      targetPrefix: "Client.SendSignedTransaction"
    });
    return rpcResponse.value.error ? handleError(rpcResponse.value) : handleResult(rpcResponse.value, args);
  });
  const RpcEndpointSchema = /* @__PURE__ */ object({
    url: /* @__PURE__ */ url(),
    headers: /* @__PURE__ */ optional(/* @__PURE__ */ record(/* @__PURE__ */ string(), /* @__PURE__ */ string()))
  });
  const RpcEndpointsArgsSchema = /* @__PURE__ */ union([
    /* @__PURE__ */ object({
      regular: (/* @__PURE__ */ array(RpcEndpointSchema)).check(/* @__PURE__ */ _minLength(1)),
      archival: /* @__PURE__ */ optional(/* @__PURE__ */ _undefined())
    }),
    /* @__PURE__ */ object({
      regular: /* @__PURE__ */ optional(/* @__PURE__ */ _undefined()),
      archival: (/* @__PURE__ */ array(RpcEndpointSchema)).check(/* @__PURE__ */ _minLength(1))
    }),
    /* @__PURE__ */ object({
      regular: (/* @__PURE__ */ array(RpcEndpointSchema)).check(/* @__PURE__ */ _minLength(1)),
      archival: (/* @__PURE__ */ array(RpcEndpointSchema)).check(/* @__PURE__ */ _minLength(1))
    })
  ]);
  const getInnerRpcEndpoints = (list = [], type) => list.map((rpc) => ({
    type,
    url: rpc.url,
    headers: {
      ...rpc.headers,
      "Content-Type": "application/json"
    }
  }));
  const safeSleep = (ms, signal) => new Promise((resolve) => {
    const abort = () => resolve(result.err(signal?.reason));
    if (signal?.aborted) abort();
    const timeoutId = setTimeout(() => resolve(result.ok(true)), ms);
    if (signal) signal.addEventListener("abort", () => {
      clearTimeout(timeoutId);
      abort();
    }, { once: true });
  });
  const BaseRpcErrorZodSchema = /* @__PURE__ */ object({
    code: /* @__PURE__ */ number(),
    message: /* @__PURE__ */ string(),
    data: /* @__PURE__ */ optional(/* @__PURE__ */ unknown())
  });
  const RpcErrorZodSchema = /* @__PURE__ */ discriminatedUnion("name", [
    /* @__PURE__ */ object({
      ...BaseRpcErrorZodSchema.shape,
      name: /* @__PURE__ */ literal("REQUEST_VALIDATION_ERROR"),
      cause: /* @__PURE__ */ discriminatedUnion("name", [/* @__PURE__ */ object({
        name: /* @__PURE__ */ literal("METHOD_NOT_FOUND"),
        info: /* @__PURE__ */ object({ methodName: /* @__PURE__ */ string() })
      }), /* @__PURE__ */ object({
        name: /* @__PURE__ */ literal("PARSE_ERROR"),
        info: /* @__PURE__ */ object({ errorMessage: /* @__PURE__ */ string() })
      })])
    }),
    /* @__PURE__ */ object({
      ...BaseRpcErrorZodSchema.shape,
      name: /* @__PURE__ */ literal("HANDLER_ERROR"),
      cause: /* @__PURE__ */ object({
        info: /* @__PURE__ */ unknown(),
        name: /* @__PURE__ */ string()
      })
    }),
    /* @__PURE__ */ object({
      ...BaseRpcErrorZodSchema.shape,
      name: /* @__PURE__ */ literal("INTERNAL_ERROR"),
      cause: /* @__PURE__ */ object({
        name: /* @__PURE__ */ literal("INTERNAL_ERROR"),
        info: /* @__PURE__ */ object({ errorMessage: /* @__PURE__ */ string() })
      })
    })
  ]);
  const RpcResponseZodSchema = /* @__PURE__ */ union([/* @__PURE__ */ object({
    jsonrpc: /* @__PURE__ */ literal("2.0"),
    id: /* @__PURE__ */ number(),
    result: /* @__PURE__ */ unknown(),
    error: /* @__PURE__ */ optional(/* @__PURE__ */ never())
  }), /* @__PURE__ */ object({
    jsonrpc: /* @__PURE__ */ literal("2.0"),
    id: /* @__PURE__ */ number(),
    result: /* @__PURE__ */ optional(/* @__PURE__ */ never()),
    error: RpcErrorZodSchema
  })]);
  const snakeToCamelCase = (obj) => {
    if (obj === null || typeof obj !== "object") return obj;
    if (Array.isArray(obj)) return obj.map((item) => snakeToCamelCase(item));
    return Object.keys(obj).reduce((acc, key) => {
      const value = obj[key];
      const camelKey = key.replace(/(_\w)/g, (match) => match.charAt(1).toUpperCase());
      if (value !== null && typeof value === "object") acc[camelKey] = snakeToCamelCase(value);
      else acc[camelKey] = value;
      return acc;
    }, {});
  };
  const prefix = "SendRequest.InnerRpc";
  const getErrorKind = ({ name, cause }) => {
    if (name === "REQUEST_VALIDATION_ERROR") {
      if (cause.name === "METHOD_NOT_FOUND") return `${prefix}.MethodNotFound`;
      if (cause.name === "PARSE_ERROR") return `${prefix}.ParseFailed`;
    }
    if (name === "HANDLER_ERROR") {
      if (cause.name === "NO_SYNCED_BLOCKS") return `${prefix}.NotSynced`;
      if (cause.name === "NOT_SYNCED_YET") return `${prefix}.NotSynced`;
      if (cause.name === "TIMEOUT_ERROR") return `${prefix}.Transaction.Timeout`;
      if (cause.name === "GARBAGE_COLLECTED_BLOCK") return `${prefix}.Block.GarbageCollected`;
      if (cause.name === "UNKNOWN_BLOCK") return `${prefix}.Block.NotFound`;
      if (cause.name === "INTERNAL_ERROR") return `${prefix}.Internal`;
    }
    if (name === "INTERNAL_ERROR") return `${prefix}.Internal`;
  };
  const extractRpcErrors = (generalRpcResponse, rpc) => {
    if ("result" in generalRpcResponse) return result.ok(generalRpcResponse);
    const kind = getErrorKind(generalRpcResponse.error);
    if (!kind) return result.ok(generalRpcResponse);
    return result.err(createNatError({
      kind,
      context: {
        rawRpcResponse: generalRpcResponse,
        rpc
      }
    }));
  };
  const createAttemptTimeout = (attemptTimeoutMs) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(createNatError({
      kind: "SendRequest.Attempt.Request.Timeout",
      context: { timeoutMs: attemptTimeoutMs }
    })), attemptTimeoutMs);
    return {
      signal: controller.signal,
      timeoutId
    };
  };
  const fetchData = async (context, rpc, body) => {
    const attemptTimeout = createAttemptTimeout(context.transportPolicy.timeouts.attemptMs);
    try {
      const response = await fetch(rpc.url, {
        method: "POST",
        headers: rpc.headers,
        body: JSON.stringify(body),
        signal: combineAbortSignals([
          context.externalAbortSignal,
          context.requestTimeoutSignal,
          attemptTimeout.signal
        ])
      });
      return result.ok(response);
    } catch (e) {
      if (isNatErrorOf(e, [
        "SendRequest.Attempt.Request.Timeout",
        "SendRequest.Timeout",
        "SendRequest.Aborted"
      ])) return result.err(e);
      return result.err(createNatError({
        kind: "SendRequest.Attempt.Request.FetchFailed",
        context: {
          cause: e,
          rpc,
          requestBody: body
        }
      }));
    } finally {
      clearTimeout(attemptTimeout.timeoutId);
    }
  };
  const parseJsonResponse = async (response, rpc) => {
    try {
      return result.ok(await response.json());
    } catch (e) {
      return result.err(createNatError({
        kind: "SendRequest.Attempt.Response.JsonParseFailed",
        context: {
          cause: e,
          rpc,
          response
        }
      }));
    }
  };
  const sendOnce = async (context, rpc) => {
    const response = await fetchData(context, rpc, {
      jsonrpc: "2.0",
      id: 0,
      method: context.method,
      params: context.params
    });
    if (!response.ok) return response;
    const json2 = await parseJsonResponse(response.value, rpc);
    if (!json2.ok) return json2;
    const camelCased = snakeToCamelCase(json2.value);
    const generalRpcResponse = RpcResponseZodSchema.safeParse(camelCased);
    if (!generalRpcResponse.success) return result.err(createNatError({
      kind: "SendRequest.Attempt.Response.InvalidSchema",
      context: { zodError: generalRpcResponse.error }
    }));
    return extractRpcErrors(generalRpcResponse.data, rpc);
  };
  const getBackoffDelay = (cap, base, sleep, multiplier) => Math.min(cap, Math.round(randomBetween(base, sleep * multiplier)));
  const shouldRetry = (sendOnceResult) => !sendOnceResult.ok && isNatErrorOf(sendOnceResult.error, [
    "SendRequest.Attempt.Request.FetchFailed",
    "SendRequest.Attempt.Request.Timeout",
    "SendRequest.InnerRpc.Transaction.Timeout",
    "SendRequest.InnerRpc.NotSynced",
    "SendRequest.InnerRpc.Internal"
  ]);
  const sendWithRetry = async (context, rpc) => {
    const { maxAttempts, retryBackoff } = context.transportPolicy.rpc;
    let backoffDelay = retryBackoff.minDelayMs;
    const attempt = async (attemptIndex) => {
      const sendOnceResult = await sendOnce(context, rpc);
      if (attemptIndex >= maxAttempts - 1 || !shouldRetry(sendOnceResult)) return sendOnceResult;
      backoffDelay = getBackoffDelay(retryBackoff.maxDelayMs, retryBackoff.minDelayMs, backoffDelay, retryBackoff.multiplier);
      const sleepResult = await safeSleep(backoffDelay, combineAbortSignals([context.externalAbortSignal, context.requestTimeoutSignal]));
      return sleepResult.ok ? attempt(attemptIndex + 1) : sleepResult;
    };
    return attempt(0);
  };
  const shouldTryAnotherRpc = (sendOnceResult) => !sendOnceResult.ok && isNatErrorOf(sendOnceResult.error, [
    "SendRequest.Attempt.Request.FetchFailed",
    "SendRequest.Attempt.Request.Timeout",
    "SendRequest.Attempt.Response.JsonParseFailed",
    "SendRequest.Attempt.Response.InvalidSchema",
    "SendRequest.InnerRpc.MethodNotFound",
    "SendRequest.InnerRpc.ParseFailed",
    "SendRequest.InnerRpc.Transaction.Timeout",
    "SendRequest.InnerRpc.NotSynced",
    "SendRequest.InnerRpc.Internal"
  ]);
  const tryOneRound = async (context, rpcs) => {
    const { nextRpcDelayMs } = context.transportPolicy.failover;
    const roundOnRpc = async (rpcIndex) => {
      const rpc = rpcs[rpcIndex];
      const sendWithRetryResult = await sendWithRetry(context, rpc);
      if (rpcIndex >= rpcs.length - 1 || !shouldTryAnotherRpc(sendWithRetryResult)) return sendWithRetryResult;
      const sleepResult = await safeSleep(nextRpcDelayMs, combineAbortSignals([context.externalAbortSignal, context.requestTimeoutSignal]));
      return sleepResult.ok ? roundOnRpc(rpcIndex + 1) : sleepResult;
    };
    return roundOnRpc(0);
  };
  const shouldTryAnotherRound = (sendOnceResult) => !sendOnceResult.ok && isNatErrorOf(sendOnceResult.error, [
    "SendRequest.Attempt.Request.FetchFailed",
    "SendRequest.Attempt.Request.Timeout",
    "SendRequest.Attempt.Response.JsonParseFailed",
    "SendRequest.Attempt.Response.InvalidSchema",
    "SendRequest.InnerRpc.MethodNotFound",
    "SendRequest.InnerRpc.ParseFailed",
    "SendRequest.InnerRpc.Transaction.Timeout",
    "SendRequest.InnerRpc.NotSynced",
    "SendRequest.InnerRpc.Internal"
  ]);
  const tryMultipleRounds = async (context, rpcs) => {
    const { maxRounds, nextRoundDelayMs } = context.transportPolicy.failover;
    const round = async (roundIndex) => {
      const tryOneRoundResult = await tryOneRound(context, rpcs);
      if (roundIndex >= maxRounds - 1 || !shouldTryAnotherRound(tryOneRoundResult)) return tryOneRoundResult;
      const sleepResult = await safeSleep(nextRoundDelayMs, combineAbortSignals([context.externalAbortSignal, context.requestTimeoutSignal]));
      return sleepResult.ok ? round(roundIndex + 1) : sleepResult;
    };
    return round(0);
  };
  const getAvailableRpcs = (rpcEndpoints, rpcTypePreferences) => {
    const sortedList = rpcTypePreferences.reduce((acc, type) => {
      const value = rpcEndpoints[type === "Regular" ? "regular" : "archival"] ?? [];
      acc.push(...value);
      return acc;
    }, []);
    return sortedList.length > 0 ? result.ok(sortedList) : result.err(createNatError({
      kind: "SendRequest.PreferredRpc.NotFound",
      context: {
        rpcEndpoints,
        rpcTypePreferences
      }
    }));
  };
  const createExternalAbortSignal = (inputSignal) => {
    if (!inputSignal) return;
    const controller = new AbortController();
    inputSignal.addEventListener("abort", () => {
      controller.abort(createNatError({
        kind: "SendRequest.Aborted",
        context: { reason: inputSignal.reason }
      }));
    }, { once: true });
    return controller.signal;
  };
  const createRequestTimeout = (requestTimeoutMs) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(createNatError({
      kind: "SendRequest.Timeout",
      context: { timeoutMs: requestTimeoutMs }
    })), requestTimeoutMs);
    return {
      signal: controller.signal,
      timeoutId
    };
  };
  const handleMaybeUnknownBlock = async ({ requestResult: previousResult, rpcEndpoints, context }) => {
    if (previousResult.ok || !(isNatErrorOf(previousResult.error, ["SendRequest.InnerRpc.Block.GarbageCollected", "SendRequest.InnerRpc.Block.NotFound"]) && previousResult.error.context.rpc.type === "regular" && context.transportPolicy.rpcTypePreferences.includes("Archival"))) return previousResult;
    const rpcs = getAvailableRpcs(rpcEndpoints, ["Archival"]);
    if (!rpcs.ok) return previousResult;
    return await tryOneRound({
      ...context,
      transportPolicy: mergeTransportPolicy(context.transportPolicy, { rpcTypePreferences: ["Archival"] })
    }, rpcs.value);
  };
  const createSendRequest = (transportContext) => async (args) => {
    const transportPolicy = mergeTransportPolicy(transportContext.transportPolicy, args.transportPolicy);
    const rpcs = getAvailableRpcs(transportContext.rpcEndpoints, transportPolicy.rpcTypePreferences);
    if (!rpcs.ok) return rpcs;
    const maybeExternalAbortSignal = createExternalAbortSignal(args.signal);
    const requestTimeout = createRequestTimeout(transportPolicy.timeouts.requestMs);
    const context = {
      transportPolicy,
      method: args.method,
      params: args.params,
      externalAbortSignal: maybeExternalAbortSignal,
      requestTimeoutSignal: requestTimeout.signal
    };
    let requestResult = await tryMultipleRounds(context, rpcs.value);
    requestResult = await handleMaybeUnknownBlock({
      requestResult,
      context,
      rpcEndpoints: transportContext.rpcEndpoints
    });
    clearTimeout(requestTimeout.timeoutId);
    if (requestResult.ok) return requestResult;
    if (isNatErrorOf(requestResult.error, [
      "SendRequest.PreferredRpc.NotFound",
      "SendRequest.Timeout",
      "SendRequest.Aborted"
    ])) return result.err(requestResult.error);
    if (isNatErrorOf(requestResult.error, [
      "SendRequest.Attempt.Request.FetchFailed",
      "SendRequest.Attempt.Request.Timeout",
      "SendRequest.Attempt.Response.JsonParseFailed",
      "SendRequest.Attempt.Response.InvalidSchema"
    ])) return result.err(createNatError({
      kind: "SendRequest.Exhausted",
      context: { lastError: requestResult.error }
    }));
    return result.ok(requestResult.error.context.rawRpcResponse);
  };
  const CreateTransportArgsZodSchema = /* @__PURE__ */ object({
    rpcEndpoints: RpcEndpointsArgsSchema,
    policy: PartialTransportPolicyZodSchema
  });
  const createTransport = (args) => {
    const transportPolicy = mergeTransportPolicy(defaultTransportPolicy, args.policy);
    return { sendRequest: createSendRequest({
      rpcEndpoints: {
        regular: getInnerRpcEndpoints(args.rpcEndpoints.regular, "regular"),
        archival: getInnerRpcEndpoints(args.rpcEndpoints.archival, "archival")
      },
      transportPolicy
    }) };
  };
  const ClientBrand = /* @__PURE__ */ Symbol("Client");
  const isClient = (value) => typeof value === "object" && value !== null && ClientBrand in value;
  const CreateClientArgsSchema = /* @__PURE__ */ object({ transport: CreateTransportArgsZodSchema });
  const safeCreateClient = wrapInternalError("CreateClient.Internal", (args) => {
    const validArgs = CreateClientArgsSchema.safeParse(args);
    if (!validArgs.success) return result.err(createNatError({
      kind: "CreateClient.Args.InvalidSchema",
      context: { zodError: validArgs.error }
    }));
    const transport = createTransport(args.transport);
    const cache2 = createCache({ transport });
    const context = {
      sendRequest: transport.sendRequest,
      cache: cache2
    };
    const safeGetAccountInfo = createSafeGetAccountInfo(context);
    const safeGetAccountAccessKey = createSafeGetAccountAccessKey(context);
    const safeGetAccountAccessKeys = createSafeGetAccountAccessKeys(context);
    const safeCallContractReadFunction = createSafeCallContractReadFunction(context);
    const safeGetBlock = createSafeGetBlock(context);
    const safeGetTransactionResult = createSafeGetTransactionResult(context);
    const safeSendSignedTransaction = createSafeSendSignedTransaction(context);
    return result.ok({
      [ClientBrand]: true,
      getAccountInfo: asThrowable(safeGetAccountInfo),
      getAccountAccessKey: asThrowable(safeGetAccountAccessKey),
      getAccountAccessKeys: asThrowable(safeGetAccountAccessKeys),
      callContractReadFunction: asThrowable(safeCallContractReadFunction),
      getBlock: asThrowable(safeGetBlock),
      getRecentBlockHash: asThrowable(cache2.getRecentBlockHash),
      getTransactionResult: asThrowable(safeGetTransactionResult),
      sendSignedTransaction: asThrowable(safeSendSignedTransaction),
      safeGetAccountInfo,
      safeGetAccountAccessKey,
      safeGetAccountAccessKeys,
      safeCallContractReadFunction,
      safeGetBlock,
      safeGetRecentBlockHash: cache2.getRecentBlockHash,
      safeGetTransactionResult,
      safeSendSignedTransaction
    });
  });
  const throwableCreateClient = asThrowable(safeCreateClient);
  const serializeFunctionArgs = (args) => {
    if (args.options?.serializeArgs) try {
      const output = args.options.serializeArgs({ functionArgs: args.functionArgs });
      if (!(output instanceof Uint8Array)) return result.err(createNatError({
        kind: "CreateAction.FunctionCall.SerializeArgs.InvalidOutput",
        context: { output }
      }));
      return result.ok(output);
    } catch (e) {
      return result.err(createNatError({
        kind: "CreateAction.FunctionCall.SerializeArgs.Failed",
        context: {
          cause: e,
          functionArgs: args.functionArgs
        }
      }));
    }
    if (args?.functionArgs) {
      const jsonArgs = JsonValueZodSchema.safeParse(args.functionArgs);
      if (!jsonArgs.success) return result.err(createNatError({
        kind: "CreateAction.FunctionCall.Args.InvalidSchema",
        context: { zodError: jsonArgs.error }
      }));
      return result.ok(toJsonBytes(args.functionArgs));
    }
    return result.ok(new Uint8Array());
  };
  const CreateFunctionCallActionArgsSchema = /* @__PURE__ */ object({
    functionName: ContractFunctionNameZodSchema,
    functionArgs: /* @__PURE__ */ optional(/* @__PURE__ */ unknown()),
    gasLimit: NearGasArgsZodSchema,
    attachedDeposit: /* @__PURE__ */ optional(NearTokenArgsZodSchema),
    options: /* @__PURE__ */ optional(/* @__PURE__ */ object({ serializeArgs: /* @__PURE__ */ optional(/* @__PURE__ */ _instanceof(Function)) }))
  });
  const safeFunctionCall = wrapInternalError("CreateAction.FunctionCall.Internal", (args) => {
    const validArgs = CreateFunctionCallActionArgsSchema.safeParse(args);
    if (!validArgs.success) return result.err(createNatError({
      kind: "CreateAction.FunctionCall.Args.InvalidSchema",
      context: { zodError: validArgs.error }
    }));
    const functionArgs = serializeFunctionArgs(args);
    if (!functionArgs.ok) return functionArgs;
    return result.ok({
      actionType: "FunctionCall",
      functionName: args.functionName,
      gasLimit: args.gasLimit,
      functionArgs: functionArgs.value,
      attachedDeposit: args.attachedDeposit
    });
  });
  const throwableFunctionCall = asThrowable(safeFunctionCall);
  const { Ed25519: Ed25519$1, Secp256k1: Secp256k1$1 } = BinaryLengths;
  const PrivateKeyZodSchema = (/* @__PURE__ */ pipe(CurveStringZodSchema, /* @__PURE__ */ transform((val) => ({
    privateKey: val.curveString,
    privateKeyU8: val.dataU8,
    curve: val.curve
  })))).check(/* @__PURE__ */ refine(({ curve, privateKeyU8 }) => curve === "ed25519" ? privateKeyU8.length === Ed25519$1.PrivateKey : privateKeyU8.length === Secp256k1$1.PrivateKey, { error: "Invalid private key length" }));
  const { Ed25519, Secp256k1 } = BinaryLengths;
  const getInnerPublicKey = ({ curve, privateKeyU8 }) => {
    if (curve === "ed25519") {
      const publicKeyU82 = privateKeyU8.slice(Ed25519.SecretKey);
      return {
        curve,
        publicKey: toEd25519CurveString(publicKeyU82),
        publicKeyU8: publicKeyU82
      };
    }
    const publicKeyU8 = privateKeyU8.slice(Secp256k1.SecretKey);
    return {
      curve,
      publicKey: toSecp256k1CurveString(publicKeyU8),
      publicKeyU8
    };
  };
  const SignDataArgsZodSchema$1 = /* @__PURE__ */ object({ dataU8: /* @__PURE__ */ _instanceof(Uint8Array) });
  hashes$1.sha512 = sha512;
  const signByEd25519Key = (secretKeyU8, dataU8) => {
    const signatureU8 = sign$1(dataU8, secretKeyU8);
    return result.ok({
      curve: "ed25519",
      signature: toEd25519CurveString(signatureU8),
      signatureU8,
      dataU8
    });
  };
  hashes.hmacSha256 = (key, msg) => hmac(sha256, key, msg);
  hashes.sha256 = sha256;
  const signBySecp256k1Key = (secretKeyU8, dataU8) => {
    const recoveredSignature = sign(dataU8, secretKeyU8, {
      prehash: false,
      format: "recovered"
    });
    const signatureU8 = new Uint8Array([...recoveredSignature.subarray(1), recoveredSignature[0]]);
    return result.ok({
      curve: "secp256k1",
      signature: toSecp256k1CurveString(signatureU8),
      signatureU8,
      dataU8
    });
  };
  const getSecretKey = ({ curve, privateKeyU8 }) => {
    const secretKeyLength = curve === "ed25519" ? BinaryLengths.Ed25519.SecretKey : BinaryLengths.Secp256k1.SecretKey;
    return privateKeyU8.slice(0, secretKeyLength);
  };
  const createSafeSignData$3 = (innerPrivateKey) => {
    const secretKeyU8 = getSecretKey(innerPrivateKey);
    return wrapInternalError("KeyPair.SignData.Internal", async (args) => {
      const validArgs = SignDataArgsZodSchema$1.safeParse(args);
      if (!validArgs.success) return resultNatError("KeyPair.SignData.Args.InvalidSchema", { zodError: validArgs.error });
      return innerPrivateKey.curve === "ed25519" ? signByEd25519Key(secretKeyU8, validArgs.data.dataU8) : signBySecp256k1Key(secretKeyU8, validArgs.data.dataU8);
    });
  };
  const safeKeyPair = wrapInternalError("CreateKeyPair.Internal", (privateKey) => {
    const validPrivateKey = PrivateKeyZodSchema.safeParse(privateKey);
    if (!validPrivateKey.success) return resultNatError("CreateKeyPair.Args.InvalidSchema", { zodError: validPrivateKey.error });
    const innerPublicKey = getInnerPublicKey(validPrivateKey.data);
    const safeSignData = createSafeSignData$3(validPrivateKey.data);
    return result.ok({
      curve: innerPublicKey.curve,
      publicKey: innerPublicKey.publicKey,
      publicKeyU8: innerPublicKey.publicKeyU8,
      privateKey: validPrivateKey.data.privateKey,
      privateKeyU8: validPrivateKey.data.privateKeyU8,
      signData: asThrowable(safeSignData),
      safeSignData
    });
  });
  const keyPair = asThrowable(safeKeyPair);
  /* @__PURE__ */ object({
    message: JsonValueZodSchema,
    recipient: /* @__PURE__ */ string(),
    nonce: /* @__PURE__ */ optional((/* @__PURE__ */ _instanceof(Uint8Array)).check(/* @__PURE__ */ _length(Nep413Message.NonceLength)))
  });
  hashes$1.sha512 = sha512;
  hashes.hmacSha256 = (key, msg) => hmac(sha256, key, msg);
  hashes.sha256 = sha256;
  const getTransactionHash = (transaction) => {
    const transactionHashU8 = sha256(toBorshTransaction(transaction));
    return {
      transactionHash: base58.encode(transactionHashU8),
      transactionHashU8
    };
  };
  const SignTransactionArgsSchema$2 = /* @__PURE__ */ object({
    transaction: TransactionZodSchema,
    signDataProvider: /* @__PURE__ */ object({ safeSignData: /* @__PURE__ */ custom((val) => typeof val === "function", "keyService.safeSignData must be a function") })
  });
  const safeSignTransaction = wrapInternalError("SignTransaction.Internal", async (args) => {
    const validArgs = SignTransactionArgsSchema$2.safeParse(args);
    if (!validArgs.success) return resultNatError("SignTransaction.Args.InvalidSchema", { zodError: validArgs.error });
    const { transaction: innerTransaction } = validArgs.data;
    const { transactionHash: transactionHash2, transactionHashU8 } = getTransactionHash(innerTransaction);
    const signedData = await args.signDataProvider.safeSignData({
      publicKey: innerTransaction.signerPublicKey.publicKey,
      dataU8: transactionHashU8
    });
    if (!signedData.ok) return result.err(signedData.error);
    return result.ok({
      transaction: args.transaction,
      transactionHash: transactionHash2,
      signature: signedData.value.signature
    });
  });
  const signTransaction = asThrowable(safeSignTransaction);
  const toKeyPairs = (args) => {
    if ("keySource" in args) {
      const kp = keyPair(args.keySource.privateKey.privateKey);
      return { [kp.publicKey]: kp };
    }
    return Object.fromEntries(args.keySources.map((keySource) => {
      const kp = keyPair(keySource.privateKey.privateKey);
      return [kp.publicKey, kp];
    }));
  };
  const HasKeyArgsZodSchema = /* @__PURE__ */ object({ publicKey: PublicKeyZodSchema });
  const createSafeHasKey = (context) => wrapInternalError("MemoryKeyService.HasKey.Internal", async (args) => {
    const validArgs = HasKeyArgsZodSchema.safeParse(args);
    if (!validArgs.success) return resultNatError("MemoryKeyService.HasKey.Args.InvalidSchema", { zodError: validArgs.error });
    const { publicKey } = validArgs.data.publicKey;
    const keyPair2 = context.keyPairs[publicKey];
    return result.ok(keyPair2 !== void 0);
  });
  const SignDataArgsZodSchema = /* @__PURE__ */ object({
    publicKey: PublicKeyZodSchema,
    dataU8: /* @__PURE__ */ _instanceof(Uint8Array)
  });
  const createSafeSignData = (context) => wrapInternalError("MemoryKeyService.SignData.Internal", async (args) => {
    const validArgs = SignDataArgsZodSchema.safeParse(args);
    if (!validArgs.success) return resultNatError("MemoryKeyService.SignData.Args.InvalidSchema", { zodError: validArgs.error });
    const { publicKey, dataU8 } = validArgs.data;
    if (!await context.hasKey({ publicKey: publicKey.publicKey })) return resultNatError("MemoryKeyService.SignData.SigningKey.NotFound", { publicKey: publicKey.publicKey });
    const signedData = await context.keyPairs[publicKey.publicKey].signData({ dataU8 });
    return result.ok(signedData);
  });
  const KeySourceSchema = /* @__PURE__ */ object({ privateKey: PrivateKeyZodSchema });
  const CreateMemoryKeyServiceArgsSchema = /* @__PURE__ */ union([/* @__PURE__ */ object({ keySource: KeySourceSchema }), /* @__PURE__ */ object({ keySources: (/* @__PURE__ */ array(KeySourceSchema)).check(/* @__PURE__ */ _minLength(1)) })]);
  const safeCreateMemoryKeyService = wrapInternalError("CreateMemoryKeyService.Internal", (args) => {
    const validArgs = CreateMemoryKeyServiceArgsSchema.safeParse(args);
    if (!validArgs.success) return resultNatError("CreateMemoryKeyService.Args.InvalidSchema", { zodError: validArgs.error });
    const context = { keyPairs: toKeyPairs(validArgs.data) };
    const safeHasKey = createSafeHasKey(context);
    const hasKey = asThrowable(safeHasKey);
    context.hasKey = hasKey;
    const safeSignData = createSafeSignData(context);
    const signData = asThrowable(safeSignData);
    return result.ok({
      hasKey,
      safeHasKey,
      signData,
      safeSignData
    });
  });
  const throwableCreateMemoryKeyService = asThrowable(safeCreateMemoryKeyService);
  const SignTransactionArgsSchema$1 = /* @__PURE__ */ object({ intent: TransactionIntentZodSchema });
  const createSafeExecuteTransaction = (context) => wrapInternalError("MemorySigner.ExecuteTransaction.Internal", async (args) => {
    const validArgs = SignTransactionArgsSchema$1.safeParse(args);
    if (!validArgs.success) return result.err(createNatError({
      kind: "MemorySigner.ExecuteTransaction.Args.InvalidSchema",
      context: { zodError: validArgs.error }
    }));
    const taskResult = await context.taskQueue.addExecuteTransactionTask(args.intent);
    if (taskResult.ok) return taskResult;
    if (isNatErrorOf(taskResult.error, [
      "MemorySigner.KeyPool.AccessKeys.NotLoaded",
      "MemorySigner.KeyPool.Empty",
      "MemorySigner.KeyPool.SigningKey.NotFound",
      "MemorySigner.TaskQueue.Timeout"
    ])) return repackError({
      error: taskResult.error,
      originPrefix: "MemorySigner",
      targetPrefix: "MemorySigner.ExecuteTransaction"
    });
    if (taskResult.error.kind === "MemorySigner.Executors.ExecuteTransaction.Client.SendSignedTransaction") {
      if (isNatErrorOf(taskResult.error.context.cause, [
        "Client.SendSignedTransaction.PreferredRpc.NotFound",
        "Client.SendSignedTransaction.Aborted",
        "Client.SendSignedTransaction.Timeout",
        "Client.SendSignedTransaction.Exhausted",
        "Client.SendSignedTransaction.Rpc.Transaction.Timeout",
        "Client.SendSignedTransaction.Rpc.Transaction.Receiver.NotFound",
        "Client.SendSignedTransaction.Rpc.Transaction.Signer.Balance.TooLow",
        "Client.SendSignedTransaction.Rpc.Transaction.Action.CreateAccount.AlreadyExist",
        "Client.SendSignedTransaction.Rpc.Transaction.Action.Stake.BelowThreshold",
        "Client.SendSignedTransaction.Rpc.Transaction.Action.Stake.Balance.TooLow",
        "Client.SendSignedTransaction.Rpc.Transaction.Action.Stake.NotFound"
      ])) return repackError({
        error: taskResult.error.context.cause,
        originPrefix: "Client.SendSignedTransaction",
        targetPrefix: "MemorySigner.ExecuteTransaction"
      });
      throw taskResult.error.context.cause;
    }
    return result.err(taskResult.error);
  });
  const SignTransactionArgsSchema = /* @__PURE__ */ object({ intent: TransactionIntentZodSchema });
  const createSafeSignTransaction = (context) => wrapInternalError("MemorySigner.SignTransaction.Internal", async (args) => {
    const validArgs = SignTransactionArgsSchema.safeParse(args);
    if (!validArgs.success) return result.err(createNatError({
      kind: "MemorySigner.SignTransaction.Args.InvalidSchema",
      context: { zodError: validArgs.error }
    }));
    const signedTransaction = await context.taskQueue.addSignTransactionTask(args.intent);
    if (signedTransaction.ok) return signedTransaction;
    if (isNatErrorOf(signedTransaction.error, [
      "MemorySigner.KeyPool.AccessKeys.NotLoaded",
      "MemorySigner.KeyPool.Empty",
      "MemorySigner.KeyPool.SigningKey.NotFound",
      "MemorySigner.TaskQueue.Timeout"
    ])) return repackError({
      error: signedTransaction.error,
      originPrefix: "MemorySigner",
      targetPrefix: "MemorySigner.SignTransaction"
    });
    return result.err(signedTransaction.error);
  });
  const findSigningKey = (keyPriority, poolKeys) => {
    if (keyPriority.accessType === "FullAccess") return poolKeys.fullAccess.find((key) => !key.isLocked);
    return poolKeys.functionCall.find((key) => {
      const isContractIdMatch = key.contractAccountId === keyPriority.contractAccountId;
      const isFnCallAllowed = key.allowedFunctions === "AllNonPayable" || key.allowedFunctions.includes(keyPriority.calledFnName);
      return !key.isLocked && isContractIdMatch && isFnCallAllowed;
    });
  };
  const createFindKeyForTask = (keyPoolContext) => async (task) => {
    const poolKeys = await keyPoolContext.getPoolKeys();
    if (!poolKeys.ok) return poolKeys;
    for (const keyPriority of task.accessTypePriority) {
      const key = findSigningKey(keyPriority, poolKeys.value);
      if (key) {
        key.lock();
        return result.ok(key);
      }
    }
    return result.ok(void 0);
  };
  const createLock = (key) => () => {
    key.isLocked = true;
  };
  const createUnlock = (key) => () => {
    key.isLocked = false;
  };
  const createSetNonce = (key) => (newNonce) => {
    key.nonce = newNonce;
  };
  const transformKey$1 = (fullAccessKey) => {
    const { publicKey, nonce } = fullAccessKey;
    const key = {
      accessType: "FullAccess",
      publicKey,
      isLocked: false,
      nonce
    };
    key.lock = createLock(key);
    key.unlock = createUnlock(key);
    key.setNonce = createSetNonce(key);
    return key;
  };
  const createFullAccessPoolKeys = async (accountKeys, signerContext) => {
    const filteredKeys = [];
    for (const key of accountKeys) {
      const isKey = await signerContext.keyService.safeHasKey(key);
      if (isKey.ok && isKey.value === true && key.accessType === "FullAccess") filteredKeys.push(transformKey$1(key));
    }
    return filteredKeys;
  };
  const transformKey = (functionCallKey) => {
    const { publicKey, nonce, contractAccountId, allowedFunctions } = functionCallKey;
    const key = {
      accessType: "FunctionCall",
      publicKey,
      isLocked: false,
      nonce,
      contractAccountId,
      allowedFunctions
    };
    key.lock = createLock(key);
    key.unlock = createUnlock(key);
    key.setNonce = createSetNonce(key);
    return key;
  };
  const createFunctionCallPoolKeys = async (accountKeys, signerContext) => {
    const filteredKeys = [];
    for (const key of accountKeys) {
      const isKey = await signerContext.keyService.safeHasKey(key);
      if (isKey.ok && isKey.value === true && key.accessType === "FunctionCall") filteredKeys.push(transformKey(key));
    }
    return filteredKeys;
  };
  const getAllowedAccessKeys = (accountAccessKeys, createMemorySignerArgs) => {
    const whitelist = createMemorySignerArgs?.keyPool?.allowedAccessKeys;
    if (!whitelist) return accountAccessKeys;
    const set = new Set(whitelist);
    return accountAccessKeys.filter((key) => set.has(key.publicKey));
  };
  const createGetPoolKeys = (state, signerContext, createMemorySignerArgs) => async () => {
    if (state.poolKeys) return result.ok({
      fullAccess: state.poolKeys.fullAccess,
      functionCall: state.poolKeys.functionCall
    });
    if (state.poolKeysLoadingPromise) return await state.poolKeysLoadingPromise;
    const loadAccessKeys = async () => {
      const accountAccessKeys = await signerContext.client.safeGetAccountAccessKeys({
        accountId: signerContext.signerAccountId,
        atMomentOf: "LatestOptimisticBlock"
      });
      if (!accountAccessKeys.ok) return result.err(createNatError({
        kind: "MemorySigner.KeyPool.AccessKeys.NotLoaded",
        context: { cause: accountAccessKeys.error }
      }));
      const allowedAccessKeys = getAllowedAccessKeys(accountAccessKeys.value.accountAccessKeys, createMemorySignerArgs);
      if (allowedAccessKeys.length === 0) return result.err(createNatError({
        kind: "MemorySigner.KeyPool.Empty",
        context: {
          accountAccessKeys: accountAccessKeys.value.accountAccessKeys,
          allowedAccessKeys: createMemorySignerArgs.keyPool?.allowedAccessKeys ?? []
        }
      }));
      const [fullAccessPoolKeys, functionCallPollKeys] = await Promise.all([createFullAccessPoolKeys(allowedAccessKeys, signerContext), createFunctionCallPoolKeys(allowedAccessKeys, signerContext)]);
      state.poolKeys = {
        fullAccess: fullAccessPoolKeys,
        functionCall: functionCallPollKeys
      };
      state.poolKeysLoadingPromise = void 0;
      return result.ok(state.poolKeys);
    };
    state.poolKeysLoadingPromise = loadAccessKeys();
    return await state.poolKeysLoadingPromise;
  };
  const isKeyExist = async (keyPriority, poolKeys) => {
    if (keyPriority.accessType === "FullAccess") return poolKeys.fullAccess.length > 0;
    return poolKeys.functionCall.some((key) => {
      const isContractIdMatch = key.contractAccountId === keyPriority.contractAccountId;
      const isFnCallAllowed = key.allowedFunctions === "AllNonPayable" || key.allowedFunctions.includes(keyPriority.calledFnName);
      return isContractIdMatch && isFnCallAllowed;
    });
  };
  const createIsKeyForTaskExist = (keyPoolContext) => async (task) => {
    const poolKeys = await keyPoolContext.getPoolKeys();
    if (!poolKeys.ok) return poolKeys;
    for (const keyPriority of task.accessTypePriority) if (await isKeyExist(keyPriority, poolKeys.value)) return result.ok(true);
    return result.err(createNatError({
      kind: "MemorySigner.KeyPool.SigningKey.NotFound",
      context: {
        poolKeys: poolKeys.value,
        accessTypePriority: task.accessTypePriority
      }
    }));
  };
  const createKeyPool = (signerContext, createMemorySignerArgs) => {
    const keyPoolContext = { getPoolKeys: createGetPoolKeys({
      poolKeys: void 0,
      poolKeysLoadingPromise: void 0
    }, signerContext, createMemorySignerArgs) };
    return {
      findKeyForTask: createFindKeyForTask(keyPoolContext),
      isKeyForTaskExist: createIsKeyForTaskExist(keyPoolContext)
    };
  };
  const executeTransaction = async (signerContext, task, key) => {
    const maxAttempts = 3;
    const attempt = wrapInternalError("MemorySigner.ExecuteTransaction.Internal", async (attemptIndex, newNonce) => {
      const blockHash = await signerContext.client.getRecentBlockHash();
      const transaction = {
        ...task.transactionIntent,
        signerAccountId: signerContext.signerAccountId,
        signerPublicKey: key.publicKey,
        nonce: newNonce,
        blockHash
      };
      const signedTransaction = await signTransaction({
        signDataProvider: signerContext.keyService,
        transaction
      });
      const txResult = await signerContext.client.safeSendSignedTransaction({ signedTransaction });
      if (txResult.ok) {
        key.setNonce(newNonce);
        return txResult;
      }
      if (attemptIndex <= maxAttempts && txResult.error.kind === "Client.SendSignedTransaction.Rpc.Transaction.Nonce.Invalid") return await attempt(attemptIndex + 1, txResult.error.context.accessKeyNonce + 1);
      return result.err(createNatError({
        kind: "MemorySigner.Executors.ExecuteTransaction.Client.SendSignedTransaction",
        context: { cause: txResult.error }
      }));
    });
    const executeTransactionResult = await attempt(1, key.nonce + 1);
    signerContext.tasker.completeTask(task.taskId, executeTransactionResult);
  };
  const signTransaction$1 = async (signerContext, task, key) => {
    const transactionResult = await wrapInternalError("MemorySigner.SignTransaction.Internal", async () => {
      const nextNonce2 = key.nonce + 1;
      const blockHash = await signerContext.client.getRecentBlockHash();
      const transaction = {
        ...task.transactionIntent,
        signerAccountId: signerContext.signerAccountId,
        signerPublicKey: key.publicKey,
        nonce: nextNonce2,
        blockHash
      };
      const signedTransaction = await signTransaction({
        signDataProvider: signerContext.keyService,
        transaction
      });
      key.setNonce(nextNonce2);
      return result.ok(signedTransaction);
    })();
    signerContext.tasker.completeTask(task.taskId, transactionResult);
  };
  const createExecuteTask = (signerContext) => {
    const executeTask = async (task) => {
      const maybeKey = await signerContext.keyPool.findKeyForTask(task);
      if (!maybeKey.ok) throw maybeKey;
      if (!maybeKey.value) return;
      const key = maybeKey.value;
      signerContext.taskQueue.removeTask(task.taskId);
      await (task.taskType === "ExecuteTransaction" ? executeTransaction : signTransaction$1)(signerContext, task, key);
      key.unlock();
      const nextTask = signerContext.taskQueue.findTaskForKey(key);
      if (nextTask) executeTask(nextTask);
    };
    return executeTask;
  };
  const createTasker = (signerContext) => {
    const activeTasks = {};
    const waitForTask = (taskId) => new Promise((resolve) => {
      activeTasks[taskId] = (taskResult) => {
        resolve(taskResult);
        delete activeTasks[taskId];
      };
    });
    const completeTask = (taskId, taskResult) => {
      activeTasks[taskId](taskResult);
    };
    return {
      executeTask: createExecuteTask(signerContext),
      waitForTask,
      completeTask
    };
  };
  const checkIfKeyMatchRequirements = (keyPriority, key) => {
    if (key.accessType !== keyPriority.accessType) return false;
    if (key.accessType === "FullAccess") return true;
    const isContractIdMatch = key.contractAccountId === keyPriority.contractAccountId;
    const isFnCallAllowed = key.allowedFunctions === "AllNonPayable" || key.allowedFunctions.includes(keyPriority.calledFnName);
    return isContractIdMatch && isFnCallAllowed;
  };
  const createFindTaskForKey = (context) => (key) => context.queue.find((task) => task.accessTypePriority.some((keyPriority) => checkIfKeyMatchRequirements(keyPriority, key)));
  const addTask = (task, taskQueueContext) => {
    const { timeoutMs, signerContext, cleaners } = taskQueueContext;
    taskQueueContext.queue.push(task);
    cleaners[task.taskId] = setTimeout(() => {
      taskQueueContext.queue = taskQueueContext.queue.filter(({ taskId }) => taskId !== task.taskId);
      delete cleaners[task.taskId];
      signerContext.tasker.completeTask(task.taskId, result.err(createNatError({
        kind: "MemorySigner.TaskQueue.Timeout",
        context: { timeoutMs }
      })));
    }, timeoutMs);
    signerContext.tasker.executeTask(task);
  };
  const getPriorityForFunctionCallTransaction = (action, receiverAccountId) => [{ accessType: "FullAccess" }, {
    accessType: "FunctionCall",
    contractAccountId: receiverAccountId,
    calledFnName: action.functionName
  }];
  const getAccessTypePriority = ({ action, actions, receiverAccountId }) => {
    if (action?.actionType === "FunctionCall") return getPriorityForFunctionCallTransaction(action, receiverAccountId);
    if (actions?.length === 1 && actions[0].actionType === "FunctionCall") return getPriorityForFunctionCallTransaction(actions[0], receiverAccountId);
    return [{ accessType: "FullAccess" }];
  };
  const createAddExecuteTransactionTask = (taskQueueContext) => async (transactionIntent) => {
    const { keyPool, tasker } = taskQueueContext.signerContext;
    const task = {
      taskType: "ExecuteTransaction",
      taskId: crypto.randomUUID(),
      accessTypePriority: getAccessTypePriority(transactionIntent),
      transactionIntent
    };
    const canHandle = await keyPool.isKeyForTaskExist(task);
    if (!canHandle.ok) return canHandle;
    addTask(task, taskQueueContext);
    return await tasker.waitForTask(task.taskId);
  };
  const createAddSignTransactionTask = (taskQueueContext) => async (transactionIntent) => {
    const { keyPool, tasker } = taskQueueContext.signerContext;
    const task = {
      taskType: "SignTransaction",
      taskId: crypto.randomUUID(),
      accessTypePriority: getAccessTypePriority(transactionIntent),
      transactionIntent
    };
    const canHandle = await keyPool.isKeyForTaskExist(task);
    if (!canHandle.ok) return canHandle;
    addTask(task, taskQueueContext);
    return await tasker.waitForTask(task.taskId);
  };
  const createTaskQueue = (signerContext, createMemorySignerArgs) => {
    const taskQueueContext = {
      queue: [],
      cleaners: {},
      signerContext,
      timeoutMs: createMemorySignerArgs.taskQueue?.timeoutMs ?? 6e4
    };
    const removeTask = (taskId) => {
      taskQueueContext.queue = taskQueueContext.queue.filter((task) => task.taskId !== taskId);
      clearTimeout(taskQueueContext.cleaners[taskId]);
      delete taskQueueContext.cleaners[taskId];
    };
    return {
      addSignTransactionTask: createAddSignTransactionTask(taskQueueContext),
      addExecuteTransactionTask: createAddExecuteTransactionTask(taskQueueContext),
      findTaskForKey: createFindTaskForKey(taskQueueContext),
      removeTask
    };
  };
  const CreateMemorySignerArgsSchema = /* @__PURE__ */ object({
    signerAccountId: AccountIdZodSchema,
    client: /* @__PURE__ */ custom((value) => isClient(value)),
    keyService: /* @__PURE__ */ custom((value) => true),
    keyPool: /* @__PURE__ */ optional(/* @__PURE__ */ object({ allowedAccessKeys: /* @__PURE__ */ optional((/* @__PURE__ */ array(PublicKeyZodSchema)).check(/* @__PURE__ */ _minLength(1))) })),
    taskQueue: /* @__PURE__ */ optional(/* @__PURE__ */ object({ timeoutMs: /* @__PURE__ */ optional((/* @__PURE__ */ number()).check(/* @__PURE__ */ _nonnegative())) }))
  });
  const safeCreateMemorySigner = wrapInternalError("CreateMemorySigner.Internal", (args) => {
    const validArgs = CreateMemorySignerArgsSchema.safeParse(args);
    if (!validArgs.success) return result.err(createNatError({
      kind: "CreateMemorySigner.Args.InvalidSchema",
      context: { zodError: validArgs.error }
    }));
    const { signerAccountId, client, keyService } = validArgs.data;
    const context = {
      signerAccountId,
      client,
      keyService
    };
    context.keyPool = createKeyPool(context, args);
    context.taskQueue = createTaskQueue(context, args);
    context.tasker = createTasker(context);
    const safeSignTransaction2 = createSafeSignTransaction(context);
    const safeExecuteTransaction = createSafeExecuteTransaction(context);
    return result.ok({
      signerAccountId,
      keyService,
      client,
      signTransaction: asThrowable(safeSignTransaction2),
      executeTransaction: asThrowable(safeExecuteTransaction),
      safeSignTransaction: safeSignTransaction2,
      safeExecuteTransaction
    });
  });
  const throwableCreateMemorySigner = asThrowable(safeCreateMemorySigner);
  class BorshWriter {
    chunks = [];
    writeU8(value) {
      this.chunks.push(value & 255);
      return this;
    }
    writeBool(value) {
      return this.writeU8(value ? 1 : 0);
    }
    writeU16(value) {
      this.chunks.push(value & 255, value >>> 8 & 255);
      return this;
    }
    writeU32(value) {
      this.chunks.push(
        value & 255,
        value >>> 8 & 255,
        value >>> 16 & 255,
        value >>> 24 & 255
      );
      return this;
    }
    writeU64(value) {
      let v = BigInt.asUintN(64, value);
      for (let i = 0; i < 8; i++) {
        this.chunks.push(Number(v & 0xffn));
        v >>= 8n;
      }
      return this;
    }
    writeU128(value) {
      let v = BigInt.asUintN(128, value);
      for (let i = 0; i < 16; i++) {
        this.chunks.push(Number(v & 0xffn));
        v >>= 8n;
      }
      return this;
    }
    writeString(value) {
      return this.writeBytes(new TextEncoder().encode(value));
    }
    /** Vec<u8>: u32 length prefix + raw bytes. */
    writeBytes(value) {
      this.writeU32(value.length);
      return this.writeFixedBytes(value);
    }
    /** [u8; N] / pre-serialized payload: raw bytes, no prefix. */
    writeFixedBytes(value) {
      for (const b of value) this.chunks.push(b & 255);
      return this;
    }
    writeOption(value, write) {
      if (value == null) {
        this.writeU8(0);
      } else {
        this.writeU8(1);
        write(value);
      }
      return this;
    }
    writeVec(items, write) {
      this.writeU32(items.length);
      for (const item of items) write(item);
      return this;
    }
    toBytes() {
      return new Uint8Array(this.chunks);
    }
  }
  function concatBytes$1(...arrays) {
    const total = arrays.reduce((sum, a) => sum + a.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const a of arrays) {
      out.set(a, offset);
      offset += a.length;
    }
    return out;
  }
  function compareBytes(a, b) {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const av = a[i];
      const bv = b[i];
      if (av !== bv) return av - bv;
    }
    return a.length - b.length;
  }
  const FACTORY_IDS = {
    p256: "p256-passkey-wallet-contract.trezu.near",
    ed25519: "ed25519-passkey-wallet-contract.trezu.near"
  };
  const REGISTRY_ID = "passkeys-registry.near";
  const REGISTRY_FC_PRIVATE_KEY = "ed25519:3eDM1nB2hVs8mYminjBuBSxr7d4Gmd2JaAJhtmviVDQRm1zPGC7TxXoEwQsR9JBxDH3ax1U5RnfiAP3n4CZCfHXf";
  const SPONSOR_ACCOUNT_ID = "";
  const DEFAULT_TIMEOUT_SECS = 3600;
  const AUTH_DOMAIN = "NEAR_WALLET_CONTRACT_AUTH/V1";
  const REQUEST_DOMAIN = "NEAR_WALLET_CONTRACT/V1";
  const CHAIN_ID = "mainnet";
  const STORAGE_ACTIVE = "passkey:v1";
  const STORAGE_KNOWN = "passkey:known";
  const STORAGE_PENDING_REGISTRATION = "passkey:pendingRegistration";
  const STORAGE_NONCE = "passkey:nonce";
  const _0n$6 = BigInt(0);
  const _1n$6 = BigInt(1);
  const _2n$4 = BigInt(2);
  const _7n$1 = BigInt(7);
  const _256n = BigInt(256);
  const _0x71n = BigInt(113);
  const SHA3_PI = [];
  const SHA3_ROTL = [];
  const _SHA3_IOTA = [];
  for (let round = 0, R = _1n$6, x = 1, y = 0; round < 24; round++) {
    [x, y] = [y, (2 * x + 3 * y) % 5];
    SHA3_PI.push(2 * (5 * y + x));
    SHA3_ROTL.push((round + 1) * (round + 2) / 2 % 64);
    let t = _0n$6;
    for (let j = 0; j < 7; j++) {
      R = (R << _1n$6 ^ (R >> _7n$1) * _0x71n) % _256n;
      if (R & _2n$4)
        t ^= _1n$6 << (_1n$6 << BigInt(j)) - _1n$6;
    }
    _SHA3_IOTA.push(t);
  }
  const IOTAS = split(_SHA3_IOTA, true);
  const SHA3_IOTA_H = IOTAS[0];
  const SHA3_IOTA_L = IOTAS[1];
  const rotlH = (h2, l, s) => s > 32 ? rotlBH(h2, l, s) : rotlSH(h2, l, s);
  const rotlL = (h2, l, s) => s > 32 ? rotlBL(h2, l, s) : rotlSL(h2, l, s);
  function keccakP(s, rounds = 24) {
    anumber$1(rounds, "rounds");
    if (rounds < 1 || rounds > 24)
      throw new Error('"rounds" expected integer 1..24');
    const B = new Uint32Array(5 * 2);
    for (let round = 24 - rounds; round < 24; round++) {
      for (let x = 0; x < 10; x++)
        B[x] = s[x] ^ s[x + 10] ^ s[x + 20] ^ s[x + 30] ^ s[x + 40];
      for (let x = 0; x < 10; x += 2) {
        const idx1 = (x + 8) % 10;
        const idx0 = (x + 2) % 10;
        const B0 = B[idx0];
        const B1 = B[idx0 + 1];
        const Th = rotlH(B0, B1, 1) ^ B[idx1];
        const Tl = rotlL(B0, B1, 1) ^ B[idx1 + 1];
        for (let y = 0; y < 50; y += 10) {
          s[x + y] ^= Th;
          s[x + y + 1] ^= Tl;
        }
      }
      let curH = s[2];
      let curL = s[3];
      for (let t = 0; t < 24; t++) {
        const shift = SHA3_ROTL[t];
        const Th = rotlH(curH, curL, shift);
        const Tl = rotlL(curH, curL, shift);
        const PI = SHA3_PI[t];
        curH = s[PI];
        curL = s[PI + 1];
        s[PI] = Th;
        s[PI + 1] = Tl;
      }
      for (let y = 0; y < 50; y += 10) {
        const b0 = s[y], b1 = s[y + 1], b2 = s[y + 2], b3 = s[y + 3];
        s[y] ^= ~s[y + 2] & s[y + 4];
        s[y + 1] ^= ~s[y + 3] & s[y + 5];
        s[y + 2] ^= ~s[y + 4] & s[y + 6];
        s[y + 3] ^= ~s[y + 5] & s[y + 7];
        s[y + 4] ^= ~s[y + 6] & s[y + 8];
        s[y + 5] ^= ~s[y + 7] & s[y + 9];
        s[y + 6] ^= ~s[y + 8] & b0;
        s[y + 7] ^= ~s[y + 9] & b1;
        s[y + 8] ^= ~b0 & b2;
        s[y + 9] ^= ~b1 & b3;
      }
      s[0] ^= SHA3_IOTA_H[round];
      s[1] ^= SHA3_IOTA_L[round];
    }
    clean(B);
  }
  class Keccak {
    state;
    pos = 0;
    posOut = 0;
    finished = false;
    state32;
    destroyed = false;
    blockLen;
    suffix;
    outputLen;
    canXOF;
    enableXOF = false;
    rounds;
    // NOTE: we accept arguments in bytes instead of bits here.
    constructor(blockLen, suffix, outputLen, enableXOF = false, rounds = 24) {
      this.blockLen = blockLen;
      this.suffix = suffix;
      this.outputLen = outputLen;
      this.enableXOF = enableXOF;
      this.canXOF = enableXOF;
      this.rounds = rounds;
      anumber$1(outputLen, "outputLen");
      if (!(0 < blockLen && blockLen < 200))
        throw new Error("only keccak-f1600 function is supported");
      this.state = new Uint8Array(200);
      this.state32 = u32(this.state);
    }
    clone() {
      return this._cloneInto();
    }
    keccak() {
      swap32IfBE(this.state32);
      keccakP(this.state32, this.rounds);
      swap32IfBE(this.state32);
      this.posOut = 0;
      this.pos = 0;
    }
    update(data) {
      aexists(this);
      abytes$2(data);
      const { blockLen, state } = this;
      const len = data.length;
      for (let pos = 0; pos < len; ) {
        const take = Math.min(blockLen - this.pos, len - pos);
        for (let i = 0; i < take; i++)
          state[this.pos++] ^= data[pos++];
        if (this.pos === blockLen)
          this.keccak();
      }
      return this;
    }
    finish() {
      if (this.finished)
        return;
      this.finished = true;
      const { state, suffix, pos, blockLen } = this;
      state[pos] ^= suffix;
      if ((suffix & 128) !== 0 && pos === blockLen - 1)
        this.keccak();
      state[blockLen - 1] ^= 128;
      this.keccak();
    }
    writeInto(out) {
      aexists(this, false);
      abytes$2(out);
      this.finish();
      const bufferOut = this.state;
      const { blockLen } = this;
      for (let pos = 0, len = out.length; pos < len; ) {
        if (this.posOut >= blockLen)
          this.keccak();
        const take = Math.min(blockLen - this.posOut, len - pos);
        out.set(bufferOut.subarray(this.posOut, this.posOut + take), pos);
        this.posOut += take;
        pos += take;
      }
      return out;
    }
    xofInto(out) {
      if (!this.enableXOF)
        throw new Error("XOF is not possible for this instance");
      return this.writeInto(out);
    }
    xof(bytes) {
      anumber$1(bytes);
      return this.xofInto(new Uint8Array(bytes));
    }
    digestInto(out) {
      aoutput(out, this);
      if (this.finished)
        throw new Error("digest() was already called");
      this.writeInto(out.subarray(0, this.outputLen));
      this.destroy();
    }
    digest() {
      const out = new Uint8Array(this.outputLen);
      this.digestInto(out);
      return out;
    }
    destroy() {
      this.destroyed = true;
      clean(this.state);
    }
    _cloneInto(to) {
      const { blockLen, suffix, outputLen, rounds, enableXOF } = this;
      to ||= new Keccak(blockLen, suffix, outputLen, enableXOF, rounds);
      to.blockLen = blockLen;
      to.state32.set(this.state32);
      to.pos = this.pos;
      to.posOut = this.posOut;
      to.finished = this.finished;
      to.rounds = rounds;
      to.suffix = suffix;
      to.outputLen = outputLen;
      to.enableXOF = enableXOF;
      to.canXOF = this.canXOF;
      to.destroyed = this.destroyed;
      return to;
    }
  }
  const genKeccak = (suffix, blockLen, outputLen, info = {}) => createHasher(() => new Keccak(blockLen, suffix, outputLen), info);
  const sha3_256 = /* @__PURE__ */ genKeccak(
    6,
    136,
    32,
    /* @__PURE__ */ oidNist(8)
  );
  const keccak_256 = /* @__PURE__ */ genKeccak(1, 136, 32);
  const RFC3339_RE = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?([Zz]|[+-]\d{2}:\d{2})$/;
  function rfc3339ToNanos(value) {
    const m = RFC3339_RE.exec(value);
    if (!m) throw new Error(`invalid RFC-3339 timestamp: ${value}`);
    const [, y, mo, d, h2, mi, s, frac, offset] = m;
    const utcMs = Date.UTC(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h2),
      Number(mi),
      Number(s)
    );
    let nanos = BigInt(utcMs) * 1000000n;
    if (frac) {
      nanos += BigInt(frac.slice(1).padEnd(9, "0"));
    }
    if (offset && offset.toUpperCase() !== "Z") {
      const sign2 = offset.startsWith("-") ? -1n : 1n;
      const [oh, om] = offset.slice(1).split(":");
      nanos -= sign2 * (BigInt(oh ?? "0") * 3600n + BigInt(om ?? "0") * 60n) * 1000000000n;
    }
    return nanos;
  }
  function nanosToRfc3339(nanos) {
    const seconds = nanos / 1000000000n;
    const frac = nanos % 1000000000n;
    const base = new Date(Number(seconds) * 1e3).toISOString().slice(0, 19);
    if (frac === 0n) return `${base}Z`;
    const fracStr = frac.toString().padStart(9, "0").replace(/0+$/, "");
    return `${base}.${fracStr}Z`;
  }
  function writeCodeId(w, code) {
    if ("hash" in code) {
      const bytes = base58.decode(code.hash);
      if (bytes.length !== 32) throw new Error("CodeId hash must be 32 bytes");
      w.writeU8(0).writeFixedBytes(bytes);
    } else {
      w.writeU8(1).writeString(code.account_id);
    }
  }
  function writeAuthSignerBinding(w, signer) {
    if (signer.type === "signer_id") {
      w.writeU8(0).writeString(signer.signer_id);
      return;
    }
    w.writeU8(1);
    w.writeBool(signer.signature_enabled);
    w.writeU32(signer.subwallet_id);
    w.writeU32(signer.timeout_secs);
    w.writeVec([...signer.extensions].sort(), (ext) => w.writeString(ext));
  }
  function serializeAuthMessage(msg) {
    const w = new BorshWriter();
    w.writeString(msg.chain_id);
    writeAuthSignerBinding(w, msg.signer);
    w.writeString(msg.purpose);
    w.writeString(msg.recipient);
    w.writeString(msg.payload);
    w.writeU64(rfc3339ToNanos(msg.created_at));
    w.writeU32(msg.timeout_secs);
    return w.toBytes();
  }
  function authMessageHash(msg) {
    return sha3_256(
      concatBytes$1(new TextEncoder().encode(AUTH_DOMAIN), serializeAuthMessage(msg))
    );
  }
  function writeWalletOp(w, op) {
    switch (op.op) {
      case "set_signature_mode":
        w.writeU8(0).writeBool(op.payload.enable);
        break;
      case "add_extension":
        w.writeU8(1).writeString(op.payload.account_id);
        break;
      case "remove_extension":
        w.writeU8(2).writeString(op.payload.account_id);
        break;
    }
  }
  function serializeStateInitJson(stateInit) {
    const w = new BorshWriter();
    w.writeU8(0);
    writeCodeId(w, stateInit.V1.code);
    const entries = Object.entries(stateInit.V1.data).map(([k, v]) => [base64.decode(k), base64.decode(v)]).sort((a, b) => compareBytes(a[0], b[0]));
    w.writeVec(entries, ([key, value]) => {
      w.writeBytes(key);
      w.writeBytes(value);
    });
    return w.toBytes();
  }
  function writeNearAction(w, action) {
    switch (action.action) {
      case "function_call": {
        const p = action.payload;
        w.writeU8(2);
        w.writeString(p.function_name);
        w.writeBytes(p.args ? base64.decode(p.args) : new Uint8Array(0));
        w.writeU128(BigInt(p.deposit ?? "0"));
        w.writeU64(BigInt(p.gas ?? "0"));
        w.writeU64(BigInt(p.gas_weight ?? "1"));
        break;
      }
      case "transfer":
        w.writeU8(3).writeU128(BigInt(action.payload.amount));
        break;
      case "deterministic_state_init":
        w.writeU8(11);
        w.writeFixedBytes(serializeStateInitJson(action.payload.state_init));
        w.writeU128(BigInt(action.payload.deposit ?? "0"));
        break;
    }
  }
  function writeNearPromise(w, promise) {
    w.writeString(promise.receiver_id);
    w.writeOption(promise.refund_to, (r) => w.writeString(r));
    w.writeVec(promise.actions, (a) => writeNearAction(w, a));
  }
  function writeRequest(w, request) {
    w.writeVec(request.internal ?? [], (op) => writeWalletOp(w, op));
    w.writeVec(request.external ?? [], (p) => writeNearPromise(w, p));
  }
  function serializeRequestMessage(msg) {
    const w = new BorshWriter();
    w.writeString(msg.chain_id);
    w.writeString(msg.signer_id);
    w.writeU32(msg.nonce);
    w.writeU64(rfc3339ToNanos(msg.created_at));
    w.writeU32(msg.timeout_secs);
    writeRequest(w, msg.request);
    return w.toBytes();
  }
  function requestMessageHash(msg) {
    return sha3_256(
      concatBytes$1(new TextEncoder().encode(REQUEST_DOMAIN), serializeRequestMessage(msg))
    );
  }
  function authMessageToWireJson(msg) {
    const signer = msg.signer.type === "signer_id" ? { type: "signer_id", signer_id: msg.signer.signer_id } : {
      type: "code",
      signature_enabled: msg.signer.signature_enabled,
      subwallet_id: msg.signer.subwallet_id,
      timeout_secs: msg.signer.timeout_secs,
      extensions: [...msg.signer.extensions].sort()
    };
    return {
      chain_id: msg.chain_id,
      signer,
      purpose: msg.purpose,
      recipient: msg.recipient,
      payload: msg.payload,
      created_at: nanosToRfc3339(rfc3339ToNanos(msg.created_at)),
      timeout_secs: msg.timeout_secs
    };
  }
  function createdAtNow() {
    const seconds = Math.floor(Date.now() / 1e3) - 60;
    return nanosToRfc3339(BigInt(seconds) * 1000000000n);
  }
  function buildRequestMessage(signerId, nonce, request) {
    return {
      chain_id: CHAIN_ID,
      signer_id: signerId,
      nonce,
      created_at: createdAtNow(),
      timeout_secs: DEFAULT_TIMEOUT_SECS,
      request
    };
  }
  function connectorActionsToPromises(transactions) {
    return transactions.map((tx) => ({
      receiver_id: tx.receiverId,
      actions: tx.actions.map(connectorActionToNearAction)
    }));
  }
  function connectorActionToNearAction(action) {
    switch (action.type) {
      case "FunctionCall": {
        const args = base64.encode(
          new TextEncoder().encode(JSON.stringify(action.params.args))
        );
        const payload = {
          function_name: action.params.methodName
        };
        if (args.length > 0 && action.params.args != null) payload.args = args;
        if (action.params.deposit !== "0") payload.deposit = action.params.deposit;
        if (action.params.gas !== "0") payload.gas = action.params.gas;
        return { action: "function_call", payload };
      }
      case "Transfer":
        return { action: "transfer", payload: { amount: action.params.deposit } };
      default:
        throw new Error(
          `Action type "${action.type}" is not supported by the passkey wallet contract. Only FunctionCall and Transfer are supported.`
        );
    }
  }
  const DEFAULT_WALLET_CONFIG = {
    signature_enabled: true,
    subwallet_id: 0,
    timeout_secs: DEFAULT_TIMEOUT_SECS,
    extensions: []
  };
  function buildAuthMessage(args) {
    return {
      chain_id: CHAIN_ID,
      signer: {
        type: "code",
        signature_enabled: args.config.signature_enabled,
        subwallet_id: args.config.subwallet_id,
        timeout_secs: args.config.timeout_secs,
        extensions: [...args.config.extensions].sort()
      },
      purpose: args.purpose,
      recipient: args.recipient,
      payload: args.payload,
      created_at: createdAtNow(),
      timeout_secs: DEFAULT_TIMEOUT_SECS
    };
  }
  function buildAuthorizationBlob(message, proof) {
    return JSON.stringify({ message: authMessageToWireJson(message), proof });
  }
  async function registryGet(client, rawIdB64) {
    const { result: result2 } = await client.callContractReadFunction({
      contractAccountId: REGISTRY_ID,
      functionName: "get",
      functionArgs: { passkey_raw_id: rawIdB64 }
    });
    return Array.isArray(result2) ? result2.filter((k) => typeof k === "string") : [];
  }
  const REGISTER_ATTEMPTS = 3;
  const BACKOFF_BASE_MS = 1e3;
  async function registryRegister(client, rawIdB64, publicKey) {
    const signer = throwableCreateMemorySigner({
      signerAccountId: REGISTRY_ID,
      client,
      keyService: throwableCreateMemoryKeyService({
        keySource: { privateKey: REGISTRY_FC_PRIVATE_KEY }
      })
    });
    let lastError;
    for (let attempt = 0; attempt < REGISTER_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, BACKOFF_BASE_MS * 2 ** (attempt - 1)));
      }
      try {
        await signer.executeTransaction({
          intent: {
            receiverAccountId: REGISTRY_ID,
            action: throwableFunctionCall({
              functionName: "register",
              functionArgs: { passkey_raw_id: rawIdB64, passkey_public_key: publicKey },
              gasLimit: { teraGas: "15" }
            })
          }
        });
        return;
      } catch (e) {
        lastError = e;
      }
    }
    throw new Error(
      `Passkey registration failed after ${REGISTER_ATTEMPTS} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`
    );
  }
  function serializeFunctionCallAction(methodName, argsJson, gas, deposit) {
    const w = new BorshWriter();
    w.writeU8(2);
    w.writeString(methodName);
    w.writeBytes(new TextEncoder().encode(JSON.stringify(argsJson)));
    w.writeU64(gas);
    w.writeU128(deposit);
    return w.toBytes();
  }
  function serializeDeterministicStateInitAction(stateInitBorsh, deposit) {
    const w = new BorshWriter();
    w.writeU8(11);
    w.writeFixedBytes(stateInitBorsh);
    w.writeU128(deposit);
    return w.toBytes();
  }
  function serializeTransaction(args) {
    const w = new BorshWriter();
    w.writeString(args.signerId);
    w.writeU8(0);
    w.writeFixedBytes(args.publicKey);
    w.writeU64(args.nonce);
    w.writeString(args.receiverId);
    w.writeFixedBytes(args.blockHash);
    w.writeU32(args.actions.length);
    for (const action of args.actions) w.writeFixedBytes(action);
    return w.toBytes();
  }
  function serializeSignedTransaction(transactionBytes, signature) {
    const w = new BorshWriter();
    w.writeFixedBytes(transactionBytes);
    w.writeU8(0);
    w.writeFixedBytes(signature);
    return w.toBytes();
  }
  function transactionHash(transactionBytes) {
    return sha256(transactionBytes);
  }
  async function jsonRpc(rpcUrl2, method, params) {
    const response = await fetch(rpcUrl2, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "passkey-executor", method, params })
    });
    if (!response.ok) {
      throw new Error(`RPC ${method} failed: HTTP ${response.status}`);
    }
    const body = await response.json();
    if (body.error) {
      throw new Error(`RPC ${method} failed: ${JSON.stringify(body.error)}`);
    }
    return body.result;
  }
  async function sendRawTransaction(rpcUrl2, signedTransactionBytes) {
    const signedTxBase64 = base64.encode(signedTransactionBytes);
    try {
      return await jsonRpc(rpcUrl2, "send_tx", {
        signed_tx_base64: signedTxBase64,
        wait_until: "EXECUTED_OPTIMISTIC"
      });
    } catch (e) {
      if (e instanceof Error && /METHOD_NOT_FOUND|Method not found/i.test(e.message)) {
        return await jsonRpc(rpcUrl2, "broadcast_tx_commit", [signedTxBase64]);
      }
      throw e;
    }
  }
  function assertOutcomeSuccess(outcome) {
    const status = outcome?.status;
    if (status && typeof status === "object" && "Failure" in status) {
      throw new Error(`transaction failed: ${JSON.stringify(status)}`);
    }
  }
  const EXECUTE_GAS = 300000000000000n;
  const EXECUTE_DEPOSIT = 1n;
  function sponsorKeyPair() {
    {
      throw new Error(
        "Sponsor relayer is not configured (SPONSOR_ACCOUNT_ID / SPONSOR_PRIVATE_KEY are empty in constants.ts). Fill in a dedicated LOW-VALUE relayer account before shipping this executor."
      );
    }
  }
  async function signAndSendSponsored(client, rpcUrl2, receiverId, rawActions) {
    const sponsor = sponsorKeyPair();
    const [blockHashB58, accessKey] = await Promise.all([
      client.getRecentBlockHash(),
      client.getAccountAccessKey({
        accountId: SPONSOR_ACCOUNT_ID,
        publicKey: sponsor.publicKey
      })
    ]);
    const txBytes = serializeTransaction({
      signerId: SPONSOR_ACCOUNT_ID,
      publicKey: sponsor.publicKeyU8,
      nonce: BigInt(accessKey.accountAccessKey.nonce) + 1n,
      receiverId,
      blockHash: base58.decode(blockHashB58),
      actions: rawActions
    });
    const { signatureU8 } = await sponsor.signData({ dataU8: transactionHash(txBytes) });
    const outcome = await sendRawTransaction(
      rpcUrl2,
      serializeSignedTransaction(txBytes, signatureU8)
    );
    assertOutcomeSuccess(outcome);
    return outcome;
  }
  async function relayExecuteSigned(client, rpcUrl2, walletAccountId, msg, proof, stateInitBorsh) {
    const rawActions = [];
    if (stateInitBorsh) {
      rawActions.push(serializeDeterministicStateInitAction(stateInitBorsh, 0n));
    }
    rawActions.push(
      serializeFunctionCallAction("w_execute_signed", { msg, proof }, EXECUTE_GAS, EXECUTE_DEPOSIT)
    );
    return signAndSendSponsored(client, rpcUrl2, walletAccountId, rawActions);
  }
  async function relayStateInit(client, rpcUrl2, walletAccountId, stateInitBorsh) {
    return signAndSendSponsored(client, rpcUrl2, walletAccountId, [
      serializeDeterministicStateInitAction(stateInitBorsh, 0n)
    ]);
  }
  function publicKeyToString(key) {
    return `${key.curve}:${base58.encode(key.bytes)}`;
  }
  function publicKeyFromString(value) {
    if (value.startsWith("p256:")) {
      const bytes = base58.decode(value.slice(5));
      if (bytes.length !== 33 || !(bytes[0] === 2 || bytes[0] === 3)) {
        throw new Error("invalid p256 public key");
      }
      return { curve: "p256", bytes };
    }
    if (value.startsWith("ed25519:")) {
      const bytes = base58.decode(value.slice(8));
      if (bytes.length !== 32) throw new Error("invalid ed25519 public key");
      return { curve: "ed25519", bytes };
    }
    throw new Error(`unsupported public key: ${value}`);
  }
  function serializeDefaultWalletState(publicKey) {
    const w = new BorshWriter();
    w.writeBool(true);
    w.writeU32(0);
    w.writeFixedBytes(publicKey.bytes);
    w.writeU32(DEFAULT_TIMEOUT_SECS);
    w.writeU64(0n);
    w.writeU32(0);
    w.writeU32(0);
    w.writeU32(0);
    return w.toBytes();
  }
  function serializeStateInit(code, data) {
    const w = new BorshWriter();
    w.writeU8(0);
    if ("hash" in code) {
      const bytes = base58.decode(code.hash);
      if (bytes.length !== 32) throw new Error("CodeId hash must be 32 bytes");
      w.writeU8(0).writeFixedBytes(bytes);
    } else {
      w.writeU8(1).writeString(code.account_id);
    }
    const sorted = [...data].sort((a, b) => compareBytes(a[0], b[0]));
    w.writeVec(sorted, ([key, value]) => {
      w.writeBytes(key);
      w.writeBytes(value);
    });
    return w.toBytes();
  }
  function serializeDefaultStateInit(publicKey) {
    return serializeStateInit({ account_id: FACTORY_IDS[publicKey.curve] }, [
      [new Uint8Array(0), serializeDefaultWalletState(publicKey)]
    ]);
  }
  function deriveAccountIdFromStateInit(stateInitBorsh) {
    const hash = keccak_256(stateInitBorsh);
    return `0s${hex.encode(hash.slice(12, 32))}`;
  }
  function deriveAccountId(publicKey) {
    return deriveAccountIdFromStateInit(serializeDefaultStateInit(publicKey));
  }
  function selector() {
    return window.selector;
  }
  async function getJson(key) {
    const raw = await selector().storage.get(key);
    if (raw == null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  async function setJson(key, value) {
    await selector().storage.set(key, JSON.stringify(value));
  }
  const getActiveCredential = () => getJson(STORAGE_ACTIVE);
  const setActiveCredential = (credential) => setJson(STORAGE_ACTIVE, credential);
  const clearActiveCredential = () => selector().storage.remove(STORAGE_ACTIVE);
  const getKnownCredentials = async () => await getJson(STORAGE_KNOWN) ?? {};
  async function addKnownCredential(rawIdB64, credential) {
    const known = await getKnownCredentials();
    known[rawIdB64] = credential;
    await setJson(STORAGE_KNOWN, known);
  }
  const getPendingRegistration = () => getJson(STORAGE_PENDING_REGISTRATION);
  const setPendingRegistration = (pending) => setJson(STORAGE_PENDING_REGISTRATION, pending);
  const clearPendingRegistration = () => selector().storage.remove(STORAGE_PENDING_REGISTRATION);
  async function nextNonce() {
    let nonce = await getJson(STORAGE_NONCE) ?? 0;
    if (!Number.isInteger(nonce) || nonce <= 0 || nonce > 4294967295 || (nonce & 31) === 0) {
      const random = new Uint32Array(1);
      crypto.getRandomValues(random);
      nonce = (random[0] & -32) >>> 0;
      if (nonce === 0) nonce = 32;
    }
    await setJson(STORAGE_NONCE, nonce + 1 >>> 0);
    return nonce;
  }
  const SECONDARY_BUTTON_STYLE = "background-color:#1a1a1a;margin-top:8px;";
  const INPUT_STYLE = "margin-top:16px;padding:12px;border-radius:12px;border:1px solid #444;background:#131313;color:#fff;font-size:14px;width:240px;outline:none;text-align:center;";
  const ERROR_STYLE = "color:#ff8a80;font-size:14px;margin-top:8px;";
  function root() {
    const el = document.getElementById("root");
    if (!el) throw new Error("sandbox #root element missing");
    return el;
  }
  async function openDialog(html) {
    const el = root();
    el.innerHTML = `<div class="prompt-container">${html}</div>`;
    el.style.display = "flex";
    await selector().ui.showIframe();
    return el;
  }
  async function closeDialog() {
    const el = root();
    el.innerHTML = "";
    el.style.display = "none";
    await selector().ui.hideIframe();
  }
  async function promptSignInChoice() {
    const el = await openDialog(`
    <h1>Passkey Wallet</h1>
    <p>Sign in with a passkey — no seed phrase, no extension</p>
    <button id="pk-existing">Use existing passkey</button>
    <button id="pk-create" style="${SECONDARY_BUTTON_STYLE}">Create new passkey</button>
  `);
    return new Promise((resolve, reject) => {
      el.querySelector("#pk-existing")?.addEventListener("click", async () => {
        await closeDialog();
        resolve("existing");
      });
      el.querySelector("#pk-create")?.addEventListener("click", async () => {
        await closeDialog();
        resolve("create");
      });
    });
  }
  async function promptPasskeyName() {
    const el = await openDialog(`
    <h1>Name your passkey</h1>
    <p>Shown in your device's passkey manager</p>
    <input id="pk-name" style="${INPUT_STYLE}" placeholder="NEAR Passkey" maxlength="64" />
    <button id="pk-continue">Create passkey</button>
  `);
    return new Promise((resolve) => {
      const submit = async () => {
        const input = el.querySelector("#pk-name");
        const name = input?.value.trim() || "NEAR Passkey";
        await closeDialog();
        resolve(name);
      };
      el.querySelector("#pk-continue")?.addEventListener("click", submit);
      el.querySelector("#pk-name")?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") void submit();
      });
      el.querySelector("#pk-name")?.focus();
    });
  }
  async function promptRetryRegistration(message) {
    const el = await openDialog(`
    <h1>Registration failed</h1>
    <p>${escapeHtml(message)}</p>
    <p style="${ERROR_STYLE}">Your passkey was created but is not registered yet. Without registration it cannot be recovered on other devices.</p>
    <button id="pk-retry">Retry</button>
    <button id="pk-cancel" style="${SECONDARY_BUTTON_STYLE}">Cancel</button>
  `);
    return new Promise((resolve) => {
      el.querySelector("#pk-retry")?.addEventListener("click", async () => {
        await closeDialog();
        resolve(true);
      });
      el.querySelector("#pk-cancel")?.addEventListener("click", async () => {
        await closeDialog();
        resolve(false);
      });
    });
  }
  async function showErrorDialog(title, message) {
    const el = await openDialog(`
    <h1>${escapeHtml(title)}</h1>
    <p style="${ERROR_STYLE}">${escapeHtml(message)}</p>
    <button id="pk-close">Close</button>
  `);
    return new Promise((resolve) => {
      el.querySelector("#pk-close")?.addEventListener("click", async () => {
        await closeDialog();
        resolve();
      });
    });
  }
  function escapeHtml(value) {
    return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  }
  const abytes = (value, length, title) => abytes$2(value, length, title);
  const anumber = anumber$1;
  const bytesToHex = bytesToHex$2;
  const concatBytes = (...arrays) => concatBytes$3(...arrays);
  const hexToBytes = (hex2) => hexToBytes$2(hex2);
  const isBytes = isBytes$2;
  const randomBytes$1 = (bytesLength) => randomBytes$3(bytesLength);
  const _0n$5 = /* @__PURE__ */ BigInt(0);
  const _1n$5 = /* @__PURE__ */ BigInt(1);
  function abool(value, title = "") {
    if (typeof value !== "boolean") {
      const prefix2 = title && `"${title}" `;
      throw new TypeError(prefix2 + "expected boolean, got type=" + typeof value);
    }
    return value;
  }
  function abignumber(n) {
    if (typeof n === "bigint") {
      if (!isPosBig(n))
        throw new RangeError("positive bigint expected, got " + n);
    } else
      anumber(n);
    return n;
  }
  function asafenumber(value, title = "") {
    if (typeof value !== "number") {
      const prefix2 = title && `"${title}" `;
      throw new TypeError(prefix2 + "expected number, got type=" + typeof value);
    }
    if (!Number.isSafeInteger(value)) {
      const prefix2 = title && `"${title}" `;
      throw new RangeError(prefix2 + "expected safe integer, got " + value);
    }
  }
  function numberToHexUnpadded(num) {
    const hex2 = abignumber(num).toString(16);
    return hex2.length & 1 ? "0" + hex2 : hex2;
  }
  function hexToNumber(hex2) {
    if (typeof hex2 !== "string")
      throw new TypeError("hex string expected, got " + typeof hex2);
    return hex2 === "" ? _0n$5 : BigInt("0x" + hex2);
  }
  function bytesToNumberBE(bytes) {
    return hexToNumber(bytesToHex$2(bytes));
  }
  function bytesToNumberLE(bytes) {
    return hexToNumber(bytesToHex$2(copyBytes(abytes$2(bytes)).reverse()));
  }
  function numberToBytesBE(n, len) {
    anumber$1(len);
    if (len === 0)
      throw new RangeError("zero length");
    n = abignumber(n);
    const hex2 = n.toString(16);
    if (hex2.length > len * 2)
      throw new RangeError("number too large");
    return hexToBytes$2(hex2.padStart(len * 2, "0"));
  }
  function numberToBytesLE(n, len) {
    return numberToBytesBE(n, len).reverse();
  }
  function equalBytes(a, b) {
    a = abytes(a);
    b = abytes(b);
    if (a.length !== b.length)
      return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++)
      diff |= a[i] ^ b[i];
    return diff === 0;
  }
  function copyBytes(bytes) {
    return Uint8Array.from(abytes(bytes));
  }
  const isPosBig = (n) => typeof n === "bigint" && _0n$5 <= n;
  function inRange(n, min, max) {
    return isPosBig(n) && isPosBig(min) && isPosBig(max) && min <= n && n < max;
  }
  function aInRange(title, n, min, max) {
    if (!inRange(n, min, max))
      throw new RangeError("expected valid " + title + ": " + min + " <= n < " + max + ", got " + n);
  }
  function bitLen(n) {
    if (n < _0n$5)
      throw new Error("expected non-negative bigint, got " + n);
    let len;
    for (len = 0; n > _0n$5; n >>= _1n$5, len += 1)
      ;
    return len;
  }
  const bitMask = (n) => (_1n$5 << BigInt(n)) - _1n$5;
  function createHmacDrbg(hashLen, qByteLen, hmacFn) {
    anumber$1(hashLen, "hashLen");
    anumber$1(qByteLen, "qByteLen");
    if (typeof hmacFn !== "function")
      throw new TypeError("hmacFn must be a function");
    const u8n2 = (len) => new Uint8Array(len);
    const NULL2 = Uint8Array.of();
    const byte02 = Uint8Array.of(0);
    const byte12 = Uint8Array.of(1);
    const _maxDrbgIters2 = 1e3;
    let v = u8n2(hashLen);
    let k = u8n2(hashLen);
    let i = 0;
    const reset = () => {
      v.fill(1);
      k.fill(0);
      i = 0;
    };
    const h2 = (...msgs) => hmacFn(k, concatBytes(v, ...msgs));
    const reseed = (seed = NULL2) => {
      k = h2(byte02, seed);
      v = h2();
      if (seed.length === 0)
        return;
      k = h2(byte12, seed);
      v = h2();
    };
    const gen = () => {
      if (i++ >= _maxDrbgIters2)
        throw new Error("drbg: tried max amount of iterations");
      let len = 0;
      const out = [];
      while (len < qByteLen) {
        v = h2();
        const sl = v.slice();
        out.push(sl);
        len += v.length;
      }
      return concatBytes(...out);
    };
    const genUntil = (seed, pred) => {
      reset();
      reseed(seed);
      let res = void 0;
      while ((res = pred(gen())) === void 0)
        reseed();
      reset();
      return res;
    };
    return genUntil;
  }
  function validateObject(object2, fields = {}, optFields = {}) {
    if (Object.prototype.toString.call(object2) !== "[object Object]")
      throw new TypeError("expected valid options object");
    function checkField(fieldName, expectedType, isOpt) {
      if (!isOpt && expectedType !== "function" && !Object.hasOwn(object2, fieldName))
        throw new TypeError(`param "${fieldName}" is invalid: expected own property`);
      const val = object2[fieldName];
      if (isOpt && val === void 0)
        return;
      const current = typeof val;
      if (current !== expectedType || val === null)
        throw new TypeError(`param "${fieldName}" is invalid: expected ${expectedType}, got ${current}`);
    }
    const iter = (f, isOpt) => Object.entries(f).forEach(([k, v]) => checkField(k, v, isOpt));
    iter(fields, false);
    iter(optFields, true);
  }
  const notImplemented = () => {
    throw new Error("not implemented");
  };
  const _0n$4 = /* @__PURE__ */ BigInt(0), _1n$4 = /* @__PURE__ */ BigInt(1), _2n$3 = /* @__PURE__ */ BigInt(2);
  const _3n$1 = /* @__PURE__ */ BigInt(3), _4n$1 = /* @__PURE__ */ BigInt(4), _5n$1 = /* @__PURE__ */ BigInt(5);
  const _7n = /* @__PURE__ */ BigInt(7), _8n$2 = /* @__PURE__ */ BigInt(8), _9n = /* @__PURE__ */ BigInt(9);
  const _16n = /* @__PURE__ */ BigInt(16);
  function mod(a, b) {
    if (b <= _0n$4)
      throw new Error("mod: expected positive modulus, got " + b);
    const result2 = a % b;
    return result2 >= _0n$4 ? result2 : b + result2;
  }
  function pow2(x, power, modulo) {
    if (power < _0n$4)
      throw new Error("pow2: expected non-negative exponent, got " + power);
    let res = x;
    while (power-- > _0n$4) {
      res *= res;
      res %= modulo;
    }
    return res;
  }
  function invert(number2, modulo) {
    if (number2 === _0n$4)
      throw new Error("invert: expected non-zero number");
    if (modulo <= _0n$4)
      throw new Error("invert: expected positive modulus, got " + modulo);
    let a = mod(number2, modulo);
    let b = modulo;
    let x = _0n$4, u = _1n$4;
    while (a !== _0n$4) {
      const q = b / a;
      const r = b - a * q;
      const m = x - u * q;
      b = a, a = r, x = u, u = m;
    }
    const gcd2 = b;
    if (gcd2 !== _1n$4)
      throw new Error("invert: does not exist");
    return mod(x, modulo);
  }
  function assertIsSquare(Fp2, root2, n) {
    const F = Fp2;
    if (!F.eql(F.sqr(root2), n))
      throw new Error("Cannot find square root");
  }
  function sqrt3mod4(Fp2, n) {
    const F = Fp2;
    const p1div4 = (F.ORDER + _1n$4) / _4n$1;
    const root2 = F.pow(n, p1div4);
    assertIsSquare(F, root2, n);
    return root2;
  }
  function sqrt5mod8(Fp2, n) {
    const F = Fp2;
    const p5div8 = (F.ORDER - _5n$1) / _8n$2;
    const n2 = F.mul(n, _2n$3);
    const v = F.pow(n2, p5div8);
    const nv = F.mul(n, v);
    const i = F.mul(F.mul(nv, _2n$3), v);
    const root2 = F.mul(nv, F.sub(i, F.ONE));
    assertIsSquare(F, root2, n);
    return root2;
  }
  function sqrt9mod16(P2) {
    const Fp_ = Field(P2);
    const tn = tonelliShanks(P2);
    const c1 = tn(Fp_, Fp_.neg(Fp_.ONE));
    const c2 = tn(Fp_, c1);
    const c3 = tn(Fp_, Fp_.neg(c1));
    const c4 = (P2 + _7n) / _16n;
    return ((Fp2, n) => {
      const F = Fp2;
      let tv1 = F.pow(n, c4);
      let tv2 = F.mul(tv1, c1);
      const tv3 = F.mul(tv1, c2);
      const tv4 = F.mul(tv1, c3);
      const e1 = F.eql(F.sqr(tv2), n);
      const e2 = F.eql(F.sqr(tv3), n);
      tv1 = F.cmov(tv1, tv2, e1);
      tv2 = F.cmov(tv4, tv3, e2);
      const e3 = F.eql(F.sqr(tv2), n);
      const root2 = F.cmov(tv1, tv2, e3);
      assertIsSquare(F, root2, n);
      return root2;
    });
  }
  function tonelliShanks(P2) {
    if (P2 < _3n$1)
      throw new Error("sqrt is not defined for small field");
    let Q = P2 - _1n$4;
    let S = 0;
    while (Q % _2n$3 === _0n$4) {
      Q /= _2n$3;
      S++;
    }
    let Z = _2n$3;
    const _Fp = Field(P2);
    while (FpLegendre(_Fp, Z) === 1) {
      if (Z++ > 1e3)
        throw new Error("Cannot find square root: probably non-prime P");
    }
    if (S === 1)
      return sqrt3mod4;
    let cc = _Fp.pow(Z, Q);
    const Q1div2 = (Q + _1n$4) / _2n$3;
    return function tonelliSlow(Fp2, n) {
      const F = Fp2;
      if (F.is0(n))
        return n;
      if (FpLegendre(F, n) !== 1)
        throw new Error("Cannot find square root");
      let M2 = S;
      let c = F.mul(F.ONE, cc);
      let t = F.pow(n, Q);
      let R = F.pow(n, Q1div2);
      while (!F.eql(t, F.ONE)) {
        if (F.is0(t))
          return F.ZERO;
        let i = 1;
        let t_tmp = F.sqr(t);
        while (!F.eql(t_tmp, F.ONE)) {
          i++;
          t_tmp = F.sqr(t_tmp);
          if (i === M2)
            throw new Error("Cannot find square root");
        }
        const exponent = _1n$4 << BigInt(M2 - i - 1);
        const b = F.pow(c, exponent);
        M2 = i;
        c = F.sqr(b);
        t = F.mul(t, c);
        R = F.mul(R, b);
      }
      return R;
    };
  }
  function FpSqrt(P2) {
    if (P2 % _4n$1 === _3n$1)
      return sqrt3mod4;
    if (P2 % _8n$2 === _5n$1)
      return sqrt5mod8;
    if (P2 % _16n === _9n)
      return sqrt9mod16(P2);
    return tonelliShanks(P2);
  }
  const isNegativeLE = (num, modulo) => (mod(num, modulo) & _1n$4) === _1n$4;
  const FIELD_FIELDS = [
    "create",
    "isValid",
    "is0",
    "neg",
    "inv",
    "sqrt",
    "sqr",
    "eql",
    "add",
    "sub",
    "mul",
    "pow",
    "div",
    "addN",
    "subN",
    "mulN",
    "sqrN"
  ];
  function validateField(field) {
    const initial = {
      ORDER: "bigint",
      BYTES: "number",
      BITS: "number"
    };
    const opts = FIELD_FIELDS.reduce((map, val) => {
      map[val] = "function";
      return map;
    }, initial);
    validateObject(field, opts);
    asafenumber(field.BYTES, "BYTES");
    asafenumber(field.BITS, "BITS");
    if (field.BYTES < 1 || field.BITS < 1)
      throw new Error("invalid field: expected BYTES/BITS > 0");
    if (field.ORDER <= _1n$4)
      throw new Error("invalid field: expected ORDER > 1, got " + field.ORDER);
    return field;
  }
  function FpPow(Fp2, num, power) {
    const F = Fp2;
    if (power < _0n$4)
      throw new Error("invalid exponent, negatives unsupported");
    if (power === _0n$4)
      return F.ONE;
    if (power === _1n$4)
      return num;
    let p = F.ONE;
    let d = num;
    while (power > _0n$4) {
      if (power & _1n$4)
        p = F.mul(p, d);
      d = F.sqr(d);
      power >>= _1n$4;
    }
    return p;
  }
  function FpInvertBatch(Fp2, nums, passZero = false) {
    const F = Fp2;
    const inverted = new Array(nums.length).fill(passZero ? F.ZERO : void 0);
    const multipliedAcc = nums.reduce((acc, num, i) => {
      if (F.is0(num))
        return acc;
      inverted[i] = acc;
      return F.mul(acc, num);
    }, F.ONE);
    const invertedAcc = F.inv(multipliedAcc);
    nums.reduceRight((acc, num, i) => {
      if (F.is0(num))
        return acc;
      inverted[i] = F.mul(acc, inverted[i]);
      return F.mul(acc, num);
    }, invertedAcc);
    return inverted;
  }
  function FpLegendre(Fp2, n) {
    const F = Fp2;
    const p1mod2 = (F.ORDER - _1n$4) / _2n$3;
    const powered = F.pow(n, p1mod2);
    const yes = F.eql(powered, F.ONE);
    const zero = F.eql(powered, F.ZERO);
    const no = F.eql(powered, F.neg(F.ONE));
    if (!yes && !zero && !no)
      throw new Error("invalid Legendre symbol result");
    return yes ? 1 : zero ? 0 : -1;
  }
  function nLength(n, nBitLength) {
    if (nBitLength !== void 0)
      anumber(nBitLength);
    if (n <= _0n$4)
      throw new Error("invalid n length: expected positive n, got " + n);
    if (nBitLength !== void 0 && nBitLength < 1)
      throw new Error("invalid n length: expected positive bit length, got " + nBitLength);
    const bits = bitLen(n);
    if (nBitLength !== void 0 && nBitLength < bits)
      throw new Error(`invalid n length: expected bit length (${bits}) >= n.length (${nBitLength})`);
    const _nBitLength = nBitLength !== void 0 ? nBitLength : bits;
    const nByteLength = Math.ceil(_nBitLength / 8);
    return { nBitLength: _nBitLength, nByteLength };
  }
  const FIELD_SQRT = /* @__PURE__ */ new WeakMap();
  class _Field {
    ORDER;
    BITS;
    BYTES;
    isLE;
    ZERO = _0n$4;
    ONE = _1n$4;
    _lengths;
    _mod;
    constructor(ORDER, opts = {}) {
      if (ORDER <= _1n$4)
        throw new Error("invalid field: expected ORDER > 1, got " + ORDER);
      let _nbitLength = void 0;
      this.isLE = false;
      if (opts != null && typeof opts === "object") {
        if (typeof opts.BITS === "number")
          _nbitLength = opts.BITS;
        if (typeof opts.sqrt === "function")
          Object.defineProperty(this, "sqrt", { value: opts.sqrt, enumerable: true });
        if (typeof opts.isLE === "boolean")
          this.isLE = opts.isLE;
        if (opts.allowedLengths)
          this._lengths = Object.freeze(opts.allowedLengths.slice());
        if (typeof opts.modFromBytes === "boolean")
          this._mod = opts.modFromBytes;
      }
      const { nBitLength, nByteLength } = nLength(ORDER, _nbitLength);
      if (nByteLength > 2048)
        throw new Error("invalid field: expected ORDER of <= 2048 bytes");
      this.ORDER = ORDER;
      this.BITS = nBitLength;
      this.BYTES = nByteLength;
      Object.freeze(this);
    }
    create(num) {
      return mod(num, this.ORDER);
    }
    isValid(num) {
      if (typeof num !== "bigint")
        throw new TypeError("invalid field element: expected bigint, got " + typeof num);
      return _0n$4 <= num && num < this.ORDER;
    }
    is0(num) {
      return num === _0n$4;
    }
    // is valid and invertible
    isValidNot0(num) {
      return !this.is0(num) && this.isValid(num);
    }
    isOdd(num) {
      return (num & _1n$4) === _1n$4;
    }
    neg(num) {
      return mod(-num, this.ORDER);
    }
    eql(lhs, rhs) {
      return lhs === rhs;
    }
    sqr(num) {
      return mod(num * num, this.ORDER);
    }
    add(lhs, rhs) {
      return mod(lhs + rhs, this.ORDER);
    }
    sub(lhs, rhs) {
      return mod(lhs - rhs, this.ORDER);
    }
    mul(lhs, rhs) {
      return mod(lhs * rhs, this.ORDER);
    }
    pow(num, power) {
      return FpPow(this, num, power);
    }
    div(lhs, rhs) {
      return mod(lhs * invert(rhs, this.ORDER), this.ORDER);
    }
    // Same as above, but doesn't normalize
    sqrN(num) {
      return num * num;
    }
    addN(lhs, rhs) {
      return lhs + rhs;
    }
    subN(lhs, rhs) {
      return lhs - rhs;
    }
    mulN(lhs, rhs) {
      return lhs * rhs;
    }
    inv(num) {
      return invert(num, this.ORDER);
    }
    sqrt(num) {
      let sqrt = FIELD_SQRT.get(this);
      if (!sqrt)
        FIELD_SQRT.set(this, sqrt = FpSqrt(this.ORDER));
      return sqrt(this, num);
    }
    toBytes(num) {
      return this.isLE ? numberToBytesLE(num, this.BYTES) : numberToBytesBE(num, this.BYTES);
    }
    fromBytes(bytes, skipValidation = false) {
      abytes(bytes);
      const { _lengths: allowedLengths, BYTES, isLE: isLE2, ORDER, _mod: modFromBytes } = this;
      if (allowedLengths) {
        if (bytes.length < 1 || !allowedLengths.includes(bytes.length) || bytes.length > BYTES) {
          throw new Error("Field.fromBytes: expected " + allowedLengths + " bytes, got " + bytes.length);
        }
        const padded = new Uint8Array(BYTES);
        padded.set(bytes, isLE2 ? 0 : padded.length - bytes.length);
        bytes = padded;
      }
      if (bytes.length !== BYTES)
        throw new Error("Field.fromBytes: expected " + BYTES + " bytes, got " + bytes.length);
      let scalar = isLE2 ? bytesToNumberLE(bytes) : bytesToNumberBE(bytes);
      if (modFromBytes)
        scalar = mod(scalar, ORDER);
      if (!skipValidation) {
        if (!this.isValid(scalar))
          throw new Error("invalid field element: outside of range 0..ORDER");
      }
      return scalar;
    }
    // TODO: we don't need it here, move out to separate fn
    invertBatch(lst) {
      return FpInvertBatch(this, lst);
    }
    // We can't move this out because Fp6, Fp12 implement it
    // and it's unclear what to return in there.
    cmov(a, b, condition) {
      abool(condition, "condition");
      return condition ? b : a;
    }
  }
  Object.freeze(_Field.prototype);
  function Field(ORDER, opts = {}) {
    return new _Field(ORDER, opts);
  }
  function getFieldBytesLength(fieldOrder) {
    if (typeof fieldOrder !== "bigint")
      throw new Error("field order must be bigint");
    if (fieldOrder <= _1n$4)
      throw new Error("field order must be greater than 1");
    const bitLength = bitLen(fieldOrder - _1n$4);
    return Math.ceil(bitLength / 8);
  }
  function getMinHashLength(fieldOrder) {
    const length = getFieldBytesLength(fieldOrder);
    return length + Math.ceil(length / 2);
  }
  function mapHashToField(key, fieldOrder, isLE2 = false) {
    abytes(key);
    const len = key.length;
    const fieldLen = getFieldBytesLength(fieldOrder);
    const minLen = Math.max(getMinHashLength(fieldOrder), 16);
    if (len < minLen || len > 1024)
      throw new Error("expected " + minLen + "-1024 bytes of input, got " + len);
    const num = isLE2 ? bytesToNumberLE(key) : bytesToNumberBE(key);
    const reduced = mod(num, fieldOrder - _1n$4) + _1n$4;
    return isLE2 ? numberToBytesLE(reduced, fieldLen) : numberToBytesBE(reduced, fieldLen);
  }
  const _0n$3 = /* @__PURE__ */ BigInt(0);
  const _1n$3 = /* @__PURE__ */ BigInt(1);
  function negateCt(condition, item) {
    const neg = item.negate();
    return condition ? neg : item;
  }
  function normalizeZ(c, points) {
    const invertedZs = FpInvertBatch(c.Fp, points.map((p) => p.Z));
    return points.map((p, i) => c.fromAffine(p.toAffine(invertedZs[i])));
  }
  function validateW(W2, bits) {
    if (!Number.isSafeInteger(W2) || W2 <= 0 || W2 > bits)
      throw new Error("invalid window size, expected [1.." + bits + "], got W=" + W2);
  }
  function calcWOpts(W2, scalarBits2) {
    validateW(W2, scalarBits2);
    const windows = Math.ceil(scalarBits2 / W2) + 1;
    const windowSize = 2 ** (W2 - 1);
    const maxNumber = 2 ** W2;
    const mask = bitMask(W2);
    const shiftBy = BigInt(W2);
    return { windows, windowSize, mask, maxNumber, shiftBy };
  }
  function calcOffsets(n, window2, wOpts) {
    const { windowSize, mask, maxNumber, shiftBy } = wOpts;
    let wbits = Number(n & mask);
    let nextN = n >> shiftBy;
    if (wbits > windowSize) {
      wbits -= maxNumber;
      nextN += _1n$3;
    }
    const offsetStart = window2 * windowSize;
    const offset = offsetStart + Math.abs(wbits) - 1;
    const isZero = wbits === 0;
    const isNeg = wbits < 0;
    const isNegF = window2 % 2 !== 0;
    const offsetF = offsetStart;
    return { nextN, offset, isZero, isNeg, isNegF, offsetF };
  }
  const pointPrecomputes = /* @__PURE__ */ new WeakMap();
  const pointWindowSizes = /* @__PURE__ */ new WeakMap();
  function getW(P2) {
    return pointWindowSizes.get(P2) || 1;
  }
  function assert0(n) {
    if (n !== _0n$3)
      throw new Error("invalid wNAF");
  }
  class wNAF {
    BASE;
    ZERO;
    Fn;
    bits;
    // Parametrized with a given Point class (not individual point)
    constructor(Point2, bits) {
      this.BASE = Point2.BASE;
      this.ZERO = Point2.ZERO;
      this.Fn = Point2.Fn;
      this.bits = bits;
    }
    // non-const time multiplication ladder
    _unsafeLadder(elm, n, p = this.ZERO) {
      let d = elm;
      while (n > _0n$3) {
        if (n & _1n$3)
          p = p.add(d);
        d = d.double();
        n >>= _1n$3;
      }
      return p;
    }
    /**
     * Creates a wNAF precomputation window. Used for caching.
     * Default window size is set by `utils.precompute()` and is equal to 8.
     * Number of precomputed points depends on the curve size:
     * 2^(𝑊−1) * (Math.ceil(𝑛 / 𝑊) + 1), where:
     * - 𝑊 is the window size
     * - 𝑛 is the bitlength of the curve order.
     * For a 256-bit curve and window size 8, the number of precomputed points is 128 * 33 = 4224.
     * @param point - Point instance
     * @param W - window size
     * @returns precomputed point tables flattened to a single array
     */
    precomputeWindow(point, W2) {
      const { windows, windowSize } = calcWOpts(W2, this.bits);
      const points = [];
      let p = point;
      let base = p;
      for (let window2 = 0; window2 < windows; window2++) {
        base = p;
        points.push(base);
        for (let i = 1; i < windowSize; i++) {
          base = base.add(p);
          points.push(base);
        }
        p = base.double();
      }
      return points;
    }
    /**
     * Implements ec multiplication using precomputed tables and w-ary non-adjacent form.
     * More compact implementation:
     * https://github.com/paulmillr/noble-secp256k1/blob/47cb1669b6e506ad66b35fe7d76132ae97465da2/index.ts#L502-L541
     * @returns real and fake (for const-time) points
     */
    wNAF(W2, precomputes, n) {
      if (!this.Fn.isValid(n))
        throw new Error("invalid scalar");
      let p = this.ZERO;
      let f = this.BASE;
      const wo = calcWOpts(W2, this.bits);
      for (let window2 = 0; window2 < wo.windows; window2++) {
        const { nextN, offset, isZero, isNeg, isNegF, offsetF } = calcOffsets(n, window2, wo);
        n = nextN;
        if (isZero) {
          f = f.add(negateCt(isNegF, precomputes[offsetF]));
        } else {
          p = p.add(negateCt(isNeg, precomputes[offset]));
        }
      }
      assert0(n);
      return { p, f };
    }
    /**
     * Implements unsafe EC multiplication using precomputed tables
     * and w-ary non-adjacent form.
     * @param acc - accumulator point to add result of multiplication
     * @returns point
     */
    wNAFUnsafe(W2, precomputes, n, acc = this.ZERO) {
      const wo = calcWOpts(W2, this.bits);
      for (let window2 = 0; window2 < wo.windows; window2++) {
        if (n === _0n$3)
          break;
        const { nextN, offset, isZero, isNeg } = calcOffsets(n, window2, wo);
        n = nextN;
        if (isZero) {
          continue;
        } else {
          const item = precomputes[offset];
          acc = acc.add(isNeg ? item.negate() : item);
        }
      }
      assert0(n);
      return acc;
    }
    getPrecomputes(W2, point, transform2) {
      let comp = pointPrecomputes.get(point);
      if (!comp) {
        comp = this.precomputeWindow(point, W2);
        if (W2 !== 1) {
          if (typeof transform2 === "function")
            comp = transform2(comp);
          pointPrecomputes.set(point, comp);
        }
      }
      return comp;
    }
    cached(point, scalar, transform2) {
      const W2 = getW(point);
      return this.wNAF(W2, this.getPrecomputes(W2, point, transform2), scalar);
    }
    unsafe(point, scalar, transform2, prev) {
      const W2 = getW(point);
      if (W2 === 1)
        return this._unsafeLadder(point, scalar, prev);
      return this.wNAFUnsafe(W2, this.getPrecomputes(W2, point, transform2), scalar, prev);
    }
    // We calculate precomputes for elliptic curve point multiplication
    // using windowed method. This specifies window size and
    // stores precomputed values. Usually only base point would be precomputed.
    createCache(P2, W2) {
      validateW(W2, this.bits);
      pointWindowSizes.set(P2, W2);
      pointPrecomputes.delete(P2);
    }
    hasCache(elm) {
      return getW(elm) !== 1;
    }
  }
  function mulEndoUnsafe(Point2, point, k1, k2) {
    let acc = point;
    let p1 = Point2.ZERO;
    let p2 = Point2.ZERO;
    while (k1 > _0n$3 || k2 > _0n$3) {
      if (k1 & _1n$3)
        p1 = p1.add(acc);
      if (k2 & _1n$3)
        p2 = p2.add(acc);
      acc = acc.double();
      k1 >>= _1n$3;
      k2 >>= _1n$3;
    }
    return { p1, p2 };
  }
  function createField(order, field, isLE2) {
    if (field) {
      if (field.ORDER !== order)
        throw new Error("Field.ORDER must match order: Fp == p, Fn == n");
      validateField(field);
      return field;
    } else {
      return Field(order, { isLE: isLE2 });
    }
  }
  function createCurveFields(type, CURVE, curveOpts = {}, FpFnLE) {
    if (FpFnLE === void 0)
      FpFnLE = type === "edwards";
    if (!CURVE || typeof CURVE !== "object")
      throw new Error(`expected valid ${type} CURVE object`);
    for (const p of ["p", "n", "h"]) {
      const val = CURVE[p];
      if (!(typeof val === "bigint" && val > _0n$3))
        throw new Error(`CURVE.${p} must be positive bigint`);
    }
    const Fp2 = createField(CURVE.p, curveOpts.Fp, FpFnLE);
    const Fn2 = createField(CURVE.n, curveOpts.Fn, FpFnLE);
    const _b2 = type === "weierstrass" ? "b" : "d";
    const params = ["Gx", "Gy", "a", _b2];
    for (const p of params) {
      if (!Fp2.isValid(CURVE[p]))
        throw new Error(`CURVE.${p} must be valid field element of CURVE.Fp`);
    }
    CURVE = Object.freeze(Object.assign({}, CURVE));
    return { CURVE, Fp: Fp2, Fn: Fn2 };
  }
  function createKeygen(randomSecretKey, getPublicKey) {
    return function keygen(seed) {
      const secretKey = randomSecretKey(seed);
      return { secretKey, publicKey: getPublicKey(secretKey) };
    };
  }
  const _0n$2 = /* @__PURE__ */ BigInt(0), _1n$2 = /* @__PURE__ */ BigInt(1), _2n$2 = /* @__PURE__ */ BigInt(2), _8n$1 = /* @__PURE__ */ BigInt(8);
  function isEdValidXY(Fp2, CURVE, x, y) {
    const x2 = Fp2.sqr(x);
    const y2 = Fp2.sqr(y);
    const left = Fp2.add(Fp2.mul(CURVE.a, x2), y2);
    const right = Fp2.add(Fp2.ONE, Fp2.mul(CURVE.d, Fp2.mul(x2, y2)));
    return Fp2.eql(left, right);
  }
  function edwards(params, extraOpts = {}) {
    const opts = extraOpts;
    const validated = createCurveFields("edwards", params, opts, opts.FpFnLE);
    const { Fp: Fp2, Fn: Fn2 } = validated;
    let CURVE = validated.CURVE;
    const { h: cofactor } = CURVE;
    validateObject(opts, {}, { uvRatio: "function" });
    const MASK = _2n$2 << BigInt(Fn2.BYTES * 8) - _1n$2;
    const modP2 = (n) => Fp2.create(n);
    const uvRatio2 = opts.uvRatio === void 0 ? (u, v) => {
      try {
        return { isValid: true, value: Fp2.sqrt(Fp2.div(u, v)) };
      } catch (e) {
        return { isValid: false, value: _0n$2 };
      }
    } : opts.uvRatio;
    if (!isEdValidXY(Fp2, CURVE, CURVE.Gx, CURVE.Gy))
      throw new Error("bad curve params: generator point");
    function acoord(title, n, banZero = false) {
      const min = banZero ? _1n$2 : _0n$2;
      aInRange("coordinate " + title, n, min, MASK);
      return n;
    }
    function aedpoint(other) {
      if (!(other instanceof Point2))
        throw new Error("EdwardsPoint expected");
    }
    class Point2 {
      // base / generator point
      static BASE = new Point2(CURVE.Gx, CURVE.Gy, _1n$2, modP2(CURVE.Gx * CURVE.Gy));
      // zero / infinity / identity point
      static ZERO = new Point2(_0n$2, _1n$2, _1n$2, _0n$2);
      // 0, 1, 1, 0
      // math field
      static Fp = Fp2;
      // scalar field
      static Fn = Fn2;
      X;
      Y;
      Z;
      T;
      constructor(X, Y, Z, T) {
        this.X = acoord("x", X);
        this.Y = acoord("y", Y);
        this.Z = acoord("z", Z, true);
        this.T = acoord("t", T);
        Object.freeze(this);
      }
      static CURVE() {
        return CURVE;
      }
      /**
       * Create one extended Edwards point from affine coordinates.
       * Does NOT validate that the point is on-curve or torsion-free.
       * Use `.assertValidity()` on adversarial inputs.
       */
      static fromAffine(p) {
        if (p instanceof Point2)
          throw new Error("extended point not allowed");
        const { x, y } = p || {};
        acoord("x", x);
        acoord("y", y);
        return new Point2(x, y, _1n$2, modP2(x * y));
      }
      // Uses algo from RFC8032 5.1.3.
      static fromBytes(bytes, zip215 = false) {
        const len = Fp2.BYTES;
        const { a, d } = CURVE;
        bytes = copyBytes(abytes(bytes, len, "point"));
        abool(zip215, "zip215");
        const normed = copyBytes(bytes);
        const lastByte = bytes[len - 1];
        normed[len - 1] = lastByte & -129;
        const y = bytesToNumberLE(normed);
        const max = zip215 ? MASK : Fp2.ORDER;
        aInRange("point.y", y, _0n$2, max);
        const y2 = modP2(y * y);
        const u = modP2(y2 - _1n$2);
        const v = modP2(d * y2 - a);
        let { isValid, value: x } = uvRatio2(u, v);
        if (!isValid)
          throw new Error("bad point: invalid y coordinate");
        const isXOdd = (x & _1n$2) === _1n$2;
        const isLastByteOdd = (lastByte & 128) !== 0;
        if (!zip215 && x === _0n$2 && isLastByteOdd)
          throw new Error("bad point: x=0 and x_0=1");
        if (isLastByteOdd !== isXOdd)
          x = modP2(-x);
        return Point2.fromAffine({ x, y });
      }
      static fromHex(hex2, zip215 = false) {
        return Point2.fromBytes(hexToBytes(hex2), zip215);
      }
      get x() {
        return this.toAffine().x;
      }
      get y() {
        return this.toAffine().y;
      }
      precompute(windowSize = 8, isLazy = true) {
        wnaf.createCache(this, windowSize);
        if (!isLazy)
          this.multiply(_2n$2);
        return this;
      }
      // Useful in fromAffine() - not for fromBytes(), which always created valid points.
      assertValidity() {
        const p = this;
        const { a, d } = CURVE;
        if (p.is0())
          throw new Error("bad point: ZERO");
        const { X, Y, Z, T } = p;
        const X2 = modP2(X * X);
        const Y2 = modP2(Y * Y);
        const Z2 = modP2(Z * Z);
        const Z4 = modP2(Z2 * Z2);
        const aX2 = modP2(X2 * a);
        const left = modP2(Z2 * modP2(aX2 + Y2));
        const right = modP2(Z4 + modP2(d * modP2(X2 * Y2)));
        if (left !== right)
          throw new Error("bad point: equation left != right (1)");
        const XY = modP2(X * Y);
        const ZT = modP2(Z * T);
        if (XY !== ZT)
          throw new Error("bad point: equation left != right (2)");
      }
      // Compare one point to another.
      equals(other) {
        aedpoint(other);
        const { X: X1, Y: Y1, Z: Z1 } = this;
        const { X: X2, Y: Y2, Z: Z2 } = other;
        const X1Z2 = modP2(X1 * Z2);
        const X2Z1 = modP2(X2 * Z1);
        const Y1Z2 = modP2(Y1 * Z2);
        const Y2Z1 = modP2(Y2 * Z1);
        return X1Z2 === X2Z1 && Y1Z2 === Y2Z1;
      }
      is0() {
        return this.equals(Point2.ZERO);
      }
      negate() {
        return new Point2(modP2(-this.X), this.Y, this.Z, modP2(-this.T));
      }
      // Fast algo for doubling Extended Point.
      // https://hyperelliptic.org/EFD/g1p/auto-twisted-extended.html#doubling-dbl-2008-hwcd
      // Cost: 4M + 4S + 1*a + 6add + 1*2.
      double() {
        const { a } = CURVE;
        const { X: X1, Y: Y1, Z: Z1 } = this;
        const A = modP2(X1 * X1);
        const B = modP2(Y1 * Y1);
        const C2 = modP2(_2n$2 * modP2(Z1 * Z1));
        const D = modP2(a * A);
        const x1y1 = X1 + Y1;
        const E = modP2(modP2(x1y1 * x1y1) - A - B);
        const G2 = D + B;
        const F = G2 - C2;
        const H = D - B;
        const X3 = modP2(E * F);
        const Y3 = modP2(G2 * H);
        const T3 = modP2(E * H);
        const Z3 = modP2(F * G2);
        return new Point2(X3, Y3, Z3, T3);
      }
      // Fast algo for adding 2 Extended Points.
      // https://hyperelliptic.org/EFD/g1p/auto-twisted-extended.html#addition-add-2008-hwcd
      // Cost: 9M + 1*a + 1*d + 7add.
      add(other) {
        aedpoint(other);
        const { a, d } = CURVE;
        const { X: X1, Y: Y1, Z: Z1, T: T1 } = this;
        const { X: X2, Y: Y2, Z: Z2, T: T2 } = other;
        const A = modP2(X1 * X2);
        const B = modP2(Y1 * Y2);
        const C2 = modP2(T1 * d * T2);
        const D = modP2(Z1 * Z2);
        const E = modP2((X1 + Y1) * (X2 + Y2) - A - B);
        const F = D - C2;
        const G2 = D + C2;
        const H = modP2(B - a * A);
        const X3 = modP2(E * F);
        const Y3 = modP2(G2 * H);
        const T3 = modP2(E * H);
        const Z3 = modP2(F * G2);
        return new Point2(X3, Y3, Z3, T3);
      }
      subtract(other) {
        aedpoint(other);
        return this.add(other.negate());
      }
      // Constant-time multiplication.
      multiply(scalar) {
        if (!Fn2.isValidNot0(scalar))
          throw new RangeError("invalid scalar: expected 1 <= sc < curve.n");
        const { p, f } = wnaf.cached(this, scalar, (p2) => normalizeZ(Point2, p2));
        return normalizeZ(Point2, [p, f])[0];
      }
      // Non-constant-time multiplication. Uses double-and-add algorithm.
      // It's faster, but should only be used when you don't care about
      // an exposed private key e.g. sig verification.
      // Keeps the same subgroup-scalar contract: 0 is allowed for public-scalar callers, but
      // n and larger values are rejected instead of being reduced mod n to the identity point.
      multiplyUnsafe(scalar) {
        if (!Fn2.isValid(scalar))
          throw new RangeError("invalid scalar: expected 0 <= sc < curve.n");
        if (scalar === _0n$2)
          return Point2.ZERO;
        if (this.is0() || scalar === _1n$2)
          return this;
        return wnaf.unsafe(this, scalar, (p) => normalizeZ(Point2, p));
      }
      // Checks if point is of small order.
      // If you add something to small order point, you will have "dirty"
      // point with torsion component.
      // Clears cofactor and checks if the result is 0.
      isSmallOrder() {
        return this.clearCofactor().is0();
      }
      // Multiplies point by curve order and checks if the result is 0.
      // Returns `false` is the point is dirty.
      isTorsionFree() {
        return wnaf.unsafe(this, CURVE.n).is0();
      }
      // Converts Extended point to default (x, y) coordinates.
      // Can accept precomputed Z^-1 - for example, from invertBatch.
      toAffine(invertedZ) {
        const p = this;
        let iz = invertedZ;
        const { X, Y, Z } = p;
        const is0 = p.is0();
        if (iz == null)
          iz = is0 ? _8n$1 : Fp2.inv(Z);
        const x = modP2(X * iz);
        const y = modP2(Y * iz);
        const zz = Fp2.mul(Z, iz);
        if (is0)
          return { x: _0n$2, y: _1n$2 };
        if (zz !== _1n$2)
          throw new Error("invZ was invalid");
        return { x, y };
      }
      clearCofactor() {
        if (cofactor === _1n$2)
          return this;
        return this.multiplyUnsafe(cofactor);
      }
      toBytes() {
        const { x, y } = this.toAffine();
        const bytes = Fp2.toBytes(y);
        bytes[bytes.length - 1] |= x & _1n$2 ? 128 : 0;
        return bytes;
      }
      toHex() {
        return bytesToHex(this.toBytes());
      }
      toString() {
        return `<Point ${this.is0() ? "ZERO" : this.toHex()}>`;
      }
    }
    const wnaf = new wNAF(Point2, Fn2.BITS);
    if (Fn2.BITS >= 8)
      Point2.BASE.precompute(8);
    Object.freeze(Point2.prototype);
    Object.freeze(Point2);
    return Point2;
  }
  class PrimeEdwardsPoint {
    static BASE;
    static ZERO;
    static Fp;
    static Fn;
    ep;
    /**
     * Wrap one internal Edwards representative directly.
     * This is not a canonical encoding boundary: alternate Edwards
     * representatives may still describe the same abstract wrapper element.
     */
    constructor(ep) {
      this.ep = ep;
    }
    // Static methods that must be implemented by subclasses
    static fromBytes(_bytes) {
      notImplemented();
    }
    static fromHex(_hex) {
      notImplemented();
    }
    get x() {
      return this.toAffine().x;
    }
    get y() {
      return this.toAffine().y;
    }
    // Common implementations
    clearCofactor() {
      return this;
    }
    assertValidity() {
      this.ep.assertValidity();
    }
    /**
     * Return affine coordinates of the current internal Edwards representative.
     * This is a convenience helper, not a canonical Ristretto/Decaf encoding.
     * Equal abstract elements may expose different `x` / `y`; use
     * `toBytes()` / `fromBytes()` for canonical roundtrips.
     */
    toAffine(invertedZ) {
      return this.ep.toAffine(invertedZ);
    }
    toHex() {
      return bytesToHex(this.toBytes());
    }
    toString() {
      return this.toHex();
    }
    isTorsionFree() {
      return true;
    }
    isSmallOrder() {
      return false;
    }
    add(other) {
      this.assertSame(other);
      return this.init(this.ep.add(other.ep));
    }
    subtract(other) {
      this.assertSame(other);
      return this.init(this.ep.subtract(other.ep));
    }
    multiply(scalar) {
      return this.init(this.ep.multiply(scalar));
    }
    multiplyUnsafe(scalar) {
      return this.init(this.ep.multiplyUnsafe(scalar));
    }
    double() {
      return this.init(this.ep.double());
    }
    negate() {
      return this.init(this.ep.negate());
    }
    precompute(windowSize, isLazy) {
      this.ep.precompute(windowSize, isLazy);
      return this;
    }
  }
  function eddsa(Point2, cHash, eddsaOpts = {}) {
    if (typeof cHash !== "function")
      throw new Error('"hash" function param is required');
    const hash = cHash;
    const opts = eddsaOpts;
    validateObject(opts, {}, {
      adjustScalarBytes: "function",
      randomBytes: "function",
      domain: "function",
      prehash: "function",
      zip215: "boolean",
      mapToCurve: "function"
    });
    const { prehash } = opts;
    const { BASE, Fp: Fp2, Fn: Fn2 } = Point2;
    const outputLen = hash.outputLen;
    const expectedLen = 2 * Fp2.BYTES;
    if (outputLen !== void 0) {
      asafenumber(outputLen, "hash.outputLen");
      if (outputLen !== expectedLen)
        throw new Error(`hash.outputLen must be ${expectedLen}, got ${outputLen}`);
    }
    const randomBytes2 = opts.randomBytes === void 0 ? randomBytes$1 : opts.randomBytes;
    const adjustScalarBytes2 = opts.adjustScalarBytes === void 0 ? (bytes) => bytes : opts.adjustScalarBytes;
    const domain = opts.domain === void 0 ? (data, ctx, phflag) => {
      abool(phflag, "phflag");
      if (ctx.length || phflag)
        throw new Error("Contexts/pre-hash are not supported");
      return data;
    } : opts.domain;
    function modN_LE(hash2) {
      return Fn2.create(bytesToNumberLE(hash2));
    }
    function getPrivateScalar(key) {
      const len = lengths2.secretKey;
      abytes(key, lengths2.secretKey, "secretKey");
      const hashed = abytes(hash(key), 2 * len, "hashedSecretKey");
      const head = adjustScalarBytes2(hashed.slice(0, len));
      const prefix2 = hashed.slice(len, 2 * len);
      const scalar = modN_LE(head);
      return { head, prefix: prefix2, scalar };
    }
    function getExtendedPublicKey2(secretKey) {
      const { head, prefix: prefix2, scalar } = getPrivateScalar(secretKey);
      const point = BASE.multiply(scalar);
      const pointBytes = point.toBytes();
      return { head, prefix: prefix2, scalar, point, pointBytes };
    }
    function getPublicKey(secretKey) {
      return getExtendedPublicKey2(secretKey).pointBytes;
    }
    function hashDomainToScalar(context = Uint8Array.of(), ...msgs) {
      const msg = concatBytes(...msgs);
      return modN_LE(hash(domain(msg, abytes(context, void 0, "context"), !!prehash)));
    }
    function sign2(msg, secretKey, options = {}) {
      msg = abytes(msg, void 0, "message");
      if (prehash)
        msg = prehash(msg);
      const { prefix: prefix2, scalar, pointBytes } = getExtendedPublicKey2(secretKey);
      const r = hashDomainToScalar(options.context, prefix2, msg);
      const R = BASE.multiply(r).toBytes();
      const k = hashDomainToScalar(options.context, R, pointBytes, msg);
      const s = Fn2.create(r + k * scalar);
      if (!Fn2.isValid(s))
        throw new Error("sign failed: invalid s");
      const rs = concatBytes(R, Fn2.toBytes(s));
      return abytes(rs, lengths2.signature, "result");
    }
    const verifyOpts = {
      zip215: opts.zip215
    };
    function verify(sig, msg, publicKey, options = verifyOpts) {
      const { context } = options;
      const zip215 = options.zip215 === void 0 ? !!verifyOpts.zip215 : options.zip215;
      const len = lengths2.signature;
      sig = abytes(sig, len, "signature");
      msg = abytes(msg, void 0, "message");
      publicKey = abytes(publicKey, lengths2.publicKey, "publicKey");
      if (zip215 !== void 0)
        abool(zip215, "zip215");
      if (prehash)
        msg = prehash(msg);
      const mid = len / 2;
      const r = sig.subarray(0, mid);
      const s = bytesToNumberLE(sig.subarray(mid, len));
      let A, R, SB;
      try {
        A = Point2.fromBytes(publicKey, zip215);
        R = Point2.fromBytes(r, zip215);
        SB = BASE.multiplyUnsafe(s);
      } catch (error) {
        return false;
      }
      if (!zip215 && A.isSmallOrder())
        return false;
      const k = hashDomainToScalar(context, r, publicKey, msg);
      const RkA = R.add(A.multiplyUnsafe(k));
      return RkA.subtract(SB).clearCofactor().is0();
    }
    const _size = Fp2.BYTES;
    const lengths2 = {
      secretKey: _size,
      publicKey: _size,
      signature: 2 * _size,
      seed: _size
    };
    function randomSecretKey(seed) {
      seed = seed === void 0 ? randomBytes2(lengths2.seed) : seed;
      return abytes(seed, lengths2.seed, "seed");
    }
    function isValidSecretKey(key) {
      return isBytes(key) && key.length === lengths2.secretKey;
    }
    function isValidPublicKey(key, zip215) {
      try {
        return !!Point2.fromBytes(key, zip215 === void 0 ? verifyOpts.zip215 : zip215);
      } catch (error) {
        return false;
      }
    }
    const utils = {
      getExtendedPublicKey: getExtendedPublicKey2,
      randomSecretKey,
      isValidSecretKey,
      isValidPublicKey,
      /**
       * Converts ed public key to x public key. Uses formula:
       * - ed25519:
       *   - `(u, v) = ((1+y)/(1-y), sqrt(-486664)*u/x)`
       *   - `(x, y) = (sqrt(-486664)*u/v, (u-1)/(u+1))`
       * - ed448:
       *   - `(u, v) = ((y-1)/(y+1), sqrt(156324)*u/x)`
       *   - `(x, y) = (sqrt(156324)*u/v, (1+u)/(1-u))`
       */
      toMontgomery(publicKey) {
        const { y } = Point2.fromBytes(publicKey);
        const size = lengths2.publicKey;
        const is25519 = size === 32;
        if (!is25519 && size !== 57)
          throw new Error("only defined for 25519 and 448");
        const u = is25519 ? Fp2.div(_1n$2 + y, _1n$2 - y) : Fp2.div(y - _1n$2, y + _1n$2);
        return Fp2.toBytes(u);
      },
      toMontgomerySecret(secretKey) {
        const size = lengths2.secretKey;
        abytes(secretKey, size);
        const hashed = hash(secretKey.subarray(0, size));
        return adjustScalarBytes2(hashed).subarray(0, size);
      }
    };
    Object.freeze(lengths2);
    Object.freeze(utils);
    return Object.freeze({
      keygen: createKeygen(randomSecretKey, getPublicKey),
      getPublicKey,
      sign: sign2,
      verify,
      utils,
      Point: Point2,
      lengths: lengths2
    });
  }
  const _0n$1 = /* @__PURE__ */ BigInt(0), _1n$1 = /* @__PURE__ */ BigInt(1), _2n$1 = /* @__PURE__ */ BigInt(2);
  const _5n = /* @__PURE__ */ BigInt(5), _8n = /* @__PURE__ */ BigInt(8);
  const ed25519_CURVE_p = /* @__PURE__ */ BigInt("0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed");
  const ed25519_CURVE = /* @__PURE__ */ (() => ({
    p: ed25519_CURVE_p,
    n: BigInt("0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed"),
    h: _8n,
    a: BigInt("0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffec"),
    d: BigInt("0x52036cee2b6ffe738cc740797779e89800700a4d4141d8ab75eb4dca135978a3"),
    Gx: BigInt("0x216936d3cd6e53fec0a4e231fdd6dc5c692cc7609525a7b2c9562d608f25d51a"),
    Gy: BigInt("0x6666666666666666666666666666666666666666666666666666666666666658")
  }))();
  function ed25519_pow_2_252_3(x) {
    const _10n = BigInt(10), _20n = BigInt(20), _40n = BigInt(40), _80n = BigInt(80);
    const P2 = ed25519_CURVE_p;
    const x2 = x * x % P2;
    const b2 = x2 * x % P2;
    const b4 = pow2(b2, _2n$1, P2) * b2 % P2;
    const b5 = pow2(b4, _1n$1, P2) * x % P2;
    const b10 = pow2(b5, _5n, P2) * b5 % P2;
    const b20 = pow2(b10, _10n, P2) * b10 % P2;
    const b40 = pow2(b20, _20n, P2) * b20 % P2;
    const b80 = pow2(b40, _40n, P2) * b40 % P2;
    const b160 = pow2(b80, _80n, P2) * b80 % P2;
    const b240 = pow2(b160, _80n, P2) * b80 % P2;
    const b250 = pow2(b240, _10n, P2) * b10 % P2;
    const pow_p_5_8 = pow2(b250, _2n$1, P2) * x % P2;
    return { pow_p_5_8, b2 };
  }
  function adjustScalarBytes(bytes) {
    bytes[0] &= 248;
    bytes[31] &= 127;
    bytes[31] |= 64;
    return bytes;
  }
  const ED25519_SQRT_M1 = /* @__PURE__ */ BigInt("19681161376707505956807079304988542015446066515923890162744021073123829784752");
  function uvRatio(u, v) {
    const P2 = ed25519_CURVE_p;
    const v3 = mod(v * v * v, P2);
    const v7 = mod(v3 * v3 * v, P2);
    const pow = ed25519_pow_2_252_3(u * v7).pow_p_5_8;
    let x = mod(u * v3 * pow, P2);
    const vx2 = mod(v * x * x, P2);
    const root1 = x;
    const root2 = mod(x * ED25519_SQRT_M1, P2);
    const useRoot1 = vx2 === u;
    const useRoot2 = vx2 === mod(-u, P2);
    const noRoot = vx2 === mod(-u * ED25519_SQRT_M1, P2);
    if (useRoot1)
      x = root1;
    if (useRoot2 || noRoot)
      x = root2;
    if (isNegativeLE(x, P2))
      x = mod(-x, P2);
    return { isValid: useRoot1 || useRoot2, value: x };
  }
  const ed25519_Point = /* @__PURE__ */ edwards(ed25519_CURVE, { uvRatio });
  const Fp = /* @__PURE__ */ (() => ed25519_Point.Fp)();
  const Fn = /* @__PURE__ */ (() => ed25519_Point.Fn)();
  function ed(opts) {
    return eddsa(ed25519_Point, sha512, Object.assign({ adjustScalarBytes, zip215: true }, opts));
  }
  const ed25519 = /* @__PURE__ */ ed({});
  const SQRT_M1 = ED25519_SQRT_M1;
  const INVSQRT_A_MINUS_D = /* @__PURE__ */ BigInt("54469307008909316920995813868745141605393597292927456921205312896311721017578");
  const invertSqrt = (number2) => uvRatio(_1n$1, number2);
  const MAX_255B = /* @__PURE__ */ BigInt("0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
  const bytes255ToNumberLE = (bytes) => Fp.create(bytesToNumberLE(bytes) & MAX_255B);
  class _RistrettoPoint extends PrimeEdwardsPoint {
    // Do NOT change syntax: the following gymnastics is done,
    // because typescript strips comments, which makes bundlers disable tree-shaking.
    // prettier-ignore
    static BASE = /* @__PURE__ */ (() => new _RistrettoPoint(ed25519_Point.BASE))();
    // prettier-ignore
    static ZERO = /* @__PURE__ */ (() => new _RistrettoPoint(ed25519_Point.ZERO))();
    // prettier-ignore
    static Fp = /* @__PURE__ */ (() => Fp)();
    // prettier-ignore
    static Fn = /* @__PURE__ */ (() => Fn)();
    constructor(ep) {
      super(ep);
    }
    /**
     * Create one Ristretto255 point from affine Edwards coordinates.
     * This wraps the internal Edwards representative directly and is not a
     * canonical ristretto255 decoding path.
     * Use `toBytes()` / `fromBytes()` if canonical ristretto255 bytes matter.
     */
    static fromAffine(ap) {
      return new _RistrettoPoint(ed25519_Point.fromAffine(ap));
    }
    assertSame(other) {
      if (!(other instanceof _RistrettoPoint))
        throw new Error("RistrettoPoint expected");
    }
    init(ep) {
      return new _RistrettoPoint(ep);
    }
    static fromBytes(bytes) {
      abytes$2(bytes, 32);
      const { a, d } = ed25519_CURVE;
      const P2 = ed25519_CURVE_p;
      const mod2 = (n) => Fp.create(n);
      const s = bytes255ToNumberLE(bytes);
      if (!equalBytes(Fp.toBytes(s), bytes) || isNegativeLE(s, P2))
        throw new Error("invalid ristretto255 encoding 1");
      const s2 = mod2(s * s);
      const u1 = mod2(_1n$1 + a * s2);
      const u2 = mod2(_1n$1 - a * s2);
      const u1_2 = mod2(u1 * u1);
      const u2_2 = mod2(u2 * u2);
      const v = mod2(a * d * u1_2 - u2_2);
      const { isValid, value: I2 } = invertSqrt(mod2(v * u2_2));
      const Dx = mod2(I2 * u2);
      const Dy = mod2(I2 * Dx * v);
      let x = mod2((s + s) * Dx);
      if (isNegativeLE(x, P2))
        x = mod2(-x);
      const y = mod2(u1 * Dy);
      const t = mod2(x * y);
      if (!isValid || isNegativeLE(t, P2) || y === _0n$1)
        throw new Error("invalid ristretto255 encoding 2");
      return new _RistrettoPoint(new ed25519_Point(x, y, _1n$1, t));
    }
    /**
     * Converts ristretto-encoded string to ristretto point.
     * Described in [RFC9496](https://www.rfc-editor.org/rfc/rfc9496#name-decode).
     * @param hex - Ristretto-encoded 32 bytes. Not every 32-byte string is valid ristretto encoding
     */
    static fromHex(hex2) {
      return _RistrettoPoint.fromBytes(hexToBytes$2(hex2));
    }
    /**
     * Encodes ristretto point to Uint8Array.
     * Described in [RFC9496](https://www.rfc-editor.org/rfc/rfc9496#name-encode).
     */
    toBytes() {
      let { X, Y, Z, T } = this.ep;
      const P2 = ed25519_CURVE_p;
      const mod2 = (n) => Fp.create(n);
      const u1 = mod2(mod2(Z + Y) * mod2(Z - Y));
      const u2 = mod2(X * Y);
      const u2sq = mod2(u2 * u2);
      const { value: invsqrt } = invertSqrt(mod2(u1 * u2sq));
      const D1 = mod2(invsqrt * u1);
      const D2 = mod2(invsqrt * u2);
      const zInv = mod2(D1 * D2 * T);
      let D;
      if (isNegativeLE(T * zInv, P2)) {
        let _x = mod2(Y * SQRT_M1);
        let _y = mod2(X * SQRT_M1);
        X = _x;
        Y = _y;
        D = mod2(D1 * INVSQRT_A_MINUS_D);
      } else {
        D = D2;
      }
      if (isNegativeLE(X * zInv, P2))
        Y = mod2(-Y);
      let s = mod2((Z - Y) * D);
      if (isNegativeLE(s, P2))
        s = mod2(-s);
      return Fp.toBytes(s);
    }
    /**
     * Compares two Ristretto points.
     * Described in [RFC9496](https://www.rfc-editor.org/rfc/rfc9496#name-equals).
     */
    equals(other) {
      this.assertSame(other);
      const { X: X1, Y: Y1 } = this.ep;
      const { X: X2, Y: Y2 } = other.ep;
      const mod2 = (n) => Fp.create(n);
      const one = mod2(X1 * Y2) === mod2(Y1 * X2);
      const two = mod2(Y1 * Y2) === mod2(X1 * X2);
      return one || two;
    }
    is0() {
      return this.equals(_RistrettoPoint.ZERO);
    }
  }
  Object.freeze(_RistrettoPoint.BASE);
  Object.freeze(_RistrettoPoint.ZERO);
  Object.freeze(_RistrettoPoint.prototype);
  Object.freeze(_RistrettoPoint);
  const divNearest = (num, den) => (num + (num >= 0 ? den : -den) / _2n) / den;
  function _splitEndoScalar(k, basis, n) {
    aInRange("scalar", k, _0n, n);
    const [[a1, b1], [a2, b2]] = basis;
    const c1 = divNearest(b2 * k, n);
    const c2 = divNearest(-b1 * k, n);
    let k1 = k - c1 * a1 - c2 * a2;
    let k2 = -c1 * b1 - c2 * b2;
    const k1neg = k1 < _0n;
    const k2neg = k2 < _0n;
    if (k1neg)
      k1 = -k1;
    if (k2neg)
      k2 = -k2;
    const MAX_NUM = bitMask(Math.ceil(bitLen(n) / 2)) + _1n;
    if (k1 < _0n || k1 >= MAX_NUM || k2 < _0n || k2 >= MAX_NUM) {
      throw new Error("splitScalar (endomorphism): failed for k");
    }
    return { k1neg, k1, k2neg, k2 };
  }
  function validateSigFormat(format) {
    if (!["compact", "recovered", "der"].includes(format))
      throw new Error('Signature format must be "compact", "recovered", or "der"');
    return format;
  }
  function validateSigOpts(opts, def) {
    validateObject(opts);
    const optsn = {};
    for (let optName of Object.keys(def)) {
      optsn[optName] = opts[optName] === void 0 ? def[optName] : opts[optName];
    }
    abool(optsn.lowS, "lowS");
    abool(optsn.prehash, "prehash");
    if (optsn.format !== void 0)
      validateSigFormat(optsn.format);
    return optsn;
  }
  class DERErr extends Error {
    constructor(m = "") {
      super(m);
    }
  }
  const DER = {
    // asn.1 DER encoding utils
    Err: DERErr,
    // Basic building block is TLV (Tag-Length-Value)
    _tlv: {
      encode: (tag, data) => {
        const { Err: E } = DER;
        asafenumber(tag, "tag");
        if (tag < 0 || tag > 255)
          throw new E("tlv.encode: wrong tag");
        if (typeof data !== "string")
          throw new TypeError('"data" expected string, got type=' + typeof data);
        if (data.length & 1)
          throw new E("tlv.encode: unpadded data");
        const dataLen = data.length / 2;
        const len = numberToHexUnpadded(dataLen);
        if (len.length / 2 & 128)
          throw new E("tlv.encode: long form length too big");
        const lenLen = dataLen > 127 ? numberToHexUnpadded(len.length / 2 | 128) : "";
        const t = numberToHexUnpadded(tag);
        return t + lenLen + len + data;
      },
      // v - value, l - left bytes (unparsed)
      decode(tag, data) {
        const { Err: E } = DER;
        data = abytes(data, void 0, "DER data");
        let pos = 0;
        if (tag < 0 || tag > 255)
          throw new E("tlv.encode: wrong tag");
        if (data.length < 2 || data[pos++] !== tag)
          throw new E("tlv.decode: wrong tlv");
        const first = data[pos++];
        const isLong = !!(first & 128);
        let length = 0;
        if (!isLong)
          length = first;
        else {
          const lenLen = first & 127;
          if (!lenLen)
            throw new E("tlv.decode(long): indefinite length not supported");
          if (lenLen > 4)
            throw new E("tlv.decode(long): byte length is too big");
          const lengthBytes = data.subarray(pos, pos + lenLen);
          if (lengthBytes.length !== lenLen)
            throw new E("tlv.decode: length bytes not complete");
          if (lengthBytes[0] === 0)
            throw new E("tlv.decode(long): zero leftmost byte");
          for (const b of lengthBytes)
            length = length << 8 | b;
          pos += lenLen;
          if (length < 128)
            throw new E("tlv.decode(long): not minimal encoding");
        }
        const v = data.subarray(pos, pos + length);
        if (v.length !== length)
          throw new E("tlv.decode: wrong value length");
        return { v, l: data.subarray(pos + length) };
      }
    },
    // https://crypto.stackexchange.com/a/57734 Leftmost bit of first byte is 'negative' flag,
    // since we always use positive integers here. It must always be empty:
    // - add zero byte if exists
    // - if next byte doesn't have a flag, leading zero is not allowed (minimal encoding)
    _int: {
      encode(num) {
        const { Err: E } = DER;
        abignumber(num);
        if (num < _0n)
          throw new E("integer: negative integers are not allowed");
        let hex2 = numberToHexUnpadded(num);
        if (Number.parseInt(hex2[0], 16) & 8)
          hex2 = "00" + hex2;
        if (hex2.length & 1)
          throw new E("unexpected DER parsing assertion: unpadded hex");
        return hex2;
      },
      decode(data) {
        const { Err: E } = DER;
        if (data.length < 1)
          throw new E("invalid signature integer: empty");
        if (data[0] & 128)
          throw new E("invalid signature integer: negative");
        if (data.length > 1 && data[0] === 0 && !(data[1] & 128))
          throw new E("invalid signature integer: unnecessary leading zero");
        return bytesToNumberBE(data);
      }
    },
    toSig(bytes) {
      const { Err: E, _int: int2, _tlv: tlv } = DER;
      const data = abytes(bytes, void 0, "signature");
      const { v: seqBytes, l: seqLeftBytes } = tlv.decode(48, data);
      if (seqLeftBytes.length)
        throw new E("invalid signature: left bytes after parsing");
      const { v: rBytes, l: rLeftBytes } = tlv.decode(2, seqBytes);
      const { v: sBytes, l: sLeftBytes } = tlv.decode(2, rLeftBytes);
      if (sLeftBytes.length)
        throw new E("invalid signature: left bytes after parsing");
      return { r: int2.decode(rBytes), s: int2.decode(sBytes) };
    },
    hexFromSig(sig) {
      const { _tlv: tlv, _int: int2 } = DER;
      const rs = tlv.encode(2, int2.encode(sig.r));
      const ss = tlv.encode(2, int2.encode(sig.s));
      const seq = rs + ss;
      return tlv.encode(48, seq);
    }
  };
  Object.freeze(DER._tlv);
  Object.freeze(DER._int);
  Object.freeze(DER);
  const _0n = /* @__PURE__ */ BigInt(0), _1n = /* @__PURE__ */ BigInt(1), _2n = /* @__PURE__ */ BigInt(2), _3n = /* @__PURE__ */ BigInt(3), _4n = /* @__PURE__ */ BigInt(4);
  function weierstrass(params, extraOpts = {}) {
    const validated = createCurveFields("weierstrass", params, extraOpts);
    const Fp2 = validated.Fp;
    const Fn2 = validated.Fn;
    let CURVE = validated.CURVE;
    const { h: cofactor, n: CURVE_ORDER } = CURVE;
    validateObject(extraOpts, {}, {
      allowInfinityPoint: "boolean",
      clearCofactor: "function",
      isTorsionFree: "function",
      fromBytes: "function",
      toBytes: "function",
      endo: "object"
    });
    const { endo, allowInfinityPoint } = extraOpts;
    if (endo) {
      if (!Fp2.is0(CURVE.a) || typeof endo.beta !== "bigint" || !Array.isArray(endo.basises)) {
        throw new Error('invalid endo: expected "beta": bigint and "basises": array');
      }
    }
    const lengths2 = getWLengths(Fp2, Fn2);
    function assertCompressionIsSupported() {
      if (!Fp2.isOdd)
        throw new Error("compression is not supported: Field does not have .isOdd()");
    }
    function pointToBytes(_c, point, isCompressed) {
      if (allowInfinityPoint && point.is0())
        return Uint8Array.of(0);
      const { x, y } = point.toAffine();
      const bx = Fp2.toBytes(x);
      abool(isCompressed, "isCompressed");
      if (isCompressed) {
        assertCompressionIsSupported();
        const hasEvenY = !Fp2.isOdd(y);
        return concatBytes(pprefix(hasEvenY), bx);
      } else {
        return concatBytes(Uint8Array.of(4), bx, Fp2.toBytes(y));
      }
    }
    function pointFromBytes(bytes) {
      abytes(bytes, void 0, "Point");
      const { publicKey: comp, publicKeyUncompressed: uncomp } = lengths2;
      const length = bytes.length;
      const head = bytes[0];
      const tail = bytes.subarray(1);
      if (allowInfinityPoint && length === 1 && head === 0)
        return { x: Fp2.ZERO, y: Fp2.ZERO };
      if (length === comp && (head === 2 || head === 3)) {
        const x = Fp2.fromBytes(tail);
        if (!Fp2.isValid(x))
          throw new Error("bad point: is not on curve, wrong x");
        const y2 = weierstrassEquation(x);
        let y;
        try {
          y = Fp2.sqrt(y2);
        } catch (sqrtError) {
          const err2 = sqrtError instanceof Error ? ": " + sqrtError.message : "";
          throw new Error("bad point: is not on curve, sqrt error" + err2);
        }
        assertCompressionIsSupported();
        const evenY = Fp2.isOdd(y);
        const evenH = (head & 1) === 1;
        if (evenH !== evenY)
          y = Fp2.neg(y);
        return { x, y };
      } else if (length === uncomp && head === 4) {
        const L3 = Fp2.BYTES;
        const x = Fp2.fromBytes(tail.subarray(0, L3));
        const y = Fp2.fromBytes(tail.subarray(L3, L3 * 2));
        if (!isValidXY(x, y))
          throw new Error("bad point: is not on curve");
        return { x, y };
      } else {
        throw new Error(`bad point: got length ${length}, expected compressed=${comp} or uncompressed=${uncomp}`);
      }
    }
    const encodePoint = extraOpts.toBytes === void 0 ? pointToBytes : extraOpts.toBytes;
    const decodePoint = extraOpts.fromBytes === void 0 ? pointFromBytes : extraOpts.fromBytes;
    function weierstrassEquation(x) {
      const x2 = Fp2.sqr(x);
      const x3 = Fp2.mul(x2, x);
      return Fp2.add(Fp2.add(x3, Fp2.mul(x, CURVE.a)), CURVE.b);
    }
    function isValidXY(x, y) {
      const left = Fp2.sqr(y);
      const right = weierstrassEquation(x);
      return Fp2.eql(left, right);
    }
    if (!isValidXY(CURVE.Gx, CURVE.Gy))
      throw new Error("bad curve params: generator point");
    const _4a3 = Fp2.mul(Fp2.pow(CURVE.a, _3n), _4n);
    const _27b2 = Fp2.mul(Fp2.sqr(CURVE.b), BigInt(27));
    if (Fp2.is0(Fp2.add(_4a3, _27b2)))
      throw new Error("bad curve params: a or b");
    function acoord(title, n, banZero = false) {
      if (!Fp2.isValid(n) || banZero && Fp2.is0(n))
        throw new Error(`bad point coordinate ${title}`);
      return n;
    }
    function aprjpoint(other) {
      if (!(other instanceof Point2))
        throw new Error("Weierstrass Point expected");
    }
    function splitEndoScalarN(k) {
      if (!endo || !endo.basises)
        throw new Error("no endo");
      return _splitEndoScalar(k, endo.basises, Fn2.ORDER);
    }
    function finishEndo(endoBeta, k1p, k2p, k1neg, k2neg) {
      k2p = new Point2(Fp2.mul(k2p.X, endoBeta), k2p.Y, k2p.Z);
      k1p = negateCt(k1neg, k1p);
      k2p = negateCt(k2neg, k2p);
      return k1p.add(k2p);
    }
    class Point2 {
      // base / generator point
      static BASE = new Point2(CURVE.Gx, CURVE.Gy, Fp2.ONE);
      // zero / infinity / identity point
      static ZERO = new Point2(Fp2.ZERO, Fp2.ONE, Fp2.ZERO);
      // 0, 1, 0
      // math field
      static Fp = Fp2;
      // scalar field
      static Fn = Fn2;
      X;
      Y;
      Z;
      /** Does NOT validate if the point is valid. Use `.assertValidity()`. */
      constructor(X, Y, Z) {
        this.X = acoord("x", X);
        this.Y = acoord("y", Y, true);
        this.Z = acoord("z", Z);
        Object.freeze(this);
      }
      static CURVE() {
        return CURVE;
      }
      /** Does NOT validate if the point is valid. Use `.assertValidity()`. */
      static fromAffine(p) {
        const { x, y } = p || {};
        if (!p || !Fp2.isValid(x) || !Fp2.isValid(y))
          throw new Error("invalid affine point");
        if (p instanceof Point2)
          throw new Error("projective point not allowed");
        if (Fp2.is0(x) && Fp2.is0(y))
          return Point2.ZERO;
        return new Point2(x, y, Fp2.ONE);
      }
      static fromBytes(bytes) {
        const P2 = Point2.fromAffine(decodePoint(abytes(bytes, void 0, "point")));
        P2.assertValidity();
        return P2;
      }
      static fromHex(hex2) {
        return Point2.fromBytes(hexToBytes(hex2));
      }
      get x() {
        return this.toAffine().x;
      }
      get y() {
        return this.toAffine().y;
      }
      /**
       *
       * @param windowSize
       * @param isLazy - true will defer table computation until the first multiplication
       * @returns
       */
      precompute(windowSize = 8, isLazy = true) {
        wnaf.createCache(this, windowSize);
        if (!isLazy)
          this.multiply(_3n);
        return this;
      }
      // TODO: return `this`
      /** A point on curve is valid if it conforms to equation. */
      assertValidity() {
        const p = this;
        if (p.is0()) {
          if (extraOpts.allowInfinityPoint && Fp2.is0(p.X) && Fp2.eql(p.Y, Fp2.ONE) && Fp2.is0(p.Z))
            return;
          throw new Error("bad point: ZERO");
        }
        const { x, y } = p.toAffine();
        if (!Fp2.isValid(x) || !Fp2.isValid(y))
          throw new Error("bad point: x or y not field elements");
        if (!isValidXY(x, y))
          throw new Error("bad point: equation left != right");
        if (!p.isTorsionFree())
          throw new Error("bad point: not in prime-order subgroup");
      }
      hasEvenY() {
        const { y } = this.toAffine();
        if (!Fp2.isOdd)
          throw new Error("Field doesn't support isOdd");
        return !Fp2.isOdd(y);
      }
      /** Compare one point to another. */
      equals(other) {
        aprjpoint(other);
        const { X: X1, Y: Y1, Z: Z1 } = this;
        const { X: X2, Y: Y2, Z: Z2 } = other;
        const U1 = Fp2.eql(Fp2.mul(X1, Z2), Fp2.mul(X2, Z1));
        const U2 = Fp2.eql(Fp2.mul(Y1, Z2), Fp2.mul(Y2, Z1));
        return U1 && U2;
      }
      /** Flips point to one corresponding to (x, -y) in Affine coordinates. */
      negate() {
        return new Point2(this.X, Fp2.neg(this.Y), this.Z);
      }
      // Renes-Costello-Batina exception-free doubling formula.
      // There is 30% faster Jacobian formula, but it is not complete.
      // https://eprint.iacr.org/2015/1060, algorithm 3
      // Cost: 8M + 3S + 3*a + 2*b3 + 15add.
      double() {
        const { a, b } = CURVE;
        const b3 = Fp2.mul(b, _3n);
        const { X: X1, Y: Y1, Z: Z1 } = this;
        let X3 = Fp2.ZERO, Y3 = Fp2.ZERO, Z3 = Fp2.ZERO;
        let t0 = Fp2.mul(X1, X1);
        let t1 = Fp2.mul(Y1, Y1);
        let t2 = Fp2.mul(Z1, Z1);
        let t3 = Fp2.mul(X1, Y1);
        t3 = Fp2.add(t3, t3);
        Z3 = Fp2.mul(X1, Z1);
        Z3 = Fp2.add(Z3, Z3);
        X3 = Fp2.mul(a, Z3);
        Y3 = Fp2.mul(b3, t2);
        Y3 = Fp2.add(X3, Y3);
        X3 = Fp2.sub(t1, Y3);
        Y3 = Fp2.add(t1, Y3);
        Y3 = Fp2.mul(X3, Y3);
        X3 = Fp2.mul(t3, X3);
        Z3 = Fp2.mul(b3, Z3);
        t2 = Fp2.mul(a, t2);
        t3 = Fp2.sub(t0, t2);
        t3 = Fp2.mul(a, t3);
        t3 = Fp2.add(t3, Z3);
        Z3 = Fp2.add(t0, t0);
        t0 = Fp2.add(Z3, t0);
        t0 = Fp2.add(t0, t2);
        t0 = Fp2.mul(t0, t3);
        Y3 = Fp2.add(Y3, t0);
        t2 = Fp2.mul(Y1, Z1);
        t2 = Fp2.add(t2, t2);
        t0 = Fp2.mul(t2, t3);
        X3 = Fp2.sub(X3, t0);
        Z3 = Fp2.mul(t2, t1);
        Z3 = Fp2.add(Z3, Z3);
        Z3 = Fp2.add(Z3, Z3);
        return new Point2(X3, Y3, Z3);
      }
      // Renes-Costello-Batina exception-free addition formula.
      // There is 30% faster Jacobian formula, but it is not complete.
      // https://eprint.iacr.org/2015/1060, algorithm 1
      // Cost: 12M + 0S + 3*a + 3*b3 + 23add.
      add(other) {
        aprjpoint(other);
        const { X: X1, Y: Y1, Z: Z1 } = this;
        const { X: X2, Y: Y2, Z: Z2 } = other;
        let X3 = Fp2.ZERO, Y3 = Fp2.ZERO, Z3 = Fp2.ZERO;
        const a = CURVE.a;
        const b3 = Fp2.mul(CURVE.b, _3n);
        let t0 = Fp2.mul(X1, X2);
        let t1 = Fp2.mul(Y1, Y2);
        let t2 = Fp2.mul(Z1, Z2);
        let t3 = Fp2.add(X1, Y1);
        let t4 = Fp2.add(X2, Y2);
        t3 = Fp2.mul(t3, t4);
        t4 = Fp2.add(t0, t1);
        t3 = Fp2.sub(t3, t4);
        t4 = Fp2.add(X1, Z1);
        let t5 = Fp2.add(X2, Z2);
        t4 = Fp2.mul(t4, t5);
        t5 = Fp2.add(t0, t2);
        t4 = Fp2.sub(t4, t5);
        t5 = Fp2.add(Y1, Z1);
        X3 = Fp2.add(Y2, Z2);
        t5 = Fp2.mul(t5, X3);
        X3 = Fp2.add(t1, t2);
        t5 = Fp2.sub(t5, X3);
        Z3 = Fp2.mul(a, t4);
        X3 = Fp2.mul(b3, t2);
        Z3 = Fp2.add(X3, Z3);
        X3 = Fp2.sub(t1, Z3);
        Z3 = Fp2.add(t1, Z3);
        Y3 = Fp2.mul(X3, Z3);
        t1 = Fp2.add(t0, t0);
        t1 = Fp2.add(t1, t0);
        t2 = Fp2.mul(a, t2);
        t4 = Fp2.mul(b3, t4);
        t1 = Fp2.add(t1, t2);
        t2 = Fp2.sub(t0, t2);
        t2 = Fp2.mul(a, t2);
        t4 = Fp2.add(t4, t2);
        t0 = Fp2.mul(t1, t4);
        Y3 = Fp2.add(Y3, t0);
        t0 = Fp2.mul(t5, t4);
        X3 = Fp2.mul(t3, X3);
        X3 = Fp2.sub(X3, t0);
        t0 = Fp2.mul(t3, t1);
        Z3 = Fp2.mul(t5, Z3);
        Z3 = Fp2.add(Z3, t0);
        return new Point2(X3, Y3, Z3);
      }
      subtract(other) {
        aprjpoint(other);
        return this.add(other.negate());
      }
      is0() {
        return this.equals(Point2.ZERO);
      }
      /**
       * Constant time multiplication.
       * Uses wNAF method. Windowed method may be 10% faster,
       * but takes 2x longer to generate and consumes 2x memory.
       * Uses precomputes when available.
       * Uses endomorphism for Koblitz curves.
       * @param scalar - by which the point would be multiplied
       * @returns New point
       */
      multiply(scalar) {
        const { endo: endo2 } = extraOpts;
        if (!Fn2.isValidNot0(scalar))
          throw new RangeError("invalid scalar: out of range");
        let point, fake;
        const mul = (n) => wnaf.cached(this, n, (p) => normalizeZ(Point2, p));
        if (endo2) {
          const { k1neg, k1, k2neg, k2 } = splitEndoScalarN(scalar);
          const { p: k1p, f: k1f } = mul(k1);
          const { p: k2p, f: k2f } = mul(k2);
          fake = k1f.add(k2f);
          point = finishEndo(endo2.beta, k1p, k2p, k1neg, k2neg);
        } else {
          const { p, f } = mul(scalar);
          point = p;
          fake = f;
        }
        return normalizeZ(Point2, [point, fake])[0];
      }
      /**
       * Non-constant-time multiplication. Uses double-and-add algorithm.
       * It's faster, but should only be used when you don't care about
       * an exposed secret key e.g. sig verification, which works over *public* keys.
       */
      multiplyUnsafe(scalar) {
        const { endo: endo2 } = extraOpts;
        const p = this;
        const sc = scalar;
        if (!Fn2.isValid(sc))
          throw new RangeError("invalid scalar: out of range");
        if (sc === _0n || p.is0())
          return Point2.ZERO;
        if (sc === _1n)
          return p;
        if (wnaf.hasCache(this))
          return this.multiply(sc);
        if (endo2) {
          const { k1neg, k1, k2neg, k2 } = splitEndoScalarN(sc);
          const { p1, p2 } = mulEndoUnsafe(Point2, p, k1, k2);
          return finishEndo(endo2.beta, p1, p2, k1neg, k2neg);
        } else {
          return wnaf.unsafe(p, sc);
        }
      }
      /**
       * Converts Projective point to affine (x, y) coordinates.
       * (X, Y, Z) ∋ (x=X/Z, y=Y/Z).
       * @param invertedZ - Z^-1 (inverted zero) - optional, precomputation is useful for invertBatch
       */
      toAffine(invertedZ) {
        const p = this;
        let iz = invertedZ;
        const { X, Y, Z } = p;
        if (Fp2.eql(Z, Fp2.ONE))
          return { x: X, y: Y };
        const is0 = p.is0();
        if (iz == null)
          iz = is0 ? Fp2.ONE : Fp2.inv(Z);
        const x = Fp2.mul(X, iz);
        const y = Fp2.mul(Y, iz);
        const zz = Fp2.mul(Z, iz);
        if (is0)
          return { x: Fp2.ZERO, y: Fp2.ZERO };
        if (!Fp2.eql(zz, Fp2.ONE))
          throw new Error("invZ was invalid");
        return { x, y };
      }
      /**
       * Checks whether Point is free of torsion elements (is in prime subgroup).
       * Always torsion-free for cofactor=1 curves.
       */
      isTorsionFree() {
        const { isTorsionFree } = extraOpts;
        if (cofactor === _1n)
          return true;
        if (isTorsionFree)
          return isTorsionFree(Point2, this);
        return wnaf.unsafe(this, CURVE_ORDER).is0();
      }
      clearCofactor() {
        const { clearCofactor } = extraOpts;
        if (cofactor === _1n)
          return this;
        if (clearCofactor)
          return clearCofactor(Point2, this);
        return this.multiplyUnsafe(cofactor);
      }
      isSmallOrder() {
        if (cofactor === _1n)
          return this.is0();
        return this.clearCofactor().is0();
      }
      toBytes(isCompressed = true) {
        abool(isCompressed, "isCompressed");
        this.assertValidity();
        return encodePoint(Point2, this, isCompressed);
      }
      toHex(isCompressed = true) {
        return bytesToHex(this.toBytes(isCompressed));
      }
      toString() {
        return `<Point ${this.is0() ? "ZERO" : this.toHex()}>`;
      }
    }
    const bits = Fn2.BITS;
    const wnaf = new wNAF(Point2, extraOpts.endo ? Math.ceil(bits / 2) : bits);
    if (bits >= 8)
      Point2.BASE.precompute(8);
    Object.freeze(Point2.prototype);
    Object.freeze(Point2);
    return Point2;
  }
  function pprefix(hasEvenY) {
    return Uint8Array.of(hasEvenY ? 2 : 3);
  }
  function getWLengths(Fp2, Fn2) {
    return {
      secretKey: Fn2.BYTES,
      publicKey: 1 + Fp2.BYTES,
      publicKeyUncompressed: 1 + 2 * Fp2.BYTES,
      publicKeyHasPrefix: true,
      // Raw compact `(r || s)` signature width; DER and recovered signatures use
      // different lengths outside this helper.
      signature: 2 * Fn2.BYTES
    };
  }
  function ecdh(Point2, ecdhOpts = {}) {
    const { Fn: Fn2 } = Point2;
    const randomBytes_ = ecdhOpts.randomBytes === void 0 ? randomBytes$1 : ecdhOpts.randomBytes;
    const lengths2 = Object.assign(getWLengths(Point2.Fp, Fn2), {
      seed: Math.max(getMinHashLength(Fn2.ORDER), 16)
    });
    function isValidSecretKey(secretKey) {
      try {
        const num = Fn2.fromBytes(secretKey);
        return Fn2.isValidNot0(num);
      } catch (error) {
        return false;
      }
    }
    function isValidPublicKey(publicKey, isCompressed) {
      const { publicKey: comp, publicKeyUncompressed } = lengths2;
      try {
        const l = publicKey.length;
        if (isCompressed === true && l !== comp)
          return false;
        if (isCompressed === false && l !== publicKeyUncompressed)
          return false;
        return !!Point2.fromBytes(publicKey);
      } catch (error) {
        return false;
      }
    }
    function randomSecretKey(seed) {
      seed = seed === void 0 ? randomBytes_(lengths2.seed) : seed;
      return mapHashToField(abytes(seed, lengths2.seed, "seed"), Fn2.ORDER);
    }
    function getPublicKey(secretKey, isCompressed = true) {
      return Point2.BASE.multiply(Fn2.fromBytes(secretKey)).toBytes(isCompressed);
    }
    function isProbPub(item) {
      const { secretKey, publicKey, publicKeyUncompressed } = lengths2;
      const allowedLengths = Fn2._lengths;
      if (!isBytes(item))
        return void 0;
      const l = abytes(item, void 0, "key").length;
      const isPub = l === publicKey || l === publicKeyUncompressed;
      const isSec = l === secretKey || !!allowedLengths?.includes(l);
      if (isPub && isSec)
        return void 0;
      return isPub;
    }
    function getSharedSecret(secretKeyA, publicKeyB, isCompressed = true) {
      if (isProbPub(secretKeyA) === true)
        throw new Error("first arg must be private key");
      if (isProbPub(publicKeyB) === false)
        throw new Error("second arg must be public key");
      const s = Fn2.fromBytes(secretKeyA);
      const b = Point2.fromBytes(publicKeyB);
      return b.multiply(s).toBytes(isCompressed);
    }
    const utils = {
      isValidSecretKey,
      isValidPublicKey,
      randomSecretKey
    };
    const keygen = createKeygen(randomSecretKey, getPublicKey);
    Object.freeze(utils);
    Object.freeze(lengths2);
    return Object.freeze({ getPublicKey, getSharedSecret, keygen, Point: Point2, utils, lengths: lengths2 });
  }
  function ecdsa(Point2, hash, ecdsaOpts = {}) {
    const hash_ = hash;
    ahash(hash_);
    validateObject(ecdsaOpts, {}, {
      hmac: "function",
      lowS: "boolean",
      randomBytes: "function",
      bits2int: "function",
      bits2int_modN: "function"
    });
    ecdsaOpts = Object.assign({}, ecdsaOpts);
    const randomBytes2 = ecdsaOpts.randomBytes === void 0 ? randomBytes$1 : ecdsaOpts.randomBytes;
    const hmac$1 = ecdsaOpts.hmac === void 0 ? (key, msg) => hmac(hash_, key, msg) : ecdsaOpts.hmac;
    const { Fp: Fp2, Fn: Fn2 } = Point2;
    const { ORDER: CURVE_ORDER, BITS: fnBits } = Fn2;
    const { keygen, getPublicKey, getSharedSecret, utils, lengths: lengths2 } = ecdh(Point2, ecdsaOpts);
    const defaultSigOpts = {
      prehash: true,
      lowS: typeof ecdsaOpts.lowS === "boolean" ? ecdsaOpts.lowS : true,
      format: "compact",
      extraEntropy: false
    };
    const hasLargeRecoveryLifts = CURVE_ORDER * _2n + _1n < Fp2.ORDER;
    function isBiggerThanHalfOrder(number2) {
      const HALF = CURVE_ORDER >> _1n;
      return number2 > HALF;
    }
    function validateRS(title, num) {
      if (!Fn2.isValidNot0(num))
        throw new Error(`invalid signature ${title}: out of range 1..Point.Fn.ORDER`);
      return num;
    }
    function assertRecoverableCurve() {
      if (hasLargeRecoveryLifts)
        throw new Error('"recovered" sig type is not supported for cofactor >2 curves');
    }
    function validateSigLength(bytes, format) {
      validateSigFormat(format);
      const size = lengths2.signature;
      const sizer = format === "compact" ? size : format === "recovered" ? size + 1 : void 0;
      return abytes(bytes, sizer);
    }
    class Signature2 {
      r;
      s;
      recovery;
      constructor(r, s, recovery) {
        this.r = validateRS("r", r);
        this.s = validateRS("s", s);
        if (recovery != null) {
          assertRecoverableCurve();
          if (![0, 1, 2, 3].includes(recovery))
            throw new Error("invalid recovery id");
          this.recovery = recovery;
        }
        Object.freeze(this);
      }
      static fromBytes(bytes, format = defaultSigOpts.format) {
        validateSigLength(bytes, format);
        let recid;
        if (format === "der") {
          const { r: r2, s: s2 } = DER.toSig(abytes(bytes));
          return new Signature2(r2, s2);
        }
        if (format === "recovered") {
          recid = bytes[0];
          format = "compact";
          bytes = bytes.subarray(1);
        }
        const L3 = lengths2.signature / 2;
        const r = bytes.subarray(0, L3);
        const s = bytes.subarray(L3, L3 * 2);
        return new Signature2(Fn2.fromBytes(r), Fn2.fromBytes(s), recid);
      }
      static fromHex(hex2, format) {
        return this.fromBytes(hexToBytes(hex2), format);
      }
      assertRecovery() {
        const { recovery } = this;
        if (recovery == null)
          throw new Error("invalid recovery id: must be present");
        return recovery;
      }
      addRecoveryBit(recovery) {
        return new Signature2(this.r, this.s, recovery);
      }
      // Unlike the top-level helper below, this method expects a digest that has
      // already been hashed to the curve's message representative.
      recoverPublicKey(messageHash) {
        const { r, s } = this;
        const recovery = this.assertRecovery();
        const radj = recovery === 2 || recovery === 3 ? r + CURVE_ORDER : r;
        if (!Fp2.isValid(radj))
          throw new Error("invalid recovery id: sig.r+curve.n != R.x");
        const x = Fp2.toBytes(radj);
        const R = Point2.fromBytes(concatBytes(pprefix((recovery & 1) === 0), x));
        const ir = Fn2.inv(radj);
        const h2 = bits2int_modN2(abytes(messageHash, void 0, "msgHash"));
        const u1 = Fn2.create(-h2 * ir);
        const u2 = Fn2.create(s * ir);
        const Q = Point2.BASE.multiplyUnsafe(u1).add(R.multiplyUnsafe(u2));
        if (Q.is0())
          throw new Error("invalid recovery: point at infinify");
        Q.assertValidity();
        return Q;
      }
      // Signatures should be low-s, to prevent malleability.
      hasHighS() {
        return isBiggerThanHalfOrder(this.s);
      }
      toBytes(format = defaultSigOpts.format) {
        validateSigFormat(format);
        if (format === "der")
          return hexToBytes(DER.hexFromSig(this));
        const { r, s } = this;
        const rb = Fn2.toBytes(r);
        const sb = Fn2.toBytes(s);
        if (format === "recovered") {
          assertRecoverableCurve();
          return concatBytes(Uint8Array.of(this.assertRecovery()), rb, sb);
        }
        return concatBytes(rb, sb);
      }
      toHex(format) {
        return bytesToHex(this.toBytes(format));
      }
    }
    Object.freeze(Signature2.prototype);
    Object.freeze(Signature2);
    const bits2int2 = ecdsaOpts.bits2int === void 0 ? function bits2int_def(bytes) {
      if (bytes.length > 8192)
        throw new Error("input is too large");
      const num = bytesToNumberBE(bytes);
      const delta = bytes.length * 8 - fnBits;
      return delta > 0 ? num >> BigInt(delta) : num;
    } : ecdsaOpts.bits2int;
    const bits2int_modN2 = ecdsaOpts.bits2int_modN === void 0 ? function bits2int_modN_def(bytes) {
      return Fn2.create(bits2int2(bytes));
    } : ecdsaOpts.bits2int_modN;
    const ORDER_MASK = bitMask(fnBits);
    function int2octets(num) {
      aInRange("num < 2^" + fnBits, num, _0n, ORDER_MASK);
      return Fn2.toBytes(num);
    }
    function validateMsgAndHash(message, prehash) {
      abytes(message, void 0, "message");
      return prehash ? abytes(hash_(message), void 0, "prehashed message") : message;
    }
    function prepSig(message, secretKey, opts) {
      const { lowS, prehash, extraEntropy } = validateSigOpts(opts, defaultSigOpts);
      message = validateMsgAndHash(message, prehash);
      const h1int = bits2int_modN2(message);
      const d = Fn2.fromBytes(secretKey);
      if (!Fn2.isValidNot0(d))
        throw new Error("invalid private key");
      const seedArgs = [int2octets(d), int2octets(h1int)];
      if (extraEntropy != null && extraEntropy !== false) {
        const e = extraEntropy === true ? randomBytes2(lengths2.secretKey) : extraEntropy;
        seedArgs.push(abytes(e, void 0, "extraEntropy"));
      }
      const seed = concatBytes(...seedArgs);
      const m = h1int;
      function k2sig(kBytes) {
        const k = bits2int2(kBytes);
        if (!Fn2.isValidNot0(k))
          return;
        const ik = Fn2.inv(k);
        const q = Point2.BASE.multiply(k).toAffine();
        const r = Fn2.create(q.x);
        if (r === _0n)
          return;
        const s = Fn2.create(ik * Fn2.create(m + r * d));
        if (s === _0n)
          return;
        let recovery = (q.x === r ? 0 : 2) | Number(q.y & _1n);
        let normS = s;
        if (lowS && isBiggerThanHalfOrder(s)) {
          normS = Fn2.neg(s);
          recovery ^= 1;
        }
        return new Signature2(r, normS, hasLargeRecoveryLifts ? void 0 : recovery);
      }
      return { seed, k2sig };
    }
    function sign2(message, secretKey, opts = {}) {
      const { seed, k2sig } = prepSig(message, secretKey, opts);
      const drbg = createHmacDrbg(hash_.outputLen, Fn2.BYTES, hmac$1);
      const sig = drbg(seed, k2sig);
      return sig.toBytes(opts.format);
    }
    function verify(signature, message, publicKey, opts = {}) {
      const { lowS, prehash, format } = validateSigOpts(opts, defaultSigOpts);
      publicKey = abytes(publicKey, void 0, "publicKey");
      message = validateMsgAndHash(message, prehash);
      if (!isBytes(signature)) {
        const end = signature instanceof Signature2 ? ", use sig.toBytes()" : "";
        throw new Error("verify expects Uint8Array signature" + end);
      }
      validateSigLength(signature, format);
      try {
        const sig = Signature2.fromBytes(signature, format);
        const P2 = Point2.fromBytes(publicKey);
        if (lowS && sig.hasHighS())
          return false;
        const { r, s } = sig;
        const h2 = bits2int_modN2(message);
        const is = Fn2.inv(s);
        const u1 = Fn2.create(h2 * is);
        const u2 = Fn2.create(r * is);
        const R = Point2.BASE.multiplyUnsafe(u1).add(P2.multiplyUnsafe(u2));
        if (R.is0())
          return false;
        const v = Fn2.create(R.x);
        return v === r;
      } catch (e) {
        return false;
      }
    }
    function recoverPublicKey(signature, message, opts = {}) {
      const { prehash } = validateSigOpts(opts, defaultSigOpts);
      message = validateMsgAndHash(message, prehash);
      return Signature2.fromBytes(signature, "recovered").recoverPublicKey(message).toBytes();
    }
    return Object.freeze({
      keygen,
      getPublicKey,
      getSharedSecret,
      utils,
      lengths: lengths2,
      Point: Point2,
      sign: sign2,
      verify,
      recoverPublicKey,
      Signature: Signature2,
      hash: hash_
    });
  }
  const p256_CURVE = /* @__PURE__ */ (() => ({
    p: BigInt("0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff"),
    n: BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551"),
    h: BigInt(1),
    a: BigInt("0xffffffff00000001000000000000000000000000fffffffffffffffffffffffc"),
    b: BigInt("0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b"),
    Gx: BigInt("0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296"),
    Gy: BigInt("0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5")
  }))();
  const p256_Point = /* @__PURE__ */ weierstrass(p256_CURVE);
  const p256 = /* @__PURE__ */ ecdsa(p256_Point, sha256);
  function readLength(bytes, offset, info) {
    if (info < 24) return [info, offset];
    if (info === 24) return [at(bytes, offset), offset + 1];
    if (info === 25) return [at(bytes, offset) << 8 | at(bytes, offset + 1), offset + 2];
    if (info === 26) {
      return [
        at(bytes, offset) * 16777216 + (at(bytes, offset + 1) << 16 | at(bytes, offset + 2) << 8 | at(bytes, offset + 3)),
        offset + 4
      ];
    }
    throw new Error("CBOR: unsupported length encoding");
  }
  function at(bytes, offset) {
    const b = bytes[offset];
    if (b === void 0) throw new Error("CBOR: unexpected end of input");
    return b;
  }
  function decodeItem(bytes, offset) {
    const initial = at(bytes, offset);
    const major = initial >> 5;
    const info = initial & 31;
    offset += 1;
    switch (major) {
      case 0: {
        const [value, next] = readLength(bytes, offset, info);
        return [value, next];
      }
      case 1: {
        const [value, next] = readLength(bytes, offset, info);
        return [-1 - value, next];
      }
      case 2: {
        const [len, next] = readLength(bytes, offset, info);
        return [bytes.slice(next, next + len), next + len];
      }
      case 3: {
        const [len, next] = readLength(bytes, offset, info);
        return [new TextDecoder().decode(bytes.slice(next, next + len)), next + len];
      }
      case 4: {
        const [len, next] = readLength(bytes, offset, info);
        const items = [];
        let cursor = next;
        for (let i = 0; i < len; i++) {
          const [item, after] = decodeItem(bytes, cursor);
          items.push(item);
          cursor = after;
        }
        return [items, cursor];
      }
      case 5: {
        const [len, next] = readLength(bytes, offset, info);
        const map = /* @__PURE__ */ new Map();
        let cursor = next;
        for (let i = 0; i < len; i++) {
          const [key, afterKey] = decodeItem(bytes, cursor);
          const [value, afterValue] = decodeItem(bytes, afterKey);
          if (typeof key !== "number" && typeof key !== "string") {
            throw new Error("CBOR: unsupported map key type");
          }
          map.set(key, value);
          cursor = afterValue;
        }
        return [map, cursor];
      }
      default:
        throw new Error(`CBOR: unsupported major type ${major}`);
    }
  }
  function decodeCbor(bytes) {
    return decodeItem(bytes, 0)[0];
  }
  function compressP256Uncompressed(uncompressed) {
    return p256.Point.fromBytes(uncompressed).toBytes(true);
  }
  function extractCosePublicKey(authData) {
    const flags = at(authData, 32);
    if ((flags & 64) === 0) {
      throw new Error("WebAuthn: attested credential data flag (AT) not set");
    }
    const credIdLen = at(authData, 53) << 8 | at(authData, 54);
    const coseStart = 55 + credIdLen;
    const cose = decodeItem(authData, coseStart)[0];
    if (!(cose instanceof Map)) throw new Error("WebAuthn: COSE key is not a map");
    const kty = cose.get(1);
    const alg = cose.get(3);
    if (kty === 2 && alg === -7) {
      if (cose.get(-1) !== 1) throw new Error("WebAuthn: unsupported EC2 curve");
      const x = cose.get(-2);
      const y = cose.get(-3);
      if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array)) {
        throw new Error("WebAuthn: malformed EC2 COSE key");
      }
      const uncompressed = concatBytes$1(new Uint8Array([4]), x, y);
      return { curve: "p256", bytes: compressP256Uncompressed(uncompressed) };
    }
    if (kty === 1 && alg === -8) {
      if (cose.get(-1) !== 6) throw new Error("WebAuthn: unsupported OKP curve");
      const x = cose.get(-2);
      if (!(x instanceof Uint8Array) || x.length !== 32) {
        throw new Error("WebAuthn: malformed OKP COSE key");
      }
      return { curve: "ed25519", bytes: x };
    }
    throw new Error(`WebAuthn: unsupported COSE key (kty=${String(kty)}, alg=${String(alg)})`);
  }
  const ED25519_SPKI_PREFIX = new Uint8Array([
    48,
    42,
    48,
    5,
    6,
    3,
    43,
    101,
    112,
    3,
    33,
    0
  ]);
  function extractSpkiPublicKey(spki) {
    if (spki.length === 44 && ED25519_SPKI_PREFIX.every((byte, index) => spki[index] === byte)) {
      return { curve: "ed25519", bytes: spki.slice(12) };
    }
    if (spki.length === 91 && spki[26] === 4) {
      return { curve: "p256", bytes: compressP256Uncompressed(spki.slice(26)) };
    }
    if (spki.length === 65 && spki[0] === 4) {
      return { curve: "p256", bytes: compressP256Uncompressed(spki) };
    }
    throw new Error(`WebAuthn: unsupported SPKI public key (${spki.length} bytes)`);
  }
  function extractCredentialPublicKey(result2) {
    if (result2.publicKey && result2.publicKey.length > 0) {
      try {
        return extractSpkiPublicKey(new Uint8Array(result2.publicKey));
      } catch {
      }
    }
    const attestation = decodeCbor(new Uint8Array(result2.attestationObject));
    if (!(attestation instanceof Map)) {
      throw new Error("WebAuthn: malformed attestation object");
    }
    const authData = attestation.get("authData");
    if (!(authData instanceof Uint8Array)) {
      throw new Error("WebAuthn: attestation object has no authData");
    }
    return extractCosePublicKey(authData);
  }
  const P256_ORDER = p256.Point.Fn.ORDER;
  function derToRawLowS(der) {
    const sig = p256.Signature.fromBytes(der, "der");
    const normalized = sig.s * 2n > P256_ORDER ? new p256.Signature(sig.r, P256_ORDER - sig.s) : sig;
    return normalized.toBytes("compact");
  }
  function assertionSignedBytes(authenticatorData, clientDataJson) {
    return concatBytes$1(authenticatorData, sha256(clientDataJson));
  }
  function verifyAssertion(publicKey, assertion) {
    const signedBytes = assertionSignedBytes(
      new Uint8Array(assertion.authenticatorData),
      new Uint8Array(assertion.clientDataJSON)
    );
    try {
      if (publicKey.curve === "p256") {
        const raw = derToRawLowS(new Uint8Array(assertion.signature));
        return p256.verify(raw, signedBytes, publicKey.bytes, { format: "compact" });
      }
      return ed25519.verify(new Uint8Array(assertion.signature), signedBytes, publicKey.bytes);
    } catch {
      return false;
    }
  }
  function signatureToString(curve, signature) {
    if (curve === "p256") {
      return `p256:${base58.encode(derToRawLowS(signature))}`;
    }
    if (signature.length !== 64) throw new Error("WebAuthn: ed25519 signature must be 64 bytes");
    return `ed25519:${base58.encode(signature)}`;
  }
  function buildProof(curve, assertion) {
    return JSON.stringify({
      authenticator_data: base64urlnopad.encode(new Uint8Array(assertion.authenticatorData)),
      client_data_json: new TextDecoder().decode(new Uint8Array(assertion.clientDataJSON)),
      signature: signatureToString(curve, new Uint8Array(assertion.signature))
    });
  }
  function rawIdToB64(rawId) {
    return base64urlnopad.encode(
      rawId instanceof Uint8Array ? rawId : new Uint8Array(rawId)
    );
  }
  function b64ToRawId(b64) {
    return Array.from(base64urlnopad.decode(b64));
  }
  let cachedClient = null;
  function rpcUrl() {
    const url2 = selector().providers.mainnet[0];
    if (!url2) throw new Error("no mainnet RPC provider configured");
    return url2;
  }
  function getClient() {
    if (!cachedClient) {
      cachedClient = throwableCreateClient({
        transport: {
          rpcEndpoints: { regular: selector().providers.mainnet.map((url2) => ({ url: url2 })) }
        }
      });
    }
    return cachedClient;
  }
  function assertMainnet(network) {
    if (network && network !== CHAIN_ID) {
      throw new Error("Passkey wallet supports mainnet only");
    }
  }
  async function accountExists(client, accountId) {
    const info = await client.safeGetAccountInfo({ accountId });
    if (info.ok) return true;
    if (isNatError(info.error, "Client.GetAccountInfo.Rpc.Account.NotFound")) return false;
    throw info.error;
  }
  function randomBytes(length) {
    return Array.from(crypto.getRandomValues(new Uint8Array(length)));
  }
  async function webauthnCreate(name) {
    return selector().webauthn.create({
      challenge: randomBytes(32),
      rp: { name },
      user: { id: randomBytes(16), name, displayName: name },
      pubKeyCredParams: [
        { alg: -8, type: "public-key" },
        // EdDSA (Ed25519)
        { alg: -7, type: "public-key" }
        // ES256 (P-256)
      ],
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
      attestation: "none"
    });
  }
  async function webauthnGet(challenge, rawIdB64) {
    const options = {
      challenge: Array.from(challenge),
      userVerification: "preferred"
    };
    if (rawIdB64) {
      options["allowCredentials"] = [
        { id: b64ToRawId(rawIdB64), type: "public-key" }
      ];
    }
    return selector().webauthn.get(options);
  }
  async function resolveCredential(assertion) {
    const rawIdB64 = rawIdToB64(assertion.rawId);
    const known = await getKnownCredentials();
    const cached2 = known[rawIdB64];
    const candidates = cached2 ? [cached2.publicKey] : [];
    if (candidates.length === 0) {
      candidates.push(...await registryGet(getClient(), rawIdB64));
    }
    for (const candidate of candidates) {
      let publicKey;
      try {
        publicKey = publicKeyFromString(candidate);
      } catch {
        continue;
      }
      if (verifyAssertion(publicKey, assertion)) {
        const accountId = deriveAccountId(publicKey);
        await addKnownCredential(rawIdB64, {
          publicKey: candidate,
          curve: publicKey.curve,
          accountId
        });
        return { rawIdB64, publicKey, accountId };
      }
    }
    throw new Error(
      "This passkey is not registered in the passkeys registry (or the registered keys do not match its signature). Create it again on the original device or register it first."
    );
  }
  function toActiveCredential(resolved) {
    return {
      rawId: resolved.rawIdB64,
      publicKey: publicKeyToString(resolved.publicKey),
      curve: resolved.publicKey.curve,
      accountId: resolved.accountId,
      registeredAt: Date.now()
    };
  }
  function toAccount(active) {
    return { accountId: active.accountId, publicKey: active.publicKey };
  }
  async function registerWithUi(rawIdB64, publicKey) {
    for (; ; ) {
      try {
        await registryRegister(getClient(), rawIdB64, publicKey);
        return;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const retry = await promptRetryRegistration(message);
        if (!retry) {
          throw new Error(`Passkey registration cancelled: ${message}`);
        }
      }
    }
  }
  async function retryPendingRegistration() {
    const pending = await getPendingRegistration();
    if (!pending) return;
    await registerWithUi(pending.rawIdB64, pending.publicKey);
    await clearPendingRegistration();
    const publicKey = publicKeyFromString(pending.publicKey);
    await addKnownCredential(pending.rawIdB64, {
      publicKey: pending.publicKey,
      curve: pending.curve,
      accountId: deriveAccountId(publicKey)
    });
  }
  async function createNewPasskey() {
    const name = await promptPasskeyName();
    const created = await webauthnCreate(name);
    const publicKey = extractCredentialPublicKey(created);
    const publicKeyStr = publicKeyToString(publicKey);
    const rawIdB64 = rawIdToB64(created.rawId);
    const accountId = deriveAccountId(publicKey);
    await setPendingRegistration({
      rawIdB64,
      publicKey: publicKeyStr,
      curve: publicKey.curve
    });
    await registerWithUi(rawIdB64, publicKeyStr);
    await clearPendingRegistration();
    await addKnownCredential(rawIdB64, {
      publicKey: publicKeyStr,
      curve: publicKey.curve,
      accountId
    });
    const active = {
      rawId: rawIdB64,
      publicKey: publicKeyStr,
      curve: publicKey.curve,
      accountId,
      registeredAt: Date.now()
    };
    await setActiveCredential(active);
    return active;
  }
  async function useExistingPasskey() {
    const assertion = await webauthnGet(new Uint8Array(randomBytes(32)));
    let resolved;
    try {
      resolved = await resolveCredential(assertion);
    } catch (e) {
      await showErrorDialog(
        "Passkey not registered",
        e instanceof Error ? e.message : String(e)
      );
      throw e;
    }
    const active = toActiveCredential(resolved);
    await setActiveCredential(active);
    return active;
  }
  async function requireActive() {
    const active = await getActiveCredential();
    if (!active) throw new Error("Wallet not signed in");
    return active;
  }
  async function signRequestMessage(active, request) {
    const msg = buildRequestMessage(active.accountId, await nextNonce(), request);
    const assertion = await webauthnGet(requestMessageHash(msg), active.rawId);
    return { msg, proof: buildProof(active.curve, assertion) };
  }
  async function executeRequest(active, request) {
    const client = getClient();
    const { msg, proof } = await signRequestMessage(active, request);
    const exists = await accountExists(client, active.accountId);
    const stateInit = exists ? null : serializeDefaultStateInit(publicKeyFromString(active.publicKey));
    return relayExecuteSigned(client, rpcUrl(), active.accountId, msg, proof, stateInit);
  }
  async function ensureAccountOnChain(active) {
    const client = getClient();
    if (await accountExists(client, active.accountId)) return;
    await relayStateInit(
      client,
      rpcUrl(),
      active.accountId,
      serializeDefaultStateInit(publicKeyFromString(active.publicKey))
    );
  }
  const NEP413_TAG = 2 ** 31 + 413;
  function nep413PayloadHash(message, recipient, nonce) {
    if (nonce.length !== 32) throw new Error("NEP-413 nonce must be 32 bytes");
    const w = new BorshWriter();
    w.writeU32(NEP413_TAG);
    w.writeString(message);
    w.writeFixedBytes(nonce);
    w.writeString(recipient);
    w.writeU8(0);
    return sha256(w.toBytes());
  }
  const wallet = {
    // Overwritten by `selector.ready()` with the real manifest.
    manifest: {},
    async signIn(params) {
      assertMainnet(params?.network);
      if (params?.addFunctionCallKey) {
        throw new Error("Function-call access keys are not supported by passkey wallet accounts");
      }
      await retryPendingRegistration();
      const existing = await getActiveCredential();
      if (existing) return [toAccount(existing)];
      const choice = await promptSignInChoice();
      const active = choice === "create" ? await createNewPasskey() : await useExistingPasskey();
      return [toAccount(active)];
    },
    async signInAndSignMessage(params) {
      const accounts = await this.signIn(params);
      const account = accounts[0];
      if (!account) throw new Error("sign-in produced no account");
      const signedMessage = await this.signMessage({
        message: params.messageParams.message,
        recipient: params.messageParams.recipient,
        nonce: params.messageParams.nonce,
        network: params.network
      });
      return [{ ...account, signedMessage }];
    },
    async signOut() {
      await clearActiveCredential();
    },
    async getAccounts() {
      const active = await getActiveCredential();
      return active ? [toAccount(active)] : [];
    },
    async signMessage(params) {
      assertMainnet(params.network);
      const active = await requireActive();
      const nonce = params.nonce instanceof Uint8Array ? params.nonce : new Uint8Array(params.nonce);
      const challenge = nep413PayloadHash(params.message, params.recipient, nonce);
      const assertion = await webauthnGet(challenge, active.rawId);
      const proof = buildProof(active.curve, assertion);
      return {
        accountId: active.accountId,
        publicKey: active.publicKey,
        signature: base64.encode(new TextEncoder().encode(proof))
      };
    },
    async signAndSendTransaction(params) {
      assertMainnet(params.network);
      const active = await requireActive();
      const request = {
        external: connectorActionsToPromises([
          { receiverId: params.receiverId, actions: params.actions }
        ])
      };
      return executeRequest(active, request);
    },
    async signAndSendTransactions(params) {
      assertMainnet(params.network);
      const active = await requireActive();
      const request = {
        external: connectorActionsToPromises(params.transactions)
      };
      const outcome = await executeRequest(active, request);
      return params.transactions.map(() => outcome);
    },
    async signDelegateActions(params) {
      assertMainnet(params.network);
      const active = await requireActive();
      const request = {
        external: connectorActionsToPromises(
          params.delegateActions.map((d) => ({
            receiverId: d.receiverId,
            actions: d.actions
          }))
        )
      };
      const { msg, proof } = await signRequestMessage(active, request);
      const stateInit = base64.encode(
        serializeDefaultStateInit(publicKeyFromString(active.publicKey))
      );
      const blob = JSON.stringify({ msg, proof, stateInit });
      return { signedDelegateActions: [base64.encode(new TextEncoder().encode(blob))] };
    },
    async resolveAuth(params) {
      assertMainnet(params.network);
      const signedIn = await getActiveCredential();
      const message = buildAuthMessage({ ...params, config: DEFAULT_WALLET_CONFIG });
      const challenge = authMessageHash(message);
      if (signedIn) {
        await ensureAccountOnChain(signedIn);
        const assertion2 = await webauthnGet(challenge, signedIn.rawId);
        return {
          accountId: signedIn.accountId,
          authorization: buildAuthorizationBlob(message, buildProof(signedIn.curve, assertion2))
        };
      }
      const assertion = await webauthnGet(challenge);
      const resolved = await resolveCredential(assertion);
      const active = toActiveCredential(resolved);
      await setActiveCredential(active);
      try {
        await ensureAccountOnChain(active);
      } catch (e) {
        await clearActiveCredential();
        throw e;
      }
      return {
        accountId: resolved.accountId,
        authorization: buildAuthorizationBlob(
          message,
          buildProof(resolved.publicKey.curve, assertion)
        )
      };
    }
  };
  selector().ready(wallet);
})();
