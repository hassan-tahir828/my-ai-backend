// ai-processor/index.js
require('dotenv').config();
const admin = require('firebase-admin');
const fetch = require('node-fetch');

// --- Global Error Handlers (FIX: Added to catch silent crashes) ---

process.on('uncaughtException', (err) => {
    // Catches synchronous errors that crash the process immediately.
    console.error('❌ FATAL: Uncaught Exception! The service is crashing.', err);
    // Explicitly exit so Railway restarts the service.
    process.exit(1); 
});

process.on('unhandledRejection', (reason, promise) => {
    // Catches asynchronous errors (common in Firestore listeners or API calls).
    console.error('❌ FATAL: Unhandled Rejection at:', promise, 'Reason:', reason);
    // Explicitly exit so Railway restarts the service.
    process.exit(1);
});

// --- Global Variables ---
const RAW_MESSAGES_COLLECTION = 'raw_messages';
const LEADS_COLLECTION = 'leads';
const QUALIFIED_LEADS_COLLECTION = 'qualified_leads';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_API_MODEL = "gemini-2.5-flash";
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_API_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

let db;

// --- Firebase Initialization ---
function initializeFirebase() {
    try {
        const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_API_BASE64;
        if (!serviceAccountBase64) {
            console.error("❌ FIREBASE_SERVICE_ACCOUNT_API_BASE64 not set in .env.");
            process.exit(1);
        }

        const serviceAccountJson = Buffer.from(serviceAccountBase64, 'base64').toString('utf8');
        const serviceAccount = JSON.parse(serviceAccountJson);

        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        db = admin.firestore();
        console.log("🔥 Firebase Admin Initialized");
    } catch (error) {
        console.error("❌ Error initializing Firebase Admin:", error.message);
        process.exit(1);
    }
}

// --- Helper: Delay to throttle API calls ---
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Gemini API calls (JSON only) ---
async function callGeminiAPI(payload) {
    if (!GEMINI_API_KEY) {
        console.error("❌ GEMINI_API_KEY missing.");
        return null;
    }
    try {
        const response = await fetch(GEMINI_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            console.error(`❌ Gemini API HTTP Error: ${response.status} ${response.statusText}`);
            return null;
        }
        const result = await response.json();
        const jsonText = result.candidates?.[0]?.content?.parts?.[0]?.text;

        if (jsonText) {
            try {
                // Safely parse JSON
                return JSON.parse(jsonText);
            } catch (jsonError) {
                console.error("❌ Failed to parse JSON response:", jsonError.message, "Raw Text:", jsonText.substring(0, Math.min(jsonText.length, 100)) + (jsonText.length > 100 ? "..." : ""));
                return null;
            }
        }
        return null;

    } catch (err) {
        console.error("❌ Gemini API call failed:", err.message);
        return null;
    }
}

