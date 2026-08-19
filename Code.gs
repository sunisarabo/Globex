/*************************************************************
 * ระบบลงเวลา–เข้าออกงาน + OT (PSA-HKT / Globex)  — Prototype
 * ลายเซ็นอิเล็กทรอนิกส์แบบ "ล็อกอินยืนยัน" (Google org account)
 *
 * โครงสร้าง: Apps Script Web App + Google Sheets เป็นฐานข้อมูล
 * หน้า: (1) เช็คอิน/เอาต์+OT  (2) อนุมัติของ Supervisor  (3) export PDF
 *************************************************************/

const CFG = {
  // เว้นว่างไว้ = ใช้ Spreadsheet ที่ผูกกับสคริปต์ (หรือระบบจะสร้างไฟล์ใหม่ให้ครั้งแรก)
  SHEET_ID: '',
  TZ: 'Asia/Bangkok',
  TITLE: 'ระบบลงเวลา–OT · ฝ่ายการโดยสาร ท่าอากาศยานภูเก็ต (PSA-HKT)',
  ORG: 'บริษัท โกลเบกซ์ ไทย จำกัด · ว่าจ้างโดย AOTGA',
  // อีเมลที่มีสิทธิ์อนุมัติ (Supervisor / ผู้ตรวจรับ) — ลายเซ็นผูกกับอีเมลเหล่านี้
  SUPERVISORS: ['supervisor@your-domain.com', 'admin.psa@your-domain.com'],
  PDF_FOLDER_ID: '',            // Drive folder สำหรับเก็บ PDF (เว้นว่าง = My Drive ราก)
  NORMAL_HOURS: 8,              // ชั่วโมงทำงานปกติต่อกะ
  LEAVE_TYPES: { AL:'ลาพักร้อน', SL:'ลาป่วย', BL:'ลากิจ' },
  RATES: { ot15: 112.50, ot1: 75.00, ot3: 225.00 }
};

const SH = { LOG: 'TimeLog', EMP: 'Employees', HOL: 'Holidays' };
const LOG_HEADERS = ['id','date','empId','empName','team','timeIn','timeOut',
  'breakH','workedH','otStart','otEnd','ot15','ot1','ot3','dayType',
  'status','approvedBy','approvedAt','note','leaveType'];

