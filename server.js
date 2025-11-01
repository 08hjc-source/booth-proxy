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

// 환경변수 (Render 대시보드에서 설정해야 함)
let DROPBOX_TOKEN = process.env.DROPBOX_TOKEN || "";
let OPENAI_KEY = process.env.OPENAI_KEY || "";

// Dropbox Authorization 헤더 normalize
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

// 스타일 기준 이미지 (반드시 repo에 포함되어야 함)
// 권장: 256x256 PNG 하나 넣어두기
const STYLE_REF_LOCAL = path.join(__dirname, "assets", "style_ref_all.png");

//
// ─────────────────────────────
// multer 설정: 업로드 이미지를 메모리로 받음
// (이미 프론트에서 256x256 PNG로 만들어서 전송한다고 가정)
// ─────────────────────────────
//
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024, // 15MB
  },
});

//
// ─────────────────────────────
// 유틸 함수
// ─────────────────────────────
//

// 닉네임을 Dropbox 경로-safe하게 정규화
function sanitizeName(name) {
  if (!name) return "guest";
  const asciiOnly = name.replace(/[^a-zA-Z0-9_-]/g, "");
  return asciiOnly.length > 0 ? asciiOnly : "guest";
}

// 한국시간(HHMMSS)
function makeKRTimestamp() {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `${hh}${mm}${ss}`;
}

//
// Dropbox 업로드 (공유링크 X, 내부 기록용)
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
        strict_conflict: false,
      }),
      "Content-Type": "application/octet-stream",
    },
    body: fileBytes,
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
// OpenAI 스타일 변환 로직
// (프런트에서 이미 256x256 PNG를 보냈다고 가정)
// ─────────────────────────────
//
async function stylizeWithGPT(userPngBuffer) {
  // 1. 사용자 이미지 -> data URL
  const userB64 = userPngBuffer.toString("base64");
  const userDataUrl = `data:image/png;base64,${userB64}`;

  // 2. 스타일 레퍼런스 이미지 로드 -> data URL
  let styleBuf;
  try {
    styleBuf = fs.readFileSync(STYLE_REF_LOCAL);
  } catch (e) {
    console.error("❌ style reference load failed:", e);
    return {
      ok: false,
      errorType: "style_ref_missing",
      message: "스타일 기준 이미지가 없습니다.",
    };
  }
  const styleB64 = styleBuf.toString("base64");
  const styleDataUrl = `data:image/png;base64,${styleB64}`;

  // 3. 프롬프트 (짧게, 토큰 절약)
  const promptText =
    "Apply the second image's style to the first person. " +
    "Keep pose, hair, and clothing colors. " +
    "Clean linework, flat fills, minimal shading. " +
    "White background only. No text.";

  // 4. OpenAI 요청 바디
  const gptRequestBody = {
    model: "gpt-4o-mini-2024-07-18",
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: promptText,
          },
          {
            type: "input_image",
            image_url: userDataUrl,
          },
          {
            type: "input_image",
            image_url: styleDataUrl,
          },
        ],
      },
    ],
  };

  // 5. 실제 호출
  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(gptRequestBody),
  });

  const result = await resp.json();

  if (!resp.ok) {
    console.error("GPT style remix fail:", result);

    // rate limit은 따로 구분해서 프론트에 그대로 전달
    if (result?.error?.code === "rate_limit_exceeded") {
      return {
        ok: false,
        errorType: "rate_limit",
        message:
          "요청이 많아 변환이 지연 중입니다. 잠시 후 다시 시도해주세요.",
      };
    }

    return {
      ok: false,
      errorType: "openai_error",
      message: "스타일 변환 실패 (API 오류)",
    };
  }

  // 6. OpenAI 응답에서 base64 PNG 찾기
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

  // fallback 구조
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
      message: "이미지 결과를 받지 못했습니다.",
    };
  }

  // 7. 최종 PNG Buffer
  const outBytes = Buffer.from(base64Image, "base64");
  return {
    ok: true,
    buffer: outBytes,
  };
}

//
// ─────────────────────────────
// 큐(Queue) 구현
//   - 동시에 여러 사람이 눌러도 OpenAI 호출은 한 번에 하나씩만.
//   - TPM(토큰/분당) 한도를 순간적으로 다 써버리는 걸 방지.
// ─────────────────────────────
//

// 전역 큐와 상태
const jobQueue = [];
let queueBusy = false;

// 짧은 sleep
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 큐에 넣고 결과 Promise로 받기
function enqueueStylize(userPngBuffer) {
  return new Promise((resolve) => {
    jobQueue.push({ userPngBuffer, resolve });
    if (!queueBusy) {
      processQueue();
    }
  });
}

// 큐를 실제로 소비
async function processQueue() {
  queueBusy = true;
  while (jobQueue.length > 0) {
    const job = jobQueue.shift();

    const result = await stylizeWithGPT(job.userPngBuffer).catch((e) => {
      console.error("stylizeWithGPT threw:", e);
      return {
        ok: false,
        errorType: "queue_internal_error",
        message: String(e?.message || e),
      };
    });

    job.resolve(result);

    // 호출 사이에 텀을 준다 (TPM 급발진 방지)
    await sleep(1500);
  }
  queueBusy = false;
}

//
// ─────────────────────────────
// /upload 라우트
// 프론트(FormData):
//   nickname: string
//   photo:    Blob(256x256 PNG)
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
        message: "이미지가 없습니다.",
      });
    }

    // 프론트에서 이미 256x256 PNG
    const capturedBuffer = req.file.buffer;

    // 여기서 바로 OpenAI를 호출하지 않고, 큐에 넣어서 순차 처리
    const styleResult = await enqueueStylize(capturedBuffer);

    if (!styleResult.ok) {
      // 실패하더라도 입력 이미지는 기록해 둔다
      const failBase = `${cleanName}_${stamp}_fail`;
      const capturedFailPath = `/booth_uploads/${failBase}.png`;

      try {
        await uploadToDropbox(capturedFailPath, capturedBuffer);
      } catch (e) {
        console.error("Dropbox backup fail upload error:", e);
      }

      // 관객에게 사유 그대로 알려주기
      // rate_limit이면 프론트가 "잠시 후 다시 전송" 메시지를 보여주게 되어 있다
      return res.status(429).json({
        ok: false,
        step: "stylize",
        errorType: styleResult.errorType,
        message: styleResult.message,
      });
    }

    // 성공 시, 입력 원본 + 스타일 결과 둘 다 Dropbox에 저장
    const baseName = `${cleanName}_${stamp}`;

    // 입력 저장
    const capturedDropboxPath = `/booth_uploads/${baseName}.png`;
    const upIn = await uploadToDropbox(
      capturedDropboxPath,
      capturedBuffer
    );
    const capturedCanonicalPath = upIn.path_lower;

    // 결과 저장
    const stylizedDropboxPath = `/booth_outputs/${baseName}_stylized.png`;
    const upOut = await uploadToDropbox(
      stylizedDropboxPath,
      styleResult.buffer
    );
    const stylizedCanonicalPath = upOut.path_lower;

    // 정상 응답
    return res.json({
      ok: true,
      message: "upload + stylize complete",
      inputPath: capturedCanonicalPath,
      stylizedPath: stylizedCanonicalPath,
    });
  } catch (err) {
    console.error("서버 내부 오류:", err);
    return res.status(500).json({
      ok: false,
      message: "server error",
      details: String(err.message || err),
    });
  }
});

//
// 헬스 체크
//
app.get("/health", (req, res) => {
  res.json({ ok: true, status: "alive" });
});

//
// 서버 시작
//
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 booth-proxy running on :${PORT}`);
});
