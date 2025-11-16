// ai-processor/index.js
// This service monitors new messages in Firestore, classifies them using Gemini, 
// and prepares an auto-reply for the WhatsApp client to execute.

require('dotenv').config(); 
const admin = require('firebase-admin');

// --- Global Variables ---
const RAW_MESSAGES_COLLECTION = 'raw_messages';
const LEADS_COLLECTION = 'leads';
const QUALIFIED_LEADS_COLLECTION = 'qualified_leads'; // <--- ADDED: New collection for high-value leads

// --- Gemini API Configuration ---
// NOTE: We assume the GEMINI_API_KEY is available in your .env file
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_API_MODEL = "gemini-2.5-flash"; // Using flash for speed and classification capability
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_API_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
const MAX_RETRIES = 3;

let db;


// --- Firebase Initialization ---
function initializeFirebase() {
    try {
        const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_API_BASE64;
        
        if (!serviceAccountBase64) {
            console.error("❌ AI Processor: FIREBASE_SERVICE_ACCOUNT_API_BASE64 not set in .env.");
            process.exit(1);
        }

        const serviceAccountJson = Buffer.from(serviceAccountBase64, 'base64').toString('utf8');
        const serviceAccount = JSON.parse(serviceAccountJson);

        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        db = admin.firestore();
        console.log("🔥 AI Processor: Firebase Admin Initialized");
        
    } catch (error) {
        console.error("❌ AI Processor: Error initializing Firebase Admin (check Base64 encoding/JSON format):", error.message);
        process.exit(1);
    }
}


/**
 * Calls Gemini to classify the lead and return a structured JSON object.
 */
