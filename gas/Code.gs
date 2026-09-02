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
 *
 * 每次更新本檔後，請「部署 → 管理部署 → 編輯（鉛筆）→ 版本選新版本 → 部署」
 * 否則信件仍會寄出舊的簽名圖／舊 PDF。
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
    if (action === "lookup") return json_(lookup_(payload));
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
  var cache = CacheService.getScriptCache();
  if (cache.get("otp_sent_" + phone)) {
    throw new Error("請稍候再重新發送驗證碼。");
  }
  var email = String(payload.email || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    email = findEmailByPhone_(phone);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(payload.purpose === "lookup"
      ? "找不到此手機的入園紀錄，請確認號碼或先完成登記。"
      : "找不到電子信箱，請返回第一步確認。");
  }
  var code = "";
  for (var i = 0; i < 6; i++) code += String(Math.floor(Math.random() * 10));
  cache.put("otp_" + phone, JSON.stringify({
    code: code,
    email: email,
    exp: Date.now() + CONFIG.OTP_TTL_SEC * 1000,
    tries: 0
  }), CONFIG.OTP_TTL_SEC);
  cache.put("otp_sent_" + phone, "1", 60);

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

function petsOf_(form) {
  if (form.pets && form.pets.length) {
    return form.pets.map(function (p) {
      return { pet: p, care: p };
    });
  }
  if (form.pet) return [{ pet: form.pet, care: form.care || {} }];
  return [];
}

function submit_(payload) {
  var form = payload.form || {};
  var owner = form.owner || {};
  var list = petsOf_(form);
  if (!list.length) throw new Error("請至少填寫一隻毛孩的資料。");
  var phone = String(owner.phone || "").replace(/\D/g, "");
  if (!/^09\d{8}$/.test(phone)) throw new Error("手機號碼格式不正確。");
  verifyOtp_(phone, String(payload.otp || ""));

  if (!payload.agreedToTerms) throw new Error("請先同意條款並完成簽署。");
  if (!payload.signatureDataUrl) throw new Error("找不到手寫簽名，請返回上一步重簽。");

  var caseId = makeCaseId_();
  var now = new Date();
  var tzNow = Utilities.formatDate(now, "Asia/Taipei", "yyyy-MM-dd HH:mm:ss");
  var names = list.map(function (x) { return x.pet && x.pet.name; }).filter(function (n) { return n; });
  var folderLabel = names.length > 1
    ? safeName_(names[0]) + "等" + names.length + "隻"
    : safeName_(names[0] || "毛孩");

  var folder = getRootFolder_();
  var caseFolder = folder.createFolder(
    caseId + "_" + folderLabel + "_" + Utilities.formatDate(now, "Asia/Taipei", "yyyyMMdd")
  );

  var signBlob = dataUrlToBlob_(payload.signatureDataUrl, caseId + "_簽名.png");
  var signFile = caseFolder.createFile(signBlob);

  var pdfFile = createPdf_(caseFolder, caseId, tzNow, owner, list, payload, signBlob);

  try { pdfFile.addViewer(String(owner.email || "")); } catch (e1) {}
  try { signFile.addViewer(String(owner.email || "")); } catch (e2) {}

  list.forEach(function (item) {
    appendRow_(caseId, tzNow, owner, item.pet, item.care, payload, caseFolder.getUrl(), pdfFile.getUrl(), signFile.getUrl());
  });

  sendCustomerMail_(owner, names, caseId, pdfFile);
  if (CONFIG.BUSINESS_EMAIL) {
    sendBusinessMail_(owner, names, caseId, pdfFile, caseFolder.getUrl());
  }

  consumeOtp_(phone);

  return {
    success: true,
    caseId: caseId,
    pdfUrl: pdfFile.getUrl(),
    message: "入園資料已送出（" + names.join("、") + "）。副本已寄到 " + owner.email + "。"
  };
}

function lookup_(payload) {
  var phone = String(payload.phone || "").replace(/\D/g, "");
  if (!/^09\d{8}$/.test(phone)) throw new Error("手機號碼格式不正確。");
  verifyOtp_(phone, String(payload.otp || ""));
  var sh = getSheet_();
  var values = sh.getDataRange().getDisplayValues();
  var map = {};
  var order = [];
  for (var r = values.length - 1; r >= 1; r--) {
    var row = values[r];
    var p = String(row[3] || "").replace(/\D/g, "");
    if (p !== phone) continue;
    var id = String(row[0] || "");
    if (!id) continue;
    if (!map[id]) {
      map[id] = {
        caseId: id,
        submittedAt: row[1] || "",
        petNames: [],
        pdfUrl: row[28] || ""
      };
      order.push(id);
    }
    if (row[8]) map[id].petNames.push(String(row[8]));
    if (!map[id].pdfUrl && row[28]) map[id].pdfUrl = row[28];
    if (order.length >= 30) break;
  }
  consumeOtp_(phone);
  return {
    success: true,
    cases: order.map(function (id) { return map[id]; })
  };
}