async function classifyMessage(messageBody) {
    const systemPrompt = "You are an expert lead classifier. Respond ONLY with a JSON object { isLead: boolean, intent: string }.";
    const payload = {
        contents: [{ parts: [{ text: `Client Message: "${messageBody}"` }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: { responseMimeType: "application/json" }
    };
    const result = await callGeminiAPI(payload);
    console.log(`✅ Classification:`, result);
    return result || { isLead: false, intent: "Unknown" };
}

async function qualifyLead(messageBody, totalMessages, intent) {
    const systemPrompt = `You are a qualification specialist. Return JSON: { isQualified: boolean, priority: "Low"|"Medium"|"High" }.`;
    const payload = {
        contents: [{ parts: [{ text: `Current Message: "${messageBody}", Intent: "${intent}", Total Messages: ${totalMessages}` }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: { responseMimeType: "application/json" }
    };
    const result = await callGeminiAPI(payload);
    console.log(`⭐ Qualification:`, result);
    return result || { isQualified: false, priority: "Low" };
}

async function extractData(messageBody) {
    const systemPrompt = "Extract only Name and Email. Return { name: string|null, email: string|null }.";
    const payload = {
        contents: [{ parts: [{ text: `Client Message: "${messageBody}"` }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: { responseMimeType: "application/json" }
    };
    const result = await callGeminiAPI(payload);
    console.log(`🕵️‍♂️ Extraction:`, result);
    return result || { name: null, email: null };
}

// --- Dedicated Text Generation for Reply (FIX: Uses direct fetch for text output) ---
async function generateReply(messageBody, intent, isReturningClient, isQualified, missingName, missingEmail) {
    const systemPrompt = isQualified
        ? (missingName || missingEmail
            ? `Ask for missing info (name and/or email). Keep reply <= 3 sentences.`
            : `Confirm info received. Reply in 1 sentence.`)
        : `Answer query concisely, offer call. Keep reply <=5 sentences.`;

    const payload = {
        contents: [{ parts: [{ text: `Client Message: "${messageBody}"` }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] }
    };
    
    try {
        const response = await fetch(GEMINI_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            console.error(`❌ Reply API HTTP Error: ${response.status} ${response.statusText}`);
            return "Thank you. We'll get back shortly.";
        }
        const result = await response.json();
        const replyText = result.candidates?.[0]?.content?.parts?.[0]?.text;
        
        console.log(`💬 Reply Generated: ${replyText ? replyText.substring(0, Math.min(replyText.length, 50)) + "..." : "Default"}`);
        
        return replyText || "Thank you. We'll get back shortly.";
    } catch (err) {
        console.error("❌ Reply generation failed:", err.message);
        return "Thank you. We'll get back shortly.";
    }
}

// --- Main Processor ---
async function processMessage(doc) {
    const message = doc.data();
    const docId = doc.id;
    const userId = message.userId || "unknown_user";
    const phoneNumber = message.phoneNumber || "unknown_phone";

    // Prevent duplicate processing
    if (message.processing) {
        console.log(`⏳ [${userId}] Skipping ${docId.substring(0, 10)}... already processing.`);
        return;
    }
    await doc.ref.update({ processing: true });

    try {
        console.log(`📨 [${userId}] Processing ${docId.substring(0, 10)}...`);

        const classification = await classifyMessage(message.body);
        await delay(200); // Throttle API

        let isReturningClient = false;
        let totalMessages = 1;
        let isQualified = false;
        let leadPriority = "Low";

        // Qualified Lead Data Storage
        let qualifiedLeadDocRef = null;
        let currentLeadData = { name: null, email: null };

        // Check existing lead
        if (classification.isLead) {
            const existingLeadSnap = await db.collection(LEADS_COLLECTION)
                .where('userId', '==', userId)
                .orderBy('timestamp', 'desc')
                .limit(1)
                .get();

            isReturningClient = !existingLeadSnap.empty;
            if (isReturningClient) {
                totalMessages = (existingLeadSnap.docs[0].data().messageCount || 1) + 1;
            }

            // Check existing qualified lead
            const existingQualifiedSnap = await db.collection(QUALIFIED_LEADS_COLLECTION)
                .where('userId', '==', userId)
                .limit(1)
                .get();

            if (!existingQualifiedSnap.empty) {
                // Lead is already qualified
                qualifiedLeadDocRef = existingQualifiedSnap.docs[0].ref;
                currentLeadData = existingQualifiedSnap.docs[0].data();
                isQualified = true;
                leadPriority = currentLeadData.priority || "High";
            } else {
                // Qualification needed
                const qual = await qualifyLead(message.body, totalMessages, classification.intent);
                isQualified = qual.isQualified;
                leadPriority = qual.priority;
                await delay(200);
            }

            let extractedData = { name: null, email: null };

            // Extraction if qualified and data is missing
            if (isQualified) {
                const missingName = !currentLeadData.name;
                const missingEmail = !currentLeadData.email;
                
                if (missingName || missingEmail) {
                    // Only run extraction if we are missing name or email
                    extractedData = await extractData(message.body);
                    await delay(200);

                    // Update local data with newly extracted info
                    currentLeadData.name = currentLeadData.name || extractedData.name;
                    currentLeadData.email = currentLeadData.email || extractedData.email;
                }
            }
            
            // Re-check missing fields after (potential) extraction for reply generation
            const missingName = !currentLeadData.name;
            const missingEmail = !currentLeadData.email;

            // Generate Reply
            const autoReply = await generateReply(
                message.body,
                classification.intent,
                isReturningClient,
                isQualified,
                missingName,
                missingEmail
            );
            await delay(200);

            // Save/Update qualified lead
            if (isQualified) {
                const qualifiedLeadUpdate = {
                    userId,
                    phoneNumber,
                    rawMessageId: docId,
                    intent: classification.intent,
                    priority: leadPriority,
                    messageCount: totalMessages,
                    autoReplyText: autoReply,
                    name: currentLeadData.name,
                    email: currentLeadData.email,
                    timestamp: admin.firestore.Timestamp.now()
                };

                if (!qualifiedLeadDocRef) {
                    // Create new qualified lead record
                    await db.collection(QUALIFIED_LEADS_COLLECTION).add(qualifiedLeadUpdate);
                    console.log(`🚀 [${userId}] New qualified lead created.`);
                } else {
                    // Update existing qualified lead record (only necessary fields)
                    await qualifiedLeadDocRef.update({
                        name: currentLeadData.name, // Will update if it was null before
                        email: currentLeadData.email, // Will update if it was null before
                        messageCount: totalMessages,
                        lastActive: admin.firestore.Timestamp.now()
                    });
                    console.log(`⭐ [${userId}] Qualified lead updated.`);
                }
            }

            // Save/update general lead
            if (!isReturningClient) {
                await db.collection(LEADS_COLLECTION).add({
                    userId,
                    phoneNumber,
                    intent: classification.intent,
                    firstMessageBody: message.body,
                    messageCount: totalMessages,
                    timestamp: admin.firestore.Timestamp.now()
                });
                console.log(`✅ [${userId}] New lead saved.`);
            } else if (isReturningClient) {
                await existingLeadSnap.docs[0].ref.update({
                    intent: classification.intent,
                    messageCount: totalMessages,
                    lastActive: admin.firestore.Timestamp.now()
                });
            }

            // Update raw message
            await doc.ref.update({
                processed: true,
                isLead: classification.isLead,
                isQualified,
                priority: leadPriority,
                autoReplyText: autoReply,
                messageCount: totalMessages,
                processing: false
            });
            console.log(`✅ [${userId}] Raw message updated.`);

        } else {
            await doc.ref.update({ processed: true, processing: false });
            console.log(`❌ [${userId}] Not a lead. Marked processed.`);
        }

    } catch (err) {
        // Catches errors specific to the message processing loop
        console.error(`❌ [${userId}] Processing failed for ${docId}:`, err.message);
        await doc.ref.update({ processing: false });
    }
}

// --- Start Listener ---
function startLeadProcessor() {
    if (!db) {
        console.error("❌ Firestore not initialized.");
        return;
    }

    console.log(`🔄 Starting live queue monitor on '${RAW_MESSAGES_COLLECTION}'`);

    // Listen for new, unprocessed messages (processed == false) AND not currently being processed (processing == false)
    db.collection(RAW_MESSAGES_COLLECTION)
        .where('processed', '==', false)
        .where('processing', '==', false)
        .onSnapshot(async snapshot => {
            for (const change of snapshot.docChanges()) {
                if (change.type === 'added' || (change.type === 'modified' && change.doc.data().processed === false && change.doc.data().processing === false)) {
                    // Process 'added' and 'modified' that may appear due to failed processing/re-queue
                    await processMessage(change.doc);
                }
            }
        });
}

// --- Execute ---
initializeFirebase();
startLeadProcessor();
