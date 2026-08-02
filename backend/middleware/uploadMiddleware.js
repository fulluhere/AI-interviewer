import multer from "multer";

const storage = multer.diskStorage({
  destination(req, file, cb){
    cb(null, "uploads/");
  },
  filename(req, file, cb){
    const ext=path.extname(file.originalname);
    const basename=path.basename(file.originalname, ext);
    const sessionId=req.params.id || 'unknown';
    cb(null, `${sessionId}-${Date.now()}${ext}`);

  },
});

const fileFilter = (req, file, cb) => {
  if(file.mimetype.startsWith("audio/") || file.mimetype === "application/octet-stream"){
      cb(null, true);
  }else{
    cb(null, false);
  }
};

const upload = multer({
  storage: storage,
  fileFilter,
  limits: { fileSize: 1024*1024*10},
});


const uploadSingleAudio = upload.single("audio");

export { uploadSingleAudio };