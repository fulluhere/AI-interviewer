// backend/controllers/sessionController.js
import asyncHandler from 'express-async-handler';
import Session from '../models/SessionModel.js';
import fetch from 'node-fetch'; // Standard for making HTTP requests (npm install node-fetch@2.6.1)
import fs from 'fs'; // <-- NEW: For reading and deleting the temporary file
import FormData from 'form-data'; // <-- NEW: For sending files to FastAPI
import path from 'path';
import mongoose from 'mongoose';
// URL for the Python AI Microservice (Must match Step 6 setup)
const AI_SERVICE_URL = 'http://localhost:8000';

// Helper function to send an update via Socket.io
const pushSocketUpdate = (io, userId, sessionId, status, message, session = null) => {
    // We target the user by their ID, assuming the user's socket is joined to a room named after their userId
    // (This room setup must be done on socket connection, which we will address later in server.js)
    io.to(userId.toString()).emit('sessionUpdate', {
        sessionId,
        status, // e.g., 'AI_GENERATING_QUESTIONS', 'QUESTIONS_READY', 'EVALUATION_FAILED'
        message,
        session,
    });
};

// @desc    Create a new interview session and start AI question generation
// @route   POST /api/sessions/
// @access  Private
const createSession = asyncHandler(async (req, res) => {
    const {
        role,
        level,
        interviewType,
        count,
        interviewMode = 'general',
        knowledgeBaseId = null
    } = req.body;

    const userId = req.user._id;

    if (!role || !level || !interviewType || !count) {
        res.status(400);
        throw new Error('Please specify role, level, interview type, and question count.');
    }

    if (!['general', 'knowledge-based'].includes(interviewMode)) {
        res.status(400);
        throw new Error('Invalid interview mode.');
    }

    if (interviewMode === 'knowledge-based' && !knowledgeBaseId) {
        res.status(400);
        throw new Error('Please select a knowledge base for a knowledge-based interview.');
    }

    if (interviewMode === 'general' && knowledgeBaseId) {
        res.status(400);
        throw new Error('General interviews cannot specify a knowledge base.');
    }

    // 1. Create the session placeholder in MongoDB
    let session = await Session.create({
        user: userId,
        role,
        level,
        interviewType,
        interviewMode,
        knowledgeBaseId,
        status: 'pending',
    });

    const io = req.app.get('io');

    // 2. Immediately respond to the client (Latency Management)
    res.status(202).json({
        message: 'Session created. Generating questions asynchronously...',
        sessionId: session._id,
        status: 'processing',
    });

    // --- ASYNCHRONOUS BACKGROUND TASK START ---

    // Using a self-executing async function to run the process in the background
    (async () => {
        try {
            // A. Notify the user via Socket.io that processing has started
            pushSocketUpdate(io, userId, session._id, 'AI_GENERATING_QUESTIONS', `Generating ${count} questions for ${role}...`);

            // B. Call the Python AI Microservice
            // backend/controllers/sessionController.js inside createSession
            const aiResponse = await fetch(`${AI_SERVICE_URL}/generate-questions`, {
                method: 'POST',
                headers: {
    'Content-Type': 'application/json',
    'x-ai-service-key': process.env.AI_SERVICE_API_KEY
},
                body: JSON.stringify({
                    role,
                    level,
                    count,
                    interview_type: interviewType,
                    interview_mode: interviewMode,
                    knowledge_base_id: knowledgeBaseId,
                    user_id: String(userId)
                }),
            });

            if (!aiResponse.ok) {
                // If the AI service returns a non-200 status
                const errorBody = await aiResponse.text();
                throw new Error(`AI Service error: ${aiResponse.status} - ${errorBody}`);
            }

            const aiData = await aiResponse.json();
            const codingCount = interviewType === 'coding-mix' ? Math.floor(count * 0.2) : 0;
            // C. Map the raw questions into the structured Mongoose sub-document format
            const questionsArray = aiData.questions.map((qText, index) => ({
                questionText: qText,
                questionType: index < codingCount ? 'coding' : 'oral',
                isEvaluated: false,
                isSubmitted: false,
            }));

            // D. Update the session in MongoDB
            session.questions = questionsArray;
            session.status = 'in-progress';
            await session.save();

            // E. Push final result back to the client via Socket.io
            pushSocketUpdate(io, userId, session._id, 'QUESTIONS_READY', 'Questions generated successfully. Starting session.', session);

        } catch (error) {
            console.error(`Session Creation Failure for ${session._id}:`, error.message);

            // F. Handle failure: Update status and notify client
            session.status = 'failed';
            await session.save();
            pushSocketUpdate(io, userId, session._id, 'GENERATION_FAILED', `Question generation failed. Reason: ${error.message}.`);
        }
    })();
});

