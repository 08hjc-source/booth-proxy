import express from "express";
import cors from "cors";
import multer from "multer";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config(); // .env 읽기

const app = express();
app.use(cors());
const upload = multer();

// =======================
// 0. 환경변수(비밀키 불러오기)
// =======================
const DROPBOX_TOKEN = process.env.DROPBOX_TOKEN; // "Bearer ...."
const GPT_IMAGE_API_KEY = process.env.GPT_IMAGE_API_KEY;
const GPT_IMAGE_ENDPOINT = process.env.GPT_IMAGE_ENDPOINT;

// =======================
// 1. 유틸 함수들
// =======================

// 업로드된 이름에서 Dropbox가 싫어하는 문자만 지우는 함수
// (슬래시나 따옴표 같은 파일깨트리는 애들만 제거하고 나머지(한글 등)는 유지)
function sanitizeName(raw) {
  if (!raw || !raw.trim()) return "unknown";
  return raw
    .trim()
    .replace(/[\/\\:\*\?"<>\|]/g, "") // 경로 깨트리는 위험 문자 제거
    .replace(/\s+/g, "_");            // 공백은 _ 로
}

// 업로드된 원본 경로를 받아서 스타일 버전 경로로 바꾼다.
// 파일명은 그대로 유지하고, 폴더만 booth_styled 로 바꾼다.
function makeProcessedPath(originalPath) {
  // 예: /booth_uploads/주찬_1730.png
  // -> /booth_styled/주찬_1730.png
  return originalPath.replace("/booth_uploads/", "/booth_styled/");
}

// Dropbox에 버퍼(이미지)를 업로드하는 함수
async function uploadBufferToDropbox(buffer, dropboxPath) {
  const resp = await fetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      Authorization: DROPBOX_TOKEN,
      "Dropbox-API-Arg": JSON.stringify({
        path: dropboxPath,
        mode: "add",
        autorename: true,
        mute: false
      }),
      "Content-Type": "application/octet-stream"
    },
    body: buffer
  });

  const data = await resp.json();

  if (!resp.ok) {
    console.error("Dropbox upload error:", data);
    throw new Error("uploadBufferToDropbox failed");
  }

  return data;
}

// Dropbox에서 파일(이미지)을 다운로드해서 Buffer로 돌려주는 함수
// 주의: Dropbox /2/files/download 는 헤더 "Dropbox-API-Arg" 에 경로를 넣음.
// 여기에도 한글이 들어가면 Node가 문제를 낼 수 있다.
// 안정적으로 가려면 최종적으로 ASCII만 들어가는 경로를 쓰는 편이 안전하다.
// 일단은 그대로 쓴다고 가정한다.
async function downloadFromDropbox(dropboxPath) {
  const resp = await fetch("https://content.dropboxapi.com/2/files/download", {
    method: "POST",
    headers: {
      Authorization: DROPBOX_TOKEN,
      "Dropbox-API-Arg": JSON.stringify({
        path: dropboxPath
      })
    }
  });

  if (!resp.ok) {
    const t = await resp.text();
    console.error("Dropbox download error:", t);
    throw new Error("downloadFromDropbox failed");
  }

  const buffer = Buffer.from(await resp.arrayBuffer());
  return buffer;
}

