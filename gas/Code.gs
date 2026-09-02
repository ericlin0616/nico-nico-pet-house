/**
 * NicoPark 入園登記｜Google Apps Script 後端
 *
 * 會做的事：
 *  1. 寫入 Google 試算表
 *  2. 把入園副本寄到飼主信箱（含 PDF）
 *  3. 把 PDF、簽名圖存進商家 Google 雲端資料夾
 *  4. 發送／核對驗證碼（先寄到電子信箱；簡訊可之後再接）
 *
 * 部署步驟（一次即可）：
 *  1. 開啟 https://script.google.com → 新增專案 → 專案名稱「NicoPark 入園登記」
 *  2. 刪掉預設程式碼，把本檔全部貼上並儲存
 *  3. 右上角「部署」→「新增部署」→ 類型選「網頁應用程式」
 *     - 說明：NicoPark
 *     - 執行身分：我
 *     - 具有存取權的使用者：任何人
 *  4. 授權（選你的 Google 帳號 → 進階 → 前往專案）
 *  5. 複製 Web App 的 /exec 網址，貼回網站 index.html 的 GAS_WEB_APP_URL
 */

var CONFIG = {
  // 留空：由腳本用「執行身分」的 Google 帳號自動建立雲端資料夾與試算表
  FOLDER_ID: "",
  SHEET_ID: "",
  SHEET_NAME: "入園登記",
  BUSINESS_NAME: "Nico Nico Pet House 尼口尼口寵物精緻美容旅館",
  BUSINESS_EMAIL: "",
  OTP_TTL_SEC: 600,
  OTP_MAX_TRIES: 5
};

var SHEET_HEADERS = [
  "案件識別碼", "送出時間", "飼主名稱", "聯絡電話", "電子信箱", "LINE名稱",
  "緊急聯絡人", "緊急聯絡人電話", "毛寶名字", "性別", "品種", "年齡", "體重kg",
  "是否結紮", "是否發情", "親狗親人", "護食護玩具", "牽繩狀況", "固定獸醫院",
  "獸醫院名稱與電話", "近14天健康", "疾病紀錄", "驅蟲時間", "滴劑口服藥",
  "注意事項", "已同意條款", "簽署時間", "雲端資料夾", "PDF連結", "簽名檔"
];

function doGet() {
  return json_({ ok: true, service: "NicoPark", message: "NicoPark 入園登記服務運作中" });
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    var payload = parsePayload_(e);
    var action = String(payload.action || "");
    if (action === "sendOtp") return json_(sendOtp_(payload));
    if (action === "submit") return json_(submit_(payload));
    return json_({ success: false, message: "未知的操作，請重新整理頁面後再試。" });
  } catch (err) {
    return json_({ success: false, message: friendlyErr_(err) });
  } finally {
    try { lock.releaseLock(); } catch (e2) {}
  }
}

function sendOtp_(payload) {
  var phone = String(payload.phone || "").replace(/\D/g, "");
  if (!/^09\d{8}$/.test(phone)) {
    throw new Error("手機號碼格式不正確。");
  }
  var email = String(payload.email || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("找不到電子信箱，請返回第一步確認。");
  }
  var code = "";
  for (var i = 0; i < 6; i++) code += String(Math.floor(Math.random() * 10));
  var cache = CacheService.getScriptCache();
  cache.put("otp_" + phone, JSON.stringify({
    code: code,
    email: email,
    exp: Date.now() + CONFIG.OTP_TTL_SEC * 1000,
    tries: 0
  }), CONFIG.OTP_TTL_SEC);

  MailApp.sendEmail({
    to: email,
    subject: "【" + CONFIG.BUSINESS_NAME + "】入園驗證碼 " + code,
    name: "Nico Nico Pet House",
    htmlBody:
      "<p>您好，</p>" +
      "<p>您的 NicoPark 入園驗證碼為：</p>" +
      "<p style=\"font-size:28px;letter-spacing:8px;font-weight:700;color:#53453A\">" + code + "</p>" +
      "<p>請於 10 分鐘內輸入。若不是您本人操作，請忽略此信。</p>" +
      "<p>Nico Nico Pet House 尼口尼口寵物精緻美容旅館</p>"
  });

  return { success: true, channel: "email" };
}

