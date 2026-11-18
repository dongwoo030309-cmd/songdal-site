/* 아이폰 방문표. plan.json 을 읽어 지도·다음 방문지·남은 순서 재정렬을 처리. 네트워크 없이도 재정렬은 됨. */
const $ = (id) => document.getElementById(id);
const CFG = window.SONGDAL_CONFIG || {};
const LOCAL = new URLSearchParams(location.search).get("local") === "1";
const S = { plan: null, map: null, markers: {}, lines: [], order: [], done: {}, showList: false, selected: null, fallbackNote: "" };
const RULE_CLASS = { "오전": "morning", "주간": "day", "야간": "night", "휴일": "holiday" };
const RULE_COLOR = (r) => r === "야간" ? "#5b4bb5" : r === "오전" ? "#c2640f" : r === "휴일" ? "#a23b72" : "#1b5e4a";
const hhmm = (s) => { s = Math.round(s) % 86400; return String(Math.floor(s / 3600)).padStart(2, "0") + ":" + String(Math.floor(s % 3600 / 60)).padStart(2, "0"); };
const mins = (s) => Math.round(s / 60) + "분";
const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const nowSec = () => { const d = new Date(); return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds(); };

/* ---------- 데이터 ---------- */
function b64uToBytes(t) { t = t.replace(/-/g, "+").replace(/_/g, "/"); while (t.length % 4) t += "="; const bin = atob(t); return Uint8Array.from(bin, (c) => c.charCodeAt(0)); }
function takeKeyFromHash() {
  const m = (location.hash || "").match(/[#&]k=([A-Za-z0-9_\-]+)/);
  if (m) { localStorage.setItem("songdal_key", m[1]); history.replaceState(null, "", location.pathname + location.search); }
  return localStorage.getItem("songdal_key");
}
async function loadPlan() {
  if (LOCAL) { const r = await fetch("plan.json", { cache: "no-store" }); if (!r.ok) throw new Error("맥에서 아직 순서를 계산하지 않았어요."); return r.json(); }
  const keyB64u = takeKeyFromHash();
  if (!keyB64u) { showGate(); throw new Error("gate"); }
  let text = null, fresh = false;
  S.offline = false;
  try {
    const r = await fetch("plan.enc.txt?t=" + Date.now(), { cache: "no-store" });
    if (r.status === 404) throw new Error("올라온 방문표가 없어요. 맥에서 '아이폰에 올리기'를 눌러 주세요.");
    if (!r.ok) throw new Error("방문표를 받지 못했어요 (" + r.status + "). 잠시 후 ↻ 를 눌러 주세요.");
    text = (await r.text()).trim();
    if (r.headers.get("X-Songdal-Offline")) S.offline = true;
    fresh = true;
  } catch (err) {
    // 인터넷이 안 될 때: 마지막으로 받은 방문표(암호문)를 씀
    text = localStorage.getItem("songdal_last_enc");
    if (!text) throw new Error(err.message && !/fetch|network|load/i.test(err.message) ? err.message : "인터넷에 연결되지 않았고, 이 아이폰에 저장된 방문표도 없어요.");
    S.offline = true;
    S.samePlanText = true;   // 저장해 둔 방문표를 그대로 씀
  }
  const raw = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  try {
    const key = await crypto.subtle.importKey("raw", b64uToBytes(keyB64u), "AES-GCM", false, ["decrypt"]);
    const data = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12) }, key, raw.slice(12));
    const plan = JSON.parse(new TextDecoder().decode(data));
    if (fresh) {
      // 지난번에 '풀어서 쓴' 방문표(암호문)와 글자까지 같으면 같은 방문표. 다시 올린 것이면 암호문이 달라짐.
      // 열쇠가 틀려 못 푼 암호문은 저장하지 않음 → 다시 시도해도 지난번 방문표와 제대로 비교됨.
      S.samePlanText = localStorage.getItem("songdal_last_enc") === text;
      try { localStorage.setItem("songdal_last_enc", text); } catch (e) {}
    }
    return plan;
  } catch (e) {
    showGate("열쇠가 맞지 않아요. 맥 설정 5번에서 '아이폰 연결 링크'를 다시 보내서 열어 주세요.");
    throw new Error("gate");
  }
}
function showGate(msg) { $("gate").classList.remove("hidden"); $("app").classList.add("hidden"); if (msg) $("gate-msg").textContent = msg; }
$("gate-save").onclick = () => {
  const t = $("gate-token").value.trim(); if (!t) return;
  const m = t.match(/[#&]k=([A-Za-z0-9_\-]+)/) || t.match(/^([A-Za-z0-9_\-]{40,})$/);
  if (!m) { $("gate-msg").textContent = "링크 형식이 아니에요. 맥에서 복사한 연결 링크를 그대로 붙여 주세요."; return; }
  localStorage.setItem("songdal_key", m[1]); $("gate-token").value = ""; $("gate").classList.add("hidden"); boot();
};

/* 방문 결과: 마침을 누를 때 고름. 기록에는 전달 완료가 아닌 것만 남김(S.res). 맥 history.RESULTS 와 같은 이름 */
const RESULTS = { ok: "전달 완료", absent: "부재", addr: "주소 문제" };
const resultOf = (i) => (S.done[i] ? ((S.res || {})[i] && RESULTS[S.res[i]] ? S.res[i] : "ok") : null);
/* 오늘 다시 방문: 부재·주소 문제였던 곳을 첫 방문 기록은 남긴 채(S.tries) 남은 순서에 다시 넣음.
   넣을 자리는 남은 순서의 모든 자리에 넣어 보고 가장 나은 곳(제시간에 갈 수 있는 곳 수 → 끝나는 시각 → 운전)으로 정함.
   newRem 을 주면 그 순서대로 넣음(확인 창에서 보여 준 자리 그대로). */
function revisit(i, newRem) {
  const rk = resultOf(i); if (!rk || rk === "ok") return;
  snapshot(`서류 ${docNumber(i)}번 다시 방문`);
  S.tries = S.tries || {}; (S.tries[i] = S.tries[i] || []).push({ at: S.done[i], res: rk });
  delete S.done[i]; if (S.res) delete S.res[i];
  const rem = newRem || S.order.filter((x) => x !== i && !S.done[x]).concat([i]);
  S.order = S.order.filter((x) => S.done[x]).concat(rem);
  saveDone();
}
function planRevisit(i) {
  const rest = remaining().filter((x) => x !== i), base = liveBase(false);
  let best = null;
  for (let k = 0; k <= rest.length; k++) {
    const cand = rest.slice(0, k).concat([i], rest.slice(k)); const sc = score(cand, base.origin, base.t);
    if (!best || less(sc, best.sc)) best = { sc, order: cand, k };
  }
  const sim = simulate(best.order, base.origin, base.t);
  return { order: best.order, pos: best.k + 1, row: (sim.rows || []).find((r) => r.i === i) || null, ok: sim.ok };
}
/* 다시 방문 확인 창: 넣을 자리·예상 도착·시간 조건을 먼저 보여 주고, 주소 문제였던 곳은 주소를 확인했는지 물음 */
function askRevisit(i) {
  const st = stopOf(i), rk = resultOf(i), pr = planRevisit(i), box = $("recalc"), r = pr.row;
  const win = st.rule === "아무때나" ? "" : `${st.rule} ${hhmm(st.window[0])}–${hhmm(st.window[1])}`;
  box.innerHTML = `<div class="rc-card">
    <div class="rc-title">서류 ${docNumber(i)}번 다시 방문</div>
    <div class="basis">${esc(st.label || st.place || "")} · 앞선 방문: ${RESULTS[rk]} ${hhmm(S.done[i])}</div>
    <div class="rv-info">남은 순서 <b>${pr.pos}번째</b>에 넣어요${r ? ` · 예상 <b>${hhmm(r.arrive)}</b> 도착${r.wait > 60 ? ` (${hhmm(r.begin)}부터 송달)` : ""}` : ""}</div>
    ${win ? `<div class="rv-cond${!r || r.late ? " late" : ""}">${!r ? `⚠ 예상 시각을 계산하지 못했어요 (${esc(win)} 조건 확인 필요)` : r.late ? (r.miss ? `⚠ 이 자리에 넣으면 ${esc(win)} 조건을 넘겨요 (<b>오늘 중 방문</b>)` : `⚠ ${esc(win)} 조건이 지나서 <b>오늘 중 방문</b>으로 들어가요`) : `${esc(win)} 조건 안에 갈 수 있어요`}</div>` : ""}
    ${pr.ok ? "" : `<div class="rv-cond late">⚠ 다시 넣으면 퇴근 기한 안에 다 못 돌 수 있어요</div>`}
    ${rk === "addr" ? `<div class="rv-cond">주소 문제였던 곳이에요. 주소를 확인한 뒤에 다시 넣어 주세요.</div>` : ""}
    <div class="actions"><button class="ghost" id="rv-cancel">그만두기</button><button id="rv-go">${rk === "addr" ? "주소 확인했어요 · 넣기" : "다시 넣기"}</button></div></div>`;
  box.classList.remove("hidden");
  $("rv-cancel").onclick = () => { box.classList.add("hidden"); S.ghostDraft = null; };
  $("rv-go").onclick = () => {
    box.classList.add("hidden");
    revisit(i, pr.order); S.ghost = { i, pos: pr.pos, ...(S.ghostDraft || {}) }; S.ghostDraft = null;
    render(); toast(`서류 ${docNumber(i)}번을 남은 순서 ${pr.pos}번째에 다시 넣었어요`, "되돌리기", undo, 8000);
  };
}
/* 기록한 곳의 줄을 누르면: 기록 내용과 [기록 취소] (목록 줄에서 바로 누르지 않게 따로 뺌) */
function askRecord(i) {
  const st = stopOf(i), rk = resultOf(i), box = $("recalc");
  box.innerHTML = `<div class="rc-card">
    <div class="rc-title">서류 ${docNumber(i)}번 · ${RESULTS[rk]} ${hhmm(S.done[i])}</div>
    <div class="basis">${esc(st.label || st.place || "")}${triesText(i) ? ` · 앞선 방문: ${esc(triesText(i))}` : ""}</div>
    <div class="hint" style="margin:10px 0">기록 취소는 잘못 누른 기록을 지울 때만 써요. 지우면 이 곳은 남은 순서로 돌아가요.</div>
    <div class="actions">${rk !== "ok" ? `<button class="wide" id="ra-again">다시 방문…</button>` : ""}<button class="ghost warn" id="ra-undo">기록 취소</button><button class="ghost" id="ra-close">닫기</button></div></div>`;
  box.classList.remove("hidden");
  $("ra-close").onclick = () => { box.classList.add("hidden"); S.ghostDraft = null; };
  if ($("ra-again")) $("ra-again").onclick = () => askRevisit(i);
  $("ra-undo").onclick = () => { box.classList.add("hidden"); S.ghost = null; S.ghostDraft = null; snapshot(`서류 ${docNumber(i)}번 기록 취소`); delete S.done[i]; if (S.res) delete S.res[i]; saveDone(); render(); toast(`서류 ${docNumber(i)}번 기록을 취소했어요`, "되돌리기", undo, 8000); };
}
/* 되돌리기 버튼 글씨: 무엇을 되돌리는지 (예: '↶ 서류 2번') */
function undoText() { const h = (S.history || [])[S.history.length - 1]; const m = h && /서류 \d+번/.exec(h.label || ""); return m ? `↶ ${m[0]}` : "↶ 되돌리기"; }
const triesText = (i) => ((S.tries || {})[i] || []).map((t) => `${RESULTS[t.res] || "방문"} ${hhmm(t.at)}`).join(", ");
function resultCounts() { const c = { ok: 0, absent: 0, addr: 0 }; S.order.forEach((i) => { const r = resultOf(i); if (r) c[r]++; }); return c; }
function countsText(c) { return [`전달 ${c.ok}`, c.absent ? `부재 ${c.absent}` : "", c.addr ? `주소 문제 ${c.addr}` : ""].filter(Boolean).join(" · "); }
const storeKey = () => "songdal_done_" + (S.plan ? S.plan.date : "");
/* 지난 날짜 기록 정리: 최근 3일치(오늘 포함)와 아직 전송 안 된 날짜만 남기고 지움. Safari 저장 한도(약 5MB)를 넘지 않게. */
function pruneOldDays() {
  try {
    const dates = new Set();
    for (let k = 0; k < localStorage.length; k++) { const m = /^songdal_(?:done|sync)_(\d{4}-\d{2}-\d{2})/.exec(localStorage.key(k)); if (m) dates.add(m[1]); }
    const keep = new Set([...dates].sort().slice(-3).concat(S.plan ? [S.plan.date] : []));
    // 맥으로 아직 전송되지 않은 날짜(미저장 표시가 남은 날)는 며칠이 지나도 지우지 않음
    for (let k = 0; k < localStorage.length; k++) { const m = /^songdal_sync_(\d{4}-\d{2}-\d{2})$/.exec(localStorage.key(k)); if (m) keep.add(m[1]); }
    const drop = [];
    for (let k = 0; k < localStorage.length; k++) { const key = localStorage.key(k), m = /^songdal_(?:done|sync)_(\d{4}-\d{2}-\d{2})/.exec(key); if (m && !keep.has(m[1])) drop.push(key); }
    drop.forEach((key) => localStorage.removeItem(key));
  } catch (e) {}
}
/* 방문지 대응 열쇠: 핀 id 를 짧은 해시로 바꾼 값. 같은 날 방문표를 다시 올려도 같은 곳은 같은 열쇠라서
   아이폰이 마침 기록을 '순번'이 아니라 '곳' 기준으로 옮길 수 있음. (핀 id 자체는 아이폰에 보내지 않음) */
function stopKey(id) {
  let a = 0x811c9dc5, b = 0x01000193; const t = String(id);
  for (let n = 0; n < t.length; n++) { const c = t.charCodeAt(n); a = Math.imul(a ^ c, 0x01000193) >>> 0; b = Math.imul(b + c, 0x85ebca6b) >>> 0; b ^= b >>> 13; }
  return ("0000000" + a.toString(16)).slice(-8) + ("0000000" + (b >>> 0).toString(16)).slice(-8);
}
const keyOf = (st) => st.k || (st.id != null ? stopKey(st.id) : "i" + st.i);
/* 이 방문표(계산본)의 지문: 계산 시각 + 고른 안 + 방문 순서(곳 기준) + 서류 번호. 맥 history.plan_sig 와 같은 값이어야 함 */
function planSig() {
  const o = S.plan.order, doc = S.plan.doc || {};
  return [S.plan.generated || "", S.plan.chosen || "", o.map((i) => keyOf(stopOf(i))).join(","), o.map((i, n) => +doc[i] || n + 1).join(","), S.plan.pid || ""].join("|");
}
function sameKeys(a, b) { a = a || {}; const ka = Object.keys(a), kb = Object.keys(b); return ka.length === kb.length && kb.every((i) => a[i] === b[i]); }
function planKeys() { const m = {}; S.plan.stops.forEach((st) => { m[st.i] = keyOf(st); }); return m; }
function loadDone() {
  pruneOldDays();
  const read = (suffix, dflt) => { try { const v = JSON.parse(localStorage.getItem(storeKey() + suffix) || "null"); return v == null ? dflt : v; } catch (e) { return dflt; } };
  let done = read("", {}), order = read("_order", null), hist = read("_hist", []);
  const meta = read("_plan", null), valid = new Set(S.plan.order);
  let res = read("_res", {}); if (!res || typeof res !== "object") res = {};
  let tries = read("_tries", {}); if (!tries || typeof tries !== "object") tries = {};   // 재방문 전의 방문 기록 {순번: [{at, res}]}
  const samePerm = (o) => Array.isArray(o) && o.length === valid.size && new Set(o).size === o.length && o.every((i) => valid.has(i));
  S.carried = null;
  if (meta && (meta.sig !== planSig() || !sameKeys(meta.keys, planKeys()))) {
    // (지문이 같아도 순번↔곳 대응이 바뀌었으면 다른 방문표로 봄)
    // 같은 날짜에 방문표가 다시 올라옴: 마침 기록을 '곳' 기준으로 새 방문표에 옮기고, 순서는 새 방문표대로
    const byKey = {}; S.plan.stops.forEach((st) => { if (valid.has(st.i)) byKey[keyOf(st)] = st.i; });
    const moved = {}; let kept = 0, lost = 0;
    const movedRes = {}, movedTries = {};
    Object.keys(tries).forEach((i) => { const ni = byKey[(meta.keys || {})[i]]; if (ni != null) movedTries[ni] = tries[i]; });
    tries = movedTries;
    Object.keys(done).forEach((i) => { if (!done[i]) return; const ni = byKey[(meta.keys || {})[i]]; if (ni != null) { moved[ni] = done[i]; if (res[i]) movedRes[ni] = res[i]; kept++; } else lost++; });
    done = moved; res = movedRes; order = null; hist = []; S.carried = { kept, lost };
  } else if (!meta && order && (!samePerm(order) || S.samePlanText === false)) {
    // 예전 방식 기록(곳 정보 없음)인데 방문표가 다시 올라왔거나 달라짐: 어느 곳의 마침인지 알 수 없어 옮기지 않음
    // (곳 수가 같아도 구성이 다를 수 있어서, 받은 방문표가 지난번과 글자까지 같을 때만 그대로 둠)
    const had = Object.keys(done).filter((i) => done[i]).length;
    done = {}; res = {}; tries = {}; order = null; hist = []; if (had) S.carried = { kept: 0, lost: had, unknown: true };
  }
  if (!samePerm(order)) { order = [...S.plan.order]; hist = []; }
  Object.keys(done).forEach((i) => { if (!valid.has(+i)) delete done[i]; });
  Object.keys(res).forEach((i) => { if (!done[i] || !RESULTS[res[i]]) delete res[i]; });
  Object.keys(tries).forEach((i) => { if (!valid.has(+i) || !Array.isArray(tries[i]) || !tries[i].length) delete tries[i]; });
  S.done = done; S.res = res; S.tries = tries; S.order = order; S.history = Array.isArray(hist) ? hist : [];
  if (S.carried || !meta) { try { saveDone(S.carried ? undefined : "quiet"); } catch (e) {} }
}
function saveDone(quiet) {
  localStorage.setItem(storeKey() + "_res", JSON.stringify(S.res || {}));
  localStorage.setItem(storeKey() + "_tries", JSON.stringify(S.tries || {}));
  localStorage.setItem(storeKey(), JSON.stringify(S.done)); localStorage.setItem(storeKey() + "_order", JSON.stringify(S.order));
  localStorage.setItem(storeKey() + "_hist", JSON.stringify(S.history || []));
  localStorage.setItem(storeKey() + "_plan", JSON.stringify({ sig: planSig(), keys: planKeys() }));
  if (quiet !== "quiet") scheduleSync();
}
/* 바꾸기 직전 상태를 남겨 두면 '되돌리기'로 그대로 돌아감 (마침·미루기·순서 바꾸기·취소 모두) */
function snapshot(label) { S.history = S.history || []; S.history.push({ done: { ...S.done }, res: { ...(S.res || {}) }, tries: JSON.parse(JSON.stringify(S.tries || {})), order: [...S.order], label }); if (S.history.length > 50) S.history.shift(); }
function undo() {
  const h = (S.history || []).pop(); if (!h) return;
  S.ghost = null; S.done = h.done; S.res = h.res || {}; S.tries = h.tries || {}; S.order = h.order; S.selected = null; saveDone(); render(); toast("되돌렸어요: " + h.label);
}

/* ---------- 일정 계산 (파이썬 planner.simulate 와 같은 규칙) ---------- */
function stopOf(i) { return S.plan.stops.find((s) => s.i === i); }
function remaining() { return S.order.filter((i) => !S.done[i]); }
/* 마지막으로 마친 곳: 순서 배열의 뒤쪽이 아니라 '마침 시각'이 가장 늦은 곳 (순서와 다르게 돌았거나 방문표가 바뀌어도 맞게) */
/* 그곳에 마지막으로 들른 시각: 마침 시각, 또는 재방문으로 다시 넣은 곳이면 앞선 방문 시각 */
function visitTime(i) { const tr = (S.tries || {})[i] || []; return Math.max(S.done[i] || 0, ...tr.map((t) => t.at || 0)); }
function lastDone() { let best = 0, bt = 0; S.order.forEach((i) => { const t = visitTime(i); if (t && t >= bt) { best = i; bt = t; } }); return best; }
function currentPos() { return lastDone(); }
function todayStr() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
const END_OF = () => S.plan.stops.length + 1;
function dist(a, b) { const R = 6371000, r = Math.PI / 180, dLa = (b[0] - a[0]) * r, dLo = (b[1] - a[1]) * r; const h = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.min(1, Math.sqrt(h))); }
/* GPS 위치에서 가는 시간은 아침에 받은 실제 도로 시간들의 '직선거리 대비 소요시간' 중앙값으로 추정 */
function roadRatio() {
  if (S.ratio) return S.ratio;
  const T = S.plan.matrix, n = T.length - 1, rs = [];
  for (let i = 0; i < n; i++) for (let j = 1; j < n; j++) { if (i === j) continue; const d = dist(pt(i), pt(j)); if (d > 300 && T[i][j] > 0) rs.push(T[i][j] / d); }
  rs.sort((x, y) => x - y); S.ratio = rs.length ? rs[Math.floor(rs.length / 2)] : 1 / (35000 / 3600) * 1.3;
  return S.ratio;
}
function legT(from, to) {
  const END = END_OF();
  if (to === END && S.plan.end_mode === "last") return 0;
  if (typeof from === "number") return S.plan.matrix[from][to];
  return Math.ceil(dist([from.lat, from.lng], pt(to)) * roadRatio());
}
/* 지금 기준 예상의 '기준': 어디서, 몇 시에 출발한다고 보고 계산했는지 */
function liveBase(useGps) {
  const done = S.order.filter((i) => S.done[i]); const today = todayStr();
  const beforeStart = !done.length && !lastDone() && (today < S.plan.date || (today === S.plan.date && nowSec() < S.plan.depart));
  if (useGps && S.gps) return { origin: S.gps, t: nowSec(), label: `지금 ${hhmm(nowSec())} · 현재 위치(GPS, 오차 약 ${Math.round(S.gps.acc)}m)에서 출발` };
  if (beforeStart) return { origin: 0, t: S.plan.depart, planned: true, label: `계획대로 ${hhmm(S.plan.depart)}에 ${S.plan.start.name}에서 출발` };
  const last = lastDone();
  const t = Math.max(nowSec(), last ? visitTime(last) : 0);
  return { origin: last, t, label: `지금 ${hhmm(t)} · ${last ? `서류 ${docNumber(last)}번(마지막 마침)` : S.plan.start.name}에서 출발` };
}
/* 업무 규칙(사용자 확인 2026-11-17): 오전·주간 서류를 그 시간에 못 갔으면 같은 날 퇴근 기한 전까지 가도 됨.
   - 시간창이 이미 지난 곳, 그리고 이 순서로 가면 시간창 안에 못 마치는 곳 모두 '오늘 중 방문'으로 허용하고 late 표시.
     (12:00 직전·직후처럼 경계에서 '불가능 ↔ 가능'이 갑자기 바뀌지 않게 같은 기준을 씀)
   - missed = 아직 시간이 남았는데 이 순서 때문에 놓치는 곳 수. 순서를 고를 때 이 수가 적은 쪽을 먼저 고름(제시간 방문 우선).
   - 맥의 아침 계획(planner.py)은 원래 시간창을 그대로 지킴. */
function simulate(order, origin, t0) {
  let t = t0, p = origin, drive = 0, wait = 0, missed = 0, broken = 0; const rows = [], lim = S.plan.return_by;
  for (const i of order) {
    const st = stopOf(i); const leg = legT(p, i); const arrive = t + leg; const [a, b] = st.window;
    let begin = Math.max(arrive, a), late = false;
    if (b < t0) { late = true; begin = arrive; }                                  // 이미 지난 시간창
    let miss = false;
    if (!late && begin + st.service > b) { late = true; miss = true; missed++; begin = arrive; }   // 이 순서로는 시간창을 놓침
    if (late && begin + st.service > lim) return { ok: false };
    const strict = !!st.custom && late;   // 맥에서 건별로 직접 정한 시간(폴더 규칙과 달리 '오늘 중'으로 넘어가지 않고 못 지킨 것으로 셈)
    if (strict) broken++;
    rows.push({ i, arrive, begin, leave: begin + st.service, travel: leg, wait: begin - arrive, late, miss, strict });
    t = begin + st.service; drive += leg; wait += begin - arrive; p = i;
  }
  const back = order.length ? legT(p, END_OF()) : 0;
  return { ok: t + back <= lim || order.length === 0, finish: t + back, drive: drive + back, wait, rows, missed, broken };
}
function score(order, origin, t0) { const r = simulate(order, origin, t0); return r.ok ? [0, r.broken, r.missed, r.finish, r.drive] : [1, 0, 0, 0, 0]; }   // 직접 정한 시간 → 폴더 시간 → 종료 → 운전
function less(a, b) { for (let k = 0; k < a.length; k++) { if (a[k] !== b[k]) return a[k] < b[k]; } return false; }
function improve(order, origin, t0, budgetMs) {
  let best = order.slice(), bs = score(best, origin, t0); const end = Date.now() + budgetMs; let improved = true;
  while (improved && Date.now() < end) {
    improved = false; const n = best.length;
    outer: for (const seg of [1, 2, 3]) for (let i = 0; i + seg <= n; i++) {
      const chunk = best.slice(i, i + seg), rest = best.slice(0, i).concat(best.slice(i + seg));
      for (let k = 0; k <= rest.length; k++) { if (k === i) continue; const c = rest.slice(0, k).concat(chunk, rest.slice(k)); const sc = score(c, origin, t0); if (less(sc, bs)) { best = c; bs = sc; improved = true; break outer; } }
    }
    if (improved) continue;
    outer2: for (let i = 0; i < n - 1; i++) for (let j = i + 2; j <= n; j++) { const c = best.slice(0, i).concat(best.slice(i, j).reverse(), best.slice(j)); const sc = score(c, origin, t0); if (less(sc, bs)) { best = c; bs = sc; improved = true; break outer2; } }
  }
  return { order: best, score: bs };
}
/* 남은 건만 다시 계산 → { base, cur, next } (적용은 하지 않음) */
function proposeRemaining(useGps) {
  const rem = remaining(); const base = liveBase(useGps);
  const cur = simulate(rem, base.origin, base.t);
  let start = rem;
  if (!cur.ok) start = rem.slice().sort((x, y) => stopOf(x).window[1] - stopOf(y).window[1]);
  const r = improve(start, base.origin, base.t, 1500);
  const next = simulate(r.order, base.origin, base.t);
  return { base, rem, cur, nextOrder: r.order, next };
}

/* ---------- 화면 ---------- */
function docNumber(i) { const d = S.plan.doc && S.plan.doc[i]; return d ? +d : S.plan.order.indexOf(i) + 1; }  /* 아침에 인쇄한 서류 번호 (맥에서 확정한 번호) */
function render() {
  const plan = S.plan, rem = remaining(), total = S.order.length, doneCount = total - rem.length;
  $("bar-title").textContent = `${plan.date.slice(5).replace("-", "/")} 방문표`;
  const gen = plan.generated ? plan.generated.slice(5, 16).replace("T", " ").replace("-", "/") : "";
  $("bar-sub").textContent = `처리 ${doneCount}/${total}${doneCount ? ` · ${countsText(resultCounts())}` : ""}${S.offline ? " · 오프라인" : ""}`;
  if ($("menu-info")) $("menu-info").textContent = `계획: ${hhmm(plan.depart)} ${plan.start.name} 출발 · ${gen} 계산`;
  const base = liveBase(false);
  const sim = simulate(rem, base.origin, base.t);
  const etas = {}; (sim.rows || []).forEach((r) => (etas[r.i] = r));
  const planned = Object.fromEntries(plan.schedule.map((r) => [r.i, r]));
  // 다음 카드
  const next = $("next");
  if (!rem.length) { next.innerHTML = `<div class="done-msg">오늘 방문을 모두 마쳤어요 🎉<div class="done-sum">${["ok", "absent", "addr"].map((k) => `<span class="${k}"><b>${resultCounts()[k]}</b>${RESULTS[k]}</span>`).join("")}</div></div>${resultCounts().absent + resultCounts().addr ? `<button class="wide again-btn" id="btn-again">다시 갈 곳 ${resultCounts().absent + resultCounts().addr}건 보기</button>` : ""}${(S.history || []).length ? `<button class="undo-line" id="btn-undo">↶ 되돌리기 · ${esc(S.history[S.history.length - 1].label)}</button>` : ""}`; if ($("btn-undo")) $("btn-undo").onclick = undo; if ($("btn-again")) $("btn-again").onclick = () => { S.showList = true; S.listFilter = "again"; render(); $("sheet").scrollTop = 0; }; }
  else {
    const i = S.selected && rem.includes(S.selected) ? S.selected : rem[0]; const st = stopOf(i); const e = etas[i];
    const isNext = i === rem[0];
    next.innerHTML = `
      ${isNext ? "" : `<div class="picked"><span>다음 차례가 아닌 곳을 보고 있어요</span><button id="btn-back">다음 방문(서류 ${docNumber(rem[0])}번)으로</button></div>`}
      <div class="kicker"><span>${isNext ? "다음 방문" : "선택한 방문지"}${S.collapsed && !(e && e.late) ? (st.custom ? ` · <span class="tag custom">⏰ ${esc(st.custom)}</span>` : ` · <span class="tag ${RULE_CLASS[st.rule] || ""}">${esc(st.rule)}</span>`) : ""}</span><span class="tools">${(S.history || []).length ? `<button class="tool" id="btn-undo" title="${esc(S.history[S.history.length - 1].label)} 되돌리기">${undoText()} 되돌리기</button>` : ""}${rem.length >= 2 ? `<button class="tool" id="btn-recalc">🔄 재계산</button>` : ""}</span></div>
      ${triesText(i) ? `<div class="again-note">다시 방문하는 곳이에요 · 앞선 방문: ${esc(triesText(i))}</div>` : ""}
      <div class="docrow"><div class="docno"><small>서류</small><b>${docNumber(i)}</b></div><div class="name">${esc(st.label || st.place || "(이름 없음)")}${e && e.late ? (st.custom ? `<span class="late-chip strict">⛔ ${e.miss ? `지금 순서로는 직접 정한 시간(${esc(st.custom)})을 못 지켜요` : `직접 정한 시간(${esc(st.custom)})이 지났어요`}</span>` : `<span class="late-chip">⏰ ${e.miss ? `지금 순서로는 ${esc(st.rule)} 시간을 넘겨요` : `${esc(st.rule)} 시간 지남 · 오늘 중 방문`}</span>`) : ""}</div></div>
      ${st.label && st.place ? `<div class="place">${esc(st.place)}</div>` : ""}
      ${st.door && st.door.length ? st.door.map((d) => `<div class="door"><span class="k">출입</span><span class="code">${esc(d.code)}</span><span class="dn">${d.note ? `<span class="use">${esc(d.note)}</span>` : ""}<span class="nm">${d.note && d.name ? " · " : ""}${esc(d.name)}</span></span></div>`).join("") : ""}
      <div class="addr">${esc(st.address)}${st.memo ? ` · <b class="memo">${esc(st.memo)}</b>` : ""}${st.folder && st.folder.includes(" + ") ? `<br><b>두 폴더 문건 함께 확인</b> (${esc(st.folder)})` : ""}</div>
      <div class="act${isNext ? "" : " other"}">
        <div class="actions">
          <a class="wide" href="${navLink(st)}"><button class="wide" style="width:100%">${isNext ? "네이버지도 길안내" : `서류 ${docNumber(i)}번 길안내`}</button></a>
          <button class="wide big" id="btn-done">${isNext ? "전달 완료" : `서류 ${docNumber(i)}번 전달 완료`}</button>
        </div>
        <div class="actions3">
          <button class="ghost warn" id="btn-absent">부재</button>
          <button class="ghost warn" id="btn-addr">주소 문제</button>
          <button class="ghost" id="btn-skip">${isNext ? "순서 미루기" : "이 건부터"}</button>
        </div>
      </div>
      <!-- 버튼이 항상 먼저 보이게: 시간·조건 정보는 버튼 아래 -->
      <div class="more-info">${timesHtml(planned[i], e, base, isNext, isNext ? null : base.t + legT(base.origin, i))}</div>
      <div class="meta more-info">${st.custom ? `<span class="tag custom">⏰ 직접 정한 시간 ${esc(st.custom)}</span>` : `<span class="tag ${RULE_CLASS[st.rule] || ""}">${esc(st.rule)} ${st.rule === "아무때나" ? "" : hhmm(st.window[0]) + "–" + hhmm(st.window[1])}</span>`}${e ? `<span class="tag">이동 ${mins(e.travel)}</span>` : ""}<span class="hint">남은 ${rem.length}건${sim.ok ? ` · 지금 기준 종료 ${hhmm(sim.finish)}` : " · 기한 안에 다 못 돌 수 있어요"}</span></div>`;
    if ($("btn-undo")) $("btn-undo").onclick = undo;
    if ($("btn-back")) $("btn-back").onclick = () => { S.selected = null; render(); $("sheet").scrollTop = 0; followNext(); };
    if ($("btn-recalc")) $("btn-recalc").onclick = () => openRecalc(true);
    const finish = (kind) => {
      const what = `서류 ${docNumber(i)}번 ${RESULTS[kind]}`;
      snapshot(what);
      S.done[i] = nowSec(); S.res = S.res || {}; if (kind === "ok") delete S.res[i]; else S.res[i] = kind;
      S.selected = null; saveDone(); render(); $("sheet").scrollTop = 0; followNext();
      toast(what, "되돌리기", undo, 8000);
      // 더 빠른 순서가 있으면 알려만 주고, 바꾸는 건 동우님이 정함
      setTimeout(() => { if (remaining().length < 2) return; const pr = proposeRemaining(false); const gain = gainOf(pr);
        if (gain.finish >= 300 || gain.drive >= 300) toast(gain.fixes ? "남은 순서를 바꾸면 시간을 지킬 수 있는 곳이 있어요" : `남은 순서를 바꾸면 ${gain.finish >= 60 ? Math.round(gain.finish / 60) + "분 빨리 끝나요" : "운전이 " + Math.round(gain.drive / 60) + "분 줄어요"}`, "보기", () => openRecalc(false, pr), 9000); }, 8200);
    };
    $("btn-done").onclick = () => finish("ok");
    $("btn-absent").onclick = () => finish("absent");
    $("btn-addr").onclick = () => finish("addr");
    $("btn-skip").onclick = () => { snapshot(isNext ? `서류 ${docNumber(i)}번 미루기` : `서류 ${docNumber(i)}번부터 가기`); const r = remaining(); const k = r.indexOf(i); if (isNext) { if (r.length > 1) { const d = S.order.filter((x) => S.done[x]); const nr = r.slice(1, 2).concat([i], r.slice(2)); S.order = d.concat(nr); } } else { const d = S.order.filter((x) => S.done[x]); const nr = [i].concat(r.filter((x) => x !== i)); S.order = d.concat(nr); } S.selected = null; saveDone(); render(); followNext(); };
  }
  renderList(etas); drawRoute();
}
function timesHtml(pl, e, base, isNext, direct) {
  const planLine = pl ? `<div><span class="tl">아침 계획</span><b>${hhmm(pl.arrive)}</b> 도착${pl.wait > 60 ? ` · ${hhmm(pl.begin)}부터 송달` : ""}</div>` : "";
  let liveLine = "";
  if (e) {
    const d = pl ? Math.round((e.arrive - pl.arrive) / 60) : 0;
    const dTxt = !pl ? "" : d === 0 ? " · 계획과 같아요" : ` · 계획보다 ${Math.abs(d)}분 ${d > 0 ? "늦어요" : "빨라요"}`;
    const waitTxt = e.wait > 60 ? `<div class="wait">${hhmm(e.begin)}부터 송달할 수 있어서 ${mins(e.wait)} 기다려요</div>` : "";
    // 출발 전(계획대로 출발한다고 볼 때)에는 아침 계획과 같으므로 생략. 단, 순서를 바꿔서 시각이 달라졌으면 보여 줌
    const label = base.planned ? "지금 순서로는" : isNext === false ? "앞 순서를 거치면" : "지금 출발하면";
    if (!base.planned || d !== 0) liveLine = `<div><span class="tl live">${label}</span><b>${hhmm(e.arrive)}</b> 도착${dTxt}</div>${waitTxt}`;
    if (isNext === false && direct != null && !base.planned) liveLine += `<div><span class="tl live">바로 가면</span><b>${hhmm(direct)}</b> 도착</div>`;
  } else liveLine = `<div><span class="tl live">지금 출발하면</span>시간 계산 불가</div>`;
  return `<div class="times">${planLine}${liveLine}<div class="basis">기준: ${esc(base.label)}</div></div>`;
}
function navLink(st) { const app = encodeURIComponent(LOCAL ? "songdal" : location.origin + location.pathname); return `nmap://navigation?dlat=${st.lat}&dlng=${st.lng}&dname=${encodeURIComponent(st.place || st.label || "송달지")}&appname=${app}`; }
function renderList(etas) {
  const box = $("list"); box.classList.toggle("hidden", !S.showList);
  const wasListing = $("app").classList.contains("listing");
  $("sheet").classList.toggle("listing", !!S.showList); $("app").classList.toggle("listing", !!S.showList);
  if (wasListing !== !!S.showList && S.map) setTimeout(() => { S.map.resize(); if (S.selected != null && S.order.includes(S.selected) && !S.done[S.selected]) fitLeg(S.selected); else followNext(); }, 60);
  if (!S.animating) $("btn-list").textContent = S.showList ? "카드" : "목록";
  if (!S.showList) return;
  const rem = remaining(), cnt = resultCounts(), nAgain = cnt.absent + cnt.addr;
  const f = S.listFilter || "all";
  const chip = (key, label) => `<button class="fchip${f === key ? " on" : ""}" data-f="${key}">${label}</button>`;
  box.innerHTML = `<div class="head"><input id="list-q" type="search" inputmode="search" autocomplete="off" placeholder="서류 번호·이름 찾기" value="${esc(S.listQ || "")}"></div>
    <div class="filters">${chip("all", `전체 ${S.order.length}`)}${chip("left", `남은 곳 ${rem.length}`)}${chip("again", `다시 갈 곳 ${nAgain}`)}</div>
    <div class="sum">${esc(countsText(cnt))} · 남음 ${rem.length}</div>`;
  // 찾기: 숫자면 서류 번호가 그 숫자로 시작하는 곳, 글자면 이름·장소에 들어 있는 곳 (입력 중에 화면을 다시 그리지 않고 줄만 숨김)
  const applyQ = () => { const q = (S.listQ || "").trim().toLowerCase(); box.querySelectorAll(".item:not(.ghost-row)").forEach((el) => { el.style.display = !q || (/^\d+$/.test(q) ? el.dataset.doc.startsWith(q) : el.dataset.q.includes(q)) ? "" : "none"; }); };
  $("list-q").oninput = (e) => { S.listQ = e.target.value; applyQ(); };
  box.querySelectorAll(".fchip").forEach((b) => (b.onclick = () => { S.listFilter = b.dataset.f; S.ghost = null; render(); $("sheet").scrollTop = 0; }));
  const shown = S.order.filter((i) => f === "all" || (f === "left" ? !S.done[i] : resultOf(i) && resultOf(i) !== "ok"));
  if (!shown.length && !S.ghost) box.insertAdjacentHTML("beforeend", `<div class="hint" style="padding:14px 0">${f === "left" ? "남은 곳이 없어요." : f === "again" ? "다시 갈 곳이 없어요." : "해당하는 곳이 없어요."}</div>`);
  // 방금 다시 넣은 곳: 원래 줄 자리에 같은 높이의 안내 줄을 남겨, 아래 줄들이 손가락 밑으로 올라오지 않게 함 (다른 조작을 하면 사라짐)
  const ghostAt = S.ghost ? Math.max(0, Math.min(S.ghost.slot != null ? S.ghost.slot : shown.length, shown.length)) : -1;
  const ghostRow = () => {
    const g = document.createElement("div"); g.className = "item ghost-row"; g.style.minHeight = (S.ghost.h || 64) + "px";
    g.innerHTML = `<div class="t">서류 ${docNumber(S.ghost.i)}번 → 남은 순서 ${S.ghost.pos}번째로 옮겼어요</div><button class="ghost" id="ghost-go">옮긴 곳 보기</button>`;
    box.appendChild(g);
    g.querySelector("button").onclick = () => {
      const gi = S.ghost.i; S.ghost = null;
      if (S.listFilter === "again") S.listFilter = "left";
      render(); const row = box.querySelector(`.item[data-i="${gi}"]`);
      if (row) { row.scrollIntoView({ block: "center" }); row.classList.add("flash"); setTimeout(() => row.classList.remove("flash"), 2200); }
    };
  };
  shown.forEach((i, n) => {
    if (n === ghostAt) ghostRow();
    const st = stopOf(i); const done = !!S.done[i]; const e = etas[i]; const cur = !done && rem[0] === i;
    const rk = resultOf(i);
    const div = document.createElement("div"); div.className = "item" + (done ? " done" : "") + (rk && rk !== "ok" ? " again" : "") + (cur ? " cur" : "");
    div.dataset.doc = String(docNumber(i)); div.dataset.i = String(i); div.dataset.q = `${st.label || ""} ${st.place || ""}`.toLowerCase();
    div.innerHTML = `<div class="n">${docNumber(i)}</div><div class="t"><b>${esc(st.label || st.place || `서류 ${docNumber(i)}번`)}</b>${st.label && st.place ? " · " + esc(st.place) : ""}<small>${st.custom ? `⏰ 직접 ${esc(st.custom)}` : esc(st.rule)}${st.door && st.door.length ? " · 출입 " + esc(st.door[0].code) : ""}${done ? ` · <span class="rk ${rk}">${RESULTS[rk]}</span> ${hhmm(S.done[i])}` : e ? ` · 도착 ${hhmm(e.arrive)}${e.wait > 60 ? ` · <b class="from">${hhmm(e.begin)}부터 송달</b>` : ""}${e.late ? (st.custom ? ` · <b class="lateb strict">⛔ 직접 ${esc(st.custom)} 못 지킴</b>` : ` · <b class="lateb">${e.miss ? `지금 순서로는 ${esc(st.rule)} 넘김` : `${esc(st.rule)} 시간 지남 · 오늘 중`}</b>`) : ""}` : ""}${triesText(i) ? ` · <span class="rk absent">재방문</span> (${esc(triesText(i))})` : ""}</small></div>${done && rk !== "ok" ? `<button class="again">다시 방문…</button>` : done ? `<span class="more" aria-hidden="true">›</span>` : `<button class="ghost go">보기</button>`}`;
    const ag = div.querySelector("button.again"), go = div.querySelector("button.go");
    if (ag) ag.onclick = (ev) => { ev.stopPropagation(); S.ghost = null; const h = div.offsetHeight; askRevisit(i); S.ghostDraft = { slot: n, h }; };
    if (go) go.onclick = () => { S.ghost = null; S.selected = i; S.showList = false; render(); fitLeg(i); };
    if (done) div.onclick = () => { S.ghostDraft = { slot: n, h: div.offsetHeight }; askRecord(i); };   // 기록한 곳: 줄을 누르면 기록 내용과 [기록 취소]
    box.appendChild(div);
  });
  if (ghostAt === shown.length) ghostRow();
  applyQ();
}
let toastTimer;
function toast(msg, actionLabel, actionFn, ms) {
  const n = $("note"); n.innerHTML = ""; const span = document.createElement("span"); span.textContent = msg; n.appendChild(span);
  const hide = () => { n.classList.add("hidden"); document.body.classList.remove("toast-undo", "note-on"); };
  if (actionLabel) { const b = document.createElement("button"); b.className = "note-btn"; b.textContent = actionLabel; b.onclick = () => { hide(); actionFn(); }; n.appendChild(b); }
  document.body.classList.toggle("toast-undo", actionFn === undo);   // 같은 되돌리기가 카드에도 있어서 그 줄은 잠깐 숨김
  document.body.classList.add("note-on"); n.classList.remove("hidden"); clearTimeout(toastTimer); toastTimer = setTimeout(hide, ms || 4000);
}

/* ---------- 지도 ---------- */
function pt(i) { const p = S.plan; return i === 0 ? [p.start.lat, p.start.lng] : i === p.stops.length + 1 ? [p.end.lat, p.end.lng] : [stopOf(i).lat, stopOf(i).lng]; }
function legCoords(a, b) {
  const path = S.plan.paths[`${a},${b}`];
  return { coords: path ? path.map(([lng, lat]) => [lat, lng]) : [pt(a), pt(b)], real: !!path };
}
function prevOf(i) { const k = S.order.indexOf(i); return k > 0 ? S.order[k - 1] : 0; }   /* 선택한 곳 바로 앞 순서 (첫 곳이면 출발지) */
function drawRoute() {
  const m = S.map; if (!m || S.animating) return; m.clear(); S.markers = {};
  const rem = remaining(); const seq = S.plan.end_mode === "last" ? [currentPos(), ...rem] : [currentPos(), ...rem, S.plan.stops.length + 1];
  const focus = S.selected && S.order.includes(S.selected) ? S.selected : null;
  for (let k = 0; k < seq.length - 1; k++) {
    const a = seq[k], b = seq[k + 1]; const { coords, real } = legCoords(a, b);
    const st = b <= S.plan.stops.length ? stopOf(b) : null;
    const base = st && st.rule === "야간" ? "#5b4bb5" : "#1b5e4a";
    if (focus) m.polyline(coords, { color: base, dashed: !real, weight: 4, opacity: 0.22 });
    else m.polyline(coords, { color: base, dashed: !real, weight: k === 0 ? 6 : 4, opacity: k === 0 ? 0.95 : 0.7 });
  }
  if (focus) {   /* 앞 순서 → 선택한 곳 구간만 또렷하게 */
    const { coords, real } = legCoords(prevOf(focus), focus);
    m.polyline(coords, { color: "#ffffff", weight: 11, opacity: 0.9 });
    m.polyline(coords, { color: "#ff6a00", dashed: !real, weight: 7, opacity: 1 });
  }
  S.order.forEach((i) => {
    const st = stopOf(i); const done = !!S.done[i]; const isNext = rem[0] === i;
    S.markers[i] = m.marker({ lat: st.lat, lng: st.lng, label: String(docNumber(i)), size: isNext ? 34 : 26, z: isNext ? 90 : done ? 1 : 10,
      badge: done ? "" : SongdalMap.badge(st.rule), color: done ? "#b5b5b0" : RULE_COLOR(st.rule), onClick: () => { S.selected = i; render(); fitLeg(i); } });
  });
  m.marker({ lat: S.plan.start.lat, lng: S.plan.start.lng, label: "출발", color: "#333", size: 34, z: 95 });
  if (S.plan.end_mode === "custom") m.marker({ lat: S.plan.end.lat, lng: S.plan.end.lng, label: "종료", color: "#555", size: 34, z: 95 });
  if (S.me) m.marker({ lat: S.me.lat, lng: S.me.lng, label: "나", color: "#1a73e8", size: 30, z: 99 });
}
/* 지도를 '지금 있는 곳 → 다음 방문지' 구간에 맞춤 (기록할 때마다 다음 곳이 지도에 보이게) */
function followNext() {
  const nx = remaining()[0]; if (!nx || !S.map || S.animating) return;
  const { coords } = legCoords(currentPos(), nx); const pts = (coords.length ? coords : [pt(nx)]).slice();
  // 가까운 구간이면 지도가 지나치게 확대되므로, 주변 250m쯤은 함께 보이게 범위를 넓힘
  const la = pts.map((q) => q[0]), lo = pts.map((q) => q[1]), cy = (Math.min(...la) + Math.max(...la)) / 2, cx = (Math.min(...lo) + Math.max(...lo)) / 2, pad = 0.0025;
  pts.push([cy - pad, cx - pad], [cy + pad, cx + pad]);
  S.map.fit(pts);
}
async function showMe() {
  toast("현재 위치를 확인하는 중…");
  const g = await getGps();
  if (!g) return toast("위치를 받지 못했어요. 아이폰 설정에서 위치 사용을 허용해 주세요.");
  S.me = g; drawRoute();
  const nx = remaining()[0]; S.map.fit(nx ? [[g.lat, g.lng], pt(nx)] : [[g.lat, g.lng], [g.lat + 0.002, g.lng + 0.002], [g.lat - 0.002, g.lng - 0.002]]);
  toast(`내 위치(파란 점) · 오차 약 ${Math.round(g.acc)}m`);
}
function fitAll() { const pts = remaining().map(pt); if (!pts.length) pts.push(pt(0)); S.map.fit(pts); }
function fitLeg(i) { const { coords } = legCoords(prevOf(i), i); S.map.fit(coords.length ? coords : [pt(i)]); }

/* ---------- 남은 건 다시 계산 (미리보기 → 적용) ---------- */
function gainOf(pr) {
  if (!pr.next.ok) return { finish: 0, drive: 0 };
  if (!pr.cur.ok || (pr.cur.broken || 0) > (pr.next.broken || 0) || ((pr.cur.broken || 0) === (pr.next.broken || 0) && (pr.cur.missed || 0) > (pr.next.missed || 0))) return { finish: 3600 * 24, drive: 0, fixes: true };
  // 화면에 보이는 시:분 차이와 맞도록 분 단위로 버림해서 비교
  const fm = (x) => Math.floor(x / 60) * 60;
  return { finish: fm(pr.cur.finish) - fm(pr.next.finish), drive: Math.round(pr.cur.drive / 60) * 60 - Math.round(pr.next.drive / 60) * 60 };
}
function getGps() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition((p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy || 0, at: Date.now() }),
      () => resolve(null), { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
  });
}
/* 재계산 미리보기: 새 순서로 제시간이 되는 곳과 그래도 시간을 넘기는 곳 (서류 번호·이름·도착 시각 전→후) */
function fixList(pr) {
  if (!pr.next.ok) return "";
  const cur = Object.fromEntries((pr.cur.rows || []).map((r) => [r.i, r])), nx = pr.next.rows || [];
  const who = (i) => `서류 <b>${docNumber(i)}</b>번 ${esc(stopOf(i).label || stopOf(i).place || "")}`;
  const win = (i) => { const st = stopOf(i); return st.custom ? `<b>직접 ${esc(st.custom)}</b>` : `${esc(st.rule)} ${hhmm(st.window[0])}–${hhmm(st.window[1])}`; };
  const fixed = nx.filter((r) => !r.late && cur[r.i] && cur[r.i].miss);
  // 지금 순서가 퇴근 기한을 넘겨 중간에 계산이 끊겼으면 곳별 비교가 없음 → '새로/그래도'를 나누지 않고 새 순서에서 넘기는 곳만 보여 줌
  const known = !!(pr.cur.rows && pr.cur.rows.length);
  const worse = known ? nx.filter((r) => r.miss && !(cur[r.i] && cur[r.i].miss)) : [];   // 지금 순서로는 제시간인데 새 순서에서 늦어지는 곳
  const still = nx.filter((r) => r.miss && (!known || (cur[r.i] && cur[r.i].miss)));
  if (!fixed.length && !worse.length && !still.length && !nx.some((r) => r.strict)) return "";
  const sec = (title, cls, mark, rows, both) => rows.length ? `<div class="h">${title}</div>` + rows.map((r) => `<div class="${cls}">${mark} ${who(r.i)} · ${win(r.i)} · 도착 ${both && cur[r.i] ? `${hhmm(cur[r.i].arrive)} → ` : ""}<b>${hhmm(r.arrive)}</b></div>`).join("") : "";
  const gone = nx.filter((r) => r.strict && !r.miss);   // 직접 정한 시간이 이미 지난 곳
  return `<div class="rc-fix">${sec("직접 정한 시간이 이미 지난 곳", "bad", "⛔", gone, false)}${sec("제시간이 되는 곳", "ok", "✓", fixed, true)}${sec("새로 시간을 넘기는 곳 (오늘 중 방문)", "bad", "⚠", worse, true)}${sec(known ? "바꿔도 시간을 넘기는 곳 (오늘 중 방문)" : "새 순서에서 시간을 넘기는 곳 (오늘 중 방문)", "bad", "⚠", still, false)}</div>`;
}
async function openRecalc(useGps, ready) {
  const box = $("recalc"); box.classList.remove("hidden");
  box.innerHTML = `<div class="rc-card"><div class="rc-title">남은 순서 다시 계산</div><div class="hint">${useGps ? "현재 위치를 확인하는 중…" : "계산 중…"}</div></div>`;
  let note = "";
  if (useGps) { const g = await getGps(); if (g) S.gps = g; else { S.gps = null; note = "위치를 받지 못해서 마지막 마침 장소 기준으로 계산했어요."; } }
  const sameRem = (x) => x.slice().sort((m, n) => m - n).join(",") === remaining().slice().sort((m, n) => m - n).join(",");
  if (ready && !sameRem(ready.rem)) { ready = null; note = "그사이 마친 곳이 있어서 지금 상태로 다시 계산했어요."; }
  const pr = ready || proposeRemaining(useGps && !!S.gps);
  const g = gainOf(pr);
  const changed = pr.nextOrder.join(",") !== pr.rem.join(",");
  const chips = pr.nextOrder.map((i, k) => `<span class="chip ${pr.rem[k] !== i ? "moved" : ""}">${docNumber(i)}</span>`).join("→");
  const line = (lbl, r) => r.ok ? `<tr><td>${lbl}</td><td><b>${hhmm(r.finish)}</b></td><td>${mins(r.drive)}</td><td>${mins(r.wait)}</td></tr>` : `<tr><td>${lbl}</td><td colspan="3" class="bad">기한 안에 다 못 돌아요</td></tr>`;
  const verdict = !changed ? "지금 순서가 이미 가장 좋아요." :
    g.fixes && pr.cur.ok ? ((pr.cur.broken || 0) > (pr.next.broken || 0) ? `바꾸면 <b>직접 정한 시간을 지키는 곳이 ${pr.cur.broken - pr.next.broken}곳 늘어요</b>. ` : "") + (pr.cur.missed > pr.next.missed ? `${(pr.cur.broken || 0) > (pr.next.broken || 0) ? "" : "바꾸면 "}<b>제시간에 갈 수 있는 곳이 ${pr.cur.missed - pr.next.missed}곳 늘어요</b>. ` : "") + (pr.next.missed ? `그래도 ${pr.next.missed}곳은 시간을 넘겨요(오늘 중 방문). ` : "") +
      (() => { const d = Math.round((pr.next.finish - pr.cur.finish) / 60); return d === 0 ? "끝나는 시각은 같아요." : `끝나는 시각은 ${Math.abs(d)}분 ${d > 0 ? "늦어져요" : "빨라져요"}.`; })() :
    g.fixes ? "지금 순서로는 퇴근 기한 안에 다 못 돌아서, 돌 수 있게 바꿨어요." + (pr.next.missed ? ` ${pr.next.missed}곳은 시간을 넘겨요(오늘 중 방문).` : "") :
    `바꾸면 <b>${g.finish > 0 ? Math.round(g.finish / 60) + "분 빨리 끝나고" : "끝나는 시각은 같고"}</b>, 운전이 <b>${Math.round(g.drive / 60)}분</b> ${g.drive >= 0 ? "줄어요" : "늘어요"}.`;
  box.innerHTML = `<div class="rc-card">
    <div class="rc-title">남은 ${pr.rem.length}건 순서 다시 계산</div>
    <div class="basis">기준: ${esc(pr.base.label)}${pr.base.origin && typeof pr.base.origin === "object" ? " · 현재 위치에서 첫 곳까지는 추정" : ""}</div>
    ${note ? `<div class="hint warn">${esc(note)}</div>` : ""}
    <table class="rc-table"><tr><th></th><th>종료</th><th>운전</th><th>대기</th></tr>${line("지금 순서", pr.cur)}${line("새 순서", pr.next)}</table>
    <div class="rc-verdict">${verdict}</div>
    ${changed ? fixList(pr) : ""}
    ${changed ? `<div class="rc-chips">${chips}</div><div class="hint">숫자는 아침에 인쇄한 <b>서류 번호</b>예요. 번호는 그대로이고 가는 순서만 바뀌어요. 주황색·밑줄이 자리가 바뀐 곳이에요.</div>` : ""}
    <div class="actions">${changed ? `<button id="rc-apply">이 순서로 바꾸기</button><button class="ghost" id="rc-cancel">그대로 두기</button>` : `<button class="ghost wide" id="rc-cancel">닫기</button>`}</div>
  </div>`;
  $("rc-cancel").onclick = () => box.classList.add("hidden");
  if ($("rc-apply")) $("rc-apply").onclick = () => {
    // 미리보기를 띄워 둔 사이에 마침·되돌리기가 있었으면 이 제안은 쓰지 않음 (마친 곳이 순서에 두 번 들어가지 않게)
    if (!sameRem(pr.rem) || new Set(pr.nextOrder).size !== pr.nextOrder.length || !sameRem(pr.nextOrder)) {
      box.classList.add("hidden"); toast("그사이 상태가 바뀌어서 이 순서는 적용하지 않았어요. 다시 계산해 주세요."); return;
    }
    snapshot("남은 순서 다시 계산");
    S.order = S.order.filter((i) => S.done[i]).concat(pr.nextOrder); S.selected = null; saveDone();
    box.classList.add("hidden"); render(); toast("남은 순서를 바꿨어요", "되돌리기", undo, 8000);
  };
}

