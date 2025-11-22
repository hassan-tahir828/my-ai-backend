// ai-processor/index.js
require('dotenv').config();
const admin = require('firebase-admin');
const fetch = require('node-fetch');
const pLimit = require('p-limit');
const crypto = require('crypto');
const express = require('express');

// Debug: path to the log you uploaded for debugging. (Dev note: file URL)
const DEBUG_LOG_FILE_URL = "file:///mnt/data/logs.1763827710412.json";

// --- Config / Globals ---
const PORT = process.env.PORT || 3000;
const RAW_MESSAGES_COLLECTION = 'raw_messages';
const LEADS_COLLECTION = 'leads';
const QUALIFIED_LEADS_COLLECTION = 'qualified_leads';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_API_MODEL = process.env.GEMINI_API_MODEL || "gemini-2.5-flash";
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_API_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
const CONCURRENCY_LIMIT = parseInt(process.env.CONCURRENCY_LIMIT || "5", 10);
const limit = pLimit(CONCURRENCY_LIMIT);
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY; // 64 hex chars

let db;

// --- Global Error Handlers ---
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'Reason:', reason);
});

// -------------------------
// 🔒 Decrypt helper (AES-256-GCM, hex key/iv/tag)
// -------------------------
function decrypt(encryptedBody, iv, authTag) {
    if (!encryptedBody || !iv || !authTag) return null;
    try {
        const key = Buffer.from(ENCRYPTION_KEY, 'hex'); 
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
        decipher.setAuthTag(Buffer.from(authTag, 'hex'));

        let decrypted = decipher.update(encryptedBody, 'hex', 'utf8');
        decrypted += decipher.final('utf8');

        return decrypted;
    } catch (e) {
        console.error("❌ Decryption Failed:", e.message);
        return null;
    }
}

// -------------------------
// 🔥 Firebase Initialization
// -------------------------
function initializeFirebase() {
    try {
        if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(ENCRYPTION_KEY)) {
            throw new Error("Missing or invalid ENCRYPTION_KEY. Must be a 64-character hexadecimal string.");
        }

        const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_API_BASE64;
        if (!serviceAccountBase64) throw new Error("FIREBASE_SERVICE_ACCOUNT_API_BASE64 missing");
        const serviceAccountJson = Buffer.from(serviceAccountBase64, 'base64').toString('utf-8');
        const serviceAccount = JSON.parse(serviceAccountJson);

        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });

        db = admin.firestore();
        console.log("🔥 Firebase Admin Initialized");

    } catch (error) {
        console.error("❌ Firebase Init Error:", error.message);
        process.exit(1);
    }
}