// GPT(이미지 변환 모델)에게 원본 이미지를 보내서
// 스타일이 바뀐 새 이미지를 Buffer 로 받아오는 함수
// 이 부분은 네가 쓸 실제 GPT 이미지 변환 API 스펙에 맞게만 바꾸면 된다.
async function callStyleTransferModel(originalBuffer) {
  // 1. 변환 스타일 프롬프트: 여기서 전시 이미지 톤을 정의한다.
  //    이건 너랑 내가 합의해서 고정시키는 게 좋다. (전시장 전체 스타일 통일)
  const stylePrompt = `
굵은 검정 라인으로만 표현된 만화 스타일,
배경은 완전히 흰색,
사람의 얼굴/몸 형태는 알아볼 수 있게 단순화,
전체적으로 스캔한 잉크드로잉 느낌.
`;

  // 2. 원본 이미지를 base64로 변환해서 전송한다고 가정
  const base64Input = originalBuffer.toString("base64");

  // 3. GPT 이미지 변환 API 호출 (엔드포인트/파라미터는 네 환경에 맞게 수정)
  const resp = await fetch(GPT_IMAGE_ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${GPT_IMAGE_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      prompt: stylePrompt,
      image: base64Input, // 원본 이미지
      // 모델 옵션 (예시)
      strength: 0.7,      // 원본을 얼마나 유지할지 (0~1 가정)
      // size나 output_format 등 필요하면 여기에
    })
  });

  if (!resp.ok) {
    const t = await resp.text();
    console.error("Style transfer error:", t);
    throw new Error("callStyleTransferModel failed");
  }

  // 4. 응답을 JSON으로 받았다고 가정.
  //    output_image 가 base64 PNG라고 가정한다.
  const resultJson = await resp.json();

  const outputBase64 = resultJson.output_image; // 예: "iVBORw0KGgoAAAANSUhEUgA..."
  const styledBuffer = Buffer.from(outputBase64, "base64");
  return styledBuffer;
}

// 최종 파이프라인:
// 1) Dropbox에서 원본 다운로드
// 2) GPT로 스타일 변환
// 3) 같은 파일명으로 다른 폴더(/booth_styled/)에 업로드
async function processAndRedropbox(originalPath) {
  console.log("post-process start:", originalPath);

  // 1. 원본 이미지 받기
  const originalBuffer = await downloadFromDropbox(originalPath);

  // 2. GPT 스타일 변환
  const styledBuffer = await callStyleTransferModel(originalBuffer);

  // 3. 결과 저장 경로 만들기 (파일명은 그대로 두고 폴더만 바꿈)
  const processedPath = makeProcessedPath(originalPath);

  // 4. 변환된 이미지 Dropbox에 업로드
  await uploadBufferToDropbox(styledBuffer, processedPath);

  console.log("post-process done:", processedPath);
}

// =======================
// 2. 실제 업로드 라우트
// =======================
app.post("/upload", upload.single("photo"), async (req, res) => {
  try {
    // 1) 업로드된 파일 없으면 에러
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ ok: false, message: "no file" });
    }

    // 2) 사용자 이름(닉네임 등) 받아서 파일명에 쓸 준비
    const rawName = req.body.name || "unknown";
    const safeName = sanitizeName(rawName);

    // 3) 우리가 Dropbox에 저장할 경로 만들기
    //    여기서는 사진 찍을 때의 "원래 이름" + timestamp 조합으로 유니크하게 한다.
    //    한글 포함 유지 가능. (단, Node가 헤더에서 한글 싫어하는 이슈는 별도 대응 필요)
    const fileName = `${safeName}_${Date.now()}.png`;
    const dropboxPathOriginal = `/booth_uploads/${fileName}`;

    // 4) 먼저 원본 이미지를 Dropbox에 업로드
    await uploadBufferToDropbox(req.file.buffer, dropboxPathOriginal);

    // 5) 업로드가 끝났으니까 후처리(스타일 변환) 시작
    processAndRedropbox(dropboxPathOriginal).catch(err => {
      console.error("post-process failed:", err);
    });

    // 6) 클라이언트에 응답
    return res.json({
      ok: true,
      original_path: dropboxPathOriginal,
      styled_path: makeProcessedPath(dropboxPathOriginal) 
      // 이건 "나중에 여기에 결과 올라간다" 라는 예고용
    });

  } catch (error) {
    console.error("Upload error:", error);
    return res.status(500).json({ ok: false, message: "server error" });
  }
});

// =======================
// 3. 서버 시작
// =======================
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Server running on port " + port);
});
