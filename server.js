// server.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import sharp from "sharp";

const app = express();
const PORT = process.env.PORT || 10000;

// Render 환경변수에 넣어둔 Dropbox 토큰을 읽는다.
// 예: "Bearer sl.u.ABCDEFG....."
const DROPBOX_TOKEN = process.env.DROPBOX_REFRESH_TOKEN;

// 바디가 JSON (nickname, photo) 로 들어오기 때문에 이거 필요
app.use(express.json({ limit: "10mb" })); // base64 이미지라 용량 커질 수 있어서 limit 넉넉히
app.use(cors());

// 임시 메모리: jobId -> { status, styledReady, styledDataUrl }
const jobTable = {}; 
// 실제 프로덕션에서는 이걸 메모리 말고 DB나 파일에 저장하는 게 맞지만 지금은 메모리로 진행


// small helper: base64 dataURL -> Buffer
function dataURLtoBuffer(dataURL) {
  // dataURL 예: "data:image/png;base64,AAAAAA..."
  const matches = dataURL.match(/^data:(.+);base64,(.+)$/);
  if (!matches) return null;
  const base64 = matches[2];
  return Buffer.from(base64, "base64");
}

// helper: make filename from nickname
function makeSafeFilename(nickname) {
  // 닉네임에 한글/특수문자 많으면 Dropbox API가 깨질 수 있어
  // 그래서 우리가 했던 룰: "닉네임_시분초.png" 같은 짧은 ASCII만
  // 여기선 그냥 jobId를 timestamp 기반으로 강제로 만들자.
  // 프론트는 jobId만 중요하게 본다.
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const stamp = `${hh}${mm}${ss}`;

  // 닉네임에서 @, 공백 등 몇 개만 제거, 한글은 날려서 안전하게 ascii만 남긴다.
  const asciiNick = nickname
    .replace(/[^a-zA-Z0-9_\-]/g, "") // 영문/숫자/언더바/대시만
    .slice(0, 20) || "guest";

  return `${asciiNick}_${stamp}.png`;
}

// helper: upload buffer to dropbox
async function uploadToDropbox(buf, dropboxPath) {
  const rawToken = process.env.DROPBOX_TOKEN || "";

  // 1) rawToken이 "Bearer xxxxx"로 들어온 경우 -> "xxxxx"만 뽑아내
  // 2) rawToken이 "sl.u.xxxxx"처럼 Bearer 없이 들어온 경우 -> 그대로 쓴다
  const cleanedToken = rawToken.replace(/^Bearer\s+/i, "").trim();

  // 최종 Authorization 헤더는 항상 "Bearer {순수토큰}"
  const authHeader = "Bearer " + cleanedToken;

  if (!cleanedToken) {
    console.error("❌ DROPBOX_TOKEN missing or empty after cleaning");
    throw new Error("no dropbox token");
  }

  const resp = await fetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      "Authorization": authHeader,
      "Dropbox-API-Arg": JSON.stringify({
        path: dropboxPath,
        mode: "add",
        autorename: true,
        mute: false,
        strict_conflict: false
      }),
      "Content-Type": "application/octet-stream"
    },
    body: buf,
  });

  if (!resp.ok) {
    const t = await resp.text();
    console.error("Dropbox upload fail (raw):", t);
    throw new Error("dropbox upload failed: " + t);
  }

  const data = await resp.json();
  console.log("✅ Dropbox upload success:", data.path_lower);
  return data;
}



// POST /upload
// body: { nickname: string, photo: "data:image/png;base64,..." }
app.post("/upload", async (req, res) => {
  try {
    const { nickname, photo } = req.body || {};
    if (!nickname || !photo) {
      return res.status(400).json({
        ok: false,
        error: "missing_nickname_or_photo"
      });
    }

    // dataURL -> Buffer
    const rawBuf = dataURLtoBuffer(photo);
    if (!rawBuf) {
      return res.status(400).json({
        ok: false,
        error: "bad_photo_format"
      });
    }

    // sharp로 512x512 png 정규화
    const normBuf = await sharp(rawBuf)
      .resize(512, 512, { fit: "cover" })
      .png()
      .toBuffer();

    // 파일명 / Dropbox 경로
    const jobFile = makeSafeFilename(nickname); // e.g. "guest_071728.png"
    const dropboxPath = "/booth_uploads/" + jobFile;

    // Dropbox 업로드
    await uploadToDropbox(normBuf, dropboxPath);

    // 메모리에 job 등록
    jobTable[jobFile] = {
      status: "uploaded",   // 업로드 완료
      styledReady: false,   // 아직 변환 안됨
      styledDataUrl: null,  // 변환 후 dataURL 들어올 자리
    };

    // 프론트는 jobId만 기억해뒀다가 /status?jobId=... 로 계속 물어본다
    res.json({
      ok: true,
      jobId: jobFile,
      message: "upload_success_wait_for_style"
    });
  } catch (err) {
    console.error("POST /upload error:", err);
    return res.status(500).json({
      ok: false,
      error: "server_error",
      message: err.message || String(err),
    });
  }
});


// GET /status?jobId=xxxx.png
// -> {ok:true, done:false} | {ok:true, done:true, previewDataUrl:"data:image/png;base64,...."}
app.get("/status", async (req, res) => {
  try {
    const jobId = req.query.jobId;
    if (!jobId || !jobTable[jobId]) {
      return res.json({
        ok: false,
        error: "no_such_job"
      });
    }

    const jobInfo = jobTable[jobId];

    // 여기서 진짜 구현은:
    //
    // 1. Dropbox의 /booth_styled/{jobId} 같은 위치를 확인한다.
    // 2. 거기 파일이 있으면 다운로드해서 base64로 읽어서 styledDataUrl 채우고
    //    jobInfo.styledReady=true 로 바꾼다.
    //
    // 지금은 네 로컬 자동 파이프라인(ComfyUI→Dropbox 업로드)이 완성되기 전이니까
    // 임시로 "아직 변환 안 끝났음"만 준다.
    //
    // ↓↓↓ 나중에 여기서 실제 Dropbox에서 결과 png를 읽어서 dataURL 만들면 된다.

    if (!jobInfo.styledReady) {
        return res.json({
            ok: true,
            done: false // 아직 변환 안 끝남
        });
    }

    // 만약 styledReady=true 라면:
    return res.json({
      ok: true,
      done: true,
      previewDataUrl: jobInfo.styledDataUrl, // "data:image/png;base64,...."
    });

  } catch (err) {
    console.error("GET /status error:", err);
    return res.status(500).json({
      ok: false,
      error: "server_error",
      message: err.message || String(err),
    });
  }
});

app.listen(PORT, () => {
  console.log(`✅ booth-proxy server running on port ${PORT}`);
});


