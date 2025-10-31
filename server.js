import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";

const app = express();

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.options("/upload", (req, res) => {
  res.sendStatus(200);
});

const upload = multer();

// ⬇⬇⬇ 여기 너 토큰 넣어
const DROPBOX_TOKEN = "Bearer sl.u.AGETpn391W2nwklxtA8oo41Gnatvu3sPidlLCA1zA9sey13ED_RlgxygVckdBIbQbl1veL0YxaGh-3Pk66U1uFCuwm-LHVqw_ERrvjVHNCHXE3LUeYKwLDzFxaPSubFVJZD3DafBresjaqFF87w5_3CwlOioun-DOqLdfnDTPzDlnH_FBt0Gnq3Z2vIWU1opWwXtKT9WPO2ihkqpotRR8TIBN6-2GEm3aFKnxOuviJx8M2yAKD_HTZghI2PylOq6MEfAG-aRV52SBsIH5a6ge7epqR_5w_ReJL_FSrkAFQv9vrwn4pO_jD3LIbSN3JCbPn1nUOSBjnhRvn4GJ7846e291h2f2C-ibdPer23H0CUNXdBJyP4qoGI5uSo-sdZmXb8fvsY9kFgAQEpL-Bx65EqGnZOrD-DUoPga3ulTHY4V-K7O97Gy1M0yCffy-PUNEqN0FVEwrfX1pXUm2ycekmwSdxpfjSXTZmel0CrcawFVQWAo8TYtZ0BtxNarnxOrwoEkIxqabjM8ge3J8kigZSuxyb3hSBAL35_BOQTbpPyr8p9qiSj4iWKkrxTk8M0joNozcMPm_9qOhIWktoHNplFeP3bYIAd7YOVbEsHDllwRMHVCnwXwXTN6gLLFK11G0ujTgHX4NsS4RQZQ-UM3X0WE35KSnJ0wRgfpHsl7LyAMol1V_wXDF0Otebe-BkKwJMNdzbUZrCzkh3aBGKiqoTWvCRtodYEtgOF5ymJW5BYyxfc5luvMvKkf5z2xaZ7V3keX6XRYtNmi9zcllk-WHmCioS1N-K3xtQlMhJMkyk__WY_BXGDkt4rWMKARLFqNjrTb7AATZ5clpUrwlaKwP7TTa1rlFpZ3MsphUiPRnHMfA5rwDYVM1I6nps3AFTwvoFbq_nxKxg1rwK7HCRXSA9EcV6rMwQIx6oXGEjQHaaH38tz4rWaSHW7o3QGL-lS3M7QQZAF_PhcborCZ0ItWz5S9x6mRX6oJnmFuVTZhjK5WVcitsE2C6EFYxH3wIIwGVZf1t2xUmAXOmObHygd5LIdEDzqPHddjbhwApJHfl-eNcEfqY06bVz9wnKH57tLlIeWtwW-5gz0hO-zA31F0KF0oUh3s_kzq0nlLKee8QDfPIKn-hgrVYiIEwT9LjMXCLokdI2A-Rh-L34lA9r3XhiN9Dn0Mi8A8iIKtb8RfopZbMbXqhRm3c1melFyzhFxUxU-F_gRz6hzblfOvTj5JZhl61CWza4hch3woH5n2ClLqVabUSq1A3dOg8jUtC6tuRnbTpR4yqOjlpbRM_nWCCHPVop0eMSoSrzdeddP5g1hBA4ZPnnJBUTP3f8Ctc5xcMbGpEV_6x9oPThphvnl7mlomandSqHwSJRnenhnVfBB4SfcDcSZy0HUzyDU-whRhpWoNKTlGixG5j9VOqboWo2D1";
const OPENAI_KEY = process.env.OPENAI_KEY;

// 닉네임을 ASCII로만 만들어서 Dropbox 파일명에 쓰기 (드롭박스 헤더에 한글 못들어가서)
function sanitizeAsciiFilename(userLabel) {
  const asciiOnly = (userLabel || "")
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")    // ASCII 아닌 글자 제거 (한글 등)
    .replace(/[\/\\:\*\?"<>\|]/g, "") // 위험문자 제거
    .replace(/\s+/g, "_")
    .trim();
  return asciiOnly || "user";
}

// 한국 시간 HHMMSS
function getKSTTimeTag() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const hh = String(kst.getUTCHours()).padStart(2, "0");
  const mm = String(kst.getUTCMinutes()).padStart(2, "0");
  const ss = String(kst.getUTCSeconds()).padStart(2, "0");
  return `${hh}${mm}${ss}`;
}

// Dropbox 업로드 (원본 / 결과)
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

  const data = await resp.json();
  if (!resp.ok) {
    console.error("Dropbox upload fail:", data);
    throw new Error("dropbox upload failed");
  }
  return data;
}

