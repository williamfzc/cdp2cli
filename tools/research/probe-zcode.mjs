/**
 * probe-zcode.mjs — live CDP probe (ZCode 3.11.2 / Electron 41.0.3)
 * Adapted from the probe5/7/8 templates; zero dependencies, Node >= 22
 * Port: 9227
 * Read-only throughout; never mutates user data
 */

const PORT = 9227;
const BASE = `http://127.0.0.1:${PORT}`;

// ── CDP basics ──────────────────────────────────────────────
const ver = await (await fetch(`${BASE}/json/version`)).json();
const targets = await (await fetch(`${BASE}/json`)).json();

console.log('═══════════════════════════════════════════════════');
console.log('  ZCode CDP Probe Report');
console.log('═══════════════════════════════════════════════════');

// ── a. Target enumeration ───────────────────────────────────────────
console.log('\n── a. Target enumeration (/json) ──');
console.log(`Browser: ${ver.Browser} | UA: ${ver['User-Agent']}`);
console.log(`webSocketDebuggerUrl: ${ver.webSocketDebuggerUrl}`);
console.log(`\n${targets.length} targets in total:`);
targets.forEach((t, i) => {
  console.log(`  [${i}] type=${t.type}  title="${t.title || '(none)'}"`);
  console.log(`      url=${t.url || '(none)'}`);
  console.log(`      ws=${t.webSocketDebuggerUrl}`);
});

const pageTarget = targets.find(t => t.type === 'page');
if (!pageTarget) { console.error('no page target found, exiting'); process.exit(1); }

// ── Connect the browser-level WebSocket ───────────────────────────────────
const ws = new WebSocket(ver.webSocketDebuggerUrl);
let id = 0;
const pend = new Map();
const sessInfo = new Map();   // sid -> "type url"
const traffic = new Map();    // sid -> Set(host+path)
const wsFrames = [];
const scripts = new Map();    // url -> {sid, len, scriptId}
const ipcLog = [];

const send = (m, p = {}, sid) => new Promise(r => {
  const i = ++id;
  pend.set(i, r);
  ws.send(JSON.stringify({ sessionId: sid, id: i, method: m, params: p }));
});
const evOn = async (sid, expr) =>
  (await send('Runtime.evaluate', { expression: expr, returnByValue: true }, sid))?.result?.value;

ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); return; }
  const sid = m.sessionId || 'browser';

  if (m.method === 'Target.attachedToTarget') {
    const ti = m.params.targetInfo;
    sessInfo.set(m.params.sessionId, ti.type + ' ' + (ti.url || '').slice(0, 60));
    traffic.set(m.params.sessionId, new Set());
    send('Network.enable', {}, m.params.sessionId);
    send('Runtime.enable', {}, m.params.sessionId);
    send('Debugger.enable', {}, m.params.sessionId);
  }
  if (m.method === 'Debugger.scriptParsed' && m.params?.url && !m.params.url.startsWith('extensions::')) {
    scripts.set(m.params.url, { sid, len: m.params.length || 0, scriptId: m.params.scriptId });
  }
  if (m.method === 'Network.requestWillBeSent') {
    try {
      const u = new URL(m.params.request.url);
      traffic.get(sid)?.add(`${u.protocol}//${u.host}${u.pathname}`.slice(0, 120));
    } catch {}
  }
  if (/webSocketFrame(Sent|Received)/.test(m.method) && wsFrames.length < 20) {
    const pl = m.params.response?.payloadData || '';
    wsFrames.push(`${(sessInfo.get(sid) || sid).slice(0, 30)} ${m.method.endsWith('Sent') ? '→' : '←'} ${pl.slice(0, 150)}`);
  }
};

await new Promise(r => ws.onopen = r);
console.log('\n[WS] browser-level connection established');

// Auto-attach every target (flatten mode)
await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
await new Promise(r => setTimeout(r, 3000));

console.log(`\n${sessInfo.size} sessions attached:`);
for (const [sid, info] of sessInfo) console.log(`  ${sid.slice(0, 12)}…  ${info}`);

// Find the main page session
const mainSid = [...sessInfo.entries()].find(([, v]) => v.startsWith('page '))?.[0];
console.log(`\nmain page sid: ${mainSid?.slice(0, 16)}…`);

if (!mainSid) { console.error('main page session not found'); ws.close(); process.exit(1); }

// ── b. Bridge surface discovery ────────────────────────────────────────────
console.log('\n── b. Bridge surface discovery (non-standard window properties) ──');

