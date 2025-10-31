import express from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";

// .env 불러오기 (.env 파일에 비밀키 넣어둠)
dotenv.config();

const app = express();

// =========================
// 0. 기본 서버/미들웨어 설정
// =========================

// CORS 설정 (전시장 현장용이라 전체 허용)
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// 프리플라이트(브라우저 사전요청) 허용
app.options("/upload", (req, res) => {
  res.sendStatus(200);
});

// multipart/form-data 처리기 (사진 받으려고 필요)
const upload = multer();

// =========================
// 1. 환경 변수 (비밀키)
// =========================
//
// .env 예시:
// DROPBOX_TOKEN=Bearer 슬래시시작~긴토큰
// GPT_IMAGE_API_KEY=sk-너의-gpt-api키
// GPT_IMAGE_ENDPOINT=https://너_gpt이미지변환_엔드포인트
//
const DROPBOX_TOKEN = process.env.DROPBOX_TOKEN;
const GPT_IMAGE_API_KEY = process.env.GPT_IMAGE_API_KEY;
const GPT_IMAGE_ENDPOINT = process.env.GPT_IMAGE_ENDPOINT;

// 방어적으로 체크 (없으면 콘솔에 경고만 찍어줌)
if (!DROPBOX_TOKEN) {
  console.warn("⚠ DROPBOX_TOKEN is missing from .env");
}
if (!GPT_IMAGE_API_KEY) {
  console.warn("⚠ GPT_IMAGE_API_KEY is missing from .env");
}
if (!GPT_IMAGE_ENDPOINT) {
  console.warn("⚠ GPT_IMAGE_ENDPOINT is missing from .env");
}

// =========================
// 2. 유틸 함수들
// =========================

// (A) 닉네임을 ASCII 안전 파일이름으로 바꾼다
// - 한글 등 ASCII 아닌 문자는 제거
// - 공백은 _ 로 치환
// - 파일/경로 깨는 특수문자는 제거
// - 전부 없어지면 "user"로 대체
function sanitizeAsciiFilename(userLabel) {
  const asciiOnly = (userLabel || "")
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "") // ASCII 이외 문자 제거
    .replace(/[\/\\:\*\?"<>\|]/g, "") // 경로 깨는 문자 제거
    .replace(/\s+/g, "_") // 공백 → _
    .trim();

  return asciiOnly || "user";
}

// (B) 한국시간(KST, UTC+9 기준) HHMMSS 형태의 태그 생성
//    예: "134209"
function getKSTTimeTag() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000); // UTC+9 보정
  const hours = String(kst.getUTCHours()).padStart(2, "0");
  const mins = String(kst.getUTCMinutes()).padStart(2, "0");
  const secs = String(kst.getUTCSeconds()).padStart(2, "0");
  return `${hours}${mins}${secs}`;
}

// (C) 원본 경로(/booth_uploads/파일명.png)를
//     스타일 결과 경로(/booth_styled/파일명.png)로 바꿔주는 함수
function makeStyledPath(originalPath) {
  return originalPath.replace("/booth_uploads/", "/booth_styled/");
}

// (D) Dropbox에 buffer(이미지)를 업로드하는 함수
async function uploadBufferToDropbox(buffer, dropboxPath) {
  // Node 18+ 에서는 fetch 전역 지원. (Render/LTS 서버는 보통 최신 Node)
  const resp = await fetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      Authorization: DROPBOX_TOKEN,
      "Dropbox-API-Arg": JSON.stringify({
        path: dropboxPath,
        mode: "add",
        autorename: true,
        mute: false,
      }),
      "Content-Type": "application/octet-stream",
    },
    body: buffer,
  });

  const data = await resp.json();

  if (!resp.ok) {
    console.error("Dropbox upload error:", data);
    throw new Error("uploadBufferToDropbox failed");
  }

  return data;
}

// (E) Dropbox에서 파일을 다운로드하여 Buffer로 돌려주는 함수
//     ⚠ 중요: Dropbox /2/files/download는 경로를 헤더 "Dropbox-API-Arg"에 넣는다.
//     ASCII 이외 문자가 경로에 있으면 Node가 'ERR_INVALID_CHAR' 뱉을 수 있다.
//     우리는 이미 파일명을 ASCII로 만들었기 때문에 안전하다는 전제.
async function downloadFromDropbox(dropboxPath) {
  const resp = await fetch("https://content.dropboxapi.com/2/files/download", {
    method: "POST",
    headers: {
      Authorization: DROPBOX_TOKEN,
      "Dropbox-API-Arg": JSON.stringify({
        path: dropboxPath,
      }),
    },
  });

  if (!resp.ok) {
    const t = await resp.text();
    console.error("Dropbox download error:", t);
    throw new Error("downloadFromDropbox failed");
  }

  const buffer = Buffer.from(await resp.arrayBuffer());
  return buffer;
}

