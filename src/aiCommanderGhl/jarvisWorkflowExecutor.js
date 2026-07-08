const { executeGhlRequest } = require("./ghlUniversalExecutor");
const { redact } = require("./ghlClient");

const DEFAULT_MAX_STEPS = 50000;

function cleanString(value) {
  return String(value ?? "").trim();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function splitPath(path) {
  return cleanString(path)
    .replace(/^\$?\./, "")
    .split(".")
    .map(cleanString)
    .filter(Boolean);
}

function getPath(source, path, fallback = undefined) {
  if (!path || path === "$") return source;
  let current = source;
  for (const part of splitPath(path)) {
    if (current === undefined || current === null) return fallback;
    current = current[part];
  }
  return current === undefined ? fallback : current;
}

function setPath(target, path, value) {
  const parts = splitPath(path);
  if (!parts.length) return;
  let current = target;
  for (const part of parts.slice(0, -1)) {
    if (!current[part] || typeof current[part] !== "object") current[part] = {};
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
}

function pushPath(target, path, value) {
  const existing = getPath(target, path);
  if (!Array.isArray(existing)) {
    setPath(target, path, []);
  }
  getPath(target, path).push(value);
}

function renderTemplate(template, variables) {
  return cleanString(template).replace(/\$\{([^}]+)\}/g, (_, expression) => {
    const value = getPath(variables, expression);
    if (value === undefined || value === null) return "";
    if (typeof value === "object") return JSON.stringify(redact(value));
    return String(value);
  });
}

async function resolveValue(value, helpers) {
  if (typeof value === "function") return value(helpers);
  if (typeof value === "string") {
    if (value.startsWith("$.")) return getPath(helpers.variables, value);
    return renderTemplate(value, helpers.variables);
  }
  if (Array.isArray(value)) {
    const resolved = [];
    for (const item of value) resolved.push(await resolveValue(item, helpers));
    return resolved;
  }
  if (value && typeof value === "object") {
    if (Object.prototype.hasOwnProperty.call(value, "$path")) {
      return getPath(helpers.variables, value.$path);
    }
    if (Object.prototype.hasOwnProperty.call(value, "$template")) {
      return renderTemplate(value.$template, helpers.variables);
    }
    const resolved = {};
    for (const [key, item] of Object.entries(value)) {
      resolved[key] = await resolveValue(item, helpers);
    }
    return resolved;
  }
  return value;
}

function evaluateCondition(condition, helpers) {
  if (typeof condition === "function") return condition(helpers);
  if (!condition || typeof condition !== "object") return Boolean(condition);

  const left = Object.prototype.hasOwnProperty.call(condition, "path")
    ? getPath(helpers.variables, condition.path)
    : condition.value;

  if (condition.exists === true) return left !== undefined && left !== null && left !== "";
  if (condition.notEmpty === true) {
    if (Array.isArray(left)) return left.length > 0;
    return left !== undefined && left !== null && cleanString(left) !== "";
  }
  if (Object.prototype.hasOwnProperty.call(condition, "equals")) {
    return left === condition.equals;
  }
  if (Object.prototype.hasOwnProperty.call(condition, "notEquals")) {
    return left !== condition.notEquals;
  }
  if (Object.prototype.hasOwnProperty.call(condition, "includes")) {
    return Array.isArray(left)
      ? left.includes(condition.includes)
      : cleanString(left).includes(cleanString(condition.includes));
  }
  if (Object.prototype.hasOwnProperty.call(condition, "greaterThan")) {
    return Number(left) > Number(condition.greaterThan);
  }
  if (Object.prototype.hasOwnProperty.call(condition, "lessThan")) {
    return Number(left) < Number(condition.lessThan);
  }
  return Boolean(left);
}

function stepType(step) {
  return cleanString(step?.type || step?.kind || step?.stepType).toLowerCase();
}

function workflowError(error, step) {
  return redact({
    stepId: cleanString(step?.id || step?.name || stepType(step)),
    type: stepType(step),
    message: error?.message || String(error || "Workflow step failed"),
    statusCode: error?.statusCode || null,
    ghlStatus: error?.ghlStatus || null,
    request: error?.request || null,
    response: error?.response || null,
  });
}

async function executeWorkflow({
  name,
  steps = [],
  context = {},
  dryRun = false,
  approvalRequired = false,
  approved = false,
  confirmationPhrase = "",
  adminUserId = null,
  userRequest = "",
  onProgress,
  maxSteps = DEFAULT_MAX_STEPS,
} = {}) {
  const state = {
    name: cleanString(name) || "jarvis_workflow",
    dryRun: dryRun === true,
    approvalRequired: approvalRequired === true,
    approved: approved === true,
    variables: { ...(context || {}) },
    progress: [],
    errors: [],
    report: {},
    stepCount: 0,
    stepStats: {
      total: 0,
      byType: {},
      apiCalls: 0,
      loopIterations: 0,
      conditionsPassed: 0,
      conditionsFailed: 0,
      reportsGenerated: 0,
      errors: 0,
    },
  };

  const emitProgress = async (message, meta = {}) => {
    const event = {
      at: new Date().toISOString(),
      message: cleanString(message),
      meta: redact(meta),
    };
    if (!event.message) return;
    state.progress.push(event);
    if (typeof onProgress === "function") await onProgress(event, state);
  };

  const helpers = {
    get state() {
      return state;
    },
    get variables() {
      return state.variables;
    },
    emitProgress,
    getPath: (path, fallback) => getPath(state.variables, path, fallback),
    setPath: (path, value) => setPath(state.variables, path, value),
    pushPath: (path, value) => pushPath(state.variables, path, value),
    resolveValue: (value) => resolveValue(value, helpers),
    apiCall: async (requestShape) =>
      executeGhlRequest({
        ...requestShape,
        dryRun: requestShape.dryRun ?? state.dryRun,
        approved: requestShape.approved ?? state.approved,
        confirmationPhrase: requestShape.confirmationPhrase || confirmationPhrase,
        adminUserId,
        userRequest,
      }),
  };

  async function runStep(step) {
    state.stepCount += 1;
    if (state.stepCount > maxSteps) {
      const error = new Error("Workflow exceeded the maximum safe step limit.");
      error.statusCode = 429;
      throw error;
    }

    const type = stepType(step);
    const statType = type || "unknown";
    state.stepStats.total += 1;
    state.stepStats.byType[statType] = Number(state.stepStats.byType[statType] || 0) + 1;
    try {
      if (type === "progress") {
        await emitProgress(await resolveValue(step.message, helpers), step.meta || {});
        return null;
      }

      if (type === "set" || type === "variable") {
        setPath(state.variables, step.var || step.name, await resolveValue(step.value, helpers));
        return null;
      }

      if (type === "array_push" || type === "push") {
        pushPath(state.variables, step.target || step.var, await resolveValue(step.value, helpers));
        return null;
      }

      if (type === "delay") {
        await wait(Math.max(0, Math.min(30000, Number(step.ms || 0))));
        return null;
      }

      if (type === "api_call" || type === "api") {
        state.stepStats.apiCalls += 1;
        const result = await helpers.apiCall({
          method: await resolveValue(step.method, helpers),
          path: await resolveValue(step.path, helpers),
          query: await resolveValue(step.query || {}, helpers),
          body: await resolveValue(step.body || {}, helpers),
          reason: await resolveValue(step.reason || step.description || "", helpers),
          dryRun: step.dryRun,
        });
        if (step.resultVar) setPath(state.variables, step.resultVar, result);
        return result;
      }

      if (type === "map") {
        if (typeof step.handler === "function") {
          const result = await step.handler(helpers);
          if (step.resultVar) setPath(state.variables, step.resultVar, result);
          return result;
        }
        const items = await resolveValue(step.items || [], helpers);
        const list = Array.isArray(items) ? items : [];
        const itemVar = cleanString(step.itemVar) || "item";
        const mapped = [];
        for (let index = 0; index < list.length; index += 1) {
          state.variables[itemVar] = list[index];
          state.variables.index = index;
          state.variables.indexDisplay = index + 1;
          mapped.push(await resolveValue(step.value ?? `$.${itemVar}`, helpers));
        }
        if (step.resultVar) setPath(state.variables, step.resultVar, mapped);
        return mapped;
      }

      if (type === "filter") {
        if (typeof step.handler === "function") {
          const result = await step.handler(helpers);
          if (step.resultVar) setPath(state.variables, step.resultVar, result);
          return result;
        }
        const items = await resolveValue(step.items || [], helpers);
        const list = Array.isArray(items) ? items : [];
        const itemVar = cleanString(step.itemVar) || "item";
        const filtered = [];
        for (let index = 0; index < list.length; index += 1) {
          state.variables[itemVar] = list[index];
          state.variables.index = index;
          state.variables.indexDisplay = index + 1;
          if (evaluateCondition(step.where || step.condition || step.if, helpers)) {
            filtered.push(list[index]);
          }
        }
        if (step.resultVar) setPath(state.variables, step.resultVar, filtered);
        return filtered;
      }

      if (type === "transform") {
        if (typeof step.handler !== "function") {
          const error = new Error(`${type} step requires a handler function.`);
          error.statusCode = 400;
          throw error;
        }
        const result = await step.handler(helpers);
        if (step.resultVar) setPath(state.variables, step.resultVar, result);
        return result;
      }

      if (type === "condition" || type === "if") {
        const passed = await evaluateCondition(step.if || step.condition || step.test, helpers);
        if (passed) state.stepStats.conditionsPassed += 1;
        else state.stepStats.conditionsFailed += 1;
        await runSteps(passed ? step.then || [] : step.else || []);
        return passed;
      }

      if (type === "loop") {
        const items = await resolveValue(step.items || [], helpers);
        const list = Array.isArray(items) ? items : [];
        const itemVar = cleanString(step.itemVar) || "item";
        const indexVar = cleanString(step.indexVar) || "index";
        const progressEvery = Math.max(0, Number(step.progressEvery || 0));

        for (let index = 0; index < list.length; index += 1) {
          state.stepStats.loopIterations += 1;
          state.variables[itemVar] = list[index];
          state.variables[indexVar] = index;
          state.variables[`${indexVar}Display`] = index + 1;
          state.variables.loopLength = list.length;

          if (
            progressEvery > 0 &&
            (index === 0 || (index + 1) % progressEvery === 0 || index + 1 === list.length)
          ) {
            await emitProgress(
              renderTemplate(
                step.progressMessage || `Processing ${indexVar} ${index + 1} / ${list.length}...`,
                state.variables
              ),
              { index: index + 1, total: list.length }
            );
          }

          try {
            await runSteps(step.steps || []);
          } catch (error) {
            state.errors.push(workflowError(error, step));
            if (step.continueOnError !== true) throw error;
          }
        }
        return null;
      }

      if (type === "report") {
        state.stepStats.reportsGenerated += 1;
        const report = await resolveValue(step.value, helpers);
        state.report = report && typeof report === "object" ? redact(report) : { value: report };
        return state.report;
      }

      const error = new Error(`Unsupported workflow step type: ${type || "unknown"}`);
      error.statusCode = 400;
      throw error;
    } catch (error) {
      state.stepStats.errors += 1;
      if (step.continueOnError === true) {
        state.errors.push(workflowError(error, step));
        return null;
      }
      throw error;
    }
  }

  async function runSteps(items) {
    for (const step of Array.isArray(items) ? items : []) {
      await runStep(step);
    }
  }

  await runSteps(steps);

  return {
    name: state.name,
    status: state.errors.length ? "completed_with_errors" : "completed",
    dryRun: state.dryRun,
    approvalRequired: state.approvalRequired,
    approved: state.approved,
    progress: state.progress,
    errors: state.errors,
    report: state.report,
    stepCount: state.stepCount,
    stepStats: state.stepStats,
  };
}

module.exports = {
  executeWorkflow,
  getPath,
  renderTemplate,
  setPath,
};
