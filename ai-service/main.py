
import uvicorn
import os
import io
import json
import tempfile
import re

from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
from typing import Optional

import ollama
import whisper
from pydub import AudioSegment


# Load environment variables
load_dotenv()

AI_SERVICE_PORT = int(os.getenv("AI_SERVICE_PORT", 8000))
OLLAMA_MODEL_NAME = os.getenv("OLLAMA_MODEL_NAME", "qwen2.5:3b")

app = FastAPI(
    title="AI Interviewer Microservice",
    version="1.0"
)


# CORS Configuration
origins = ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Load Whisper Model
WHISPER_MODEL = None

try:
    print("Loading Whisper Model ...")
    WHISPER_MODEL = whisper.load_model("base.en")
    print("Whisper Model Loaded Successfully")

except Exception as e:
    print("Error while loading Whisper Model")
    print(e)


# Request and Response Models

class QuestionRequest(BaseModel):
    role: str = "MERN Stack Developer"
    level: str = "Junior"
    count: int = 5
    interview_type: str = "coding-mix"


class QuestionResponse(BaseModel):
    questions: list[str]
    model_used: str


class EvaluationRequest(BaseModel):
    question: str
    question_type: str
    role: str
    level: str
    user_answer: Optional[str] = None
    user_code: Optional[str] = None


class FollowUpRequest(BaseModel):
    question: str
    question_type: str
    role: str
    level: str
    user_answer: Optional[str] = None
    user_code: Optional[str] = None
    technical_score: int
    confidence_score: int
    ai_feedback: str
    ideal_answer: str
    follow_up_depth: int = 0


class FollowUpResponse(BaseModel):
    should_follow_up: bool
    follow_up_question: Optional[str] = None
    reason: str


class EvaluationResponse(BaseModel):
    technicalScore: int
    confidenceScore: int
    aiFeedback: str
    idealAnswer: str


# Root API

@app.get("/")
async def root():
    return {
        "message": "Hello from AI Interviewer Microservice!",
        "model": OLLAMA_MODEL_NAME
    }


# Generate Interview Questions

@app.post("/generate-questions", response_model=QuestionResponse)
async def generate_questions(request: QuestionRequest):

    try:
        if request.interview_type == "coding-mix":

            coding_count = int(request.count * 0.2)
            oral_count = request.count - coding_count

            instruction = (
                f"The first {coding_count} questions MUST be coding "
                "challenges requiring function implementation. "
                f"The remaining {oral_count} questions MUST be "
                "conceptual oral questions."
            )

        else:
            instruction = (
                "All questions MUST be conceptual oral questions. "
                "Do NOT generate any coding or implementation challenges."
            )

        system_prompt = (
            "You are a professional technical interviewer. "
            "Task: Generate interview questions. "
            "No conversational text or numbering. "
            f"Crucial: {instruction} "
            "Output exactly one question per line."
        )

        user_prompt = (
            f"Generate exactly {request.count} unique interview "
            f"questions for a {request.level} level {request.role}."
        )

        response = ollama.generate(
            model=OLLAMA_MODEL_NAME,
            prompt=user_prompt,
            system=system_prompt,
            options={"temperature": 0.6}
        )

        raw_text = response["response"].strip()

        questions = [
            q.strip()
            for q in raw_text.split("\n")
            if q.strip()
        ]

        return QuestionResponse(
            questions=questions[:request.count],
            model_used=OLLAMA_MODEL_NAME
        )

    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=str(e)
        )


# Audio Transcription API

@app.post("/transcribe")
async def transcribe_audio(file: UploadFile = File(...)):

    temp_audio_path = None

    try:
        audio_bytes = await file.read()

        audio_in_memory = io.BytesIO(audio_bytes)

        audio_segment = AudioSegment.from_file(audio_in_memory)

        with tempfile.NamedTemporaryFile(
            delete=False,
            suffix=".mp3"
        ) as tmp:

            temp_audio_path = tmp.name

        audio_segment.export(
            temp_audio_path,
            format="mp3"
        )

        if WHISPER_MODEL is None:
            raise HTTPException(
                status_code=503,
                detail="Whisper Model is not loaded"
            )

        result = WHISPER_MODEL.transcribe(temp_audio_path)

        return {
            "transcription": result["text"].strip()
        }

    except HTTPException:
        raise

    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=str(e)
        )

    finally:
        if temp_audio_path and os.path.exists(temp_audio_path):
            os.remove(temp_audio_path)


# Evaluate Candidate Answer

