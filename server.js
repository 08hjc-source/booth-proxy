import express from "express";
import cors from "cors";
import multer from "multer";

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

// ⬇⬇⬇ 너 토큰 넣는 곳 (그대로 유지)
const DROPBOX_TOKEN = "Bearer sl.u.AGETpn391W2nwklxtA8oo41Gnatvu3sPidlLCA1zA9sey13ED_RlgxygVckdBIbQbl1veL0YxaGh-3Pk66U1uFCuwm-LHVqw_ERrvjVHNCHXE3LUeYKwLDzFxaPSubFVJZD3DafBresjaqFF87w5_3CwlOioun-DOqLdfnDTPzDlnH_FBt0Gnq3Z2vIWU1opWwXtKT9WPO2ihkqpotRR8TIBN6-2GEm3aFKnxOuviJx8M2yAKD_HTZghI2PylOq6MEfAG-aRV52SBsIH5a6ge7epqR_5w_ReJL_FSrkAFQv9vrwn4pO_jD3LIbSN3JCbPn1nUOSBjnhRvn4GJ7846e291h2f2C-ibdPer23H0CUNXdBJyP4qoGI5uSo-sdZmXb8fvsY9kFgAQEpL-Bx65EqGnZOrD-DUoPga3ulTHY4V-K7O97Gy1M0yCffy-PUNEqN0FVEwrfX1pXUm2ycekmwSdxpfjSXTZmel0CrcawFVQWAo8TYtZ0BtxNarnxOrwoEkIxqabjM8ge3J8kigZSuxyb3hSBAL35_BOQTbpPyr8p9qiSj4iWKkrxTk8M0joNozcMPm_9qOhIWktoHNplFeP3bYIAd7YOVbEsHDllwRMHVCnwXwXTN6gLLFK11G0ujTgHX4NsS4RQZQ-UM3X0WE35KSnJ0wRgfpHsl7LyAMol1V_wXDF0Otebe-BkKwJMNdzbUZrCzkh3aBGKiqoTWvCRtodYEtgOF5ymJW5BYyxfc5luvMvKkf5z2xaZ7V3keX6XRYtNmi9zcllk-WHmCioS1N-K3xtQlMhJMkyk__WY_BXGDkt4rWMKARLFqNjrTb7AATZ5clpUrwlaKwP7TTa1rlFpZ3MsphUiPRnHMfA5rwDYVM1I6nps3AFTwvoFbq_nxKxg1rwK7HCRXSA9EcV6rMwQIx6oXGEjQHaaH38tz4rWaSHW7o3QGL-lS3M7QQZAF_PhcborCZ0ItWz5S9x6mRX6oJnmFuVTZhjK5WVcitsE2C6EFYxH3wIIwGVZf1t2xUmAXOmObHygd5LIdEDzqPHddjbhwApJHfl-eNcEfqY06bVz9wnKH57tLlIeWtwW-5gz0hO-zA31F0KF0oUh3s_kzq0nlLKee8QDfPIKn-hgrVYiIEwT9LjMXCLokdI2A-Rh-L34lA9r3XhiN9Dn0Mi8A8iIKtb8RfopZbMbXqhRm3c1melFyzhFxUxU-F_gRz6hzblfOvTj5JZhl61CWza4hch3woH5n2ClLqVabUSq1A3dOg8jUtC6tuRnbTpR4yqOjlpbRM_nWCCHPVop0eMSoSrzdeddP5g1hBA4ZPnnJBUTP3f8Ctc5xcMbGpEV_6x9oPThphvnl7mlomandSqHwSJRnenhnVfBB4SfcDcSZy0HUzyDU-whRhpWoNKTlGixG5j9VOqboWo2D1";
const OPENAI_KEY = "YOUR_OPENAI_KEY_HERE"; // sk- 로 시작하는 키

// 닉네임을 ASCII로만 변환 (Dropbox 경로에 한글 못 들어가니까)
function sanitizeAsciiFilename(userLabel) {
  const asciiOnly = (userLabel || "")
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "") // ASCII 외 제거
    .replace(/[\/\\:\*\?"<>\|]/g, "") // 위험문자 제거
    .replace(/\s+/g, "_")
    .trim();
  return asciiOnly || "user";
}

// 한국시간 HHMMSS
function getKSTTimeTag() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const hh = String(kst.getUTCHours()).padStart(2, "0");
  const mm = String(kst.getUTCMinutes()).padStart(2, "0");
  const ss = String(kst.getUTCSeconds()).padStart(2, "0");
  return `${hh}${mm}${ss}`;
}

