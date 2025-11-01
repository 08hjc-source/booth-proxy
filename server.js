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

// 환경 변수
let DROPBOX_TOKEN = process.env.DROPBOX_TOKEN || "";
let OPENAI_KEY = process.env.OPENAI_KEY || "";

// Dropbox Authorization 헤더 보정
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

// 스타일 기준 이미지 (256x256 PNG 준비 권장)
const STYLE_REF_LOCAL = path.join(__dirname, "assets", "style_ref_all.png");

//
// ─────────────────────────────
// multer: 수신 이미지 메모리 저장
// ─────────────────────────────
//
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024 // 15MB
  }
});

//
// ─────────────────────────────
// 유틸 함수
// ─────────────────────────────
//

// Dropbox 경로 안전 닉네임
function sanitizeName(name) {
  if (!name) return "guest";
  const asciiOnly = name.replace(/[^a-zA-Z0-9_-]/g, "");
  return asciiOnly.length > 0 ? asciiOnly : "guest";
}

// KST HHMMSS
function makeKRTimestamp() {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `${hh}${mm}${ss}`;
}

//
// ─────────────────────────────
// Dropbox 업로드
// ─────────────────────────────
//
async function uploadToDropbox(dropboxPath, fileBytes) {
  console.log("DEBUG dropbox upload path:", dropboxPath);

  const resp = await fetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      Authorization: dbxAuthHeader(),
      "Dropbox-API-Arg": JSON.stringify({
        path: dropboxPath,
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
// OpenAI 스타일 변환
// ─────────────────────────────
//
async function stylizeWithGPT(userPngBuffer) {
  // user 이미지 data URL (256x256 PNG)
  const userB64 = userPngBuffer.toString("base64");
  const userDataUrl = `data:image/png;base64,${userB64}`;

  // style ref data URL
  let styleBuf;
  try {
    styleBuf = fs.readFileSync(STYLE_REF_LOCAL);
  } catch (e) {
    console.error("❌ style reference load failed:", e);
    return {
      ok: false,
      errorType: "style_ref_missing",
      message: "스타일 기준 이미지가 없습니다."
    };
  }
  const styleB64 = styleBuf.toString("base64");
  const styleDataUrl = `data:image/png;base64,${styleB64}`;

  console.log("DEBUG calling OpenAI with:");
  console.log("DEBUG OPENAI KEY preview:", (OPENAI_KEY || "").slice(0, 12));

  // 프롬프트를 짧게 해서 토큰 절약
  const promptText =
    "Apply the second image's style to the first person. " +
    "Keep pose, hair, and clothing colors. " +
    "Clean linework, flat fills, minimal shading. " +
    "White background only. No text.";

  const gptRequestBody = {
    model: "gpt-4o-mini-2024-07-18",
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: promptText
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

    if (
      result &&
      result.error &&
      result.error.code === "rate_limit_exceeded"
    ) {
      return {
        ok: false,
        errorType: "rate_limit",
        message:
          "요청이 많아 잠시 대기 중입니다. 다시 시도해주세요."
      };
    }

    return {
      ok: false,
      errorType: "openai_error",
      message: "스타일 변환 실패 (API 오류)"
    };
  }

  // 응답에서 base64 PNG 뽑기
  let base64Image = null;

  if (
    result.output &&
    Array.isArray(result.output) &&
    result.output[0] &&
    Array.isArray(result.output[0].content)
  ) {
    for (const chunk of result.output[0].content) {
      if (
        chunk.type === "output_image" &&
        chunk.image &&
        typeof chunk.image.b64_json === "string"
      ) {
        base64Image = chunk.image.b64_json;
        break;
      }
      if (
        chunk.type === "output_image" &&
        typeof chunk.image === "string"
      ) {
        base64Image = chunk.image;
        break;
      }
    }
  }

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
    return {
      ok: false,
      errorType: "no_image",
      message: "이미지 결과를 받지 못했습니다."
    };
  }

  const outBytes = Buffer.from(base64Image, "base64");
  return {
    ok: true,
    buffer: outBytes
  };
}

//
// ─────────────────────────────
// /upload 라우트
// 프론트(FormData):
//   nickname: string
//   photo:   Blob(256x256 PNG)
// ─────────────────────────────
//
app.post("/upload", upload.single("photo"), async (req, res) => {
  try {
    const rawNickname = req.body.nickname || "";
    const cleanName = sanitizeName(rawNickname);
    const stamp = makeKRTimestamp();

    if (!req.file || !req.file.buffer) {
      return res.status(400).json({
        ok: false,
        message: "이미지가 없습니다."
      });
    }

    // 프론트에서 이미 256x256 PNG로 온 상태
    const capturedBuffer = req.file.buffer;

    // 스타일 변환 시도
    const styleResult = await stylizeWithGPT(capturedBuffer);

    if (!styleResult.ok) {
      // 실패해도 입력 이미지는 기록해 두자 (관객 참여 이력)
      const failBase = `${cleanName}_${stamp}_fail`;
      const capturedFailPath = `/booth_uploads/${failBase}.png`;
      try {
        await uploadToDropbox(capturedFailPath, capturedBuffer);
      } catch (e) {
        console.error("Dropbox backup fail upload error:", e);
      }

      // 관객에게 사유 그대로 전달 (rate_limit 등)
      return res.status(429).json({
        ok: false,
        step: "stylize",
        errorType: styleResult.errorType,
        message: styleResult.message
      });
    }

    // 성공: Dropbox에 입력/결과 모두 저장
    const baseName = `${cleanName}_${stamp}`;

    const capturedDropboxPath = `/booth_uploads/${baseName}.png`;
    const upIn = await uploadToDropbox(
      capturedDropboxPath,
      capturedBuffer
    );
    const capturedCanonicalPath = upIn.path_lower;

    const stylizedDropboxPath = `/booth_outputs/${baseName}_stylized.png`;
    const upOut = await uploadToDropbox(
      stylizedDropboxPath,
      styleResult.buffer
    );
    const stylizedCanonicalPath = upOut.path_lower;

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
// /health 라우트
// ─────────────────────────────
//
app.get("/health", (req, res) => {
  res.json({ ok: true, status: "alive" });
});

//
// ─────────────────────────────
// 서버 시작
// ─────────────────────────────
//
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 booth-proxy running on :${PORT}`);
});