/* ---------- 순서대로 경로보기 ---------- */
function stopAnimation(finished) {
  if (!S.animating) return;
  if (!finished && S.anim) S.anim.stop();
  S.animating = false; $("btn-play").textContent = "▶ 순서대로 경로보기"; $("btn-list").textContent = "목록";
  if (!finished) { render(); return; }
  toast("출발부터 끝까지 보여드렸어요"); setTimeout(() => { if (!S.animating) render(); }, 2500);
}
function playRoute() {
  const m = S.map, END = S.plan.stops.length + 1;
  const seq = S.plan.end_mode === "last" ? [0, ...S.order] : [0, ...S.order, END];
  const legs = []; for (let k = 0; k < seq.length - 1; k++) { const { coords, real } = legCoords(seq[k], seq[k + 1]); const st = seq[k + 1] !== END ? stopOf(seq[k + 1]) : null; legs.push({ b: seq[k + 1], coords, real, color: st && st.rule === "야간" ? "#7a5cff" : "#ff6a00" }); }
  S.selected = null; S.showList = false; render();
  S.animating = true; $("btn-play").textContent = "■ 경로 보기 멈춤"; $("btn-list").textContent = "■ 멈춤";
  m.clear();
  legs.forEach((L) => m.polyline(L.coords, { color: "#1b5e4a", dashed: !L.real, weight: 4, opacity: 0.18 }));
  const pins = {};
  S.order.forEach((i) => { const st = stopOf(i); pins[i] = m.marker({ lat: st.lat, lng: st.lng, label: String(docNumber(i)), size: 24, z: 10, color: "#9aa59f" }); });
  m.marker({ lat: S.plan.start.lat, lng: S.plan.start.lng, label: "출발", color: "#333", size: 34, z: 95 });
  m.fit(legs.flatMap((L) => [L.coords[0], L.coords[L.coords.length - 1]]));
  S.anim = SongdalMap.animate(m, legs, {
    onArrive(k) { const i = legs[k].b; if (i === END) return; const st = stopOf(i); pins[i].set({ size: 30, z: 60, color: RULE_COLOR(st.rule), badge: SongdalMap.badge(st.rule) }); toast(`${k + 1}번째 · 서류 ${docNumber(i)}번 ${st.label || st.place || ""}`, null, null, 1200); },
    onDone() { stopAnimation(true); },
  });
}