async function callGeminiForClassification(messageBody) {
    if (!GEMINI_API_KEY) {
        console.error("❌ GEMINI_API_KEY is missing. Cannot call AI service.");
        return { isLead: false, intent: "API Key Missing" };
    }
    
    console.log(`\n🤖 AI: Classifying message: "${messageBody.substring(0, 50)}..."`);
    
    const systemPrompt = "You are an expert lead classifier for an immigration consulting firm. Your task is to analyze the client's message and determine if it is a qualified sales lead (i.e., requesting a service, consultation, or general inquiry about visa/immigration) or if it is spam/a system message. Respond ONLY with a JSON object conforming to the schema. Do NOT include any extra text, markdown wrappers (like ```json), or explanations.";
    const userQuery = `Client Message: "${messageBody}"`;
    
    // Define the required JSON output structure (Structured Output)
    const responseSchema = {
        type: "OBJECT",
        properties: {
            "isLead": { "type": "BOOLEAN", "description": "True if the message is a qualified lead asking for service/consultation." },
            "intent": { "type": "STRING", "description": "A concise description of the client's goal (e.g., 'Student Visa Enquiry', 'PR Application Question', 'General Greeting')." }
        },
        "required": ["isLead", "intent"]
    };

    const payload = {
        contents: [{ parts: [{ text: userQuery }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: {
            responseMimeType: "application/json",
            responseSchema: responseSchema,
        }
    };

    try {
        const response = await fetch(GEMINI_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorBody = await response.text();
            console.error(`❌ AI API HTTP Error: Status ${response.status} ${response.statusText}`);
            console.error(`--- Raw API Error Body ---:\n${errorBody.substring(0, 500)}`);
            return { isLead: false, intent: "API Error" };
        }
        
        const result = await response.json();
        const candidate = result.candidates?.[0];
        const jsonText = candidate?.content?.parts?.[0]?.text;
        
        if (!jsonText) {
             return { isLead: false, intent: "No JSON Part" };
        }
        
        const classification = JSON.parse(jsonText);
        console.log(`✅ AI Classification Result: isLead=${classification.isLead}, Intent='${classification.intent}'`);
        
        return classification;

    } catch (error) {
        console.error("❌ AI Classification failed during fetch/parse:", error.message);
        return { isLead: false, intent: "Classification Error" }; // Default safe value
    }
}


// --- NEW FUNCTION: LEAD QUALIFICATION ---

/**
 * Calls Gemini to evaluate if the conversation shows enough interest to be considered a Qualified Lead.
 * @param {string} currentMessage - The current client message.
 * @param {number} totalMessagesFromClient - Total number of messages received from this user.
 * @param {string} currentIntent - The current classified intent.
 * @returns {Promise<{isQualified: boolean, priority: 'Low' | 'Medium' | 'High'}>}
 */
async function callGeminiForQualification(currentMessage, totalMessagesFromClient, currentIntent) {
    
    // Logic: If client has sent 3+ messages AND the intent is specific, set isQualified to true.
    const systemPrompt = `You are a qualification specialist. Analyze the client's current message, their intent, and the length of the conversation (${totalMessagesFromClient} messages). Determine if the client is highly engaged and genuinely interested in moving forward (e.g., asking about next steps, costs, timelines, or follow-up questions). 
    If the client has sent 3 or more messages AND the intent is specific (not just a greeting), set 'isQualified' to true. Set 'priority' based on engagement: 'High' for 3+ specific messages, 'Medium' for 2, 'Low' for 1. Respond ONLY with a JSON object conforming to the schema.`;
    
    const userQuery = `Current Message: "${currentMessage}". Current Intent: "${currentIntent}". Total Messages in Thread: ${totalMessagesFromClient}`;

    const responseSchema = {
        type: "OBJECT",
        properties: {
            "isQualified": { "type": "BOOLEAN", "description": "True if the client shows high engagement and is ready for next steps/data collection." },
            "priority": { "type": "STRING", "description": "The lead priority, based on engagement: 'Low', 'Medium', or 'High'." }
        },
        "required": ["isQualified", "priority"]
    };
    
    const payload = {
        contents: [{ parts: [{ text: userQuery }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: {
            responseMimeType: "application/json",
            responseSchema: responseSchema,
        }
    };

    try {
        const response = await fetch(GEMINI_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const result = await response.json();
        const jsonText = result.candidates?.[0]?.content?.parts?.[0]?.text;
        
        if (!jsonText) throw new Error("No JSON part received for qualification.");
        
        const qualification = JSON.parse(jsonText);
        console.log(`⭐ AI Qualification Result: isQualified=${qualification.isQualified}, Priority='${qualification.priority}'`);
        
        return qualification;
    } catch (error) {
        console.error("❌ AI Qualification failed:", error.message);
        return { isQualified: false, priority: "Low" };
    }
}


// --- NEW FUNCTION: DATA EXTRACTION ---
/**
 * Calls Gemini to extract Name and Email from the client message.
 * @param {string} messageBody - The text of the client message.
 * @returns {Promise<{name: string | null, email: string | null}>}
 */
async function callGeminiForExtraction(messageBody) {
    if (!GEMINI_API_KEY) return { name: null, email: null };

    console.log(`\n🕵️‍♂️ AI: Attempting to extract contact data from: "${messageBody.substring(0, 50)}..."`);
    
    const systemPrompt = "You are an expert data parser. Analyze the user's message and strictly extract only their full name and a valid email address. If a value is not found or is ambiguous, return null for that field. Respond ONLY with a JSON object conforming to the schema. Do NOT include any extra text or markdown.";
    const userQuery = `Client Message: "${messageBody}"`;
    
    const responseSchema = {
        type: "OBJECT",
        properties: {
            "name": { "type": "STRING", "description": "The client's full name, or null if not found." },
            "email": { "type": "STRING", "description": "The client's email address, or null if not found." }
        },
        "required": ["name", "email"]
    };

    const payload = {
        contents: [{ parts: [{ text: userQuery }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: {
            responseMimeType: "application/json",
            responseSchema: responseSchema,
        }
    };

    try {
        const response = await fetch(GEMINI_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) throw new Error(`HTTP Error: ${response.status} ${response.statusText}`);
        
        const result = await response.json();
        const jsonText = result.candidates?.[0]?.content?.parts?.[0]?.text;
        
        if (!jsonText) return { name: null, email: null };
        
        const extractedData = JSON.parse(jsonText);
        console.log(`✅ AI Extraction Result: Name='${extractedData.name}', Email='${extractedData.email}'`);
        
        return extractedData;

    } catch (error) {
        console.error("❌ AI Extraction failed:", error.message);
        return { name: null, email: null };
    }
}


/**
 * Calls Gemini to generate a professional auto-reply.
 * @param {string} messageBody - The original client message.
 * @param {string} intent - The classified intent.
 * @param {boolean} isReturningClient - True if client has an existing record. 
 * @param {boolean} isQualified - True if the lead is highly engaged. 
 * @param {boolean} missingName - True if name is still needed.
 * @param {boolean} missingEmail - True if email is still needed.
 * @returns {Promise<string>} - The generated reply text.
 */
async function callGeminiForReply(messageBody, intent, isReturningClient = false, isQualified = false, missingName = true, missingEmail = true) { 
    if (!GEMINI_API_KEY) return "Reply failed: API Key Missing.";

    console.log(`🤖 AI: Generating reply (Qualified: ${isQualified}, Missing Name: ${missingName}, Missing Email: ${missingEmail})`);
    
    let systemPrompt;
    
    if (isQualified && (missingName || missingEmail)) {
        // --- Qualification Data Collection Prompt ---
        let promptPart = "";
        
        if (missingName && missingEmail) {
            promptPart = "State that to confirm their consultation slot, you now need to collect their Full Name and Email Address.";
        } else if (missingName) {
            promptPart = "Acknowledge the contact information received and ask ONLY for their Full Name to complete the registration.";
        } else if (missingEmail) {
            promptPart = "Acknowledge the contact information received and ask ONLY for their Email Address to complete the registration.";
        }
        
        systemPrompt = `You are a professional immigration consultant's assistant. Acknowledge the client's response. ${promptPart} Conclude by confirming you will use their current phone number for the call. Keep the response professional and encouraging. The reply must be no more than three sentences.`;

    } else if (isQualified && !missingName && !missingEmail) {
        // --- Qualification Complete Prompt ---
        systemPrompt = `You are a professional immigration consultant's assistant. Congratulate the client for providing all necessary information (Name and Email). Confirm that their details have been saved and state that a consultant specializing in their **${intent}** query will call them shortly on their number. The reply must be one single sentence.`;
    } else {
        // --- Standard Reply Prompt (Answer Question + Suggest Call) ---
        const baseRequirement = `Your primary goal is to **answer the client's direct question** as concisely and informatively as possible. For complex queries, provide a brief summary of 3-4 key points. Conclude your message by offering to schedule a personalized call to discuss their specific profile and next steps. The total reply must be no more than five sentences.`;
        
        if (isReturningClient) {
            systemPrompt = `You are a professional, friendly, and efficient immigration consultant's assistant. Acknowledge that they have contacted us before and thank them for reaching out again with the intent: "${intent}". ${baseRequirement}`;
        } else {
            systemPrompt = `You are a professional, friendly, and efficient immigration consultant's assistant. Acknowledge their interest in the identified intent: "${intent}". ${baseRequirement}`;
        }
    }

    const userQuery = `The client's message was: "${messageBody}".`;

    const payload = {
        contents: [{ parts: [{ text: userQuery }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] }
    };

    try {
        const response = await fetch(GEMINI_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        if (!response.ok) throw new Error(`HTTP Error: ${response.status} ${response.statusText}`);

        const result = await response.json();
        
        const replyText = result.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!replyText) throw new Error("Gemini returned no reply text.");

        return replyText;

    } catch (error) {
        console.error("❌ AI Reply Generation failed:", error.message);
        return "Thank you for your message. We are currently experiencing high volume but will reply to your inquiry shortly!";
    }
}


/**
 * Main processor loop. Sets up a listener for unprocessed messages.
 */
function startLeadProcessor() {
    if (!db) {
        console.error("AI Processor cannot start: Firestore DB not initialized.");
        return;
    }

    const q = db.collection(RAW_MESSAGES_COLLECTION)
        .where('processed', '==', false);

    console.log(`\n🔄 AI Processor: Starting live queue monitor on '${RAW_MESSAGES_COLLECTION}'.`);

    q.onSnapshot(async (snapshot) => {
        snapshot.docChanges().forEach(async (change) => {
            if (change.type === "added") {
                const doc = change.doc;
                const message = doc.data();
                const docId = doc.id;

                const userId = message.userId || "unknown_user";
                const phoneNumber = message.phoneNumber || "unknown_phone";

                console.log(`📨 [${userId}] Processing message ${docId.substring(0, 10)}...`);

                // --- Step 1: Classification ---
                const classification = await callGeminiForClassification(message.body);

                let autoReplyText = null;
                let isReturningClient = false; 
                let totalMessagesFromClient = 0;
                let isQualified = false; 
                let leadPriority = "Low";
                
                let qualifiedLeadRecord = null; // To hold the existing qualified lead data (if any)

                // --- Step 2: Get Context & Total Messages from LEADS_COLLECTION ---
                let existingLeadSnapshot = null; 

                if (classification.isLead) {
                    existingLeadSnapshot = await db.collection(LEADS_COLLECTION)
                        .where('userId', '==', userId)
                        .orderBy('timestamp', 'desc') 
                        .limit(1)
                        .get();
                    
                    isReturningClient = !existingLeadSnapshot.empty;
                    
                    if (isReturningClient) {
                        totalMessagesFromClient = existingLeadSnapshot.docs[0].data().messageCount || 1;
                    }
                    totalMessagesFromClient += 1; // Increment for the current message
                    console.log(`🔍 [${userId}] Is returning client: ${isReturningClient}, Total Messages: ${totalMessagesFromClient}`);
                    
                    // --- Check for existing QUALIFIED_LEAD record ---
                    const existingQualifiedLead = await db.collection(QUALIFIED_LEADS_COLLECTION)
                        .where('userId', '==', userId)
                        .limit(1)
                        .get();
                        
                    if (!existingQualifiedLead.empty) {
                        qualifiedLeadRecord = existingQualifiedLead.docs[0];
                        isQualified = true; // Once they are in this collection, they are qualified
                        leadPriority = qualifiedLeadRecord.data().priority || "High"; // Retain priority
                        console.log(`⭐ [${userId}] Found existing qualified lead record: ${qualifiedLeadRecord.id}`);
                    }
                }
                
                // --- Step 3: Qualification Check (Only if classified as a lead AND not already qualified) ---
                if (classification.isLead && !isQualified) {
                    const qualificationResult = await callGeminiForQualification(message.body, totalMessagesFromClient, classification.intent);
                    isQualified = qualificationResult.isQualified;
                    leadPriority = qualificationResult.priority;
                }

                // --- Step 4: Data Extraction and Update (If Qualified) ---
                let missingName = true;
                let missingEmail = true;

                if (isQualified) {
                    const extractedData = await callGeminiForExtraction(message.body);
                    let updateQualifiedData = {};
                    
                    if (qualifiedLeadRecord) {
                        // Check status against the existing record
                        const currentName = qualifiedLeadRecord.data().name;
                        const currentEmail = qualifiedLeadRecord.data().email;

                        // Logic to update missing fields
                        if (!currentName && extractedData.name) {
                            updateQualifiedData.name = extractedData.name;
                        } else if (currentName) {
                            missingName = false;
                        }
                        
                        if (!currentEmail && extractedData.email) {
                            updateQualifiedData.email = extractedData.email;
                        } else if (currentEmail) {
                            missingEmail = false;
                        }
                        
                        // Check again if the fields are still missing after potential extraction from THIS message
                        missingName = missingName && !updateQualifiedData.name;
                        missingEmail = missingEmail && !updateQualifiedData.email;
                        
                        // Perform update on existing qualified record
                        if (Object.keys(updateQualifiedData).length > 0) {
                            await qualifiedLeadRecord.ref.update(updateQualifiedData);
                            console.log(`✅ [${userId}] Updated qualified lead record with new data.`);
                        }

                    } else if (extractedData.name || extractedData.email) {
                        // This is the first message that qualified the lead and contained data.
                        missingName = !extractedData.name;
                        missingEmail = !extractedData.email;
                        
                        // No record exists yet, so we don't update here, we create in the next step (Step 6).
                        // The extracted data will be included in the creation payload.
                    }
                }
                
                // --- Step 5: Define newLead status & Update Data Object ---
                const newLead = classification.isLead && !isReturningClient;

                let updateData = {
                    processed: true,
                    isLead: classification.isLead,
                    newLead: newLead, 
                    userId,      
                    phoneNumber,  
                    intent: classification.intent, 
                    messageCount: totalMessagesFromClient, 
                    isQualified: isQualified, 
                    priority: leadPriority, 
                };

                // --- Step 6: Generate Auto Reply ---
                if (classification.isLead) {
                    if (!["Classification Error", "API Error", "API Key Missing", "No Candidate", "No JSON Part"].includes(classification.intent)) {
                        
                        // Pass qualification status AND missing data status to generate the right response
                        autoReplyText = await callGeminiForReply(message.body, classification.intent, isReturningClient, isQualified, missingName, missingEmail); 

                        updateData.replyPending = true;
                        updateData.autoReplyText = autoReplyText;

                        // --- Step 7: Save/Update Lead Records ---
                        if (isQualified && !qualifiedLeadRecord) {
                            // Save to the high-value collection for the FIRST time
                            await db.collection(QUALIFIED_LEADS_COLLECTION).add({
                                userId,         
                                phoneNumber,
                                rawMessageId: docId,
                                contactId: message.from,
                                intent: classification.intent,
                                lastMessageBody: message.body,
                                priority: leadPriority,
                                messageCount: totalMessagesFromClient,
                                autoReplyText: autoReplyText,
                                timestamp: admin.firestore.Timestamp.now(),
                                // Include any data extracted from this first qualifying message
                                name: extractedData?.name || null,
                                email: extractedData?.email || null,
                            });
                            console.log(`🚀 [${userId}] HIGHLY QUALIFIED LEAD created in '${QUALIFIED_LEADS_COLLECTION}'.`);
                        }
                        
                        // Maintain/Update the general LEADS_COLLECTION record for message count and intent tracking
                        if (newLead) { 
                             // Only save initial record to LEADS_COLLECTION if new client
                            await db.collection(LEADS_COLLECTION).add({
                                userId,         
                                phoneNumber,
                                contactId: message.from,
                                intent: classification.intent,
                                firstMessageBody: message.body,
                                messageCount: totalMessagesFromClient,
                                timestamp: admin.firestore.Timestamp.now(),
                            });
                            console.log(`✅ [${userId}] NEW Lead saved to '${LEADS_COLLECTION}'.`);
                        } else if (isReturningClient && existingLeadSnapshot.docs[0]) {
                            // Update the existing LEADS_COLLECTION record
                            await existingLeadSnapshot.docs[0].ref.update({
                                intent: classification.intent, 
                                messageCount: totalMessagesFromClient,
                                lastActive: admin.firestore.Timestamp.now(),
                            });
                        }

                    } else {
                        console.log(`❌ [${userId}] Classification failed internally. Skipping auto-reply.`);
                    }
                } else {
                    console.log(`❌ [${userId}] Classified as not a lead.`);
                }

                // --- Step 8: Update raw message ---
                await db.collection(RAW_MESSAGES_COLLECTION).doc(docId).update(updateData);
                console.log(`✅ [${userId}] Updated raw message ${docId.substring(0, 10)} with processed status.`);
            }
        });
    });
}


// --- Execute Main Function ---
initializeFirebase();
startLeadProcessor();
