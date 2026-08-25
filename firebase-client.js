import { firebaseConfig } from "./firebase-config.js?v=1";

const FIREBASE_SDK_VERSION = "12.17.1";
const FIREBASE_SDK_BASE =
  `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}`;

let sdkPromise = null;
let initializationPromise = null;
let anonymousAuthPromise = null;
let firebaseApp = null;
let firebaseAuth = null;
let firestoreDb = null;
let firebaseUser = null;

function normalizeFirestorePart(value) {
  const result = String(value || "").trim().replace(/^#/, "");
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(result)) {
    throw new Error("Некорректный номер заказа.");
  }
  return result;
}

function orderDocumentPath(seasonId, orderId) {
  return `seasons/${normalizeFirestorePart(seasonId)}/orders/${normalizeFirestorePart(orderId)}`;
}

function isFirebaseDebugMode() {
  return ["localhost", "127.0.0.1", "[::1]"]
    .includes(window.location.hostname);
}

function loadFirebaseSdk() {
  if (!sdkPromise) {
    sdkPromise = Promise.all([
      import(`${FIREBASE_SDK_BASE}/firebase-app.js`),
      import(`${FIREBASE_SDK_BASE}/firebase-auth.js`),
      import(`${FIREBASE_SDK_BASE}/firebase-firestore.js`),
    ]).then(([appSdk, authSdk, firestoreSdk]) => ({
      appSdk,
      authSdk,
      firestoreSdk,
    }));
  }

  return sdkPromise;
}

export function initFirebase() {
  if (!initializationPromise) {
    initializationPromise = loadFirebaseSdk()
      .then(({ appSdk, authSdk, firestoreSdk }) => {
        firebaseApp = appSdk.getApps().find((app) => app.name === "[DEFAULT]")
          || appSdk.initializeApp(firebaseConfig);
        firebaseAuth = authSdk.getAuth(firebaseApp);
        firestoreDb = firestoreSdk.getFirestore(firebaseApp);

        return {
          app: firebaseApp,
          auth: firebaseAuth,
          db: firestoreDb,
        };
      })
      .catch((error) => {
        initializationPromise = null;
        throw error;
      });
  }

  return initializationPromise;
}

function waitForInitialAuthState(auth, onAuthStateChanged) {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => undefined;

    unsubscribe = onAuthStateChanged(
      auth,
      (user) => {
        unsubscribe();
        resolve(user);
      },
      (error) => {
        unsubscribe();
        reject(error);
      },
    );
  });
}

export function ensureAnonymousAuth() {
  if (!anonymousAuthPromise) {
    anonymousAuthPromise = initFirebase()
      .then(async ({ auth }) => {
        const { authSdk } = await loadFirebaseSdk();
        const existingUser = await waitForInitialAuthState(
          auth,
          authSdk.onAuthStateChanged,
        );

        firebaseUser = existingUser
          || (await authSdk.signInAnonymously(auth)).user;

        return firebaseUser;
      })
      .catch((error) => {
        anonymousAuthPromise = null;
        throw error;
      });
  }

  return anonymousAuthPromise;
}

export function getFirebaseUser() {
  return firebaseAuth ? firebaseAuth.currentUser : firebaseUser;
}

export function getFirebaseUid() {
  return getFirebaseUser()?.uid || null;
}

export function getFirestoreDb() {
  return firestoreDb;
}

async function getFirebaseContext() {
  const [{ db }, user, sdk] = await Promise.all([
    initFirebase(),
    ensureAnonymousAuth(),
    loadFirebaseSdk(),
  ]);
  return { db, user, firestoreSdk: sdk.firestoreSdk };
}

async function postJson(url, payload, timeoutMs = 20000) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const result = await response.json();
    if (!response.ok || !result || result.success !== true) {
      const error = new Error(result?.message || "Firebase-синхронизация недоступна.");
      error.code = result?.error || "FIREBASE_BRIDGE_UNAVAILABLE";
      throw error;
    }
    return result;
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function linkRealtimeOrder({ apiUrl, orderId, chatToken }) {
  const { user } = await getFirebaseContext();
  const firebaseIdToken = await user.getIdToken();
  return postJson(apiUrl, {
    action: "chat_firestore_link",
    orderId,
    chatToken,
    firebaseIdToken,
  }, 30000);
}

function firestoreDate(value, fallback = "") {
  if (value && typeof value.toDate === "function") return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return String(value || fallback || "");
}

function realtimeMessage(documentSnapshot) {
  const data = documentSnapshot.data() || {};
  return {
    messageId: String(data.messageId || documentSnapshot.id),
    orderId: String(data.orderId || ""),
    sender: String(data.sender || "system"),
    type: String(data.type || "text"),
    text: String(data.text || ""),
    attachmentId: String(data.attachmentId || ""),
    attachment: data.attachment || null,
    snapshot: data.snapshot || null,
    clientMessageId: String(data.clientMessageId || ""),
    createdAt: firestoreDate(data.createdAt, data.createdAtIso),
  };
}

function messagePreview(message) {
  if (message.text) return message.text;
  if (message.type === "order_card") return "Карточка заказа";
  if (message.type === "payment_card") return "Реквизиты для оплаты";
  if (message.type === "attachment") return "Вложение";
  return "Сообщение";
}

