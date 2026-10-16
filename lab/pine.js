/* Pine Script interpreter for the NQ Strategy Lab.
 *
 * Runs a practical subset of Pine Script v5/v6 *strategies* bar by bar on OHLCV
 * arrays and simulates their orders the way TradingView does by default:
 * orders placed on a bar's close fill at the next bar's open (or at the same
 * close with process_orders_on_close=true); strategy.exit stops and targets are
 * checked against each bar's high and low.
 *
 * Exposes Pine.compile(source) -> program and Pine.run(program, bars, params, cfg).
 */
(function (root) {
"use strict";

class PineError extends Error {
  constructor(msg, line) { super(line ? `Line ${line}: ${msg}` : msg); this.line = line; }
}

// ================================================================= lexer
const OPS = [":=", "=>", "==", "!=", "<=", ">=", "+=", "-=", "*=", "/=", "%=", "+", "-", "*", "/", "%", "<", ">", "=", "?", ":", "(", ")", "[", "]", ","];
const KW = new Set(["and", "or", "not", "if", "else", "for", "to", "by", "var", "varip", "true", "false", "switch", "while", "break", "continue", "in", "import", "export", "method", "type"]);
const TYPE_WORDS = new Set(["int", "float", "bool", "string", "color", "series", "simple", "const", "input", "line", "label", "box", "table"]);
const CONT_OPS = new Set(["+", "-", "*", "/", "%", "==", "!=", "<", "<=", ">", ">=", "?", ":", ",", "(", "[", "=", ":="]);

function lexLine(s, line) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === " ") { i++; continue; }
    if (ch === "/" && s[i + 1] === "/") break;
    if (ch === '"' || ch === "'") {
      let j = i + 1, v = "";
      while (j < s.length && s[j] !== ch) {
        if (s[j] === "\\" && j + 1 < s.length) { const e = s[j + 1]; v += e === "n" ? "\n" : e === "t" ? "\t" : e; j += 2; } else v += s[j++];
      }
      if (j >= s.length) throw new PineError("A string is missing its closing quote", line);
      out.push({ t: "str", v, line }); i = j + 1; continue;
    }
    const rest = s.slice(i);
    if (ch === "#") {
      const m = /^#[0-9a-fA-F]{3,8}\b/.exec(rest);
      if (m) { out.push({ t: "str", v: m[0], line }); i += m[0].length; continue; }
    }
    const num = /^(\d+\.?\d*(e[+-]?\d+)?|\.\d+(e[+-]?\d+)?)/i.exec(rest);
    if (num) { out.push({ t: "num", v: parseFloat(num[0]), line }); i += num[0].length; continue; }
    const id = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(rest);
    if (id) { out.push({ t: KW.has(id[0]) ? "kw" : "id", v: id[0], line }); i += id[0].length; continue; }
    const op = OPS.find(o => s.startsWith(o, i));
    if (op) { out.push({ t: "op", v: op, line }); i += op.length; continue; }
    throw new PineError(`Unexpected character "${ch}"`, line);
  }
  return out;
}

// Join physical lines into logical lines: open brackets, a trailing operator, or an
// indent that isn't a multiple of 4 all continue the previous line (Pine's rules).
function logicalLines(src) {
  const phys = src.replace(/\r/g, "").split("\n"), out = [];
  let cur = null, depth = 0;
  for (let k = 0; k < phys.length; k++) {
    const raw = phys[k].replace(/\t/g, "    ");
    const toks = lexLine(raw, k + 1);
    if (!toks.length) continue;
    const indent = raw.match(/^ */)[0].length;
    const last = cur && cur.toks[cur.toks.length - 1];
    const trailing = last && ((last.t === "op" && CONT_OPS.has(last.v)) || (last.t === "kw" && (last.v === "and" || last.v === "or" || last.v === "not")));
    if (cur && (depth > 0 || indent % 4 !== 0 || trailing)) cur.toks.push(...toks);
    else { cur = { indent, toks, line: k + 1 }; out.push(cur); depth = 0; }
    for (const t of toks) if (t.t === "op") { if (t.v === "(" || t.v === "[") depth++; else if (t.v === ")" || t.v === "]") depth--; }
  }
  return out;
}

// ================================================================= parser
let NODE_ID = 0;
const mk = (k, line, props) => Object.assign({ k, line, id: ++NODE_ID }, props);

class TS {
  constructor(toks, line) { this.t = toks; this.p = 0; this.line = line; }
  peek(o = 0) { return this.t[this.p + o]; }
  next() { return this.t[this.p++]; }
  is(v, o = 0) { const x = this.t[this.p + o]; return !!x && (x.t === "op" || x.t === "kw") && x.v === v; }
  eat(v) { if (this.is(v)) { this.p++; return true; } return false; }
  expect(v) {
    if (this.eat(v)) return;
    const x = this.peek();
    throw new PineError(`Expected "${v}"${x ? ` but found "${x.v}"` : " at the end of the line"}`, x ? x.line : this.line);
  }
  done() { return this.p >= this.t.length; }
  end() { if (!this.done()) throw new PineError(`Unexpected "${this.peek().v}"`, this.peek().line); }
}

