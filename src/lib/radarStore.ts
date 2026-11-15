/** Persist a user supplied radar image per map in IndexedDB. */
const DB = "rewind";
const STORE = "radar";

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export async function saveRadar(map: string, blob: Blob): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((res, rej) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(blob, map);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } catch {
    /* storage unavailable */
  }
}
export async function clearRadar(map: string): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((res) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(map);
      tx.oncomplete = () => res();
    });
  } catch {
    /* ignore */
  }
}

export async function loadRadar(map: string): Promise<HTMLImageElement | null> {
  try {
    const db = await open();
    const blob = await new Promise<Blob | undefined>((res, rej) => {
      const r = db.transaction(STORE).objectStore(STORE).get(map);
      r.onsuccess = () => res(r.result as Blob | undefined);
      r.onerror = () => rej(r.error);
    });
    if (!blob) return null;
    return await blobToImage(blob);
  } catch {
    return null;
  }
}

export function blobToImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error("Görsel okunamadı"));
    img.src = url;
  });
}