function findEmailByPhone_(phone) {
  try {
    var sh = getSheet_();
    var values = sh.getDataRange().getDisplayValues();
    for (var r = values.length - 1; r >= 1; r--) {
      var p = String(values[r][3] || "").replace(/\D/g, "");
      if (p === phone && values[r][4]) return String(values[r][4]).trim();
    }
  } catch (err) {}
  return "";
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

function createPdf_(folder, caseId, tzNow, owner, list, payload, signBlob) {
  var html = buildPdfHtml_(caseId, tzNow, owner, list, payload, signBlob);
  var pdfBlob;
  try {
    pdfBlob = Utilities.newBlob(html, MimeType.HTML, caseId + ".html")
      .getAs(MimeType.PDF)
      .setName(caseId + "_NicoPark入園資料.pdf");
  } catch (err) {
    pdfBlob = createPdfViaDoc_(caseId, tzNow, owner, list, payload, signBlob);
  }
  return folder.createFile(pdfBlob);
}

function createPdfViaDoc_(caseId, tzNow, owner, list, payload, signBlob) {
  var doc = DocumentApp.create("NicoPark 入園資料 " + caseId);
  var body = doc.getBody();
  body.appendParagraph("Nico Nico Pet House").setHeading(DocumentApp.ParagraphHeading.HEADING1);
  body.appendParagraph("尼口尼口寵物精緻美容旅館｜NicoPark 毛孩入園資料");
  body.appendParagraph("案件識別碼：" + caseId + "　送出時間：" + tzNow);
  body.appendParagraph("一、飼主資料").setHeading(DocumentApp.ParagraphHeading.HEADING2);
  addLine_(body, "飼主名稱", owner.name);
  addLine_(body, "聯絡電話", owner.phone);
  addLine_(body, "電子信箱", owner.email);
  addLine_(body, "LINE 名稱", owner.lineName);
  addLine_(body, "緊急聯絡人", owner.emergencyName);
  addLine_(body, "緊急聯絡人電話", owner.emergencyPhone);
  (list || []).forEach(function (item, i) {
    var pet = item.pet || {};
    var care = item.care || pet;
    body.appendParagraph("毛寶 " + (i + 1) + "　" + (pet.name || "")).setHeading(DocumentApp.ParagraphHeading.HEADING2);
    addLine_(body, "性別", markOpts_(OPTIONS.gender, pet.gender));
    addLine_(body, "品種", pet.breed);
    addLine_(body, "年齡", pet.age);
    addLine_(body, "體重", pet.weightKg ? pet.weightKg + " 公斤" : "");
    addLine_(body, "結紮", markOpts_(OPTIONS.yesNo, pet.neutered));
    addLine_(body, "發情", markOpts_(OPTIONS.yesNo, pet.inHeat));
    addLine_(body, "親狗親人", markOpts_(OPTIONS.sociability, care.sociability));
    addLine_(body, "護食／敏感", markOpts_(OPTIONS.guarding, care.guarding) + extra_(care.guardingOther));
    addLine_(body, "牽繩狀況", markOpts_(OPTIONS.leash, care.leash));
    addLine_(body, "固定獸醫院", markOpts_(OPTIONS.yesNo, care.hasVet) + extra_(care.vetInfo));
    addLine_(body, "近 14 天健康", markOpts_(OPTIONS.health14, care.health14));
    addLine_(body, "疾病紀錄", markOpts_(OPTIONS.diseases, care.diseases) + extra_(care.diseaseOther));
    addLine_(body, "驅蟲", markOpts_(OPTIONS.deworm, care.deworm) + extra_(care.dewormOther));
    addLine_(body, "滴劑／口服藥", markOpts_(OPTIONS.preventative, care.preventative) + extra_(care.preventativeOther));
    addLine_(body, "備註", care.notes);
  });
  body.appendParagraph("電子簽署").setHeading(DocumentApp.ParagraphHeading.HEADING2);
  addLine_(body, "同意電子簽署", payload.agreedToTerms ? "是" : "否");
  addLine_(body, "簽署時間", prettyTime_(payload.agreedAt) || tzNow);
  if (signBlob) {
    try {
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
  var pdfBlob = docFile.getAs(MimeType.PDF).setName(caseId + "_NicoPark入園資料.pdf");
  docFile.setTrashed(true);
  return pdfBlob;
}

var OPTIONS = {
  gender: ["男生", "女生"],
  yesNo: ["是", "否"],
  sociability: ["親狗親人", "親狗不親人", "親人不親狗", "皆不親"],
  guarding: ["有護食、護玩具", "突然被觸碰敏感部位會低吼", "無此狀況", "其他"],
  leash: ["乖巧隨行", "會微微拉緊", "看到人車或貓狗會激動暴衝"],
  health14: ["咳嗽", "嘔吐", "腹瀉", "食慾不佳", "精神不佳", "發燒", "皮膚紅疹", "掉毛異常", "黴菌／皮膚病疑慮", "跳蚤／壁蝨", "傷口", "術後恢復中", "以上皆無"],
  diseases: ["心臟病", "氣管塌陷", "癲癇", "關節問題", "呼吸道疾病", "過敏", "皮膚病", "其他疾病", "以上皆無"],
  deworm: ["半年內", "一年", "不太確定", "其他"],
  preventative: ["是", "否", "其他"]
};

function selectedMap_(v) {
  var map = {};
  if (Array.isArray(v)) {
    v.forEach(function (x) { if (x) map[String(x)] = true; });
  } else if (v) {
    map[String(v)] = true;
  }
  return map;
}

function markOpts_(items, selected) {
  var map = selectedMap_(selected);
  return (items || []).map(function (label) {
    return (map[label] ? "☑ " : "☐ ") + label;
  }).join("　");
}

function extra_(s) {
  return s ? "（" + s + "）" : "";
}

function prettyTime_(v) {
  if (!v) return "";
  try {
    var d = new Date(v);
    if (!isNaN(d.getTime())) {
      return Utilities.formatDate(d, "Asia/Taipei", "yyyy年MM月dd日 HH:mm:ss");
    }
  } catch (err) {}
  return String(v);
}

function boxHtml_(on) {
  var bg = on ? "#53453A" : "#FFFDF9";
  var fg = on ? "#F8F3EC" : "#FFFDF9";
  var bd = on ? "#53453A" : "#C4B5A5";
  return '<table cellpadding="0" cellspacing="0" style="display:inline;"><tr><td style="width:12px;height:12px;line-height:12px;font-size:9px;text-align:center;border:1.5px solid ' + bd + ";background:" + bg + ";color:" + fg + ';">' + (on ? "✓" : "&nbsp;") + "</td></tr></table>";
}

function optionCell_(label, on) {
  var color = on ? "#3F332B" : "#8A7B6C";
  var weight = on ? "700" : "400";
  return '<td style="width:50%;padding:5px 8px 5px 0;font-size:11.5px;line-height:1.45;color:' + color + ";font-weight:" + weight + ';">' + boxHtml_(on) + "&nbsp;" + esc_(label) + "</td>";
}

function optionTable_(items, selected) {
  var map = selectedMap_(selected);
  var html = '<table width="100%" cellpadding="0" cellspacing="0">';
  for (var i = 0; i < items.length; i += 2) {
    html += "<tr>" + optionCell_(items[i], !!map[items[i]]);
    if (items[i + 1]) html += optionCell_(items[i + 1], !!map[items[i + 1]]);
    else html += "<td></td>";
    html += "</tr>";
  }
  return html + "</table>";
}

function kv_(label, value) {
  return '<tr><td style="width:26%;padding:8px 10px;background:#F4EBE1;color:#6B5C4F;font-size:11px;border-bottom:1px solid #E7D9CC;">' + esc_(label) + '</td><td style="padding:8px 10px;font-size:12px;color:#3F332B;border-bottom:1px solid #E7D9CC;">' + esc_(value == null || value === "" ? "—" : value) + "</td></tr>";
}

function section_(title) {
  return '<tr><td colspan="2" style="padding:12px 10px 8px;background:#53453A;color:#F8F3EC;font-size:13px;letter-spacing:0.08em;font-weight:700;">' + esc_(title) + "</td></tr>";
}

function subhead_(title) {
  return '<p style="margin:14px 0 6px;font-size:12px;font-weight:700;color:#53453A;letter-spacing:0.06em;">' + esc_(title) + "</p>";
}

function noteHtml_(text) {
  if (!text) return "";
  return '<p style="margin:6px 0 0;font-size:11px;color:#6B5C4F;">補充說明：' + esc_(text) + "</p>";
}

function blobToDataUrl_(blob) {
  if (!blob) return "";
  try {
    return "data:" + (blob.getContentType() || "image/png") + ";base64," + Utilities.base64Encode(blob.getBytes());
  } catch (err) {
    return "";
  }
}

function buildPdfHtml_(caseId, tzNow, owner, list, payload, signBlob) {
  owner = owner || {};
  list = list || [];
  var signSrc = blobToDataUrl_(signBlob);
  var html = "";
  html += '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>' + esc_(caseId) + "</title></head>";
  html += '<body style="margin:0;padding:0;background:#F3EBE2;color:#3F332B;font-family:\'Noto Sans TC\',PingFang TC,Microsoft JhengHei,sans-serif;">';
  html += '<table width="100%" cellpadding="0" cellspacing="0" style="background:#F3EBE2;"><tr><td style="padding:20px 16px;">';
  html += '<table width="640" align="center" cellpadding="0" cellspacing="0" style="background:#FFF8F1;border:1px solid #E7D9CC;">';

  html += '<tr><td style="padding:22px 22px 16px;background:linear-gradient(180deg,#FFFDF9,#F8F3EC);border-bottom:1px solid #E7D9CC;">';
  html += '<p style="margin:0;font-size:11px;letter-spacing:0.22em;color:#AC9D8D;font-weight:700;">NICOPARK</p>';
  html += '<p style="margin:4px 0 0;font-size:20px;font-weight:700;color:#3F332B;">Nico Nico Pet House</p>';
  html += '<p style="margin:2px 0 0;font-size:13px;color:#6B5C4F;">尼口尼口寵物精緻美容旅館　毛孩入園資料與電子簽署</p>';
  html += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;"><tr>';
  html += '<td style="padding:8px 10px;background:#F4EBE1;font-size:12px;">案件識別碼　<strong>' + esc_(caseId) + "</strong></td>";
  html += '<td style="padding:8px 10px;background:#F4EBE1;font-size:12px;text-align:right;">送出時間　' + esc_(tzNow) + "</td>";
  html += "</tr></table></td></tr>";

  html += '<tr><td style="padding:8px 18px 22px;">';
  html += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;border:1px solid #E7D9CC;">';
  html += section_("一、飼主資料");
  html += kv_("飼主名稱", owner.name);
  html += kv_("聯絡電話", owner.phone);
  html += kv_("電子信箱", owner.email);
  html += kv_("LINE 名稱", owner.lineName);
  html += kv_("緊急聯絡人", owner.emergencyName);
  html += kv_("緊急聯絡人電話", owner.emergencyPhone);
  html += "</table>";

  (list || []).forEach(function (item, i) {
    var pet = item.pet || {};
    var care = item.care || pet;
    var title = "二、毛寶 " + (i + 1) + (pet.name ? "　" + pet.name : "");
    html += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;border:1px solid #E7D9CC;">';
    html += section_(title);
    html += kv_("毛寶名字", pet.name);
    html += kv_("品種", pet.breed);
    html += kv_("年齡", pet.age);
    html += kv_("體重", pet.weightKg ? pet.weightKg + " 公斤" : "");
    html += "</table>";
    html += subhead_("性別");
    html += optionTable_(OPTIONS.gender, pet.gender);
    html += subhead_("是否結紮");
    html += optionTable_(OPTIONS.yesNo, pet.neutered);
    html += subhead_("是否處於發情階段");
    html += optionTable_(OPTIONS.yesNo, pet.inHeat);
    html += subhead_("親狗親人");
    html += optionTable_(OPTIONS.sociability, care.sociability);
    html += subhead_("是否有護食、護玩具或碰觸敏感部位低吼經驗");
    html += optionTable_(OPTIONS.guarding, care.guarding);
    html += noteHtml_(care.guardingOther);
    html += subhead_("平時散步時牽繩狀況");
    html += optionTable_(OPTIONS.leash, care.leash);
    html += subhead_("是否有固定獸醫院");
    html += optionTable_(OPTIONS.yesNo, care.hasVet);
    html += noteHtml_(care.hasVet === "是" ? care.vetInfo : "");
    html += subhead_("近 14 天健康狀況（含未勾選）");
    html += optionTable_(OPTIONS.health14, care.health14);
    html += subhead_("是否曾被獸醫診斷疾病（含未勾選）");
    html += optionTable_(OPTIONS.diseases, care.diseases);
    html += noteHtml_(care.diseaseOther);
    html += subhead_("最近一次體內外驅蟲時間");
    html += optionTable_(OPTIONS.deworm, care.deworm);
    html += noteHtml_(care.dewormOther);
    html += subhead_("是否固定施用滴劑或口服藥");
    html += optionTable_(OPTIONS.preventative, care.preventative);
    html += noteHtml_(care.preventativeOther);
    html += subhead_("注意事項／備註");
    html += '<p style="margin:0;padding:8px 10px;background:#F8F3EC;border:1px solid #E7D9CC;font-size:12px;min-height:36px;">' + esc_(care.notes || "（無）") + "</p>";
  });

  html += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;border:1px solid #E7D9CC;">';
  html += section_("三、電子簽署");
  html += kv_("同意以電子文件與手寫電子簽章完成簽署", payload.agreedToTerms ? "是" : "否");
  html += kv_("簽署時間", prettyTime_(payload.agreedAt) || tzNow);
  html += "</table>";
  html += '<p style="margin:14px 0 6px;font-size:12px;font-weight:700;color:#53453A;">手寫簽名</p>';
  html += '<div style="padding:10px;background:#FFFDF9;border:1px dashed #C4B5A5;text-align:center;">';
  if (signSrc) {
    html += '<img src="' + signSrc + '" alt="手寫簽名" width="360" style="max-width:360px;height:auto;">';
  } else {
    html += '<p style="color:#8A7B6C;font-size:12px;">（無簽名圖）</p>';
  }
  html += "</div>";
  html += '<p style="margin:16px 0 0;font-size:10px;color:#8A7B6C;line-height:1.6;">本文件為 NicoPark 入園資料電子正本，已列出全部表單選項（含未勾選項目）。勾選／填寫項目以深色方塊標示。Nico Nico Pet House 尼口尼口寵物精緻美容旅館</p>';
  html += "</td></tr></table></td></tr></table></body></html>";
  return html;
}

function sendCustomerMail_(owner, names, caseId, pdfFile) {
  var to = String(owner.email || "");
  if (!to) return;
  var petLabel = (names && names.length) ? names.join("、") : "毛寶";
  var pdfBlob = pdfFile.getBlob().setName(caseId + "_NicoPark入園資料.pdf");
  MailApp.sendEmail({
    to: to,
    subject: "【" + CONFIG.BUSINESS_NAME + "】入園資料已受理（" + caseId + "）",
    name: "Nico Nico Pet House",
    htmlBody:
      '<div style="font-family:\'Noto Sans TC\',PingFang TC,Microsoft JhengHei,sans-serif;color:#3F332B;line-height:1.7;">' +
      "<p>" + esc_(owner.name) + " 您好，</p>" +
      "<p>我們已收到毛寶 <strong>" + esc_(petLabel) + "</strong> 的 NicoPark 入園資料與電子簽署。</p>" +
      "<p>案件識別碼：<strong>" + esc_(caseId) + "</strong></p>" +
      "<p>完整入園表單（含全部選項、未勾項目與手寫簽名）請見本信 <strong>PDF 附件</strong>，請勿只看縮圖。</p>" +
      "<p style=\"font-size:13px;color:#6B5C4F;\">之後也可在網站以手機驗證碼查詢案件與下載副本。</p>" +
      "<p>Nico Nico Pet House 尼口尼口寵物精緻美容旅館</p></div>",
    attachments: [pdfBlob]
  });
}

function sendBusinessMail_(owner, names, caseId, pdfFile, folderUrl) {
  var petLabel = (names && names.length) ? names.join("、") : "";
  MailApp.sendEmail({
    to: CONFIG.BUSINESS_EMAIL,
    subject: "【新入園】" + caseId + " " + petLabel + "／" + (owner.name || ""),
    name: "NicoPark",
    htmlBody:
      "<p>新的入園資料已寫入試算表並存雲端。</p>" +
      "<p>案件：" + esc_(caseId) + "<br>飼主：" + esc_(owner.name) + " " + esc_(owner.phone) +
      "<br>毛寶：" + esc_(petLabel) + "</p>" +
      "<p><a href=\"" + folderUrl + "\">開啟雲端資料夾</a></p>",
    attachments: [pdfFile.getBlob().setName(caseId + "_NicoPark入園資料.pdf")]
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