@app.post("/evaluate", response_model=EvaluationResponse)
async def evaluate(request: EvaluationRequest):

    try:
        if request.question_type == "oral":

            assessment_instruction = (
                "This is a conceptual oral question. "
                "Focus purely on the candidate's verbal explanation. "
                "Ignore any code blocks. "
                "CRITICAL: If the transcript is empty, nonsense "
                "(e.g. 'blah blah', 'testing') or irrelevant "
                "to the question, SCORE 0."
            )

        else:

            assessment_instruction = (
                "This is a coding challenge question. "
                "Evaluate the code logic and efficiency. "
                "Use the transcription only for insight into "
                "their thought process. "
                "CRITICAL: If the code is undefined, empty, "
                "just random comments, or random characters, SCORE 0."
            )

        system_prompt = (
            "You are a strict technical interviewer. "
            "Do NOT hallucinate positive reviews for bad input. "
            "RULE 1: If the answer is gibberish, irrelevant, "
            "or missing, return technicalScore: 0 "
            "and confidenceScore: 0. "
            "RULE 2: For idealAnswer, provide a clean Markdown "
            "string. Do NOT return a nested JSON object. "
            f"Context: {assessment_instruction} "
            "Respond ONLY with a JSON object. "
            "Required keys: technicalScore (0-100), "
            "confidenceScore (0-100), aiFeedback, idealAnswer."
        )

        user_prompt = (
            f"Role: {request.role}\n"
            f"Question: {request.question}\n"
            f"Level: {request.level}\n"
            f"Verbal Answer: {request.user_answer or 'No verbal answer provided'}\n"
            f"Code Answer: {request.user_code or 'No code provided'}\n"
        )

        response = ollama.generate(
            model=OLLAMA_MODEL_NAME,
            prompt=user_prompt,
            system=system_prompt,
            format="json",
            options={"temperature": 0.1}
        )

        response_text = response["response"].strip()

        try:
            evaluation_data = json.loads(response_text)

            if (
                "idealAnswer" in evaluation_data
                and not isinstance(evaluation_data["idealAnswer"], str)
            ):
                evaluation_data["idealAnswer"] = json.dumps(
                    evaluation_data["idealAnswer"]
                )

            return EvaluationResponse(**evaluation_data)

        except (json.JSONDecodeError, TypeError, ValueError):

            fixed_text = re.sub(
                r"[\r\n\t]",
                " ",
                response_text
            )

            try:
                evaluation_data = json.loads(fixed_text)

                if (
                    "idealAnswer" in evaluation_data
                    and not isinstance(evaluation_data["idealAnswer"], str)
                ):
                    evaluation_data["idealAnswer"] = json.dumps(
                        evaluation_data["idealAnswer"]
                    )

                return EvaluationResponse(**evaluation_data)

            except (json.JSONDecodeError, TypeError, ValueError):

                print(
                    f"Failed to parse response: {response_text}"
                )

                return EvaluationResponse(
                    technicalScore=0,
                    confidenceScore=0,
                    aiFeedback="Failed to parse response",
                    idealAnswer="Failed to parse response"
                )

    except Exception as e:

        print(f"Failed to generate response: {e}")

        raise HTTPException(
            status_code=500,
            detail=str(e)
        )


# Generate Adaptive Follow-up Question

@app.post(
    "/generate-followup",
    response_model=FollowUpResponse
)
async def generate_followup(request: FollowUpRequest):

    try:

        # Never allow more than 2 follow-ups
        # for one original question.

        if request.follow_up_depth >= 2:

            return FollowUpResponse(
                should_follow_up=False,
                follow_up_question=None,
                reason="Maximum follow-up depth reached."
            )

        system_prompt = (
            "You are an adaptive technical interview agent. "
            "Your job is to decide whether a candidate needs one more "
            "targeted technical question based on their answer and evaluation. "
            "Ask a follow-up only when it meaningfully tests understanding, "
            "clarifies an incomplete explanation, or probes a technical weakness. "
            "Do not ask a follow-up for irrelevant, empty, or gibberish answers. "
            "Do not repeat the original question. "
            "For coding questions, ask about the candidate's code, approach, "
            "edge cases, complexity, or design choices. "
            "For oral questions, ask about a missing concept or deeper reasoning. "
            "If no useful follow-up is needed, set should_follow_up to false. "
            "Return ONLY valid JSON with exactly these keys: "
            "should_follow_up (boolean), "
            "follow_up_question (string or null), "
            "reason (string)."
        )

        user_prompt = (
            f"Role: {request.role}\n"
            f"Level: {request.level}\n"
            f"Question type: {request.question_type}\n"
            f"Original question: {request.question}\n"
            f"Candidate's verbal answer: {request.user_answer or 'No verbal answer'}\n"
            f"Candidate's code: {request.user_code or 'No code submitted'}\n"
            f"Technical score: {request.technical_score}/100\n"
            f"Confidence score: {request.confidence_score}/100\n"
            f"Evaluation feedback: {request.ai_feedback}\n"
            f"Ideal answer: {request.ideal_answer}\n"
            f"Current follow-up depth: {request.follow_up_depth}\n"
        )

        response = ollama.generate(
            model=OLLAMA_MODEL_NAME,
            prompt=user_prompt,
            system=system_prompt,
            format="json",
            options={"temperature": 0.2}
        )

        response_text = response["response"].strip()

        followup_data = json.loads(response_text)

        result = FollowUpResponse(**followup_data)

        # Do not allow an empty follow-up question.

        if result.should_follow_up and not (
            result.follow_up_question
            and result.follow_up_question.strip()
        ):

            return FollowUpResponse(
                should_follow_up=False,
                follow_up_question=None,
                reason="AI did not generate a valid follow-up question."
            )

        return result

    except Exception as e:

        print(f"Failed to generate follow-up: {e}")

        raise HTTPException(
            status_code=500,
            detail="Failed to generate adaptive follow-up question."
        )


# Run FastAPI Server

if __name__ == "__main__":

    uvicorn.run(
        app,
        host="0.0.0.0",
        port=AI_SERVICE_PORT
    )
