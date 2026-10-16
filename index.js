const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const pino = require("pino");
const QRCode = require("qrcode");
const qrcodeTerminal = require("qrcode-terminal");
const axios = require("axios");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { Server } = require("socket.io");

// Firebase Configuration & Endpoints
const WEBHOOK_URL = "https://us-central1-mon-bocadillo-menu.cloudfunctions.net/whatsappWebhook";
const APP_ID = "mon-bocadillo-menu";
const API_KEY = "AIzaSyBcQDTGG0vsKRtK6B233Wuc4YM1_Gta-7Y";

// -------------------------------------------------------------
// 🔥 FIREBASE AUTHENTICATION (CUSTOM TOKEN)
// -------------------------------------------------------------
let currentIdToken = null;
let tokenExpiry = 0;

async function getFirebaseIdToken() {
    if (currentIdToken && Date.now() < tokenExpiry) return currentIdToken;
    try {
        const authRes = await axios.post(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`, {
            email: "bot@mon-bocadillo.com",
            password: "MonBocadilloBot2026!",
            returnSecureToken: true
        });
        currentIdToken = authRes.data.idToken;
        tokenExpiry = Date.now() + (parseInt(authRes.data.expiresIn, 10) * 1000) - 300000;
        return currentIdToken;
    } catch(e) {
        console.error("❌ Firebase Auth Error:", e.response ? e.response.data : e.message);
        return null;
    }
}

// Inject Authorization Header into all Firestore requests automatically!
axios.interceptors.request.use(async (config) => {
    if (config.url && config.url.includes('firestore.googleapis.com')) {
        const token = await getFirebaseIdToken();
        if (token) {
            config.headers = config.headers || {};
            config.headers['Authorization'] = `Bearer ${token}`;
        }
    }
    return config;
});
// -------------------------------------------------------------
// In-Memory Multi-Session Registry
// Key: sessionId -> Value: { id, label, phone, isDefault, status, qrUrl, rawQr, sock, isConnected, connectedPhone }
const sessions = new Map();

// Global Message Deduplication Cache (msgId -> timestamp)
const processedMsgIds = new Map();

// Cache for sent messages to fix '...' sync issue on WhatsApp Web
const sentMessageCache = new Map();

// Persistent LID -> Real Phone mapping cache
const lidMapFile = path.join(__dirname, 'lid_map.json');
let lidMap = {
    "172735028318333": "0661800728",
    "106588857708781": "0661800728"
};
try {
    if (fs.existsSync(lidMapFile)) {
        const loaded = JSON.parse(fs.readFileSync(lidMapFile, 'utf8'));
        lidMap = { ...lidMap, ...loaded };
    }
} catch (e) {}

function saveLidMap() {
    try {
        fs.writeFileSync(lidMapFile, JSON.stringify(lidMap, null, 2), 'utf8');
    } catch (e) {}
}

function normalizeMoroccanPhone(raw) {
    if (!raw) return '';
    const digits = String(raw).replace(/[^\d]/g, '');
    if (digits.startsWith('2126')) return '06' + digits.slice(4);
    if (digits.startsWith('2127')) return '07' + digits.slice(4);
    if (digits.startsWith('2125')) return '05' + digits.slice(4);
    if ((digits.startsWith('6') || digits.startsWith('7')) && digits.length === 9) return '0' + digits;
    if (digits.startsWith('06') || digits.startsWith('07') || digits.startsWith('05')) return digits.slice(0, 10);
    return digits;
}

// Helper: Firestore REST API Update
async function updateFirestoreDoc(docPath, fields) {
    try {
        const fieldPaths = Object.keys(fields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
        const url = `https://firestore.googleapis.com/v1/projects/${APP_ID}/databases/(default)/documents/${docPath}?key=${API_KEY}&${fieldPaths}`;
        
        const formattedFields = {};
        for (const [key, val] of Object.entries(fields)) {
            if (typeof val === 'string') formattedFields[key] = { stringValue: val };
            else if (typeof val === 'number') formattedFields[key] = { integerValue: String(val) };
            else if (typeof val === 'boolean') formattedFields[key] = { booleanValue: val };
            else if (val === null) formattedFields[key] = { nullValue: null };
        }

        await axios.patch(url, { fields: formattedFields }, { headers: { "Content-Type": "application/json" }, timeout: 8000 });
    } catch (e) {
        // Fallback create/merge if document does not exist yet
        try {
            const postUrl = `https://firestore.googleapis.com/v1/projects/${APP_ID}/databases/(default)/documents/${docPath}?key=${API_KEY}`;
            const formattedFields = {};
            for (const [key, val] of Object.entries(fields)) {
                if (typeof val === 'string') formattedFields[key] = { stringValue: val };
                else if (typeof val === 'number') formattedFields[key] = { integerValue: String(val) };
                else if (typeof val === 'boolean') formattedFields[key] = { booleanValue: val };
                else if (val === null) formattedFields[key] = { nullValue: null };
            }
            await axios.patch(postUrl, { fields: formattedFields }, { headers: { "Content-Type": "application/json" }, timeout: 8000 });
        } catch (err2) {}
    }
}

// Update individual session doc in Firestore
async function updateSessionDoc(sessionId, fields) {
    await updateFirestoreDoc(`artifacts/${APP_ID}/public/data/whatsapp_sessions/${sessionId}`, fields);
}

// -------------------------------------------------------------
// 🚀 Session Manager: Initialize or Connect a Specific Line
// -------------------------------------------------------------
async function startSession(sessionId, initialData = {}) {
    if (sessions.has(sessionId) && sessions.get(sessionId).sock) {
        // Already running
        return sessions.get(sessionId);
    }

    const sessionObj = {
        id: sessionId,
        label: initialData.label || `Ligne WhatsApp (${sessionId})`,
        phone: initialData.phone || '',
        isDefault: !!initialData.isDefault,
        status: 'initializing',
        qrUrl: null,
        rawQr: null,
        sock: null,
        isConnected: false,
        connectedPhone: initialData.phone || null
    };
    sessions.set(sessionId, sessionObj);

    const authFolder = path.join(__dirname, "auth_sessions", sessionId);
    if (!fs.existsSync(authFolder)) {
        fs.mkdirSync(authFolder, { recursive: true });
    }

    try {
        const { state, saveCreds } = await useMultiFileAuthState(authFolder);
        const { version } = await fetchLatestBaileysVersion();

        console.log(`\n▶️ Démarrage de la session [${sessionId}] - "${sessionObj.label}" (Baileys v${version.join('.')})`);

        const sock = makeWASocket({
            version,
            logger: pino({ level: "silent" }),
            printQRInTerminal: false,
            auth: state,
            browser: [`Mon Bocadillo (${sessionObj.label})`, "Chrome", "1.0.0"],
            syncFullHistory: false,
            // Ajout de getMessage pour corriger l'erreur "En attente de ce message"
            getMessage: async (key) => {
                if (sentMessageCache.has(key.id)) {
                    return sentMessageCache.get(key.id);
                }
                return {
                    conversation: '...'
                };
            }
        });

        sessionObj.sock = sock;

        // Override sendMessage to cache messages for getMessage (fixes '...' sync bug)
        const originalSendMessage = sock.sendMessage;
        sock.sendMessage = async (...args) => {
            const sentMsg = await originalSendMessage.apply(sock, args);
            if (sentMsg && sentMsg.key && sentMsg.message) {
                if (sentMessageCache.size > 1000) {
                    const firstKey = sentMessageCache.keys().next().value;
                    sentMessageCache.delete(firstKey);
                }
                sentMessageCache.set(sentMsg.key.id, sentMsg.message);
            }
            return sentMsg;
        };

        sock.ev.on("creds.update", saveCreds);

        sock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                sessionObj.rawQr = qr;
                sessionObj.status = 'waiting_qr';
                sessionObj.isConnected = false;

                console.log(`\n======================================================`);
                console.log(`📱 SCANNEZ CE QR CODE AVEC WHATSAPP : "${sessionObj.label}" (${sessionId})`);
                console.log(`======================================================\n`);
                try {
                    qrcodeTerminal.generate(qr, { small: true });
                } catch (qrErr) {}

                try {
                    sessionObj.qrUrl = await QRCode.toDataURL(qr, { margin: 2, scale: 8 });
                    await updateSessionDoc(sessionId, {
                        status: "waiting_qr",
                        qrUrl: sessionObj.qrUrl,
                        updatedAt: Date.now()
                    });
                    console.log(`📲 [QR CODE PRÊT] Ligne "${sessionObj.label}" (${sessionId}) -> Scannez sur le Hub Web ou dans la Caisse`);
                } catch (e) {
                    console.error(`Erreur génération QR pour ${sessionId}:`, e.message);
                }
            }

            if (connection === "close") {
                sessionObj.isConnected = false;
                sessionObj.status = 'disconnected';
                const statusCode = (lastDisconnect?.error)?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                
                console.log(`⚠️ Ligne "${sessionObj.label}" (${sessionId}) fermée (Code: ${statusCode}). Reconnexion: ${shouldReconnect}`);

                await updateSessionDoc(sessionId, {
                    status: "disconnected",
                    qrUrl: null,
                    updatedAt: Date.now()
                });

                if (shouldReconnect) {
                    setTimeout(() => {
                        sessionObj.sock = null;
                        startSession(sessionId, sessionObj);
                    }, 4000);
                } else {
                    console.log(`❌ Session "${sessionObj.label}" déconnectée définitivement (Logout).`);
                    try {
                        fs.rmSync(authFolder, { recursive: true, force: true });
                    } catch (e) {}
                }
            } else if (connection === "open") {
                sessionObj.isConnected = true;
                sessionObj.status = 'connected';
                sessionObj.qrUrl = null;

                const phoneJid = sock.user?.id || '';
                const detectedDigits = phoneJid.split(':')[0].split('@')[0];
                let formattedPhone = detectedDigits;
                if (formattedPhone.startsWith('212')) {
                    formattedPhone = '0' + formattedPhone.slice(3);
                }
                
                sessionObj.connectedPhone = formattedPhone;
                if (!sessionObj.phone) sessionObj.phone = formattedPhone;

                console.log(`\n🎉 ==============================================`);
                console.log(`✅ LIGNE CONNECTÉE : "${sessionObj.label}"`);
                console.log(`📞 Numéro Actif   : ${sessionObj.connectedPhone} (${detectedDigits})`);
                console.log(`⭐️ Principal      : ${sessionObj.isDefault ? 'OUI (Par défaut)' : 'NON'}`);
                console.log(`==============================================\n`);

                await updateSessionDoc(sessionId, {
                    status: "connected",
                    phone: sessionObj.phone || formattedPhone,
                    connectedPhone: formattedPhone,
                    qrUrl: null,
                    command: "connected",
                    updatedAt: Date.now()
                });

                // Si c'est la ligne par défaut ou unique, mettre à jour aussi le status global
                if (sessionObj.isDefault || sessions.size === 1) {
                    await updateFirestoreDoc(`artifacts/${APP_ID}/public/data/settings/whatsapp_bot`, {
                        status: "connected",
                        connectedPhone: formattedPhone,
                        phone: sessionObj.phone || formattedPhone,
                        sessionId: sessionId,
                        lastUpdated: Date.now()
                    });
                }
            }
        });

        // Cache des messages récents envoyés par le bot pour éviter toute boucle / écho
        const recentBotReplies = new Map(); // text -> timestamp

        // -------------------------------------------------------------
        // 💬 ÉCOUTE DES MESSAGES ENTRANT SUR CETTE LIGNE PRÉCISE (IA)
        // -------------------------------------------------------------
        sock.ev.on("messages.upsert", async ({ messages, type }) => {
            if (type !== "notify") return;

            // Nettoyage périodique des caches
            const now = Date.now();
            for (const [txt, ts] of recentBotReplies.entries()) {
                if (now - ts > 60000) recentBotReplies.delete(txt);
            }
            for (const [mid, ts] of processedMsgIds.entries()) {
                if (now - ts > 600000) processedMsgIds.delete(mid); // Garder 10 min
            }

            for (const msg of messages) {
                if (!msg.message || msg.key.fromMe) continue;

                // 🛑 Déduplication absolue : Empêcher le traitement multiple du même message
                const msgId = msg.key?.id;
                if (msgId) {
                    if (processedMsgIds.has(msgId)) {
                        console.log(`⏩ [DEDUPLICATION] Message "${msgId}" déjà traité sur [${sessionObj.label}], ignoré.`);
                        continue;
                    }
                    processedMsgIds.set(msgId, Date.now());
                }

                const senderJid = msg.key.remoteJid;
                if (!senderJid || senderJid.includes("@g.us")) continue; // Ignorer les groupes

                // Ignorer si le message vient du bot lui-même
                const botUserJid = sock.user?.id?.split(':')[0]?.split('@')[0] || '';
                const rawLid = senderJid.includes('@lid') ? senderJid.split('@')[0] : null;
                let senderPhone = senderJid.split("@")[0];

                if (msg.key.senderPn) {
                    const p = normalizeMoroccanPhone(msg.key.senderPn.split('@')[0]);
                    if (p && !p.startsWith('172') && !p.startsWith('106') && p.length <= 12) {
                        senderPhone = p;
                        if (rawLid) {
                            lidMap[rawLid] = p;
                            saveLidMap();
                        }
                    }
                } else if (msg.key.participant && !msg.key.participant.includes('@lid')) {
                    const p = normalizeMoroccanPhone(msg.key.participant.split('@')[0]);
                    if (p && !p.startsWith('172') && !p.startsWith('106') && p.length <= 12) {
                        senderPhone = p;
                        if (rawLid) {
                            lidMap[rawLid] = p;
                            saveLidMap();
                        }
                    }
                }

                if (rawLid && (senderPhone.includes('@lid') || senderPhone === rawLid || senderPhone.length > 11)) {
                    if (lidMap[rawLid]) {
                        senderPhone = lidMap[rawLid];
                    }
                }

                senderPhone = normalizeMoroccanPhone(senderPhone);
                const senderName = msg.pushName || senderPhone;
                if (botUserJid && (senderPhone === botUserJid || senderJid.includes(botUserJid))) {
                    continue;
                }

                // Détection de localisation native WhatsApp (Punaise GPS)
                const locMsg = msg.message.locationMessage || msg.message.liveLocationMessage;
                const isLocation = !!locMsg;
                let locLat = null;
                let locLng = null;
                if (locMsg) {
                    locLat = locMsg.degreesLatitude ?? locMsg.latitude;
                    locLng = locMsg.degreesLongitude ?? locMsg.longitude;
                }

                const text = (msg.message.conversation || 
                             msg.message.extendedTextMessage?.text || 
                             msg.message.imageMessage?.caption || 
                             msg.message.videoMessage?.caption || 
                             (isLocation ? `[LOCATION: ${locLat}, ${locLng}]` : '')).trim();

                if (!text && !isLocation) continue;

                // Ignorer si ce texte correspond exactement à une réponse récente du bot (écho Baileys)
                if (text && recentBotReplies.has(text)) {
                    console.log(`⏩ [Ligne: ${sessionObj.label}] Message ignoré (écho bot détecté)`);
                    continue;
                }

                console.log(`\n📩 [Ligne: ${sessionObj.label}] Message de ${senderName} (${senderJid}): "${isLocation ? `📍 Localisation [${locLat}, ${locLng}]` : text}"`);

                // Auto-reply pour les salutations basiques
                const lowerText = text.toLowerCase().trim().replace(/[^a-z ]/g, '');
                const greetings = ["salam", "salam alikom", "salam rebo", "salam khoya", "bonjour", "salut"];
                
                if (greetings.includes(lowerText)) {
                    const welcomeMsg = "Wa alikom salam, marhba bik f Mon Bocadillo! 🥪 Ana f lkhidma dyalak, t9dar tdowez la commande w ana ghadi ntkalaf biha.";
                    const voilaMsg = "Voila le menu dyalna 👇:";
                    console.log(`🤖 [Auto-Reply Rapide] Salutation détectée, envoi du message de bienvenue et du menu...`);
                    
                    recentBotReplies.set(welcomeMsg, Date.now());
                    recentBotReplies.set(voilaMsg, Date.now());
                    
                    try {
                        // 1. Message de bienvenue
                        await sock.sendMessage(senderJid, { text: welcomeMsg });
                        await new Promise(r => setTimeout(r, 1000));
                        
                        // 2. Annonce du menu
                        await sock.sendMessage(senderJid, { text: voilaMsg });
                        await new Promise(r => setTimeout(r, 1000));

                        // 3. Envoi des images du menu
                        const assetsDir = path.join(__dirname, 'assets');
                        const menuCards = [
                            { file: 'menu_1.png', caption: '🍔 *Bocadillos & Tortillias*' },
                            { file: 'menu_2.png', caption: '🍟 *Sandwiches, Formules & Extras*' },
                            { file: 'menu_3.png', caption: '🥤 *Boissons Fraîches*' }
                        ];

                        for (const card of menuCards) {
                            const imgPath = path.join(assetsDir, card.file);
                            if (fs.existsSync(imgPath)) {
                                try {
                                    await sock.sendMessage(senderJid, {
                                        image: fs.readFileSync(imgPath),
                                        caption: card.caption
                                    });
                                    await new Promise(r => setTimeout(r, 800));
                                } catch (cardErr) {
                                    console.error(`❌ Erreur envoi image ${card.file}:`, cardErr.message);
                                }
                            }
                        }
                    } catch(e) {}
                    
                    continue; // On arrête là pour ne pas faire appel au Webhook AI
                }

                // ==========================================
                // INTERCEPTER LA LOCALISATION POUR LES COMMANDES SANS GPS
                // ==========================================
                if (isLocation && locLat && locLng) {
                    console.log(`📍 Traitement de la localisation pour ${senderPhone}...`);
                    try {
                        const url = `https://firestore.googleapis.com/v1/projects/${APP_ID}/databases/(default)/documents/artifacts/${APP_ID}/public/data:runQuery?key=${API_KEY}`;
                        const query = {
                            structuredQuery: {
                                from: [{ collectionId: "orders" }],
                                where: {
                                    compositeFilter: {
                                        op: "AND",
                                        filters: [
                                            { fieldFilter: { field: { fieldPath: "phone" }, op: "EQUAL", value: { stringValue: senderPhone } } },
                                            { fieldFilter: { field: { fieldPath: "status" }, op: "EQUAL", value: { stringValue: "pending" } } }
                                        ]
                                    }
                                },
                                orderBy: [{ field: { fieldPath: "createdAt" }, direction: "DESCENDING" }],
                                limit: 1
                            }
                        };
                        const res = await axios.post(url, query, { headers: { "Content-Type": "application/json" } });
                        
                        if (res.data && res.data.length > 0 && res.data[0].document) {
                            const docName = res.data[0].document.name;
                            const fields = res.data[0].document.fields;
                            
                            // Si la commande n'a pas de lat/lng
                            if (!fields.lat || !fields.lat.doubleValue) {
                                const orderId = docName.split('/orders/')[1];
                                console.log(`✅ Mise à jour de la commande ${orderId} avec le GPS`);
                                await updateFirestoreDoc(`artifacts/${APP_ID}/public/data/orders/${orderId}`, {
                                    lat: locLat,
                                    lng: locLng
                                });
                                
                                const replyMsg = "✅ Chokran! Localisation (GPS) t-sjjlat b naja7 w l'livreur ghadi yji l3ndk.";
                                recentBotReplies.set(replyMsg, Date.now());
                                await sock.sendMessage(senderJid, { text: replyMsg });
                                continue; // Stop further processing
                            }
                        }
                    } catch(err) {
                        console.error("❌ Erreur traitement localisation:", err.message);
                    }
                }
                // ==========================================

                try {
                    // Transmettre au Webhook IA avec l'identifiant exact de la ligne
                    const payload = {
                        event: "messages.upsert",
                        instance: sessionId,
                        sessionId: sessionId,
                        sessionLabel: sessionObj.label,
                        receiverPhone: sessionObj.phone || sessionObj.connectedPhone || '',
                        from: senderPhone,
                        phone: senderPhone,
                        sender: senderPhone,
                        body: text,
                        text: text,
                        lat: locLat,
                        lng: locLng,
                        latitude: locLat,
                        longitude: locLng,
                        pushName: senderName,
                        pushname: senderName,
                        data: {
                            from: senderPhone,
                            phone: senderPhone,
                            sender: senderPhone,
                            body: text,
                            text: text,
                            lat: locLat,
                            lng: locLng,
                            latitude: locLat,
                            longitude: locLng,
                            type: isLocation ? 'location' : 'chat',
                            address: locMsg?.name || locMsg?.address || '',
                            pushName: senderName,
                            pushname: senderName,
                            key: msg.key,
                            message: msg.message,
                            messageTimestamp: msg.messageTimestamp
                        }
                    };

                    // ⏱️ Timeout 30s avec retry
                    let res = null;
                    let lastErr = null;
                    for (let attempt = 1; attempt <= 2; attempt++) {
                        try {
                            res = await axios.post(WEBHOOK_URL, payload, {
                                headers: { "Content-Type": "application/json" },
                                timeout: 35000
                            });
                            break; // Succès -> sortir de la boucle
                        } catch (retryErr) {
                            lastErr = retryErr;
                            if (attempt < 2) {
                                console.warn(`⚠️ Webhook tentative ${attempt} échouée, retry dans 1s...`, retryErr.message);
                                await new Promise(r => setTimeout(r, 1000));
                            }
                        }
                    }

                    if (!res) throw lastErr;

                    console.log(`🤖 [IA Webhook HTTP ${res.status}] pour ${senderName} sur [${sessionObj.label}]`);

                    // 🔥 Réponse directe au client sur la même ligne WhatsApp !
                    const rawReplyText = (res.data?.reply || '').trim();
                    if (rawReplyText) {
                        console.log(`📤 Traitement réponse IA via [${sessionObj.label}] à ${senderJid}...`);
                        try {
                            if (rawReplyText.includes('[SEND_MENU_IMAGES]')) {
                                const cleanPrompt = rawReplyText.replace(/\[SEND_MENU_IMAGES\]/g, '').trim();
                                const assetsDir = path.join(__dirname, 'assets');
                                const menuCards = [
                                    { file: 'menu_1.png', caption: '🍔 *Bocadillos & Tortillias*' },
                                    { file: 'menu_2.png', caption: '🍟 *Sandwiches, Formules & Extras*' },
                                    { file: 'menu_3.png', caption: '🥤 *Boissons Fraîches*' }
                                ];

                                for (const card of menuCards) {
                                    const imgPath = path.join(assetsDir, card.file);
                                    if (fs.existsSync(imgPath)) {
                                        try {
                                            await sock.sendMessage(senderJid, {
                                                image: fs.readFileSync(imgPath),
                                                caption: card.caption
                                            });
                                            await new Promise(r => setTimeout(r, 600));
                                        } catch (cardErr) {
                                            console.error(`❌ Erreur envoi image ${card.file}:`, cardErr.message);
                                        }
                                    }
                                }

                                if (cleanPrompt) {
                                    recentBotReplies.set(cleanPrompt, Date.now());
                                    await sock.sendMessage(senderJid, { text: cleanPrompt });
                                }
                                console.log(`✅ Menu Images + Prompt envoyés avec succès sur [${sessionObj.label}] !`);
                            } else {
                                recentBotReplies.set(rawReplyText, Date.now());
                                await sock.sendMessage(senderJid, { text: rawReplyText });
                                console.log(`✅ Réponse IA envoyée avec succès sur [${sessionObj.label}] !`);
                            }
                        } catch (sendErr) {
                            console.error(`❌ Erreur envoi direct reply:`, sendErr.message);
                        }
                    } else {
                        console.log(`ℹ️ Aucune réponse texte à renvoyer pour ${senderName}`);
                    }
                } catch (err) {
                    console.error(`❌ Erreur Webhook Cloud sur [${sessionObj.label}]:`, err.message);
                }
            }
        });

    } catch (err) {
        console.error(`❌ Erreur démarrage session ${sessionId}:`, err);
    }

    return sessionObj;
}

