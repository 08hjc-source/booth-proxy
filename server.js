import express from "express";
import cors from "cors";
import multer from "multer";
import fetch from "node-fetch";

const app = express();

// CORS 허용
app.use(cors());

// multer로 multipart/form-data 받기
const upload = multer();

// 🔐 Dropbox 토큰 (Bearer 포함, 한 줄 그대로)
const DROPBOX_TOKEN = "Bearer sl.u.AGETpn391W2nwklxtA8oo41Gnatvu3sPidlLCA1zA9sey13ED_RlgxygVckdBIbQbl1veL0YxaGh-3Pk66U1uFCuwm-LHVqw_ERrvjVHNCHXE3LUeYKwLDzFxaPSubFVJZD3DafBresjaqFF87w5_3CwlOioun-DOqLdfnDTPzDlnH_FBt0Gnq3Z2vIWU1opWwXtKT9WPO2ihkqpotRR8TIBN6-2GEm3aFKnxOuviJx8M2yAKD_HTZghI2PylOq6MEfAG-aRV52SBsIH5a6ge7epqR_5w_ReJL_FSrkAFQv9vrwn4pO_jD3LIbSN3JCbPn1nUOSBjnhRvn4GJ7846e291h2f2C-ibdPer23H0CUNXdBJyP4qoGI5uSo-sdZmXb8fvsY9kFgAQEpL-Bx65EqGnZOrD-DUoPga3ulTHY4V-K7O97Gy1M0yCffy-PUNEqN0FVEwrfX1pXUm2ycekmwSdxpfjSXTZmel0CrcawFVQWAo8TYtZ0BtxNarnxOrwoEkIxqabjM8ge3J8kigZSuxyb3hSBAL35_BOQTbpPyr8p9qiSj4iWKkrxTk8M0joNozcMPm_9qOhIWktoHNplFeP3bYIAd7YOVbEsHDllwRMHVCnwXwXTN6gLLFK11G0ujTgHX4NsS4RQZQ-UM3X0WE35KSnJ0wRgfpHsl7LyAMol1V_wXDF0Otebe-BkKwJMNdzbUZrCzkh3aBGKiqoTWvCRtodYEtgOF5ymJW5BYyxfc5luvMvKkf5z2xaZ7V3keX6XRYtNmi9zcllk-WHmCioS1N-K3xtQlMhJMkyk__WY_BXGDkt4rWMKARLFqNjrTb7AATZ5clpUrwlaKwP7TTa1rlFpZ3MsphUiPRnHMfA5rwDYVM1I6nps3AFTwvoFbq_nxKxg1rwK7HCRXSA9EcV6rMwQIx6oXGEjQHaaH38tz4rWaSHW7o3QGL-lS3M7QQZAF_PhcborCZ0ItWz5S9x6mRX6oJnmFuVTZhjK5WVcitsE2C6EFYxH3wIIwGVZf1t2xUmAXOmObHygd5LIdEDzqPHddjbhwApJHfl-eNcEfqY06bVz9wnKH57tLlIeWtwW-5gz0hO-zA31F0KF0oUh3s_kzq0nlLKee8QDfPIKn-hgrVYiIEwT9LjMXCLokdI2A-Rh-L34lA9r3XhiN9Dn0Mi8A8iIKtb8RfopZbMbXqhRm3c1melFyzhFxUxU-F_gRz6hzblfOvTj5JZhl61CWza4hch3woH5n2ClLqVabUSq1A3dOg8jUtC6tuRnbTpR4yqOjlpbRM_nWCCHPVop0eMSoSrzdeddP5g1hBA4ZPnnJBUTP3f8Ctc5xcMbGpEV_6x9oPThphvnl7mlomandSqHwSJRnenhnVfBB4SfcDcSZy0HUzyDU-whRhpWoNKTlGixG5j9VOqboWo2D1";

function makeSafeName(raw) {
  if (!raw) return "user";

  // 공백은 _ 로 바꾸고, 경로를 깨뜨리는 위험 문자만 제거.
  // 한글, 영문, 숫자, 언더바, 하이픈은 그대로 살려.
  return raw
    .trim()
    .replace(/[\/\\:\*\?"<>\|]/g, "") // 진짜 위험한 문자들만 제거
    .replace(/\s+/g, "_"); // 공백 → _
}

app.post("/upload", upload.single("photo"), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ ok: false, message: "no file" });
    }

    const fileBuffer = req.file.buffer;

    // 프런트에서 보낸 이름(한글 포함)
    const rawName = req.body && req.body.name ? req.body.name : "";
    console.log("받은 이름:", rawName);

    const safeName = makeSafeName(rawName); // 한글 유지됨

    // 최종 파일 경로
    const dropboxPath = `/booth_uploads/${safeName}_${Date.now()}.png`;

    // Dropbox 업로드 호출
    const resp = await fetch("https://content.dropboxapi.com/2/files/upload", {
      method: "POST",
      headers: {
        Authorization: DROPBOX_TOKEN,
        "Dropbox-API-Arg": JSON.stringify({
          path: dropboxPath,
          mode: "add",
          autorename: true,
          mute: false
        }),
        "Content-Type": "application/octet-stream"
      },
      body: fileBuffer
    });

    const data = await resp.json();

    if (!resp.ok) {
      console.error("Dropbox error:", data);
      return res.status(500).json({
        ok: false,
        message: data?.error_summary || "dropbox upload failed"
      });
    }

    return res.json({
      ok: true,
      path: data.path_display || dropboxPath
    });
  } catch (error) {
    console.error("Upload error:", error);
    return res.status(500).json({ ok: false, message: "server error" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server running on port " + port));