// 1) Dropbox에 업로드하는 함수
async function uploadToDropbox(pathInDropbox, fileBytes) {
  const resp = await fetch(
    "https://content.dropboxapi.com/2/files/upload",
    {
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
    }
  );
  const data = await resp.json();
  if (!resp.ok) {
    console.error("Dropbox upload fail:", data);
    throw new Error("dropbox upload failed");
  }
  return data;
}

// 2) OpenAI 이미지 변환 호출 함수
async function stylizeWithOpenAI(inputImageBytes) {
  // 여기서 하는 일:
  // - OpenAI 이미지 편집 API에 이미지랑 "스타일 설명 프롬프트"를 같이 보내서
  //   만화/캐릭터 스타일로 바꾼 결과 이미지를 받아온다.
  //
  // 참고: OpenAI 이미지 API는 기존 이미지를 기반으로 수정/스타일화가 가능하다고 문서에 나와 있다.
  // 한 장의 입력 이미지를 주고, 프롬프트로 "원본 인물은 유지하되 이 스타일로 변환해" 라고 지시할 수 있다. :contentReference[oaicite:1]{index=1}
  //
  // 여기서는 가상의 엔드포인트 형태로 적어줄게. (images/edits)
  // Render 서버에서 fetch로 직접 부를 수 있는 일반 HTTP POST 형태다.

  // 1) input 이미지를 form-data로 보냄
  // 2) prompt에 우리가 원하는 스타일을 적음

  // ↓ 이 스타일 설명은 너 그림체 설명으로 바꾸면 돼.
  const stylePrompt =
    "Convert the person in this photo into a clean flat mascot-style illustration with bold outlines, simple cel shading, big head small body proportions, no background, keep same clothing colors and same facial identity.";

  const formData = new FormData();
  formData.append(
    "image",
    new Blob([inputImageBytes], { type: "image/png" }),
    "input.png"
  );
  formData.append("prompt", stylePrompt);
  // 원하는 출력 사이즈
  formData.append("size", "1024x1024");

  const resp = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
    },
    body: formData,
  });

  const result = await resp.json();

  if (!resp.ok) {
    console.error("OpenAI image edit fail:", result);
    throw new Error("openai style conversion failed");
  }

  // OpenAI 이미지 API는 base64로 결과 이미지를 돌려준다고 문서화되어 있음. :contentReference[oaicite:2]{index=2}
  // result.data[0].b64_json 이런 식으로 온다.
  const b64 = result.data[0].b64_json;
  const bytes = Buffer.from(b64, "base64");
  return bytes; // 변환된 PNG 바이너리
}

app.post("/upload", upload.single("photo"), async (req, res) => {
  try {
    // --- 들어온 원본 파일/닉네임 확보 ---
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({
        ok: false,
        message: "no file buffer",
      });
    }
    const fileBuffer = req.file.buffer;

    const rawName =
      req.body && typeof req.body.name === "string" ? req.body.name : "";
    console.log("받은 이름(raw):", rawName);

    const safeBase = sanitizeAsciiFilename(rawName);
    const timeTag = getKSTTimeTag();

    // 원본 파일명 / 경로 (ASCII로만)
    const origFileName = `${safeBase}_${timeTag}.png`;
    const origPath = `/booth_uploads/${origFileName}`;

    // 1) 원본을 Dropbox에 저장
    await uploadToDropbox(origPath, fileBuffer);

    // 2) OpenAI에 스타일 변환 요청 (이게 너가 원하는 "너 스타일로 바꿔줘" 단계)
    const stylizedBytes = await stylizeWithOpenAI(fileBuffer);

    // 3) 결과 이미지를 Dropbox에 저장 (output 폴더)
    const outFileName = `${safeBase}_${timeTag}_stylized.png`;
    const outPath = `/booth_outputs/${outFileName}`;
    await uploadToDropbox(outPath, stylizedBytes);

    // 4) 클라이언트로 응답
    return res.json({
      ok: true,
      user: rawName,               // 한글 닉네임 그대로
      original_path: origPath,     // 원본 저장 위치
      stylized_path: outPath,      // 변환본 저장 위치
      status: "done",              // 프론트에서 '완료'라고 띄워줄 수 있음
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