const bridgeResult = await evOn(mainSid, `
(() => {
  // Native DOM/Window property whitelist (filters out standard properties)
  const native = new Set();
  // Collect standard properties from a clean iframe
  try {
    const f = document.createElement('iframe');
    f.style.display = 'none';
    document.body.appendChild(f);
    const w = f.contentWindow;
    for (const k of Object.getOwnPropertyNames(w)) native.add(k);
    for (const k of Object.getOwnPropertyNames(Object.getPrototypeOf(w))) native.add(k);
    document.body.removeChild(f);
  } catch(e) {}

  const nonStandard = [];
  for (const k of Object.getOwnPropertyNames(window)) {
    if (!native.has(k)) nonStandard.push(k);
  }
  // Also check enumerable properties on the prototype chain
  for (const k in window) {
    if (!native.has(k) && !nonStandard.includes(k)) nonStandard.push(k);
  }

  const result = {
    nonStandardProps: nonStandard.sort(),
    hasProcess: typeof window.process !== 'undefined',
    hasRequire: typeof window.require !== 'undefined',
    hasElectron: typeof window.electron !== 'undefined',
    bridgeObjects: {}
  };

  // For each non-standard object, enumerate its methods
  for (const key of nonStandard) {
    try {
      const val = window[key];
      if (val && typeof val === 'object') {
        const methods = [];
        const props = [];
        for (const k of Object.getOwnPropertyNames(val)) {
          try {
            if (typeof val[k] === 'function') methods.push(k);
            else props.push(k);
          } catch(e) {}
        }
        // Prototype-chain methods
        let proto = Object.getPrototypeOf(val);
        while (proto && proto !== Object.prototype) {
          for (const k of Object.getOwnPropertyNames(proto)) {
            if (typeof proto[k] === 'function' && !methods.includes(k)) methods.push(k);
          }
          proto = Object.getPrototypeOf(proto);
        }
        result.bridgeObjects[key] = { methods: methods.sort(), props: props.sort(), type: typeof val };
      } else if (typeof val === 'function') {
        result.bridgeObjects[key] = { type: 'function' };
      }
    } catch(e) {
      result.bridgeObjects[key] = { error: String(e) };
    }
  }
  return JSON.stringify(result);
})()`);

try {
  const bridge = JSON.parse(bridgeResult);
  console.log(`non-standard window properties (${bridge.nonStandardProps.length}): ${bridge.nonStandardProps.join(', ')}`);
  console.log(`window.process: ${bridge.hasProcess}  |  window.require: ${bridge.hasRequire}  |  window.electron: ${bridge.hasElectron}`);
  console.log('\nbridge object details:');
  for (const [name, info] of Object.entries(bridge.bridgeObjects)) {
    if (info.methods) {
      console.log(`  window.${name} (${info.type}):`);
      console.log(`    methods (${info.methods.length}): ${info.methods.join(', ')}`);
      if (info.props.length) console.log(`    props (${info.props.length}): ${info.props.join(', ')}`);
    } else {
      console.log(`  window.${name}: ${info.type || info.error}`);
    }
  }
} catch (e) {
  console.log('bridge surface parse failed:', e.message);
  console.log('raw output:', bridgeResult);
}

// ── c. Feature surface enumeration (DOM) ──────────────────────────────────────
console.log('\n── c. Capability surface enumeration (visible DOM elements) ──');

const domResult = await evOn(mainSid, `
(() => {
  const els = document.querySelectorAll('a,button,[role="tab"],[role="menuitem"],li,[data-testid]');
  const seen = new Set();
  const items = [];
  for (const el of els) {
    if (!el.offsetParent) continue; // not visible
    const text = (el.innerText || el.textContent || '').trim().split('\\n')[0];
    if (!text || text.length < 2 || text.length > 20) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || '';
    const testid = el.getAttribute('data-testid') || '';
    items.push({ text, tag, role, testid });
    if (items.length >= 30) break;
  }
  return JSON.stringify({ total: els.length, visible: items.length, items });
})()`);

try {
  const dom = JSON.parse(domResult);
  console.log(`DOM matched elements: ${dom.total}, visible short-text: ${dom.visible}`);
  dom.items.forEach((it, i) => {
    const extra = [it.role && `role=${it.role}`, it.testid && `data-testid=${it.testid}`].filter(Boolean).join(' ');
    console.log(`  ${String(i+1).padStart(2)}. [${it.tag}] ${it.text}${extra ? '  (' + extra + ')' : ''}`);
  });
} catch (e) {
  console.log('DOM enumeration failed:', e.message);
}

// ── d. Script inventory ──────────────────────────────────────────────
console.log('\n── d. Script inventory (scriptParsed) ──');
// Debugger.enable was already on from autoAttach; wait a few more seconds for scripts
await new Promise(r => setTimeout(r, 5000));

