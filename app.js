/* 아이폰 방문표. plan.json 을 읽어 지도·다음 방문지·남은 순서 재정렬을 처리. 네트워크 없이도 재정렬은 됨. */
const $ = (id) => document.getElementById(id);
const CFG = window.SONGDAL_CONFIG || {};
const LOCAL = new URLSearchParams(location.search).get("local") === "1";
const S = { plan: null, map: null, markers: {}, lines: [], order: [], done: {}, showList: false, selected: null, fallbackNote: "" };
const RULE_CLASS = { "오전": "morning", "주간": "day", "야간": "night" };
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
  const r = await fetch("plan.enc.txt?t=" + Date.now(), { cache: "no-store" });
  if (r.status === 404) throw new Error("올라온 방문표가 없어요. 맥에서 '아이폰에 올리기'를 눌러 주세요.");
  if (!r.ok) throw new Error("방문표를 받지 못했어요 (" + r.status + "). 잠시 후 ↻ 를 눌러 주세요.");
  const raw = Uint8Array.from(atob((await r.text()).trim()), (c) => c.charCodeAt(0));
  try {
    const key = await crypto.subtle.importKey("raw", b64uToBytes(keyB64u), "AES-GCM", false, ["decrypt"]);
    const data = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12) }, key, raw.slice(12));
    return JSON.parse(new TextDecoder().decode(data));
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

const storeKey = () => "songdal_done_" + (S.plan ? S.plan.date : "");
function loadDone() { try { S.done = JSON.parse(localStorage.getItem(storeKey()) || "{}"); } catch (e) { S.done = {}; } const o = localStorage.getItem(storeKey() + "_order"); S.order = o ? JSON.parse(o) : [...S.plan.order]; }
function saveDone() { localStorage.setItem(storeKey(), JSON.stringify(S.done)); localStorage.setItem(storeKey() + "_order", JSON.stringify(S.order)); }

/* ---------- 일정 계산 (파이썬 planner.simulate 와 같은 규칙) ---------- */
function stopOf(i) { return S.plan.stops.find((s) => s.i === i); }
function remaining() { return S.order.filter((i) => !S.done[i]); }
function currentPos() { const d = S.order.filter((i) => S.done[i]); return d.length ? d[d.length - 1] : 0; }
function currentTime() { const d = S.order.filter((i) => S.done[i]); const last = d.length ? (S.done[d[d.length - 1]] || 0) : 0; return Math.max(nowSec(), last); }
function windowOf(st, t0) { let [a, b] = st.window; if (b < t0) return [0, S.plan.return_by, true]; return [a, b, false]; }
function simulate(order, pos, t0) {
  const T = S.plan.matrix, END = S.plan.stops.length + 1; let t = t0, p = pos, drive = 0; const rows = [];
  for (const i of order) {
    const st = stopOf(i); const leg = T[p][i]; const arrive = t + leg; const [a, b, late] = windowOf(st, t0);
    const begin = Math.max(arrive, a);
    if (begin + st.service > b) return { ok: false };
    rows.push({ i, arrive, begin, leave: begin + st.service, travel: leg, wait: begin - arrive, late });
    t = begin + st.service; drive += leg; p = i;
  }
  const back = T[p][END];
  return { ok: t + back <= S.plan.return_by || order.length === 0, finish: t + back, drive, rows };
}
function score(order, pos, t0) { const r = simulate(order, pos, t0); return r.ok ? [0, -order.length, r.finish, r.drive] : [1, 0, 0, 0]; }
function less(a, b) { for (let k = 0; k < a.length; k++) { if (a[k] !== b[k]) return a[k] < b[k]; } return false; }
function improve(order, pos, t0, budgetMs) {
  let best = order.slice(), bs = score(best, pos, t0); const end = Date.now() + budgetMs; let improved = true;
  while (improved && Date.now() < end) {
    improved = false; const n = best.length;
    outer: for (const seg of [1, 2, 3]) for (let i = 0; i + seg <= n; i++) {
      const chunk = best.slice(i, i + seg), rest = best.slice(0, i).concat(best.slice(i + seg));
      for (let k = 0; k <= rest.length; k++) { if (k === i) continue; const c = rest.slice(0, k).concat(chunk, rest.slice(k)); const sc = score(c, pos, t0); if (less(sc, bs)) { best = c; bs = sc; improved = true; break outer; } }
    }
    if (improved) continue;
    outer2: for (let i = 0; i < n - 1; i++) for (let j = i + 2; j <= n; j++) { const c = best.slice(0, i).concat(best.slice(i, j).reverse(), best.slice(j)); const sc = score(c, pos, t0); if (less(sc, bs)) { best = c; bs = sc; improved = true; break outer2; } }
  }
  return { order: best, score: bs };
}
function replan() {
  const rem = remaining(); if (rem.length < 2) return;
  const pos = currentPos(), t0 = currentTime();
  const base = score(rem, pos, t0);
  // 시간이 지난 창이 있으면 우선 실행 가능하게 만들고, 그다음 더 좋은 순서가 있으면 채택 (2분 이상 이득일 때만 바꿈)
  let start = rem;
  if (base[0] === 1) { start = rem.slice().sort((x, y) => (stopOf(x).window[1] - stopOf(y).window[1])); }
  const r = improve(start, pos, t0, 1500);
  if (r.score[0] === 0 && (base[0] === 1 || r.score[2] < base[2] - 120 || (r.score[2] === base[2] && r.score[3] < base[3] - 120))) {
    const doneList = S.order.filter((i) => S.done[i]);
    S.order = doneList.concat(r.order); saveDone(); return true;
  }
  return false;
}