function parse(src) {
  const lines = logicalLines(src);
  let pos = 0;

  function block(minIndent) {
    if (pos >= lines.length || lines[pos].indent < minIndent)
      throw new PineError("Expected an indented block (4 spaces) after this line", lines[pos - 1] ? lines[pos - 1].line : 1);
    const ind = lines[pos].indent, body = [];
    while (pos < lines.length && lines[pos].indent >= ind) {
      if (lines[pos].indent > ind) throw new PineError("Unexpected indentation", lines[pos].line);
      body.push(statement());
    }
    return body;
  }

  // Right-hand side of = or :=, which may be an if/switch block expression.
  function rhs(ts, L) {
    if (ts.eat("if")) return ifFrom(ts, L);
    if (ts.eat("switch")) return switchFrom(ts, L);
    const e = expr(ts); ts.end(); pos++;
    return e;
  }

  function statement() {
    const L = lines[pos], ts = new TS(L.toks, L.line), t0 = ts.peek();
    if (t0.t === "kw") {
      if (t0.v === "if") { ts.next(); return ifFrom(ts, L); }
      if (t0.v === "switch") { ts.next(); return switchFrom(ts, L); }
      if (t0.v === "for") { ts.next(); return forFrom(ts, L); }
      if (t0.v === "while") { ts.next(); const cond = expr(ts); ts.end(); pos++; return mk("while", L.line, { cond, body: block(L.indent + 1) }); }
      if (t0.v === "break" || t0.v === "continue") { ts.next(); ts.end(); pos++; return mk(t0.v, L.line, {}); }
      if (t0.v === "var" || t0.v === "varip") { ts.next(); return declFrom(ts, L, true); }
      if (["import", "export", "method", "type"].includes(t0.v)) throw new PineError(`"${t0.v}" isn't supported in the lab`, L.line);
    }
    if (t0.t === "id" && ts.is("(", 1)) {
      let d = 0, k = 1;
      for (; k < L.toks.length; k++) {
        const x = L.toks[k];
        if (x.t === "op" && (x.v === "(" || x.v === "[")) d++;
        else if (x.t === "op" && (x.v === ")" || x.v === "]") && --d === 0) break;
      }
      if (L.toks[k + 1] && L.toks[k + 1].v === "=>") return funcFrom(ts, L);
    }
    if (t0.t === "op" && t0.v === "[" && L.toks.some(x => x.t === "op" && x.v === "=")) {
      ts.next();
      const names = [];
      do { const x = ts.next(); if (!x || x.t !== "id") throw new PineError("Expected a variable name inside [ ]", L.line); names.push(x.v); } while (ts.eat(","));
      ts.expect("]"); ts.expect("=");
      return mk("tuple", L.line, { names, value: rhs(ts, L) });
    }
    let k = 0;
    while (L.toks[k] && L.toks[k].t === "id" && TYPE_WORDS.has(L.toks[k].v) && L.toks[k + 1] && L.toks[k + 1].t === "id") k++;
    if (k > 0) { ts.p = k; return declFrom(ts, L, false); }
    if (t0.t === "id" && ts.is("=", 1)) return declFrom(ts, L, false);
    if (t0.t === "id" && L.toks[1] && L.toks[1].t === "op" && [":=", "+=", "-=", "*=", "/=", "%="].includes(L.toks[1].v)) {
      ts.next(); const op = ts.next().v;
      return mk("assign", L.line, { name: t0.v, op, value: rhs(ts, L) });
    }
    const e = expr(ts); ts.end(); pos++;
    return mk("expr", L.line, { e });
  }

  function declFrom(ts, L, isVar) {
    while (ts.peek() && ts.peek().t === "id" && TYPE_WORDS.has(ts.peek().v) && ts.peek(1) && ts.peek(1).t === "id") ts.next();
    const nm = ts.next();
    if (!nm || nm.t !== "id") throw new PineError("Expected a variable name", L.line);
    ts.expect("=");
    return mk("decl", L.line, { name: nm.v, isVar, value: rhs(ts, L) });
  }

  function ifFrom(ts, L) {
    const cond = expr(ts); ts.end(); pos++;
    const then = block(L.indent + 1);
    let els = null;
    const E = lines[pos];
    if (E && E.indent === L.indent && E.toks[0].t === "kw" && E.toks[0].v === "else") {
      const ts2 = new TS(E.toks, E.line); ts2.next();
      if (ts2.eat("if")) els = [ifFrom(ts2, { indent: L.indent, line: E.line })];
      else { ts2.end(); pos++; els = block(L.indent + 1); }
    }
    return mk("if", L.line, { cond, then, els });
  }

  function switchFrom(ts, L) {
    const subject = ts.done() ? null : expr(ts); ts.end(); pos++;
    if (pos >= lines.length || lines[pos].indent <= L.indent) throw new PineError("switch needs indented cases", L.line);
    const ind = lines[pos].indent, cases = [];
    while (pos < lines.length && lines[pos].indent === ind) {
      const C = lines[pos], t2 = new TS(C.toks, C.line);
      const match = t2.is("=>") ? null : expr(t2);
      t2.expect("=>");
      let body;
      if (t2.done()) { pos++; body = block(ind + 1); }
      else { const e = expr(t2); t2.end(); pos++; body = [mk("expr", C.line, { e })]; }
      cases.push({ match, body });
    }
    return mk("switch", L.line, { subject, cases });
  }

  function forFrom(ts, L) {
    const nm = ts.next();
    if (!nm || nm.t !== "id") throw new PineError("Expected a loop variable after for", L.line);
    if (ts.is("in")) throw new PineError("for ... in loops aren't supported (arrays aren't supported)", L.line);
    ts.expect("=");
    const from = expr(ts); ts.expect("to");
    const to = expr(ts);
    const step = ts.eat("by") ? expr(ts) : null;
    ts.end(); pos++;
    return mk("for", L.line, { name: nm.v, from, to, step, body: block(L.indent + 1) });
  }

  function funcFrom(ts, L) {
    const name = ts.next().v, params = [];
    ts.expect("(");
    if (!ts.is(")")) do {
      while (ts.peek() && ts.peek().t === "id" && TYPE_WORDS.has(ts.peek().v) && ts.peek(1) && ts.peek(1).t === "id") ts.next();
      const nm = ts.next();
      if (!nm || nm.t !== "id") throw new PineError("Expected a parameter name", L.line);
      params.push({ name: nm.v, def: ts.eat("=") ? expr(ts) : null, id: ++NODE_ID });
    } while (ts.eat(","));
    ts.expect(")"); ts.expect("=>");
    let body;
    if (ts.done()) { pos++; body = block(L.indent + 1); }
    else { const e = expr(ts); ts.end(); pos++; body = [mk("expr", L.line, { e })]; }
    if (L.indent !== 0) throw new PineError("Functions must be defined at the top level", L.line);
    return mk("func", L.line, { name, params, body });
  }

  // Precedence (low to high): ?: , or, and, == !=, < > <= >=, + -, * / %, unary, [] history
  function expr(ts) { return ternary(ts); }
  function ternary(ts) {
    const c = binary(ts, 0);
    if (ts.eat("?")) { const a = ternary(ts); ts.expect(":"); const b = ternary(ts); return mk("tern", c.line, { c, a, b }); }
    return c;
  }
  const LEVELS = [["or"], ["and"], ["==", "!="], ["<", ">", "<=", ">="], ["+", "-"], ["*", "/", "%"]];
  function binary(ts, lvl) {
    if (lvl === LEVELS.length) return unary(ts);
    let l = binary(ts, lvl + 1);
    while (LEVELS[lvl].some(op => ts.is(op))) {
      const t = ts.next();
      l = mk("bin", t.line, { op: t.v, l, r: binary(ts, lvl + 1) });
    }
    return l;
  }
  function unary(ts) {
    if (ts.is("not") || ts.is("-") || ts.is("+")) { const t = ts.next(); return mk("un", t.line, { op: t.v, e: unary(ts) }); }
    let p = primary(ts);
    while (ts.is("[")) { ts.next(); const off = expr(ts); ts.expect("]"); p = mk("idx", p.line, { obj: p, off }); }
    return p;
  }
  function primary(ts) {
    const t = ts.next();
    if (!t) throw new PineError("This expression is incomplete", ts.line);
    if (t.t === "num") return mk("num", t.line, { v: t.v });
    if (t.t === "str") return mk("str", t.line, { v: t.v });
    if (t.t === "kw" && (t.v === "true" || t.v === "false")) return mk("bool", t.line, { v: t.v === "true" });
    if (t.t === "op" && t.v === "(") { const e = expr(ts); ts.expect(")"); return e; }
    if (t.t === "op" && t.v === "[") {
      const items = [];
      if (!ts.is("]")) do items.push(expr(ts)); while (ts.eat(","));
      ts.expect("]");
      return mk("arr", t.line, { items });
    }
    if (t.t === "id") {
      if (ts.is("<")) {
        // generic call like array.new<float>() - not supported
        if (/^(array|matrix|map)\./.test(t.v)) throw new PineError(`${t.v}() isn't supported (arrays, matrices and maps aren't available in the lab)`, t.line);
      }
      if (ts.is("(")) {
        ts.next();
        const args = [], kw = {};
        if (!ts.is(")")) do {
          if (ts.peek() && ts.peek().t === "id" && ts.is("=", 1)) { const n = ts.next().v; ts.next(); kw[n] = expr(ts); }
          else args.push(expr(ts));
        } while (ts.eat(","));
        ts.expect(")");
        return mk("call", t.line, { name: t.v, args, kw });
      }
      if (t.v === "na") return mk("na", t.line, {});
      return mk("name", t.line, { name: t.v });
    }
    if (t.t === "kw" && (t.v === "if" || t.v === "switch")) throw new PineError(`Put "${t.v}" at the start of its own line`, t.line);
    throw new PineError(`Unexpected "${t.v}"`, t.line);
  }

  const prog = [];
  while (pos < lines.length) {
    if (lines[pos].indent !== 0) throw new PineError("Unexpected indentation", lines[pos].line);
    prog.push(statement());
  }
  return prog;
}

// ================================================================= compile
const IGNORED_CALLS = new Set(["plotshape", "plotchar", "plotarrow", "plotcandle", "plotbar", "bgcolor", "barcolor", "fill", "hline", "alert", "alertcondition", "max_bars_back", "indicator", "strategy"]);
const IGNORED_PREFIX = ["label.", "line.", "box.", "table.", "linefill.", "log.", "polyline.", "chart.point.", "runtime.log", "strategy.risk."];
const CONST_NS = ["color.", "shape.", "location.", "size.", "plot.", "line.", "label.", "display.", "position.", "text.", "extend.", "xloc.", "yloc.", "format.", "scale.", "alert.", "barmerge.", "font.", "hline.", "order.", "adjustment.", "currency.", "session.", "dividends.", "earnings.", "splits.", "backadjustment.", "settlement_as_close.", "strategy.oca.", "strategy.commission."];
const SOURCES = ["open", "high", "low", "close", "hl2", "hlc3", "ohlc4", "hlcc4", "volume"];

function walk(x, fn) {
  if (Array.isArray(x)) { for (const y of x) walk(y, fn); return; }
  if (!x || typeof x !== "object") return;
  if (x.k) fn(x);
  for (const key in x) if (key !== "line" && key !== "id" && key !== "k" && typeof x[key] === "object") walk(x[key], fn);
}

function constEval(n) {
  if (!n) return undefined;
  switch (n.k) {
    case "num": case "str": case "bool": return n.v;
    case "na": return NaN;
    case "un": { const v = constEval(n.e); return n.op === "-" ? -v : n.op === "not" ? !v : v; }
    case "name": return SOURCES.includes(n.name) ? { source: n.name } : undefined;
    case "arr": return n.items.map(constEval);
    case "bin": {
      const a = constEval(n.l), b = constEval(n.r);
      if (typeof a !== "number" || typeof b !== "number") return undefined;
      return { "+": a + b, "-": a - b, "*": a * b, "/": a / b }[n.op];
    }
  }
  return undefined;
}

function compile(src) {
  const prog = parse(src);
  const funcs = new Map(), body = [];
  for (const s of prog) {
    if (s.k === "func") { if (funcs.has(s.name)) throw new PineError(`Function ${s.name} is defined twice`, s.line); funcs.set(s.name, s); }
    else body.push(s);
  }
  let decl = null;
  for (const s of body) if (s.k === "expr" && s.e.k === "call" && ["strategy", "indicator", "study"].includes(s.e.name)) decl = s.e;
  if (!decl) throw new PineError('Add a strategy("Name", overlay=true) line at the top. Only strategy scripts can be backtested.');
  if (decl.name !== "strategy") throw new PineError("This is an indicator script. Backtests need a strategy script: strategy(...) plus strategy.entry() calls.", decl.line);
  const title = String(constEval(decl.args[0] || decl.kw.title) || "My Pine strategy");
  const opts = {
    pyramiding: constEval(decl.kw.pyramiding) || 0,
    poc: !!constEval(decl.kw.process_orders_on_close),
    overlay: constEval(decl.args[2] || decl.kw.overlay),
  };

  const inputs = [];
  let hasEntry = false;
  walk(prog, n => {
    if (n.k !== "call") return;
    const name = n.name;
    if (name === "strategy.entry" || name === "strategy.order") hasEntry = true;
    if (name === "input" || name.startsWith("input.")) {
      const def = constEval(n.args[0] || n.kw.defval);
      const titleV = constEval(n.args[1] || n.kw.title);
      let type = { "input.int": "num", "input.float": "num", "input.price": "num", "input.bool": "bool", "input.string": "str", "input.session": "str", "input.timeframe": "str", "input.symbol": "str", "input.text_area": "str", "input.source": "src", "input.color": "hidden", "input.time": "hidden", "input.enum": "str" }[name];
      if (name === "input") type = typeof def === "number" ? "num" : typeof def === "boolean" ? "bool" : typeof def === "string" ? "str" : def && def.source ? "src" : "hidden";
      if (!type) throw new PineError(`${name}() isn't supported`, n.line);
      const key = "in" + inputs.length;
      n.inKey = key; n.inType = type;
      const options = constEval(n.kw.options);
      const p = { id: key, label: titleV ? String(titleV) : `Input ${inputs.length + 1}`, type, def };
      if (type === "num") { p.def = typeof def === "number" ? def : 0; p.step = constEval(n.kw.step) || (name === "input.int" ? 1 : "any"); if (Array.isArray(options)) p.options = options.map(String); }
      if (type === "bool") { p.def = String(!!def); p.options = ["true", "false"]; }
      if (type === "str") { p.def = def == null ? "" : String(def); if (Array.isArray(options)) p.options = options.map(String); else p.text = true; }
      if (type === "src") { p.def = def && def.source ? def.source : "close"; p.options = SOURCES; }
      inputs.push(p);
      return;
    }
    if (funcs.has(name) || BUILTINS[name] || IGNORED_CALLS.has(name) || IGNORED_PREFIX.some(p => name.startsWith(p))) return;
    if (/^(array|matrix|map)\./.test(name)) throw new PineError(`${name}() isn't supported (arrays, matrices and maps aren't available in the lab)`, n.line);
    throw new PineError(`${name}() isn't supported in the lab yet`, n.line);
  });
  if (!hasEntry) throw new PineError("The script never calls strategy.entry(), so it can't open any trades.");
  return { title, opts, inputs, params: inputs.filter(p => p.type !== "hidden"), body, funcs };
}

