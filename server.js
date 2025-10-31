import express from "express";
import multer from "multer";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

// __dirname 대용 (ESM 환경)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ====== 환경변수 ======
const DROPBOX_TOKEN = process.env.DROPBOX_TOKEN; // "Bearer xxxx..."
const OPENAI_KEY = process.env.OPENAI_KEY;       // "sk-xxxx..."

if (!DROPBOX_TOKEN) {
  console.warn("⚠️ WARNING: DROPBOX_TOKEN not set");
}
if (!OPENAI_KEY) {
  console.warn("⚠️ WARNING: OPENAI_KEY not set");
}

// ====== multer 설정 (메모리 저장) ======
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024 // 15MB 정도 안전빵
  }
});

// ====== helpers ======

// 한글/특수문자 제거해서 Dropbox 안전한 파일명 fragment 만들기
function sanitizeName(name) {
  if (!name) return "guest";
  const asciiOnly = name.replace(/[^a-zA-Z0-9_-]/g, "");
  return asciiOnly.length > 0 ? asciiOnly : "guest";
}

// 한국 시간(HHMMSS) 스탬프 생성 (24시간 기준)
function makeKRTimestamp() {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000); // UTC+9
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `${hh}${mm}${ss}`; // 예: "195342"
}

// Dropbox 업로드
async function uploadToDropbox(pathInDropbox, fileBytes) {
  // 디버그로 토큰 앞부분만 찍기 (전체 노출 금지)
  console.log(
    "DEBUG dropbox token preview:",
    (DROPBOX_TOKEN || "").slice(0, 20)
  );
  console.log("DEBUG dropbox upload path:", pathInDropbox);

  const resp = await fetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      Authorization: DROPBOX_TOKEN,
      "Dropbox-API-Arg": JSON.stringify({
        path: pathInDropbox,
        mode: "add",
        autorename: true,
        mute: false
      }),
      "Content-Type": "application/octet-stream"
    },
    body: fileBytes
  });

  if (resp.ok) {
    const data = await resp.json();
    console.log("✅ Dropbox upload success:", data.path_lower);
    return data;
  }

  const errText = await resp.text();
  console.error("Dropbox upload fail (raw):", errText);
  throw new Error("dropbox upload failed: " + errText);
}

// buffer -> data URL (png)
function bufferToDataUrlPNG(buf) {
  const b64 = buf.toString("base64");
  return `data:image/png;base64,${b64}`;
}

// 방문자 원본 이미지를 512x512 PNG로 리사이즈
async function resizeTo512(buffer) {
  const resizedBuffer = await sharp(buffer)
    .resize(512, 512, { fit: "cover" })
    .png()
    .toBuffer();
  return resizedBuffer;
}

// GPT 스타일 변환 호출
// 인자: resizedBuffer(512x512 PNG buffer), style_ref_all.png (스타일 합본 한 장)
// 반환: Buffer (최종 변환된 이미지 바이트)  또는 throw
async function stylizeWithGPT(resizedBuffer) {
  // 준비: 방문자 이미지 base64
  const base64User = resizedBuffer.toString("base64");

  // 준비: 스타일 참조 (1장짜리 합본)
  const stylePath = path.join(__dirname, "style_ref_all.png");
  let styleBuf;
  try {
    styleBuf = fs.readFileSync(stylePath);
  } catch (e) {
    console.error("❌ style_ref_all.png not found next to server.js");
    throw new Error("missing_style_reference");
  }
  const base64Style = styleBuf.toString("base64");

  // GPT 요청: 'gpt-4o-mini-2024-07-18' 사용
  // 멀티모달 입력 규격:
  // - type: "input_image" + image_data: <base64>  (우리가 가정하는 형식)
  // - type: "input_text"  텍스트 지시
  //
  // 이 모델은 "내가 준 사람 사진을 스타일 이미지처럼 그려줘"를 이해하고
  // 응답 안에서 base64(혹은 output_image 구조)를 돌려주는 걸 목표로 함.
  const gptRequestBody = {
    model: "gpt-4o-mini-2024-07-18",
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              "You are an illustration generator. " +
              "Redraw the person from the first photo as a stylized character. " +
              "Use the line quality, color blocking, shading style, face style, and body proportions from the style reference. " +
              "Keep the same hairstyle, clothing colors, and overall pose from the original person. " +
              "Return a clean character illustration on plain white background. No text, no watermark."
          },
          {
            // 방문자 실제 사진
            type: "input_image",
            image_data: base64User
          },
          {
            // 스타일 레퍼런스 이미지 (4장 합쳐놓은 한 장)
            type: "input_image",
            image_data: base64Style
          }
        ]
      }
    ]
  };

  console.log("DEBUG calling OpenAI with reduced payload...");
  console.log(
    "DEBUG OPENAI KEY preview:",
    (OPENAI_KEY || "").slice(0, 12)
  );

  // OpenAI 호출
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

  // 여기서 모델 응답 구조를 까서 base64 PNG를 뽑아야 함.
  // 다양한 경우를 대비해서 순서대로 검사한다.

  console.log(
    "DEBUG GPT raw result summary:",
    JSON.stringify(
      {
        model: result.model,
        status: result.status,
        keys: Object.keys(result)
      },
      null,
      2
    )
  );

  let base64Image = null;

  // Case 1: result.output[0].content[*].image.b64_json 스타일
  if (result.output && result.output[0] && Array.isArray(result.output[0].content)) {
    for (const chunk of result.output[0].content) {
      // 예상 형태 1:
      // {
      //   type: "output_image",
      //   image: { b64_json: "..." }
      // }
      if (
        chunk.type === "output_image" &&
        chunk.image &&
        chunk.image.b64_json
      ) {
        base64Image = chunk.image.b64_json;
        break;
      }

      // 혹시 다른 형태로 "image" 바로 base64 string일 수도 있으니까 방어
      if (
        chunk.type === "output_image" &&
        typeof chunk.image === "string" &&
        chunk.image.startsWith("iVBOR") // PNG 헤더 ("iVBORw0KGgo")
      ) {
        base64Image = chunk.image;
        break;
      }
    }
  }

  // Case 2: 옛 스타일 result.data[0].b64_json
  if (!base64Image && result.data && result.data[0] && result.data[0].b64_json) {
    base64Image = result.data[0].b64_json;
  }

  // Case 3: 이미지가 아예 안 왔고 텍스트만 왔을 때
  if (!base64Image) {
    console.warn(
      "⚠️ GPT did not return an image. Full result.output[0].content:",
      JSON.stringify(
        result.output && result.output[0] ? result.output[0].content : null,
        null,
        2
      )
    );
    throw new Error("no_image_in_gpt_response");
  }

  // base64 → Buffer
  const outBytes = Buffer.from(base64Image, "base64");
  return outBytes;
}

