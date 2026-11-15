/* 지도 공통 모듈. 네이버 Web Dynamic Map 을 먼저 시도하고, 못 쓰면 OpenStreetMap(Leaflet) 으로 대체.
   사용: SongdalMap.create(element, {clientId}).then(map => { map.marker(...); map.polyline(...); map.fit(); }) */
(function () {
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
  function pinHtml(label, color, size) {
    const s = size || 26;
    return `<div class="sd-pin" style="width:${s}px;height:${s}px;line-height:${s}px;background:${color};font-size:${s > 24 ? 12 : 10}px">${label}</div>`;
  }

  async function tryNaver(clientId) {
    if (!clientId) throw new Error("no client id");
    let failed = false;
    window.navermap_authFailure = function () { failed = true; };
    await loadScript("https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=" + encodeURIComponent(clientId));
    // 인증 실패 콜백은 비동기로 올 수 있어 잠깐 기다림
    await new Promise(r => setTimeout(r, 700));
    if (failed || !window.naver || !window.naver.maps) throw new Error("naver auth failed");
    return "naver";
  }

  function naverMap(el) {
    const nm = window.naver.maps;
    const map = new nm.Map(el, { center: new nm.LatLng(36.50, 127.26), zoom: 12, mapDataControl: false, logoControlOptions: { position: nm.Position.BOTTOM_LEFT } });
    const items = [];
    return {
      kind: "naver", raw: map,
      marker(o) {
        const m = new nm.Marker({ map, position: new nm.LatLng(o.lat, o.lng), zIndex: o.z || 10,
          icon: { content: pinHtml(o.label, o.color || "#1b5e4a", o.size), anchor: new nm.Point((o.size || 26) / 2, (o.size || 26) / 2) } });
        if (o.onClick) nm.Event.addListener(m, "click", () => o.onClick(o));
        items.push(m);
        return { set(opts) { m.setIcon({ content: pinHtml(opts.label ?? o.label, opts.color || o.color, opts.size || o.size), anchor: new nm.Point((opts.size || o.size || 26) / 2, (opts.size || o.size || 26) / 2) }); m.setZIndex(opts.z || o.z || 10); }, remove() { m.setMap(null); } };
      },
      polyline(coords, o) {
        o = o || {};
        const p = new nm.Polyline({ map, path: coords.map(c => new nm.LatLng(c[0], c[1])), strokeColor: o.color || "#1b5e4a",
          strokeWeight: o.weight || 4, strokeOpacity: o.opacity ?? 0.85, strokeStyle: o.dashed ? "shortdash" : "solid", zIndex: 5 });
        items.push(p);
        return { remove() { p.setMap(null); } };
      },
      fit(points) {
        if (!points.length) return;
        const b = new nm.LatLngBounds(new nm.LatLng(points[0][0], points[0][1]), new nm.LatLng(points[0][0], points[0][1]));
        points.forEach(p => b.extend(new nm.LatLng(p[0], p[1])));
        map.fitBounds(b, { top: 40, right: 40, bottom: 40, left: 40 });
      },
      center(lat, lng, zoom) { map.setCenter(new nm.LatLng(lat, lng)); if (zoom) map.setZoom(zoom); },
      clear() { items.forEach(i => i.setMap(null)); items.length = 0; },
      resize() { nm.Event.trigger(map, "resize"); },
    };
  }

  async function leafletMap(el) {
    loadCss(LEAFLET_CSS);
    if (!window.L) await loadScript(LEAFLET_JS);
    const map = L.map(el, { zoomControl: true }).setView([36.50, 127.26], 12);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map);
    const layer = L.layerGroup().addTo(map);
    return {
      kind: "osm", raw: map,
      marker(o) {
        const size = o.size || 26;
        const m = L.marker([o.lat, o.lng], { icon: L.divIcon({ className: "", html: pinHtml(o.label, o.color || "#1b5e4a", size), iconSize: [size, size], iconAnchor: [size / 2, size / 2] }), zIndexOffset: (o.z || 10) * 10 }).addTo(layer);
        if (o.onClick) m.on("click", () => o.onClick(o));
        return { set(opts) { const s = opts.size || size; m.setIcon(L.divIcon({ className: "", html: pinHtml(opts.label ?? o.label, opts.color || o.color, s), iconSize: [s, s], iconAnchor: [s / 2, s / 2] })); m.setZIndexOffset((opts.z || o.z || 10) * 10); }, remove() { layer.removeLayer(m); } };
      },
      polyline(coords, o) {
        o = o || {};
        const p = L.polyline(coords, { color: o.color || "#1b5e4a", weight: o.weight || 4, opacity: o.opacity ?? 0.85, dashArray: o.dashed ? "6 8" : null }).addTo(layer);
        return { remove() { layer.removeLayer(p); } };
      },
      fit(points) { if (points.length) map.fitBounds(points, { padding: [40, 40] }); },
      center(lat, lng, zoom) { map.setView([lat, lng], zoom || map.getZoom()); },
      clear() { layer.clearLayers(); },
      resize() { map.invalidateSize(); },
    };
  }

  window.SongdalMap = {
    async create(el, opts) {
      opts = opts || {};
      if (!document.getElementById("sd-pin-style")) {
        const st = document.createElement("style"); st.id = "sd-pin-style";
        st.textContent = ".sd-pin{border-radius:50%;color:#fff;font-weight:700;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.4);border:2px solid #fff;box-sizing:border-box;font-family:-apple-system,system-ui,sans-serif}";
        document.head.appendChild(st);
      }
      try {
        await tryNaver(opts.clientId);
        return naverMap(el);
      } catch (e) {
        if (opts.onFallback) opts.onFallback(e);
      }
      try {
        return await leafletMap(el);
      } catch (e) {
        el.innerHTML = '<div style="padding:20px;color:#6b6b66;font-size:13px">지도를 불러오지 못했어요 (인터넷 연결 또는 네이버 Dynamic Map 설정을 확인하세요). 순서표는 아래에서 볼 수 있어요.</div>';
        const noop = () => ({ set() {}, remove() {} });
        return { kind: "none", marker: noop, polyline: noop, fit() {}, center() {}, clear() {}, resize() {} };
      }
    },
  };
})();