// ================================================================= runtime
let R = null; // the running bar loop; builtins read the current bar from here
const BRK = { brk: 1 }, CNT = { cnt: 1 };
const isNa = v => v === undefined || v === null || (typeof v === "number" && v !== v);
const truthy = v => typeof v === "number" ? v === v && v !== 0 : !!v;
const num = v => typeof v === "number" ? v : typeof v === "boolean" ? +v : NaN;
const at = (arr, j) => j >= 0 && arr[j] !== undefined ? arr[j] : NaN;
const shiftDay = (d, k) => new Date(Date.parse(d + "T12:00:00Z") + k * 864e5).toISOString().slice(0, 10);
const dowOf = d => new Date(d + "T12:00:00Z").getUTCDay() + 1; // Pine: 1 = Sunday

// Per-call-site state. Global scope uses one state per node; inside user functions
// each call site (the ctx path) gets its own state, like Pine.
function stateFor(store, id, ctx) {
  if (ctx === "") return store.g[id] || (store.g[id] = {});
  const m = store.m[id] || (store.m[id] = new Map());
  let s = m.get(ctx);
  if (!s) { s = {}; m.set(ctx, s); }
  return s;
}
function getSlot(id, ctx, isVar) {
  const s = stateFor(R.slots, id, ctx);
  if (!s.hist) { s.hist = []; s.cur = NaN; s.isVar = isVar; s.init = false; s.lastBar = -1; R.slotList.push(s); }
  return s;
}
function lookup(scope, name) {
  for (let s = scope; s; s = s.parent) { const v = s.vars.get(name); if (v) return v; }
  return null;
}

class Ser { // values a call site has seen, newest last; one entry per bar
  constructor() { this.a = []; this.bar = -1; }
  put(v) { if (this.bar === R.i) this.a[this.a.length - 1] = v; else { this.a.push(v); this.bar = R.i; } return this; }
  get(k) { const j = this.a.length - 1 - k; return j >= 0 ? this.a[j] : NaN; }
  get len() { return this.a.length; }
}
const ser = (st, k) => st[k] || (st[k] = new Ser());
function rec(st, k) { const r = st[k] || (st[k] = { bar: -1, last: NaN, cur: NaN }); if (r.bar !== R.i) { r.last = r.cur; r.bar = R.i; } return r; }
const sub = (st, k) => st[k] || (st[k] = {});

// ---------------------------------------------------------------- indicators
function sma(st, src, len) {
  const s = ser(st, "s").put(num(src)); len = Math.round(len);
  if (!(len >= 1) || s.len < len) return NaN;
  let sum = 0;
  for (let k = 0; k < len; k++) { const v = s.get(k); if (v !== v) return NaN; sum += v; }
  return sum / len;
}
function smooth(st, src, len, alpha) { // ema/rma: seeded with an SMA, then recursive
  const r = rec(st, "r"), seed = sma(sub(st, "sm"), src, len);
  r.cur = r.last !== r.last ? seed : alpha * src + (1 - alpha) * r.last;
  return r.cur;
}
const ema = (st, src, len) => smooth(st, src, len, 2 / (Math.round(len) + 1));
const rma = (st, src, len) => smooth(st, src, len, 1 / Math.round(len));
function wma(st, src, len) {
  const s = ser(st, "s").put(num(src)); len = Math.round(len);
  if (!(len >= 1) || s.len < len) return NaN;
  let sum = 0, norm = 0;
  for (let k = 0; k < len; k++) { const w = len - k; sum += s.get(k) * w; norm += w; }
  return sum / norm;
}
function stdev(st, src, len, biased = true) {
  const s = ser(st, "s").put(num(src)); len = Math.round(len);
  if (!(len >= 1) || s.len < len) return NaN;
  let m = 0;
  for (let k = 0; k < len; k++) m += s.get(k);
  m /= len;
  let q = 0;
  for (let k = 0; k < len; k++) q += (s.get(k) - m) ** 2;
  return Math.sqrt(q / (biased || len < 2 ? len : len - 1));
}
function extreme(st, a, useMax, bars) {
  let src, len;
  if (a.length === 1) { src = useMax ? R.b.h[R.i] : R.b.l[R.i]; len = a[0]; } else { src = a[0]; len = a[1]; }
  const s = ser(st, "s").put(num(src)); len = Math.round(len);
  if (!(len >= 1) || s.len < len) return NaN;
  let best = s.get(0), off = 0;
  for (let k = 1; k < len; k++) { const v = s.get(k); if (useMax ? v > best : v < best) { best = v; off = k; } }
  return bars ? -off : best;
}
function trAt(j) {
  const b = R.b;
  if (j < 0) return NaN;
  if (j === 0) return b.h[0] - b.l[0];
  const pc = b.c[j - 1];
  return Math.max(b.h[j] - b.l[j], Math.abs(b.h[j] - pc), Math.abs(b.l[j] - pc));
}
function pivot(st, a, high) {
  let src, left, right;
  if (a.length === 2) { src = high ? R.b.h[R.i] : R.b.l[R.i]; left = a[0]; right = a[1]; } else { src = a[0]; left = a[1]; right = a[2]; }
  const s = ser(st, "s").put(num(src));
  if (s.len < left + right + 1) return NaN;
  const c = s.get(right);
  for (let k = 0; k <= left + right; k++) if (k !== right && (high ? s.get(k) >= c : s.get(k) <= c)) return NaN;
  return c;
}

// ---------------------------------------------------------------- exchange time
// TradingView's NQ1! uses the exchange time zone (America/Chicago). NY is always 1 hour ahead.
function exTime() {
  if (R.ex) return R.ex;
  const b = R.b, n = R.n, mod = new Int16Array(n), day = new Array(n), tday = new Array(n);
  for (let j = 0; j < n; j++) {
    if (b.intraday) {
      let m = b.mod[j] - 60, d = b.day[j];
      if (m < 0) { m += 1440; d = shiftDay(d, -1); }
      mod[j] = m; day[j] = d;
      tday[j] = b.mod[j] >= 1080 ? shiftDay(b.day[j], 1) : b.day[j]; // CME session opens 18:00 NY
    } else { mod[j] = 0; day[j] = b.day[j]; tday[j] = b.day[j]; }
  }
  return (R.ex = { mod, day, tday });
}
function minutesIn(tz, j) {
  const b = R.b;
  if (!b.intraday) return 0;
  if (!tz || /^(America\/Chicago|US\/Central|exchange)$/i.test(tz)) return exTime().mod[j];
  if (/^(America\/New_York|US\/Eastern)$/i.test(tz)) return b.mod[j];
  const m = /^(?:UTC|GMT|Etc\/UTC)(?:([+-])(\d{1,2})(?::?(\d{2}))?)?$/i.exec(tz);
  if (!m) throw new PineError(`Time zone "${tz}" isn't supported. Use America/New_York, America/Chicago or UTC±H.`, R.line);
  const utc = Math.floor((b.t[j] % 864e5) / 60000), off = m[1] ? (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + +(m[3] || 0)) : 0;
  return ((utc + off) % 1440 + 1440) % 1440;
}
function inSession(sess, tz, j) {
  if (!R.b.intraday) return true;
  const m = minutesIn(tz, j);
  const d = /^(America\/New_York|US\/Eastern)$/i.test(tz || "") ? dowOf(R.b.day[j]) : dowOf(exTime().day[j]);
  for (const part of String(sess).split(",")) {
    const mm = /^\s*(\d{2})(\d{2})-(\d{2})(\d{2})(?::(\d+))?\s*$/.exec(part);
    if (!mm) throw new PineError(`Session "${sess}" should look like "0930-1600" or "0930-1600:23456"`, R.line);
    if (mm[5] && !mm[5].includes(String(d))) continue;
    const s = +mm[1] * 60 + +mm[2], e = +mm[3] * 60 + +mm[4];
    if (s === e || (s < e ? m >= s && m < e : m >= s || m < e)) return true;
  }
  return false;
}
function tfMinutes() { return R.b.intraday ? parseInt(R.b.interval, 10) || 1 : 1440; }
function timeFor(tf, j) {
  const b = R.b, t = b.t[j];
  if (!tf || tf === tfString()) return t;
  if (/^1?D$/i.test(tf)) return Date.parse(exTime().tday[j] + "T00:00:00Z");
  if (/^1?W$/i.test(tf)) { const d = exTime().tday[j]; return Date.parse(shiftDay(d, -(dowOf(d) + 5) % 7) + "T00:00:00Z"); }
  if (/^1?M$/i.test(tf)) return Date.parse(exTime().tday[j].slice(0, 7) + "-01T00:00:00Z");
  const m = parseInt(tf, 10);
  if (m > 0) return Math.floor(t / (m * 60000)) * m * 60000;
  throw new PineError(`Timeframe "${tf}" isn't supported`, R.line);
}
const tfString = () => R.b.intraday ? String(tfMinutes()) : "D";