function submit_(payload) {
  var form = payload.form || {};
  var owner = form.owner || {};
  var pet = form.pet || {};
  var care = form.care || {};
  var phone = String(owner.phone || "").replace(/\D/g, "");
  if (!/^09\d{8}$/.test(phone)) throw new Error("手機號碼格式不正確。");
  verifyOtp_(phone, String(payload.otp || ""));

  if (!payload.agreedToTerms) throw new Error("請先同意條款並完成簽署。");
  if (!payload.signatureDataUrl) throw new Error("找不到手寫簽名，請返回上一步重簽。");

  var caseId = makeCaseId_();
  var now = new Date();
  var tzNow = Utilities.formatDate(now, "Asia/Taipei", "yyyy-MM-dd HH:mm:ss");

  var folder = getRootFolder_();
  var caseFolder = folder.createFolder(
    caseId + "_" + safeName_(pet.name || "毛孩") + "_" + Utilities.formatDate(now, "Asia/Taipei", "yyyyMMdd")
  );

  var signBlob = dataUrlToBlob_(payload.signatureDataUrl, caseId + "_簽名.png");
  var signFile = caseFolder.createFile(signBlob);

  var pdfFile = createPdf_(caseFolder, caseId, tzNow, owner, pet, care, payload, signBlob);

  try { pdfFile.addViewer(String(owner.email || "")); } catch (e1) {}
  try { signFile.addViewer(String(owner.email || "")); } catch (e2) {}

  appendRow_(caseId, tzNow, owner, pet, care, payload, caseFolder.getUrl(), pdfFile.getUrl(), signFile.getUrl());

  sendCustomerMail_(owner, pet, caseId, pdfFile, caseFolder.getUrl());
  if (CONFIG.BUSINESS_EMAIL) {
    sendBusinessMail_(owner, pet, caseId, pdfFile, caseFolder.getUrl());
  }

  consumeOtp_(phone);

  return {
    success: true,
    caseId: caseId,
    pdfUrl: pdfFile.getUrl(),
    message: "入園資料已送出。副本已寄到 " + owner.email + "，Nico Nico 也已存入雲端與登記表。"
  };
}

function verifyOtp_(phone, otp) {
  var rec = readOtp_(phone);
  rec.tries = (rec.tries || 0) + 1;
  if (rec.tries > CONFIG.OTP_MAX_TRIES) {
    consumeOtp_(phone);
    throw new Error("驗證碼錯誤次數過多，請重新發送。");
  }
  if (String(rec.code) !== String(otp)) {
    CacheService.getScriptCache().put("otp_" + phone, JSON.stringify(rec), CONFIG.OTP_TTL_SEC);
    throw new Error("驗證碼不正確，請再試一次。");
  }
}

function readOtp_(phone) {
  var raw = CacheService.getScriptCache().get("otp_" + phone);
  if (!raw) throw new Error("驗證碼已過期或尚未發送，請重新取得驗證碼。");
  return JSON.parse(raw);
}

function consumeOtp_(phone) {
  CacheService.getScriptCache().remove("otp_" + phone);
}

function getRootFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = String(CONFIG.FOLDER_ID || props.getProperty("FOLDER_ID") || "");
  if (id) {
    try {
      return DriveApp.getFolderById(id);
    } catch (err) {
      // 舊資料夾 ID 對這個 Google 帳號無效時，改為自動建立
    }
  }
  var existing = DriveApp.getRootFolder().getFoldersByName("NicoPark 入園資料");
  var folder = existing.hasNext() ? existing.next() : DriveApp.createFolder("NicoPark 入園資料");
  props.setProperty("FOLDER_ID", folder.getId());
  return folder;
}

function getSheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = CONFIG.SHEET_ID || props.getProperty("SHEET_ID") || "";
  var ss = null;
  if (id) {
    try { ss = SpreadsheetApp.openById(id); } catch (err) { ss = null; }
  }
  if (!ss) {
    var folder = getRootFolder_();
    var files = folder.getFilesByName("NicoPark 入園登記");
    if (files.hasNext()) {
      ss = SpreadsheetApp.open(files.next());
    } else {
      ss = SpreadsheetApp.create("NicoPark 入園登記");
      DriveApp.getFileById(ss.getId()).moveTo(folder);
    }
    props.setProperty("SHEET_ID", ss.getId());
  }
  var sh = ss.getSheetByName(CONFIG.SHEET_NAME) || ss.getSheets()[0];
  sh.setName(CONFIG.SHEET_NAME);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, SHEET_HEADERS.length).setValues([SHEET_HEADERS]);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, SHEET_HEADERS.length).setFontWeight("bold");
  }
  return sh;
}

