// server.js

import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ──────────────────────────────
// 0. 기본 세팅
// ─────────────────────────────-
const app = express();
const upload = multer();

// 현재 파일의 경로 계산 (__dirname 대용)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// CORS 허용 (프레이머에서 바로 호출 가능하게)
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Preflight 처리
app.options("/upload", (req, res) => {
  res.sendStatus(200);
});

// ──────────────────────────────
// 1. 환경변수 (Render에서 세팅해라)
// ─────────────────────────────-
//
// Render의 Environment 탭에서 추가해야 하는 값들:
//
// DROPBOX_TOKEN = Bearer 네드롭박스토큰전체
// OPENAI_KEY    = sk- 로 시작하는 OpenAI API 키
//
// 주의: 여기 코드 안에 하드코딩하지 말 것.
//
const DROPBOX_TOKEN = process.env.DROPBOX_TOKEN;
const OPENAI_KEY = process.env.OPENAI_KEY;

// 안전 체크 (없으면 서버가 떠도 호출 시 바로 에러 나게)
if (!DROPBOX_TOKEN) {
  console.error("ERROR: DROPBOX_TOKEN env var is missing");
}
if (!OPENAI_KEY) {
  console.error("ERROR: OPENAI_KEY env var is missing");
}

// ──────────────────────────────
// 2. 유틸: 한글 닉네임 → Dropbox 안전 파일명
// Dropbox 쪽에서 고유문자 깨지는 이슈 있으니까 ASCII만 남긴다.
// ─────────────────────────────-
function toAsciiSafeName(nameRaw) {
  const asciiOnly = (nameRaw || "")
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "") // ASCII 아닌 글자 제거(한글 등)
    .replace(/[\/\\:\*\?"<>\|]/g, "") // 경로 깨뜨리는 문자 제거
    .replace(/\s+/g, "_")
    .trim();
  return asciiOnly || "user";
}

// ──────────────────────────────
// 3. 유틸: 한국 시간 HHMMSS 태그
// ─────────────────────────────-
function getKSTTimeTag() {
  const now = new Date();
  // KST = UTC+9
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const hh = String(kst.getUTCHours()).padStart(2, "0");
  const mm = String(kst.getUTCMinutes()).padStart(2, "0");
  const ss = String(kst.getUTCSeconds()).padStart(2, "0");
  return `${hh}${mm}${ss}`;
}

// ──────────────────────────────
// 4. 유틸: Buffer → data:image/png;base64,... 문자열
// GPT 멀티모달 API에 이미지를 넣기 위해 사용
// ─────────────────────────────-
function bufferToDataUrlPNG(buf) {
  const b64 = buf.toString("base64");
  return `data:image/png;base64,${b64}`;
}

// ──────────────────────────────
// 5. Dropbox 업로드 함수
// pathInDropbox 예: "/booth_uploads/xxx.png"
// fileBytes: Buffer
// ─────────────────────────────-
async function uploadToDropbox(pathInDropbox, fileBytes) {
  const resp = await fetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      Authorization: DROPBOX_TOKEN,
      "Dropbox-API-Arg": JSON.stringify({
        path: pathInDropbox,
        mode: "add",
        autorename: true,
        mute: false,
      }),
      "Content-Type": "application/octet-stream",
    },
    body: fileBytes,
  });

  // 성공 케이스 먼저
  if (resp.ok) {
    // 드롭박스 정상 응답은 JSON이라 이때만 json() 파싱해
    const data = await resp.json();
    return data;
  }

  // 실패 케이스 (권한 문제 등)
  const errText = await resp.text();
  console.error("Dropbox upload fail (raw):", errText);
  throw new Error("dropbox upload failed: " + errText);
}