// ---------------------------------------------------------------- built-in variables
function builtinVar(name, j) {
  const b = R.b, E = R.E;
  if (j < 0) return NaN;
  switch (name) {
    case "open": return b.o[j];
    case "high": return b.h[j];
    case "low": return b.l[j];
    case "close": return b.c[j];
    case "volume": return b.v[j];
    case "hl2": return (b.h[j] + b.l[j]) / 2;
    case "hlc3": return (b.h[j] + b.l[j] + b.c[j]) / 3;
    case "ohlc4": return (b.o[j] + b.h[j] + b.l[j] + b.c[j]) / 4;
    case "hlcc4": return (b.h[j] + b.l[j] + 2 * b.c[j]) / 4;
    case "bar_index": return j;
    case "last_bar_index": return R.n - 1;
    case "time": case "time_tradingday": return name === "time" ? b.t[j] : Date.parse(exTime().tday[j] + "T00:00:00Z");
    case "time_close": return b.t[j] + tfMinutes() * 60000;
    case "hour": return Math.floor(exTime().mod[j] / 60);
    case "minute": return exTime().mod[j] % 60;
    case "dayofmonth": return +exTime().day[j].slice(8, 10);
    case "month": return +exTime().day[j].slice(5, 7);
    case "year": return +exTime().day[j].slice(0, 4);
    case "dayofweek": return dowOf(exTime().day[j]);
    case "weekofyear": { const d = exTime().day[j], t = Date.parse(d + "T00:00:00Z"), y0 = Date.parse(d.slice(0, 4) + "-01-01T00:00:00Z"); return Math.floor((t - y0) / 864e5 / 7) + 1; }
    case "strategy.long": return 1;
    case "strategy.short": return -1;
    case "strategy.direction.long": return "long";
    case "strategy.direction.short": return "short";
    case "strategy.direction.all": return "all";
    case "strategy.fixed": case "strategy.cash": case "strategy.percent_of_equity": return name;
    case "strategy.position_size": return j === R.i ? E.pos() : at(E.posHist, j);
    case "strategy.position_avg_price": return j === R.i ? E.avgPrice() : NaN;
    case "strategy.opentrades": return E.lots.length;
    case "strategy.closedtrades": return E.trades.length;
    case "strategy.wintrades": return E.trades.filter(t => t.pnl > 0).length;
    case "strategy.losstrades": return E.trades.filter(t => t.pnl < 0).length;
    case "strategy.equity": return j === R.i ? E.equityNow() : at(E.eq, j);
    case "strategy.netprofit": return E.cash - R.cfg.capital + E.costsOpen();
    case "strategy.openprofit": return E.openProfit();
    case "strategy.initial_capital": return R.cfg.capital;
    case "syminfo.mintick": return 0.25;
    case "syminfo.pointvalue": return R.cfg.pv;
    case "syminfo.ticker": return "NQ1!";
    case "syminfo.tickerid": return "CME_MINI:NQ1!";
    case "syminfo.timezone": return "America/Chicago";
    case "syminfo.currency": return "USD";
    case "syminfo.session": return "regular";
    case "timeframe.period": return tfString();
    case "timeframe.multiplier": return b.intraday ? tfMinutes() : 1;
    case "timeframe.isintraday": case "timeframe.isminutes": return b.intraday;
    case "timeframe.isdaily": case "timeframe.isdwm": return !b.intraday;
    case "timeframe.isweekly": case "timeframe.ismonthly": case "timeframe.isseconds": case "timeframe.isticks": return false;
    case "barstate.isfirst": return j === 0;
    case "barstate.islast": case "barstate.islastconfirmedhistory": return j === R.n - 1;
    case "barstate.isconfirmed": case "barstate.ishistory": case "barstate.isnew": return true;
    case "barstate.isrealtime": return false;
    case "math.pi": return Math.PI;
    case "math.e": return Math.E;
    case "math.phi": return 1.618033988749895;
    case "ta.tr": return trAt(j);
  }
  const dow = /^dayofweek\.(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/.exec(name);
  if (dow) return ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].indexOf(dow[1]) + 1;
  if (CONST_NS.some(p => name.startsWith(p))) return name;
  throw new PineError(`Unknown name "${name}"`, R.line);
}