function friendlyErr_(err) {
  var m = String(err && err.message ? err.message : err || "");
  if (/指定 ID|specified ID|not found|沒有編輯/i.test(m)) {
    return "雲端資料夾尚未建立或沒有權限。請在 Apps Script 存檔並「管理部署 → 新版本」後再送出，系統會自動建立資料夾。";
  }
  if (/授權|Authorization|Access denied|權限/i.test(m)) {
    return "Google 尚未授權雲端或試算表權限。請在 Apps Script 重新授權後再試。";
  }
  if (/配額|quota|Service invoked too many/i.test(m)) {
    return "今日寄信或雲端寫入次數已用完，請稍後再試。";
  }
  return m || "伺服器暫時無法處理，請稍後再試。";
}

function appendRow_(caseId, tzNow, owner, pet, care, payload, folderUrl, pdfUrl, signUrl) {
  var guarding = join_(care.guarding);
  if (care.guardingOther) guarding += (guarding ? "；" : "") + care.guardingOther;
  var diseases = join_(care.diseases);
  if (care.diseaseOther) diseases += (diseases ? "；" : "") + care.diseaseOther;
  var deworm = care.deworm || "";
  if (care.dewormOther) deworm += (deworm ? "；" : "") + care.dewormOther;
  var prev = care.preventative || "";
  if (care.preventativeOther) prev += (prev ? "；" : "") + care.preventativeOther;

  getSheet_().appendRow([
    caseId, tzNow, owner.name || "", owner.phone || "", owner.email || "", owner.lineName || "",
    owner.emergencyName || "", owner.emergencyPhone || "", pet.name || "", pet.gender || "",
    pet.breed || "", pet.age || "", pet.weightKg || "", pet.neutered || "", pet.inHeat || "",
    care.sociability || "", guarding, care.leash || "", care.hasVet || "", care.vetInfo || "",
    join_(care.health14), diseases, deworm, prev, care.notes || "",
    payload.agreedToTerms ? "是" : "否", payload.agreedAt || "",
    folderUrl, pdfUrl, signUrl
  ]);
}

function createPdf_(folder, caseId, tzNow, owner, pet, care, payload, signBlob) {
  var title = "NicoPark 入園資料 " + caseId;
  var doc = DocumentApp.create(title);
  var body = doc.getBody();
  body.appendParagraph("Nico Nico Pet House").setHeading(DocumentApp.ParagraphHeading.HEADING1);
  body.appendParagraph("尼口尼口寵物精緻美容旅館｜NicoPark 毛孩入園資料");
  body.appendParagraph("案件識別碼：" + caseId);
  body.appendParagraph("送出時間：" + tzNow);
  body.appendParagraph("");
  body.appendParagraph("一、飼主資料").setHeading(DocumentApp.ParagraphHeading.HEADING2);
  addLine_(body, "飼主名稱", owner.name);
  addLine_(body, "聯絡電話", owner.phone);
  addLine_(body, "電子信箱", owner.email);
  addLine_(body, "LINE 名稱", owner.lineName);
  addLine_(body, "緊急聯絡人", owner.emergencyName);
  addLine_(body, "緊急聯絡人電話", owner.emergencyPhone);
  body.appendParagraph("二、毛寶資料").setHeading(DocumentApp.ParagraphHeading.HEADING2);
  addLine_(body, "名字", pet.name);
  addLine_(body, "性別", pet.gender);
  addLine_(body, "品種", pet.breed);
  addLine_(body, "年齡", pet.age);
  addLine_(body, "體重", pet.weightKg ? pet.weightKg + " 公斤" : "");
  addLine_(body, "結紮", pet.neutered);
  addLine_(body, "發情階段", pet.inHeat);
  body.appendParagraph("三、照護與健康").setHeading(DocumentApp.ParagraphHeading.HEADING2);
  addLine_(body, "親狗親人", care.sociability);
  addLine_(body, "護食／敏感", join_(care.guarding) + (care.guardingOther ? "；" + care.guardingOther : ""));
  addLine_(body, "牽繩狀況", care.leash);
  addLine_(body, "固定獸醫院", care.hasVet === "是" ? (care.vetInfo || "是") : (care.hasVet || ""));
  addLine_(body, "近 14 天健康", join_(care.health14));
  addLine_(body, "疾病紀錄", join_(care.diseases) + (care.diseaseOther ? "；" + care.diseaseOther : ""));
  addLine_(body, "驅蟲", (care.deworm || "") + (care.dewormOther ? "；" + care.dewormOther : ""));
  addLine_(body, "滴劑／口服藥", (care.preventative || "") + (care.preventativeOther ? "；" + care.preventativeOther : ""));
  addLine_(body, "備註", care.notes);
  body.appendParagraph("四、簽署").setHeading(DocumentApp.ParagraphHeading.HEADING2);
  addLine_(body, "同意電子簽署", payload.agreedToTerms ? "是" : "否");
  addLine_(body, "簽署時間", payload.agreedAt);
  if (signBlob) {
    try {
      body.appendParagraph("手寫簽名：");
      var img = body.appendImage(signBlob);
      var iw = img.getWidth() || 1;
      var ih = img.getHeight() || 1;
      var scale = Math.min(380 / iw, 118 / ih);
      img.setWidth(iw * scale);
      img.setHeight(ih * scale);
    } catch (e) {}
  }
  doc.saveAndClose();

  var docFile = DriveApp.getFileById(doc.getId());
  var pdfBlob = docFile.getAs(MimeType.PDF).setName(caseId + "_入園資料.pdf");
  var pdfFile = folder.createFile(pdfBlob);
  docFile.setTrashed(true);
  return pdfFile;
}