// (F) GPT 스타일 변환 호출
//     originalBuffer: 원본 이미지 (PNG 등)
//     return: 변환된 이미지(Buffer)
//
//     ⚠ 여기서 GPT_IMAGE_ENDPOINT와 GPT_IMAGE_API_KEY는
//     너가 실제 사용할 이미지 변환 API 규격에 맞게 바꿔줘야 한다.
//     지금은 "image(base64) + prompt"를 보내고
//     "output_image"(base64)로 받는다고 가정한 형태야.
async function callStyleTransferModel(originalBuffer) {
  // 전시에 쓰고 싶은 시각 스타일 지시문
  // -> 전시장 전체 톤이 통일되게끔 항상 같은 스타일로 유지하는 게 좋다
  const stylePrompt = `
굵고 선명한 검은 라인으로 단순화된 만화 스타일,
배경은 완전히 하얀 종이처럼 흰색,
사람의 포즈와 형태는 알아볼 수 있게 유지,
스캔된 잉크 드로잉 같은 질감.
`;

  // 원본 이미지를 base64로 인코딩해 전송한다고 가정
  const base64Input = originalBuffer.toString("base64");

  const resp = await fetch(GPT_IMAGE_ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${GPT_IMAGE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt: stylePrompt,
      image: base64Input,
      strength: 0.7, // 원본을 얼마나 유지할지 (0~1 가정값)
    }),
  });

  if (!resp.ok) {
    const t = await resp.text();
    console.error("Style transfer error:", t);
    throw new Error("callStyleTransferModel failed");
  }

  // 응답은 JSON이라고 가정:
  // { output_image: "<base64 PNG...>" }
  const resultJson = await resp.json();

  const outputBase64 = resultJson.output_image;
  if (!outputBase64) {
    throw new Error("No output_image from style model");
  }

  const styledBuffer = Buffer.from(outputBase64, "base64");
  return styledBuffer;
}

// (G) 전체 후처리 파이프라인
//     1) Dropbox에서 원본 이미지 다운로드
//     2) GPT로 스타일 변환
//     3) 같은 파일명으로 /booth_styled/ 폴더에 업로드
async function processAndRedropbox(originalPath) {
  try {
    console.log("▶ post-process start:", originalPath);

    // 1. Dropbox에서 원본 이미지 파일 받기 (Buffer)
    const originalBuffer = await downloadFromDropbox(originalPath);

    // 2. GPT 스타일 변환 호출
    const styledBuffer = await callStyleTransferModel(originalBuffer);

    // 3. 결과 저장 경로 (파일명은 그대로, 폴더만 booth_styled)
    const styledPath = makeStyledPath(originalPath);

    // 4. 변환된 이미지를 Dropbox에 업로드
    await uploadBufferToDropbox(styledBuffer, styledPath);

    console.log("✅ post-process done:", styledPath);
  } catch (err) {
    console.error("post-process failed:", err);
  }
}

// =========================
// 3. 업로드 라우트
// =========================
//
// 클라이언트는 form-data로 보낸다:
// - photo: 실제 이미지 파일
// - name: 유저 이름(닉네임) 문자열
//
// 응답으로:
// - original_path : /booth_uploads/...png
// - styled_path   : /booth_styled/...png (곧 생성될 예정 경로 안내용)
//
app.post("/upload", upload.single("photo"), async (req, res) => {
  try {
    // (1) 파일 유효성 확인
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({
        ok: false,
        message: "no file buffer",
        debug: "req.file or req.file.buffer is missing",
      });
    }

    const fileBuffer = req.file.buffer;

    // (2) 유저가 보낸 이름(닉네임). 한글일 수도 있음.
    //     rawName은 전시에 '이건 누구 작품이다' 표시용으로만 쓸 수 있어.
    const rawName =
      req.body && typeof req.body.name === "string" ? req.body.name : "";
    console.log("받은 이름(raw):", rawName);

    // (3) Dropbox에 안전하게 쓸 ASCII 파일명 만들기
    //     예: "user_134209.png"
    const safeBase = sanitizeAsciiFilename(rawName); // ex) "juchan" or "user"
    const timeTag = getKSTTimeTag();                 // ex) "134209"
    const finalFileName = `${safeBase}_${timeTag}.png`;

    // (4) Dropbox에 원본을 저장할 경로
    //     ASCII만 쓰이므로 Dropbox 헤더 제약에 안 걸리게 설계
    const dropboxPathOriginal = `/booth_uploads/${finalFileName}`;
    console.log("업로드 경로:", dropboxPathOriginal);

    // (5) Dropbox로 업로드
    const dropRespData = await uploadBufferToDropbox(
      fileBuffer,
      dropboxPathOriginal
    );

    // (6) 업로드 성공했으니, 후처리(스타일 변환) 비동기 실행
    //     이건 기다리지 않고 바로 실행만 던진다.
    processAndRedropbox(dropboxPathOriginal);

    // (7) 클라이언트에게 응답
    //     styled_path는 "곧 여기에 스타일 버전이 올라간다"라는 안내용
    return res.json({
      ok: true,
      user: rawName,
      filename: finalFileName,
      original_path: dropboxPathOriginal,
      styled_path: makeStyledPath(dropboxPathOriginal),
      dropbox_result: dropRespData, // 필요 없으면 빼도 됨
    });
  } catch (err) {
    console.error("서버 내부 오류:", err);
    return res.status(500).json({
      ok: false,
      message: "server crashed",
      error: String(err && err.message ? err.message : err),
    });
  }
});

// =========================
// 4. 서버 시작
// =========================
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Server running on port " + port);
});