/* ---------- 화면 ---------- */
function docNumber(i) { return S.plan.order.indexOf(i) + 1; }  /* 아침에 인쇄한 서류 번호 */
function render() {
  const plan = S.plan, rem = remaining(), total = S.order.length, doneCount = total - rem.length;
  $("bar-title").textContent = `${plan.date.slice(5).replace("-", "/")} 방문표`;
  $("bar-sub").textContent = `${doneCount}/${total} 완료 · 출발 ${plan.start.name}`;
  const sim = simulate(rem, currentPos(), currentTime());
  const etas = {}; (sim.rows || []).forEach((r) => (etas[r.i] = r));
  // 다음 카드
  const next = $("next");
  if (!rem.length) { next.innerHTML = `<div class="done-msg">오늘 방문을 모두 마쳤어요 🎉</div><div class="actions"><button class="ghost wide" id="btn-undo-last">마지막 마침 취소</button></div>`; $("btn-undo-last").onclick = () => { const d = S.order.filter((i) => S.done[i]); if (d.length) { delete S.done[d[d.length - 1]]; saveDone(); render(); } }; }
  else {
    const i = S.selected && rem.includes(S.selected) ? S.selected : rem[0]; const st = stopOf(i); const e = etas[i];
    const isNext = i === rem[0];
    next.innerHTML = `
      <div class="kicker"><span>${isNext ? "다음 방문" : "선택한 방문지"} · 서류 ${docNumber(i)}번</span><span>${e ? `도착 예정 ${hhmm(e.arrive)}${e.wait > 60 ? ` (대기 ${mins(e.wait)})` : ""}` : "시간 계산 불가"}</span></div>
      <div class="name">${esc(st.label || "(이름 없음)")}</div>
      <div class="place">${esc(st.place)}</div>
      <div class="addr">${esc(st.address)}${st.memo ? " · " + esc(st.memo) : ""}${st.folder && st.folder.includes(" + ") ? `<br><b>두 폴더 문건 함께 확인</b> (${esc(st.folder)})` : ""}</div>
      <div class="meta"><span class="tag ${RULE_CLASS[st.rule] || ""}">${esc(st.rule)} ${st.rule === "아무때나" ? "" : hhmm(st.window[0]) + "–" + hhmm(st.window[1])}</span>${e && e.late ? '<span class="tag late">시간창 지남</span>' : ""}${e ? `<span class="tag">이동 ${mins(e.travel)}</span>` : ""}<span class="hint">남은 ${rem.length}건${sim.ok ? ` · 종료 예상 ${hhmm(sim.finish)}` : " · 기한 안에 다 못 돌 수 있어요"}</span></div>
      <div class="actions">
        <a class="wide" href="${navLink(st)}"><button class="wide" style="width:100%">네이버지도 길안내</button></a>
        <button id="btn-done">이 건 마침</button>
        <button class="ghost" id="btn-skip">${isNext ? "다음으로 미루기" : "이 건부터 가기"}</button>
      </div>`;
    $("btn-done").onclick = () => { S.done[i] = nowSec(); S.selected = null; const changed = replan(); saveDone(); render(); if (changed) toast("남은 순서를 현재 위치 기준으로 다시 짰어요."); };
    $("btn-skip").onclick = () => { const r = remaining(); const k = r.indexOf(i); if (isNext) { if (r.length > 1) { const d = S.order.filter((x) => S.done[x]); const nr = r.slice(1, 2).concat([i], r.slice(2)); S.order = d.concat(nr); } } else { const d = S.order.filter((x) => S.done[x]); const nr = [i].concat(r.filter((x) => x !== i)); S.order = d.concat(nr); } S.selected = null; saveDone(); render(); };
  }
  renderList(etas); drawRoute();
}
function navLink(st) { const app = encodeURIComponent(LOCAL ? "songdal" : location.origin + location.pathname); return `nmap://navigation?dlat=${st.lat}&dlng=${st.lng}&dname=${encodeURIComponent(st.place || st.label)}&appname=${app}`; }
function renderList(etas) {
  const box = $("list"); box.classList.toggle("hidden", !S.showList); if (!S.showList) return;
  const rem = remaining(); box.innerHTML = `<div class="head"><span>순서 (번호 = 서류 번호)</span><button class="ghost" id="btn-reset">완료 모두 취소</button></div>`;
  $("btn-reset").onclick = () => { if (confirm("오늘 완료 표시를 모두 지울까요?")) { S.done = {}; S.order = [...S.plan.order]; saveDone(); render(); } };
  S.order.forEach((i) => {
    const st = stopOf(i); const done = !!S.done[i]; const e = etas[i]; const cur = !done && rem[0] === i;
    const div = document.createElement("div"); div.className = "item" + (done ? " done" : "") + (cur ? " cur" : "");
    div.innerHTML = `<div class="n">${docNumber(i)}</div><div class="t"><b>${esc(st.label)}</b> · ${esc(st.place)}<small>${esc(st.rule)}${done ? ` · 마침 ${hhmm(S.done[i])}` : e ? ` · 예정 ${hhmm(e.arrive)}` : ""}</small></div>${done ? `<button class="ghost undo">취소</button>` : `<button class="ghost go">보기</button>`}`;
    const b = div.querySelector("button");
    if (done) b.onclick = () => { delete S.done[i]; saveDone(); render(); };
    else b.onclick = () => { S.selected = i; S.showList = false; const st = stopOf(i); S.map.center(st.lat, st.lng, 16); render(); };
    box.appendChild(div);
  });
}
let toastTimer;
function toast(msg) { const n = $("note"); n.textContent = msg; n.classList.remove("hidden"); clearTimeout(toastTimer); toastTimer = setTimeout(() => n.classList.add("hidden"), 4000); }

