// ai-processor/index.js
require('dotenv').config();
const admin = require('firebase-admin');
const fetch = require('node-fetch');
const pLimit = require('p-limit');
const crypto = require('crypto');

// --- Global Variables ---
const RAW_MESSAGES_COLLECTION = 'raw_messages';
const LEADS_COLLECTION = 'leads';
const QUALIFIED_LEADS_COLLECTION = 'qualified_leads';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_API_MODEL = "gemini-2.5-flash";
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_API_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
const CONCURRENCY_LIMIT = 5;
const limit = pLimit(CONCURRENCY_LIMIT);
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

let db;

// --- Global Error Handlers (Logic maintained) ---
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'Reason:', reason);
});

// -------------------------
// 🔒 DECRYPTION HELPER (Updated Key Handling)
// -------------------------
function decrypt({ encryptedBody, iv, authTag }) {
    if (!encryptedBody || !iv || !authTag) return "";

    try {
        const key = Buffer.from(ENCRYPTION_KEY, 'hex'); // Use 'hex' encoding for secure 64-char key
        const ivBuffer = Buffer.from(iv, 'hex');
        const authTagBuffer = Buffer.from(authTag, 'hex');
        const encryptedTextBuffer = Buffer.from(encryptedBody, 'hex');

        const decipher = crypto.createDecipheriv('aes-256-gcm', key, ivBuffer);
        decipher.setAuthTag(authTagBuffer);

        let decrypted = decipher.update(encryptedTextBuffer, 'buffer', 'utf-8');
        decrypted += decipher.final('utf-8');
        return decrypted;
    } catch (err) {
        // Log metadata, not content
        console.error("❌ Decryption failed. Check ENCRYPTION_KEY consistency.", err.message);
        return "";
    }
}


// --- Firebase Initialization (Updated Key Check) ---
function initializeFirebase() {
    try {
        if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(ENCRYPTION_KEY)) {
            throw new Error("Missing or invalid ENCRYPTION_KEY. Must be a 64-character hexadecimal string.");
        }
        const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_API_BASE64;
        if (!serviceAccountBase64) throw new Error("FIREBASE_SERVICE_ACCOUNT_API_BASE64 missing");
        const serviceAccountJson = Buffer.from(serviceAccountBase64, 'base64').toString('utf8');
        const serviceAccount = JSON.parse(serviceAccountJson);
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        db = admin.firestore();
        console.log("🔥 Firebase Admin Initialized");
    } catch (err) {
        console.error("❌ Firebase init error:", err.message);
        process.exit(1);
    }
}

// --- Helper: Delay (Logic maintained) ---
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Fetch with Timeout (Logic maintained) ---
async function fetchWithTimeout(url, options = {}, timeout = 10000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        return res;
    } finally {
        clearTimeout(id);
    }
}

// --- Retry Wrapper (Logic maintained) ---
async function retry(fn, retries = 2, delayMs = 500) {
    try {
        return await fn();
    } catch (err) {
        if (retries > 0) {
            console.log(`🔁 Retry after ${delayMs}ms: ${err.message}`);
            await delay(delayMs);
            return retry(fn, retries - 1, delayMs * 2);
        } else {
            console.error("❌ Retry failed:", err.message);
            return null;
        }
    }
}

// --- Gemini API call (Logic maintained) ---
async function callGeminiAPI(payload) {
    if (!GEMINI_API_KEY) return null;
    return retry(async () => {
        const response = await fetchWithTimeout(GEMINI_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }, 10000);

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = await response.json();
        const jsonText = result.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!jsonText) return null;

        try { return JSON.parse(jsonText); }
        catch { return null; }
    });
}

// --- Classification/Qualification/Extraction (Logic maintained, uses decrypted body) ---
async function classifyMessage(messageBody) {
    const payload = {
        contents: [{ parts: [{ text: `Client Message: "${messageBody}"` }] }],
        systemInstruction: { parts: [{ text: "You are an expert lead classifier. Respond ONLY with JSON { isLead: boolean, intent: string }." }] },
        generationConfig: { responseMimeType: "application/json" }
    };
    return await callGeminiAPI(payload) || { isLead: false, intent: "Unknown" };
}

async function qualifyLead(messageBody, totalMessages, intent) {
    const payload = {
        contents: [{ parts: [{ text: `Current Message: "${messageBody}", Intent: "${intent}", Total Messages: ${totalMessages}` }] }],
        systemInstruction: { parts: [{ text: "Return JSON { isQualified: boolean, priority: 'Low'|'Medium'|'High' }." }] },
        generationConfig: { responseMimeType: "application/json" }
    };
    return await callGeminiAPI(payload) || { isQualified: false, priority: "Low" };
}

async function extractData(messageBody) {
    const payload = {
        contents: [{ parts: [{ text: `Client Message: "${messageBody}"` }] }],
        systemInstruction: { parts: [{ text: "Extract Name and Email. Return { name: string|null, email: string|null }." }] },
        generationConfig: { responseMimeType: "application/json" }
    };
    return await callGeminiAPI(payload) || { name: null, email: null };
}

