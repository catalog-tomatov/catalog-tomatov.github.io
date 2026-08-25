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