// @desc    Get all interview sessions for the current user
// @route   GET /api/sessions/
// @access  Private
const getSessions = asyncHandler(async (req, res) => {
    // Find all sessions for the logged-in user, sorted by newest first
    const sessions = await Session.find({ user: req.user._id })
        .sort({ createdAt: -1 })
        .select('-questions.userAnswerText -questions.userSubmittedCode'); // Exclude heavy data for list view
    res.json(sessions);
});

// @desc    Get a specific session detail
// @route   GET /api/sessions/:id
// @access  Private
const getSessionById = asyncHandler(async (req, res) => {
    // Find session by ID and ensure it belongs to the logged-in user
    const session = await Session.findOne({ _id: req.params.id, user: req.user._id });

    if (session) {
        res.json(session);
    } else {
        res.status(404);
        throw new Error('Session not found or user unauthorized.');
    }
});

// @desc    Delete a session
// @route   DELETE /api/sessions/:id
// @access  Private
const deleteSession = asyncHandler(async (req, res) => {
    const session = await Session.findById(req.params.id);

    if (!session) {
        res.status(404);
        throw new Error('Session not found');
    }

    // Check if the user owns this session
    if (session.user.toString() !== req.user.id) {
        res.status(401);
        throw new Error('Not authorized');
    }

    await session.deleteOne();

    res.status(200).json({ id: req.params.id });
});