const scriptUrls = [...scripts.entries()].filter(([u]) => !u.startsWith('devtools'));
const bigScripts = scriptUrls.filter(([, s]) => s.len > 30 * 1024);
console.log(`total scripts: ${scripts.size} (after devtools filter: ${scriptUrls.length})`);
console.log(`chunks >30KB: ${bigScripts.length}`);
console.log('\nTop 20 largest scripts:');
scriptUrls.sort((a, b) => b[1].len - a[1].len).slice(0, 20).forEach(([u, s], i) => {
  console.log(`  ${String(i+1).padStart(2)}. ${(s.len/1024).toFixed(1).padStart(7)}KB  ${u.replace(/\?.*$/, '').slice(0, 90)}`);
});

// ── e. Traffic listening (5s idle) ─────────────────────────────────
console.log('\n── e. Idle traffic profile (5s) ──');
// Reset collected traffic and restart the timer
for (const s of traffic.values()) s.clear();
await new Promise(r => setTimeout(r, 5000));

let totalReqs = 0;
const allDomains = new Set();
for (const [sid, set] of traffic) {
  if (!set.size) continue;
  totalReqs += set.size;
  console.log(`\n  [${(sessInfo.get(sid) || sid).slice(0, 45)}] ${set.size} requests:`);
  for (const u of set) {
    console.log(`    ${u}`);
    try { allDomains.add(new URL(u).host); } catch {}
  }
}
console.log(`\ntotal idle requests: ${totalReqs}`);
console.log(`domains involved: ${[...allDomains].join(', ') || '(none)'}`);
console.log(`WebSocket frames: ${wsFrames.length}`);
wsFrames.slice(0, 8).forEach(f => console.log(`  ${f}`));

// ── f. IPC hook (rewritten: explicit enumeration + replaceability tests + verification) ────
console.log('\n── f. IPC hook installation (rewritten) ──');

// f-a. Explicitly enumerate known contextBridge objects (no regex guessing)
const BRIDGE_CANDIDATES = ['zcode', 'cuaPermissionPanel', 'processMonitor', 'ArmsEventBridge', 'RumSDK', 'ArmsRumBrowser'];
const bridgeEnumExpr = `
(() => {
  const result = [];
  const CANDIDATES = ${JSON.stringify(BRIDGE_CANDIDATES)};
  for (const name of CANDIDATES) {
    const obj = window[name];
    if (!obj || typeof obj !== 'object') continue;
    // Collect all methods: own properties + prototype chain (excluding Object.prototype); keep only data-descriptor functions
    const methodSet = new Set();
    for (const k of Object.getOwnPropertyNames(obj)) {
      const d = Object.getOwnPropertyDescriptor(obj, k);
      if (d && typeof d.value === 'function') methodSet.add(k);
    }
    let proto = Object.getPrototypeOf(obj);
    while (proto && proto !== Object.prototype) {
      for (const k of Object.getOwnPropertyNames(proto)) {
        const d = Object.getOwnPropertyDescriptor(proto, k);
        if (d && typeof d.value === 'function') methodSet.add(k);
      }
      proto = Object.getPrototypeOf(proto);
    }
    // f-b. Test replaceability one by one
    const methods = [];
    for (const m of methodSet) {
      let desc = Object.getOwnPropertyDescriptor(obj, m);
      let source = 'own';
      if (!desc) {
        let p = Object.getPrototypeOf(obj);
        while (p && p !== Object.prototype) {
          desc = Object.getOwnPropertyDescriptor(p, m);
          if (desc) { source = 'proto'; break; }
          p = Object.getPrototypeOf(p);
        }
      }
      if (!desc) { methods.push({ name: m, writable: false, configurable: false, source: 'unknown' }); continue; }
      methods.push({ name: m, writable: !!desc.writable, configurable: !!desc.configurable, source });
    }
    result.push({ name, methodCount: methods.length, methods });
  }
  return JSON.stringify(result);
})()`;

const bridgeEnumRaw = await evOn(mainSid, bridgeEnumExpr);
let bridgeObjects = [];
try { bridgeObjects = JSON.parse(bridgeEnumRaw); } catch (e) { console.log('bridge enumeration parse failed:', e.message, bridgeEnumRaw); }