/* ---------- 지도 ---------- */
function pt(i) { const p = S.plan; return i === 0 ? [p.start.lat, p.start.lng] : i === p.stops.length + 1 ? [p.end.lat, p.end.lng] : [stopOf(i).lat, stopOf(i).lng]; }
function drawRoute() {
  const m = S.map; if (!m) return; m.clear(); S.markers = {};
  const rem = remaining(); const seq = [currentPos(), ...rem, S.plan.stops.length + 1];
  for (let k = 0; k < seq.length - 1; k++) {
    const a = seq[k], b = seq[k + 1]; const path = S.plan.paths[`${a},${b}`];
    const coords = path ? path.map(([lng, lat]) => [lat, lng]) : [pt(a), pt(b)];
    const st = b <= S.plan.stops.length ? stopOf(b) : null;
    m.polyline(coords, { color: st && st.rule === "야간" ? "#5b4bb5" : "#1b5e4a", dashed: !path, weight: k === 0 ? 6 : 4, opacity: k === 0 ? 0.95 : 0.7 });
  }
  S.order.forEach((i) => {
    const st = stopOf(i); const done = !!S.done[i]; const isNext = rem[0] === i;
    S.markers[i] = m.marker({ lat: st.lat, lng: st.lng, label: String(docNumber(i)), size: isNext ? 34 : 26, z: isNext ? 90 : done ? 1 : 10,
      color: done ? "#b5b5b0" : st.rule === "야간" ? "#5b4bb5" : st.rule === "오전" ? "#c2640f" : "#1b5e4a", onClick: () => { S.selected = i; render(); } });
  });
  m.marker({ lat: S.plan.start.lat, lng: S.plan.start.lng, label: "출발", color: "#333", size: 34, z: 95 });
}
function fitAll() { const pts = remaining().map(pt); if (!pts.length) pts.push(pt(0)); S.map.fit(pts); }

/* ---------- 시작 ---------- */
async function boot() {
  try {
    S.plan = await loadPlan();
  } catch (e) { if (e.message !== "gate") { showGate(e.message); $("gate-token").classList.add("hidden"); $("gate-save").textContent = "다시 시도"; $("gate-save").onclick = () => location.reload(); } return; }
  $("gate").classList.add("hidden"); $("app").classList.remove("hidden");
  loadDone();
  if (!S.map) S.map = await SongdalMap.create($("map"), { clientId: S.plan.naver_client_id, onFallback: () => { S.fallbackNote = "네이버 지도 대신 OpenStreetMap 으로 표시 중"; } });
  render(); fitAll(); setTimeout(() => S.map.resize(), 300);
  if (S.fallbackNote) toast(S.fallbackNote);
  $("btn-fit").onclick = fitAll;
  $("btn-list").onclick = () => { S.showList = !S.showList; render(); };
  $("btn-reload").onclick = () => location.reload();
}
boot();