// --- Generate Reply (Logic maintained, uses decrypted body) ---
async function generateReply(messageBody, intent, isReturningClient, isQualified, missingName, missingEmail) {
    const systemPrompt = isQualified
        ? (missingName || missingEmail ? "Ask for missing info (name/email). Keep reply <= 3 sentences." : "Confirm info received. Reply in 1 sentence.")
        : "Answer query concisely, offer call. <=5 sentences.";
    const payload = { contents: [{ parts: [{ text: `Client Message: "${messageBody}"` }] }], systemInstruction: { parts: [{ text: systemPrompt }] } };

    try {
        const response = await fetchWithTimeout(GEMINI_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }, 10000);
        const result = await response.json();
        return result.candidates?.[0]?.content?.parts?.[0]?.text || "Thank you. We'll get back shortly.";
    } catch (err) {
        return "Thank you. We'll get back shortly.";
    }
}

// --- Process a single message (Logic maintained, uses decrypted body) ---
async function processMessage(doc) {
    const message = doc.data();
    const docId = doc.id;
    const userId = message.userId || "unknown_user";
    const phoneNumber = message.phoneNumber || "unknown_phone";

    if (message.processing) return;
    await doc.ref.update({ processing: true });

    try {
        console.log(`📨 Processing ${docId} [${userId}]...`);

        // Decrypt the message body in memory
        const decryptedBody = decrypt({
            encryptedBody: message.encryptedBody,
            iv: message.iv,
            authTag: message.authTag
        });

        if (!decryptedBody) {
             console.error(`❌ Processing failed for ${docId}: Decryption error or empty message.`);
             await doc.ref.update({ processing: false });
             return;
        }

        const classification = await classifyMessage(decryptedBody);
        await delay(100);

        let isReturningClient = false;
        let totalMessages = 1;
        let isQualified = false;
        let leadPriority = "Low";
        let qualifiedLeadDocRef = null;
        let currentLeadData = { name: null, email: null };

        if (classification.isLead) {
            const existingLeadSnap = await db.collection(LEADS_COLLECTION).where('userId', '==', userId).orderBy('timestamp', 'desc').limit(1).get();
            isReturningClient = !existingLeadSnap.empty;
            if (isReturningClient) totalMessages = (existingLeadSnap.docs[0].data().messageCount || 1) + 1;

            const existingQualifiedSnap = await db.collection(QUALIFIED_LEADS_COLLECTION).where('userId', '==', userId).limit(1).get();
            if (!existingQualifiedSnap.empty) {
                qualifiedLeadDocRef = existingQualifiedSnap.docs[0].ref;
                currentLeadData = existingQualifiedSnap.docs[0].data();
                isQualified = true;
                leadPriority = currentLeadData.priority || "High";
            } else {
                const qual = await qualifyLead(decryptedBody, totalMessages, classification.intent);
                isQualified = qual.isQualified;
                leadPriority = qual.priority;
                await delay(100);
            }

            if (isQualified && (!currentLeadData.name || !currentLeadData.email)) {
                const extracted = await extractData(decryptedBody);
                currentLeadData.name = currentLeadData.name || extracted.name;
                currentLeadData.email = currentLeadData.email || extracted.email;
            }

            const missingName = !currentLeadData.name;
            const missingEmail = !currentLeadData.email;

            const autoReply = await generateReply(decryptedBody, classification.intent, isReturningClient, isQualified, missingName, missingEmail);
            await delay(100);

            if (isQualified) {
                const qualifiedLeadUpdate = {
                    userId, phoneNumber, rawMessageId: docId, intent: classification.intent,
                    priority: leadPriority, messageCount: totalMessages, autoReplyText: autoReply,
                    name: currentLeadData.name, email: currentLeadData.email, timestamp: admin.firestore.Timestamp.now()
                };
                if (!qualifiedLeadDocRef) await db.collection(QUALIFIED_LEADS_COLLECTION).add(qualifiedLeadUpdate);
                else await qualifiedLeadDocRef.update({ name: currentLeadData.name, email: currentLeadData.email, messageCount: totalMessages, lastActive: admin.firestore.Timestamp.now() });
            }

            // Storing DECRYPTED body for the first message in the LEADS collection
            if (!isReturningClient) await db.collection(LEADS_COLLECTION).add({ userId, phoneNumber, intent: classification.intent, firstMessageBody: decryptedBody, messageCount: totalMessages, timestamp: admin.firestore.Timestamp.now() });
            else await existingLeadSnap.docs[0].ref.update({ intent: classification.intent, messageCount: totalMessages, lastActive: admin.firestore.Timestamp.now() });

            // Mark raw message processed
            await doc.ref.update({ processed: true, isLead: classification.isLead, isQualified, priority: leadPriority, autoReplyText: autoReply, messageCount: totalMessages, processing: false });
            console.log(`✅ Message ${docId} processed.`);
        } else {
            await doc.ref.update({ processed: true, processing: false });
            console.log(`❌ Not a lead. Marked processed.`);
        }

    } catch (err) {
        console.error(`❌ Processing failed for ${docId}:`, err.message);
        await doc.ref.update({ processing: false });
    }
}

// --- Polling Processor (Stable for Railway) ---
async function pollMessages() {
    const snapshot = await db.collection(RAW_MESSAGES_COLLECTION).where('processed', '==', false).where('processing', '==', false).get();
    snapshot.docs.forEach(doc => limit(() => processMessage(doc)));
}

// --- Start Polling ---
function startLeadProcessor() {
    if (!db) { console.error("❌ Firestore not initialized"); return; }
    console.log("🔄 Starting lead processor (poll every 2s)...");
    setInterval(pollMessages, 2000);
}

// --- Execute ---
initializeFirebase();
startLeadProcessor();