console.log(`\n${bridgeObjects.length} bridge objects found:`);
let totalWritable = 0, totalConfigOnly = 0, totalNonRepl = 0;
for (const bo of bridgeObjects) {
  const w = bo.methods.filter(m => m.writable).length;
  const c = bo.methods.filter(m => !m.writable && m.configurable).length;
  const n = bo.methods.filter(m => !m.writable && !m.configurable).length;
  totalWritable += w; totalConfigOnly += c; totalNonRepl += n;
  console.log(`  window.${bo.name}: ${bo.methodCount} methods → writable=${w}, configurable-only=${c}, non-replaceable=${n}`);
}
console.log(`\nreplaceability totals: writable=${totalWritable}, configurable-only=${totalConfigOnly}, non-replaceable=${totalNonRepl}`);

// f-c. Build the hook script (handled by replaceability class)
let hooksInstalled = false;
if (bridgeObjects.length > 0) {
  const hookScript = `
(function() {
  if (window.__zcodeIpcHooked) return;
  window.__zcodeIpcBuf = [];
  window.__zcodeIpcHookStats = { wrapped: 0, failed: 0, skipped: 0 };
  const rec = function(objName, method, args) {
    try {
      let arg0 = '';
      if (args.length > 0) {
        try { arg0 = JSON.stringify(args[0]).slice(0, 120); } catch(e) { arg0 = String(args[0]).slice(0, 120); }
      }
      window.__zcodeIpcBuf.push(objName + '.' + method + '|' + arg0);
    } catch(e) {}
  };
${bridgeObjects.map(bo => {
    const objName = bo.name;
    const blocks = bo.methods.map(m => {
      if (!m.configurable && !m.writable) {
        return `    /* ${objName}.${m.name}: non-replaceable (configurable=false,writable=false), skipped */ window.__zcodeIpcHookStats.skipped++;`;
      }
      if (m.writable) {
        return `    try {
      var _o_${m.name} = obj['${m.name}'].bind(obj);
      var _w_${m.name} = function() { rec('${objName}', '${m.name}', arguments); return _o_${m.name}.apply(this, arguments); };
      _w_${m.name}.__wrapped = true;
      obj['${m.name}'] = _w_${m.name};
      window.__zcodeIpcHookStats.wrapped++;
    } catch(e) { window.__zcodeIpcHookStats.failed++; }`;
      }
      // configurable=true, writable=false → Object.defineProperty
      return `    try {
      var _o_${m.name} = obj['${m.name}'].bind(obj);
      var _w_${m.name} = function() { rec('${objName}', '${m.name}', arguments); return _o_${m.name}.apply(this, arguments); };
      _w_${m.name}.__wrapped = true;
      Object.defineProperty(obj, '${m.name}', { value: _w_${m.name}, configurable: true, writable: true });
      window.__zcodeIpcHookStats.wrapped++;
    } catch(e) { window.__zcodeIpcHookStats.failed++; }`;
    }).join('\n');
    return `  (function() {
    var obj = window['${objName}'];
    if (!obj) return;
${blocks}
  })();`;
  }).join('\n')}
  window.__zcodeIpcHooked = true;
})();`;

  const addResult = await send('Page.addScriptToEvaluateOnNewDocument', { source: hookScript }, mainSid);
  console.log(`Page.addScriptToEvaluateOnNewDocument: identifier=${addResult?.identifier}`);
  await evOn(mainSid, hookScript);
  console.log('instant hook installed on current page');
  hooksInstalled = true;

  // f-d. Verify the hook actually took effect
  const verifyExpr = `
(() => {
  const stats = window.__zcodeIpcHookStats || { wrapped: 0, failed: 0, skipped: 0 };
  const checks = [];
  const names = ${JSON.stringify(bridgeObjects.map(b => b.name))};
  for (const objName of names) {
    const obj = window[objName];
    if (!obj) continue;
    const allMethods = Object.getOwnPropertyNames(obj).filter(function(m) { return typeof obj[m] === 'function'; });
    let wrappedCount = 0;
    const sampleWrapped = [];
    for (const m of allMethods) {
      if (obj[m] && obj[m].__wrapped) { wrappedCount++; if (sampleWrapped.length < 3) sampleWrapped.push(m); }
    }
    checks.push({ obj: objName, total: allMethods.length, wrapped: wrappedCount, samples: sampleWrapped });
  }
  // Specifically check window.zcode.selectFile
  var sfCheck = null;
  if (window.zcode && window.zcode.selectFile) {
    sfCheck = { __wrapped: !!window.zcode.selectFile.__wrapped, type: typeof window.zcode.selectFile };
  }
  return JSON.stringify({ stats, checks, selectFileCheck: sfCheck });
})()`;
  const verifyRaw = await evOn(mainSid, verifyExpr);
  try {
    const v = JSON.parse(verifyRaw);
    console.log(`\nHook verification result:`);
    console.log(`  stats: wrapped=${v.stats.wrapped}, failed=${v.stats.failed}, skipped(non-replaceable)=${v.stats.skipped}`);
    v.checks.forEach(c => console.log(`  window.${c.obj}: ${c.wrapped}/${c.total} methods tagged __wrapped (samples: ${c.samples.join(', ') || 'none'})`));
    if (v.selectFileCheck) console.log(`  window.zcode.selectFile.__wrapped = ${v.selectFileCheck.__wrapped} (${v.selectFileCheck.type})`);
  } catch (e) {
    console.log('verification parse failed:', e.message, verifyRaw);
  }
} else {
  console.log('no bridge objects found, skipping hook installation');
}