/* ---------- 카드 접기 ---------- */
function setCollapsed(on) {
  S.collapsed = on; $("sheet").classList.toggle("collapsed", on);
  try { localStorage.setItem("songdal_collapsed", on ? "1" : "0"); } catch (e) {}
  if (S.map) setTimeout(() => S.map.resize(), 250);
}

/* ---------- 오늘 결과 맥으로 보내기 (암호화한 글) ---------- */
function bytesToB64(u8) { let bin = ""; for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(bin); }
async function resultText(other) {
  const keyB64u = localStorage.getItem("songdal_key");
  if (!keyB64u) throw new Error("열쇠가 없어요.");
  const payload = other || { v: 2, date: S.plan.date, generated: S.plan.generated, done: S.done, res: S.res || {}, tries: S.tries || {}, order: S.order, sig: planSig(), keys: planKeys() };
  const key = await crypto.subtle.importKey("raw", b64uToBytes(keyB64u), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(payload))));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return "송달결과:" + bytesToB64(out);
}

/* ---------- 결과 자동 저장 (GitHub 비공개 저장소, 암호문만) ----------
   맥이 방문표에 넣어 준 sync = {owner, repo, token, dir}. 토큰은 그 저장소 하나에만 쓸 수 있는 토큰.
   '마침'·되돌리기·순서 바꾸기 때마다 4초 뒤 저장. 인터넷이 안 되면 기다렸다가 다시 시도. */
