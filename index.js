// ai-processor/index.js
require('dotenv').config();
const admin = require('firebase-admin');
const fetch = require('node-fetch');
const pLimit = require('p-limit');
const crypto = require('crypto'); // <-- ADDED: For decryption
const express = require('express'); // <-- ADDED: For Railway health check

// --- Global Variables ---
const PORT = process.env.PORT || 3000; // Define Port for Health Check
const RAW_MESSAGES_COLLECTION = 'raw_messages';
const LEADS_COLLECTION = 'leads';
const QUALIFIED_LEADS_COLLECTION = 'qualified_leads';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_API_MODEL = "gemini-2.5-flash";
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_API_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
const CONCURRENCY_LIMIT = 5; // Max concurrent messages
const limit = pLimit(CONCURRENCY_LIMIT);
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY; // Get key from env

let db;

// --- Global Error Handlers ---
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'Reason:', reason);
});

// -------------------------
// 🔒 DECRYPTION HELPER (FIXED: Uses secure hex key encoding)
// -------------------------
function decrypt(encryptedBody, iv, authTag) {
    if (!encryptedBody || !iv || !authTag) return null;
    try {
        // SECURITY FIX: Use 'hex' encoding to correctly interpret the 64-char key
        const key = Buffer.from(ENCRYPTION_KEY, 'hex'); 
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
        decipher.setAuthTag(Buffer.from(authTag, 'hex'));

        let decrypted = decipher.update(encryptedBody, 'hex', 'utf8');
        decrypted += decipher.final('utf8');

        return decrypted;
    } catch (e) {
        console.error("❌ Decryption Failed:", e.message);
        return null; // Return null on failure
    }
}

// -------------------------
// 🔥 FIREBASE INITIALIZATION (FIXED: Added key validation)
// -------------------------
function initializeFirebase() {
    try {
        // SECURITY CHECK: Ensure ENCRYPTION_KEY is valid
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
// 🤖 CORE AI FUNCTIONS (Stubs for the logic)
// -------------------------

async function generateAIResponse(prompt) {
    if (!GEMINI_API_KEY) {
        console.warn("⚠️ GEMINI_API_KEY is not set. Skipping AI calls.");
        return { text: "The AI is currently unavailable.", classification: { isLead: false, intent: "error" }, extraction: null };
    }

    // This block would contain the logic to call the Gemini API
    // and process the response for classification, extraction, and reply.
    
    // Placeholder logic:
    if (prompt.toLowerCase().includes("quote")) {
        return { 
            text: "Thank you for your inquiry about a quote! I need to know your company name and project scope to provide an accurate estimate.", 
            classification: { isLead: true, intent: "quote_request" }, 
            extraction: { companyName: "Unknown", scope: "Quote Request" } 
        };
    }
    
    return { 
        text: "Thank you for your message. I'm processing your request.", 
        classification: { isLead: true, intent: "general_inquiry" }, 
        extraction: null 
    };
}


// -------------------------
// ⚙️ MESSAGE PROCESSOR (FIXED: Handles decryption failure)
// -------------------------

async function processMessage(doc) {
    const docId = doc.id;
    const message = doc.data();

    if (message.processing) return;

    await doc.ref.update({ processing: true });

    const decryptedBody = decrypt(message.encryptedBody, message.iv, message.authTag);

    // STABILITY FIX: If decryption fails, mark as processed and exit safely
    if (!decryptedBody) {
        console.error(`❌ Decryption failed for message ${docId}. Marking processed.`);
        await doc.ref.update({ processed: true, processing: false, autoReplyText: "Error processing your message due to a decryption issue." });
        return;
    }

    // 1. Get total message count for this lead (to determine if this is the first message)
    const leadKey = message.from;
    const totalMessages = (await db.collection(RAW_MESSAGES_COLLECTION).where('from', '==', leadKey).get()).size;

    try {
        // 2. Classify and Extract Data using AI (using decryptedBody)
        const aiResult = await generateAIResponse(decryptedBody);
        const { text: autoReply, classification, extraction } = aiResult;
        
        const isQualified = classification.intent === "quote_request"; // Example qualification logic
        const leadPriority = isQualified ? 1 : 2; 

        // 3. Update/Create Lead Document
        const existingLeadSnap = await db.collection(LEADS_COLLECTION).where('leadKey', '==', leadKey).get();
        
        if (classification.isLead) {
            // Update the raw message document to trigger reply sending in the whatsapp backend
            await doc.ref.update({ processed: true, isLead: classification.isLead, isQualified, priority: leadPriority, autoReplyText: autoReply, messageCount: totalMessages, replyPending: true, processing: false });

            // Update Lead Document
            if (existingLeadSnap.empty) 
                await db.collection(LEADS_COLLECTION).add({ leadKey, intent: classification.intent, firstMessageBody: decryptedBody, messageCount: totalMessages, timestamp: admin.firestore.Timestamp.now() });
            else 
                await existingLeadSnap.docs[0].ref.update({ intent: classification.intent, messageCount: totalMessages, lastActive: admin.firestore.Timestamp.now() });

            console.log(`✅ Message ${docId} processed. Reply pending.`);
        } else {
            // Not a lead - just mark processed
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
    const snapshot = await db.collection(RAW_MESSAGES_COLLECTION).where('processed', '==', false).where('processing', '==', false).limit(CONCURRENCY_LIMIT).get();
    snapshot.docs.forEach(doc => limit(() => processMessage(doc)));
}

// --- Start Polling ---
function startLeadProcessor() {
    if (!db) { console.error("❌ Firestore not initialized"); return; }
    console.log("🔄 Starting lead processor (poll every 2s)...");
    setInterval(pollMessages, 2000);
}

// -------------------------
// 🌍 HEALTH CHECK SERVER (NEW FIX for Railway SIGTERM)
// -------------------------
const app = express();

// Simple health check route
app.get("/", (req, res) => {
    res.json({
        status: "AI Processor Running and Polling",
        timestamp: new Date().toISOString(),
    });
});

// --- Execute ---
initializeFirebase();
startLeadProcessor();

// Start the HTTP server to pass Railway's health check
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🌍 Health Check Server Running on port ${PORT}`);
});
