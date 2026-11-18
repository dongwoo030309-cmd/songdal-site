/* 지도 공통 모듈. 네이버 Web Dynamic Map 을 먼저 시도하고, 못 쓰면 OpenStreetMap(Leaflet) 으로 대체.
   사용: SongdalMap.create(element, {clientId}).then(map => { map.marker(...); map.polyline(...); map.fit(); }) */
(function () {
  /* 화면 위에 떠 있는 것(아이폰의 검색창·아래 패널)에 가리지 않게 지도 맞춤 여백을 페이지가 알려 줄 수 있음: window.SONGDAL_MAP_PAD() → {top,right,bottom,left} */
  const pad = () => { const d = { top: 40, right: 40, bottom: 40, left: 40 }; try { const p = window.SONGDAL_MAP_PAD && window.SONGDAL_MAP_PAD(); return p ? { ...d, ...p } : d; } catch (e) { return d; } };
  const shift = () => { const p = pad(); return Math.round((p.bottom - p.top) / 2); };   // 보이는 영역 가운데로 옮길 픽셀
  const LEAFLET_JS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
  const LEAFLET_CSS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src; s.async = true; s.onload = resolve; s.onerror = () => reject(new Error("load fail " + src));
      document.head.appendChild(s);
    });
  }
  function loadCss(href) {
    if ([...document.styleSheets].some(ss => ss.href === href)) return;
    const l = document.createElement("link"); l.rel = "stylesheet"; l.href = href; document.head.appendChild(l);
  }
  /* badge: 시간대 글자(오/주/야/휴). 색을 구분하기 어려울 때도 알아볼 수 있게 핀 오른쪽 위에 붙임 */
  function pinHtml(label, color, size, tip, badge) {
    const s = size || 26;
    const b = badge ? `<span class="sd-badge" style="color:${color}">${badge}</span>` : "";
    const pin = `<div class="sd-pin" style="width:${s}px;height:${s}px;line-height:${s}px;background:${color};font-size:${s > 24 ? 12 : 10}px">${label}</div>${b}`;
    return (tip || badge) ? `<div class="sd-wrap" style="width:${s}px;height:${s}px">${pin}${tip ? `<div class="sd-tip">${tip}</div>` : ""}</div>` : pin;
  }

  /* 아이콘 핀(11-18, 사용자 요청 · 네이버지도 저장 장소처럼): 숫자 없이 둥근 바탕 + 흰 별 / 집 모양.
     o.icon = "star" | "home", o.color = 바탕색(폴더 색), o.ring = 다음 방문(바깥 고리), o.dim = 마친 곳(흐리게) */
  const GLYPH = {
    star: '<path fill="#fff" d="M12 3.2l2.6 5.3 5.8.85-4.2 4.1 1 5.8L12 16.5l-5.2 2.75 1-5.8-4.2-4.1 5.8-.85z"/>',
    home: '<path fill="#fff" d="M12 3.6 3 11.2h2.6V20h4.9v-5.4h3V20h4.9v-8.8H21z"/>',
  };
  const escH = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  /* o.name: 핀 아래 이름(11-19 사용자 요청). o.nameKeep: 조금 축소해도 이름을 남김(다음 방문·고른 곳). 많이 축소하면 이름은 숨김(지도를 덜 가리게) */
  function iconHtml(o) {
    const s = o.size || 22, g = GLYPH[o.icon] || GLYPH.star;
    const cls = "sd-ico" + (o.ring ? " ring" : "") + (o.dim ? " dim" : "");
    const nm = o.name ? `<div class="sd-name${o.nameKeep ? " keep" : ""}${o.dim ? " dim" : ""}">${escH(o.name)}</div>` : "";
    return `<div class="sd-z" style="width:${s}px;height:${s}px"><div class="${cls}" style="width:${s}px;height:${s}px;background:${o.color || "#1b5e4a"}"${o.title ? ` role="img" aria-label="${escH(o.title)}"` : ""}><svg viewBox="0 0 24 24" width="${Math.round(s * 0.64)}" height="${Math.round(s * 0.64)}" aria-hidden="true">${g}</svg></div>${nm}</div>`;
  }
  /* 경로선 모서리를 둥글게(11-19 사용자 요청): 꺾이는 점마다 앞뒤로 최대 r 미터 안쪽에서 곡선(2차 베지어)으로 이어 줌.
     네이버 경로 점은 꺾이는 곳에만 있어서 회전교차로·굽은 길이 각지게 보였음. 길이 짧은 구간은 그 길이의 45%까지만 깎음 */
  function smoothPath(c, r) {
    if (!c || c.length < 3) return c;
    r = r || 14;
    const K = 111320, m = (a, b) => { const kx = K * Math.cos(a[0] * Math.PI / 180); return Math.hypot((b[0] - a[0]) * K, (b[1] - a[1]) * kx); };
    const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const out = [c[0]];
    for (let k = 1; k < c.length - 1; k++) {
      const A = c[k - 1], B = c[k], C = c[k + 1], ab = m(A, B), bc = m(B, C);
      if (ab < 0.5 || bc < 0.5) { out.push(B); continue; }
      // 거의 곧은 곳은 그대로
      const v1 = [(B[0] - A[0]) / ab, (B[1] - A[1]) / ab], v2 = [(C[0] - B[0]) / bc, (C[1] - B[1]) / bc];
      if (v1[0] * v2[0] * K * K + v1[1] * v2[1] * (K * Math.cos(B[0] * Math.PI / 180)) ** 2 > 0.995) { out.push(B); continue; }
      const cut = Math.min(r, ab * 0.45, bc * 0.45), P = lerp(B, A, cut / ab), Q = lerp(B, C, cut / bc);
      for (let t = 0; t <= 1.0001; t += 1 / 6) { const u = 1 - t; out.push([u * u * P[0] + 2 * u * t * B[0] + t * t * Q[0], u * u * P[1] + 2 * u * t * B[1] + t * t * Q[1]]); }
    }
    out.push(c[c.length - 1]);
    return out;
  }
  const htmlOf = (o) => o.icon ? iconHtml(o) : pinHtml(o.label, o.color || "#1b5e4a", o.size, o.tip, o.badge);
  const merged = (o, opts) => ({ ...o, ...opts, label: opts.label ?? o.label, color: opts.color || o.color, badge: opts.badge === undefined ? o.badge : opts.badge });
  /* 지도를 축소하면 아이콘 핀도 작게 (지도를 덜 가리게, 11-18 사용자 요청) — 확대 수준을 지도 칸에 data-zb 로 표시하고 CSS 가 크기를 줄임 */
  function zoomBucket(el, z) { el.dataset.zb = z <= 11 ? "far" : z <= 13 ? "mid" : "near"; }

  function naverMap(el) {
    const nm = window.naver.maps;
    const map = new nm.Map(el, { center: new nm.LatLng(36.50, 127.26), zoom: 12, mapDataControl: false, logoControlOptions: { position: nm.Position.BOTTOM_LEFT }, zoomControl: !window.SONGDAL_NO_ZOOM });
    const items = [];
    const zl = [];
    zoomBucket(el, map.getZoom()); nm.Event.addListener(map, "zoom_changed", (z) => { zoomBucket(el, z); zl.forEach((f) => f(z)); });
    /* 위성(겹쳐보기)에서 산의 등산로 선(overlayType 'ar')을 뺌 — 사용자 요청(11-18). 기본 겹쳐보기는 'ar.bg.ol.sw.lko'.
       나머지(배경·도로·지하철·한국어 이름)는 그대로. 안 되면 기본 겹쳐보기를 씀. */
    try {
      const S = nm.NaverStyleMapTypeOptions;
      if (S && S.getHybridMap && map.mapTypes) map.mapTypes.set(nm.MapTypeId.HYBRID, S.getHybridMap({ overlayType: "bg.ol.sw.lko" }));
    } catch (e) {}
    return {
      kind: "naver", raw: map, zoom: () => map.getZoom(), onZoom(f) { zl.push(f); },
      marker(o) {
        const m = new nm.Marker({ map, position: new nm.LatLng(o.lat, o.lng), zIndex: o.z || 10,
          icon: { content: htmlOf(o), anchor: new nm.Point((o.size || 26) / 2, (o.size || 26) / 2) } });
        if (o.onClick) nm.Event.addListener(m, "click", () => o.onClick(o));
        if (o.tip) { nm.Event.addListener(m, "mouseover", () => m.setZIndex(5000)); nm.Event.addListener(m, "mouseout", () => m.setZIndex(m.__z || o.z || 10)); }
        items.push(m);
        return { set(opts) { const q = merged(o, opts); m.setIcon({ content: htmlOf(q), anchor: new nm.Point((q.size || 26) / 2, (q.size || 26) / 2) }); m.__z = opts.z || o.z || 10; m.setZIndex(m.__z); }, move(lat, lng) { m.setPosition(new nm.LatLng(lat, lng)); }, remove() { m.setMap(null); } };
      },
      polyline(coords, o) {
        o = o || {};
        const sm = (c) => (o.smooth === false || o.dashed ? c : smoothPath(c));
        const p = new nm.Polyline({ map, path: sm(coords).map(c => new nm.LatLng(c[0], c[1])), strokeColor: o.color || "#1b5e4a",
          strokeWeight: o.weight || 4, strokeOpacity: o.opacity ?? 0.85, strokeStyle: o.dashed ? "shortdash" : "solid", strokeLineCap: "round", strokeLineJoin: "round", zIndex: o.z || 5 });
        items.push(p);
        return { setPath(c) { p.setPath(c.map(x => new nm.LatLng(x[0], x[1]))); }, remove() { p.setMap(null); } };
      },
      fit(points) {
        if (!points.length) return;
        const b = new nm.LatLngBounds(new nm.LatLng(points[0][0], points[0][1]), new nm.LatLng(points[0][0], points[0][1]));
        points.forEach(p => b.extend(new nm.LatLng(p[0], p[1])));
        map.fitBounds(b, pad());
      },
      center(lat, lng, zoom) { map.setCenter(new nm.LatLng(lat, lng)); if (zoom) map.setZoom(zoom); const s = shift(); if (s) map.panBy(new nm.Point(0, s)); },
      clear() { items.forEach(i => i.setMap(null)); items.length = 0; },
      resize() { nm.Event.trigger(map, "resize"); },
      setType(t) { map.setMapTypeId(t === "satellite" ? nm.MapTypeId.HYBRID : nm.MapTypeId.NORMAL); },
    };
  }

  async function leafletMap(el) {
    loadCss(LEAFLET_CSS);
    if (!window.L) await loadScript(LEAFLET_JS);
    const map = L.map(el, { zoomControl: !window.SONGDAL_NO_ZOOM }).setView([36.50, 127.26], 12);
    const street = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map);
    const sat = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, attribution: "Imagery © Esri" });
    const layer = L.layerGroup().addTo(map);
    const zl = [];
    zoomBucket(el, map.getZoom()); map.on("zoomend", () => { zoomBucket(el, map.getZoom()); zl.forEach((f) => f(map.getZoom())); });
    return {
      kind: "osm", raw: map, zoom: () => map.getZoom(), onZoom(f) { zl.push(f); },
      marker(o) {
        const size = o.size || 26;
        const m = L.marker([o.lat, o.lng], { icon: L.divIcon({ className: "", html: htmlOf({ ...o, size }), iconSize: [size, size], iconAnchor: [size / 2, size / 2] }), zIndexOffset: (o.z || 10) * 10 }).addTo(layer);
        if (o.onClick) m.on("click", () => o.onClick(o));
        if (o.tip) { m.on("mouseover", () => m.setZIndexOffset(50000)); m.on("mouseout", () => m.setZIndexOffset((m.__z || o.z || 10) * 10)); }
        return { set(opts) { const q = merged(o, opts), s = q.size || size; m.setIcon(L.divIcon({ className: "", html: htmlOf({ ...q, size: s }), iconSize: [s, s], iconAnchor: [s / 2, s / 2] })); m.__z = opts.z || o.z || 10; m.setZIndexOffset(m.__z * 10); }, move(lat, lng) { m.setLatLng([lat, lng]); }, remove() { layer.removeLayer(m); } };
      },
      polyline(coords, o) {
        o = o || {};
        const p = L.polyline(o.smooth === false || o.dashed ? coords : smoothPath(coords), { color: o.color || "#1b5e4a", weight: o.weight || 4, opacity: o.opacity ?? 0.85, dashArray: o.dashed ? "6 8" : null, lineCap: "round", lineJoin: "round", smoothFactor: 0.5 }).addTo(layer);
        return { setPath(c) { p.setLatLngs(c); }, remove() { layer.removeLayer(p); } };
      },
      fit(points) { if (!points.length) return; const p = pad(); map.fitBounds(points, { paddingTopLeft: [p.left, p.top], paddingBottomRight: [p.right, p.bottom] }); },
      center(lat, lng, zoom) { map.setView([lat, lng], zoom || map.getZoom(), { animate: false }); const s = shift(); if (s) map.panBy([0, s], { animate: false }); },
      clear() { layer.clearLayers(); },
      resize() { map.invalidateSize(); },
      setType(t) { if (t === "satellite") { map.removeLayer(street); sat.addTo(map); } else { map.removeLayer(sat); street.addTo(map); } layer.bringToFront && layer.bringToFront(); },
    };
  }

  /* 그리기 기록을 남겨 두었다가, 네이버 인증이 늦게 실패하면 OpenStreetMap 으로 갈아타서 다시 그립니다. */
  function recorder(el, first, opts) {
    let impl = first, ops = [], swapped = false, mapType = "normal"; const zoomFns = [];
    const handles = [];
    function run(op) {
      if (op.t === "marker") { op.h.inner = impl.marker(op.o); if (op.h.state) op.h.inner.set(op.h.state); }
      else if (op.t === "polyline") op.h.inner = impl.polyline(op.c, op.o);
      else if (op.t === "fit") impl.fit(op.p);
      else if (op.t === "center") impl.center(op.lat, op.lng, op.z);
    }
    const api = {
      get kind() { return impl.kind; },
      get raw() { return impl.raw; },   // 시험·점검용(확대 수준 바꾸기 등)
      zoom() { return impl.zoom ? impl.zoom() : 14; },
      onZoom(f) { zoomFns.push(f); if (impl.onZoom) impl.onZoom(f); },   // 확대 수준이 바뀌면 부름(겹친 경로선 간격 다시 계산)
      marker(o) { const h = { inner: null, state: null, set(x) { h.state = x; h.inner && h.inner.set(x); }, move(lat, lng) { o.lat = lat; o.lng = lng; h.inner && h.inner.move && h.inner.move(lat, lng); }, remove() { h.inner && h.inner.remove(); ops = ops.filter((q) => q.h !== h); } }; const op = { t: "marker", o, h }; ops.push(op); run(op); return h; },
      polyline(c, o) { const h = { inner: null, setPath(nc) { op.c = nc; h.inner && h.inner.setPath && h.inner.setPath(nc); }, remove() { h.inner && h.inner.remove(); ops = ops.filter((q) => q.h !== h); } }; const op = { t: "polyline", c, o, h }; ops.push(op); run(op); return h; },
      fit(p) { ops = ops.filter((q) => q.t !== "fit" && q.t !== "center"); const op = { t: "fit", p }; ops.push(op); run(op); },
      center(lat, lng, z) { ops = ops.filter((q) => q.t !== "fit" && q.t !== "center"); const op = { t: "center", lat, lng, z }; ops.push(op); run(op); },
      clear() { impl.clear(); ops = []; },
      resize() { impl.resize(); },
      get type() { return mapType; },
      setType(t) { mapType = t; impl.setType(t); },
      async fallback(reason) {
        if (swapped) return; swapped = true;
        try { impl.clear(); } catch (e) {}
        el.innerHTML = "";
        const fresh = document.createElement("div"); fresh.style.cssText = "width:100%;height:100%"; el.appendChild(fresh);
        try { impl = await leafletMap(fresh); } catch (e) { impl = noneMap(el); }
        if (mapType !== "normal") impl.setType(mapType);
        if (impl.onZoom) zoomFns.forEach((f) => impl.onZoom(f));
        const replay = ops.slice(); replay.forEach(run);
        if (opts.onFallback) opts.onFallback(reason);
      },
    };
    return api;
  }
  function noneMap(el) {
    el.innerHTML = '<div style="padding:20px;color:#6b6b66;font-size:13px">지도를 불러오지 못했어요 (인터넷 연결을 확인하세요). 순서표는 아래에서 볼 수 있어요.</div>';
    const noop = () => ({ set() {}, move() {}, setPath() {}, remove() {} });
    return { kind: "none", zoom: () => 14, marker: noop, polyline: noop, fit() {}, center() {}, clear() {}, resize() {}, setType() {} };
  }

  function dist(a, b) { const R = 6371000, r = Math.PI / 180, dLa = (b[0] - a[0]) * r, dLo = (b[1] - a[1]) * r; const h = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.min(1, Math.sqrt(h))); }
  /* legs: [{coords:[[lat,lng],...], real, color}] 를 출발부터 차례로 그리며 점이 움직임.
     opts.onArrive(k) — k번째 구간 끝에 닿았을 때, opts.onDone() — 끝까지 갔을 때. 반환값.stop() 으로 멈춤 */
  function animate(map, legs, opts) {
    opts = opts || {};
    legs.forEach((L) => { L.cum = [0]; for (let j = 1; j < L.coords.length; j++) L.cum.push(L.cum[j - 1] + dist(L.coords[j - 1], L.coords[j])); L.len = L.cum[L.cum.length - 1]; L.dur = Math.max(350, Math.min(1600, 350 + L.len / 5)); });
    const start = legs[0].coords[0];
    const head = map.marker({ lat: start[0], lng: start[1], label: "", color: "#ff6a00", size: 18, z: 900 });
    let k = 0, t0 = null, last = 0, alive = true, raf = 0;
    let cur = map.polyline([start], { color: legs[0].color || "#ff6a00", weight: 6, opacity: 1 });
    const step = (now) => {
      if (!alive) return;
      if (t0 === null) t0 = now;
      const L = legs[k]; const f = L.dur ? Math.min(1, (now - t0) / L.dur) : 1;
      if (now - last > 33 || f === 1) {
        last = now; const d = f * L.len; let j = 1; while (j < L.cum.length && L.cum[j] < d) j++;
        const a = L.coords[j - 1], b = L.coords[Math.min(j, L.coords.length - 1)], seg = (L.cum[j] ?? L.len) - L.cum[j - 1];
        const u = seg > 0 ? (d - L.cum[j - 1]) / seg : 1; const p = [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
        cur.setPath(L.coords.slice(0, j).concat([p])); head.move(p[0], p[1]);
      }
      if (f === 1) {
        cur.setPath(L.coords); if (opts.onArrive) opts.onArrive(k);
        k += 1;
        if (k >= legs.length) { alive = false; head.remove(); if (opts.onDone) opts.onDone(); return; }
        t0 = now; cur = map.polyline([legs[k].coords[0]], { color: legs[k].color || "#ff6a00", weight: 6, opacity: 1 });
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return { stop() { alive = false; cancelAnimationFrame(raf); head.remove(); }, get running() { return alive; } };
  }

  window.SongdalMap = {
    animate,
    _pinHtml: pinHtml,   // 화면 점검용
    badge(rule) { return { "오전": "오", "주간": "주", "야간": "야", "휴일": "휴" }[rule] || ""; },
    async create(el, opts) {
      opts = opts || {};
      if (!document.getElementById("sd-pin-style")) {
        const st = document.createElement("style"); st.id = "sd-pin-style";
        st.textContent = ".sd-ico{border-radius:50%;display:flex;align-items:center;justify-content:center;border:2px solid #fff;box-sizing:border-box;box-shadow:0 1px 4px rgba(0,0,0,.45);cursor:pointer;transition:transform .15s ease}"
          + ".sd-ico.ring{box-shadow:0 0 0 3px rgba(255,255,255,.95),0 0 0 6px rgba(27,94,74,.55),0 2px 6px rgba(0,0,0,.4)}.sd-ico.dim{opacity:.55;filter:grayscale(.85)}"
          + "[data-zb=mid] .sd-ico{transform:scale(.78)}[data-zb=far] .sd-ico{transform:scale(.56)}[data-zb=far] .sd-ico.ring{transform:scale(.75)}"
          + "@media (prefers-reduced-motion: reduce){.sd-ico{transition:none}}"
          + ".sd-z{position:relative}.sd-name{position:absolute;left:50%;top:calc(100% + 1px);transform:translateX(-50%);white-space:nowrap;max-width:120px;overflow:hidden;text-overflow:ellipsis;pointer-events:none;"
          + "font:700 12px/1.25 -apple-system,'Apple SD Gothic Neo',system-ui,sans-serif;color:#1d1d1b;text-shadow:0 0 2px #fff,0 0 2px #fff,0 0 3px #fff,0 0 4px #fff;letter-spacing:-.2px}"
          + ".sd-name.dim{color:#77776f}[data-zb=mid] .sd-name{top:calc(89% + 1px)}[data-zb=mid] .sd-name:not(.keep),[data-zb=far] .sd-name{display:none}"
          + ".sd-pin{border-radius:50%;color:#fff;font-weight:700;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.4);border:2px solid #fff;box-sizing:border-box;font-family:-apple-system,system-ui,sans-serif;cursor:pointer}"
          + ".sd-badge{position:absolute;right:-7px;top:-7px;min-width:15px;height:15px;line-height:13px;border-radius:8px;background:#fff;border:1px solid currentColor;font:700 9.5px/13px -apple-system,'Apple SD Gothic Neo',system-ui,sans-serif;text-align:center;padding:0 1px;box-sizing:border-box;pointer-events:none}"
          + ".sd-wrap{position:relative}.sd-tip{display:none;position:absolute;left:50%;bottom:calc(100% + 10px);transform:translateX(-50%);background:#fff;color:#1d1d1b;border-radius:10px;padding:8px 11px;box-shadow:0 3px 14px rgba(0,0,0,.28);white-space:nowrap;font:13px/1.45 -apple-system,'Apple SD Gothic Neo',system-ui,sans-serif;text-align:left;pointer-events:none;z-index:10}"
          + ".sd-tip:after{content:'';position:absolute;left:50%;top:100%;margin-left:-7px;border:7px solid transparent;border-top-color:#fff}"
          + ".sd-wrap:hover .sd-tip{display:block}.sd-tip b{font-size:14px}.sd-tip .f{color:#6b6b66;font-size:12px}.sd-tip .d{margin-top:4px;padding-top:4px;border-top:1px solid #eee;color:#8a3b00;font-weight:700;font-family:ui-monospace,Menlo,monospace}";
        document.head.appendChild(st);
      }
      let rec = null, lateFail = false;
      // 네이버는 인증 실패를 지도 생성 '후에' 알려 주는 경우가 많아서, 언제 오든 받아서 갈아탑니다.
      window.navermap_authFailure = function () { lateFail = true; if (rec) rec.fallback("naver-auth"); };
      if (opts.clientId) {
        try {
          await loadScript("https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=" + encodeURIComponent(opts.clientId));
          await new Promise((r) => setTimeout(r, 400));
          if (!lateFail && window.naver && window.naver.maps) {
            rec = recorder(el, naverMap(el), opts);
            return rec;
          }
        } catch (e) { /* 스크립트 로드 실패 → 아래로 */ }
      }
      if (opts.onFallback) opts.onFallback(opts.clientId ? "naver-auth" : "no-client-id");
      let impl;
      try { impl = await leafletMap(el); } catch (e) { impl = noneMap(el); }
      rec = recorder(el, impl, {});
      return rec;
    },
  };
})();