// ---------------------------------------------------------------- built-in functions
// Each takes (positional args, named args, call-site state).
const A = (a, kw, i, name, d) => a.length > i ? a[i] : name in kw ? kw[name] : d;
const BUILTINS = {
  "ta.sma": (a, kw, st) => sma(st, A(a, kw, 0, "source"), A(a, kw, 1, "length")),
  "ta.ema": (a, kw, st) => ema(st, num(A(a, kw, 0, "source")), A(a, kw, 1, "length")),
  "ta.rma": (a, kw, st) => rma(st, num(A(a, kw, 0, "source")), A(a, kw, 1, "length")),
  "ta.wma": (a, kw, st) => wma(st, A(a, kw, 0, "source"), A(a, kw, 1, "length")),
  "ta.vwma": (a, kw, st) => { const s = num(A(a, kw, 0, "source")), v = R.b.v[R.i], n = A(a, kw, 1, "length"); return sma(sub(st, "a"), s * v, n) / sma(sub(st, "b"), v, n); },
  "ta.hma": (a, kw, st) => { const s = A(a, kw, 0, "source"), n = Math.round(A(a, kw, 1, "length")); return wma(sub(st, "c"), 2 * wma(sub(st, "a"), s, Math.floor(n / 2)) - wma(sub(st, "b"), s, n), Math.floor(Math.sqrt(n))); },
  "ta.alma": (a, kw, st) => {
    const s = ser(st, "s").put(num(A(a, kw, 0, "series"))), n = Math.round(A(a, kw, 1, "length")), off = A(a, kw, 2, "offset", 0.85), sig = A(a, kw, 3, "sigma", 6);
    if (s.len < n) return NaN;
    const m = off * (n - 1), sd = n / sig;
    let sum = 0, norm = 0;
    for (let k = 0; k < n; k++) { const w = Math.exp(-((k - m) ** 2) / (2 * sd * sd)); sum += w * s.get(n - 1 - k); norm += w; }
    return sum / norm;
  },
  "ta.rsi": (a, kw, st) => {
    const s = ser(st, "src").put(num(A(a, kw, 0, "source"))), n = A(a, kw, 1, "length"), ch = s.get(0) - s.get(1);
    const u = rma(sub(st, "u"), Math.max(ch, 0), n), d = rma(sub(st, "d"), Math.max(-ch, 0), n);
    if (u !== u || d !== d) return NaN;
    return d === 0 ? 100 : u === 0 ? 0 : 100 - 100 / (1 + u / d);
  },
  "ta.atr": (a, kw, st) => rma(st, trAt(R.i), A(a, kw, 0, "length")),
  "ta.tr": () => trAt(R.i),
  "ta.stdev": (a, kw, st) => stdev(st, A(a, kw, 0, "source"), A(a, kw, 1, "length"), A(a, kw, 2, "biased", true)),
  "ta.variance": (a, kw, st) => stdev(st, A(a, kw, 0, "source"), A(a, kw, 1, "length"), A(a, kw, 2, "biased", true)) ** 2,
  "ta.highest": (a, kw, st) => extreme(st, a, true, false),
  "ta.lowest": (a, kw, st) => extreme(st, a, false, false),
  "ta.highestbars": (a, kw, st) => extreme(st, a, true, true),
  "ta.lowestbars": (a, kw, st) => extreme(st, a, false, true),
  "ta.crossover": (a, kw, st) => { const x = ser(st, "x").put(num(a[0])), y = ser(st, "y").put(num(a[1])); return x.get(0) > y.get(0) && x.get(1) <= y.get(1); },
  "ta.crossunder": (a, kw, st) => { const x = ser(st, "x").put(num(a[0])), y = ser(st, "y").put(num(a[1])); return x.get(0) < y.get(0) && x.get(1) >= y.get(1); },
  "ta.cross": (a, kw, st) => { const x = ser(st, "x").put(num(a[0])), y = ser(st, "y").put(num(a[1])); return (x.get(0) > y.get(0) && x.get(1) <= y.get(1)) || (x.get(0) < y.get(0) && x.get(1) >= y.get(1)); },
  "ta.change": (a, kw, st) => {
    const v = A(a, kw, 0, "source"), n = Math.round(A(a, kw, 1, "length", 1)), s = ser(st, "s").put(v);
    if (typeof v === "boolean") return s.len > n && v !== s.get(n);
    return num(v) - num(s.get(n));
  },
  "ta.mom": (a, kw, st) => { const s = ser(st, "s").put(num(a[0])); return s.get(0) - s.get(Math.round(a[1])); },
  "ta.roc": (a, kw, st) => { const s = ser(st, "s").put(num(a[0])), p = s.get(Math.round(a[1])); return 100 * (s.get(0) - p) / p; },
  "ta.macd": (a, kw, st) => {
    const s = num(A(a, kw, 0, "source")), m = ema(sub(st, "f"), s, A(a, kw, 1, "fastlen")) - ema(sub(st, "s"), s, A(a, kw, 2, "slowlen"));
    const sig = ema(sub(st, "g"), m, A(a, kw, 3, "siglen"));
    return [m, sig, m - sig];
  },
  "ta.bb": (a, kw, st) => { const s = A(a, kw, 0, "series"), n = A(a, kw, 1, "length"), basis = sma(sub(st, "a"), s, n), dev = A(a, kw, 2, "mult") * stdev(sub(st, "b"), s, n); return [basis, basis + dev, basis - dev]; },
  "ta.bbw": (a, kw, st) => { const s = A(a, kw, 0, "series"), n = A(a, kw, 1, "length"), basis = sma(sub(st, "a"), s, n), dev = A(a, kw, 2, "mult") * stdev(sub(st, "b"), s, n); return 2 * dev / basis; },
  "ta.kc": (a, kw, st) => {
    const s = num(A(a, kw, 0, "series")), n = A(a, kw, 1, "length"), mult = A(a, kw, 2, "mult"), useTR = A(a, kw, 3, "useTrueRange", true);
    const basis = ema(sub(st, "a"), s, n), rng = ema(sub(st, "b"), useTR ? trAt(R.i) : R.b.h[R.i] - R.b.l[R.i], n);
    return [basis, basis + rng * mult, basis - rng * mult];
  },
  "ta.stoch": (a, kw, st) => { const hh = extreme(sub(st, "h"), [a[1], a[3]], true), ll = extreme(sub(st, "l"), [a[2], a[3]], false); return 100 * (num(a[0]) - ll) / (hh - ll); },
  "ta.cci": (a, kw, st) => {
    const src = num(a[0]), n = Math.round(a[1]), s = ser(st, "s").put(src), ma = sma(sub(st, "m"), src, n);
    if (ma !== ma) return NaN;
    let md = 0;
    for (let k = 0; k < n; k++) md += Math.abs(s.get(k) - ma);
    return (src - ma) / (0.015 * md / n);
  },
  "ta.wpr": (a, kw, st) => { const n = a[0], hh = extreme(sub(st, "h"), [R.b.h[R.i], n], true), ll = extreme(sub(st, "l"), [R.b.l[R.i], n], false); return 100 * (R.b.c[R.i] - hh) / (hh - ll); },
  "ta.dmi": (a, kw, st) => {
    const b = R.b, i = R.i, n = a[0], m = a[1];
    const up = i > 0 ? b.h[i] - b.h[i - 1] : NaN, dn = i > 0 ? b.l[i - 1] - b.l[i] : NaN;
    const pdm = up !== up ? NaN : up > dn && up > 0 ? up : 0, mdm = dn !== dn ? NaN : dn > up && dn > 0 ? dn : 0;
    const trur = rma(sub(st, "t"), trAt(i), n);
    const plus = 100 * rma(sub(st, "p"), pdm, n) / trur, minus = 100 * rma(sub(st, "m"), mdm, n) / trur, sum = plus + minus;
    return [plus, minus, 100 * rma(sub(st, "a"), Math.abs(plus - minus) / (sum === 0 ? 1 : sum), m)];
  },
  "ta.supertrend": (a, kw, st) => {
    const b = R.b, i = R.i, factor = A(a, kw, 0, "factor"), period = A(a, kw, 1, "atrPeriod");
    const src = (b.h[i] + b.l[i]) / 2, atr = rma(sub(st, "atr"), trAt(i), period), r = rec(st, "r"), L = typeof r.last === "object" ? r.last : null;
    let up = src + factor * atr, lo = src - factor * atr;
    const pl = L && L.lo === L.lo ? L.lo : 0, pu = L && L.up === L.up ? L.up : 0, pc = i > 0 ? b.c[i - 1] : NaN;
    lo = lo > pl || pc < pl ? lo : pl;
    up = up < pu || pc > pu ? up : pu;
    let dir;
    if (!L || L.atr !== L.atr) dir = 1;
    else if (L.st === L.up) dir = b.c[i] > up ? -1 : 1;
    else dir = b.c[i] < lo ? 1 : -1;
    const stv = dir === -1 ? lo : up;
    r.cur = { up, lo, st: stv, atr };
    return [stv, dir];
  },
  "ta.vwap": (a, kw, st) => {
    const src = num(A(a, kw, 0, "source", (R.b.h[R.i] + R.b.l[R.i] + R.b.c[R.i]) / 3)), d = exTime().tday[R.i], v = R.b.v[R.i] > 0 ? R.b.v[R.i] : 0;
    if (st.bar !== R.i) { if (st.day !== d) { st.day = d; st.pv0 = 0; st.v0 = 0; } else { st.pv0 = st.pv; st.v0 = st.vv; } st.bar = R.i; }
    st.pv = st.pv0 + src * v; st.vv = st.v0 + v;
    return st.vv > 0 ? st.pv / st.vv : src;
  },
  "ta.cum": (a, kw, st) => { if (st.bar !== R.i) { st.base = st.sum || 0; st.bar = R.i; } const v = num(a[0]); st.sum = st.base + (v === v ? v : 0); return st.sum; },
  "ta.barssince": (a, kw, st) => { if (st.bar !== R.i) { st.bar = R.i; st.prev = st.last; } st.last = truthy(a[0]) ? R.i : st.prev; return st.last === undefined ? NaN : R.i - st.last; },
  "ta.valuewhen": (a, kw, st) => { const vals = st.vals || (st.vals = []); if (st.bar !== R.i) { st.bar = R.i; if (truthy(a[0])) vals.push(a[1]); } const j = vals.length - 1 - Math.round(a[2] || 0); return j >= 0 ? vals[j] : NaN; },
  "ta.pivothigh": (a, kw, st) => pivot(st, a, true),
  "ta.pivotlow": (a, kw, st) => pivot(st, a, false),
  "ta.linreg": (a, kw, st) => {
    const s = ser(st, "s").put(num(a[0])), n = Math.round(a[1]), off = a[2] || 0;
    if (s.len < n) return NaN;
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (let k = 0; k < n; k++) { const x = n - 1 - k, y = s.get(k); sx += x; sy += y; sxy += x * y; sxx += x * x; }
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1), icpt = (sy - slope * sx) / n;
    return icpt + slope * (n - 1 - off);
  },
  "ta.rising": (a, kw, st) => { const s = ser(st, "s").put(num(a[0])), n = Math.round(a[1]); if (s.len <= n) return false; for (let k = 0; k < n; k++) if (!(s.get(k) > s.get(k + 1))) return false; return true; },
  "ta.falling": (a, kw, st) => { const s = ser(st, "s").put(num(a[0])), n = Math.round(a[1]); if (s.len <= n) return false; for (let k = 0; k < n; k++) if (!(s.get(k) < s.get(k + 1))) return false; return true; },
  "ta.median": (a, kw, st) => { const s = ser(st, "s").put(num(a[0])), n = Math.round(a[1]); if (s.len < n) return NaN; const w = []; for (let k = 0; k < n; k++) w.push(s.get(k)); w.sort((x, y) => x - y); return n % 2 ? w[(n - 1) / 2] : (w[n / 2 - 1] + w[n / 2]) / 2; },
  "math.sum": (a, kw, st) => { const s = ser(st, "s").put(num(a[0])), n = Math.round(a[1]); if (s.len < n) return NaN; let t = 0; for (let k = 0; k < n; k++) t += s.get(k); return t; },
  "fixnan": (a, kw, st) => { if (!isNa(a[0])) st.v = a[0]; return st.v === undefined ? NaN : st.v; },
  "math.abs": a => Math.abs(a[0]), "math.max": a => Math.max(...a.map(num)), "math.min": a => Math.min(...a.map(num)),
  "math.round": a => a.length > 1 ? Math.round(a[0] * 10 ** a[1]) / 10 ** a[1] : Math.round(a[0]),
  "math.round_to_mintick": a => Math.round(a[0] / 0.25) * 0.25,
  "math.floor": a => Math.floor(a[0]), "math.ceil": a => Math.ceil(a[0]), "math.sqrt": a => Math.sqrt(a[0]), "math.pow": a => a[0] ** a[1],
  "math.log": a => Math.log(a[0]), "math.log10": a => Math.log10(a[0]), "math.exp": a => Math.exp(a[0]), "math.sign": a => Math.sign(a[0]),
  "math.avg": a => a.reduce((s, x) => s + num(x), 0) / a.length,
  "math.sin": a => Math.sin(a[0]), "math.cos": a => Math.cos(a[0]), "math.tan": a => Math.tan(a[0]), "math.atan": a => Math.atan(a[0]),
  "math.todegrees": a => a[0] * 180 / Math.PI, "math.toradians": a => a[0] * Math.PI / 180,
  "nz": a => isNa(a[0]) ? (a.length > 1 ? a[1] : 0) : a[0],
  "na": a => isNa(a[0]),
  "int": a => isNa(a[0]) ? NaN : Math.trunc(a[0]), "float": a => num(a[0]), "bool": a => truthy(a[0]),
  "str.tostring": a => typeof a[0] === "number" ? (a[0] !== a[0] ? "NaN" : String(+a[0].toFixed(4))) : String(a[0]),
  "str.format": a => String(a[0]).replace(/\{(\d+)[^}]*\}/g, (_, k) => String(a[+k + 1])),
  "str.length": a => String(a[0]).length, "str.contains": a => String(a[0]).includes(a[1]),
  "str.upper": a => String(a[0]).toUpperCase(), "str.lower": a => String(a[0]).toLowerCase(),
  "str.tonumber": a => parseFloat(a[0]),
  "color.new": () => "color", "color.rgb": () => "color", "color.from_gradient": () => "color",
  "timestamp": a => {
    if (typeof a[0] === "string" && a.length === 1) return Date.parse(a[0]);
    const nums = a.filter(x => typeof x === "number");
    const [y, mo, d, h = 0, mi = 0, s = 0] = nums;
    return Date.UTC(y, mo - 1, d, h, mi, s);
  },
  "time": (a, kw) => { const tf = A(a, kw, 0, "timeframe", ""), sess = A(a, kw, 1, "session"), tz = A(a, kw, 2, "timezone"); if (sess !== undefined && !inSession(sess, tz, R.i)) return NaN; return timeFor(tf, R.i); },
  "time_close": (a, kw) => { const sess = A(a, kw, 1, "session"), tz = A(a, kw, 2, "timezone"); if (sess !== undefined && !inSession(sess, tz, R.i)) return NaN; return R.b.t[R.i] + tfMinutes() * 60000; },
  "request.security": (a, kw) => {
    const tf = String(A(a, kw, 1, "timeframe", "")), cur = tfString();
    if (tf === "" || tf === cur || (!R.b.intraday && /^1?D$/i.test(tf))) return A(a, kw, 2, "expression");
    throw new PineError(`request.security() for timeframe "${tf}" isn't supported. Load data in that timeframe instead.`, R.line);
  },
  "plot": (a, kw, st, node, ctx) => {
    if (ctx !== "") return NaN;
    const v = num(A(a, kw, 0, "series"));
    let p = R.plots.get(node.id);
    if (!p) { p = { label: String(A(a, kw, 1, "title", "Plot")), data: new Float64Array(R.n).fill(NaN) }; R.plots.set(node.id, p); }
    p.data[R.i] = v;
    return NaN;
  },
  "strategy.entry": (a, kw) => { if ("when" in kw && !truthy(kw.when)) return NaN; R.E.entry(A(a, kw, 0, "id"), A(a, kw, 1, "direction"), A(a, kw, 2, "qty"), A(a, kw, 3, "limit"), A(a, kw, 4, "stop")); return NaN; },
  "strategy.order": (a, kw) => { if ("when" in kw && !truthy(kw.when)) return NaN; R.E.entry(A(a, kw, 0, "id"), A(a, kw, 1, "direction"), A(a, kw, 2, "qty"), A(a, kw, 3, "limit"), A(a, kw, 4, "stop")); return NaN; },
  "strategy.close": (a, kw) => { if ("when" in kw && !truthy(kw.when)) return NaN; R.E.close(A(a, kw, 0, "id"), truthy(kw.immediately)); return NaN; },
  "strategy.close_all": (a, kw) => { if ("when" in kw && !truthy(kw.when)) return NaN; R.E.close(null, truthy(kw.immediately)); return NaN; },
  "strategy.exit": (a, kw) => {
    if ("when" in kw && !truthy(kw.when)) return NaN;
    const g = (i, k) => num(A(a, kw, i, k, NaN));
    R.E.exit({ id: A(a, kw, 0, "id"), from: A(a, kw, 1, "from_entry", ""), qty: g(2, "qty"), qtyPct: g(3, "qty_percent"), profit: g(4, "profit"), limit: g(5, "limit"), loss: g(6, "loss"), stop: g(7, "stop"), trailPrice: g(8, "trail_price"), trailPoints: g(9, "trail_points"), trailOffset: g(10, "trail_offset") });
    return NaN;
  },
  "strategy.cancel": (a, kw) => { R.E.cancel(A(a, kw, 0, "id")); return NaN; },
  "strategy.cancel_all": () => { R.E.cancel(null); return NaN; },
  "strategy.risk.allow_entry_in": a => { R.E.allow = a[0]; return NaN; },
};