/* ---------------------- Web routing ---------------------- */
function doGet(e) {
  ensureSheets();
  const page = (e && e.parameter && e.parameter.page) || 'checkin';
  const file = (page === 'supervisor') ? 'Supervisor' : 'Index';
  const t = HtmlService.createTemplateFromFile(file);
  t.user  = getUserEmail();
  t.isSup = isSupervisor();
  return t.evaluate()
    .setTitle(CFG.TITLE)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
function include(name){ return HtmlService.createHtmlOutputFromFile(name).getContent(); }

/* ---------------------- Helpers ---------------------- */
function ss_() {
  if (CFG.SHEET_ID) return SpreadsheetApp.openById(CFG.SHEET_ID);
  const bound = SpreadsheetApp.getActiveSpreadsheet();
  if (bound) return bound;
  // ครั้งแรก: สร้างไฟล์ใหม่ แล้วจำ id ไว้ใน Script Properties
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('SHEET_ID');
  if (!id) {
    const created = SpreadsheetApp.create('TimeClock-PSA-HKT (DB)');
    id = created.getId();
    props.setProperty('SHEET_ID', id);
  }
  return SpreadsheetApp.openById(id);
}
function sheet_(name){ return ss_().getSheetByName(name); }
function getUserEmail(){ try { return Session.getActiveUser().getEmail() || ''; } catch(e){ return ''; } }
function isSupervisor(){ return CFG.SUPERVISORS.map(s=>s.toLowerCase()).indexOf(getUserEmail().toLowerCase()) >= 0; }
function todayStr(){ return Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd'); }
function nowStr(){ return Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd HH:mm:ss'); }
function fmtTime(d){ return d ? Utilities.formatDate(new Date(d), CFG.TZ, 'HH:mm') : ''; }
function round2(n){ return Math.round((Number(n)+Number.EPSILON)*100)/100; }
function uid(){ return Utilities.getUuid().slice(0,8); }

function ensureSheets(){
  const s = ss_();
  if (!s.getSheetByName(SH.LOG)) {
    const sh = s.insertSheet(SH.LOG);
    sh.getRange(1,1,1,LOG_HEADERS.length).setValues([LOG_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  if (!s.getSheetByName(SH.EMP)) {
    const sh = s.insertSheet(SH.EMP);
    sh.getRange(1,1,1,3).setValues([['empId','empName','team']]).setFontWeight('bold');
    const mock = mockEmployees_();
    sh.getRange(2,1,mock.length,3).setValues(mock);
  }
  if (!s.getSheetByName(SH.HOL)) {
    const sh = s.insertSheet(SH.HOL);
    sh.getRange(1,1,1,2).setValues([['date (yyyy-MM-dd)','name']]).setFontWeight('bold');
  }
  // ลบชีต Sheet1 เปล่า ถ้ามี
  const def = s.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0 && s.getSheets().length > 1) s.deleteSheet(def);
}

// Mock 80 รายชื่อสำหรับทดสอบ — แทนที่ด้วยรายชื่อจริงในชีต Employees ได้เลย
function mockEmployees_(){
  const F = ['สมชาย','สมศรี','อนันต์','กมลชนก','ณัฐพล','ศิริพร','วิชัย','ปรีชา','สุนิสา','จิราพร',
             'ธนพล','อรทัย','ประวิทย์','มณีรัตน์','เกียรติศักดิ์','พิมพ์ชนก','ชัยวัฒน์','รัตนา','ศุภกร','วราภรณ์'];
  const L = ['ใจดี','ศรีสุข','แก้วมณี','ทองดี','บุญมา','พรหมมา','สุขสันต์','จันทร์เพ็ญ','วงศ์สวัสดิ์','รักษาดี',
             'คงคาเขต','อินทร์แก้ว','พลอยใส','นาคะวงศ์','ชูชื่น','บัวทอง','มั่นคง','สายทอง','เพชรรัตน์','อ่อนหวาน'];
  const TEAMS = ['Qanot Sharq','Red Wings','SCAT Airlines','LOT Polish','Azur Air',
                 'GullivAir','HiSky','Neos','S7 Airlines'];
  const out = [];
  for (let i = 0; i < 80; i++){
    const id = 'PSA' + ('00' + (i+1)).slice(-3);
    const name = F[i % 20] + ' ' + L[(i + Math.floor(i/20)*7) % 20];
    out.push([id, name, TEAMS[i % TEAMS.length]]);
  }
  return out;
}

/* ---------------------- OT classification ----------------------
 * แยกประเภทตามโครงสร้างค่าบริการ Globex:
 *   วันทำงาน  → OT ทั้งหมดเป็น OT×1.5 (112.50)
 *   วันหยุด    → ชั่วโมงทำงานปกติ (≤8) เป็น OT×1 (75) ; ช่วง OT เป็น OT×3 (225)
 * แก้เกณฑ์ได้ที่นี่จุดเดียว
 */
function isHoliday(dateStr){
  const sh = sheet_(SH.HOL);
  if (!sh || sh.getLastRow() < 2) return false;
  const vals = sh.getRange(2,1,sh.getLastRow()-1,1).getValues().map(r=>String(r[0]).slice(0,10));
  return vals.indexOf(dateStr) >= 0;
}
function hoursFromHHmm(start, end){
  if (!start || !end) return 0;
  const a = start.split(':').map(Number), b = end.split(':').map(Number);
  let mins = (b[0]*60+b[1]) - (a[0]*60+a[1]);
  if (mins < 0) mins += 24*60;      // ข้ามเที่ยงคืน
  return mins/60;
}
function computeOT(dateStr, workedH, otStart, otEnd){
  const otH = hoursFromHHmm(otStart, otEnd);
  const holiday = isHoliday(dateStr);
  let ot15=0, ot1=0, ot3=0;
  if (holiday){
    ot1 = Math.min(Math.max(workedH,0), CFG.NORMAL_HOURS);
    ot3 = otH;
  } else {
    ot15 = otH;
  }
  return { ot15:round2(ot15), ot1:round2(ot1), ot3:round2(ot3),
           dayType: holiday ? 'วันหยุด' : 'วันทำงาน' };
}

/* ---------------------- Employee: check-in / out / OT ---------------------- */
function apiGetEmployees(){
  const sh = sheet_(SH.EMP);
  if (!sh || sh.getLastRow()<2) return [];
  return sh.getRange(2,1,sh.getLastRow()-1,3).getValues()
    .filter(r=>r[0])
    .map(r=>({ empId:String(r[0]), empName:String(r[1]), team:String(r[2]||'') }));
}
function findTodayRow_(empId){
  const sh = sheet_(SH.LOG);
  const last = sh.getLastRow();
  if (last < 2) return null;
  const data = sh.getRange(2,1,last-1,LOG_HEADERS.length).getValues();
  const d = todayStr();
  for (let i=data.length-1; i>=0; i--){
    if (String(data[i][2])===String(empId) && String(data[i][1]).slice(0,10)===d){
      return { rowIndex: i+2, row: data[i] };
    }
  }
  return null;
}
function rowToObj_(row){
  const o = {}; LOG_HEADERS.forEach((h,i)=>o[h]=row[i]); return o;
}
function apiGetStatus(empId){
  if (!empId) return { state:'none' };
  const found = findTodayRow_(empId);
  if (!found) return { state:'none' };
  const o = rowToObj_(found.row);
  return {
    state: o.status,           // open / closed / approved
    timeIn: fmtTime(o.timeIn), timeOut: fmtTime(o.timeOut),
    otStart:o.otStart, otEnd:o.otEnd,
    ot15:o.ot15, ot1:o.ot1, ot3:o.ot3, dayType:o.dayType,
    approvedBy:o.approvedBy, approvedAt:o.approvedAt, leaveType:o.leaveType||''
  };
}
function apiCheckIn(empId){
  const emp = apiGetEmployees().filter(e=>e.empId===String(empId))[0];
  if (!emp) throw new Error('ไม่พบรหัสพนักงาน ' + empId + ' ในทะเบียน');
  const dup = findTodayRow_(empId);
  if (dup){
    const lv = String(dup.row[LOG_HEADERS.indexOf('leaveType')]||'');
    throw new Error(lv ? 'วันนี้แจ้งลา ('+lv+') ไว้แล้ว — ยกเลิกกับ Supervisor ก่อนจึงลงเวลาได้'
                       : 'พนักงานคนนี้ลงเวลาเข้าของวันนี้แล้ว');
  }
  const sh = sheet_(SH.LOG);
  const now = new Date();
  const rec = {
    id:uid(), date:todayStr(), empId:emp.empId, empName:emp.empName, team:emp.team,
    timeIn:now, timeOut:'', breakH:1, workedH:'', otStart:'', otEnd:'',
    ot15:0, ot1:0, ot3:0, dayType: isHoliday(todayStr())?'วันหยุด':'วันทำงาน',
    status:'open', approvedBy:'', approvedAt:'', note:'', leaveType:''
  };
  sh.appendRow(LOG_HEADERS.map(h=>rec[h]));
  return apiGetStatus(empId);
}
function apiCheckOut(empId, breakH){
  const found = findTodayRow_(empId);
  if (!found) throw new Error('ยังไม่ได้ลงเวลาเข้า');
  const o = rowToObj_(found.row);
  if (o.status==='approved') throw new Error('รายการนี้อนุมัติแล้ว แก้ไขไม่ได้');
  const now = new Date();
  const brk = Number(breakH||o.breakH||0);
  const worked = round2((now.getTime() - new Date(o.timeIn).getTime())/3600000 - brk);
  const sh = sheet_(SH.LOG); const r = found.rowIndex;
  const ot = computeOT(o.date, worked, o.otStart, o.otEnd);
  setCell_(sh,r,'timeOut',now); setCell_(sh,r,'breakH',brk);
  setCell_(sh,r,'workedH',worked); setCell_(sh,r,'status','closed');
  setCell_(sh,r,'ot15',ot.ot15); setCell_(sh,r,'ot1',ot.ot1); setCell_(sh,r,'ot3',ot.ot3);
  setCell_(sh,r,'dayType',ot.dayType);
  return apiGetStatus(empId);
}
function apiSubmitOT(empId, otStart, otEnd, note){
  const found = findTodayRow_(empId);
  if (!found) throw new Error('ยังไม่ได้ลงเวลาเข้า');
  const o = rowToObj_(found.row);
  if (o.status==='approved') throw new Error('รายการนี้อนุมัติแล้ว แก้ไขไม่ได้');
  const worked = Number(o.workedH||0);
  const ot = computeOT(o.date, worked, otStart, otEnd);
  const sh = sheet_(SH.LOG); const r = found.rowIndex;
  setCell_(sh,r,'otStart',otStart); setCell_(sh,r,'otEnd',otEnd);
  setCell_(sh,r,'ot15',ot.ot15); setCell_(sh,r,'ot1',ot.ot1); setCell_(sh,r,'ot3',ot.ot3);
  setCell_(sh,r,'dayType',ot.dayType);
  if (note!=null) setCell_(sh,r,'note',note);
  return apiGetStatus(empId);
}
// แจ้งลา — สร้างรายการสถานะ closed (รอ Supervisor อนุมัติเป็นลายเซ็นเดียวกับลงเวลา)
function apiSubmitLeave(empId, leaveType, note){
  const emp = apiGetEmployees().filter(e=>e.empId===String(empId))[0];
  if (!emp) throw new Error('ไม่พบรหัสพนักงาน ' + empId + ' ในทะเบียน');
  const t = String(leaveType||'').toUpperCase();
  if (!CFG.LEAVE_TYPES[t]) throw new Error('ประเภทการลาไม่ถูกต้อง (AL/SL/BL)');
  const dup = findTodayRow_(empId);
  if (dup){
    const lv = String(dup.row[LOG_HEADERS.indexOf('leaveType')]||'');
    throw new Error(lv ? 'วันนี้แจ้งลาไว้แล้ว ('+lv+')' : 'วันนี้มีรายการลงเวลาแล้ว — แจ้งลาไม่ได้');
  }
  const sh = sheet_(SH.LOG);
  const rec = {
    id:uid(), date:todayStr(), empId:emp.empId, empName:emp.empName, team:emp.team,
    timeIn:'', timeOut:'', breakH:0, workedH:0, otStart:'', otEnd:'',
    ot15:0, ot1:0, ot3:0, dayType:'ลา '+t+' ('+CFG.LEAVE_TYPES[t]+')',
    status:'closed', approvedBy:'', approvedAt:'', note:String(note||''), leaveType:t
  };
  sh.appendRow(LOG_HEADERS.map(h=>rec[h]));
  return apiGetStatus(empId);
}

function setCell_(sh,row,field,val){ sh.getRange(row, LOG_HEADERS.indexOf(field)+1).setValue(val); }

/* ---------------------- Supervisor: approve (e-signature) ---------------------- */
function apiListForApproval(dateStr){
  const sh = sheet_(SH.LOG); const last = sh.getLastRow();
  if (last<2) return [];
  const d = dateStr || todayStr();
  const data = sh.getRange(2,1,last-1,LOG_HEADERS.length).getValues();
  const out = [];
  data.forEach((row,i)=>{
    const o = rowToObj_(row);
    if (String(o.date).slice(0,10)!==d) return;
    out.push({
      rowIndex:i+2, id:o.id, empId:o.empId, empName:o.empName, team:o.team,
      timeIn:fmtTime(o.timeIn), timeOut:fmtTime(o.timeOut), workedH:o.workedH,
      otStart:o.otStart, otEnd:o.otEnd, ot15:o.ot15, ot1:o.ot1, ot3:o.ot3,
      dayType:o.dayType, status:o.status, approvedBy:o.approvedBy, approvedAt:o.approvedAt,
      leaveType:o.leaveType||''
    });
  });
  return out;
}
function apiApprove(rowIndex){
  if (!isSupervisor()) throw new Error('บัญชีนี้ไม่มีสิทธิ์อนุมัติ (' + (getUserEmail()||'ไม่พบอีเมล') + ')');
  const sh = sheet_(SH.LOG);
  const o = rowToObj_(sh.getRange(rowIndex,1,1,LOG_HEADERS.length).getValues()[0]);
  if (o.status==='open') throw new Error('พนักงานยังไม่ได้ลงเวลาออก');
  if (o.status==='approved') throw new Error('อนุมัติไปแล้วโดย ' + o.approvedBy);
  // ==== ลายเซ็นอิเล็กทรอนิกส์ = อีเมลที่ล็อกอิน + เวลาเซิร์ฟเวอร์ (แก้ย้อนหลังไม่ได้) ====
  setCell_(sh,rowIndex,'status','approved');
  setCell_(sh,rowIndex,'approvedBy',getUserEmail());
  setCell_(sh,rowIndex,'approvedAt',nowStr());
  return { ok:true, approvedBy:getUserEmail(), approvedAt:nowStr() };
}
function apiUnapprove(rowIndex){
  if (!isSupervisor()) throw new Error('ไม่มีสิทธิ์');
  const sh = sheet_(SH.LOG);
  setCell_(sh,rowIndex,'status','closed');
  setCell_(sh,rowIndex,'approvedBy',''); setCell_(sh,rowIndex,'approvedAt','');
  return { ok:true };
}

/* ---------------------- Export PDF ---------------------- */
function apiExportPdf(dateStr){
  if (!isSupervisor()) throw new Error('เฉพาะผู้มีสิทธิ์อนุมัติจึงออก PDF ได้');
  const d = dateStr || todayStr();
  const rows = apiListForApproval(d);
  const html = buildReportHtml_(d, rows);
  const pdf = Utilities.newBlob(html, 'text/html', 'r.html')
    .getAs('application/pdf')
    .setName('TimeOT_' + d + '.pdf');
  const folder = CFG.PDF_FOLDER_ID ? DriveApp.getFolderById(CFG.PDF_FOLDER_ID) : DriveApp.getRootFolder();
  const file = folder.createFile(pdf);
  file.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW);
  return { url: file.getUrl(), name: file.getName() };
}
function buildReportHtml_(d, rows){
  const money = v => (Number(v)||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  let sum15=0,sum1=0,sum3=0, body='';
  rows.forEach((r,i)=>{
    sum15+=Number(r.ot15||0); sum1+=Number(r.ot1||0); sum3+=Number(r.ot3||0);
    const sig = r.status==='approved'
      ? '✔ ' + r.approvedBy + '<br><span class="s">' + r.approvedAt + '</span>'
      : '<span class="p">รออนุมัติ</span>';
    body += '<tr><td class="c">'+(i+1)+'</td><td>'+r.empId+'</td><td>'+r.empName+'</td>'+
      '<td class="c">'+(r.timeIn||'-')+'</td><td class="c">'+(r.timeOut||'-')+'</td>'+
      '<td class="c">'+(r.dayType||'')+'</td>'+
      '<td class="r">'+(r.ot15||0)+'</td><td class="r">'+(r.ot1||0)+'</td><td class="r">'+(r.ot3||0)+'</td>'+
      '<td class="sig">'+sig+'</td></tr>';
  });
  const costs = round2(sum15*CFG.RATES.ot15 + sum1*CFG.RATES.ot1 + sum3*CFG.RATES.ot3);
  return '<html><head><meta charset="utf-8"><style>'+
    'body{font-family:"TH Sarabun New",Sarabun,sans-serif;font-size:13px;color:#222;margin:24px}'+
    'h1{font-size:18px;margin:0;color:#1F3864}h2{font-size:14px;margin:2px 0 12px;color:#2E5496}'+
    'table{width:100%;border-collapse:collapse;margin-top:8px}'+
    'th,td{border:1px solid #888;padding:4px 6px}th{background:#2E5496;color:#fff;font-size:12px}'+
    '.c{text-align:center}.r{text-align:right}.sig{font-size:11px}.s{color:#666;font-size:10px}.p{color:#c00}'+
    'tfoot td{font-weight:bold;background:#F2F2F2}'+
    '.foot{margin-top:16px;font-size:11px;color:#555}</style></head><body>'+
    '<h1>รายงานลงเวลา–OT ประจำวัน</h1>'+
    '<h2>'+CFG.ORG+' · ตำแหน่ง Passenger Service Agent · วันที่ '+d+'</h2>'+
    '<table><thead><tr><th>#</th><th>รหัส</th><th>ชื่อ-สกุล</th><th>เข้า</th><th>ออก</th>'+
    '<th>ประเภทวัน</th><th>OT×1.5</th><th>OT×1</th><th>OT×3</th><th>ลายเซ็นอนุมัติ (อิเล็กทรอนิกส์)</th></tr></thead>'+
    '<tbody>'+ (body || '<tr><td colspan="10" class="c">— ไม่มีรายการ —</td></tr>') +'</tbody>'+
    '<tfoot><tr><td colspan="6" class="r">รวมชั่วโมง OT</td>'+
    '<td class="r">'+sum15+'</td><td class="r">'+sum1+'</td><td class="r">'+sum3+'</td>'+
    '<td class="r">รวมค่า OT: '+money(costs)+' บาท</td></tr></tfoot></table>'+
    '<div class="foot">อัตรา: OT×1.5='+CFG.RATES.ot15+' · OT×1='+CFG.RATES.ot1+' · OT×3='+CFG.RATES.ot3+' บาท/ชม.<br>'+
    'ออกเอกสารโดยระบบเมื่อ '+nowStr()+' · ผู้สั่งพิมพ์: '+getUserEmail()+'<br>'+
    'ลายเซ็นอิเล็กทรอนิกส์ยืนยันด้วยการล็อกอินบัญชีองค์กร ตาม พ.ร.บ. ว่าด้วยธุรกรรมทางอิเล็กทรอนิกส์ พ.ศ. 2544</div>'+
    '</body></html>';
}
