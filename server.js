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

// Render 환경변수로 넣어둔 값 사용
const DROPBOX_TOKEN = process.env.DROPBOX_TOKEN; // "Bearer sl.u.~~~~"
const OPENAI_KEY = process.env.OPENAI_KEY;       // "sk-~~~~"

if (!DROPBOX_TOKEN) {
  console.warn("⚠️ DROPBOX_TOKEN not set");
}
if (!OPENAI_KEY) {
  console.warn("⚠️ OPENAI_KEY not set");
}

// 스타일 참조 이미지는 Dropbox에 미리 올려둔다.
// 예: /style/style_ref_all.png
// (너가 직접 Dropbox에 업로드해둔 상태라고 가정)
const STYLE_DBX_PATH = "/style/style_ref_all.png";

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

// 닉네임에서 Dropbox 경로에 문제될 수 있는 문자 제거 (한글, 공백 등은 날아갈 수 있음)
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

// 버퍼 PNG로 변환 → 리사이즈(512x512) → 다시 버퍼
async function toPng512(buffer) {
  const resizedBuffer = await sharp(buffer)
    .resize(512, 512, { fit: "cover" })
    .png()
    .toBuffer();
  return resizedBuffer;
}

// 원본 이미지를 PNG로 정규화
async function toPng(buffer) {
  const pngBuf = await sharp(buffer).png().toBuffer();
  return pngBuf;
}

//
// ─────────────────────────────
// Dropbox 관련
// ─────────────────────────────
//

// 1) Dropbox에 파일 업로드
// pathInDropbox 예: "/booth_uploads/guest_071728.png"
async function uploadToDropbox(pathInDropbox, fileBytes) {
  console.log("DEBUG dropbox token preview:", (DROPBOX_TOKEN || "").slice(0, 20));
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

  const text = await resp.text();

  if (!resp.ok) {
    console.error("Dropbox upload fail (raw):", text);
    throw new Error("dropbox upload failed: " + text);
  }

  const data = JSON.parse(text);
  console.log("✅ Dropbox upload success:", data.path_lower);
  return data;
}

// 2) Dropbox 공유 링크 만들기 (공개 URL 만들기)
// → create_shared_link_with_settings 로 시도
//    만약 이미 존재하면 list_shared_links 로 가져와서 그걸 쓰는 식으로 fallback
//
// 최종적으로 direct download URL (dl=1 형태)로 바꿔서 리턴
//
async function getDropboxPublicUrl(pathInDropbox) {
  // 먼저 시도: 새 공유 링크 생성
  let resp = await fetch(
    "https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings",
    {
      method: "POST",
      headers: {
        Authorization: DROPBOX_TOKEN,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        path: pathInDropbox,
        settings: { requested_visibility: "public" }
      })
    }
  );

  let data = await resp.json();

  if (!resp.ok) {
    // 이미 링크가 있는 경우 등은 409로 떨어질 수 있음
    // 그때는 list_shared_links로 가져와야 함
    if (
      data &&
      data.error &&
      data.error[".tag"] === "shared_link_already_exists"
    ) {
      // fallback
      const resp2 = await fetch(
        "https://api.dropboxapi.com/2/sharing/list_shared_links",
        {
          method: "POST",
          headers: {
            Authorization: DROPBOX_TOKEN,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            path: pathInDropbox,
            direct_only: true
          })
        }
      );

      const data2 = await resp2.json();
      if (!resp2.ok) {
        console.error("Dropbox list_shared_links fail:", data2);
        throw new Error("dropbox share link failed (list_shared_links)");
      }

      if (!data2.links || data2.links.length === 0) {
        console.error("Dropbox list_shared_links: no links");
        throw new Error("no shared link available");
      }

      data = { url: data2.links[0].url };
    } else {
      console.error("Dropbox share link fail:", data);
      throw new Error("dropbox share link failed");
    }
  }

  // data.url 예: "https://www.dropbox.com/s/abc123/filename.png?dl=0"
  let publicUrl = data.url;
  // direct 다운로드 가능하게 만들기
  // dl=0 -> dl=1 으로 바꿔주자
  if (publicUrl.includes("dl=0")) {
    publicUrl = publicUrl.replace("dl=0", "dl=1");
  } else if (!publicUrl.includes("dl=")) {
    // 혹시 dl 파라미터가 아예 없으면 그냥 dl=1 붙여
    if (publicUrl.includes("?")) {
      publicUrl = publicUrl + "&dl=1";
    } else {
      publicUrl = publicUrl + "?dl=1";
    }
  }

  console.log("DEBUG dropbox public url:", publicUrl);
  return publicUrl;
}