function sendCustomerMail_(owner, pet, caseId, pdfFile, folderUrl) {
  var to = String(owner.email || "");
  if (!to) return;
  MailApp.sendEmail({
    to: to,
    subject: "【" + CONFIG.BUSINESS_NAME + "】入園資料已受理（" + caseId + "）",
    name: "Nico Nico Pet House",
    htmlBody:
      "<p>" + esc_(owner.name) + " 您好，</p>" +
      "<p>我們已收到毛寶 <strong>" + esc_(pet.name) + "</strong> 的 NicoPark 入園資料與電子簽署。</p>" +
      "<p>案件識別碼：<strong>" + esc_(caseId) + "</strong></p>" +
      "<p>副本 PDF 如附件，也請自行保存此信件。</p>" +
      "<p>若需補件或有照護叮嚀，請再與 Nico Nico 聯繫。</p>" +
      "<p>Nico Nico Pet House 尼口尼口寵物精緻美容旅館</p>",
    attachments: [pdfFile.getAs(MimeType.PDF)]
  });
}

function sendBusinessMail_(owner, pet, caseId, pdfFile, folderUrl) {
  MailApp.sendEmail({
    to: CONFIG.BUSINESS_EMAIL,
    subject: "【新入園】" + caseId + " " + (pet.name || "") + "／" + (owner.name || ""),
    name: "NicoPark",
    htmlBody:
      "<p>新的入園資料已寫入試算表並存雲端。</p>" +
      "<p>案件：" + esc_(caseId) + "<br>飼主：" + esc_(owner.name) + " " + esc_(owner.phone) +
      "<br>毛寶：" + esc_(pet.name) + "</p>" +
      "<p><a href=\"" + folderUrl + "\">開啟雲端資料夾</a></p>",
    attachments: [pdfFile.getAs(MimeType.PDF)]
  });
}

function addLine_(body, label, value) {
  body.appendParagraph(label + "：" + (value == null || value === "" ? "—" : String(value)));
}

function join_(v) {
  if (Array.isArray(v)) return v.filter(function (x) { return x; }).join("、");
  return v == null ? "" : String(v);
}

function makeCaseId_() {
  var d = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyyMMdd");
  var n = Math.floor(Math.random() * 36 * 36 * 36 * 36).toString(36).toUpperCase();
  while (n.length < 4) n = "0" + n;
  return "NP-" + d + "-" + n;
}

function safeName_(s) {
  return String(s || "").replace(/[\\/:*?"<>|]/g, "").slice(0, 20) || "毛孩";
}

function dataUrlToBlob_(dataUrl, name) {
  var m = String(dataUrl || "").match(/^data:([^;]+);base64,(.+)$/);
  if (!m) throw new Error("簽名圖檔格式不正確，請清除後重簽。");
  return Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], name);
}

function parsePayload_(e) {
  if (!e) return {};
  if (e.postData && e.postData.contents) {
    var raw = e.postData.contents;
    try { return JSON.parse(raw); } catch (err) {}
    try {
      var params = {};
      String(raw).split("&").forEach(function (part) {
        var i = part.indexOf("=");
        if (i < 0) return;
        var k = decodeURIComponent(part.slice(0, i).replace(/\+/g, " "));
        var v = decodeURIComponent(part.slice(i + 1).replace(/\+/g, " "));
        params[k] = v;
      });
      if (params.payload) return JSON.parse(params.payload);
      return params;
    } catch (err2) {}
  }
  if (e.parameter && e.parameter.payload) {
    try { return JSON.parse(e.parameter.payload); } catch (err3) {}
  }
  return e.parameter || {};
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function esc_(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (ch) {
    if (ch === "&") return "&#38;";
    if (ch === "<") return "&#60;";
    if (ch === ">") return "&#62;";
    if (ch === '"') return "&#34;";
    return "&#39;";
  });
}
