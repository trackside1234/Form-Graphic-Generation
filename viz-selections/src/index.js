/**
* Presenter Selections — Cloudflare Worker
*
* Producer builds a cross-venue "Races to be previewed" list for today's
* preview show by browsing meetings from the TAB affiliates API and adding
* individual races (any mix of venues/codes) to a preview list. Presenters
* each pick one runner per race in that list. The producer view collates
* every presenter's selections into:
*   1. A single Viz Trio 3.0 XML file (batch import of every selection),
*   2. A Word-compatible backup document, and
*   3. A .zip of every selected horse's silk PNG for the graphics op.
*
* TAB proxy logic (meetings / event lookup) is carried over from the
* TS-FORM-VT-EDIT-BUILDER project, trimmed down to just what this tool needs.
*/
const TAB_BASE = "https://api.tab.co.nz/affiliates/v1/racing";
const PRESENTERS = [
  { id: "leith-innes", name: "Leith Innes", first: "Leith", headshotKey: "LeithInnes" },
  { id: "aidan-rodley", name: "Aidan Rodley", first: "Aidan", headshotKey: "AidanRodley" },
  { id: "bevan-sweeney", name: "Bevan Sweeney", first: "Bevan", headshotKey: "BevanSweeney" },
  { id: "pip-morris", name: "Pip Morris", first: "Pip", headshotKey: "PipMorris" },
  { id: "emily-murphy", name: "Emily Murphy", first: "Emily", headshotKey: "EmilyMurphy" }
];
const SHOW_KEY = "show:current";
// ---------- small helpers ----------
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}
function cleanDate(v) { return /^\d{4}-\d{2}-\d{2}$/.test(v || "") ? v : null; }
function cleanUUID(v) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v || "") ? v : null; }
async function tabJSON(url) {
  const r = await fetch(url, { headers: { accept: "application/json", "user-agent": "Presenter-Selections/1.0" } });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!r.ok) {
    const detail = data?.error || data?.message || data?.raw || "request failed";
    const err = new Error(`TAB ${r.status}: ${typeof detail === "string" ? detail : "request failed"}`);
    err.status = r.status; err.upstream = url; err.body = data;
    throw err;
  }
  return data;
}
async function meetingsFor(date, country = "NZ", category = "T") {
  const u = new URL(`${TAB_BASE}/meetings`);
  u.searchParams.set("category", category === "H" ? "H" : "T");
  if (country) u.searchParams.set("country", country);
  u.searchParams.set("date_from", date);
  u.searchParams.set("date_to", date);
  u.searchParams.set("enc", "json");
  u.searchParams.set("limit", "200");
  return tabJSON(u.toString());
}
async function eventById(id) {
  return tabJSON(`${TAB_BASE}/events/${encodeURIComponent(id)}?enc=json`);
}
function compactEvent(payload) {
  const d = payload?.data || payload || {};
  const race = d.race || {};
  const res = d.results || [];
  const rmap = new Map(res.map(x => [String(x.runner_number), x]));
  return {
    race: {
      event_id: race.event_id, meeting_id: race.meeting_id, race_id: race.race_id,
      meeting_name: race.meeting_name, display_meeting_name: race.display_meeting_name,
      venue_name: race.venue_name, track: race.track, description: race.description,
      race_number: race.race_number, race_date_nz: race.race_date_nz, distance: race.distance,
      track_condition: race.track_condition, class: race.class, country: race.country
    },
    results: res.map(x => ({ entrant_id: x.entrant_id, runner_number: x.runner_number, name: x.name, position: x.position })),
    runners: (d.runners || []).map(x => ({
      entrant_id: x.entrant_id, horse_id: x.horse_id, runner_number: x.runner_number, name: x.name,
      is_scratched: x.is_scratched, jockey: x.jockey, driver: x.driver, driver_name: x.driver_name,
      trainer: x.trainer, trainer_name: x.trainer_name,
      barrier: x.barrier ?? x.gate ?? x.barrier_number ?? null,
      weight: x.weight ?? x.handicap_weight ?? x.jockey_weight ?? null,
      silk_url_64x64: x.silk_url_64x64, silk_url_128x128: x.silk_url_128x128,
      result: rmap.get(String(x.runner_number)) || null
    }))
  };
}
// Best-guess Viz media-pool key for a horse's silk: lowercase, spaces/dashes
// become a single hyphen, anything else invalid gets stripped. e.g.
// "Rock 'n' Roll Star" -> "rock-n-roll-star_128x128".
// UNCONFIRMED against the real Viz asset library — the producer UI lets this
// be overridden per selection before export.
function silkSlug(horseName) {
  const base = String(horseName || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base ? `${base}_128x128` : "";
}
function xmlEscape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
// ---------- KV read/write ----------
async function getShow(env) {
  const raw = await env.SELECTIONS_KV.get(SHOW_KEY);
  return raw ? JSON.parse(raw) : null;
}
async function setShow(env, show) {
  await env.SELECTIONS_KV.put(SHOW_KEY, JSON.stringify(show));
}
function selectionKey(eventId, presenterId) {
  return `selection:${eventId}:${presenterId}`;
}
async function getAllSelections(env) {
  const list = await env.SELECTIONS_KV.list({ prefix: "selection:" });
  const out = [];
  for (const k of list.keys) {
    const raw = await env.SELECTIONS_KV.get(k.name);
    if (raw) out.push(JSON.parse(raw));
  }
  return out;
}
async function clearAllSelections(env) {
  const list = await env.SELECTIONS_KV.list({ prefix: "selection:" });
  await Promise.all(list.keys.map(k => env.SELECTIONS_KV.delete(k.name)));
}
// ---------- Viz Trio XML export ----------
function buildElementXml(env, sel, elementId) {
  const description = `${sel.presenterName.toUpperCase()}'S SELECTION/${sel.silkSlug}/${sel.horseName.toUpperCase()}/T: ${sel.trainerName.toUpperCase()}/${sel.headshotKey}/${sel.runnerNumber}/0`;
  const data = {
    "001": `${sel.presenterFirst.toUpperCase()}'S SELECTION`,
    "002": `IMAGE*VizRT/scene/Trio/Silks/${sel.silkSlug}`,
    "100": String(sel.runnerNumber),
    "200": sel.horseName.toUpperCase(),
    "300": `T: ${sel.trainerName.toUpperCase()}`,
    "401": `IMAGE*VizRT/Images/Headshots/${sel.headshotKey}`
  };
  const payloadXml =
    `<payload xmlns="http://www.vizrt.com/types">` +
    `<field name="002"><value><entry xmlns="http://www.w3.org/2005/Atom"><content type="application/vnd.vizrt.viz.image">${xmlEscape(data["002"])}</content></entry></value></field>` +
    `<field name="001"><value>${xmlEscape(data["001"])}</value></field>` +
    `<field name="100"><value>${xmlEscape(data["100"])}</value></field>` +
    `<field name="200"><value>${xmlEscape(data["200"])}</value></field>` +
    `<field name="300"><value>${xmlEscape(data["300"])}</value></field>` +
    `<field name="400"><field name="active"><value>0</value></field></field>` +
    `<field name="401"><value><entry xmlns="http://www.w3.org/2005/Atom"><content type="application/vnd.vizrt.viz.image">${xmlEscape(data["401"])}</content></entry></value></field>` +
    `</payload>`;
  return `<element available="1.00" description="${xmlEscape(description)}" layer="[MAIN]" loaded="1.00" showautodescription="true" take_count="0" name="${elementId}">
\t\t\t\t\t\t\t\t<ref name="master_template">/storage/shows/${env.VIZ_SHOW_ID}/mastertemplates/${env.VIZ_MASTER_TEMPLATE}</ref>
\t\t\t\t\t\t\t\t<entry name="default_alternatives"></entry>
\t\t\t\t\t\t\t\t<entry name="data">
\t\t\t\t\t\t\t\t\t<entry name="001">${xmlEscape(data["001"])}</entry>
\t\t\t\t\t\t\t\t\t<entry name="002">${xmlEscape(data["002"])}</entry>
\t\t\t\t\t\t\t\t\t<entry name="100">${xmlEscape(data["100"])}</entry>
\t\t\t\t\t\t\t\t\t<entry name="200">${xmlEscape(data["200"])}</entry>
\t\t\t\t\t\t\t\t\t<entry name="300">${xmlEscape(data["300"])}</entry>
\t\t\t\t\t\t\t\t\t<entry name="400.active">0</entry>
\t\t\t\t\t\t\t\t\t<entry name="401">${xmlEscape(data["401"])}</entry>
\t\t\t\t\t\t\t\t</entry>
\t\t\t\t\t\t\t\t<entry name="dblink">
\t\t\t\t\t\t\t\t\t<entry name="001"></entry>
\t\t\t\t\t\t\t\t\t<entry name="100"></entry>
\t\t\t\t\t\t\t\t\t<entry name="200"></entry>
\t\t\t\t\t\t\t\t\t<entry name="300"></entry>
\t\t\t\t\t\t\t\t</entry>
\t\t\t\t\t\t\t\t<entry name="settings">
\t\t\t\t\t\t\t\t\t<entry name="tabfields">
\t\t\t\t\t\t\t\t\t\t<entry name="001"></entry>
\t\t\t\t\t\t\t\t\t\t<entry name="002"><entry name="searchtext"></entry></entry>
\t\t\t\t\t\t\t\t\t\t<entry name="100"></entry>
\t\t\t\t\t\t\t\t\t\t<entry name="200"></entry>
\t\t\t\t\t\t\t\t\t\t<entry name="300"></entry>
\t\t\t\t\t\t\t\t\t\t<entry name="400"></entry>
\t\t\t\t\t\t\t\t\t\t<entry name="401"><entry name="searchtext"></entry></entry>
\t\t\t\t\t\t\t\t\t</entry>
\t\t\t\t\t\t\t\t\t<entry name="isfilescript">false</entry>
\t\t\t\t\t\t\t\t\t<entry name="modified">${new Date().toISOString().slice(0, 19)}</entry>
\t\t\t\t\t\t\t\t</entry>
\t\t\t\t\t\t\t\t<entry usage="updating" name="payload_xml">${xmlEscape(payloadXml)}</entry>
\t\t\t\t\t\t\t</element>`;
}
function buildShowXml(env, selections) {
  const byEvent = new Map();
  for (const sel of selections) {
    if (!byEvent.has(sel.eventId)) byEvent.set(sel.eventId, []);
    byEvent.get(sel.eventId).push(sel);
  }
  let elementCounter = 1;
  const groups = [...byEvent.entries()].map(([eventId, raceSelections]) => {
    const groupGuid = crypto.randomUUID().toUpperCase();
    const first = raceSelections[0];
    const raceLabel = `${first.meetingName || ""} RACE ${first.raceNumber} SELECTIONS`.trim();
    const elements = raceSelections.map(sel => {
      const elementId = `${9000 + elementCounter}`;
      elementCounter += 1;
      return buildElementXml(env, sel, elementId);
    }).join("\n");
    return `\t\t\t\t\t\t<group name="{${groupGuid}}" presentation="group" loop="no" description="${xmlEscape(raceLabel)}" available="1.00" take_count="0" loaded="1.00">
${elements}
\t\t\t\t\t\t</group>`;
  }).join("\n");
  return `<archive version="1.0" creator="trio" creator_version="${env.VIZ_CREATOR_VERSION}"><vdom><entry name="storage"><entry name="shows"><entry name="${env.VIZ_SHOW_ID}"><entry name="elements">
${groups}
\t\t\t\t\t</entry></entry></entry></entry></vdom></archive>`;
}
// ---------- Word backup document ----------
function buildWordDoc(selections) {
  const byEvent = new Map();
  for (const sel of selections) {
    if (!byEvent.has(sel.eventId)) byEvent.set(sel.eventId, []);
    byEvent.get(sel.eventId).push(sel);
  }
  const blocks = [...byEvent.values()].map(raceSelections => {
    const first = raceSelections[0];
    const heading = `${(first.meetingName || "").toUpperCase()} RACE ${first.raceNumber}${first.description ? ` &ndash; ${xmlEscape(first.description.toUpperCase())}` : ""} - SELECTIONS`;
    const presenterBlocks = raceSelections.map(sel => `
      <p><b>${xmlEscape(sel.presenterFirst.toUpperCase())}'S SELECTION</b></p>
      <p>${xmlEscape(sel.runnerNumber)}, ${xmlEscape(sel.horseName.toUpperCase())}</p>
      <p>T: ${xmlEscape(sel.trainerName.toUpperCase())}</p>
      <p>&nbsp;</p>`).join("");
    return `<p><b>${heading}</b></p>${presenterBlocks}`;
  }).join("<p>&nbsp;</p>");
  return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>Selections</title>
<style>body{font-family:Calibri,Arial,sans-serif;font-size:12pt;} p{margin:0 0 4pt 0;}</style>
</head>
<body>
${blocks}
</body>
</html>`;
}
// ---------- minimal in-Worker ZIP writer (stored/uncompressed entries) ----------
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function dosDateTime(date) {
  const time = ((date.getHours() & 0x1F) << 11) | ((date.getMinutes() & 0x3F) << 5) | (Math.floor(date.getSeconds() / 2) & 0x1F);
  const dosDate = (((date.getFullYear() - 1980) & 0x7F) << 9) | (((date.getMonth() + 1) & 0xF) << 5) | (date.getDate() & 0x1F);
  return { time, dosDate };
}
// files: [{ name: string, data: Uint8Array }] — all entries stored uncompressed
// (method 0) so no compression library is needed inside the Worker.
function buildZip(files) {
  const encoder = new TextEncoder();
  const { time, dosDate } = dosDateTime(new Date());
  const localParts = [], centralParts = [];
  let offset = 0;
  for (const f of files) {
    const nameBytes = encoder.encode(f.name);
    const data = f.data;
    const crc = crc32(data);
    const size = data.length;
    const lh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    lh.set(nameBytes, 30);
    localParts.push(lh, data);
    const ch = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    ch.set(nameBytes, 46);
    centralParts.push(ch);
    offset += lh.length + data.length;
  }
  const centralSize = centralParts.reduce((a, p) => a + p.length, 0);
  const centralOffset = offset;
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralOffset, true);
  const out = new Uint8Array(offset + centralSize + end.length);
  let pos = 0;
  for (const p of localParts) { out.set(p, pos); pos += p.length; }
  for (const p of centralParts) { out.set(p, pos); pos += p.length; }
  out.set(end, pos);
  return out;
}
// ---------- routing ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/api/health") return jsonResponse({ ok: true, service: "presenter-selections" });
      if (path === "/api/presenters") return jsonResponse({ presenters: PRESENTERS });
      if (path === "/api/meetings") {
        const date = cleanDate(url.searchParams.get("date"));
        if (!date) return jsonResponse({ error: "date required YYYY-MM-DD" }, 400);
        const country = (url.searchParams.get("country") || "NZ").toUpperCase();
        const category = (url.searchParams.get("category") || "T").toUpperCase() === "H" ? "H" : "T";
        return jsonResponse(await meetingsFor(date, country, category));
      }
      if (path.startsWith("/api/event/")) {
        const id = cleanUUID(path.slice("/api/event/".length));
        if (!id) return jsonResponse({ error: "invalid event id" }, 400);
        return jsonResponse(compactEvent(await eventById(id)));
      }
      if (path === "/api/show" && request.method === "POST") {
        const body = await request.json();
        if (!body?.date || !Array.isArray(body?.races) || !body.races.length) {
          return jsonResponse({ error: "date and a non-empty races[] are required" }, 400);
        }
        for (const r of body.races) {
          if (!r?.event_id || !r?.race_number || !r?.meeting_name) {
            return jsonResponse({ error: "each race needs event_id, race_number and meeting_name" }, 400);
          }
        }
        await setShow(env, body);
        await clearAllSelections(env);
        return jsonResponse({ ok: true });
      }
      if (path === "/api/show" && request.method === "GET") {
        const show = await getShow(env);
        return jsonResponse({ show });
      }
      if (path === "/api/selection" && request.method === "POST") {
        const body = await request.json();
        const required = ["presenterId", "eventId", "raceNumber", "meetingName", "runnerNumber", "horseName", "trainerName"];
        for (const f of required) {
          if (body?.[f] === undefined || body?.[f] === null || body?.[f] === "") {
            return jsonResponse({ error: `${f} required` }, 400);
          }
        }
        const presenter = PRESENTERS.find(p => p.id === body.presenterId);
        if (!presenter) return jsonResponse({ error: "unknown presenterId" }, 400);
        const sel = {
          presenterId: presenter.id,
          presenterName: presenter.name,
          presenterFirst: presenter.first,
          headshotKey: presenter.headshotKey,
          eventId: String(body.eventId),
          raceNumber: Number(body.raceNumber),
          meetingName: String(body.meetingName),
          description: body.description ? String(body.description) : "",
          runnerNumber: String(body.runnerNumber),
          horseName: String(body.horseName),
          trainerName: String(body.trainerName),
          jockeyName: body.jockeyName ? String(body.jockeyName) : "",
          silkSlug: body.silkSlug ? String(body.silkSlug) : silkSlug(body.horseName),
          silkImageUrl: body.silkImageUrl ? String(body.silkImageUrl) : ""
        };
        await env.SELECTIONS_KV.put(selectionKey(sel.eventId, sel.presenterId), JSON.stringify(sel));
        return jsonResponse({ ok: true, selection: sel });
      }
      if (path === "/api/selection/silk" && request.method === "POST") {
        const body = await request.json();
        if (!body?.eventId || !body?.presenterId || !body?.silkSlug) {
          return jsonResponse({ error: "eventId, presenterId and silkSlug required" }, 400);
        }
        const key = selectionKey(String(body.eventId), body.presenterId);
        const raw = await env.SELECTIONS_KV.get(key);
        if (!raw) return jsonResponse({ error: "selection not found" }, 404);
        const sel = JSON.parse(raw);
        sel.silkSlug = String(body.silkSlug);
        await env.SELECTIONS_KV.put(key, JSON.stringify(sel));
        return jsonResponse({ ok: true, selection: sel });
      }
      if (path === "/api/selections" && request.method === "GET") {
        const selections = await getAllSelections(env);
        return jsonResponse({ selections });
      }
      if (path === "/api/export/xml") {
        const selections = await getAllSelections(env);
        const show = await getShow(env);
        if (!selections.length) return jsonResponse({ error: "no selections yet" }, 400);
        const xml = buildShowXml(env, selections);
        return new Response(xml, {
          headers: {
            "content-type": "application/xml; charset=utf-8",
            "content-disposition": `attachment; filename="selections-${show?.date || "export"}.xml"`
          }
        });
      }
      if (path === "/api/export/doc") {
        const selections = await getAllSelections(env);
        const show = await getShow(env);
        if (!selections.length) return jsonResponse({ error: "no selections yet" }, 400);
        const html = buildWordDoc(selections);
        return new Response(html, {
          headers: {
            "content-type": "application/msword; charset=utf-8",
            "content-disposition": `attachment; filename="selections-${show?.date || "export"}.doc"`
          }
        });
      }
      // --- Producer: bulk-download every selected horse's silk PNG as a .zip ---
      if (path === "/api/export/silks") {
        const selections = await getAllSelections(env);
        if (!selections.length) return jsonResponse({ error: "no selections yet" }, 400);
        const bySlug = new Map();
        for (const sel of selections) {
          if (sel.silkSlug && !bySlug.has(sel.silkSlug)) bySlug.set(sel.silkSlug, sel);
        }
        const files = [];
        const errors = [];
        for (const [slug, sel] of bySlug) {
          if (!sel.silkImageUrl) { errors.push(`${sel.horseName}: no silk image URL captured`); continue; }
          try {
            const r = await fetch(sel.silkImageUrl);
            if (!r.ok) { errors.push(`${sel.horseName}: HTTP ${r.status} fetching silk`); continue; }
            const data = new Uint8Array(await r.arrayBuffer());
            files.push({ name: `${slug}.png`, data });
          } catch (e) {
            errors.push(`${sel.horseName}: ${e.message}`);
          }
        }
        if (!files.length) return jsonResponse({ error: "no silk images could be downloaded", details: errors }, 502);
        const zipBytes = buildZip(files);
        const show = await getShow(env);
        return new Response(zipBytes, {
          headers: {
            "content-type": "application/zip",
            "content-disposition": `attachment; filename="silks-${show?.date || "export"}.zip"`,
            ...(errors.length ? { "x-silk-warnings": encodeURIComponent(errors.join(" | ")) } : {})
          }
        });
      }
      return env.ASSETS.fetch(request);
    } catch (err) {
      return jsonResponse({ error: err?.message || String(err), upstream: err?.upstream }, err?.status || 502);
    }
  }
};