// ---------------------------------------------------------------- order engine
// Net position made of open "lots" (one per filled entry). Costs are charged per
// contract per side from the lab settings; slippage is a cost, not a price change.
function makeEngine(b, cfg, opts) {
  const n = b.c.length, pv = cfg.pv, cost = cfg.cps, tick = 0.25;
  const pyr = Math.max(1, opts.pyramiding || 0);
  const E = {
    lots: [], pend: [], exits: new Map(), closeReq: [], trades: [], cash: cfg.capital, allow: "all",
    dayKey: null, dayStart: cfg.capital, halted: false, peak: cfg.capital, rules: { limitDays: 0, blownAt: -1 },
    eq: new Float64Array(n), eqLow: new Float64Array(n), held: new Int8Array(n), bar0: null, posHist: new Float64Array(n), inMkt: 0,
    pos() { let p = 0; for (const l of this.lots) p += l.side * l.qty; return p; },
    avgPrice() { let q = 0, s = 0; for (const l of this.lots) { q += l.qty; s += l.qty * l.price; } return q ? s / q : NaN; },
    openProfit() { let u = 0; const c = b.c[R.i]; for (const l of this.lots) u += (c - l.price) * l.side * l.qty * pv; return u; },
    costsOpen() { let q = 0; for (const l of this.lots) q += l.qty; return q * cost; },
    equityNow() { return this.cash + this.openProfit(); },

    allowed(side) {
      const lab = cfg.dir === "long" ? side > 0 : cfg.dir === "short" ? side < 0 : true;
      const al = this.allow === "long" ? side > 0 : this.allow === "short" ? side < 0 : true;
      return lab && al;
    },
    fillEntry(o, px, i) {
      if (this.halted) return;
      const opp = this.lots.filter(l => l.side !== o.side);
      if (opp.length) this.closeLots(opp, px, i, "reverse");
      if (cfg.win && !cfg.win.enter[i]) return; // outside the lab's trading windows: exits only
      if (!this.allowed(o.side)) return;
      if (this.lots.filter(l => l.side === o.side).length >= pyr) return;
      const q = o.qty > 0 ? o.qty : cfg.qty;
      this.lots.push({ id: o.id, side: o.side, qty: q, price: px, bar: i, done: new Set(), trail: {} });
      this.cash -= cost * q;
    },
    closePart(l, q, px, i, why) {
      // remember the most adverse stop-type fill for this bar's intrabar drawdown
      if (why !== "target" && this.intrabar && this.bar0 && this.bar0.net) {
        const f = this.bar0;
        f.fill = f.net > 0 ? Math.min(f.fill, px) : Math.max(f.fill, px);
      }
      const gross = (px - l.price) * l.side * q * pv;
      this.cash += gross - cost * q;
      this.trades.push({ side: l.side, ei: l.bar, xi: i, ep: l.price, xp: px, qty: q, why, id: l.id, pnl: gross - 2 * cost * q });
    },
    closeLots(list, px, i, why) {
      for (const l of list) this.closePart(l, l.qty, px, i, why);
      this.lots = this.lots.filter(l => !list.includes(l));
      const ids = new Set(list.map(l => l.id));
      for (const [k, ex] of this.exits) {
        if ((ex.from && ids.has(ex.from) && !this.lots.some(l => l.id === ex.from)) || (!ex.from && !this.lots.length)) this.exits.delete(k);
      }
    },

    entry(id, dir, qty, limit, stop) {
      const side = dir === 1 || dir === "long" ? 1 : dir === -1 || dir === "short" ? -1 : 0;
      if (!side) throw new PineError("strategy.entry() needs strategy.long or strategy.short", R.line);
      this.pend = this.pend.filter(p => p.id !== id);
      const o = { id: String(id), side, qty: num(qty), limit: num(limit), stop: num(stop) };
      o.market = !(o.limit === o.limit) && !(o.stop === o.stop);
      this.pend.push(o);
      if (o.market && opts.poc) { this.pend.pop(); this.fillEntry(o, b.c[R.i], R.i); }
    },
    close(id, now) {
      if (now || opts.poc) { const list = id === null ? [...this.lots] : this.lots.filter(l => l.id === String(id)); if (list.length) this.closeLots(list, b.c[R.i], R.i, "close"); }
      else this.closeReq.push(id === null ? null : String(id));
    },
    exit(o) {
      o.id = String(o.id); o.from = o.from ? String(o.from) : "";
      this.exits.set(o.id, o);
    },
    cancel(id) {
      if (id === null) { this.pend = []; this.exits.clear(); return; }
      this.pend = this.pend.filter(p => p.id !== String(id));
      this.exits.delete(String(id));
    },

    // Account rules from the lab: the price at which equity reaches a dollar level.
    levelPrice(level) {
      let net = 0, basis = 0;
      for (const x of this.lots) { net += x.side * x.qty; basis += x.price * x.side * x.qty; }
      return net ? ((level - this.cash) / pv + basis) / net : NaN;
    },
    halt(i, px, why) {
      if (this.lots.length) this.closeLots([...this.lots], px, i, why);
      this.halted = true; this.pend = []; this.closeReq = [];
      if (why === "daily") this.rules.limitDays++; else this.rules.blownAt = i;
    },
    checkRules(i) {
      if (!this.lots.length || this.halted) return;
      const net = this.pos(), o = b.o[i], h = b.h[i], l = b.l[i], cands = [];
      if (cfg.dayLimit > 0) cands.push([this.levelPrice(this.dayStart - cfg.dayLimit), "daily"]);
      if (cfg.maxDD > 0) cands.push([this.levelPrice(this.peak - cfg.maxDD), "maxdd"]);
      let sp = null;
      for (const x of cands) if (x[0] === x[0] && (!sp || (net > 0 ? x[0] > sp[0] : x[0] < sp[0]))) sp = x;
      if (sp && (net > 0 ? l <= sp[0] : h >= sp[0])) this.halt(i, net > 0 ? Math.min(sp[0], o) : Math.max(sp[0], o), sp[1]);
    },

    // Orders placed on the previous bar fill on this bar.
    open(i) {
      const o = b.o[i], h = b.h[i], l = b.l[i];
      let net = 0, basis = 0;
      for (const x of this.lots) { net += x.side * x.qty; basis += x.price * x.side * x.qty; }
      this.bar0 = { net, basis, cash: this.cash, fill: net > 0 ? Infinity : -Infinity };
      this.intrabar = true; // fills from here until the script runs happen inside the bar
      const tk = exTime().tday[i];
      if (tk !== this.dayKey) { this.dayKey = tk; this.dayStart = i > 0 ? this.eq[i - 1] : cfg.capital; if (this.rules.blownAt < 0) this.halted = false; }
      for (const r of this.closeReq) { const list = r === null ? [...this.lots] : this.lots.filter(x => x.id === r); if (list.length) this.closeLots(list, o, i, "close"); }
      this.closeReq = [];
      for (const p of this.pend.filter(p => p.market)) this.fillEntry(p, o, i);
      this.pend = this.pend.filter(p => !p.market);
      for (const p of [...this.pend]) {
        let px = NaN;
        if (p.stop === p.stop) { if (p.side > 0 ? h >= p.stop : l <= p.stop) px = p.side > 0 ? Math.max(p.stop, o) : Math.min(p.stop, o); }
        else if (p.side > 0 ? l <= p.limit : h >= p.limit) px = p.side > 0 ? Math.min(p.limit, o) : Math.max(p.limit, o);
        if (px === px) { this.pend.splice(this.pend.indexOf(p), 1); this.fillEntry(p, px, i); }
      }
      this.checkExits(i);
      this.checkRules(i);
      this.intrabar = false;
    },
    checkExits(i) {
      const o = b.o[i], h = b.h[i], l = b.l[i], upFirst = (h - o) < (o - l);
      // Daily limit / max drawdown as stop prices for the whole position (computed once per bar).
      const ruleStops = [];
      if (this.lots.length && !this.halted) {
        if (cfg.dayLimit > 0) ruleStops.push([this.levelPrice(this.dayStart - cfg.dayLimit), "daily"]);
        if (cfg.maxDD > 0) ruleStops.push([this.levelPrice(this.peak - cfg.maxDD), "maxdd"]);
      }
      for (const lot of [...this.lots]) {
        if (!this.lots.includes(lot)) continue;
        const s = lot.side, cands = [];
        for (const ex of this.exits.values()) {
          if ((ex.from && ex.from !== lot.id) || lot.done.has(ex.id)) continue;
          let stop = ex.stop === ex.stop ? ex.stop : ex.loss === ex.loss ? lot.price - s * ex.loss * tick : NaN;
          const limit = ex.limit === ex.limit ? ex.limit : ex.profit === ex.profit ? lot.price + s * ex.profit * tick : NaN;
          if (ex.trailOffset === ex.trailOffset && (ex.trailPoints === ex.trailPoints || ex.trailPrice === ex.trailPrice)) {
            const tr = lot.trail[ex.id] || (lot.trail[ex.id] = { on: false, best: NaN, act: ex.trailPrice === ex.trailPrice ? ex.trailPrice : lot.price + s * ex.trailPoints * tick, off: ex.trailOffset * tick });
            if (tr.on) { const ts = tr.best - s * tr.off; stop = stop === stop ? (s > 0 ? Math.max(stop, ts) : Math.min(stop, ts)) : ts; }
          }
          cands.push({ ex, stop, limit });
        }
        if (cfg.maxLoss > 0) cands.push({ ex: null, stop: lot.price - s * cfg.maxLoss / (pv * lot.qty), limit: NaN, why: "risk" });
        for (const [px, why] of ruleStops) if (px === px) cands.push({ ex: null, stop: px, limit: NaN, why });
        if (cfg.stop > 0 || cfg.tp > 0) cands.push({ ex: null, stop: cfg.stop > 0 ? lot.price * (1 - s * cfg.stop) : NaN, limit: cfg.tp > 0 ? lot.price * (1 + s * cfg.tp) : NaN });
        // Path through the bar: open, then whichever extreme is nearer the open, then the other.
        const tStop = (s > 0) === upFirst ? 2 : 1, tLim = 3 - tStop;
        let fill = null;
        for (const c of cands) {
          const hasS = c.stop === c.stop, hasL = c.limit === c.limit;
          let f = null;
          if (hasS && (s > 0 ? o <= c.stop : o >= c.stop)) f = { px: o, why: "stop", t: 0 };
          else if (hasL && (s > 0 ? o >= c.limit : o <= c.limit)) f = { px: o, why: "target", t: 0 };
          else {
            const sHit = hasS && (s > 0 ? l <= c.stop : h >= c.stop), lHit = hasL && (s > 0 ? h >= c.limit : l <= c.limit);
            if (sHit && (!lHit || tStop <= tLim)) f = { px: c.stop, why: "stop", t: tStop };
            else if (lHit) f = { px: c.limit, why: "target", t: tLim };
          }
          if (!f) continue;
          f.kind = f.why;
          if (f.kind === "stop" && c.why) f.why = c.why;
          // Earliest along the bar's path wins; at the same moment a stop beats a target,
          // and of two stops the tighter one is reached first.
          const better = !fill || f.t < fill.t || (f.t === fill.t && (
            (f.kind === "stop" && fill.kind !== "stop") ||
            (f.kind === "stop" && fill.kind === "stop" && (s > 0 ? f.px > fill.px : f.px < fill.px))));
          if (better) { f.c = c; fill = f; }
        }
        if (fill) {
          const ex = fill.c.ex;
          let q = lot.qty;
          if (ex && ex.qty > 0) q = Math.min(lot.qty, ex.qty);
          else if (ex && ex.qtyPct > 0) q = Math.min(lot.qty, Math.max(1, Math.round(lot.qty * ex.qtyPct / 100)));
          if (q < lot.qty) { this.closePart(lot, q, fill.px, i, fill.why); lot.qty -= q; lot.done.add(ex.id); }
          else this.closeLots([lot], fill.px, i, fill.why);
          if (fill.why === "daily" || fill.why === "maxdd") { this.halt(i, fill.px, fill.why); return; }
        }
        if (this.lots.includes(lot)) for (const tr of Object.values(lot.trail)) {
          if (!tr.on && (s > 0 ? h >= tr.act : l <= tr.act)) { tr.on = true; tr.best = s > 0 ? h : l; }
          else if (tr.on) tr.best = s > 0 ? Math.max(tr.best, h) : Math.min(tr.best, l);
        }
      }
    },
    close_(i) {
      const c = b.c[i];
      if (cfg.win && cfg.winClose && cfg.win.flat[i]) {
        if (this.lots.length) this.closeLots([...this.lots], c, i, "window");
        this.pend = this.pend.filter(p => !p.market);
      }
      const eqNow = this.cash + this.openProfit();
      if (!this.halted && cfg.dayLimit > 0 && eqNow - this.dayStart <= -cfg.dayLimit) this.halt(i, c, "daily");
      if (this.rules.blownAt < 0 && cfg.maxDD > 0 && this.cash + this.openProfit() <= this.peak - cfg.maxDD) this.halt(i, c, "maxdd");
      if (this.halted) this.pend = [];
      const p = this.pos();
      this.held[i] = Math.sign(p); this.posHist[i] = p;
      if (p !== 0) this.inMkt++;
      this.eq[i] = this.cash + this.openProfit();
      // Worst equity of the position held coming into the bar: its adverse extreme, or the stop fill if it was stopped.
      const f = this.bar0;
      let low = this.eq[i];
      if (f && f.net) {
        const worst = f.net > 0 ? Math.max(b.l[i], isFinite(f.fill) ? f.fill : -Infinity) : Math.min(b.h[i], isFinite(f.fill) ? f.fill : Infinity);
        low = Math.min(low, f.cash + (worst * f.net - f.basis) * pv);
      }
      this.eqLow[i] = low;
      this.peak = Math.max(this.peak, this.eq[i]);
    },
    result() {
      const last = n - 1;
      for (const l of this.lots) {
        const gross = (b.c[last] - l.price) * l.side * l.qty * pv;
        this.trades.push({ side: l.side, ei: l.bar, xi: last, ep: l.price, xp: b.c[last], qty: l.qty, why: "open", open: true, id: l.id, pnl: gross - 2 * cost * l.qty });
      }
      return { eq: this.eq, eqLow: this.eqLow, held: this.held, trades: this.trades, rules: this.rules, exposure: this.inMkt / Math.max(1, n) };
    },
  };
  return E;
}