//
// ─────────────────────────────
// OpenAI 호출 (이미지 스타일 변환)
// ─────────────────────────────
//
// resizedBuffer: 512x512 PNG buffer (사용자 얼굴/옷/포즈가 들어간 이미지)
// baseName: "guest_071728" 이런 식 (파일명 기반)
// 1) 이 이미지를 Dropbox /booth_temp/ 에 업로드
// 2) 그 Dropbox 경로에 대한 public URL 얻음
// 3) style_ref_all.png 도 Dropbox /style/style_ref_all.png 에 있다고 가정하고 public URL 얻음
// 4) public URL 방식으로 OpenAI에 넘김 (image_url)
// 5) 결과(base64 PNG) 받아서 Buffer로 변환해서 리턴
//
async function stylizeWithGPT(resizedBuffer, baseName) {
  // 1. 리사이즈된 방문자 이미지를 Dropbox 임시 경로에 올린다
  const tempResizedPath = `/booth_temp/${baseName}_512.png`;
  await uploadToDropbox(tempResizedPath, resizedBuffer);

  // 2. Dropbox에서 public URL 얻기
  const userImgUrl = await getDropboxPublicUrl(tempResizedPath);

  // 스타일 참조 이미지도 Dropbox에 /style/style_ref_all.png 로 이미 올려놨다고 가정
  // (이건 네가 전시 전에 한 번 수동 업로드 해야 함)
  const styleImgUrl = await getDropboxPublicUrl(STYLE_DBX_PATH);

  console.log("DEBUG calling OpenAI with:");
  console.log("DEBUG OPENAI KEY preview:", (OPENAI_KEY || "").slice(0, 12));
  console.log("DEBUG userImgUrl:", userImgUrl);
  console.log("DEBUG styleImgUrl:", styleImgUrl);

  // OpenAI 요청 바디
  // 지금 모델은 /v1/responses 에서
  //   input: [{ role:"user", content:[ {type:"input_image", image_url:...}, ... ] }]
  // 구조를 받는다.
  // text는 type:"input_text"
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
              "Output as PNG."
          },
          {
            type: "input_image",
            image_url: userImgUrl
          },
          {
            type: "input_image",
            image_url: styleImgUrl
          }
        ]
      }
    ]
  };

  // 실제 호출
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

  // 이제 result 안에서 base64 PNG 찾아야 함
  // 가능한 구조들 시도:
  //   result.output[0].content[*].type === "output_image"
  //   chunk.image.b64_json (base64)
  //
  let base64Image = null;

  if (result.output && result.output[0] && Array.isArray(result.output[0].content)) {
    for (const chunk of result.output[0].content) {
      // 예상 구조 1:
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

      // 혹시 다른 경우: image 자체가 base64 string
      if (
        chunk.type === "output_image" &&
        typeof chunk.image === "string" &&
        chunk.image.startsWith("iVBOR") // PNG 헤더
      ) {
        base64Image = chunk.image;
        break;
      }
    }
  }

  // 구형-style fallback
  if (!base64Image && result.data && result.data[0] && result.data[0].b64_json) {
    base64Image = result.data[0].b64_json;
  }

  if (!base64Image) {
    console.warn("⚠️ GPT did not return an image. Full result:", JSON.stringify(result, null, 2));
    throw new Error("no_image_in_gpt_response");
  }

  const outBytes = Buffer.from(base64Image, "base64");
  return outBytes;
}

//
// ─────────────────────────────
// /upload 라우트
// ─────────────────────────────
//
// 프론트(FormData)에서
//   nickname: "사용자입력닉네임"
//   photo: (File)
// 전송한다고 가정
//
app.post("/upload", upload.single("photo"), async (req, res) => {
  try {
    // 1. 닉네임 처리
    const rawNickname = req.body.nickname || "";
    const cleanName = sanitizeName(rawNickname); // 한글이면 날아가고 guest로 될 수 있음

    // 2. 타임스탬프
    const stamp = makeKRTimestamp();

    // 3. 베이스 파일명
    const baseName = `${cleanName}_${stamp}`;

    // 4. 업로드된 파일 여부 확인
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ ok: false, message: "no file uploaded" });
    }

    const originalBuffer = req.file.buffer;

    // 5. 원본을 PNG로 정규화해서 Dropbox /booth_uploads 에 저장
    const normalizedPngBuffer = await toPng(originalBuffer);
    const originalDropboxPath = `/booth_uploads/${baseName}.png`;
    await uploadToDropbox(originalDropboxPath, normalizedPngBuffer);

    // 6. 512x512 PNG로 리사이즈한 버전 만들기
    const resizedBuffer = await toPng512(originalBuffer);

    // 7. GPT 스타일 변환 시도
    let stylizedBuffer;
    try {
      stylizedBuffer = await stylizeWithGPT(resizedBuffer, baseName);
    } catch (err) {
      console.error("❌ stylizeWithGPT failed:", err);
      return res.status(500).json({
        ok: false,
        message: "style transform failed",
        details: String(err.message || err)
      });
    }

    // 8. 변환된 이미지를 Dropbox /booth_outputs 에 저장
    const stylizedDropboxPath = `/booth_outputs/${baseName}_stylized.png`;
    await uploadToDropbox(stylizedDropboxPath, stylizedBuffer);

    // 9. 성공 응답
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