const SYNC = { timer: null, busy: false, again: false, state: "", at: null, ver: 0 };   // ver: 기록이 바뀔 때마다 +1
function syncKey() { return "songdal_sync_" + S.plan.date; }
function syncStatus(state, extra) {
  SYNC.state = state; if (state === "ok") SYNC.at = new Date();
  const el = $("sync-status"); if (!el) return;
  const t = SYNC.at ? `${String(SYNC.at.getHours()).padStart(2, "0")}:${String(SYNC.at.getMinutes()).padStart(2, "0")}` : "";
  el.className = "sync " + state;
  el.textContent = state === "ok" ? `☁ 맥으로 자동 저장됨 ${t}` : state === "wait" ? "☁ 저장 대기 중 (인터넷 연결되면 저장)" : state === "busy" ? "☁ 저장 중…" : state === "pending" ? "☁ 곧 저장해요" : state === "err" ? `☁ 자동 저장 안 됨: ${extra}` : "";
}
function scheduleSync(delay) {
  if (!S.plan || !S.plan.sync || LOCAL) return;
  SYNC.ver++;
  try { localStorage.setItem(syncKey(), "dirty"); } catch (e) {}
  clearTimeout(SYNC.timer); SYNC.timer = setTimeout(pushSync, delay == null ? 4000 : delay);
  if (SYNC.state !== "busy") syncStatus(navigator.onLine ? "pending" : "wait");
}
async function gh(method, path, body) {
  const c = S.plan.sync;
  return fetch(`https://api.github.com/repos/${c.owner}/${c.repo}/contents/${path}`, {
    method, cache: "no-store",
    headers: { Authorization: "Bearer " + c.token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}
async function pushSync() {
  if (!S.plan || !S.plan.sync) return;
  if (SYNC.busy) { SYNC.again = true; return; }
  if (!navigator.onLine) return syncStatus("wait");
  SYNC.busy = true; syncStatus("busy");
  const sentVer = SYNC.ver;   // 이번에 올리는 기록의 변경 번호
  const path = `${S.plan.sync.dir || "results"}/${S.plan.date}.txt`;
  try {
    const content = bytesToB64(new TextEncoder().encode(await resultText()));
    let sha = null;
    const cur = await gh("GET", path);
    if (cur.status === 200) sha = (await cur.json()).sha;
    else if (cur.status === 401 || cur.status === 403) throw new Error(cur.status === 401 ? "토큰이 만료됐거나 틀렸어요 (맥 설정 5번)" : "토큰 권한이 부족해요 (Contents 쓰기)");
    const r = await gh("PUT", path, { message: `결과 ${S.plan.date} ${new Date().toTimeString().slice(0, 5)}`, content, ...(sha ? { sha } : {}) });
    if (r.status === 409 || r.status === 422) { SYNC.again = true; throw new Error("다시 시도해요"); }
    if (!r.ok) throw new Error(r.status === 401 ? "토큰이 만료됐거나 틀렸어요 (맥 설정 5번)" : r.status === 403 || r.status === 404 ? "토큰 권한이 부족해요 (Contents 쓰기)" : "HTTP " + r.status);
    if (SYNC.ver === sentVer) { try { localStorage.removeItem(syncKey()); } catch (e) {} syncStatus("ok"); }
    else { SYNC.again = true; syncStatus("pending"); }   // 올리는 사이에 기록이 더 바뀜 → 미저장 표시를 남기고 다시 올림
  } catch (e) {
    const offline = !navigator.onLine || /fetch|network|load/i.test(e.message);
    syncStatus(offline ? "wait" : "err", e.message);
  } finally {
    SYNC.busy = false;
    if (SYNC.again) { SYNC.again = false; setTimeout(pushSync, 2000); }
  }
}
/* 지난 날짜의 미전송 기록: 그날 인터넷이 안 돼서 아이폰에만 남은 결과를, 다음에 방문표를 열 때 맥(비공개 저장소)으로 보냄.
   그날 방문표는 이미 없으므로 저장해 둔 기록과 계산본 정보(_plan)만으로 보냄. 보내진 날짜는 그 뒤 정리 대상이 됨. */
function oldDayPayload(d) {
  const read = (suffix) => { try { return JSON.parse(localStorage.getItem("songdal_done_" + d + suffix) || "null"); } catch (e) { return null; } };
  const meta = read("_plan"), done = read("");
  if (!meta || !meta.sig || !done) return null;   // 예전 방식 기록은 어느 계산본인지 알 수 없어 보내지 않고 보관만 함
  return { v: 2, date: d, generated: meta.sig.split("|")[0], done, res: read("_res") || {}, tries: read("_tries") || {}, order: read("_order") || [], sig: meta.sig, keys: meta.keys || {} };
}
let oldBusy = false;
async function retryOldDays() {
  if (oldBusy) return;                      // 겹쳐서 두 번 보내지 않게
  oldBusy = true;
  try { const n = await pushOldDays(); if (n) toast(`전송되지 않았던 지난 ${n}일치 기록을 맥으로 보냈어요.`, null, null, 7000); } catch (e) {} finally { oldBusy = false; }
}
async function pushOldDays() {
  if (!S.plan || !S.plan.sync || LOCAL || !navigator.onLine) return 0;
  const days = [];
  for (let k = 0; k < localStorage.length; k++) { const m = /^songdal_sync_(\d{4}-\d{2}-\d{2})$/.exec(localStorage.key(k)); if (m && m[1] !== S.plan.date) days.push(m[1]); }
  let sent = 0;
  for (const d of days.sort()) {
    try {
      const payload = oldDayPayload(d); if (!payload) continue;
      const path = `${S.plan.sync.dir || "results"}/${d}.txt`;
      const content = bytesToB64(new TextEncoder().encode(await resultText(payload)));
      const cur = await gh("GET", path); const sha = cur.status === 200 ? (await cur.json()).sha : null;
      if (cur.status === 401 || cur.status === 403) break;
      const r = await gh("PUT", path, { message: `결과 ${d} (늦게 보냄)`, content, ...(sha ? { sha } : {}) });
      if (!r.ok) break;
      localStorage.removeItem("songdal_sync_" + d); sent++;
    } catch (e) { break; }   // 인터넷·토큰 문제면 다음에 다시
  }
  return sent;
}
window.addEventListener("online", () => { try { if (S.plan && localStorage.getItem(syncKey())) pushSync(); } catch (e) {} retryOldDays(); });
document.addEventListener("visibilitychange", () => { try { if (!document.hidden && S.plan && localStorage.getItem(syncKey())) pushSync(); } catch (e) {} if (!document.hidden) retryOldDays(); });

async function sendResults() {
  const box = $("send"); box.classList.remove("hidden");
  const total = S.order.length, n = S.order.filter((i) => S.done[i]).length;
  let text = "";
  try {
    text = await resultText();
  } catch (e) {
    box.innerHTML = `<div class="rc-card"><div class="rc-title">결과 보내기</div><div class="hint warn">만들지 못했어요: ${esc(e.message)}</div><div class="actions"><button class="ghost wide" id="sd-close">닫기</button></div></div>`;
    $("sd-close").onclick = () => box.classList.add("hidden"); return;
  }
  box.innerHTML = `<div class="rc-card"><div class="rc-title">오늘 결과 맥으로 보내기</div>
    <div class="hint">마침 <b>${n}</b> / ${total}건. 아래 글은 암호화돼 있어서 맥 프로그램에서만 풀려요. <b>AirDrop</b>이나 <b>메모·아이메시지(나에게)</b>로 맥에 보내고, 맥에서 '아이폰 결과 가져오기'에 붙여 넣으세요.</div>
    <textarea class="send-text" readonly>${text}</textarea>
    <div class="actions">${navigator.share ? `<button id="sd-share">공유…</button>` : ""}<button id="sd-copy" class="${navigator.share ? "ghost" : "wide"}">복사</button><button class="ghost wide" id="sd-close">닫기</button></div></div>`;
  $("sd-close").onclick = () => box.classList.add("hidden");
  $("sd-copy").onclick = async () => { try { await navigator.clipboard.writeText(text); toast("복사했어요"); } catch (e) { box.querySelector("textarea").select(); toast("길게 눌러 복사해 주세요"); } };
  if ($("sd-share")) $("sd-share").onclick = async () => { try { await navigator.share({ text }); } catch (e) {} };
}

/* ---------- 화면 사진용 상태 만들기 (미리보기 전용: ?local=1&demo=이름) ----------
   GPT 검토에 넘길 가상 화면 사진을 여러 상태로 찍기 위한 것. 미리보기(LOCAL)에서만 동작하고, 기록을 저장하지 않음.
   여기 쓰는 출입 비번·메모는 화면 모양을 보기 위한 가짜 값. */
function showDemo(name) {
  const t0 = Math.max(nowSec() - 1800, S.plan.depart);
  const fakeDoor = (i) => { const st = stopOf(i); st.door = [{ code: "#1234*", name: "가상마을1단지 101동", note: "공동현관" }, { code: "5678", name: "가상마을1단지 지하주차장", note: "" }]; st.memo = "가상 메모: 경비실에 맡기지 말 것"; };
  const mark = (kinds) => kinds.forEach((k, n) => { const i = remaining()[0]; snapshot(`서류 ${docNumber(i)}번 ${RESULTS[k]}`); S.done[i] = t0 + n * 420; if (k !== "ok") S.res[i] = k; });
  S.done = {}; S.res = {}; S.tries = {}; S.history = []; S.order = [...S.plan.order]; S.selected = null; S.showList = false; S.listFilter = "all";
  if (name === "door") fakeDoor(remaining()[0]);
  if (["progress", "picked", "list", "again", "collapsed", "recalc"].includes(name)) { mark(["ok", "absent", "addr", "ok"]); fakeDoor(remaining()[0]); }
  if (name === "picked") S.selected = remaining()[4];
  if (name === "list" || name === "again") { S.showList = true; if (name === "again") S.listFilter = "again"; const i = S.order.find((x) => S.res[x] === "absent"); if (name === "list" && i) { (S.tries[i] = []).push({ at: S.done[i], res: "absent" }); delete S.done[i]; delete S.res[i]; S.order = S.order.filter((x) => x !== i).concat([i]); } }
  if (name === "collapsed") { S.collapsed = true; $("sheet").classList.add("collapsed"); }
  if (name === "done") S.order.forEach((i, n) => { snapshot(`서류 ${docNumber(i)}번 ${RESULTS[n % 7 === 3 ? "absent" : n % 11 === 5 ? "addr" : "ok"]}`); S.done[i] = t0 + n * 300; if (n % 7 === 3) S.res[i] = "absent"; if (n % 11 === 5) S.res[i] = "addr"; });
  render(); if (S.map) S.map.resize(); followNext(); setTimeout(() => { if (S.map) S.map.resize(); followNext(); }, 200);
  if (name === "recalc") openRecalc(false);
}

/* ---------- 시작 ---------- */
if (!LOCAL && "serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});   // Safari 가 저장공간을 비우지 않도록 요청
async function boot() {
  try {
    S.plan = await loadPlan();
  } catch (e) { if (e.message !== "gate") { showGate(e.message); $("gate-token").classList.add("hidden"); $("gate-save").textContent = "다시 시도"; $("gate-save").onclick = () => location.reload(); } return; }
  $("gate").classList.add("hidden"); $("app").classList.remove("hidden");
  loadDone();
  if (!S.map) S.map = await SongdalMap.create($("map"), { clientId: S.plan.naver_client_id, onFallback: () => { S.fallbackNote = "네이버 지도 대신 OpenStreetMap 으로 표시 중"; if (S.plan) toast(S.fallbackNote); } });
  render(); followNext(); setTimeout(() => { S.map.resize(); followNext(); }, 300);   // 열자마자 다음 방문지가 지도에 보이게 (전체는 ⋯ → 전체 경로 보기)
  $("map-next").onclick = () => { S.selected = null; render(); followNext(); };
  $("map-me").onclick = showMe;
  if (S.fallbackNote) toast(S.fallbackNote);
  if (S.carried) {
    const c = S.carried; S.carried = null;
    toast(c.unknown ? `방문표가 바뀌어서 이전 마침 ${c.lost}건을 옮기지 못했어요. 마친 곳은 다시 눌러 주세요.`
      : `새 방문표예요. 마침 ${c.kept}건을 그대로 옮겼어요.` + (c.lost ? ` 새 방문표에 없는 ${c.lost}건은 뺐어요.` : ""), null, null, 9000);
  }
  const menu = $("menu"), closeMenu = () => menu.classList.add("hidden");
  $("btn-more").onclick = (e) => { e.stopPropagation(); menu.classList.toggle("hidden"); };
  document.addEventListener("click", (e) => { if (!menu.contains(e.target) && e.target !== $("btn-more")) closeMenu(); });
  $("btn-fit").onclick = () => { closeMenu(); S.selected = null; render(); fitAll(); };
  $("btn-play").onclick = () => { closeMenu(); S.animating ? stopAnimation() : playRoute(); };
  const applyType = (t) => { S.map.setType(t); $("btn-maptype").textContent = t === "satellite" ? "일반 지도" : "위성 지도"; try { localStorage.setItem("songdal_maptype", t); } catch (e) {} };
  try { const t = localStorage.getItem("songdal_maptype"); if (t === "satellite") applyType(t); } catch (e) {}
  $("btn-maptype").onclick = () => { closeMenu(); applyType(S.map.type === "satellite" ? "normal" : "satellite"); };
  $("btn-list").onclick = () => { S.ghost = null; if (S.animating) return stopAnimation(); S.showList = !S.showList; if (S.showList) setCollapsed(false); render(); };
  $("btn-reload").onclick = () => location.reload();
  $("btn-reset").onclick = () => { closeMenu(); if (confirm("오늘 기록(전달·부재·주소 문제)을 모두 지우고 순서도 처음대로 돌릴까요?")) { snapshot("기록 모두 지우기"); S.done = {}; S.res = {}; S.tries = {}; S.order = [...S.plan.order]; saveDone(); render(); followNext(); } };
  $("btn-send").onclick = () => { closeMenu(); sendResults(); };
  /* 회색 바: 누르면 접기/펼치기, 끌면 단계 이동 — 위로 끌면 접힘 → 카드 → 목록, 아래로 끌면 목록 → 카드 → 접힘 */
  const sheetStep = (dir) => {
    if (dir < 0) { if (S.collapsed) setCollapsed(false); else if (!S.showList && !S.animating) S.showList = true; }
    else { if (S.showList) S.showList = false; else if (!S.collapsed) setCollapsed(true); }
    render(); $("sheet").scrollTop = 0;
  };
  // 누름: 접기/펼치기. 목록을 보던 중이면 목록을 닫고 접음(안 그러면 카드도 목록도 안 보임)
  const tapHandle = () => { if (S.showList) S.showList = false; setCollapsed(!S.collapsed); render(); };
  const handle = $("handle"), sheet = $("sheet"); let drag = null;
  handle.addEventListener("click", (e) => { if (e.detail === 0) tapHandle(); });   // 키보드(Enter·Space)로 누른 경우. 손가락 누름은 아래 pointerup 에서 처리
  handle.addEventListener("pointerdown", (e) => { drag = { y: e.clientY, dy: 0 }; try { handle.setPointerCapture(e.pointerId); } catch (err) {} });
  handle.addEventListener("pointermove", (e) => {
    if (!drag) return; drag.dy = e.clientY - drag.y;
    sheet.style.transition = "none"; sheet.style.transform = `translateY(${Math.max(-24, Math.min(160, drag.dy))}px)`;   // 손가락을 따라 살짝 움직임
  });
  const endDrag = (e, cancelled) => {
    if (!drag) return; const dy = drag.dy; drag = null;
    sheet.style.transition = "transform .18s"; sheet.style.transform = "";
    if (cancelled) return;
    if (Math.abs(dy) < 10) tapHandle();   // 거의 안 움직였으면 '누름'
    else if (Math.abs(dy) >= 28) sheetStep(dy < 0 ? -1 : 1);
  };
  handle.addEventListener("pointerup", (e) => endDrag(e, false));
  handle.addEventListener("pointercancel", (e) => endDrag(e, true));
  try { if (localStorage.getItem("songdal_collapsed") === "1") setCollapsed(true); } catch (e) {}
  try { if (S.plan.sync && !LOCAL && localStorage.getItem(syncKey())) setTimeout(pushSync, 1500); } catch (e) {}
  setTimeout(retryOldDays, 4000);
  if (LOCAL) { const demo = new URLSearchParams(location.search).get("demo"); if (demo) showDemo(demo); }
  if (S.offline) toast("인터넷이 안 돼서 이 아이폰에 저장된 방문표를 보여줘요 (지도는 안 나올 수 있어요)", null, null, 8000);
}
boot();