// -------------------------------------------------------------
// 🔄 Synchronisation des sessions depuis Firestore
// -------------------------------------------------------------
let isSyncingSessions = false;
async function syncSessionsFromFirestore() {
    if (isSyncingSessions) return;
    isSyncingSessions = true;

    try {
        const url = `https://firestore.googleapis.com/v1/projects/${APP_ID}/databases/(default)/documents/artifacts/${APP_ID}/public/data/whatsapp_sessions?key=${API_KEY}`;
        const res = await axios.get(url, { timeout: 8000 });
        if (res.data && Array.isArray(res.data.documents)) {
            for (const doc of res.data.documents) {
                const fields = doc.fields || {};
                const sessId = fields.id?.stringValue;
                if (!sessId) continue;

                const label = fields.label?.stringValue || `Ligne WhatsApp (${sessId})`;
                const phone = fields.phone?.stringValue || '';
                const isDefault = fields.isDefault?.booleanValue || false;
                const command = fields.command?.stringValue || '';
                const status = fields.status?.stringValue || 'disconnected';

                if (sessions.has(sessId)) {
                    const localSess = sessions.get(sessId);
                    localSess.label = label;
                    localSess.phone = phone || localSess.phone;
                    localSess.isDefault = isDefault;

                    // Gérer les commandes distantes
                    if (command === 'logout') {
                        console.log(`🛑 Commande "logout" reçue pour la ligne [${sessId}]`);
                        if (localSess.sock) {
                            try { await localSess.sock.logout(); } catch (e) {}
                        }
                        sessions.delete(sessId);
                        const authFolder = path.join(__dirname, "auth_sessions", sessId);
                        try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch (e) {}
                        await updateSessionDoc(sessId, { command: "done", status: "disconnected" });
                    }
                } else {
                    // Nouvelle session détectée dans Firestore -> La démarrer !
                    if (status !== 'disconnected' || command === 'create_session' || command === 'reconnect' || status === 'waiting_qr') {
                        console.log(`✨ Nouvelle ligne détectée dans Firestore: [${sessId}] - "${label}"`);
                        await startSession(sessId, { label, phone, isDefault });
                    }
                }
            }
        }
    } catch (e) {
        // Silently continue
    } finally {
        isSyncingSessions = false;
    }
}