const evaluateAnswerAsync = async (io, userId, sessionId, questionIndex, audioFilePath = null, code = null) => {
    // Initialize transcription as an empty string instead of null to avoid "null" text in AI prompts
    let transcription = ""; 

    const questionIdx = typeof questionIndex === 'string' ? parseInt(questionIndex, 10) : questionIndex;

    const session = await Session.findById(sessionId);
    if (!session) {
        console.error(`Session ${sessionId} not found`);
        return;
    }

    const question = session.questions[questionIdx];
    if (!question) {
        pushSocketUpdate(io, userId, sessionId, 'EVALUATION_FAILED', `Q${questionIdx + 1} not found.`, null);
        return;
    }

    // --- Phase 1: Transcription (Only if audio exists) ---
    if (audioFilePath) {
        try {
            pushSocketUpdate(io, userId, sessionId, 'AI_TRANSCRIBING', `Transcribing audio for Q${questionIdx + 1}...`);
            const formData = new FormData();
            formData.append('file', fs.createReadStream(audioFilePath));

            const transResponse = await fetch(`${AI_SERVICE_URL}/transcribe`, {
                method: 'POST',
                body: formData,
                headers: formData.getHeaders(),
            });

            if (!transResponse.ok) throw new Error('Transcription service failed');

            const transData = await transResponse.json();
            transcription = transData.transcription || "";
        } catch (error) {
            console.error(`Transcription Error: ${error.message}`);
            // We continue even if transcription fails so the code can still be evaluated
        } finally {
            if (audioFilePath && fs.existsSync(audioFilePath)) fs.unlinkSync(audioFilePath);
        }
    }

    // --- Phase 2: AI Evaluation ---
    try {
        pushSocketUpdate(io, userId, sessionId, 'AI_EVALUATING', `AI is analyzing Q${questionIdx + 1}...`);

                const evalResponse = await fetch(`${AI_SERVICE_URL}/evaluate`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-ai-service-key': process.env.AI_SERVICE_API_KEY
            },
            body: JSON.stringify({
                question: question.questionText,
                question_type: question.questionType,
                role: session.role,
                level: session.level,
                user_answer: transcription,
                user_code: code || "",

                // RAG interview context
                interview_mode: session.interviewMode || 'general',
                knowledge_base_id: session.knowledgeBaseId || null,
                user_id: String(session.user)
            }),
        });

        if (!evalResponse.ok) throw new Error('AI Evaluation service failed');

        const evalData = await evalResponse.json();

        // --- Phase 3: Correct MongoDB Mapping ---
        // Store them strictly in their respective fields
        question.userAnswerText = transcription; 
        question.userSubmittedCode = code || ""; 

        question.technicalScore = evalData.technicalScore;
        question.confidenceScore = evalData.confidenceScore;
        question.aiFeedback = evalData.aiFeedback;
        question.idealAnswer = evalData.idealAnswer;
        question.isEvaluated = true;


        // --- Phase 4: Generate Adaptive Follow-up ---
        const existingFollowUp = session.questions.some(
            (q) =>
                q.parentQuestionId &&
                q.parentQuestionId.toString() === question._id.toString()
        );

        if (
            !existingFollowUp &&
            (question.followUpDepth || 0) < 2 &&
            session.status !== 'completed'
        ) {
            try {
                pushSocketUpdate(
                    io,
                    userId,
                    sessionId,
                    'AI_GENERATING_FOLLOW_UP',
                    `Generating an adaptive follow-up for Q${questionIdx + 1}...`
                );

                const followUpResponse = await fetch(
                    `${AI_SERVICE_URL}/generate-followup`,
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-ai-service-key': process.env.AI_SERVICE_API_KEY
                        },
                        body: JSON.stringify({
                            question: question.questionText,
                            question_type: question.questionType,
                            role: session.role,
                            level: session.level,
                            user_answer: transcription || '',
                            user_code: code || '',
                            technical_score: Number(evalData.technicalScore) || 0,
                            confidence_score: Number(evalData.confidenceScore) || 0,
                            ai_feedback: evalData.aiFeedback || '',
                            ideal_answer: evalData.idealAnswer || '',
                            follow_up_depth: question.followUpDepth || 0,

                            // RAG interview context
                            interview_mode: session.interviewMode || 'general',
                            knowledge_base_id: session.knowledgeBaseId || null,
                            user_id: String(session.user)
                        })
                    }
                );

                if (!followUpResponse.ok) {
                    throw new Error('Follow-up generation service failed');
                }

                const followUpData = await followUpResponse.json();

                if (
                    followUpData.should_follow_up &&
                    followUpData.follow_up_question?.trim()
                ) {
                    question.followUpCount = (question.followUpCount || 0) + 1;

                    session.questions.push({
                        questionText: followUpData.follow_up_question.trim(),
                        questionType: question.questionType,
                        idealAnswer: 'pending',
                        isFollowUp: true,
                        parentQuestionId: question._id,
                        followUpDepth: (question.followUpDepth || 0) + 1,
                        followUpCount: 0
                    });

                    console.log(
                        `Follow-up generated for Q${questionIdx + 1}`
                    );
                } else {
                    console.log(
                        'No follow-up required:',
                        followUpData.reason
                    );
                }
            } catch (followUpError) {
                // Follow-up failure should not break normal evaluation
                console.error(
                    'Follow-up Generation Error:',
                    followUpError.message
                );
            }
        }

        // Check if all questions in the entire session are now evaluated
        const allQuestionsEvaluated = session.questions.every(q => q.isEvaluated);

        // RECALCULATION LOGIC: 
        if (session.status === 'completed' || allQuestionsEvaluated) {
            const scoreSummary = await calculateOverallScore(sessionId);

            session.overallScore = scoreSummary.overallScore || 0;
            session.metrics = {
                avgTechnical: scoreSummary.avgTechnical,
                avgConfidence: scoreSummary.avgConfidence,
            };

            if (allQuestionsEvaluated) {
                session.status = 'completed';
                session.endTime = session.endTime || new Date();
            }

            // Save the session (includes question update + global score update)
            await session.save();

            pushSocketUpdate(io, userId, sessionId, 'SESSION_COMPLETED', 'Scores finalized.', session);
        } else {
            // Normal behavior: User is still in the interview
            await session.save();
            pushSocketUpdate(io, userId, sessionId, 'EVALUATION_COMPLETE', `Feedback for Q${questionIdx + 1} is ready!`, session);
        }

    } catch (error) {
        console.error(`Evaluation Error: ${error.message}`);
        pushSocketUpdate(io, userId, sessionId, 'EVALUATION_FAILED', `Evaluation failed.`, session);
    }
};

// @desc    Submit an answer (Audio or Code)
// @route   POST /api/sessions/:id/submit-answer
// @access  Private
const submitAnswer = asyncHandler(async (req, res) => {
    const sessionId = req.params.id;
    const { questionIndex, code } = req.body; // Remove submissionType if not strictly needed
    const userId = req.user._id;

    const session = await Session.findById(sessionId);

    if (!session || session.user.toString() !== userId.toString()) {
        res.status(404);
        throw new Error('Session not found or user unauthorized.');
    }

    const questionIdx = parseInt(questionIndex, 10);
    const question = session.questions[questionIdx];

    if (!question) {
        res.status(400);
        throw new Error(`Question at index ${questionIdx} not found.`);
    }

    // --- NEW UNIFIED LOGIC ---
    let audioFilePath = null;
    if (req.file) {
        audioFilePath = path.join(process.cwd(), req.file.path);
    }

    // We no longer error out if one is missing; 
    // we take whatever is provided (audio, code, or both).
    const codeSubmission = code || null;

    // 1. Update status in DB
    question.isSubmitted = true;
    await session.save();

    // 2. Respond immediately
    res.status(202).json({
        message: 'Answer received. Processing asynchronously...',
        status: 'received',
    });

    const io = req.app.get('io');

    // 3. Start AI processing with BOTH potential inputs
    evaluateAnswerAsync(io, userId, sessionId, questionIdx, audioFilePath, codeSubmission);
});


