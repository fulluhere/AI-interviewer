import asyncHandler from "express-async-handler";
import Session from "../models/SessionModel.js";
import fetch from "node-fetch";
import fs from "fs";
import FormData from "form-data";
import path from "path";
import mongoose from "mongoose";

const AI_SERVICE_URL="http://localhost:8000";

const pushSocketUpdate = (io, userId, sessionId, status, message, sessionData=null) => {
  io.to(userId.toString()).emit("sessionUpdate", {
    sessionId,
    status,
    message,
    sessionData
  });
}


const createSession=asyncHandler(async(req, res)=>{
  const {role, level, interviewType, count}=req.body;
  userId=req.user._id;
  if(!role || !level || !interviewType || !count){
    res.status(400);
    throw new Error("Please fill all the fields");
  }
  let session=await Session.create({
    user.userId,
    role,
    level,
    interviewType,
    status: "pending",
  })

  const io=req.app.get("io")

  res.status(202).json({
    message:"Session created successfully",
    sessionId:session._id,
    status:"processing"
  });
//IIFE -> Immediately Invoked Function Expression

  (async()=>{
    try{
      pushSocketUpdate(io, userId, session._id, "ai generating questions...", `generating ${count} question for ${level} level ${role} role interview...`);

      const aiResponse=await fetch(`${AI_SERVICE_URL}/generate-questions`, {
        method:"POST",
        headers:{
          "Content-Type":"application/json"
        },
        body:JSON.stringify({
          role, 
          level,
          count
        })
      });

      if(!aiResponse.ok){
        const errorBody=await aiResponse.text();
        throw new Error("AI service error: ${aiResponse.status}-${errorBody}");
      }
      const aiData = await aiResponse.json();
      const codingCount=interviewType==='coding-mix'?Math.floor(count*0.2):0;
      
      const questions=aiData.questions.map((qText, index)=>({
        questionText:qText,
        questionType:index<codingCount?"coding":"oral",
        isEvaluated:false,
        isSubmitted:false,
      }));

      session.questions=questions;
      session.status="in-progress";
      await session.save();

      pushSocketUpdate(io, userId, session._id, "questions ready", "starting interview...");
    }catch(error){
        console.error(`Session creation failed: ${error.message}`);
        session.status="failed";
        await session.save();
        pushSocketUpdate(io, userId, session._id, "failed", error.message);
    }
  })();

});

const getSessions=asyncHandler(async(req, res)=>{
  const userId=req.user._id;
  const sessions=await Session.find({user:userId}).select("-questions");
  res.status(200).json(sessions);
})

const getSessionById=asyncHandler(async(req, res)=>{
  const usekjrId=req.user._id;
  const sessionId=req.params.sessionId;
  const session=await Session.findOne({user:userId, _id:sessionId});

  if(!session){
    res.status(404);
    throw new Error("Session not found");
  }

  res.status(200).json(session);
})
export {createSession};
