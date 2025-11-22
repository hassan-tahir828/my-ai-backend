// ai-processor/index.js
require('dotenv').config();
const admin = require('firebase-admin');
const fetch = require('node-fetch');
const pLimit = require('p-limit');
const crypto = require('crypto');
const express = require('express');

// Local debug log (uploaded file) — developer requested local path as URL
const DEBUG_LOG_FILE_URL = "file:///mnt/data/logs.1763827710412.json";

// --- Config / Globals ---
const PORT = process.env.PORT || 3000;
const RAW_MESSAGES_COLLECTION = 'raw_messages';
const LEADS_COLLECTION = 'leads';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_API_MODEL = process.env.GEMINI_API_MODEL || "gemini-2.5-flash";
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_API_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
const CONCURRENCY_LIMIT = parseInt(process.env.CONCURRENCY_LIMIT || "5", 10);
const limit = pLimit(CONCURRENCY_LIMIT);
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY; // must be 64 hex chars (32 bytes)

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
// 🧠 Gemini multi-task call (asks for JSON but we sanitize outputs)
// - Soft 20-word suggestion is requested in system instruction (Option B)
// - Model asked to output JSON, but we robustly extract JSON and sanitize the reply
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

    const systemInstruction = `
You are an assistant for an immigration consultancy. Produce a JSON object and return ONLY valid JSON (no extra text outside JSON).
The JSON keys must be: reply, intent, isLead, missingName, missingEmail, extracted.

Rules for "reply":
- First, answer the client's query concisely (aim to keep the answer under 20 words — soft limit, not strict).
- Do NOT ask for name or email unless the conversation should be treated as a qualified lead (isLead true).
- If the conversation is qualified and name/email are missing, the assistant may include a brief ask for the missing fields.
- The reply text should be short, informative, and professional. If you must, use up to 2 short sentences, but prefer a very short single reply sentence.
- Do NOT include any JSON code fences or commentary.
- Example of intended reply content: "Study visa is possible for many applicants." (remember the soft 20-word target)

Intent should be a short string like: "study_visa", "work_visa", "quote_request", "general_inquiry", etc.
isLead should be true when the user is asking for service/quote/consultation or otherwise needs follow-up.
missingName and missingEmail should be booleans.
extracted should be an object with optional "name" and "email" fields if found, otherwise empty strings.

Context: ${JSON.stringify(context)}
Return valid JSON only.
`;

    const userContent = `Client message: """${messageBody}"""`;

    const payload = {
        contents: [{ parts: [{ text: userContent }] }],
        systemInstruction: { parts: [{ text: systemInstruction }] }
    };

    try {
        const response = await fetch(GEMINI_API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            // node-fetch doesn't accept 'timeout' in fetch options in v2; environment may differ.
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!rawText) throw new Error("Gemini returned no text.");

        // Clean rawText: remove common code fences and extra text, then extract JSON substring
        let cleanText = rawText.toString().trim();
        cleanText = cleanText.replace(/```json/gi, "").replace(/```/g, "").trim();

        // Try to find the JSON object in the returned text
        const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
        const jsonText = jsonMatch ? jsonMatch[0] : cleanText;

        let parsed;
        try {
            parsed = JSON.parse(jsonText);
        } catch (parseErr) {
            console.warn("⚠️ Failed to parse JSON from Gemini. Raw text:", rawText);
            // Heuristic fallback: attempt to salvage by returning reply as rawText
            return {
                reply: cleanText.substring(0, 1000), // fallback
                intent: "unknown",
                isLead: false,
                missingName: true,
                missingEmail: true,
                extracted: {}
            };
        }

        // Normalize fields (safeguard types)
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
            reply: "Thank you for your message. We are currently experiencing high volume but will reply shortly.",
            intent: "error",
            isLead: false,
            missingName: true,
            missingEmail: true,
            extracted: {}
        };
    }
}

// -------------------------
// 🧩 Helper: sanitize strings and counts
// -------------------------
function sanitizeTextForWhatsApp(text) {
    if (!text) return "";
    // Remove surrounding whitespace and ensure no JSON-like content
    let t = text.toString().trim();
    // Remove any remaining backticks
    t = t.replace(/```/g, "");
    // Collapse multiple blank lines to a single blank line
    t = t.replace(/\n{3,}/g, "\n\n");
    return t;
}

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

    const leadKey = message.from;
    const totalMessagesSnap = await db.collection(RAW_MESSAGES_COLLECTION).where('from', '==', leadKey).get();
    const totalMessages = totalMessagesSnap.size;

    try {
        const context = {
            returningClient: totalMessages > 1
        };

        // Get AI structured result
        const aiResult = await callGeminiMultiTask(decryptedBody, context);
        const { reply: aiReplyRaw, intent, isLead, missingName, missingEmail, extracted } = aiResult;

        const normalizedIntent = sanitizeIntent(intent);
        const isQualified = (normalizedIntent === "quote_request") || isLead;
        const leadPriority = isQualified ? 1 : 2;

        // Sanitize AI reply
        const aiReply = sanitizeTextForWhatsApp(aiReplyRaw);

        // Build final message according to rules:
        // 1) Include AI's reply (under 20 words soft request — we trust the model)
        // 2) If qualified AND missing fields, append requests for missing fields (each on its own line)
        // 3) Then leave one blank line, then the disclaimer on its own line:
        //    This is an AI generated reply
        const messageLines = [];

        // Ensure answer is first (AI reply)
        if (aiReply && aiReply.length > 0) {
            messageLines.push(aiReply);
        } else {
            messageLines.push("Thanks for your message.");
        }

        // Only ask for name/email if qualified (user requirement)
        if (isQualified) {
            // If name/email missing, ask specifically AFTER the answer
            if (missingName) {
                messageLines.push(""); // separate line for clarity if we want an empty line between answer and asks
                messageLines.push("Please share your full name.");
            }
            if (missingEmail) {
                // If both missing and we already added blank line, don't add another blank
                if (!missingName) messageLines.push("");
                messageLines.push("Please share your email address.");
            }

            // If qualified but not missing, acknowledge and confirm consultant will call
            if (!missingName && !missingEmail) {
                // keep concise acknowledgement
                messageLines.push("");
                messageLines.push("A consultant will call you shortly regarding your query.");
            }
        }

        // Always ensure there is exactly one blank line before disclaimer
        // If last line is not blank, push a blank line
        if (messageLines.length === 0 || messageLines[messageLines.length - 1].trim() !== "") {
            messageLines.push("");
        }

        messageLines.push("This is an AI generated reply");

        const finalReplyText = messageLines.join("\n").trim();

        // Update the raw message doc to trigger reply sending in whatsapp backend
        await doc.ref.update({
            processed: true,
            isLead,
            isQualified,
            priority: leadPriority,
            autoReplyText: finalReplyText,
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

        // Update or create Lead document if it's a lead
        const existingLeadSnap = await db.collection(LEADS_COLLECTION).where('leadKey', '==', leadKey).limit(1).get();
        const now = admin.firestore.Timestamp.now();

        if (isLead) {
            if (existingLeadSnap.empty) {
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
                const leadRef = existingLeadSnap.docs[0].ref;
                await leadRef.update({
                    intent: normalizedIntent,
                    messageCount: totalMessages,
                    lastActive: now,
                    // merged extraction - keep it simple (could be improved)
                    extracted: { ...(existingLeadSnap.docs[0].data().extracted || {}), ...(extracted || {}) },
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
