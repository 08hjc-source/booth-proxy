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

// ─────────────────────────────
// 환경변수 (Render 대시보드에 등록해야 함)
// ─────────────────────────────
//
// 필수:
//   DROPBOX_REFRESH_TOKEN=   (네가 방금 발급받은 refresh_token)
//   DROPBOX_APP_KEY=         (Dropbox app key)
//   DROPBOX_APP_SECRET=      (Dropbox app secret)
//   OPENAI_KEY=              (OpenAI API Key)
//
const DROPBOX_REFRESH_TOKEN = process.env.DROPBOX_REFRESH_TOKEN || "";
const DROPBOX_APP_KEY = process.env.DROPBOX_APP_KEY || "";
const DROPBOX_APP_SECRET = process.env.DROPBOX_APP_SECRET || "";
const OPENAI_KEY = process.env.OPENAI_KEY || "";

if (!DROPBOX_REFRESH_TOKEN) {
  console.warn("⚠️ DROPBOX_REFRESH_TOKEN not set");
}
if (!DROPBOX_APP_KEY) {
  console.warn("⚠️ DROPBOX_APP_KEY not set");
}
if (!DROPBOX_APP_SECRET) {
  console.warn("⚠️ DROPBOX_APP_SECRET not set");
}
if (!OPENAI_KEY) {
  console.warn("⚠️ OPENAI_KEY not set");
}

// ─────────────────────────────
// Dropbox 액세스 토큰 관리
// ─────────────────────────────
//
// Dropbox는 이제 long-lived access token을 안 주고
// refresh_token으로 short-lived access token을 계속 갱신하는 구조다.
//
// 여기서는 서버 프로세스 메모리에
// currentAccessToken 과 만료 예정 시각을 들고 있다가
// 만료되면 자동으로 새 토큰을 받아온다.
//

let currentAccessToken = "";
let accessTokenExpiresAt = 0; // ms timestamp

// 내부 유틸: 실제 Dropbox access_token 새로 발급
async function fetchNewDropboxAccessToken() {
  const resp = await fetch("https://api.dropbox.com/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: DROPBOX_REFRESH_TOKEN,
      client_id: DROPBOX_APP_KEY,
      client_secret: DROPBOX_APP_SECRET,
    }),
  });

  const data = await resp.json();

  if (!resp.ok) {
    console.error("❌ Dropbox token refresh 실패:", data);
    throw new Error("Dropbox refresh 실패");
  }

  // data.access_token 은 짧게 유효한 bearer token
  // data.expires_in 은 초 단위 유효기간 (예: 14400 = 4시간)
  currentAccessToken = data.access_token || "";
  const lifetimeSec = data.expires_in || 60 * 60; // fallback 1h
  accessTokenExpiresAt = Date.now() + lifetimeSec * 1000;

  console.log(
    "✅ Dropbox access_token 갱신 완료:",
    currentAccessToken.slice(0, 10) + "...",
    "유효(ms until exp):",
    lifetimeSec * 1000
  );

  return currentAccessToken;
}

// 외부에서 Dropbox 쓰기 전에 호출해서
// 항상 유효한 토큰을 돌려주는 헬퍼
async function ensureDropboxAccessToken() {
  const now = Date.now();

  // 토큰이 없거나 만료 임박(여기서는 30초 미만 남으면 갱신)하면 새로 발급
  if (
    !currentAccessToken ||
    now > accessTokenExpiresAt - 30 * 1000
  ) {
    return await fetchNewDropboxAccessToken();
  }

  return currentAccessToken;
}

//
// ─────────────────────────────
// multer 설정
// 프론트에서 256x256 PNG Blob으로 전송한다고 가정
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
function sanitizeName(name) {
  if (!name) return "guest";
  const asciiOnly = name.replace(/[^a-zA-Z0-9_-]/g, "");
  return asciiOnly.length > 0 ? asciiOnly : "guest";
}

function makeKRTimestamp() {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `${hh}${mm}${ss}`; // 예: "134512"
}

// 스타일 기준 이미지 (반드시 repo에 포함되어야 함)
// 권장: 192x192 또는 256x256 PNG
const STYLE_REF_LOCAL = path.join(__dirname, "assets", "style_ref_all.png");