// ---------------------------------------------------------------- evaluator
function X(s, scope, ctx) {
  switch (s.k) {
    case "num": case "str": case "bool": return s.v;
    case "na": return NaN;
    case "name": { const slot = lookup(scope, s.name); return slot ? slot.cur : builtinVar(s.name, R.i); }
    case "idx": {
      const off = Math.round(num(X(s.off, scope, ctx)));
      if (!(off >= 0)) throw new PineError("A history offset [n] must be 0 or more", s.line);
      if (s.obj.k === "name") {
        const slot = lookup(scope, s.obj.name);
        if (slot) return off === 0 ? slot.cur : at(slot.hist, R.i - off);
        if (s.obj.name === "ta.vwap") throw new PineError("Use ta.vwap(hlc3)[n] for VWAP history", s.line);
        return builtinVar(s.obj.name, R.i - off);
      }
      const v = X(s.obj, scope, ctx), h = stateFor(R.bufs, s.id, ctx);
      (h.a || (h.a = []))[R.i] = v;
      return off === 0 ? v : at(h.a, R.i - off);
    }
    case "arr": return s.items.map(x => X(x, scope, ctx));
    case "un": { const v = X(s.e, scope, ctx); return s.op === "not" ? !truthy(v) : s.op === "-" ? -num(v) : num(v); }
    case "bin": {
      if (s.op === "and") return truthy(X(s.l, scope, ctx)) && truthy(X(s.r, scope, ctx));
      if (s.op === "or") return truthy(X(s.l, scope, ctx)) || truthy(X(s.r, scope, ctx));
      const a = X(s.l, scope, ctx), c = X(s.r, scope, ctx);
      switch (s.op) {
        case "+": return typeof a === "string" || typeof c === "string" ? String(a) + String(c) : num(a) + num(c);
        case "-": return num(a) - num(c);
        case "*": return num(a) * num(c);
        case "/": return num(c) === 0 ? NaN : num(a) / num(c);
        case "%": return num(c) === 0 ? NaN : num(a) % num(c);
        case "==": return a === c || (typeof a !== "string" && typeof c !== "string" && num(a) === num(c));
        case "!=": return !(a === c || (typeof a !== "string" && typeof c !== "string" && num(a) === num(c))) && !isNa(a) && !isNa(c);
        case "<": return num(a) < num(c);
        case ">": return num(a) > num(c);
        case "<=": return num(a) <= num(c);
        case ">=": return num(a) >= num(c);
      }
      throw new PineError(`Unknown operator ${s.op}`, s.line);
    }
    case "tern": { // Pine evaluates both branches each bar, so indicators in both stay in sync
      const c = truthy(X(s.c, scope, ctx)), a = X(s.a, scope, ctx), b2 = X(s.b, scope, ctx);
      return c ? a : b2;
    }
    case "call": return call(s, scope, ctx);
    default: return exec(s, scope, ctx);
  }
}

