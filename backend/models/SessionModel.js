import mongoose from "mongoose";

const questionSchema = new mongoose.Schema({
    questionText:{
        type:String,
        required:true
    },
    questionType:{
        type:String,
        enum:["coding","oral"],
        required:true
    },
    idealAnswer:{
        type:String,
        default:"pending"
    },
    userAnswerText:{
        type:String,
        default:""
    },
    userSubmittedCode:{
        type:String,
        default:""
    },
    isSubmitted:{
        type:Boolean,
        default:false
    },
    isEvaluated:{
        type:Boolean,
        default:false
    },
    technicalScore:{
        type:Number,
        default:0
    },
    confidenceScore:{
        type:Number,
        default:0
    },
    // Adaptive AI metadata
    aiFeedback: {
        type: String,
        default: "Not yet submitted or evaluated"
    },
    isFollowUp: {
        type: Boolean,
        default: false
    },
    parentQuestionId: {
        type: mongoose.Schema.Types.ObjectId,
        default: null
    },
    followUpDepth: {
        type: Number,
        default: 0
    },
    followUpCount: {
        type: Number,
        default: 0
    }
});

const sessionSchema= new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
        index: true,
    },
    role:{
        type:String,
        required:true
    },
    level:{
        type:String,
        required:true
    },
    interviewType:{
        type:String,
        enum:["oral-only","coding-mix"],
        required:true
    },
    // Interview mode: General or RAG-based
    interviewMode: {
        type: String,
        enum: ["general", "knowledge-based"],
        default: "general"
    },

    // Selected knowledge base for RAG interviews
    knowledgeBaseId: {
        type: String,
        default: null
    },
    status:{
        type:String,
        enum:["pending","in-progress","completed","failed"],
        default:"pending"
    },
    overallScore: {
        type: Number,
        default: 0,
    },
    metrics: {
        avgTechnical: { type: Number, default: 0 },
        avgConfidence: { type: Number, default: 0 },
    },
    questions:[questionSchema],
    startTime:{type:Date,default:Date.now},
    endTime:{type:Date},
   
},{
    timestamps:true
});

const Session = mongoose.model("Session", sessionSchema);
export default Session