// -------------------------------------------------------------
// 📤 Envoi des messages en file d'attente (Outbox Router)
// -------------------------------------------------------------
let isPollingOutbox = false;
async function pollOutbox() {
    if (isPollingOutbox) return;
    isPollingOutbox = true;

    try {
        const queryBody = {
            structuredQuery: {
                from: [{ collectionId: "whatsapp_outbox" }],
                where: {
                    fieldFilter: {
                        field: { fieldPath: "status" },
                        op: "EQUAL",
                        value: { stringValue: "pending" }
                    }
                },
                limit: 10
            }
        };

        const urlLegacy = `https://firestore.googleapis.com/v1/projects/${APP_ID}/databases/(default)/documents/whatsapp_outbox?key=${API_KEY}`;
        const urlNew = `https://firestore.googleapis.com/v1/projects/${APP_ID}/databases/(default)/documents/artifacts/${APP_ID}:runQuery?key=${API_KEY}`;

        const [resLegacy, resNew] = await Promise.all([
            axios.get(urlLegacy, { timeout: 8000 }).catch(e => ({ data: { documents: [] } })),
            axios.post(urlNew, queryBody, { headers: { "Content-Type": "application/json" }, timeout: 8000 }).catch(e => ({ data: [] }))
        ]);

        const legacyDocs = (resLegacy.data?.documents || []).filter(doc => doc.fields?.status?.stringValue === 'pending').map(doc => ({ document: doc }));
        const combinedData = [...legacyDocs, ...(resNew.data || [])];
        if (combinedData.length > 0) {
            for (const item of combinedData) {
                if (!item.document) continue;
                const docName = item.document.name;
                const fields = item.document.fields || {};
                
                const rawTo = fields.to?.stringValue || fields.phone?.stringValue || fields.customerPhone?.stringValue || '';
                const body = fields.body?.stringValue || fields.message?.stringValue || fields.text?.stringValue || '';
                const targetSessionId = fields.sessionId?.stringValue || fields.session?.stringValue || null;
                
                if (rawTo && body) {
                    // Choisir le bon socket :
                    // 1. Si une session précise est demandée et connectée -> l'utiliser
                    // 2. Sinon -> Trouver la session Principale (isDefault) connectée
                    // 3. Fallback -> N'importe quelle session connectée
                    let chosenSession = null;

                    if (targetSessionId && targetSessionId !== 'default' && sessions.has(targetSessionId)) {
                        const candidate = sessions.get(targetSessionId);
                        if (candidate.isConnected && candidate.sock) chosenSession = candidate;
                    }

                    if (!chosenSession) {
                        // Chercher la session par défaut connectée
                        for (const s of sessions.values()) {
                            if (s.isDefault && s.isConnected && s.sock) {
                                chosenSession = s;
                                break;
                            }
                        }
                    }

                    if (!chosenSession) {
                        // Première session connectée
                        for (const s of sessions.values()) {
                            if (s.isConnected && s.sock) {
                                chosenSession = s;
                                break;
                            }
                        }
                    }

                    if (!chosenSession) {
                        // Aucune ligne WhatsApp connectée pour le moment
                        continue;
                    }

                    try {
                        let jid = rawTo.trim();
                        if (!jid.includes('@')) {
                            const digits = jid.replace(/[^0-9]/g, '');
                            if (!digits || digits.length < 8) {
                                console.warn(`⚠️ [OUTBOX] Numéro destinataire invalide ("${rawTo}"), document ignoré.`);
                                const patchUrl = `https://firestore.googleapis.com/v1/${docName}?key=${API_KEY}&updateMask.fieldPaths=status&updateMask.fieldPaths=error`;
                                await axios.patch(patchUrl, {
                                    fields: { 
                                        status: { stringValue: "invalid_recipient" },
                                        error: { stringValue: `Invalid recipient phone: ${rawTo}` }
                                    }
                                });
                                continue;
                            }
                            if (digits.length > 12 && !digits.startsWith('212')) {
                                jid = `${digits}@lid`;
                            } else {
                                const clean = digits.startsWith('0') ? '212' + digits.slice(1) : (digits.startsWith('212') ? digits : '212' + digits);
                                jid = `${clean}@s.whatsapp.net`;
                            }
                        }
                        
                        console.log(`📤 [OUTBOX] Envoi via [${chosenSession.label}] (${chosenSession.phone}) à ${jid}...`);
                        await chosenSession.sock.sendMessage(jid, { text: body });
                        
                        // Marquer comme envoyé
                        const patchUrl = `https://firestore.googleapis.com/v1/${docName}?key=${API_KEY}&updateMask.fieldPaths=status&updateMask.fieldPaths=sentAt&updateMask.fieldPaths=sentBySession&updateMask.fieldPaths=sentByPhone`;
                        await axios.patch(patchUrl, {
                            fields: { 
                                status: { stringValue: "sent" },
                                sentAt: { integerValue: String(Date.now()) },
                                sentBySession: { stringValue: chosenSession.id },
                                sentByPhone: { stringValue: chosenSession.phone || chosenSession.connectedPhone || '' }
                            }
                        });
                        console.log(`✅ [OUTBOX] Envoyé avec succès à ${jid} via [${chosenSession.label}]`);
                    } catch (sendErr) {
                        console.error(`❌ [OUTBOX] Erreur envoi:`, sendErr.message);
                        try {
                            const patchUrl = `https://firestore.googleapis.com/v1/${docName}?key=${API_KEY}&updateMask.fieldPaths=status&updateMask.fieldPaths=error`;
                            await axios.patch(patchUrl, {
                                fields: { 
                                    status: { stringValue: "error" },
                                    error: { stringValue: sendErr.message }
                                }
                            });
                        } catch (e2) {}
                    }
                }
            }
        }
    } catch (e) {
        console.error("❌ Erreur pollOutbox:", e.response?.data || e.message);
    } finally {
        isPollingOutbox = false;
    }
}

