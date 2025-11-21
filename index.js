// ai-processor/index.js
require('dotenv').config();
const admin = require('firebase-admin');
const fetch = require('node-fetch');
const pLimit = require('p-limit');

// --- Global Variables ---
const RAW_MESSAGES_COLLECTION = 'raw_messages';
const LEADS_COLLECTION = 'leads';
const QUALIFIED_LEADS_COLLECTION = 'qualified_leads';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_API_MODEL = "gemini-2.5-flash";
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_API_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
const CONCURRENCY_LIMIT = 5; // Max concurrent messages
const limit = pLimit(CONCURRENCY_LIMIT);

let db;

// --- Global Error Handlers ---
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'Reason:', reason);
});

// --- Firebase Initialization ---
function initializeFirebase() {
    try {
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

// --- Helper: Delay ---
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Fetch with Timeout ---
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

// --- Retry Wrapper ---
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

// --- Gemini API call ---
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

// --- Message classification / qualification / extraction ---
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

// --- Generate Reply ---
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

// --- Process a single message ---
async function processMessage(doc) {
    const message = doc.data();
    const docId = doc.id;
    const userId = message.userId || "unknown_user";
    const phoneNumber = message.phoneNumber || "unknown_phone";

    if (message.processing) return; // Already processing
    await doc.ref.update({ processing: true });

    try {
        console.log(`📨 Processing ${docId} [${userId}]...`);

        const classification = await classifyMessage(message.body);
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
                const qual = await qualifyLead(message.body, totalMessages, classification.intent);
                isQualified = qual.isQualified;
                leadPriority = qual.priority;
                await delay(100);
            }

            // Extract missing data
            if (isQualified && (!currentLeadData.name || !currentLeadData.email)) {
                const extracted = await extractData(message.body);
                currentLeadData.name = currentLeadData.name || extracted.name;
                currentLeadData.email = currentLeadData.email || extracted.email;
            }

            const missingName = !currentLeadData.name;
            const missingEmail = !currentLeadData.email;
            const autoReply = await generateReply(message.body, classification.intent, isReturningClient, isQualified, missingName, missingEmail);
            await delay(100);

            // Save qualified lead
            if (isQualified) {
                const qualifiedLeadUpdate = {
                    userId, phoneNumber, rawMessageId: docId, intent: classification.intent,
                    priority: leadPriority, messageCount: totalMessages, autoReplyText: autoReply,
                    name: currentLeadData.name, email: currentLeadData.email, timestamp: admin.firestore.Timestamp.now()
                };
                if (!qualifiedLeadDocRef) await db.collection(QUALIFIED_LEADS_COLLECTION).add(qualifiedLeadUpdate);
                else await qualifiedLeadDocRef.update({ name: currentLeadData.name, email: currentLeadData.email, messageCount: totalMessages, lastActive: admin.firestore.Timestamp.now() });
            }

            // Save/update general lead
            if (!isReturningClient) await db.collection(LEADS_COLLECTION).add({ userId, phoneNumber, intent: classification.intent, firstMessageBody: message.body, messageCount: totalMessages, timestamp: admin.firestore.Timestamp.now() });
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
