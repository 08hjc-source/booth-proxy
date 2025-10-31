// server.js

import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ──────────────────────────────
// 0. 기본 세팅
// ──────────────────────────────
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
// ──────────────────────────────
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

// 안전 체크 (로그로 찍지는 말고 그냥 없으면 크래시 시켜서 눈에 띄게)
if (!DROPBOX_TOKEN) {
  console.error("ERROR: DROPBOX_TOKEN env var is missing");
}
if (!OPENAI_KEY) {
  console.error("ERROR: OPENAI_KEY env var is missing");
}

// ──────────────────────────────
// 2. 유틸: 한글 닉네임 → Dropbox 안전 파일명
// Dropbox API 헤더에서 한글이 깨지는 문제 있었으니까
// ASCII로만 구성된 안전한 이름을 만든다.
//
// 예) "찬" → ""(빈) 이 될 수 있으니까 fallback으로 user 사용
// 공백은 _ 로 바꿔서 넣는다.
// ──────────────────────────────
function toAsciiSafeName(nameRaw) {
  const asciiOnly = (nameRaw || "")
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")     // ASCII 아닌 글자(한글 등) 제거
    .replace(/[\/\\:\*\?"<>\|]/g, "") // 파일 경로 터뜨리는 문자 제거
    .replace(/\s+/g, "_")
    .trim();
  return asciiOnly || "user";
}

// ──────────────────────────────
// 3. 유틸: 한국 시간 HHMMSS 태그
// 파일명 뒤에 붙여서 유니크하게 만들려고 씀
// ──────────────────────────────
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
// 4. 유틸: Buffer → data:image/png;base64,... 형태 문자열
// GPT 멀티모달 API에 이미지를 넣기 위해 사용
// ──────────────────────────────
function bufferToDataUrlPNG(buf) {
  const b64 = buf.toString("base64");
  return `data:image/png;base64,${b64}`;
}

// ──────────────────────────────
// 5. Dropbox 업로드 함수
// pathInDropbox: "/booth_uploads/파일명.png" 이런 식
// fileBytes: Buffer
// ──────────────────────────────
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
    }),
    body: fileBytes,
  });

  const data = await resp.json();
  if (!resp.ok) {
    console.error("Dropbox upload fail:", data);
    throw new Error("dropbox upload failed");
  }
  return data;
}