// -------------------------
// 🧠 Gemini multi-task call
// This asks Gemini to return a JSON object with these fields:
// {
//   reply: "text reply here",
//   intent: "intent_label",
//   isLead: true|false,
//   missingName: true|false,
//   missingEmail: true|false,
//   extracted: { name: "...", email: "..." }
// }
// -------------------------
async function callGeminiMultiTask(messageBody, context = {}) {
    if (!GEMINI_API_KEY) {
        console.warn("⚠️ GEMINI_API_KEY is not set. Skipping AI calls.");
        return {
            reply: "The AI is currently unavailable.",
            intent: "error",
            isLead: false,
            missingName: true,
            missingEmail: true,
            extracted: {}
        };
    }

    // Build an explicit system instruction asking for strict JSON output
    const systemInstruction = `
You are an assistant for an immigration consultancy. Given the client's message, produce TWO things and output ONLY a JSON object:
1) A concise reply message suitable to send back on WhatsApp (<= 5 sentences). The reply should be professional and follow the business rules described below.
2) Structured metadata describing intent and contact extraction.

Return valid JSON with keys: reply, intent, isLead, missingName, missingEmail, extracted.
- intent: a short string (e.g., "study_visa", "work_visa", "quote_request", "general_inquiry").
- isLead: true if this conversation should be treated as a lead (wants service/quote/consultation), otherwise false.
- missingName / missingEmail: booleans indicating whether the user's full name or email is missing.
- extracted: object with possible fields name and email (strings) if found, otherwise empty strings.

Business rules:
- If the user asks for a quote or mentions "price/fee/cost/quote", set intent to "quote_request" and isLead true.
- If user asks about "study visa", "student visa", set intent "study_visa".
- If user asks for next steps / assessment / consultation, mark isLead true.
- For name detection, consider common patterns (e.g., "My name is ...", "I am ...", signature). For email detection, find typical email patterns.
- Keep reply concise, and if name/email missing and isLead true, ask only for the missing fields (do NOT ask for additional info).
- If it seems to be a returning client (context.returningClient true), acknowledge return briefly.

Important: Output STRICT JSON only (no extra explanation). Example:
{
  "reply": "Thanks — we need your full name and email to confirm the slot. We'll call you on this number.",
  "intent": "quote_request",
  "isLead": true,
  "missingName": true,
  "missingEmail": false,
  "extracted": { "name": "", "email": "user@example.com" }
}
`;

    // Compose user content
    const userContent = `Client message: """${messageBody}""" 
Context: ${JSON.stringify(context)}.
Return only JSON.`;

    const payload = {
        contents: [{ parts: [{ text: userContent }] }],
        systemInstruction: { parts: [{ text: systemInstruction }] },
        // small generation config
        // NOTE: exact model config field names may vary; keep conservative options
        // We allow up to ~300 tokens in response for JSON
        // If your environment requires different param names, adjust accordingly.
    };

    try {
        const response = await fetch(GEMINI_API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            timeout: 30_000
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!rawText) throw new Error("Gemini returned no text.");

        // Attempt to extract JSON inside the rawText
        // Some models may wrap the JSON in triple backticks or text; try to find the JSON substring.
        const jsonMatch = rawText.match(/\{[\s\S]*\}$/);
        const jsonText = jsonMatch ? jsonMatch[0] : rawText;

        let parsed;
        try {
            parsed = JSON.parse(jsonText);
        } catch (parseErr) {
            console.warn("⚠️ Failed to parse JSON from Gemini. Raw text:", rawText);
            // As fallback, try to extract fields heuristically
            parsed = {
                reply: rawText,
                intent: "unknown",
                isLead: false,
                missingName: true,
                missingEmail: true,
                extracted: {}
            };
        }

        // Normalize expected fields
        return {
            reply: (parsed.reply || parsed.text || "").toString().trim(),
            intent: (parsed.intent || "general_inquiry").toString(),
            isLead: !!parsed.isLead,
            missingName: !!parsed.missingName,
            missingEmail: !!parsed.missingEmail,
            extracted: parsed.extracted || {}
        };

    } catch (err) {
        console.error("❌ Gemini multi-task call failed:", err.message);
        return {
            reply: "Thank you for your message. We are currently experiencing high volume but will reply to your inquiry shortly!",
            intent: "error",
            isLead: false,
            missingName: true,
            missingEmail: true,
            extracted: {}
        };
    }
}

// -------------------------
// 🧩 Helper: small sanitizers
// -------------------------
function sanitizeIntent(intent) {
    if (!intent) return "general_inquiry";
    return intent.toString().toLowerCase().replace(/\s+/g, "_");
}

