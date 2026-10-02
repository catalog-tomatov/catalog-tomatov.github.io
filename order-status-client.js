import { initFirebase, ensureAnonymousAuth, getFirebaseUser } from "./firebase-client.js?v=20260930-sync16";

const STATUS_SDK_URL = "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";
const connections = new Map();
const RETRY_DELAY = 60000;
let statusSdkPromise;
const normalizedId = value => String(value || "").trim().replace(/^#/, "");
const connectionKey = (seasonId, orderId) => `${seasonId}|${normalizedId(orderId)}`;

function setHealthy(entry, healthy) {
  if (entry.healthy === healthy) return;
  entry.healthy = healthy;
  entry.onHealth?.(healthy);
}

export function validateOrderStatusDocument(data, entry) {
  if (!data || data.source !== "appscript_order_status" ||
      String(data.seasonId) !== entry.seasonId || normalizedId(data.orderId) !== normalizedId(entry.orderId) ||
      String(data.generation) !== entry.stateId ||
      !["unpaid", "debt", "paid", "issued"].includes(data.status) ||
      !Number.isFinite(data.sourceVersion) || data.sourceVersion <= 0) return false;
  return ["total", "prepayment", "debt"].every(field => Number.isFinite(data[field]) && data[field] >= 0);
}

async function linkStatus(apiUrl, payload) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(apiUrl, { method: "POST", cache: "no-store",
      body: JSON.stringify({ action: "order_status_link", ...payload }), signal: controller.signal });
    const result = await response.json();
    if (!response.ok || result?.success !== true) {
      throw Object.assign(new Error(result?.message || "Realtime статуса недоступен"),
        { code: result?.error || "ORDER_STATUS_UNAVAILABLE" });
    }
    return result;
  } finally { window.clearTimeout(timer); }
}

export function closeOrderStatus(seasonId, orderId) {
  const key = connectionKey(seasonId, orderId);
  const entry = connections.get(key);
  if (!entry) return;
  entry.closed = true;
  setHealthy(entry, false);
  entry.unsubscribe?.();
  connections.delete(key);
}

export function closeAllOrderStatuses() {
  for (const entry of [...connections.values()]) closeOrderStatus(entry.seasonId, entry.orderId);
}

export function isOrderStatusHealthy(seasonId, orderId) {
  const entry = connections.get(connectionKey(seasonId, orderId));
  return Boolean(entry?.healthy && !entry.closed && !entry.failed &&
    entry.uid === getFirebaseUser()?.uid && navigator.onLine !== false);
}

export async function connectOrderStatus(options) {
  const key = connectionKey(options.seasonId, options.orderId);
  const identity = JSON.stringify([options.phone, options.createdAt, options.requestId, options.ownerIdentity, options.chatToken || ""]);
  let entry = connections.get(key);
  if (entry?.identity === identity && entry.uid === getFirebaseUser()?.uid) {
    if (entry.pending) return entry.pending;
    if (!entry.failed) return true;
    if (Date.now() - entry.failedAt < RETRY_DELAY) return false;
  }
  closeOrderStatus(options.seasonId, options.orderId);
  entry = { ...options, identity, seasonId: String(options.seasonId), orderId: String(options.orderId),
    healthy: false, closed: false, failed: false, uid: getFirebaseUser()?.uid || "", lastVersion: 0 };
  connections.set(key, entry);
  const fail = error => {
    if (entry.closed || connections.get(key) !== entry) return;
    entry.failed = true;
    entry.failedAt = Date.now();
    setHealthy(entry, false);
    entry.onError?.(error);
  };
  entry.pending = (async () => {
    const [{ db }] = await Promise.all([initFirebase(), ensureAnonymousAuth()]);
    const user = getFirebaseUser();
    if (!user) throw new Error("Нет сессии Firebase");
    entry.uid = user.uid;
    const result = await linkStatus(options.apiUrl, {
      orderId: entry.orderId, seasonId: entry.seasonId, phone: options.phone,
      createdAt: options.createdAt || "", requestId: options.requestId || "",
      chatToken: options.chatToken || "",
      firebaseIdToken: await user.getIdToken(),
    });
    if (entry.closed || connections.get(key) !== entry) return false;
    if (String(result.seasonId) !== entry.seasonId || normalizedId(result.orderId) !== normalizedId(entry.orderId) ||
        String(result.uid) !== user.uid || !/^[A-Za-z0-9_-]{20,160}$/.test(result.stateId || "")) {
      throw new Error("Realtime вернул доступ к другому заказу");
    }
    entry.stateId = result.stateId;
    statusSdkPromise ||= import(STATUS_SDK_URL);
    const sdk = await statusSdkPromise;
    if (entry.closed || connections.get(key) !== entry) return false;
    const base = `seasons/${entry.seasonId}/orderStates/${entry.stateId}`;
    const viewer = await sdk.getDoc(sdk.doc(db, `${base}/viewers/${user.uid}`));
    if (entry.closed || connections.get(key) !== entry) return false;
    if (!viewer.exists() || viewer.data().generation !== entry.stateId || viewer.data().uid !== user.uid) {
      throw new Error("Доступ к статусу не подтверждён");
    }
    entry.unsubscribe = sdk.onSnapshot(sdk.doc(db, base), { includeMetadataChanges: true }, snapshot => {
      if (entry.closed || connections.get(key) !== entry || entry.uid !== getFirebaseUser()?.uid) return;
      // A cache hit or absent Firebase document never proves Sheets deletion.
      if (snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) {
        setHealthy(entry, false);
        return;
      }
      if (!snapshot.exists()) {
        setHealthy(entry, false);
        entry.failed = true;
        entry.failedAt = Date.now();
        return;
      }
      const data = snapshot.data();
      if (!validateOrderStatusDocument(data, entry)) { setHealthy(entry, false); return; }
      entry.failed = false;
      setHealthy(entry, true);
      if (data.sourceVersion <= entry.lastVersion) return;
      entry.lastVersion = data.sourceVersion;
      entry.onData?.(data);
    }, fail);
    return true;
  })().catch(error => { fail(error); return false; }).finally(() => { entry.pending = null; });
  return entry.pending;
}

window.addEventListener("offline", () => {
  for (const entry of connections.values()) setHealthy(entry, false);
});
window.tomatoOrderStatus = Object.freeze({ connect: connectOrderStatus, close: closeOrderStatus,
  closeAll: closeAllOrderStatuses, isHealthy: isOrderStatusHealthy });
