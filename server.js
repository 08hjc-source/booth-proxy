import express from "express";
import cors from "cors";

const app = express();
app.use(express.json({ limit: "15mb" }));
app.use(cors());

// ====== CONFIG ======
const DROPBOX_TOKEN = process.env.DROPBOX_TOKEN;
const DROPBOX_UPLOAD_FOLDER = "/booth_uploads"; // 원본 저장 폴더
const DROPBOX_STYLED_FOLDER = "/booth_styled";   // 변환본 저장 폴더


// 닉네임 기반 파일명
function makeSafeFilename(rawName) {
  const cleaned = rawName.trim().replace(/[^가-힣a-zA-Z0-9_-]/g, "_");
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const stamp = `${hh}${mm}${ss}`;
  return `${cleaned}_${stamp}.png`; // 예: 찬_071728.png
}

// Dropbox 업로드
async function uploadToDropbox({ folder, filename, buffer }) {
  if (!DROPBOX_TOKEN) {
    throw new Error("DROPBOX_TOKEN is missing on server");
  }

  const dropboxPath = `${folder}/${filename}`;
  const resp = await fetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${DROPBOX_TOKEN}`,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify({
        path: dropboxPath,
        mode: "add",
        autorename: true,
        mute: false,
        strict_conflict: false
      })
    },
    body: buffer,
  });

  if (!resp.ok) {
    const txt = await resp.text();
    console.error("Dropbox upload fail (raw):", txt);
    throw new Error("dropbox upload failed: " + txt);
  }

  const data = await resp.json();
  return data; // includes path_display
}

// Dropbox 폴더 내 파일 목록 불러오기
async function listDropboxFolder(folder) {
  const resp = await fetch("https://api.dropboxapi.com/2/files/list_folder", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${DROPBOX_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      path: folder,
      recursive: false,
      include_media_info: false,
      include_deleted: false,
      include_has_explicit_shared_members: false,
      include_mounted_folders: true,
      limit: 2000
    })
  });

  if (!resp.ok) {
    const txt = await resp.text();
    console.error("Dropbox list_folder fail (raw):", txt);
    throw new Error("dropbox list_folder failed: " + txt);
  }

  const data = await resp.json();
  return data.entries || [];
}

// Dropbox에서 특정 파일(이미지)을 다운로드해서 base64로 돌려주기
async function downloadDropboxFile(pathLower) {
  // pathLower 예: "/booth_styled/찬_071728__styled_2025-11-01-193500.png"
  const resp = await fetch("https://content.dropboxapi.com/2/files/download", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${DROPBOX_TOKEN}`,
      "Dropbox-API-Arg": JSON.stringify({
        path: pathLower
      })
    }
  });

  if (!resp.ok) {
    const txt = await resp.text();
    console.error("Dropbox download fail (raw):", txt);
    throw new Error("dropbox download failed: " + txt);
  }

  const arrayBuf = await resp.arrayBuffer();
  const buff = Buffer.from(arrayBuf);
  const b64 = buff.toString("base64");
  // data URL로 만들어주면 프론트에서 바로 <img src="..."> 가능
  return `data:image/png;base64,${b64}`;
}

// ============ ROUTES ============

// 업로드 라우트
// body: { nickname: "찬", photo: "data:image/png;base64,AAAA..." }
app.post("/upload", async (req, res) => {
  try {
    const { nickname, photo } = req.body;

    if (!nickname || !photo) {
      return res.status(400).json({ ok: false, error: "nickname or photo missing" });
    }

    // dataURL 파싱
    const match = photo.match(/^data:image\/\w+;base64,(.+)$/);
    if (!match) {
      return res.status(400).json({ ok: false, error: "photo is not valid dataURL" });
    }
    const b64 = match[1];
    const imgBuffer = Buffer.from(b64, "base64");

    // 파일명 생성 (jobId로도 사용)
    const filename = makeSafeFilename(nickname); // 예: 찬_071728.png

    // Dropbox 업로드 (원본을 /booth_uploads에)
    const dropResult = await uploadToDropbox({
      folder: DROPBOX_UPLOAD_FOLDER,
      filename,
      buffer: imgBuffer
    });

    // 프론트엔드(프레이머)한테 jobId를 알려준다
    return res.json({
      ok: true,
      jobId: filename,             // 이게 이후 /status에 쓸 키
      stored: dropResult.path_display
    });
  } catch (err) {
    console.error("서버 내부 오류:", err);
    return res.status(500).json({ ok: false, error: "internal server error" });
  }
});


// 상태 확인 라우트
// 프레이머 쪽에서 /status?jobId=찬_071728.png 로 계속 물어보는 형태
app.get("/status", async (req, res) => {
  try {
    const jobId = req.query.jobId;
    if (!jobId) {
      return res.status(400).json({ ok: false, error: "missing jobId" });
    }

    // 예: jobId = "찬_071728.png"
    // 변환된 결과는 "찬_071728__styled_..." 이런 식으로 나오니까
    // "찬_071728" 부분만 뽑아서 startsWith로 매칭한다
    const baseName = jobId.replace(/\.png$/i, "");

    // 1) 스타일 결과 폴더를 스캔
    const entries = await listDropboxFolder(DROPBOX_STYLED_FOLDER);
    // entries 안에는 {name, path_lower, .tag:"file", ...} 등이 들어있음

    // 2) baseName으로 시작하는 파일 중 하나 고르자
    //    예: jobId = 찬_071728.png
    //    결과: 찬_071728__styled_2025-11-01-193500.png
    const hit = entries.find(e => {
      return e[".tag"] === "file" && e.name.startsWith(baseName + "__styled_");
    });

    if (!hit) {
      // 아직 변환 안 끝남
      return res.json({ ok: true, done: false });
    }

    // 3) 찾았다 → 그 파일을 실제로 다운로드해서 base64 dataURL로 리턴
    const dataUrl = await downloadDropboxFile(hit.path_lower);

    return res.json({
      ok: true,
      done: true,
      fileName: hit.name,
      previewDataUrl: dataUrl // 프레이머 <img src={previewDataUrl} />
    });
  } catch (err) {
    console.error("status check error:", err);
    return res.status(500).json({ ok: false, error: "internal server error" });
  }
});

// health check
app.get("/", (req, res) => {
  res.send("booth upload server alive");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ booth upload server running on ${PORT}`);
});