// -------------------------
// ⚙️ Message Processor
// -------------------------
async function processMessage(doc) {
    const docId = doc.id;
    const message = doc.data();

    // Avoid reprocessing
    if (message.processing) return;
    await doc.ref.update({ processing: true });

    const decryptedBody = decrypt(message.encryptedBody, message.iv, message.authTag);

    if (!decryptedBody) {
        console.error(`❌ Decryption failed for message ${docId}. Marking processed.`);
        await doc.ref.update({
            processed: true,
            processing: false,
            autoReplyText: "Error processing your message due to a decryption issue."
        });
        return;
    }

    // Determine total messages for this lead (simple heuristic)
    const leadKey = message.from;
    const totalMessagesSnap = await db.collection(RAW_MESSAGES_COLLECTION).where('from', '==', leadKey).get();
    const totalMessages = totalMessagesSnap.size;

    try {
        // Call Gemini to get structured reply + metadata
        const context = {
            returningClient: totalMessages > 1,
            // you can add more context like lastIntent, timezone, etc.
        };

        const aiResult = await callGeminiMultiTask(decryptedBody, context);
        const { reply, intent, isLead, missingName, missingEmail, extracted } = aiResult;

        const normalizedIntent = sanitizeIntent(intent);
        const isQualified = (normalizedIntent === "quote_request") || isLead;

        const leadPriority = isQualified ? 1 : 2;

        // Update raw message doc to trigger send in WhatsApp backend
        await doc.ref.update({
            processed: true,
            isLead,
            isQualified,
            priority: leadPriority,
            autoReplyText: reply,
            messageCount: totalMessages,
            replyPending: true,
            processing: false,
            metadata: {
                aiIntent: normalizedIntent,
                aiExtracted: extracted,
                missingName,
                missingEmail
            }
        });

        // Update or create Lead document
        const existingLeadSnap = await db.collection(LEADS_COLLECTION).where('leadKey', '==', leadKey).limit(1).get();
        const now = admin.firestore.Timestamp.now();

        if (isLead) {
            if (existingLeadSnap.empty) {
                // Create new lead
                await db.collection(LEADS_COLLECTION).add({
                    leadKey,
                    intent: normalizedIntent,
                    firstMessageBody: decryptedBody,
                    messageCount: totalMessages,
                    extracted: extracted || {},
                    missingName,
                    missingEmail,
                    priority: leadPriority,
                    createdAt: now,
                    lastActive: now
                });
            } else {
                // Update existing lead
                const leadRef = existingLeadSnap.docs[0].ref;
                await leadRef.update({
                    intent: normalizedIntent,
                    messageCount: totalMessages,
                    lastActive: now,
                    extracted: admin.firestore.FieldValue.arrayUnion(extracted || {}),
                    missingName,
                    missingEmail,
                    priority: leadPriority
                });
            }
            console.log(`✅ Message ${docId} processed. Reply pending.`);
        } else {
            console.log(`ℹ️ Message ${docId} processed. Not a lead.`);
        }

    } catch (err) {
        console.error(`❌ Processing failed for ${docId}:`, err.message);
        // ensure we free up the processing flag so it can be retried if needed
        await doc.ref.update({ processing: false });
    }
}

// --- Polling Processor ---
async function pollMessages() {
    try {
        const snapshot = await db.collection(RAW_MESSAGES_COLLECTION)
            .where('processed', '==', false)
            .where('processing', '==', false)
            .limit(CONCURRENCY_LIMIT)
            .get();

        snapshot.docs.forEach(doc => limit(() => processMessage(doc)));
    } catch (err) {
        console.error("❌ Polling error:", err.message);
    }
}

function startLeadProcessor() {
    if (!db) { console.error("❌ Firestore not initialized"); return; }
    console.log(`🔄 Starting lead processor (poll every 2s)...`);
    setInterval(pollMessages, 2000);
}

// -------------------------
// 🌍 Health Check Server (Railway friendly)
// -------------------------
const app = express();
app.get("/", (req, res) => {
    res.json({
        status: "AI Processor Running and Polling",
        timestamp: new Date().toISOString(),
        debugLog: DEBUG_LOG_FILE_URL
    });
});

// -------------------------
// Start everything
// -------------------------
initializeFirebase();
startLeadProcessor();

app.listen(PORT, "0.0.0.0", () => {
    console.log(`🌍 Health Check Server Running on port ${PORT}`);
});
