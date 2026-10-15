const admin = require("firebase-admin");
const path = require('path');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(require(path.join(__dirname, "../src/config/serviceAccountKey.json"))),
    });
}

const db = admin.firestore();

async function triggerSession() {
    console.log("Triggering session creation in Firestore...");
    await db.collection("whatsapp_sessions").doc("session_0656102030").set({
        command: "create_session",
        status: "waiting_qr",
        label: "Ligne 1 (Principal)",
        phone: "0656102030",
        isDefault: true,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    console.log("Done.");
    process.exit(0);
}

triggerSession();