// Intervalles
setInterval(syncSessionsFromFirestore, 4000);
setInterval(pollOutbox, 2000);

// -------------------------------------------------------------
// 🌐 Mini Web Server Dashboard Multi-Lignes (http://localhost:3002)
// -------------------------------------------------------------
const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });

    const sessionList = Array.from(sessions.values());

    const cardsHtml = sessionList.map(s => {
        const isConn = s.isConnected;
        const isWait = s.status === 'waiting_qr';
        
        return `
            <div class="card ${isConn ? 'connected-card' : isWait ? 'waiting-card' : ''}">
                <div class="header">
                    <h3>${s.label}</h3>
                    ${s.isDefault ? '<span class="badge-principal">⭐️ Principal</span>' : ''}
                </div>
                <p class="phone">📞 ${s.phone || s.connectedPhone || 'Non configuré'}</p>
                <div class="status-pill ${isConn ? 'pill-green' : isWait ? 'pill-orange' : 'pill-red'}">
                    ${isConn ? '🟢 Connecté & Actif (IA Répond)' : isWait ? '🟡 En attente de Scan QR' : '🔴 Déconnecté'}
                </div>

                ${isWait && s.qrUrl ? `
                    <div class="qr-container">
                        <img src="${s.qrUrl}" alt="Scan QR Code" />
                        <p class="scan-instructions">Scannez avec WhatsApp sur ce numéro</p>
                    </div>
                ` : ''}

                ${isConn ? `
                    <div class="connected-msg">
                        ✅ Ce numéro reçoit les commandes & l'IA répond automatiquement en Darija/Français !
                    </div>
                ` : ''}
            </div>
        `;
    }).join('');

    res.end(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Hub WhatsApp Multi-Lignes - Mon Bocadillo</title>
            <meta http-equiv="refresh" content="5">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0b1120; color: #fff; margin: 0; padding: 2rem; }
                .container { max-width: 1000px; margin: 0 auto; }
                .top-title { display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #1e293b; padding-bottom: 1.5rem; margin-bottom: 2rem; }
                .top-title h1 { margin: 0; font-size: 1.6rem; color: #10b981; display: flex; align-items: center; gap: 0.75rem; }
                .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 1.5rem; }
                .card { background: #1e293b; border-radius: 1.25rem; padding: 1.5rem; border: 1px solid #334155; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.3); }
                .connected-card { border-color: #059669; }
                .waiting-card { border-color: #d97706; }
                .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; }
                .header h3 { margin: 0; font-size: 1.15rem; color: #f8fafc; }
                .badge-principal { background: #fef3c7; color: #92400e; font-size: 0.75rem; font-weight: 800; padding: 0.25rem 0.6rem; border-radius: 9999px; }
                .phone { color: #94a3b8; font-family: monospace; font-size: 0.95rem; margin: 0.25rem 0 1rem 0; font-weight: bold; }
                .status-pill { font-size: 0.8rem; font-weight: 700; padding: 0.4rem 0.8rem; border-radius: 9999px; display: inline-block; margin-bottom: 1.25rem; }
                .pill-green { background: #064e3b; color: #34d399; }
                .pill-orange { background: #78350f; color: #fde68a; }
                .pill-red { background: #881337; color: #fecdd3; }
                .qr-container { background: white; padding: 1rem; border-radius: 1rem; text-align: center; margin-top: 1rem; }
                .qr-container img { width: 220px; height: 220px; display: block; margin: 0 auto; }
                .scan-instructions { color: #334155; font-size: 0.8rem; font-weight: 600; margin: 0.5rem 0 0 0; }
                .connected-msg { background: #064e3b33; border: 1px solid #065f46; color: #34d399; padding: 0.75rem; border-radius: 0.75rem; font-size: 0.82rem; font-weight: 600; line-height: 1.4; }
                .footer { text-align: center; margin-top: 3rem; color: #64748b; font-size: 0.85rem; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="top-title">
                    <h1>🍔 Hub Centralisé Multi-Lignes WhatsApp (Mon Bocadillo)</h1>
                    <div style="font-size: 0.85rem; color: #94a3b8; background: #1e293b; padding: 0.5rem 1rem; border-radius: 0.5rem; border: 1px solid #334155;">
                        ⚡ Actualisation automatique toutes les 5s
                    </div>
                </div>

                <div class="grid">
                    ${cardsHtml}
                </div>

                <div class="footer">
                    Mon Bocadillo • Robot IA Baileys Multi-Numéros • Tous les numéros actifs répondent aux clients 24/7
                </div>
            </div>
        </body>
        </html>
    `);
});

const PORT = process.env.PORT || 3002;
server.listen(PORT, () => {
    console.log(`🌐 Hub WhatsApp disponible sur : http://localhost:${PORT}`);
});

// -------------------------------------------------------------
// 🔌 SOCKET.IO SERVER (KDS OFFLINE BRIDGE)
// -------------------------------------------------------------
const io = new Server(server, {
    cors: { origin: "*" },
    transports: ['websocket', 'polling']
});

io.on('connection', (socket) => {
    console.log(`🔌 [Socket.io] Nouvelle connexion KDS/Caisse détectée: ${socket.id}`);

    // Quand la Caisse (POS) crée une nouvelle commande hors-ligne
    socket.on('kds_new_order', (order) => {
        console.log(`🍔 [Socket.io] Nouvelle commande reçue de la caisse: #${order.orderNumber || 'N/A'}`);
        // Rediffuser à tout le monde (notamment les écrans KDS)
        socket.broadcast.emit('kds_new_order', order);
    });

    // Quand la Caisse (POS) modifie une commande ou change le statut
    socket.on('kds_status_updated', (data) => {
        console.log(`🔄 [Socket.io] Mise à jour de statut: #${data.orderNumber} -> ${data.status}`);
        // Rediffuser au KDS
        socket.broadcast.emit('kds_status_updated', data);
    });

    socket.on('disconnect', () => {
        console.log(`🔌 [Socket.io] Déconnexion: ${socket.id}`);
    });
});

// -------------------------------------------------------------
// 🚀 DÉMARRAGE GLOBAL
// -------------------------------------------------------------
async function initBot() {
    console.log(`\n======================================================`);
    console.log(`🍔 MON BOCADILLO - MOTEUR MULTI-LIGNES WHATSAPP + IA`);
    console.log(`======================================================\n`);

    // 1. Initialiser les sessions existantes sur disque
    const authBaseDir = path.join(__dirname, "auth_sessions");
    if (!fs.existsSync(authBaseDir)) {
        fs.mkdirSync(authBaseDir, { recursive: true });
    }

    const localDirs = fs.readdirSync(authBaseDir).filter(f => fs.statSync(path.join(authBaseDir, f)).isDirectory());
    for (const dir of localDirs) {
        console.log(`📁 Détection du dossier d'authentification existant : ${dir}`);
        await startSession(dir, { label: dir, isDefault: dir.includes('0656102030') || dir.includes('primary') });
    }

    // 2. Synchroniser avec Firestore
    await syncSessionsFromFirestore();

    setInterval(() => {
        const now = new Date();
        const h = now.getHours();
        const m = now.getMinutes();
        const timeInMinutes = h * 60 + m;
        const isWorkingHours = timeInMinutes >= (12 * 60) && timeInMinutes <= (23 * 60 + 30);

        if (isWorkingHours) {
            axios.post('https://us-central1-mon-bocadillo-menu.cloudfunctions.net/whatsappBotHeartbeat', {
                appId: APP_ID,
                status: 'online'
            }).catch(err => {});
        }
    }, 600000);
}

initBot().catch(err => console.error("Erreur initBot:", err));

// Protection contre les plantages inattendus (24/7 Uptime VPS)
process.on('uncaughtException', (err) => {
    console.error('⚠️ [CRITICAL - Uncaught Exception]:', err?.message || err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ [CRITICAL - Unhandled Rejection]:', reason);
});