function call(s, scope, ctx) {
  const name = s.name;
  const fn = R.prog.funcs.get(name);
  if (fn) return callUser(fn, s, scope, ctx);
  if (s.inKey) return inputValue(s);
  const f = BUILTINS[name];
  if (!f && (IGNORED_CALLS.has(name) || IGNORED_PREFIX.some(p => name.startsWith(p)))) return NaN;
  if (!f) throw new PineError(`${name}() isn't supported in the lab yet`, s.line);
  const a = s.args.map(x => X(x, scope, ctx)), kw = {};
  for (const k in s.kw) kw[k] = X(s.kw[k], scope, ctx);
  return f(a, kw, stateFor(R.st, s.id, ctx), s, ctx);
}

function inputValue(s) {
  const p = R.prog.inputs.find(q => q.id === s.inKey);
  let v = s.inKey in R.params ? R.params[s.inKey] : p.def;
  switch (p.type) {
    case "num": return num(typeof v === "string" ? parseFloat(v) : v);
    case "bool": return v === true || v === "true";
    case "src": return builtinVar(SOURCES.includes(v) ? v : "close", R.i);
    case "hidden": return typeof p.def === "number" ? p.def : NaN;
    default: return String(v);
  }
}

function callUser(fn, s, scope, ctx) {
  if (R.depth > 40) throw new PineError(`${fn.name}() calls itself; recursion isn't allowed in Pine`, s.line);
  const a = s.args.map(x => X(x, scope, ctx)), kw = {};
  for (const k in s.kw) kw[k] = X(s.kw[k], scope, ctx);
  const nctx = ctx + "/" + s.id, fs = { vars: new Map(), parent: R.global };
  fn.params.forEach((p, j) => {
    const v = j < a.length ? a[j] : p.name in kw ? kw[p.name] : p.def ? X(p.def, R.global, "") : NaN;
    const slot = getSlot(p.id, nctx, false);
    slot.cur = v; slot.lastBar = R.i;
    fs.vars.set(p.name, slot);
  });
  R.depth++;
  try { return execBlock(fn.body, fs, nctx, true); } finally { R.depth--; }
}

function execBlock(stmts, parent, ctx, reuse) {
  const scope = reuse ? parent : { vars: new Map(), parent };
  let last = NaN;
  for (const st of stmts) last = exec(st, scope, ctx);
  return last;
}

function exec(s, scope, ctx) {
  R.line = s.line;
  switch (s.k) {
    case "expr": return X(s.e, scope, ctx);
    case "func": return NaN;
    case "decl": {
      const slot = getSlot(s.id, ctx, s.isVar);
      if (!s.isVar || !slot.init) { slot.cur = X(s.value, scope, ctx); slot.init = true; }
      slot.lastBar = R.i;
      scope.vars.set(s.name, slot);
      return slot.cur;
    }
    case "tuple": {
      const v = X(s.value, scope, ctx);
      if (!Array.isArray(v)) throw new PineError("The right side doesn't return a tuple [a, b, ...]", s.line);
      s.names.forEach((nm, j) => {
        if (nm === "_") return;
        const slot = getSlot(-(s.id * 64 + j), ctx, false);
        slot.cur = v[j]; slot.lastBar = R.i;
        scope.vars.set(nm, slot);
      });
      return NaN;
    }
    case "assign": {
      const slot = lookup(scope, s.name);
      if (!slot) throw new PineError(`"${s.name}" has to be declared with = before := can change it`, s.line);
      let v = X(s.value, scope, ctx);
      if (s.op !== ":=") {
        const a = num(slot.cur), c = num(v);
        v = s.op === "+=" ? (typeof slot.cur === "string" ? slot.cur + v : a + c) : s.op === "-=" ? a - c : s.op === "*=" ? a * c : s.op === "/=" ? (c === 0 ? NaN : a / c) : a % c;
      }
      slot.cur = v; slot.lastBar = R.i;
      return v;
    }
    case "if": {
      if (truthy(X(s.cond, scope, ctx))) return execBlock(s.then, scope, ctx);
      return s.els ? execBlock(s.els, scope, ctx) : NaN;
    }
    case "switch": {
      const subj = s.subject ? X(s.subject, scope, ctx) : undefined;
      for (const c of s.cases) {
        if (c.match === null) return execBlock(c.body, scope, ctx);
        const m = X(c.match, scope, ctx);
        if (s.subject ? m === subj : truthy(m)) return execBlock(c.body, scope, ctx);
      }
      return NaN;
    }
    case "for": {
      const slot = getSlot(s.id, ctx, false), from = num(X(s.from, scope, ctx)), to = num(X(s.to, scope, ctx));
      const step = s.step ? Math.abs(num(X(s.step, scope, ctx))) : 1, dir = to >= from ? 1 : -1;
      if (!(step > 0) || from !== from || to !== to) return NaN;
      const ls = { vars: new Map([[s.name, slot]]), parent: scope };
      let last = NaN;
      for (let v = from; dir > 0 ? v <= to : v >= to; v += dir * step) {
        if (++R.loops > 200000) throw new PineError("A loop ran more than 200,000 times on one bar", s.line);
        slot.cur = v; slot.lastBar = R.i;
        try { last = execBlock(s.body, ls, ctx); } catch (e) { if (e === BRK) break; if (e === CNT) continue; throw e; }
      }
      return last;
    }
    case "while": {
      let last = NaN;
      while (truthy(X(s.cond, scope, ctx))) {
        if (++R.loops > 200000) throw new PineError("A loop ran more than 200,000 times on one bar", s.line);
        try { last = execBlock(s.body, scope, ctx); } catch (e) { if (e === BRK) break; if (e === CNT) continue; throw e; }
      }
      return last;
    }
    case "break": throw BRK;
    case "continue": throw CNT;
  }
  return X(s, scope, ctx);
}

// ---------------------------------------------------------------- run
// bars: { t, o, h, l, c, v, day, mod, intraday, interval } (see the lab's finalize()).
// cfg: { pv, qty, cps, stop, tp, capital, dir: "long"|"short"|"both", maxLoss, dayLimit, maxDD,
//        win: { enter, flat } per-bar trading-window masks from the lab (or null), winClose }
function run(prog, bars, params, cfg) {
  const n = bars.c.length, prevR = R;
  R = { prog, b: bars, n, i: 0, params: params || {}, cfg, line: 0, depth: 0, loops: 0,
    slots: { g: [], m: [] }, st: { g: [], m: [] }, bufs: { g: [], m: [] }, slotList: [], plots: new Map(), ex: null, global: null };
  try {
    R.E = makeEngine(bars, cfg, prog.opts);
    for (let i = 0; i < n; i++) {
      R.i = i; R.loops = 0;
      R.E.open(i);
      R.global = { vars: new Map(), parent: null };
      try { execBlock(prog.body, R.global, "", true); }
      catch (e) {
        if (e === BRK || e === CNT) throw new PineError("break/continue outside a loop", R.line);
        if (e instanceof PineError) throw e;
        throw new PineError(e.message, R.line);
      }
      for (const s of R.slotList) s.hist[i] = s.isVar || s.lastBar === i ? s.cur : NaN;
      R.E.close_(i);
    }
    const res = R.E.result();
    // Plots that live on the price scale go on the price chart; oscillators are left out.
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) { if (bars.l[i] < lo) lo = bars.l[i]; if (bars.h[i] > hi) hi = bars.h[i]; }
    res.plots = [...R.plots.values()].filter(p => {
      const v = Array.from(p.data).filter(x => x === x).sort((x, y) => x - y);
      return v.length && v[v.length >> 1] > lo * 0.5 && v[v.length >> 1] < hi * 2;
    });
    return res;
  } finally { R = prevR; }
}

const Pine = { compile, run, PineError, SOURCES };
if (typeof module === "object" && module.exports) module.exports = Pine;
else root.Pine = Pine;
})(typeof window !== "undefined" ? window : globalThis);
