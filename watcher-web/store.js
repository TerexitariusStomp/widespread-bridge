// store.js — IndexedDB persistence for watcher-web. Zero deps.
const DB = "widespread-watcher";
const STORES = ["sightings", "kv", "seen"];

let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains("sightings")) d.createObjectStore("sightings", { keyPath: "dedupe" });
      if (!d.objectStoreNames.contains("kv")) d.createObjectStore("kv");
      if (!d.objectStoreNames.contains("seen")) d.createObjectStore("seen", { keyPath: "hash" });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
    t.onerror = () => rej(t.error);
  });
}
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const store = {
  async putSighting(s) { const d = await db(); return req(d.transaction("sightings", "readwrite").objectStore("sightings").put(s)); },
  async allSightings() { const d = await db(); return req(d.transaction("sightings").objectStore("sightings").getAll()); },
  async putKV(k, v) { const d = await db(); return req(d.transaction("kv", "readwrite").objectStore("kv").put(v, k)); },
  async getKV(k) { const d = await db(); return req(d.transaction("kv").objectStore("kv").get(k)); },
  async putSeen(hashes) { const d = await db(); const t = d.transaction("seen", "readwrite"); const os = t.objectStore("seen"); for (const h of hashes) os.put({ hash: h, ts: Date.now() }); return req(t); },
  async getSeen() { const d = await db(); return (await req(d.transaction("seen").objectStore("seen").getAll())).map((x) => x.hash); },
  async clear() { const d = await db(); for (const s of STORES) req(d.transaction(s, "readwrite").objectStore(s).clear()); },
};