// ──────────────────────────────
// 6. GPT 스타일 변환 함수
// 핵심: 유저 사진 + 스타일 레퍼런스 4장 → OpenAI 멀티모달 모델 호출
//      모델: "gpt-4o-mini" 같이 이미지 이해+생성 지원하는 모델
//      결과: base64 PNG 받아서 Buffer로 리턴
// ──────────────────────────────
async function stylizeWithGPT(userPhotoBytes) {
  // (1) 유저 사진을 data URL로 변환
  const userPhotoDataUrl = bufferToDataUrlPNG(userPhotoBytes);

  // (2) 스타일 레퍼런스 이미지 4장 읽어서 data URL 배열로 만들기
  // style_ref_1.png ~ style_ref_4.png 는 반드시 이 server.js랑 같은 폴더(= __dirname)에 넣어서
  // GitHub에 커밋해줘야 Render에서도 같이 배포된다.
  const stylePaths = [
    path.join(__dirname, "style_ref_1.png"),
    path.join(__dirname, "style_ref_2.png"),
    path.join(__dirname, "style_ref_3.png"),
    path.join(__dirname, "style_ref_4.png"),
  ];

  const styleDataUrls = stylePaths.map((p) => {
    const imgBuf = fs.readFileSync(p); // 만약 여기서 파일 없으면 throw 나서 catch로 감
    return bufferToDataUrlPNG(imgBuf);
  });

  // (3) GPT 요청 바디 만들기
  //
  // 구조 설명:
  // - input[0].content = 여러 chunk
  //   - 첫 번째 chunk: 방문객 사진 (이 얼굴/머리/옷/포즈 유지)
  //   - 다음 4개 chunk: 공식 스타일 시트(너 IP 캐릭터 그림들)
  //   - 마지막 chunk: 텍스트 지시문
  //
  // "우리가 원하는 건 '이 사람을 이 스타일들처럼 그려' 라는 것"
  //
  // size: "1024x1024" → 출력 이미지 크기
  // modalities: ["image"] → 우리는 이미지 결과를 원한다
  //
  const gptRequestBody = {
    model: "gpt-4o-mini", // 이미지 이해/생성 가능한 멀티모달 모델이어야 함
    input: [
      {
        role: "user",
        content: [
          // 0. 사람 원본 사진
          {
            type: "input_image",
            image_url: userPhotoDataUrl,
          },

          // 1~4. 스타일 레퍼런스 이미지
          ...styleDataUrls.map((dataUrl) => ({
            type: "input_image",
            image_url: dataUrl,
          })),

          // 5. 텍스트 지시
          {
            type: "text",
            text: [
              "Redraw the FIRST image (the real person) as a clean character illustration.",
              "Copy the exact visual style from the reference style sheets I provided:",
              "same line thickness, outline style, flat color fills, simple cel shading, head/body proportion, and facial style.",
              "Keep the person's identity, hairstyle, clothing colors, and pose from the first image so they're recognizable.",
              "Output must be a polished character illustration on plain white background. No text, no watermark."
            ].join(" ")
          }
        ]
      }
    ],
    modalities: ["image"],
    size: "1024x1024"
  };

  // (4) OpenAI 호출
  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json"
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
  // 참고: /v1/responses 멀티모달 이미지 생성 응답 형식은
  // 모델 버전에 따라 약간 다를 수 있다.
  //
  // 여기서는 두 가지 케이스를 대비해본다.
  //  A. result.output[0].content[0].image 가 base64라고 가정
  //  B. result.data[0].b64_json 형태라고 가정
  //
  let base64Image = null;

  // 시나리오 A
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
    /* ignore */
  }

  // 시나리오 B
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

  // base64 → Buffer
  const outBytes = Buffer.from(base64Image, "base64");
  return outBytes;
}

// ──────────────────────────────
// 7. /upload 라우트
//
// 프레이머 페이지에서 FormData로
//   name: 닉네임 (한글 가능)
//   photo: 캡쳐된 이미지(blob)
// 를 보내면 여기서 다 처리함.
//
// 흐름:
// 1) 사진 받기
// 2) Dropbox에 원본 저장 (/booth_uploads/...)
// 3) GPT 스타일 변환 돌리기 (유저사진 + 스타일레퍼런스4장)
// 4) 변환 결과 Dropbox에 저장 (/booth_outputs/...)
// 5) 프론트로 JSON 응답
// ──────────────────────────────
app.post("/upload", upload.single("photo"), async (req, res) => {
  try {
    // (1) 업로드 파일 검사
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({
        ok: false,
        message: "no file buffer",
      });
    }

    const fileBuffer = req.file.buffer;

    // (2) 닉네임
    const rawName =
      req.body && typeof req.body.name === "string" ? req.body.name : "";

    // (3) Dropbox 안전 파일명 조합
    const safeName = toAsciiSafeName(rawName); // ASCII-only
    const timeTag = getKSTTimeTag();           // HHMMSS

    // 예: user_145210.png
    const origFileName = `${safeName}_${timeTag}.png`;
    const origPath = `/booth_uploads/${origFileName}`;

    // (4) 원본 Dropbox 업로드
    await uploadToDropbox(origPath, fileBuffer);

    // (5) GPT 스타일 변환 실행
    const stylizedBytes = await stylizeWithGPT(fileBuffer);

    // (6) 변환본 Dropbox 업로드
    const outFileName = `${safeName}_${timeTag}_stylized.png`;
    const outPath = `/booth_outputs/${outFileName}`;
    await uploadToDropbox(outPath, stylizedBytes);

    // (7) 프론트로 OK 응답
    return res.json({
      ok: true,
      user: rawName,            // 한글 그대로 돌려줌 (화면용)
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
// 8. 서버 실행
// Render는 기본적으로 process.env.PORT 제공하니까 그거 쓰고,
// 없으면 3000으로.
// ──────────────────────────────
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Server running on port " + port);
});
