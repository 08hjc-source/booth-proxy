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

// Render 환경변수
let DROPBOX_TOKEN = process.env.DROPBOX_TOKEN || "";
let OPENAI_KEY = process.env.OPENAI_KEY || "";

// 혹시 "Bearer xxx" 없이 토큰만 들어온 경우를 대비해 헤더용으로 정규화
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

// 전시 스타일 참조 이미지(사전에 Dropbox에 올려둔 것)의 경로
// 예: "/style/style_ref_all.png"
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
// Dropbox 관련
// ─────────────────────────────
//
// Dropbox API 주의점
// - upload 응답에 path_lower가 온다. Dropbox가 실제 인지하는 canonical 경로다.
// - 이후 공유 링크 생성 시 반드시 이 canonical 경로를 사용해야 한다.
// - App Folder 권한일 경우 path_lower는 앱 루트 기준 경로이므로 반드시 그대로 써야 함.
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

  // 성공 시 Dropbox가 인식하는 실제 경로(path_lower)를 쓴다.
  console.log("✅ Dropbox upload success:", data.path_lower);
  return data;
}

/**
 * Dropbox 공유 URL 획득
 * 1) create_shared_link_with_settings 시도
 * 2) 이미 있으면 list_shared_links
 * 3) 그래도 안 되면 files/get_temporary_link fallback
 *
 * @param {string} canonicalPath Dropbox 상의 실제 경로 (upload 응답의 path_lower 그대로 쓸 것)
 * @returns {Promise<string>} 공개 접근 가능한 URL (이미지 직접 접근 가능한 형태)
 */
async function getDropboxPublicUrl(canonicalPath) {
  // 1차 시도: create_shared_link_with_settings
  let resp = await fetch(
    "https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings",
    {
      method: "POST",
      headers: {
        Authorization: dbxAuthHeader(),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        path: canonicalPath,
        settings: { requested_visibility: "public" }
      })
    }
  );

  let data = await resp.json();

  if (!resp.ok) {
    // 공유 링크가 이미 있었을 가능성 등
    const alreadyExists =
      data &&
      data.error &&
      (data.error[".tag"] === "shared_link_already_exists" ||
        data.error[".tag"] === "conflict"); // 일반적으로 409류

    if (alreadyExists) {
      // 2차 시도: list_shared_links
      const resp2 = await fetch(
        "https://api.dropboxapi.com/2/sharing/list_shared_links",
        {
          method: "POST",
          headers: {
            Authorization: dbxAuthHeader(),
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            path: canonicalPath,
            direct_only: true
          })
        }
      );

      const data2 = await resp2.json();
      if (resp2.ok && data2.links && data2.links.length > 0) {
        data = { url: data2.links[0].url };
      } else {
        console.warn("Dropbox list_shared_links fallback failed:", data2);

        // 3차 시도: files/get_temporary_link
        const resp3 = await fetch(
          "https://api.dropboxapi.com/2/files/get_temporary_link",
          {
            method: "POST",
            headers: {
              Authorization: dbxAuthHeader(),
              "Content-Type": "application/json"
            },
            body: JSON.stringify({ path: canonicalPath })
          }
        );
        const data3 = await resp3.json();
        if (!resp3.ok || !data3.link) {
          console.error("Dropbox temp link fail:", data3);
          throw new Error("dropbox share link failed (no link)");
        }
        console.log("DEBUG dropbox temp link (fallback):", data3.link);
        return data3.link; // 이미 직접 접근 가능한 https URL
      }
    } else {
      // not_found 등 근본적으로 경로를 못 찾은 경우
      console.error("Dropbox share link fail:", data);
      // 마지막으로 get_temporary_link를 시도해 본다.
      const resp3 = await fetch(
        "https://api.dropboxapi.com/2/files/get_temporary_link",
        {
          method: "POST",
          headers: {
            Authorization: dbxAuthHeader(),
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ path: canonicalPath })
        }
      );
      const data3 = await resp3.json();
      if (!resp3.ok || !data3.link) {
        console.error("Dropbox temp link fail:", data3);
        throw new Error("dropbox share link failed");
      }
      console.log("DEBUG dropbox temp link (fallback):", data3.link);
      return data3.link;
    }
  }

  // 여기까지 왔으면 data.url은 예: "https://www.dropbox.com/s/abc123/file.png?dl=0"
  let publicUrl = data.url;
  if (publicUrl.includes("dl=0")) {
    publicUrl = publicUrl.replace("dl=0", "dl=1");
  } else if (!publicUrl.includes("dl=")) {
    publicUrl += (publicUrl.includes("?") ? "&" : "?") + "dl=1";
  }

  console.log("DEBUG dropbox public url:", publicUrl);
  return publicUrl;
}