//
// ─────────────────────────────
// Dropbox 업로드 (공유링크 X, 내부 기록용)
// Authorization 헤더는 ensureDropboxAccessToken()으로 항상 최신 토큰 사용
// ─────────────────────────────
async function uploadToDropbox(dropboxPath, fileBytes) {
  console.log("DEBUG dropbox upload path:", dropboxPath);

  // 유효한 access_token 확보
  const accessToken = await ensureDropboxAccessToken();

  const resp = await fetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
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
  return data;
}

//
// ─────────────────────────────
// OpenAI 스타일 변환 로직
// (프런트에서 이미 256x256 PNG를 보냈다고 가정)
// ─────────────────────────────
async function stylizeWithGPT(userPngBuffer) {
  // 1. 사용자 이미지 → data URL
  const userB64 = userPngBuffer.toString("base64");
  const userDataUrl = `data:image/png;base64,${userB64}`;

  // 2. 스타일 레퍼런스 이미지 → data URL
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

  // 3. 짧은 프롬프트 (토큰 절약)
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

    // rate limit은 따로 프런트에서 안내할 수 있게 구분
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

  // 6. OpenAI 응답에서 base64 PNG 추출
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

  // 최종 PNG Buffer
  const outBytes = Buffer.from(base64Image, "base64");
  return {
    ok: true,
    buffer: outBytes,
  };
}

//
// ─────────────────────────────
// 큐(Queue) 구현
// 동시에 여러 명이 제출해도 OpenAI 호출은 직렬 처리하도록 해서
// 분당 토큰 한도(TPM) 폭발 방지
// ─────────────────────────────
const jobQueue = [];
let queueBusy = false;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function enqueueStylize(userPngBuffer) {
  return new Promise((resolve) => {
    jobQueue.push({ userPngBuffer, resolve });
    if (!queueBusy) {
      processQueue();
    }
  });
}

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

    // 호출 사이 텀: TPM 급발진 방지
    await sleep(1500);
  }
  queueBusy = false;
}

//
// ─────────────────────────────
// /upload 라우트
// 프론트(FormData):
//   nickname: string
//   photo:    Blob(256x256 PNG or 192x192 PNG)
// ─────────────────────────────
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

    // 프론트에서 이미 정사각 PNG로 보낸다.
    const capturedBuffer = req.file.buffer;

    // OpenAI 스타일 변환은 큐에 넣어 순차 처리
    const styleResult = await enqueueStylize(capturedBuffer);

    if (!styleResult.ok) {
      // 변환 실패해도, 업로드된 원본은 Dropbox에 남겨서 보관
      const failBase = `${cleanName}_${stamp}_fail`;
      const capturedFailPath = `/booth_uploads/${failBase}.png`;

      try {
        await uploadToDropbox(capturedFailPath, capturedBuffer);
      } catch (e) {
        console.error("Dropbox backup fail upload error:", e);
      }

      // 프론트에 사유 그대로 전달
      return res.status(429).json({
        ok: false,
        step: "stylize",
        errorType: styleResult.errorType,
        message: styleResult.message,
      });
    }

    // 스타일 변환까지 성공
    const baseName = `${cleanName}_${stamp}`;

    // 1) 입력 이미지 저장
    const capturedDropboxPath = `/booth_uploads/${baseName}.png`;
    const upIn = await uploadToDropbox(
      capturedDropboxPath,
      capturedBuffer
    );
    const capturedCanonicalPath = upIn.path_lower;

    // 2) 변환 결과 저장
    const stylizedDropboxPath = `/booth_outputs/${baseName}_stylized.png`;
    const upOut = await uploadToDropbox(
      stylizedDropboxPath,
      styleResult.buffer
    );
    const stylizedCanonicalPath = upOut.path_lower;

    // 프론트 응답
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
app.get("/health", async (req, res) => {
  // 드롭박스 토큰이 지금 유효한지도 같이 체크해주면 운영자가 보기 편함
  let dropboxOk = true;
  try {
    await ensureDropboxAccessToken();
  } catch (e) {
    dropboxOk = false;
  }

  res.json({
    ok: true,
    dropboxAuth: dropboxOk,
    status: "alive",
  });
});

//
// 서버 시작
//
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 booth-proxy running on :${PORT}`);
});