// ====== /upload 라우트 ======
//
// 프론트(프레이머)에서 form-data로 전송한다고 가정
// 필드:
//   - nickname (텍스트)
//   - photo (파일 / binary)
// 응답(JSON):
//   {
//     ok: true/false,
//     message: "...",
//     originalPath: "/booth_uploads/...",
//     stylizedPath: "/booth_outputs/..."
//   }
//
// 흐름:
// 1. 닉네임 가져오기
// 2. 현재 한국시간으로 timestamp 뽑기
// 3. Dropbox 파일명 생성 (한글 제거)
// 4. 원본 이미지를 Dropbox에 저장 (PNG 변환해서 넣는 게 깔끔하므로 sharp로 png 저장)
// 5. 512x512로 줄인 버전으로 GPT 변환 요청
// 6. GPT 결과 이미지를 Dropbox에 저장
//
app.post("/upload", upload.single("photo"), async (req, res) => {
  try {
    // 1. 닉네임 처리
    const rawNickname = req.body.nickname || "";
    const cleanName = sanitizeName(rawNickname);

    // 2. 시간 스탬프 (한국 기준 HHMMSS)
    const stamp = makeKRTimestamp();

    // 3. 기본 파일명
    const baseName = `${cleanName}_${stamp}`;

    // 4. 업로드된 파일(raw buffer)
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ ok: false, message: "no file uploaded" });
    }
    const originalBuffer = req.file.buffer;

    // 5. 원본을 PNG로 정규화 (sharp로 png 변환만)
    const normalizedPngBuffer = await sharp(originalBuffer).png().toBuffer();

    // 6. Dropbox에 원본 저장
    const originalDropboxPath = `/booth_uploads/${baseName}.png`;
    await uploadToDropbox(originalDropboxPath, normalizedPngBuffer);

    // 7. 방문자 이미지를 512x512 PNG로 축소
    const resizedBuffer = await resizeTo512(originalBuffer);

    // 8. GPT에 스타일 변환 요청 (rate limit 줄이기 위해 스타일 이미지는 style_ref_all.png 하나만 사용)
    let stylizedBuffer;
    try {
      stylizedBuffer = await stylizeWithGPT(resizedBuffer);
    } catch (err) {
      console.error("❌ stylizeWithGPT failed:", err);
      return res.status(500).json({
        ok: false,
        message: "style transform failed",
        details: String(err.message || err)
      });
    }

    // 9. 스타일 결과 Dropbox에 저장
    const stylizedDropboxPath = `/booth_outputs/${baseName}_stylized.png`;
    await uploadToDropbox(stylizedDropboxPath, stylizedBuffer);

    // 10. 응답
    return res.json({
      ok: true,
      message: "upload + stylize complete",
      originalPath: originalDropboxPath,
      stylizedPath: stylizedDropboxPath
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

// 헬스체크용
app.get("/health", (req, res) => {
  res.json({ ok: true, status: "alive" });
});

// Render가 기본적으로 10000 같은 포트 안쓰고 PORT env 씀
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 booth-proxy running on :${PORT}`);
});
