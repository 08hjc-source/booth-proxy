import express from "express";
import multer from "multer";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { fileURLToPath } from "url";

//
// ─────────────────────────────
// 기본 세팅
// ─────────────────────────────
//

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

// 환경 변수
let DROPBOX_TOKEN = process.env.DROPBOX_TOKEN || "";
let OPENAI_KEY = process.env.OPENAI_KEY || "";

// Dropbox Authorization 헤더용 래퍼
function dbxAuthHeader() {
  if (DROPBOX_TOKEN.startsWith("Bearer ")) {
    return DROPBOX_TOKEN;
  }
  return `Bearer ${DROPBOX_TOKEN}`;
}

if (!DROPBOX_TOKEN) {
  console.warn("⚠️ DROPBOX_TOKEN not set");
}
if (!OPENAI_KEY) {
  console.warn("⚠️ OPENAI_KEY not set");
}

// 스타일 참조 이미지를 로컬 파일로 둔다.
// server.js와 같은 폴더 기준 ./assets/style_ref_all.png 에 넣어둘 것
const STYLE_REF_LOCAL = path.join(__dirname, "assets", "style_ref_all.png");

//
// ─────────────────────────────
// multer: 사진 파일을 메모리로 받는다
// ─────────────────────────────
//
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024 // 최대 15MB
  }
});

//
// ─────────────────────────────
// 유틸 함수들
// ─────────────────────────────
//

// 닉네임에서 Dropbox 경로에 문제될 수 있는 문자 제거
function sanitizeName(name) {
  if (!name) return "guest";
  const asciiOnly = name.replace(/[^a-zA-Z0-9_-]/g, "");
  return asciiOnly.length > 0 ? asciiOnly : "guest";
}

// 한국 시간(UTC+9) 기준 HHMMSS 타임스탬프
function makeKRTimestamp() {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `${hh}${mm}${ss}`; // 예: "071728"
}

// 원본 이미지를 PNG로 정규화
async function toPng(buffer) {
  return sharp(buffer).png().toBuffer();
}

// 버퍼 PNG로 변환 → 리사이즈(512x512, cover) → 다시 버퍼
async function toPng512(buffer) {
  return sharp(buffer)
    .resize(512, 512, { fit: "cover" })
    .png()
    .toBuffer();
}

//
// ─────────────────────────────
// Dropbox 업로드 전용 함수
// (공유 링크는 만들지 않는다. 아카이브만 한다.)
// ─────────────────────────────
//

/**
 * Dropbox에 파일 업로드
 * @param {string} desiredPath 예: "/booth_uploads/guest_071728.png"
 * @param {Buffer} fileBytes
 * @returns {Promise<{path_lower: string, id: string, ...}>}
 */
async function uploadToDropbox(desiredPath, fileBytes) {
  console.log("DEBUG dropbox token preview:", (DROPBOX_TOKEN || "").slice(0, 20));
  console.log("DEBUG dropbox upload path (requested):", desiredPath);

  const resp = await fetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      Authorization: dbxAuthHeader(),
      "Dropbox-API-Arg": JSON.stringify({
        path: desiredPath,
        mode: "add",
        autorename: true,
        mute: false,
        strict_conflict: false
      }),
      "Content-Type": "application/octet-stream"
    },
    body: fileBytes
  });

  const rawText = await resp.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch (e) {
    console.error("Dropbox upload parse fail:", rawText);
    throw new Error("dropbox upload failed (invalid JSON)");
  }

  if (!resp.ok) {
    console.error("❌ Dropbox upload fail:", data);
    throw new Error("dropbox upload failed");
  }

  console.log("✅ Dropbox upload success:", data.path_lower);
  return data;
}

//
// ─────────────────────────────
// OpenAI 호출 (이미지 스타일 변환)
// ─────────────────────────────
//
// 변경 핵심:
// 1. Dropbox URL 안 쓴다.
// 2. base64 → data URL 로 변환 후 image_url로 넘긴다.
// 3. 응답에서 output_image를 꺼내서 PNG Buffer로 돌려준다.
//

/**
 * @param {Buffer} resizedBuffer 512x512 PNG buffer (사용자 입력 이미지)
 * @param {string} styleRefPath  로컬 스타일 참조 PNG 파일 경로
 * @returns {Promise<Buffer>}    결과물 PNG 바이너리 Buffer
 */
