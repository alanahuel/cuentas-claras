import type { Invoice } from "./invoices/types";
interface Draft {key: string; userId: string; payload: Invoice}
// Only unsubmitted drafts are stored locally, namespaced by authenticated account.
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("cuentas-drafts", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("drafts", { keyPath: "key" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function drafts(userId: string): Promise<Draft[]> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("drafts");
    const req = tx.objectStore("drafts").getAll();
    req.onsuccess = () =>
      resolve((req.result as Draft[]).filter((x) => x.userId === userId));
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}
export async function saveDraft(userId: string, payload: Invoice): Promise<void> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("drafts", "readwrite");
    tx.objectStore("drafts").put({
      key: userId + ":" + payload.request_id,
      userId,
      payload,
    });
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}
export async function removeDraft(key: string): Promise<void> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("drafts", "readwrite");
    tx.objectStore("drafts").delete(key);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}
export async function clearDrafts(userId: string): Promise<void> {
  for (const draft of await drafts(userId)) await removeDraft(draft.key);
}