//
// ─────────────────────────────
// OpenAI 호출 (이미지 스타일 변환)
// ─────────────────────────────
//
// 1) 방문자 이미지(512x512 PNG)를 Dropbox /booth_temp/... 로 업로드
//    → canonical path 확보
// 2) 그 canonical path로부터 public URL 확보
// 3) style_ref_all.png 도 동일하게 public URL 확보
// 4) /v1/responses 에 userImgUrl / styleImgUrl를 image_url로 전달
//    (모델이 이미지→이미지 변환을 지원한다고 가정한 요청 포맷)
// 5) 반환된 base64 PNG를 Buffer로 변환
//
async function stylizeWithGPT(resizedBuffer, baseName) {
  //
  // 1. 방문자 리사이즈 이미지 Dropbox 업로드
  //
  const tempResizedDesiredPath = `/booth_temp/${baseName}_512.png`;
  const uploadedUser = await uploadToDropbox(
    tempResizedDesiredPath,
    resizedBuffer
  );
  const userCanonicalPath = uploadedUser.path_lower; // canonical

  //
  // 2. Dropbox에서 해당 업로드 파일의 접근 URL 확보
  //
  const userImgUrl = await getDropboxPublicUrl(userCanonicalPath);

  //
  // 3. 스타일 참조 이미지 URL 확보
  //    스타일 참조 이미지는 이미 Dropbox에 있다고 가정하므로
  //    getDropboxPublicUrl(STYLE_DBX_PATH)를 직접 호출 → canonicalPath로 가정
  //
  const styleImgUrl = await getDropboxPublicUrl(STYLE_DBX_PATH);

  console.log("DEBUG calling OpenAI with:");
  console.log("DEBUG OPENAI KEY preview:", (OPENAI_KEY || "").slice(0, 12));
  console.log("DEBUG userImgUrl:", userImgUrl);
  console.log("DEBUG styleImgUrl:", styleImgUrl);

  //
  // 4. OpenAI 요청 본문
  // model: gpt-4o-mini-2024-07-18 (멀티모달 응답형식 가정)
  // image_url을 참조 이미지로 넘기고,
  // "이 사람을 이 스타일로 리드로잉해서 PNG로 줘"라고 지시
  //
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

  //
  // 5. OpenAI 응답에서 base64 PNG 추출
  //    예상 포맷:
  //    result.output[0].content[*] 중
  //    { type:"output_image", image:{ b64_json:"..." } }
  //
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

      // fallback: chunk.image 가 바로 base64일 수도 있음
      if (
        chunk.type === "output_image" &&
        typeof chunk.image === "string"
      ) {
        base64Image = chunk.image;
        break;
      }
    }
  }

  // 구형-style fallback (호환성)
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

  const outBytes = Buffer.from(base64Image, "base64");
  return outBytes;
}

//
// ─────────────────────────────
// /upload 라우트
// 프론트(FormData)에서 nickname, photo(File) 전송한다고 가정
// ─────────────────────────────
//
app.post("/upload", upload.single("photo"), async (req, res) => {
  try {
    //
    // 1. 닉네임 처리
    //
    const rawNickname = req.body.nickname || "";
    const cleanName = sanitizeName(rawNickname); // 한글 등은 제거되어 guest로 갈 수도 있음

    //
    // 2. 타임스탬프
    //
    const stamp = makeKRTimestamp();

    //
    // 3. 파일명(기본)
    //
    const baseName = `${cleanName}_${stamp}`;

    //
    // 4. 업로드된 파일 여부
    //
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({
        ok: false,
        message: "no file uploaded"
      });
    }

    const originalBuffer = req.file.buffer;

    //
    // 5. 원본을 PNG로 정규화 → Dropbox /booth_uploads 에 저장
    //
    const normalizedPngBuffer = await toPng(originalBuffer);
    const originalDesiredPath = `/booth_uploads/${baseName}.png`;
    const uploadedOriginal = await uploadToDropbox(
      originalDesiredPath,
      normalizedPngBuffer
    );
    const originalCanonicalPath = uploadedOriginal.path_lower;

    //
    // 6. 512x512 PNG 버전 생성
    //
    const resizedBuffer = await toPng512(originalBuffer);

    //
    // 7. GPT 스타일 변환
    //
    let stylizedBuffer;
    try {
      stylizedBuffer = await stylizeWithGPT(resizedBuffer, baseName);
    } catch (err) {
      console.error("❌ stylizeWithGPT failed:", err);
      return res.status(500).json({
        ok: false,
        step: "stylize",
        message: "style transform failed",
        details: String(err.message || err)
      });
    }

    //
    // 8. 변환된 이미지를 Dropbox /booth_outputs 에 저장
    //
    const stylizedDesiredPath = `/booth_outputs/${baseName}_stylized.png`;
    const uploadedStylized = await uploadToDropbox(
      stylizedDesiredPath,
      stylizedBuffer
    );
    const stylizedCanonicalPath = uploadedStylized.path_lower;

    //
    // 9. 성공 응답
    //
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
