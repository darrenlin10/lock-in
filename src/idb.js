// Tiny IndexedDB key → Blob store for background images (uploaded or
// Gemini-generated). Falls back to memory when IndexedDB is unavailable
// (private windows, blocked storage), so the session still works.

const DB_NAME = 'lock-in';
const STORE = 'assets';
const memory = new Map();
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function putAsset(id, blob) {
  memory.set(id, blob);
  const db = await open();
  if (!db) return false;
  try {
    await tx(db, 'readwrite', (s) => s.put(blob, id));
    return true;
  } catch {
    return false;
  }
}

export async function getAsset(id) {
  if (memory.has(id)) return memory.get(id);
  const db = await open();
  if (!db) return null;
  try {
    const blob = await tx(db, 'readonly', (s) => s.get(id));
    if (blob) memory.set(id, blob);
    return blob || null;
  } catch {
    return null;
  }
}

export async function deleteAsset(id) {
  memory.delete(id);
  const db = await open();
  if (!db) return;
  try {
    await tx(db, 'readwrite', (s) => s.delete(id));
  } catch {
    /* ignore */
  }
}

export async function clearAssets() {
  memory.clear();
  const db = await open();
  if (!db) return;
  try {
    await tx(db, 'readwrite', (s) => s.clear());
  } catch {
    /* ignore */
  }
}