export async function subscribeRealtimeOrder({ seasonId, orderId, viewer, onData, onError }) {
  const { db, user, firestoreSdk } = await getFirebaseContext();
  const basePath = orderDocumentPath(seasonId, orderId);
  const orderRef = firestoreSdk.doc(db, basePath);
  const messagesQuery = firestoreSdk.query(
    firestoreSdk.collection(db, `${basePath}/messages`),
    firestoreSdk.orderBy("createdAt", "asc"),
  );
  const readRef = firestoreSdk.doc(db, `${basePath}/readStates/${user.uid}`);
  let orderData = null;
  let messages = [];
  let readAt = 0;

  const emit = () => {
    if (!orderData || typeof onData !== "function") return;
    const order = orderData.order || {};
    const incomingSender = viewer === "seller" ? "client" : "seller";
    const unread = messages.filter((message) => (
      message.sender === incomingSender
      && (Date.parse(message.createdAt || "") || 0) > readAt
    )).length;
    const last = messages.length ? messages[messages.length - 1] : null;
    onData({
      success: true,
      seasonId: String(orderData.seasonId || seasonId),
      order,
      summary: {
        chatCreated: Boolean(orderData.chatCreated),
        isActive: Boolean(orderData.isActive),
        contactChannel: String(orderData.contactChannel || ""),
        orderId: order.orderId || orderId,
        status: order.status || orderData.status || "unpaid",
        statusLabel: order.statusLabel || orderData.statusLabel || "",
        total: Number(order.total ?? orderData.total) || 0,
        prepayment: Number(order.prepayment ?? orderData.prepayment) || 0,
        debt: Number(order.debt ?? orderData.debt) || 0,
        unread,
        lastMessage: last ? messagePreview(last) : "Сообщений пока нет",
        lastAt: last?.createdAt || "",
        attachmentBytes: Number(orderData.attachmentBytes) || 0,
        attachmentRemainingBytes: Math.max(1024 * 1024 - (Number(orderData.attachmentBytes) || 0), 0),
      },
      messagesMode: "full",
      messages,
      realtime: true,
    });
  };

  const fail = (error) => {
    if (typeof onError === "function") onError(error);
  };
  const unsubscribers = [
    firestoreSdk.onSnapshot(orderRef, (snapshot) => {
      orderData = snapshot.exists() ? snapshot.data() : null;
      emit();
    }, fail),
    firestoreSdk.onSnapshot(messagesQuery, (snapshot) => {
      messages = snapshot.docs.map(realtimeMessage);
      emit();
    }, fail),
    firestoreSdk.onSnapshot(readRef, (snapshot) => {
      const data = snapshot.exists() ? snapshot.data() : {};
      readAt = Date.parse(firestoreDate(data.readAt, data.readAtIso)) || 0;
      emit();
    }, fail),
  ];
  return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
}

export async function sendRealtimeText({ apiUrl, seasonId, orderId, chatToken, sender, text, messageId }) {
  const { db, user, firestoreSdk } = await getFirebaseContext();
  const safeMessageId = normalizeFirestorePart(messageId);
  const safeOrderId = normalizeFirestorePart(orderId);
  const createdAtIso = new Date().toISOString();
  const message = {
    messageId: safeMessageId,
    seasonId: normalizeFirestorePart(seasonId),
    orderId: safeOrderId,
    sender,
    type: "text",
    text: String(text || "").trim(),
    attachmentId: "",
    attachment: null,
    snapshot: null,
    clientMessageId: safeMessageId,
    createdAt: firestoreSdk.serverTimestamp(),
    createdAtIso,
    authorUid: user.uid,
    source: "firestore",
  };
  if (!message.text || message.text.length > 2000) throw new Error("Некорректный текст сообщения.");
  await firestoreSdk.setDoc(
    firestoreSdk.doc(db, `${orderDocumentPath(seasonId, orderId)}/messages/${safeMessageId}`),
    message,
  );
  const firebaseIdToken = await user.getIdToken();
  void postJson(apiUrl, {
    action: sender === "seller" ? "chat_firestore_seller_notify" : "chat_firestore_notify",
    orderId,
    chatToken,
    messageId: safeMessageId,
    firebaseIdToken,
  }, 30000).catch((error) => console.warn("Firebase message mirror delayed", error));
  return {
    success: true,
    message: {
      ...message,
      createdAt: createdAtIso,
      orderId,
    },
  };
}

export async function markRealtimeRead({ seasonId, orderId, viewer }) {
  const { db, user, firestoreSdk } = await getFirebaseContext();
  await firestoreSdk.setDoc(
    firestoreSdk.doc(db, `${orderDocumentPath(seasonId, orderId)}/readStates/${user.uid}`),
    {
      uid: user.uid,
      viewer,
      readAt: firestoreSdk.serverTimestamp(),
      readAtIso: new Date().toISOString(),
    },
  );
}

window.tomatoRealtime = Object.freeze({
  linkOrder: linkRealtimeOrder,
  subscribeOrder: subscribeRealtimeOrder,
  sendText: sendRealtimeText,
  markRead: markRealtimeRead,
  ready: getFirebaseContext,
});

async function connectFirebaseInBackground() {
  try {
    await initFirebase();
    const user = await ensureAnonymousAuth();

    if (isFirebaseDebugMode()) {
      console.info("Firebase connected");
      console.info("Anonymous UID:", user.uid);
    }
  } catch (error) {
    console.warn(
      "Firebase unavailable. The catalog continues without Firebase.",
      error,
    );
  }
}

void connectFirebaseInBackground();
