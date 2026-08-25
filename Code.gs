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
  // Geofence จุดลงเวลา — ค่าตั้งต้น = ท่าอากาศยานภูเก็ต (แก้พิกัด/รัศมีได้)
  GEO: {
    ENABLED: true,
    LAT: 8.10520, LNG: 98.30710, // จุดลงเวลาจริงหน้าอาคาร (จากประวัติแอปเดิม)
    RADIUS_M: 1000,              // รัศมีที่ถือว่า "ในพื้นที่" (เมตร)
    BLOCK: false                 // true = ห้ามลงเวลานอกพื้นที่/ไม่มีพิกัด · false = บันทึกและติดธงเฉย ๆ
  },
  PUNCH_GAP_MIN: 5,              // เช็คเอาท์ได้หลังเช็คอินอย่างน้อยกี่นาที (กันกดติดกัน)
  RATES: { ot15: 112.50, ot1: 75.00, ot3: 225.00 }
};

const SH = { LOG: 'TimeLog', EMP: 'Employees', HOL: 'Holidays', SHIFT: 'Shifts', ROSTER: 'Roster' };
const LOG_HEADERS = ['id','date','empId','empName','team','timeIn','timeOut',
  'breakH','workedH','otStart','otEnd','ot15','ot1','ot3','dayType',
  'status','approvedBy','approvedAt','note','leaveType','inLoc','outLoc','shiftCode','lateMin'];