// ──────────────────────────────
// 6. GPT 스타일 변환 함수
// 핵심 로직:
//   - 유저 사진 1장(userPhotoBytes)
//   - 스타일 레퍼런스 4장(style_ref_1~4.png)
//   → 전부 GPT 멀티모달 모델에 넣고
//   "이 사람을 이 스타일로 그려"라고 요청
//   → base64 PNG 결과를 Buffer로 받아 리턴
// ─────────────────────────────-
async function stylizeWithGPT(userPhotoBytes) {
  // (1) 유저 사진을 data URL로 변환
  const userPhotoDataUrl = bufferToDataUrlPNG(userPhotoBytes);

  // (2) 스타일 레퍼런스 이미지 4장 읽기 + data URL 변환
  //    style_ref_1.png ~ style_ref_4.png 는 server.js와 같은 폴더에 있어야 함
  const stylePaths = [
    path.join(__dirname, "style_ref_1.png"),
    path.join(__dirname, "style_ref_2.png"),
    path.join(__dirname, "style_ref_3.png"),
    path.join(__dirname, "style_ref_4.png"),
  ];

  const styleDataUrls = stylePaths.map((p) => {
    const imgBuf = fs.readFileSync(p); // 없으면 throw
    return bufferToDataUrlPNG(imgBuf); // "data:image/png;base64,...."
  });

  // (3) GPT 요청 바디
  // 여기서 핵심:
  // - 'modalities' 같은 필드 제거
  // - 'size'도 일단 제거
  //
  // 구조는:
  //   model: ...
  //   input: [
  //     { role: "user", content: [ {type:"input_image"...}, ... , {type:"text", text:"..."} ] }
  //   ]
  //
  // GPT에게 "이 사람을 이 스타일처럼 그려"라고 직접 지시.
  const gptRequestBody = {
    model: "gpt-4o-mini", // 멀티모달 모델 (이미지 이해 가능 모델이어야 함)
    input: [
      {
        role: "user",
        content: [
          // 0. 방문객 실제 사진
          {
            type: "input_image",
            image_url: userPhotoDataUrl,
          },

          // 1~4. 스타일 레퍼런스
          ...styleDataUrls.map((dataUrl) => ({
            type: "input_image",
            image_url: dataUrl,
          })),

          // 5. 변환 지시 텍스트
          {
            type: "text",
            text: [
              "Redraw the FIRST image (the real person photo) as a polished character illustration.",
              "Copy the visual style from the style reference images I provided:",
              "same outline thickness, flat fills, simple cel shading with one shadow tone, same head/body proportion, same facial style.",
              "Keep the person's identity, hairstyle, clothing colors, and pose recognizable from the first photo.",
              "Return ONLY the final character illustration on a plain white background, no text, no watermark.",
              "Output as a clean PNG, square framing."
            ].join(" ")
          }
        ]
      }
    ]
  };

  // (4) OpenAI 호출
  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(gptRequestBody),
  });

  const result = await resp.json();

  if (!resp.ok) {
    console.error("GPT style remix fail:", result);
    throw new Error("gpt style remix failed");
  }

  // (5) 응답에서 base64 PNG 꺼내기
  //
  // 모델마다 응답 구조가 다를 수 있으니까, 2가지 케이스 다 시도:
  //  A. result.output[0].content[0].image
  //  B. result.data[0].b64_json
  //
  let base64Image = null;

  try {
    if (
      result.output &&
      result.output[0] &&
      result.output[0].content &&
      result.output[0].content[0] &&
      result.output[0].content[0].image
    ) {
      base64Image = result.output[0].content[0].image;
    }
  } catch (e) {
    // 무시하고 B로 간다
  }

  if (!base64Image) {
    if (
      result.data &&
      result.data[0] &&
      result.data[0].b64_json
    ) {
      base64Image = result.data[0].b64_json;
    }
  }

  if (!base64Image) {
    console.error("Unexpected GPT response shape:", result);
    throw new Error("no image in gpt response");
  }

  const outBytes = Buffer.from(base64Image, "base64");
  return outBytes;
}

// ──────────────────────────────
// 7. /upload 라우트
// 프레이머에서 FormData로
//   name: 닉네임 (한글 OK)
//   photo: 캡처된 이미지(blob)
// 를 보내면,
// 1) 원본 Dropbox 저장 (/booth_uploads/...)
// 2) GPT 스타일 변환해서 결과 Dropbox 저장 (/booth_outputs/...)
// 3) JSON으로 경로 돌려줌
// ─────────────────────────────-
app.post("/upload", upload.single("photo"), async (req, res) => {
  try {
    // 1) 사진 있는지 확인
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({
        ok: false,
        message: "no file buffer",
      });
    }
    const fileBuffer = req.file.buffer;

    // 2) 닉네임(한글 그대로 화면용), 파일명용 ASCII 버전
    const rawName =
      req.body && typeof req.body.name === "string" ? req.body.name : "";
    const safeName = toAsciiSafeName(rawName);

    // 3) 고유 태그 (KST 시각)
    const timeTag = getKSTTimeTag();

    // 예: /booth_uploads/user_145210.png
    const origFileName = `${safeName}_${timeTag}.png`;
    const origPath = `/booth_uploads/${origFileName}`;

    // 4) 원본 Dropbox 업로드
    await uploadToDropbox(origPath, fileBuffer);

    // 5) GPT 스타일 변환 실행
    const stylizedBytes = await stylizeWithGPT(fileBuffer);

    // 6) 결과 Dropbox 업로드
    const outFileName = `${safeName}_${timeTag}_stylized.png`;
    const outPath = `/booth_outputs/${outFileName}`;
    await uploadToDropbox(outPath, stylizedBytes);

    // 7) 프론트로 응답
    return res.json({
      ok: true,
      user: rawName,            // 한글 닉네임 그대로 돌려줌
      original_path: origPath,  // 원본 저장 위치
      stylized_path: outPath,   // 변환본 저장 위치
      status: "done",
    });
  } catch (err) {
    console.error("서버 내부 오류:", err);
    return res.status(500).json({
      ok: false,
      message: "server crashed in upload flow",
      error: String(err && err.message ? err.message : err),
    });
  }
});

// ──────────────────────────────
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Server running on port " + port);
});