// ── g. Read-only trigger experiment ──────────────────────────────────────────
console.log('\n── g. Read-only trigger experiment ──');

// Record traffic before the trigger
const trafficBefore = new Map();
for (const [sid, set] of traffic) trafficBefore.set(sid, new Set(set));
const ipcBefore = ipcLog.length;

// Find one safe read-only navigation item
const safeCandidates = await evOn(mainSid, `
(() => {
  const SAFE = ['设置', '历史', '历史记录', '模型', '模型列表', '关于', '帮助', '快捷键', '主题', '外观', '插件', '扩展', '偏好', '配置']; // ZCode sidebar labels — the app UI is Chinese, kept as match patterns
  const els = document.querySelectorAll('a,button,[role="tab"],[role="menuitem"],li,[data-testid]');
  const found = [];
  for (const el of els) {
    if (!el.offsetParent) continue;
    const text = (el.innerText || el.textContent || '').trim().split('\\n')[0];
    if (!text) continue;
    if (SAFE.some(s => text.includes(s)) && !found.some(f => f.text === text)) {
      found.push({ text, tag: el.tagName.toLowerCase() });
    }
  }
  return JSON.stringify(found.slice(0, 10));
})()`);

let candidates = [];
try { candidates = JSON.parse(safeCandidates); } catch {}
console.log(`safe navigation candidates: ${candidates.length > 0 ? candidates.map(c => c.text).join(', ') : '(none)'}`);

if (candidates.length > 0) {
  const target = candidates[0];
  console.log(`clicking: [${target.text}] (read-only navigation / view switch)`);

  const clickResult = await evOn(mainSid, `
    (() => {
      const SAFE = ${JSON.stringify(['设置', '历史', '历史记录', '模型', '模型列表', '关于', '帮助', '快捷键', '主题', '外观', '插件', '扩展', '偏好', '配置'])};
      const els = document.querySelectorAll('a,button,[role="tab"],[role="menuitem"],li,[data-testid]');
      for (const el of els) {
        if (!el.offsetParent) continue;
        const text = (el.innerText || el.textContent || '').trim().split('\\n')[0];
        if (text === ${JSON.stringify(target.text)}) { el.click(); return 'clicked: ' + text; }
      }
      return 'not found';
    })()`);
  console.log(`click result: ${clickResult}`);

  // Wait 5s to collect post-trigger traffic and IPC
  await new Promise(r => setTimeout(r, 5000));

  // Traffic newly seen after the trigger
  console.log('\nnew requests after the trigger:');
  let newReqs = 0;
  for (const [sid, set] of traffic) {
    const before = trafficBefore.get(sid) || new Set();
    const added = [...set].filter(u => !before.has(u));
    if (added.length) {
      console.log(`  [${(sessInfo.get(sid) || sid).slice(0, 40)}]:`);
      added.forEach(u => console.log(`    + ${u}`));
      newReqs += added.length;
    }
  }
  console.log(`total new requests: ${newReqs}`);

  // IPC calls (collected only when the hook is installed)
  if (hooksInstalled) {
    const ipcBuf = await evOn(mainSid, `JSON.stringify((window.__zcodeIpcBuf || []).slice(0, 50))`);
    try {
      const buf = JSON.parse(ipcBuf);
      // Keep calls on the zcode bridge object (exclude non-core objects like ArmsEventBridge)
      const zcodeCalls = buf.filter(l => l.startsWith('zcode.'));
      console.log(`\nIPC calls after the trigger (${buf.length} total, ${zcodeCalls.length} on zcode.*):`);
      buf.forEach(l => console.log(`  ${l}`));
    } catch { console.log('IPC buffer:', ipcBuf); }
  } else {
    console.log('\n(hook not installed, skipping IPC call collection)');
  }
} else {
  console.log('no safe read-only navigation item found, skipping click trigger');
}

// ── Wrap-up ─────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════');
console.log('  probe complete, closing connection');
console.log('═══════════════════════════════════════════════════');
ws.close();
process.exit(0);