// พจนานุกรมโค้ดกะมาตรฐาน AOTGA (336 โค้ด: [เข้า,ออก,ชั่วโมง]) + โค้ดพิเศษ — seed ลงชีต Shifts ครั้งแรก
const SHIFT_DICT = {"A10":["01:00","11:00",10],"A11":["01:00","12:00",11],"A12":["01:00","13:00",12],"A4":["01:00","05:00",4],"A5":["01:00","06:00",5],"A6":["01:00","07:00",6],"A7":["01:00","08:00",7],"A8":["01:00","09:00",8],"A9":["01:00","10:00",9],"AA1":["01:30","12:30",11],"AA2":["01:30","13:30",12],"AA9":["01:30","10:30",9],"AAO":["01:30","11:30",10],"B10":["02:00","12:00",10],"B11":["02:00","13:00",11],"B12":["02:00","14:00",12],"B4":["02:00","06:00",4],"B5":["02:00","07:00",5],"B6":["02:00","08:00",6],"B7":["02:00","09:00",7],"B8":["02:00","10:00",8],"B9":["02:00","11:00",9],"BB1":["02:30","13:30",11],"BB2":["02:30","14:30",12],"BB9":["02:30","11:30",9],"BBO":["02:30","12:30",10],"C10":["03:00","13:00",10],"C11":["03:00","14:00",11],"C12":["03:00","15:00",12],"C4":["03:00","07:00",4],"C5":["03:00","08:00",5],"C6":["03:00","09:00",6],"C7":["03:00","10:00",7],"C8":["03:00","11:00",8],"C9":["03:00","12:00",9],"CC1":["03:30","14:30",11],"CC2":["03:30","15:30",12],"CC9":["03:30","12:30",9],"CCO":["03:30","13:30",10],"D10":["04:00","14:00",10],"D11":["04:00","15:00",11],"D12":["04:00","16:00",12],"D4":["04:00","08:00",4],"D5":["04:00","09:00",5],"D6":["04:00","10:00",6],"D7":["04:00","11:00",7],"D8":["04:00","12:00",8],"D9":["04:00","13:00",9],"DD1":["04:30","15:30",11],"DD2":["04:30","16:30",12],"DD5":["04:30","09:30",5],"DD6":["04:30","10:30",6],"DD8":["04:30","12:30",8],"DD9":["04:30","13:30",9],"DDO":["04:30","14:30",10],"E10":["05:00","15:00",10],"E11":["05:00","16:00",11],"E12":["05:00","17:00",12],"E4":["05:00","09:00",4],"E5":["05:00","10:00",5],"E6":["05:00","11:00",6],"E7":["05:00","12:00",7],"E8":["05:00","13:00",8],"E9":["05:00","14:00",9],"EE1":["05:30","16:30",11],"EE2":["05:30","17:30",12],"EE4":["05:30","09:30",4],"EE6":["05:30","11:30",6],"EE7":["05:30","12:30",7],"EE8":["05:30","13:30",8],"EE9":["05:30","14:30",9],"EEO":["05:30","15:30",10],"EES":["05:30","10:30",5],"F10":["06:00","16:00",10],"F11":["06:00","17:00",11],"F12":["06:00","18:00",12],"F4":["06:00","10:00",4],"F5":["06:00","11:00",5],"F6":["06:00","12:00",6],"F7":["06:00","13:00",7],"F8":["06:00","14:00",8],"F9":["06:00","15:00",9],"FF1":["06:30","17:30",11],"FF2":["06:30","18:30",12],"FF6":["06:30","12:30",6],"FF8":["06:30","14:30",8],"FF9":["06:30","15:30",9],"FFO":["06:30","16:30",10],"G10":["07:00","17:00",10],"G11":["07:00","18:00",11],"G12":["07:00","19:00",12],"G4":["07:00","11:00",4],"G5":["07:00","12:00",5],"G6":["07:00","13:00",6],"G7":["07:00","14:00",7],"G8":["07:00","15:00",8],"G9":["07:00","16:00",9],"GG1":["07:30","18:30",11],"GG2":["07:30","19:30",12],"GG6":["07:30","13:30",6],"GG7":["07:30","14:30",7],"GG8":["07:30","15:30",8],"GG9":["07:30","16:30",9],"GGO":["07:30","17:30",10],"H10":["08:00","18:00",10],"H11":["08:00","19:00",11],"H12":["08:00","20:00",12],"H4":["08:00","12:00",4],"H5":["08:00","13:00",5],"H6":["08:00","14:00",6],"H7":["08:00","15:00",7],"H8":["08:00","16:00",8],"H9":["08:00","17:00",9],"HH1":["08:30","19:30",11],"HH2":["08:30","20:30",12],"HH3":["08:30","20:00",11.5],"HH5":["08:30","13:30",5],"HH6":["08:30","14:30",6],"HH7":["08:30","15:30",7],"HH8":["08:30","16:30",8],"HH9":["08:30","17:30",9],"HHO":["08:30","18:30",10],"HQ9":["08:00","17:00",8],"I10":["09:00","19:00",10],"I11":["09:00","20:00",11],"I12":["09:00","21:00",12],"I4":["09:00","13:00",4],"I5":["09:00","14:00",5],"I6":["09:00","15:00",6],"I7":["09:00","16:00",7],"I8":["09:00","17:00",8],"I9":["09:00","18:00",9],"II0":["09:30","19:30",10],"II2":["09:30","21:30",12],"II6":["09:30","20:30",11],"II9":["09:30","18:30",9],"J10":["10:00","20:00",10],"J11":["10:00","21:00",11],"J12":["10:00","22:00",12],"J4":["10:00","14:00",4],"J5":["10:00","15:00",5],"J6":["10:00","16:00",6],"J7":["10:00","17:00",7],"J8":["10:00","18:00",8],"J9":["10:00","19:00",9],"JJ0":["10:30","20:30",10],"JJ1":["10:30","21:30",11],"JJ2":["10:30","22:30",12],"JJ9":["10:30","19:30",9],"K10":["11:00","21:00",10],"K11":["11:00","22:00",11],"K12":["11:00","23:00",12],"K4":["11:00","15:00",4],"K5":["11:00","16:00",5],"K6":["11:00","17:00",6],"K7":["11:00","18:00",7],"K8":["11:00","19:00",8],"K9":["11:00","20:00",9],"KK1":["11:30","22:30",11],"KK2":["11:30","23:30",12],"KK5":["11:30","16:30",5],"KK9":["11:30","20:30",9],"KKO":["11:30","21:30",10],"L10":["12:00","22:00",10],"L11":["12:00","23:00",11],"L12":["12:00","00:00",12],"L4":["12:00","16:00",4],"L5":["12:00","17:00",5],"L6":["12:00","18:00",6],"L7":["12:00","19:00",7],"L8":["12:00","20:00",8],"L9":["12:00","21:00",9],"LL1":["12:30","23:30",11],"LL2":["12:30","00:30",12],"LL9":["12:30","21:30",9],"LLO":["12:30","22:30",10],"M10":["13:00","23:00",10],"M11":["13:00","00:00",11],"M12":["13:00","01:00",12],"M4":["13:00","17:00",4],"M5":["13:00","18:00",5],"M6":["13:00","19:00",6],"M7":["13:00","20:00",7],"M8":["13:00","21:00",8],"M9":["13:00","22:00",9],"MM1":["13:30","00:30",11],"MM2":["13:30","01:30",12],"MM7":["13:30","20:30",7],"MM9":["13:30","22:30",9],"MMO":["13:30","23:30",10],"N10":["14:00","00:00",10],"N11":["14:00","01:00",11],"N12":["14:00","02:00",12],"N4":["14:00","18:00",4],"N5":["14:00","19:00",5],"N6":["14:00","20:00",6],"N7":["14:00","21:00",7],"N8":["14:00","22:00",8],"N9":["14:00","23:00",9],"NN1":["14:30","01:30",11],"NN2":["14:30","02:30",12],"NN8":["14:30","22:30",8],"NN9":["14:30","23:30",9],"NNO":["14:30","00:30",10],"O10":["15:00","01:00",10],"O11":["15:00","02:00",11],"O12":["15:00","03:00",12],"O4":["15:00","19:00",4],"O5":["15:00","20:00",5],"O6":["15:00","21:00",6],"O7":["15:00","22:00",7],"O8":["15:00","23:00",8],"O9":["15:00","00:00",9],"OO1":["15:30","02:30",11],"OO2":["15:30","03:30",12],"OO9":["15:30","00:30",9],"OOO":["15:30","01:30",10],"OPS":["08:00","17:00",8],"P10":["16:00","02:00",10],"P11":["16:00","03:00",11],"P12":["16:00","04:00",12],"P4":["16:00","20:00",4],"P5":["16:00","21:00",5],"P6":["16:00","22:00",6],"P7":["16:00","23:00",7],"P8":["16:00","00:00",8],"P9":["16:00","01:00",9],"PP1":["16:30","03:30",11],"PP2":["16:30","04:30",12],"PP8":["16:30","00:30",8],"PP9":["16:30","01:30",9],"PPO":["16:30","02:30",10],"Q10":["17:00","03:00",10],"Q11":["17:00","04:00",11],"Q12":["17:00","05:00",12],"Q4":["17:00","21:00",4],"Q5":["17:00","22:00",5],"Q6":["17:00","23:00",6],"Q7":["17:00","00:00",7],"Q8":["17:00","01:00",8],"Q9":["17:00","02:00",9],"QQ1":["17:30","04:30",11],"QQ2":["17:30","05:30",12],"QQ9":["17:30","02:30",9],"QQO":["17:30","03:30",10],"R10":["18:00","04:00",10],"R11":["18:00","05:00",10],"R12":["18:00","06:00",12],"R4":["18:00","22:00",4],"R5":["18:00","23:00",5],"R6":["18:00","00:00",6],"R7":["18:00","01:00",7],"R8":["18:00","02:00",8],"R9":["18:00","03:00",9],"RR1":["18:30","05:30",11],"RR2":["18:30","06:30",12],"RR9":["18:30","03:30",9],"RRO":["18:30","04:30",10],"S10":["19:00","05:00",10],"S11":["19:00","06:00",11],"S12":["19:00","07:00",12],"S4":["19:00","23:00",4],"S5":["19:00","00:00",5],"S6":["19:00","01:00",6],"S7":["19:00","02:00",7],"S8":["19:00","03:00",8],"S9":["19:00","04:00",9],"SS1":["19:30","06:30",11],"SS2":["19:30","07:30",12],"SS9":["19:30","04:30",9],"SSO":["19:30","05:30",10],"T10":["20:00","06:00",10],"T11":["20:00","07:00",11],"T12":["20:00","08:00",12],"T4":["20:00","00:00",4],"T5":["20:00","01:00",5],"T6":["20:00","02:00",6],"T7":["20:00","03:00",7],"T8":["20:00","04:00",8],"T9":["20:00","05:00",9],"TT1":["20:30","07:30",11],"TT2":["20:30","08:30",12],"TT9":["20:30","05:30",9],"TTO":["20:30","06:30",10],"U10":["21:00","07:00",10],"U11":["21:00","08:00",11],"U12":["21:00","09:00",12],"U4":["21:00","01:00",4],"U5":["21:00","02:00",5],"U6":["21:00","03:00",6],"U7":["21:00","04:00",7],"U8":["21:00","05:00",8],"U9":["21:00","06:00",9],"UU1":["21:30","08:30",11],"UU2":["21:30","09:30",12],"UU9":["21:30","06:30",9],"UUO":["21:30","07:30",10],"V10":["22:00","08:00",10],"V11":["22:00","09:00",11],"V12":["22:00","10:00",12],"V4":["22:00","02:00",4],"V5":["22:00","03:00",5],"V6":["22:00","04:00",6],"V7":["22:00","05:00",7],"V8":["22:00","06:00",8],"V9":["22:00","07:00",9],"VV1":["22:30","09:30",11],"VV2":["22:30","10:30",12],"VV9":["22:30","07:30",9],"W10":["23:00","09:00",10],"W11":["23:00","10:00",11],"W12":["23:00","11:00",12],"W4":["23:00","03:00",4],"W5":["23:00","04:00",5],"W6":["23:00","05:00",6],"W7":["23:00","06:00",7],"W8":["23:00","07:00",8],"W9":["23:00","08:00",9],"WO":["22:30","08:30",10],"WW1":["23:30","10:30",11],"WW2":["23:30","11:30",12],"WW9":["23:30","08:30",9],"WWO":["23:30","09:30",10],"X10":["00:00","10:00",10],"X11":["00:00","11:00",11],"X12":["00:00","12:00",12],"X4":["00:00","04:00",4],"X5":["00:00","05:00",5],"X6":["00:00","06:00",6],"X7":["00:00","07:00",7],"X8":["00:00","08:00",8],"X9":["00:00","09:00",9],"XX1":["00:30","11:30",11],"XX2":["00:30","12:30",12],"XX9":["00:30","09:30",9],"XXO":["00:30","10:30",10]};
const SHIFT_SPECIAL = {"X":["OFF","Off (Day off)"],"XX":["OT","OT Off"],"SL":["LEAVE","Sick Leave"],"BL":["LEAVE","Personal Leave"],"Vac":["LEAVE","Vacation"],"AL":["LEAVE","Annual Leave"],"SW":["SWAP","Shift Swap"],"TRN":["TRN","Training"]};

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
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('SHEETS_READY') === 'v3') return;   // ทำครั้งเดียว — ตัด latency ทุก doGet
  const s = ss_();
  if (!s.getSheetByName(SH.LOG)) {
    const sh = s.insertSheet(SH.LOG);
    sh.getRange(1,1,1,LOG_HEADERS.length).setValues([LOG_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  } else {
    // เวอร์ชันก่อนมีคอลัมน์น้อยกว่า — เขียนหัวตารางใหม่ (คอลัมน์ใหม่ต่อท้าย ไม่กระทบข้อมูลเดิม)
    s.getSheetByName(SH.LOG).getRange(1,1,1,LOG_HEADERS.length)
      .setValues([LOG_HEADERS]).setFontWeight('bold');
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
  if (!s.getSheetByName(SH.SHIFT)) {
    const sh = s.insertSheet(SH.SHIFT);
    const rows = [['code','timeIn','timeOut','hours','type','label']];
    Object.keys(SHIFT_DICT).forEach(c=>{
      const v = SHIFT_DICT[c];
      rows.push([c, v[0], v[1], v[2], 'WORK', '']);
    });
    Object.keys(SHIFT_SPECIAL).forEach(c=>{
      rows.push([c, '', '', 0, SHIFT_SPECIAL[c][0], SHIFT_SPECIAL[c][1]]);
    });
    sh.getRange(1,1,rows.length,6).setValues(rows);
    sh.getRange(1,1,1,6).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  if (!s.getSheetByName(SH.ROSTER)) {
    const sh = s.insertSheet(SH.ROSTER);
    // แถว = พนักงาน, คอลัมน์ = วันที่ของเดือนปัจจุบัน — ใส่โค้ดกะลงช่อง (เช่น G12, H8, X, 08-17)
    const now = new Date();
    const y = now.getFullYear(), m = now.getMonth();
    const nDays = new Date(y, m+1, 0).getDate();
    const head = ['empId','empName'];
    for (let d=1; d<=nDays; d++) head.push(Utilities.formatDate(new Date(y,m,d), CFG.TZ, 'yyyy-MM-dd'));
    const emps = s.getSheetByName(SH.EMP).getRange(2,1,Math.max(s.getSheetByName(SH.EMP).getLastRow()-1,1),2).getValues()
      .filter(r=>r[0]).map(r=>[String(r[0]),String(r[1])]);
    const grid = [head].concat(emps.map(e=>e.concat(new Array(nDays).fill(''))));
    sh.getRange(1,1,grid.length,head.length).setValues(grid);
    sh.getRange(1,1,1,head.length).setFontWeight('bold');
    sh.setFrozenRows(1); sh.setFrozenColumns(2);
  }
  // ลบชีต Sheet1 เปล่า ถ้ามี
  const def = s.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0 && s.getSheets().length > 1) s.deleteSheet(def);
  props.setProperty('SHEETS_READY','v3');
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
function computeOT(dateStr, workedH, otStart, otEnd, empId){
  const otH = hoursFromHHmm(otStart, otEnd);
  const code  = empId ? rosterCode_(empId, dateStr) : '';
  const shift = lookupShift_(code);
  // วันหยุดของ "คนนี้" = วันหยุดบริษัท หรือวัน OFF/OT-off ตาม roster ของเขาเอง
  const offByRoster = !!(shift && (shift.type==='OFF' || shift.type==='OT'));
  const holiday = isHoliday(dateStr) || offByRoster;
  const capH = (shift && shift.type==='WORK' && shift.hrs) ? shift.hrs : CFG.NORMAL_HOURS;
  let ot15=0, ot1=0, ot3=0;
  if (holiday){
    ot1 = Math.min(Math.max(workedH,0), capH);
    ot3 = otH;
  } else {
    ot15 = otH;
  }
  let dayType = holiday ? (offByRoster ? 'วันหยุด (OFF ตามกะ)' : 'วันหยุด') : 'วันทำงาน';
  if (code && shift && shift.type==='WORK') dayType += ' · '+code;
  return { ot15:round2(ot15), ot1:round2(ot1), ot3:round2(ot3), dayType:dayType, shiftCode:code };
}

/* ---------------------- Shift codes (โยง roster ↔ การลงเวลา) ---------------------- */
// map โค้ดกะจากชีต Shifts (cache 10 นาที) — แก้/เพิ่มโค้ดในชีตได้เอง
function shiftMap_(){
  const cache = CacheService.getScriptCache();
  const hit = cache.get('shiftmap');
  if (hit) return JSON.parse(hit);
  const sh = sheet_(SH.SHIFT);
  const map = {};
  if (sh && sh.getLastRow() > 1){
    sh.getRange(2,1,sh.getLastRow()-1,5).getValues().forEach(r=>{
      const code = String(r[0]||'').trim().toUpperCase();
      if (code) map[code] = { in:String(r[1]||''), out:String(r[2]||''), hrs:Number(r[3])||0,
                              type:String(r[4]||'WORK').toUpperCase() };
    });
  }
  cache.put('shiftmap', JSON.stringify(map), 600);
  return map;
}
// โค้ดกะ → {type:'WORK'|'OFF'|'LEAVE'|..., in, out, hrs} · รองรับช่วงเวลาตรง ๆ เช่น "08-17", "0830-1730"
function lookupShift_(code){
  const c = String(code||'').trim().toUpperCase();
  if (!c) return null;
  const hit = shiftMap_()[c];
  if (hit) return hit;
  const m = c.match(/^(\d{1,2})(\d{2})?\s*[-–]\s*(\d{1,2})(\d{2})?$/);
  if (m){
    const ih=+m[1], im=m[2]!=null?+m[2]:0, oh=+m[3], om=m[4]!=null?+m[4]:0;
    if (ih<=24 && oh<=24 && im<60 && om<60){
      let dur=(oh*60+om)-(ih*60+im); if (dur<=0) dur+=1440;
      const p=n=>('0'+n).slice(-2);
      return { in:p(ih%24)+':'+p(im), out:p(oh%24)+':'+p(om), hrs:Math.round(dur/60*10)/10, type:'WORK' };
    }
  }
  return { in:'', out:'', hrs:0, type:'UNKNOWN' };
}
// โค้ดกะของพนักงานคนหนึ่งในวันหนึ่ง จากชีต Roster (cache 5 นาที)
function rosterCode_(empId, dateStr){
  const cache = CacheService.getScriptCache();
  let data = null;
  const hit = cache.get('roster');
  if (hit) data = JSON.parse(hit);
  else {
    const sh = sheet_(SH.ROSTER);
    data = {head:[], rows:[]};
    if (sh && sh.getLastRow() > 1){
      const vals = sh.getDataRange().getValues();
      data.head = vals[0].map(h => h instanceof Date
        ? Utilities.formatDate(h, CFG.TZ, 'yyyy-MM-dd') : String(h||'').slice(0,10));
      data.rows = vals.slice(1).map(r => r.map(c => String(c||'').trim()));
    }
    cache.put('roster', JSON.stringify(data), 300);
  }
  const col = data.head.indexOf(String(dateStr));
  if (col < 0) return '';
  const row = data.rows.find(r => r[0] === String(empId));
  return row ? String(row[col]||'').toUpperCase() : '';
}
// สายกี่นาที (คิดเฉพาะเกิน grace ตาม TOR §11.2 — เกิน 10 นาทีถือว่าสาย)
function lateMin_(shift, inDate, dateStr){
  if (!shift || shift.type!=='WORK' || !shift.in) return '';
  // เทียบนาทีในวันเดียวกันด้วยเวลาตาม timezone สคริปต์ (ไม่พึ่ง setHours ซึ่งขึ้นกับ TZ ของ runtime)
  const inHM = Utilities.formatDate(inDate, CFG.TZ, 'HH:mm').split(':');
  const sc = shift.in.split(':');
  const late = (+inHM[0]*60 + +inHM[1]) - (+sc[0]*60 + +sc[1]);
  // กะข้ามคืนที่เช็คอินหลังเที่ยงคืน → ค่าติดลบมาก = ไม่นับสาย (นับเฉพาะสายในวันเดียวกัน)
  return late > 10 ? late : '';
}

/* ---------------------- Geofence (GPS) ---------------------- */
function distM_(lat1,lng1,lat2,lng2){
  const R=6371000, rad=x=>x*Math.PI/180;
  const dLat=rad(lat2-lat1), dLng=rad(lng2-lng1);
  const a=Math.sin(dLat/2)*Math.sin(dLat/2)
        + Math.cos(rad(lat1))*Math.cos(rad(lat2))*Math.sin(dLng/2)*Math.sin(dLng/2);
  return Math.round(2*R*Math.asin(Math.sqrt(a)));
}
// คืนข้อความพิกัดสำหรับบันทึกลงชีต · โยน error ถ้า BLOCK เปิดและอยู่นอกพื้นที่
function geoNote_(geo){
  if (!CFG.GEO.ENABLED) return '';
  if (!geo || geo.lat == null || geo.lng == null){
    if (CFG.GEO.BLOCK) throw new Error('ต้องอนุญาตตำแหน่ง (GPS) ในเบราว์เซอร์ก่อนลงเวลา');
    return 'ไม่มีพิกัด';
  }
  const d  = distM_(Number(geo.lat), Number(geo.lng), CFG.GEO.LAT, CFG.GEO.LNG);
  const acc = Math.round(Number(geo.acc)||0);
  const ok = d <= CFG.GEO.RADIUS_M + acc;     // เผื่อค่าความคลาดเคลื่อนของ GPS
  if (!ok && CFG.GEO.BLOCK) throw new Error('อยู่นอกพื้นที่ลงเวลา — ห่างจุดตรวจ '+d+' ม. (เกิน '+CFG.GEO.RADIUS_M+' ม.)');
  return (ok?'✓ในพื้นที่ ':'⚠นอกพื้นที่ ')
       + Number(geo.lat).toFixed(5)+','+Number(geo.lng).toFixed(5)
       + ' ('+d+' ม.'+(acc?' ±'+acc+' ม.':'')+')';
}

/* ---------------------- Employee: check-in / out / OT ---------------------- */
function apiGetEmployees(){
  const cache = CacheService.getScriptCache();
  const hit = cache.get('employees');
  if (hit) return JSON.parse(hit);
  const sh = sheet_(SH.EMP);
  if (!sh || sh.getLastRow()<2) return [];
  const list = sh.getRange(2,1,sh.getLastRow()-1,3).getValues()
    .filter(r=>r[0])
    .map(r=>({ empId:String(r[0]), empName:String(r[1]), team:String(r[2]||'') }));
  cache.put('employees', JSON.stringify(list), 300);   // แก้รายชื่อในชีต มีผลภายใน ≤5 นาที
  return list;
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
    approvedBy:o.approvedBy, approvedAt:o.approvedAt, leaveType:o.leaveType||'',
    inLoc:o.inLoc||'', outLoc:o.outLoc||'', shiftCode:o.shiftCode||'', lateMin:o.lateMin||''
  };
}
function apiCheckIn(empId, geo){
  const emp = apiGetEmployees().filter(e=>e.empId===String(empId))[0];
  if (!emp) throw new Error('ไม่พบรหัสพนักงาน ' + empId + ' ในทะเบียน');
  const dup = findTodayRow_(empId);
  if (dup){
    const lv = String(dup.row[LOG_HEADERS.indexOf('leaveType')]||'');
    throw new Error(lv ? 'วันนี้แจ้งลา ('+lv+') ไว้แล้ว — ยกเลิกกับ Supervisor ก่อนจึงลงเวลาได้'
                       : 'พนักงานคนนี้ลงเวลาเข้าของวันนี้แล้ว');
  }
  const inLoc = geoNote_(geo);
  const sh = sheet_(SH.LOG);
  const now = new Date();
  const shiftCode = rosterCode_(emp.empId, todayStr());
  const shift = lookupShift_(shiftCode);
  const late = lateMin_(shift, now, todayStr());
  const rec = {
    id:uid(), date:todayStr(), empId:emp.empId, empName:emp.empName, team:emp.team,
    timeIn:now, timeOut:'', breakH:1, workedH:'', otStart:'', otEnd:'',
    ot15:0, ot1:0, ot3:0,
    dayType: (isHoliday(todayStr()) || (shift && (shift.type==='OFF'||shift.type==='OT')))
      ? 'วันหยุด' : 'วันทำงาน'+(shiftCode && shift && shift.type==='WORK' ? ' · '+shiftCode : ''),
    status:'open', approvedBy:'', approvedAt:'', note:'', leaveType:'', inLoc:inLoc, outLoc:'',
    shiftCode:shiftCode, lateMin:late
  };
  sh.appendRow(LOG_HEADERS.map(h=>rec[h]));
  return apiGetStatus(empId);
}
function apiCheckOut(empId, breakH, geo){
  const found = findTodayRow_(empId);
  if (!found) throw new Error('ยังไม่ได้ลงเวลาเข้า');
  const o = rowToObj_(found.row);
  if (o.status==='approved') throw new Error('รายการนี้อนุมัติแล้ว แก้ไขไม่ได้');
  const now = new Date();
  const sinceInMin = (now.getTime() - new Date(o.timeIn).getTime())/60000;
  if (sinceInMin < CFG.PUNCH_GAP_MIN){
    throw new Error('เพิ่งลงเวลาเข้า — กดลงเวลาออกได้หลังผ่านไป '+CFG.PUNCH_GAP_MIN+' นาที');
  }
  const brk = Number(breakH||o.breakH||0);
  const worked = round2((now.getTime() - new Date(o.timeIn).getTime())/3600000 - brk);
  const ot = computeOT(o.date, worked, o.otStart, o.otEnd, o.empId);
  o.timeOut=now; o.breakH=brk; o.workedH=worked; o.status='closed';
  o.ot15=ot.ot15; o.ot1=ot.ot1; o.ot3=ot.ot3; o.dayType=ot.dayType;
  if (!o.shiftCode && ot.shiftCode) o.shiftCode = ot.shiftCode;
  o.outLoc = geoNote_(geo);
  writeRow_(sheet_(SH.LOG), found.rowIndex, o);
  return apiGetStatus(empId);
}
function apiSubmitOT(empId, otStart, otEnd, note){
  const found = findTodayRow_(empId);
  if (!found) throw new Error('ยังไม่ได้ลงเวลาเข้า');
  const o = rowToObj_(found.row);
  if (o.status==='approved') throw new Error('รายการนี้อนุมัติแล้ว แก้ไขไม่ได้');
  const worked = Number(o.workedH||0);
  const ot = computeOT(o.date, worked, otStart, otEnd, o.empId);
  o.otStart=otStart; o.otEnd=otEnd;
  o.ot15=ot.ot15; o.ot1=ot.ot1; o.ot3=ot.ot3; o.dayType=ot.dayType;
  if (note!=null) o.note=note;
  writeRow_(sheet_(SH.LOG), found.rowIndex, o);
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
// เขียนทั้งแถวใน call เดียว — เดิม setCell_ ทีละช่อง 8-9 ครั้ง = ต้นเหตุอาการหน่วง
function writeRow_(sh, rowIndex, obj){
  sh.getRange(rowIndex,1,1,LOG_HEADERS.length)
    .setValues([LOG_HEADERS.map(h=>obj[h]!=null?obj[h]:'')]);
}

// ประวัติการลงเวลาของพนักงานหนึ่งคน ย้อนหลัง N วัน (ล่าสุดขึ้นก่อน)
function apiMyHistory(empId, days){
  if (!empId) return [];
  const sh = sheet_(SH.LOG); const last = sh.getLastRow();
  if (last < 2) return [];
  const cutoff = Utilities.formatDate(
    new Date(Date.now() - (Number(days)||14)*86400000), CFG.TZ, 'yyyy-MM-dd');
  const data = sh.getRange(2,1,last-1,LOG_HEADERS.length).getValues();
  const out = [];
  for (let i = data.length-1; i >= 0 && out.length < 40; i--){
    const o = rowToObj_(data[i]);
    if (String(o.empId) !== String(empId)) continue;
    const d = String(o.date).slice(0,10);
    if (d < cutoff) break;
    out.push({
      date:d, timeIn:fmtTime(o.timeIn), timeOut:fmtTime(o.timeOut),
      workedH:o.workedH||0, ot15:o.ot15||0, ot1:o.ot1||0, ot3:o.ot3||0,
      dayType:o.dayType||'', status:o.status, leaveType:o.leaveType||'',
      approvedBy:o.approvedBy||'', inLoc:o.inLoc||'', outLoc:o.outLoc||'',
      shiftCode:o.shiftCode||'', lateMin:o.lateMin||''
    });
  }
  return out;
}

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
      leaveType:o.leaveType||'', inLoc:o.inLoc||'', outLoc:o.outLoc||'',
      shiftCode:o.shiftCode||'', lateMin:o.lateMin||''
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
  o.status='approved'; o.approvedBy=getUserEmail(); o.approvedAt=nowStr();
  writeRow_(sh, rowIndex, o);
  return { ok:true, approvedBy:o.approvedBy, approvedAt:o.approvedAt };
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
      '<td class="c">'+(r.timeIn||'-')+(r.lateMin?' (สาย'+r.lateMin+'น.)':'')+'</td><td class="c">'+(r.timeOut||'-')+'</td>'+
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
