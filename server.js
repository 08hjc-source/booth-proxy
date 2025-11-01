import express from "express";
import multer from "multer";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
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

// 환경 변수 (Render에서 설정)
let DROPBOX_TOKEN = process.env.DROPBOX_TOKEN || "";
let OPENAI_KEY = process.env.OPENAI_KEY || "";

// Dropbox Authorization 헤더 포맷 정규화
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

// 스타일 참조 이미지는 고정 리소스
// server.js랑 같은 폴더 위치 기준 ./assets/style_ref_all.png 에 넣어둘 것
const STYLE_REF_LOCAL = path.join(__dirname, "assets", "style_ref_all.png");

//
// ─────────────────────────────
// multer: 촬영 이미지를 메모리로 수신
// ─────────────────────────────
//
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024 // 15MB 제한
  }
});

//
// ─────────────────────────────
// 유틸 함수
// ─────────────────────────────
//

// 닉네임에서 위험한 문자 제거 (Dropbox 경로에 쓸 거라서)
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
  return `${hh}${mm}${ss}`; // "071728"
}

//
// ─────────────────────────────
// Dropbox 업로드 함수
// (공유링크 만들지 않는다. 단순 저장만 한다.)
// ─────────────────────────────
//
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
  return data; // { path_lower, ... }
}

//
// ─────────────────────────────
// OpenAI 스타일 변환
// (프런트에서 이미 512×512 PNG로 줄여서 보내줬다고 가정)
// ─────────────────────────────
//
async function stylizeWithGPT(userPngBuffer, styleRefPath) {
  // 1. 사용자 이미지(512x512 PNG) → data URL
  const userB64 = userPngBuffer.toString("base64");
  const userDataUrl = `data:image/png;base64,${userB64}`;

  // 2. 스타일 레퍼런스 PNG → data URL
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

  // 3. OpenAI 요청 바디
  // image_url 필드에 data URL을 넣는다 (image_data 대신 image_url)
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

  // 4. OpenAI 호출
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

  // 5. OpenAI 응답에서 base64 PNG 뽑기
  let base64Image = null;

  if (
    result.output &&
    Array.isArray(result.output) &&
    result.output[0] &&
    Array.isArray(result.output[0].content)
  ) {
    for (const chunk of result.output[0].content) {
      // case 1: { type:"output_image", image:{ b64_json:"..." } }
      if (
        chunk.type === "output_image" &&
        chunk.image &&
        typeof chunk.image.b64_json === "string"
      ) {
        base64Image = chunk.image.b64_json;
        break;
      }
      // case 2: { type:"output_image", image:"iVBOR..." }
      if (
        chunk.type === "output_image" &&
        typeof chunk.image === "string"
      ) {
        base64Image = chunk.image;
        break;
      }
    }
  }

  // fallback (다른 응답 스타일 대응)
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

  // 6. 최종 PNG Buffer
  const outBytes = Buffer.from(base64Image, "base64");
  return outBytes;
}

//
// ─────────────────────────────
// /upload 라우트
// 프런트(FormData)에서
//   nickname: 문자열
//   photo: 512x512 PNG Blob
// 을 보낸다고 가정
// ─────────────────────────────
//
app.post("/upload", upload.single("photo"), async (req, res) => {
  try {
    // 1. 닉네임 처리
    const rawNickname = req.body.nickname || "";
    const cleanName = sanitizeName(rawNickname); // 경로 안전화

    // 2. 타임스탬프
    const stamp = makeKRTimestamp();

    // 3. 업로드된 이미지 확인
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({
        ok: false,
        message: "no file uploaded"
      });
    }

    // 프런트에서 이미 512×512 PNG로 만든 걸 보내주고 있다.
    // ⇒ 이걸 바로 stylizeWithGPT에 넣는다.
    const captured512Buffer = req.file.buffer;

    // 4. 스타일 변환
    let stylizedBuffer;
    try {
      stylizedBuffer = await stylizeWithGPT(captured512Buffer, STYLE_REF_LOCAL);
    } catch (err) {
      console.error("❌ stylizeWithGPT failed:", err);
      return res.status(500).json({
        ok: false,
        step: "stylize",
        message: "style transform failed",
        details: String(err.message || err)
      });
    }

    // 5. Dropbox에 저장 (원본/결과 둘 다 남기고 싶으면 둘 다 올림)
    const baseName = `${cleanName}_${stamp}`;

    // 5-1. 사용자가 찍은 512x512 PNG 저장
    const capturedDropboxPath = `/booth_uploads/${baseName}.png`;
    const uploadedCaptured = await uploadToDropbox(
      capturedDropboxPath,
      captured512Buffer
    );
    const capturedCanonicalPath = uploadedCaptured.path_lower;

    // 5-2. 변환된 스타일 PNG 저장
    const stylizedDropboxPath = `/booth_outputs/${baseName}_stylized.png`;
    const uploadedStylized = await uploadToDropbox(
      stylizedDropboxPath,
      stylizedBuffer
    );
    const stylizedCanonicalPath = uploadedStylized.path_lower;

    // 6. 정상 응답
    return res.json({
      ok: true,
      message: "upload + stylize complete",
      inputPath: capturedCanonicalPath,
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