const calculateOverallScore = async (sessionId) => {
    const results = await Session.aggregate([
        { $match: { _id: new mongoose.Types.ObjectId(sessionId) } },
        { $unwind: '$questions' },
        // REMOVED: { $match: { 'questions.isSubmitted': true } } 
        // We now keep all questions to ensure they are part of the average.
        {
            $group: {
                _id: '$_id',
                // If a question is evaluated, use its score; otherwise, use 0.
                avgTechnical: {
                    $avg: { $cond: [{ $eq: ['$questions.isEvaluated', true] }, '$questions.technicalScore', 0] }
                },
                avgConfidence: {
                    $avg: { $cond: [{ $eq: ['$questions.isEvaluated', true] }, '$questions.confidenceScore', 0] }
                }
            }
        },
        {
            $project: {
                _id: 0,
                // Overall score is the average of the technical and confidence averages across ALL questions.
                overallScore: { $round: [{ $avg: ['$avgTechnical', '$avgConfidence'] }, 0] },
                avgTechnical: { $round: ['$avgTechnical', 0] },
                avgConfidence: { $round: ['$avgConfidence', 0] },
            }
        }
    ]);

    return results[0] || { overallScore: 0, avgTechnical: 0, avgConfidence: 0 };
};
// @desc    End the session early
// @route   POST /api/sessions/:id/end
// @access  Private
const endSession = asyncHandler(async (req, res) => {
    const sessionId = req.params.id;
    const userId = req.user._id;

    const session = await Session.findById(sessionId);

    if (!session || session.user.toString() !== userId.toString()) {
        res.status(404);
        throw new Error('Session not found or user unauthorized.');
    }
    const isProcessing = session.questions.some(q => q.isSubmitted && !q.isEvaluated);
    if (isProcessing) {
        res.status(400);
        throw new Error('Cannot end interview while AI is processing answers.');
    }
    if (session.status === 'completed') {
        res.status(400);
        throw new Error('Session is already completed.');
    }

    // Calculate scores for evaluated questions
    const scoreSummary = await calculateOverallScore(sessionId);

    session.overallScore = scoreSummary.overallScore || 0;
    session.status = 'completed';
    session.endTime = new Date();
    session.metrics = {
        avgTechnical: scoreSummary.avgTechnical,
        avgConfidence: scoreSummary.avgConfidence,
    };

    await session.save();

    const io = req.app.get('io');
    pushSocketUpdate(io, userId, sessionId, 'SESSION_COMPLETED', 'Interview session ended early.', session);

    res.json({ message: 'Session ended successfully.', session });
});

export {
    createSession,
    getSessionById,
    getSessions,
    submitAnswer,
    endSession,
    calculateOverallScore,
    deleteSession,
    uploadKnowledgeBase
};

// @desc    Upload PDF and create a knowledge base
// @route   POST /api/sessions/knowledge-base/upload
// @access  Private
const uploadKnowledgeBase = asyncHandler(async (req, res) => {
    // 1. Check whether a PDF was uploaded
    if (!req.file) {
        res.status(400);
        throw new Error("Please upload a PDF file.");
    }

    // 2. Get authenticated user ID
    const userId = req.user._id.toString();

    // 3. Verify AI service configuration
    const apiKey = process.env.AI_SERVICE_API_KEY;

    if (!apiKey) {
        res.status(500);
        throw new Error("AI service API key is not configured.");
    }

    // 4. Prepare multipart form data for FastAPI
    const formData = new FormData();

    formData.append("file", req.file.buffer, {
        filename: req.file.originalname,
        contentType: req.file.mimetype
    });

    formData.append("user_id", userId);

    // Optional: reuse an existing knowledge base ID
    if (req.body.knowledge_base_id) {
        formData.append(
            "knowledge_base_id",
            req.body.knowledge_base_id
        );
    }

    // 5. Forward PDF to FastAPI
    const response = await fetch(`${AI_SERVICE_URL}/ingest-pdf`, {
        method: "POST",
        headers: {
            ...formData.getHeaders(),
            "x-ai-service-key": apiKey
        },
        body: formData
    });

    // 6. Read FastAPI response
    const result = await response.json();

    if (!response.ok) {
        return res.status(response.status).json({
            message: result.detail || "PDF processing failed."
        });
    }

    // 7. Return knowledge base details to frontend
    res.status(201).json(result);
});