async function stylizeWithGPT(resizedBuffer, styleRefPath) {
  // 방문자 이미지 base64
  const userB64 = resizedBuffer.toString("base64");
  const userDataUrl = `data:image/png;base64,${userB64}`;

  // 스타일 참조 이미지 base64
  let styleBuf;
  try {
    styleBuf = fs.readFileSync(styleRefPath);
  } catch (e) {
    console.error("❌ style reference load failed:", e);
    throw new Error("style reference image not found");
  }
  const styleB64 = styleBuf.toString("base64");
  const styleDataUrl = `data:image/png;base64,${styleB64}`;

  console.log("DEBUG calling OpenAI with:");
  console.log("DEBUG OPENAI KEY preview:", (OPENAI_KEY || "").slice(0, 12));

  // OpenAI 요청 바디
  // image_url 필드에 data URL을 직접 넣는다.
  // (image_data 대신 image_url)
  const gptRequestBody = {
    model: "gpt-4o-mini-2024-07-18",
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              "Take the first image: it's a real person. " +
              "Take the second image: it's the style reference. " +
              "Redraw the person from the first image in the style of the second image. " +
              "Keep the same pose, hairstyle, clothing colors, and overall identity. " +
              "Use clean linework, flat fills, minimal shading, and the same face style / proportions from the style image. " +
              "Return only the final character illustration on plain white background, no text, no watermark. " +
              "Output as PNG. " +
              "IMPORTANT: return the final stylized character as an image output."
          },
          {
            type: "input_image",
            image_url: userDataUrl
          },
          {
            type: "input_image",
            image_url: styleDataUrl
          }
        ]
      }
    ]
  };

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(gptRequestBody)
  });

  const result = await resp.json();

  if (!resp.ok) {
    console.error("GPT style remix fail:", result);
    throw new Error("gpt style remix failed");
  }

  // OpenAI 응답에서 base64 PNG 추출
  let base64Image = null;

  if (
    result.output &&
    Array.isArray(result.output) &&
    result.output[0] &&
    Array.isArray(result.output[0].content)
  ) {
    for (const chunk of result.output[0].content) {
      // 예상 1: { type:"output_image", image:{ b64_json:"..." } }
      if (
        chunk.type === "output_image" &&
        chunk.image &&
        typeof chunk.image.b64_json === "string"
      ) {
        base64Image = chunk.image.b64_json;
        break;
      }
      // 예상 2: { type:"output_image", image:"iVBOR..." }
      if (
        chunk.type === "output_image" &&
        typeof chunk.image === "string"
      ) {
        base64Image = chunk.image;
        break;
      }
    }
  }

  // fallback (일부 구형 응답 스타일)
  if (
    !base64Image &&
    result.data &&
    result.data[0] &&
    result.data[0].b64_json
  ) {
    base64Image = result.data[0].b64_json;
  }

  if (!base64Image) {
    console.warn(
      "⚠️ GPT did not return an image. Full result:",
      JSON.stringify(result, null, 2)
    );
    throw new Error("no_image_in_gpt_response");
  }

  // base64 → Buffer
  const outBytes = Buffer.from(base64Image, "base64");
  return outBytes;
}

//
// ─────────────────────────────
// /upload 라우트
// 프론트(FormData):
//   nickname: "사용자닉네임"
//   photo: (File)
// ─────────────────────────────
//
app.post("/upload", upload.single("photo"), async (req, res) => {
  try {
    // 1. 닉네임 처리
    const rawNickname = req.body.nickname || "";
    const cleanName = sanitizeName(rawNickname);

    // 2. 타임스탬프
    const stamp = makeKRTimestamp();

    // 3. baseName
    const baseName = `${cleanName}_${stamp}`;

    // 4. 업로드된 파일 여부 확인
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({
        ok: false,
        message: "no file uploaded"
      });
    }

    const originalBuffer = req.file.buffer;

    // 5. 원본을 PNG로 정규화 → Dropbox /booth_uploads 에 저장
    const normalizedPngBuffer = await toPng(originalBuffer);
    const originalDesiredPath = `/booth_uploads/${baseName}.png`;
    const uploadedOriginal = await uploadToDropbox(
      originalDesiredPath,
      normalizedPngBuffer
    );
    const originalCanonicalPath = uploadedOriginal.path_lower;

    // 6. 512x512 PNG 버전 생성
    const resizedBuffer = await toPng512(originalBuffer);

    // 7. GPT 스타일 변환 (이제 Dropbox 공유링크 없음, 바로 base64로)
    let stylizedBuffer;
    try {
      stylizedBuffer = await stylizeWithGPT(resizedBuffer, STYLE_REF_LOCAL);
    } catch (err) {
      console.error("❌ stylizeWithGPT failed:", err);
      return res.status(500).json({
        ok: false,
        step: "stylize",
        message: "style transform failed",
        details: String(err.message || err)
      });
    }

    // 8. 변환된 이미지를 Dropbox /booth_outputs 에 저장 (아카이브)
    const stylizedDesiredPath = `/booth_outputs/${baseName}_stylized.png`;
    const uploadedStylized = await uploadToDropbox(
      stylizedDesiredPath,
      stylizedBuffer
    );
    const stylizedCanonicalPath = uploadedStylized.path_lower;

    // 9. 성공 응답
    return res.json({
      ok: true,
      message: "upload + stylize complete",
      originalPath: originalCanonicalPath,
      stylizedPath: stylizedCanonicalPath
    });
  } catch (err) {
    console.error("서버 내부 오류:", err);
    return res.status(500).json({
      ok: false,
      message: "server error",
      details: String(err.message || err)
    });
  }
});

//
// ─────────────────────────────
// 헬스 체크
// ─────────────────────────────
//
app.get("/health", (req, res) => {
  res.json({ ok: true, status: "alive" });
});

//
// ─────────────────────────────
// 서버 스타트
// ─────────────────────────────
//
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 booth-proxy running on :${PORT}`);
});