// 🔥 스타일 변환 함수
// userPhotoBytes: 방금 찍은 사람 사진 (Buffer)
// 스타일 참고 이미지는 style_ref_1~4.png 전부 사용
async function stylizeWithOpenAI(userPhotoBytes) {
  // 1) 스타일 레퍼런스 이미지들 읽기
  //    너는 repo 루트(= server.js랑 같은 폴더)에
  //    style_ref_1.png, style_ref_2.png, style_ref_3.png, style_ref_4.png
  //    이 네 장을 넣어두면 된다.
  const styleFiles = [
    "style_ref_1.png",
    "style_ref_2.png",
    "style_ref_3.png",
    "style_ref_4.png",
  ];

  const styleBuffers = styleFiles.map((path) => {
    try {
      return fs.readFileSync(path);
    } catch (e) {
      console.error(`스타일 이미지 ${path} 못 읽음`, e);
      return null;
    }
  }).filter(Boolean);

  if (styleBuffers.length === 0) {
    throw new Error("스타일 레퍼런스 이미지를 하나도 못 읽었어.");
  }

  // 2) multipart/form-data 만들기
  // OpenAI 이미지 편집 API에 여러 이미지를 동시에 넣고
  // prompt에서 "첫 번째는 사용자 사진(콘텐츠), 나머지 4장은 스타일 레퍼런스"라고 명시해.
  const formData = new FormData();

  // (1) 유저 실제 사진: 항상 가장 먼저 append한다.
  formData.append(
    "image[]",
    new Blob([userPhotoBytes], { type: "image/png" }),
    "subject.png"
  );

  // (2) 스타일 레퍼런스들: 그 다음에 전부 append
  styleBuffers.forEach((buf, i) => {
    formData.append(
      "image[]",
      new Blob([buf], { type: "image/png" }),
      `style_ref_${i + 1}.png`
    );
  });

  // 3) prompt: 모델에게 역할을 아주 명확하게 설명
  // 핵심:
  // - 첫 번째 이미지는 "그릴 대상"
  // - 나머지 이미지들은 "참고할 스타일"
  // - 공통 스타일을 추출해라 (4장 보고 일관된 룩으로)
  formData.append(
    "prompt",
    [
      "Use the FIRST image as the subject (the person's real face, hair, clothing, pose).",
      "Use ALL following images as style references.",
      "Redraw the subject in the unified visual style shared by the style reference images:",
      "same type of line thickness, outline color, fill style, shading style, proportions, and overall vibe.",
      "Keep the person's identity, hairstyle, outfit colors, and pose from the first image, but render them as stylized illustration.",
      "Output with a clean plain background (white or transparent), no text, no watermark."
    ].join(" ")
  );

  // 원하는 결과 해상도
  formData.append("size", "1024x1024");

  // 4) OpenAI 이미지 편집/스타일 전환 API 호출
  const resp = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
    },
    body: formData,
  });

  const result = await resp.json();

  if (!resp.ok) {
    console.error("OpenAI style remix fail:", result);
    throw new Error("openai style remix failed");
  }

  // OpenAI 응답은 base64 PNG를 준다고 문서화돼 있음.
  const b64 = result.data[0].b64_json;
  const outBytes = Buffer.from(b64, "base64");
  return outBytes;
}

app.post("/upload", upload.single("photo"), async (req, res) => {
  try {
    // 1) 들어온 데이터 확인
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({
        ok: false,
        message: "no file buffer",
      });
    }

    const fileBuffer = req.file.buffer;

    // 닉네임 (한글 그대로 안내 용)
    const rawName =
      req.body && typeof req.body.name === "string" ? req.body.name : "";

    console.log("받은 이름:", rawName);

    // 드롭박스용 파일명 베이스 (ASCII)
    const safeBase = sanitizeAsciiFilename(rawName);
    const timeTag = getKSTTimeTag();

    // 원본 저장 경로 (/booth_uploads/...)
    const origFileName = `${safeBase}_${timeTag}.png`;
    const origPath = `/booth_uploads/${origFileName}`;

    // 2) 원본 Dropbox 업로드
    await uploadToDropbox(origPath, fileBuffer);

    // 3) GPT 이미지 스타일 변환 실행
    const stylizedBytes = await stylizeWithOpenAI(fileBuffer);

    // 4) 결과 Dropbox 업로드 (/booth_outputs/...)
    const outFileName = `${safeBase}_${timeTag}_stylized.png`;
    const outPath = `/booth_outputs/${outFileName}`;
    await uploadToDropbox(outPath, stylizedBytes);

    // 5) 프런트 응답
    return res.json({
      ok: true,
      user: rawName,               // "찬" 같은 실제 닉네임
      original_path: origPath,     // 원본이 Dropbox에 어디 저장됐는지
      stylized_path: outPath,      // 스타일 변환본이 Dropbox 어디에 있는지
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

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Server running on port " + port);
});




