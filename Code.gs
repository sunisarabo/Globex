/**
 * Globex Time Attendance — เช็คอิน/เช็คเอาท์ · OT · ลา สำหรับพนักงาน Outsource
 * ─────────────────────────────────────────────────────────────────────
 * Standalone Google Apps Script Web App + Google Sheets DB.
 * เขียนตาม TOR งานจ้างเหมาบริการแรงงาน (Outsource) บพท. ท่าอากาศยานภูเก็ต:
 *   §3.1.2  OT ต้องได้รับอนุมัติก่อนปฏิบัติงาน จึงจะนับชั่วโมงเบิกจ่าย
 *   §3.1.3  OT report: รายชื่อ วันที่ เวลาเริ่ม-สิ้นสุด ชม.OT เที่ยวบิน เหตุผล
 *   §3.2.x  เอกสารตรวจรับรายเดือนเป็นไฟล์ Excel (Daily Attendance /
 *           Timesheet / OT Timesheet / สรุปชั่วโมง+จำนวนพนักงานจริง)
 *   §11.2   มาสายเกิน 10 นาที นับเป็นขาดงาน 1 ชั่วโมง → เกณฑ์ LATE = 10 นาที
 *
 * AUTH: พนักงาน Outsource ไม่มีบัญชี Google ของโดเมน — ระบบจึงมี User
 * ของตัวเอง (รหัสพนักงาน + PIN, hash เก็บใน sheet) เวลาเข้า-ออกประทับโดย
 * server เท่านั้น  Deploy: Execute as = Me · Access = Anyone
 */

var CFG = {
  APP_NAME:   'Globex Time Attendance',
  DB_FILE_ID: '',            // ว่าง = สร้าง spreadsheet ใหม่อัตโนมัติครั้งแรก แล้วจำไว้ใน ScriptProperties
  TOKEN_TTL_SEC: 6 * 3600    // อายุ login token
};

var ATT = {
  LATE_GRACE_MIN:      10,   // TOR §11.2 — สายเกิน 10 นาที
  EARLY_OUT_GRACE_MIN: 10,
  NO_OUT_AFTER_MIN:    120,  // เลยเวลาเลิกกะเท่านี้แล้วยังไม่เช็คเอาท์ → NO_OUT
  DEFAULT_SHIFT_HRS:   8,    // TOR §3 ผลัดละ 8-12 ชม.
  MAX_SHIFT_HRS:       12,
  WEEK_LIMIT_HRS:      48,   // TOR §3 ไม่เกิน 48 ชม./สัปดาห์
  OT_ROUND_MIN:        30,   // OT ปัดลงทีละ 30 นาที
  MAX_OT_REQ_HRS:      8,
  LEAVE_TYPES: {AL:'ลาพักร้อน', SL:'ลาป่วย', BL:'ลากิจ', ML:'ลาคลอด', UL:'ลาไม่รับค่าจ้าง'}
};

var TABS = {
  STAFF:   'Staff',
  USERS:   'Users',
  ATT:     'Attendance',
  REQ:     'Requests',
  LOG:     'Log'
};

var STAFF_HEADERS = ['EmpID','Name','Surname','NameTh','Position','Vendor','ShiftStart','ShiftEnd',
                     'ShiftHrs','StartDate','EndDate','Active','Note','UpdatedAt','UpdatedBy'];
var USER_HEADERS  = ['UserID','Role','Salt','PinHash','Active','CreatedAt','CreatedBy','LastLogin'];
var ATT_HEADERS   = ['Date','EmpID','Name','Shift','SchedIn','SchedOut','InAt','InBy','OutAt','OutBy',
                     'Station','Flights','WorkHrs','RegHrs','OtActual','OtApproved','OtPayable',
                     'Flags','Status','Note','UpdatedAt','UpdatedBy'];
var REQ_HEADERS   = ['ReqID','Type','EmpID','Name','SubType','DateFrom','DateTo','Days','Hours',
                     'TimeFrom','TimeTo','Flight','Reason','Status','CreatedAt','CreatedBy',
                     'DecidedAt','DecidedBy','DecideNote'];
var ROLES = {ADMIN:3, SUPERVISOR:2, STAFF:1};

// ───────────────────────────────────────────────────────────────────────
// DB + sheet helpers
// ───────────────────────────────────────────────────────────────────────
function _dbId() {
  if (CFG.DB_FILE_ID) return CFG.DB_FILE_ID;
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('DB_FILE_ID');
  if (id) return id;
  var ss = SpreadsheetApp.create(CFG.APP_NAME + ' DB');
  id = ss.getId();
  props.setProperty('DB_FILE_ID', id);
  return id;
}

function _tab(name, headers) {
  var ss = SpreadsheetApp.openById(_dbId());
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) { sh.appendRow(headers); sh.setFrozenRows(1); }
  return sh;
}

function _rows(sh) {
  var values = sh.getDataRange().getValues();
  var out = {header: [], rows: []};
  if (!values.length) return out;
  out.header = values[0].map(function(h){ return String(h||'').trim(); });
  for (var r = 1; r < values.length; r++) {
    var o = {_row: r + 1}, blank = true;
    for (var c = 0; c < out.header.length; c++) {
      var h = out.header[c]; if (!h) continue;
      o[h] = values[r][c];
      if (values[r][c] !== '' && values[r][c] != null) blank = false;
    }
    if (!blank) out.rows.push(o);
  }
  return out;
}

function _writeRow(sh, header, rowIdx, obj) {
  sh.getRange(rowIdx, 1, 1, header.length)
    .setValues([header.map(function(h){ return obj[h] != null ? obj[h] : ''; })]);
}
function _appendRow(sh, header, obj) {
  sh.appendRow(header.map(function(h){ return obj[h] != null ? obj[h] : ''; }));
}

function _lock() {
  var l = LockService.getScriptLock();
  if (!l || !l.tryLock(8000)) throw new Error('ระบบกำลังบันทึกรายการอื่น — ลองใหม่อีกครั้ง');
  return l;
}

function _log(user, action, detail) {
  try {
    var sh = _tab(TABS.LOG, ['Timestamp','User','Action','Detail']);
    sh.appendRow([_nowStamp(), user, action, String(detail||'').slice(0, 400)]);
  } catch (e) {}
}

// ───────────────────────────────────────────────────────────────────────
// time helpers — stamps "yyyy-MM-dd HH:mm" in script TZ (Asia/Bangkok)
// ───────────────────────────────────────────────────────────────────────
function _p(n) { n = String(n); return n.length < 2 ? '0' + n : n; }
function _todayISO() { return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'); }
function _nowStamp() { return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm'); }

function _toISO(v) {
  if (!v) return '';
  if (v instanceof Date && !isNaN(v)) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  var m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (m) {
    var y = +(m[3].length === 2 ? '25' + m[3] : m[3]);
    if (y > 2400) y -= 543;                        // พ.ศ. → ค.ศ.
    return y + '-' + _p(m[2]) + '-' + _p(m[1]);
  }
  return '';
}

function _toHHMM(v) {
  if (!v && v !== 0) return '';
  if (v instanceof Date && !isNaN(v)) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'HH:mm');
  var m = String(v).trim().match(/(\d{1,2})[:.]?(\d{2})/);
  return m ? _p(m[1]) + ':' + m[2] : '';
}

function _toStamp(v) {
  if (v == null || v === '') return '';
  if (v instanceof Date && !isNaN(v)) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  var m = String(v).trim().match(/^(\d{4}-\d{1,2}-\d{1,2})[ T](\d{1,2}):(\d{2})/);
  if (!m) return String(v).trim();
  var d = m[1].split('-');
  return d[0] + '-' + _p(d[1]) + '-' + _p(d[2]) + ' ' + _p(m[2]) + ':' + m[3];
}

// นาทีแบบ wall-clock (เทียบ-ลบกันได้ตรง ๆ ไม่เกี่ยว timezone)
function _stampMin(stamp) {
  var m = String(stamp || '').match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 60000;
}
function _hhmmMin(s) { var m = String(s||'').match(/^(\d{2}):(\d{2})$/); return m ? +m[1]*60 + +m[2] : null; }
function _stampOf(iso, hhmm) { return iso + ' ' + _toHHMM(hhmm); }
function _stampTime(st) { var m = String(st||'').match(/ (\d{2}:\d{2})$/); return m ? m[1] : ''; }
function _stampDate(st) { var m = String(st||'').match(/^(\d{4}-\d{2}-\d{2})/); return m ? m[1] : ''; }
function _addDays(iso, n) {
  var d = new Date(iso + 'T00:00:00');
  d = new Date(d.getTime() + n * 86400000);
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}
function _dateRange(fromISO, toISO) {
  var out = [], cur = fromISO;
  if (!fromISO || !toISO || toISO < fromISO) return out;
  while (cur <= toISO && out.length < 366) { out.push(cur); cur = _addDays(cur, 1); }
  return out;
}
function _round2(n) { return Math.round(n * 100) / 100; }

// ───────────────────────────────────────────────────────────────────────
// AUTH — app users (EmpID + PIN) · token ใน CacheService
// ───────────────────────────────────────────────────────────────────────
function _hashPin(salt, pin) {
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + '|' + String(pin));
  return raw.map(function(b){ return ('0' + (b & 0xFF).toString(16)).slice(-2); }).join('');
}

function _userById(id) {
  var data = _rows(_tab(TABS.USERS, USER_HEADERS));
  for (var i = 0; i < data.rows.length; i++) {
    if (String(data.rows[i].UserID||'').replace(/\.0$/,'').trim().toUpperCase() === String(id||'').trim().toUpperCase()) {
      return {rec: data.rows[i], data: data};
    }
  }
  return null;
}

function _tokenPut(user) {
  var token = Utilities.getUuid();
  CacheService.getScriptCache().put('tok_' + token,
    JSON.stringify({id: user.id, role: user.role, name: user.name}), CFG.TOKEN_TTL_SEC);
  return token;
}
function _tokenGet(token) {
  if (!token) return null;
  var s = CacheService.getScriptCache().get('tok_' + String(token));
  return s ? JSON.parse(s) : null;
}

// ตรวจสิทธิ์จาก token · minRole = 'STAFF' | 'SUPERVISOR' | 'ADMIN'
function _auth(body, minRole) {
  var u = _tokenGet(body && body.token);
  if (!u) throw new Error('SESSION_EXPIRED: กรุณา login ใหม่');
  if (minRole && (ROLES[u.role] || 0) < ROLES[minRole]) {
    throw new Error('ไม่มีสิทธิ์ดำเนินการ (ต้องเป็น ' + minRole + ' ขึ้นไป)');
  }
  return u;
}

function _staffName(s) { return ((s.n || '') + ' ' + (s.ln || '')).trim(); }

function apiLogin(body) {
  var id  = String(body.empId || '').trim().toUpperCase();
  var pin = String(body.pin || '');
  if (!id || !pin) throw new Error('กรอกรหัสพนักงานและ PIN');
  var found = _userById(id);
  if (!found) throw new Error('ไม่พบผู้ใช้ ' + id);
  var rec = found.rec;
  if (String(rec.Active).toLowerCase() === 'no') throw new Error('ผู้ใช้ถูกระงับ');
  if (_hashPin(String(rec.Salt), pin) !== String(rec.PinHash)) throw new Error('PIN ไม่ถูกต้อง');
  var role = String(rec.Role || 'STAFF').toUpperCase();
  var staff = _staffById(id);
  var name = staff ? _staffName(staff) : id;
  var user = {id: String(rec.UserID).trim().toUpperCase(), role: role, name: name};
  var token = _tokenPut(user);
  rec.LastLogin = _nowStamp();
  _writeRow(_tab(TABS.USERS, USER_HEADERS), found.data.header.length ? found.data.header : USER_HEADERS, rec._row, rec);
  _log(user.id, 'login', role);
  return {ok: true, token: token, user: user, staff: staff || null};
}

// kiosk: ตรวจ EmpID+PIN แบบครั้งเดียว (ไม่ออก token)
function _verifyPin(empId, pin) {
  var found = _userById(empId);
  if (!found) throw new Error('ไม่พบผู้ใช้ ' + empId);
  if (String(found.rec.Active).toLowerCase() === 'no') throw new Error('ผู้ใช้ถูกระงับ');
  if (_hashPin(String(found.rec.Salt), String(pin)) !== String(found.rec.PinHash)) throw new Error('PIN ไม่ถูกต้อง');
  return {id: String(found.rec.UserID).trim().toUpperCase(), role: String(found.rec.Role||'STAFF').toUpperCase()};
}

// ───────────────────────────────────────────────────────────────────────
// STAFF — เพิ่มชื่อ / เปลี่ยนชื่อ / ปิดสถานะ + สร้าง User (PIN) ในตัว
// ───────────────────────────────────────────────────────────────────────
function pullStaffAll() {
  var data = _rows(_tab(TABS.STAFF, STAFF_HEADERS));
  return data.rows.map(function(r){
    return {
      i:     String(r.EmpID || '').replace(/\.0$/,'').trim().toUpperCase(),
      n:     String(r.Name || '').trim(),
      ln:    String(r.Surname || '').trim(),
      nth:   String(r.NameTh || '').trim(),
      p:     String(r.Position || 'PSA').trim(),
      vendor:String(r.Vendor || '').trim(),
      si:    _toHHMM(r.ShiftStart),
      so:    _toHHMM(r.ShiftEnd),
      hrs:   parseFloat(r.ShiftHrs) || ATT.DEFAULT_SHIFT_HRS,
      start: _toISO(r.StartDate),
      end:   _toISO(r.EndDate),
      active:String(r.Active).toLowerCase() !== 'no',
      note:  String(r.Note || '').trim()
    };
  }).filter(function(s){ return s.i; });
}
function _staffById(id) {
  var all = pullStaffAll();
  id = String(id || '').trim().toUpperCase();
  for (var i = 0; i < all.length; i++) if (all[i].i === id) return all[i];
  return null;
}

// body: {token, staff:[{i,n,ln,nth,p,vendor,si,so,hrs,start,end,active,note,pin?,role?}], remove:[ids]}
function apiSaveStaff(body) {
  var actor = _auth(body, 'SUPERVISOR');
  var list = body.staff || [], remove = body.remove || [];
  var lock = _lock();
  try {
    var sh = _tab(TABS.STAFF, STAFF_HEADERS);
    var data = _rows(sh);
    var header = data.header.length ? data.header : STAFF_HEADERS;
    var byId = {};
    data.rows.forEach(function(r){
      var id = String(r.EmpID||'').replace(/\.0$/,'').trim().toUpperCase();
      if (id) byId[id] = r;
    });
    var now = _nowStamp(), n = 0;
    list.forEach(function(s){
      var id = String(s.i || '').trim().toUpperCase();
      if (!id) return;
      if (!String(s.n || '').trim()) throw new Error(id + ': ต้องระบุชื่อ');
      var hrs = parseFloat(s.hrs) || ATT.DEFAULT_SHIFT_HRS;
      if (hrs < 1 || hrs > ATT.MAX_SHIFT_HRS) throw new Error(id + ': ชั่วโมงกะต้อง 1–' + ATT.MAX_SHIFT_HRS);
      var rec = byId[id] || {EmpID: id};
      rec.Name = String(s.n).trim();           rec.Surname = String(s.ln || '').trim();
      rec.NameTh = String(s.nth || '').trim(); rec.Position = String(s.p || 'PSA').trim();
      rec.Vendor = String(s.vendor || '').trim();
      rec.ShiftStart = _toHHMM(s.si) || '';    rec.ShiftEnd = _toHHMM(s.so) || '';
      rec.ShiftHrs = hrs;
      rec.StartDate = _toISO(s.start);         rec.EndDate = _toISO(s.end);
      rec.Active = s.active === false ? 'No' : 'Yes';
      rec.Note = String(s.note || '').trim().slice(0, 300);
      rec.UpdatedAt = now; rec.UpdatedBy = actor.id;
      if (byId[id]) _writeRow(sh, header, rec._row, rec);
      else _appendRow(sh, header, rec);
      n++;
      // ตั้ง/รีเซ็ต PIN → สร้าง user record ให้เช็คอินได้
      if (s.pin) _upsertUser(id, s.role || 'STAFF', String(s.pin), actor.id);
      else if (s.role && _userById(id)) _upsertUser(id, s.role, null, actor.id);
    });
    remove.forEach(function(id){
      var r = byId[String(id).trim().toUpperCase()];
      if (r) { sh.deleteRow(r._row); n++; }
      // ลบ user คู่กันด้วย
      var u = _userById(id);
      if (u) _tab(TABS.USERS, USER_HEADERS).deleteRow(u.rec._row);
    });
    _log(actor.id, 'saveStaff', n + ' rows (' + remove.length + ' removed)');
    return {ok: true, n: n, staff: pullStaffAll()};
  } finally { try { lock.releaseLock(); } catch (e) {} }
}

function _upsertUser(id, role, pin, by) {
  id = String(id).trim().toUpperCase();
  role = String(role || 'STAFF').toUpperCase();
  if (!ROLES[role]) throw new Error('role ไม่ถูกต้อง: ' + role);
  if (pin != null && !/^\d{4,8}$/.test(String(pin))) throw new Error(id + ': PIN ต้องเป็นตัวเลข 4–8 หลัก');
  var sh = _tab(TABS.USERS, USER_HEADERS);
  var found = _userById(id);
  var now = _nowStamp();
  if (found) {
    var rec = found.rec;
    rec.Role = role;
    if (pin != null) { rec.Salt = Utilities.getUuid().slice(0, 8); rec.PinHash = _hashPin(rec.Salt, pin); }
    rec.Active = 'Yes';
    _writeRow(sh, found.data.header, rec._row, rec);
  } else {
    if (pin == null) throw new Error(id + ': ผู้ใช้ใหม่ต้องตั้ง PIN');
    var salt = Utilities.getUuid().slice(0, 8);
    _appendRow(sh, USER_HEADERS, {UserID: id, Role: role, Salt: salt, PinHash: _hashPin(salt, pin),
                                  Active: 'Yes', CreatedAt: now, CreatedBy: by});
  }
}

// body: {token, userId, role?, pin?, active?}
function apiSaveUser(body) {
  var actor = _auth(body, 'ADMIN');
  var id = String(body.userId || '').trim().toUpperCase();
  if (!id) throw new Error('ต้องระบุ userId');
  var lock = _lock();
  try {
    if (body.active === false) {
      var f = _userById(id);
      if (!f) throw new Error('ไม่พบผู้ใช้ ' + id);
      f.rec.Active = 'No';
      _writeRow(_tab(TABS.USERS, USER_HEADERS), f.data.header, f.rec._row, f.rec);
    } else {
      _upsertUser(id, body.role || (_userById(id) ? _userById(id).rec.Role : 'STAFF'),
                  body.pin != null ? String(body.pin) : null, actor.id);
    }
    _log(actor.id, 'saveUser', id + ' role=' + (body.role||'-') + (body.pin ? ' +pin' : ''));
    return {ok: true, users: pullUsers()};
  } finally { try { lock.releaseLock(); } catch (e) {} }
}

function pullUsers() {
  return _rows(_tab(TABS.USERS, USER_HEADERS)).rows.map(function(r){
    return {id: String(r.UserID||'').trim().toUpperCase(), role: String(r.Role||'').toUpperCase(),
            active: String(r.Active).toLowerCase() !== 'no', lastLogin: _toStamp(r.LastLogin)};
  });
}

// ───────────────────────────────────────────────────────────────────────
// ATTENDANCE — recalc กลางที่เดียว ให้ punch/แก้ไข/อนุมัติ OT คิดเหมือนกัน
// ───────────────────────────────────────────────────────────────────────
function _recalc(rec, staff, approvedOt) {
  var schedHrs = (staff && staff.hrs) || ATT.DEFAULT_SHIFT_HRS;
  if (!rec.SchedIn && staff && staff.si)  rec.SchedIn  = staff.si;
  if (!rec.SchedOut && staff && staff.so) rec.SchedOut = staff.so;
  rec.SchedIn = _toHHMM(rec.SchedIn); rec.SchedOut = _toHHMM(rec.SchedOut);
  if (rec.SchedIn && rec.SchedOut) {
    var si = _hhmmMin(rec.SchedIn), so = _hhmmMin(rec.SchedOut);
    if (si != null && so != null) { var d = so - si; if (d <= 0) d += 1440; schedHrs = _round2(d / 60); }
  }
  rec.Shift = rec.SchedIn && rec.SchedOut ? rec.SchedIn + '-' + rec.SchedOut : (rec.Shift || '');

  var inMin = _stampMin(_toStamp(rec.InAt)), outMin = _stampMin(_toStamp(rec.OutAt));
  var flags = [];
  var work = 0;
  if (inMin != null && outMin != null) {
    var span = outMin - inMin; if (span < 0) span += 1440;
    work = _round2(span / 60);
  }
  rec.WorkHrs = work || '';
  rec.RegHrs = work ? _round2(Math.min(work, schedHrs)) : '';

  var ot = 0;
  if (work > schedHrs) {
    var otMin = Math.floor((work - schedHrs) * 60 / ATT.OT_ROUND_MIN) * ATT.OT_ROUND_MIN;
    ot = _round2(otMin / 60);
  }
  rec.OtActual = ot || '';
  rec.OtApproved = approvedOt ? _round2(approvedOt) : '';
  // TOR §3.1.5: นับจ่ายเฉพาะ "อนุมัติแล้ว และทำจริง" — ต่ำสุดของสองค่า
  rec.OtPayable = _round2(Math.min(ot, approvedOt || 0)) || '';
  if (ot > (approvedOt || 0) + 0.01) flags.push('OT_UNAPPROVED');

  if (rec.SchedIn && inMin != null) {
    var sIn = _stampMin(_stampOf(rec.Date, rec.SchedIn));
    if (sIn != null && inMin > sIn + ATT.LATE_GRACE_MIN) flags.push('LATE');   // TOR §11.2
  }
  if (rec.SchedOut && outMin != null) {
    var sOut = _stampMin(_stampOf(rec.Date, rec.SchedOut));
    if (sOut != null && _hhmmMin(rec.SchedOut) <= _hhmmMin(rec.SchedIn || '00:00')) sOut += 1440;
    if (sOut != null && outMin < sOut - ATT.EARLY_OUT_GRACE_MIN) flags.push('EARLY_OUT');
  }

  if (inMin != null && outMin == null) {
    rec.Status = 'OPEN';
    var nowMin = _stampMin(_nowStamp());
    var endMin = rec.SchedOut ? _stampMin(_stampOf(rec.Date, rec.SchedOut)) : inMin + schedHrs * 60;
    if (rec.SchedOut && _hhmmMin(rec.SchedOut) <= _hhmmMin(rec.SchedIn || '00:00')) endMin += 1440;
    if (nowMin != null && endMin != null && nowMin > endMin + ATT.NO_OUT_AFTER_MIN) flags.push('NO_OUT');
  } else if (inMin != null && outMin != null) rec.Status = 'CLOSED';
  else rec.Status = rec.Status || 'OPEN';

  rec.Flags = flags.join(',');
  return rec;
}

function _attToClient(r) {
  return {
    row: r._row, date: _toISO(r.Date),
    empId: String(r.EmpID||'').replace(/\.0$/,'').trim().toUpperCase(),
    name: String(r.Name||''), shift: String(r.Shift||''),
    schedIn: _toHHMM(r.SchedIn), schedOut: _toHHMM(r.SchedOut),
    inAt: _toStamp(r.InAt), inBy: String(r.InBy||''),
    outAt: _toStamp(r.OutAt), outBy: String(r.OutBy||''),
    station: String(r.Station||''), flights: String(r.Flights||''),
    workHrs: Number(r.WorkHrs) || 0, regHrs: Number(r.RegHrs) || 0,
    otActual: Number(r.OtActual) || 0, otApproved: Number(r.OtApproved) || 0,
    otPayable: Number(r.OtPayable) || 0,
    flags: String(r.Flags||'').split(',').filter(function(f){return f;}),
    status: String(r.Status||''), note: String(r.Note||''),
    updatedAt: _toStamp(r.UpdatedAt), updatedBy: String(r.UpdatedBy||'')
  };
}

// ชั่วโมง OT ที่อนุมัติแล้ว ต่อ "empId|date"
function _approvedOtMap() {
  var map = {};
  _rows(_tab(TABS.REQ, REQ_HEADERS)).rows.forEach(function(r){
    if (String(r.Type||'').toUpperCase() !== 'OT') return;
    if (String(r.Status||'').toUpperCase() !== 'APPROVED') return;
    var id = String(r.EmpID||'').replace(/\.0$/,'').trim().toUpperCase();
    var hrs = parseFloat(r.Hours) || 0;
    _dateRange(_toISO(r.DateFrom), _toISO(r.DateTo || r.DateFrom)).forEach(function(d){
      map[id + '|' + d] = (map[id + '|' + d] || 0) + hrs;
    });
  });
  return map;
}

function pullAttendance(from, to) {
  var f = _toISO(from) || _todayISO(), t = _toISO(to) || f;
  if (t < f) { var s = f; f = t; t = s; }
  var out = [];
  _rows(_tab(TABS.ATT, ATT_HEADERS)).rows.forEach(function(r){
    var d = _toISO(r.Date);
    if (d && d >= f && d <= t) out.push(_attToClient(r));
  });
  out.sort(function(a,b){
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.name < b.name ? -1 : 1;
  });
  return out;
}

function _findAttRow(data, date, empId) {
  for (var i = 0; i < data.rows.length; i++) {
    if (_toISO(data.rows[i].Date) === date &&
        String(data.rows[i].EmpID||'').replace(/\.0$/,'').trim().toUpperCase() === empId) return data.rows[i];
  }
  return null;
}

// body: {kind:'IN'|'OUT', token?, empId?, pin?, station?, flights?, note?, date?, at?}
//   • token (ล็อกอินอยู่)  → STAFF punch ของตัวเองเท่านั้น / SUP+ADMIN punch แทนใครก็ได้
//   • empId+pin (kiosk)    → punch ของเจ้าของ PIN เท่านั้น
//   • date/at override     → SUPERVISOR ขึ้นไป
function apiPunch(body) {
  var kind = String(body.kind || '').toUpperCase();
  if (kind !== 'IN' && kind !== 'OUT') throw new Error('kind ต้องเป็น IN หรือ OUT');
  var actorId, actorRole, empId;
  if (body.token) {
    var u = _auth(body, 'STAFF');
    actorId = u.id; actorRole = u.role;
    empId = String(body.empId || u.id).trim().toUpperCase();
    if (empId !== u.id && (ROLES[actorRole] || 0) < ROLES.SUPERVISOR) {
      throw new Error('ลงเวลาแทนคนอื่นได้เฉพาะหัวหน้างานขึ้นไป');
    }
  } else {
    var v = _verifyPin(String(body.empId||''), String(body.pin||''));
    actorId = v.id; actorRole = v.role; empId = v.id;
  }
  var staff = _staffById(empId);
  if (!staff) throw new Error('ไม่พบพนักงาน ' + empId + ' ในทะเบียน');
  if (!staff.active) throw new Error(empId + ' ถูกปิดสถานะ (Inactive)');

  var now = _nowStamp();
  var date = _toISO(body.date) || _stampDate(now);
  var stamp = now;
  if (body.at || (body.date && body.date !== _stampDate(now))) {
    if ((ROLES[actorRole] || 0) < ROLES.SUPERVISOR) throw new Error('แก้เวลา/ลงย้อนหลังได้เฉพาะหัวหน้างานขึ้นไป');
    if (body.at) {
      stamp = _stampOf(date, body.at);
      if (_stampMin(stamp) == null) throw new Error('รูปแบบเวลาไม่ถูกต้อง: ' + body.at);
    }
  }

  var lock = _lock();
  try {
    var sh = _tab(TABS.ATT, ATT_HEADERS);
    var data = _rows(sh);
    var header = data.header.length ? data.header : ATT_HEADERS;
    var rec = _findAttRow(data, date, empId);
    var isNew = !rec, already = false;
    if (isNew) rec = {Date: date, EmpID: empId, Name: _staffName(staff)};
    rec.InAt = _toStamp(rec.InAt); rec.OutAt = _toStamp(rec.OutAt);

    if (kind === 'IN') {
      if (rec.InAt) already = true;
      else { rec.InAt = stamp; rec.InBy = actorId; }
    } else {
      if (!rec.InAt) throw new Error(empId + ' ยังไม่ได้เช็คอินวันที่ ' + date);
      if (rec.OutAt) already = true;
      else {
        // เช็คเอาท์ก่อนเวลาเข้า = กะข้ามคืน → เวลาออกเป็นของวันถัดไป
        if (_stampMin(stamp) != null && _stampMin(stamp) < _stampMin(rec.InAt)) {
          stamp = _stampOf(_addDays(date, 1), _stampTime(stamp));
        }
        rec.OutAt = stamp; rec.OutBy = actorId;
      }
    }
    if (body.station != null) rec.Station = String(body.station).slice(0, 100);
    if (body.flights != null) rec.Flights = String(body.flights).slice(0, 200);
    if (body.note != null)    rec.Note    = String(body.note).slice(0, 300);
    rec.UpdatedAt = now; rec.UpdatedBy = actorId;
    _recalc(rec, staff, _approvedOtMap()[empId + '|' + date] || 0);
    if (isNew) _appendRow(sh, header, rec);
    else _writeRow(sh, header, rec._row, rec);
    _log(actorId, 'punch' + kind, empId + ' ' + date + ' ' + stamp + (already ? ' (already)' : ''));
    return {ok: true, already: already, record: _attToClient(rec)};
  } finally { try { lock.releaseLock(); } catch (e) {} }
}

// แก้ไขแถวลงเวลา (SUPERVISOR ขึ้นไป) — '' = ล้างค่า, undefined = คงเดิม
// body: {token, date, empId, inAt?, outAt?, station?, flights?, note?, remove?}
function apiSaveAttendance(body) {
  var actor = _auth(body, 'SUPERVISOR');
  var date = _toISO(body.date), empId = String(body.empId||'').trim().toUpperCase();
  if (!date || !empId) throw new Error('ต้องมี date และ empId');
  var lock = _lock();
  try {
    var sh = _tab(TABS.ATT, ATT_HEADERS);
    var data = _rows(sh);
    var header = data.header.length ? data.header : ATT_HEADERS;
    var rec = _findAttRow(data, date, empId);
    if (body.remove) {
      if (rec) sh.deleteRow(rec._row);
      _log(actor.id, 'deleteAttendance', empId + ' ' + date);
      return {ok: true, removed: true};
    }
    var staff = _staffById(empId);
    var isNew = !rec;
    if (isNew) rec = {Date: date, EmpID: empId, Name: staff ? _staffName(staff) : empId};
    if (body.inAt != null)  { rec.InAt = body.inAt ? _stampOf(date, body.inAt) : ''; if (rec.InAt) rec.InBy = actor.id; }
    if (body.outAt != null) {
      rec.OutAt = '';
      if (body.outAt) {
        var st = _stampOf(date, body.outAt);
        var im = _stampMin(_toStamp(rec.InAt));
        if (im != null && _stampMin(st) != null && _stampMin(st) < im) st = _stampOf(_addDays(date, 1), body.outAt);
        rec.OutAt = st; rec.OutBy = actor.id;
      }
    }
    if (body.station != null) rec.Station = String(body.station).slice(0, 100);
    if (body.flights != null) rec.Flights = String(body.flights).slice(0, 200);
    if (body.note != null)    rec.Note    = String(body.note).slice(0, 300);
    rec.UpdatedAt = _nowStamp(); rec.UpdatedBy = actor.id;
    _recalc(rec, staff, _approvedOtMap()[empId + '|' + date] || 0);
    if (isNew) _appendRow(sh, header, rec);
    else _writeRow(sh, header, rec._row, rec);
    _log(actor.id, 'saveAttendance', empId + ' ' + date);
    return {ok: true, record: _attToClient(rec)};
  } finally { try { lock.releaseLock(); } catch (e) {} }
}

// recompute หลัง OT approve/cancel (เรียกภายใน lock)
function _refreshAttDays(empId, days, actorId) {
  var sh = _tab(TABS.ATT, ATT_HEADERS);
  var data = _rows(sh);
  if (!data.rows.length) return;
  var otMap = _approvedOtMap(), want = {};
  days.forEach(function(d){ want[d] = 1; });
  data.rows.forEach(function(rec){
    var d = _toISO(rec.Date);
    if (!want[d]) return;
    if (String(rec.EmpID||'').replace(/\.0$/,'').trim().toUpperCase() !== empId) return;
    rec.InAt = _toStamp(rec.InAt); rec.OutAt = _toStamp(rec.OutAt);
    rec.UpdatedAt = _nowStamp(); rec.UpdatedBy = actorId;
    _recalc(rec, _staffById(empId), otMap[empId + '|' + d] || 0);
    _writeRow(sh, data.header, rec._row, rec);
  });
}

// ───────────────────────────────────────────────────────────────────────
// REQUESTS — OT (ขออนุมัติล่วงหน้าตาม TOR §3.1.2) + ลา
// ───────────────────────────────────────────────────────────────────────
function pullRequests() {
  var out = [];
  _rows(_tab(TABS.REQ, REQ_HEADERS)).rows.forEach(function(r){
    var rec = {
      row: r._row, reqId: String(r.ReqID||''),
      type: String(r.Type||'').toUpperCase(),
      empId: String(r.EmpID||'').replace(/\.0$/,'').trim().toUpperCase(),
      name: String(r.Name||''), subType: String(r.SubType||''),
      dateFrom: _toISO(r.DateFrom), dateTo: _toISO(r.DateTo || r.DateFrom),
      days: parseInt(r.Days, 10) || 0, hours: parseFloat(r.Hours) || 0,
      timeFrom: _toHHMM(r.TimeFrom), timeTo: _toHHMM(r.TimeTo),
      flight: String(r.Flight||''), reason: String(r.Reason||''),
      status: String(r.Status||'').toUpperCase(),
      createdAt: _toStamp(r.CreatedAt), createdBy: String(r.CreatedBy||''),
      decidedAt: _toStamp(r.DecidedAt), decidedBy: String(r.DecidedBy||''),
      decideNote: String(r.DecideNote||'')
    };
    if (rec.reqId) out.push(rec);
  });
  out.sort(function(a,b){ return a.createdAt < b.createdAt ? 1 : -1; });
  return out;
}

function _nextReqId(rows, type, iso) {
  var prefix = (type === 'OT' ? 'OT-' : 'LV-') + iso.replace(/-/g, '') + '-';
  var max = 0;
  rows.forEach(function(r){
    var id = String(r.ReqID || '');
    if (id.indexOf(prefix) === 0) { var n = parseInt(id.slice(prefix.length), 10); if (n > max) max = n; }
  });
  return prefix + _p(String(max + 1));
}

// body: {token, type:'OT'|'LEAVE', empId?, dateFrom, dateTo?, hours?, timeFrom?,
//        timeTo?, flight?, subType?, reason}
function apiSubmitRequest(body) {
  var actor = _auth(body, 'STAFF');
  var type = String(body.type || '').toUpperCase();
  if (type !== 'OT' && type !== 'LEAVE') throw new Error('type ต้องเป็น OT หรือ LEAVE');
  var empId = String(body.empId || actor.id).trim().toUpperCase();
  if (empId !== actor.id && (ROLES[actor.role] || 0) < ROLES.SUPERVISOR) {
    throw new Error('ยื่นคำขอแทนคนอื่นได้เฉพาะหัวหน้างานขึ้นไป');
  }
  var staff = _staffById(empId);
  if (!staff) throw new Error('ไม่พบพนักงาน ' + empId);
  var from = _toISO(body.dateFrom), to = _toISO(body.dateTo) || from;
  if (!from) throw new Error('วันที่ไม่ถูกต้อง');
  if (to < from) { var s = from; from = to; to = s; }
  var days = _dateRange(from, to);
  if (days.length > 62) throw new Error('ขอครั้งละไม่เกิน 62 วัน');
  var reason = String(body.reason || '').trim().slice(0, 500);
  if (!reason) throw new Error('กรุณาระบุเหตุผล');   // TOR §3.1.3

  var hours = 0, subType = '', flight = '';
  if (type === 'OT') {
    hours = parseFloat(body.hours) || 0;
    if (hours <= 0) throw new Error('ระบุจำนวนชั่วโมง OT');
    if (hours > ATT.MAX_OT_REQ_HRS) throw new Error('OT ต่อวันไม่เกิน ' + ATT.MAX_OT_REQ_HRS + ' ชม.');
    flight = String(body.flight || '').trim().slice(0, 120);
    if (!flight) throw new Error('ระบุเที่ยวบิน/งานที่ปฏิบัติ (ตาม TOR ข้อ 3.1.3)');
  } else {
    subType = String(body.subType || '').trim().toUpperCase();
    if (!ATT.LEAVE_TYPES[subType]) throw new Error('ประเภทการลาไม่ถูกต้อง (' + Object.keys(ATT.LEAVE_TYPES).join('/') + ')');
  }

  var lock = _lock();
  try {
    var sh = _tab(TABS.REQ, REQ_HEADERS);
    var data = _rows(sh);
    for (var i = 0; i < data.rows.length; i++) {
      var r = data.rows[i];
      if (String(r.EmpID||'').replace(/\.0$/,'').trim().toUpperCase() !== empId) continue;
      if (String(r.Type||'').toUpperCase() !== type) continue;
      var st = String(r.Status||'').toUpperCase();
      if (st !== 'PENDING' && st !== 'APPROVED') continue;
      var rf = _toISO(r.DateFrom), rt = _toISO(r.DateTo || r.DateFrom);
      if (rf && rt && !(to < rf || from > rt)) {
        throw new Error('มีคำขอ ' + type + ' สถานะ ' + st + ' คาบเกี่ยวช่วงวันนี้อยู่แล้ว (' + r.ReqID + ')');
      }
    }
    var now = _nowStamp();
    var rec = {
      ReqID: _nextReqId(data.rows, type, _stampDate(now)),
      Type: type, EmpID: empId, Name: _staffName(staff), SubType: subType,
      DateFrom: from, DateTo: to, Days: days.length, Hours: hours || '',
      TimeFrom: body.timeFrom ? _toHHMM(body.timeFrom) : '',
      TimeTo:   body.timeTo   ? _toHHMM(body.timeTo)   : '',
      Flight: flight, Reason: reason, Status: 'PENDING',
      CreatedAt: now, CreatedBy: actor.id
    };
    _appendRow(sh, data.header.length ? data.header : REQ_HEADERS, rec);
    _log(actor.id, 'submitRequest', rec.ReqID + ' ' + empId + ' ' + from + '..' + to);
    return {ok: true, reqId: rec.ReqID};
  } finally { try { lock.releaseLock(); } catch (e) {} }
}

// body: {token, reqId, decision:'APPROVE'|'REJECT', note?}
function apiDecideRequest(body) {
  var actor = _auth(body, 'SUPERVISOR');
  var reqId = String(body.reqId || '').trim();
  var decision = String(body.decision || '').toUpperCase();
  if (decision !== 'APPROVE' && decision !== 'REJECT') throw new Error('decision ต้องเป็น APPROVE หรือ REJECT');
  var lock = _lock();
  try {
    var sh = _tab(TABS.REQ, REQ_HEADERS);
    var data = _rows(sh);
    var rec = null;
    for (var i = 0; i < data.rows.length; i++) {
      if (String(data.rows[i].ReqID||'').trim() === reqId) { rec = data.rows[i]; break; }
    }
    if (!rec) throw new Error('ไม่พบคำขอ ' + reqId);
    var empId = String(rec.EmpID||'').replace(/\.0$/,'').trim().toUpperCase();
    if (empId === actor.id) throw new Error('อนุมัติคำขอของตัวเองไม่ได้');
    if (String(rec.Status||'').toUpperCase() === 'CANCELLED') throw new Error('คำขอถูกยกเลิกแล้ว');
    rec.Status = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    rec.DecidedAt = _nowStamp(); rec.DecidedBy = actor.id;
    rec.DecideNote = String(body.note || '').slice(0, 300);
    _writeRow(sh, data.header, rec._row, rec);
    if (String(rec.Type||'').toUpperCase() === 'OT') {
      _refreshAttDays(empId, _dateRange(_toISO(rec.DateFrom), _toISO(rec.DateTo || rec.DateFrom)), actor.id);
    }
    _log(actor.id, 'decideRequest', reqId + ' → ' + rec.Status);
    return {ok: true, reqId: reqId, status: rec.Status};
  } finally { try { lock.releaseLock(); } catch (e) {} }
}

// body: {token, reqId}
function apiCancelRequest(body) {
  var actor = _auth(body, 'STAFF');
  var reqId = String(body.reqId || '').trim();
  var lock = _lock();
  try {
    var sh = _tab(TABS.REQ, REQ_HEADERS);
    var data = _rows(sh);
    var rec = null;
    for (var i = 0; i < data.rows.length; i++) {
      if (String(data.rows[i].ReqID||'').trim() === reqId) { rec = data.rows[i]; break; }
    }
    if (!rec) throw new Error('ไม่พบคำขอ ' + reqId);
    var empId = String(rec.EmpID||'').replace(/\.0$/,'').trim().toUpperCase();
    var isSup = (ROLES[actor.role] || 0) >= ROLES.SUPERVISOR;
    if (empId !== actor.id && !isSup) throw new Error('ยกเลิกได้เฉพาะเจ้าของคำขอหรือหัวหน้างาน');
    var st = String(rec.Status||'').toUpperCase();
    if (st === 'CANCELLED') return {ok: true, reqId: reqId, status: st};
    if (st === 'APPROVED' && !isSup) throw new Error('คำขอที่อนุมัติแล้ว ยกเลิกได้เฉพาะหัวหน้างาน');
    rec.Status = 'CANCELLED';
    rec.DecidedAt = _nowStamp(); rec.DecidedBy = actor.id; rec.DecideNote = 'cancelled';
    _writeRow(sh, data.header, rec._row, rec);
    if (String(rec.Type||'').toUpperCase() === 'OT') {
      _refreshAttDays(empId, _dateRange(_toISO(rec.DateFrom), _toISO(rec.DateTo || rec.DateFrom)), actor.id);
    }
    _log(actor.id, 'cancelRequest', reqId);
    return {ok: true, reqId: reqId, status: 'CANCELLED'};
  } finally { try { lock.releaseLock(); } catch (e) {} }
}

// ───────────────────────────────────────────────────────────────────────
// BOOTSTRAP + SUMMARY
// ───────────────────────────────────────────────────────────────────────
function apiBootstrap(body) {
  var actor = _auth(body, 'STAFF');
  var d = _toISO(body.date) || _todayISO();
  var from = _toISO(body.from) || d.slice(0, 7) + '-01';
  var to = _toISO(body.to) || d;
  var isSup = (ROLES[actor.role] || 0) >= ROLES.SUPERVISOR;
  var att = pullAttendance(from, to);
  var reqs = pullRequests();
  if (!isSup) {   // STAFF เห็นเฉพาะของตัวเอง
    att = att.filter(function(r){ return r.empId === actor.id; });
    reqs = reqs.filter(function(r){ return r.empId === actor.id; });
  }
  return {
    ok: true, user: actor, date: d, from: from, to: to, now: _nowStamp(),
    staff: isSup ? pullStaffAll() : pullStaffAll().filter(function(s){ return s.i === actor.id; }),
    users: actor.role === 'ADMIN' ? pullUsers() : [],
    attendance: att, requests: reqs,
    leaveTypes: ATT.LEAVE_TYPES,
    cfg: {lateGrace: ATT.LATE_GRACE_MIN, otRound: ATT.OT_ROUND_MIN,
          weekLimit: ATT.WEEK_LIMIT_HRS, maxOtReq: ATT.MAX_OT_REQ_HRS}
  };
}

function _summaryRows(from, to) {
  var att = pullAttendance(from, to);
  var reqs = pullRequests();
  var byEmp = {}, byDay = {};
  function slot(id, name) {
    if (!byEmp[id]) byEmp[id] = {empId: id, name: name || '', days: 0, regHrs: 0, otActual: 0,
                                 otApproved: 0, otPayable: 0, late: 0, earlyOut: 0, noOut: 0,
                                 otUnapproved: 0, leaveDays: 0, flights: {}};
    if (name && !byEmp[id].name) byEmp[id].name = name;
    return byEmp[id];
  }
  att.forEach(function(r){
    var e = slot(r.empId, r.name);
    e.days++; e.regHrs += r.regHrs; e.otActual += r.otActual;
    e.otApproved += r.otApproved; e.otPayable += r.otPayable;
    if (r.flags.indexOf('LATE') >= 0) e.late++;
    if (r.flags.indexOf('EARLY_OUT') >= 0) e.earlyOut++;
    if (r.flags.indexOf('NO_OUT') >= 0) e.noOut++;
    if (r.flags.indexOf('OT_UNAPPROVED') >= 0) e.otUnapproved++;
    String(r.flights||'').split(/[,\s\/]+/).forEach(function(f){ if (f) e.flights[f.toUpperCase()] = 1; });
    if (!byDay[r.date]) byDay[r.date] = {date: r.date, headcount: 0, regHrs: 0, otPayable: 0};
    if (r.workHrs > 0 || r.status === 'OPEN') byDay[r.date].headcount++;
    byDay[r.date].regHrs += r.regHrs; byDay[r.date].otPayable += r.otPayable;
  });
  reqs.forEach(function(q){
    if (q.type !== 'LEAVE' || q.status !== 'APPROVED') return;
    var a = q.dateFrom < from ? from : q.dateFrom;
    var b = q.dateTo > to ? to : q.dateTo;
    if (b < a) return;
    slot(q.empId, q.name).leaveDays += _dateRange(a, b).length;
  });
  var emps = Object.keys(byEmp).map(function(k){
    var e = byEmp[k];
    e.flightCount = Object.keys(e.flights).length; delete e.flights;
    ['regHrs','otActual','otApproved','otPayable'].forEach(function(f){ e[f] = _round2(e[f]); });
    return e;
  }).sort(function(a,b){ return a.empId < b.empId ? -1 : 1; });
  var daysArr = Object.keys(byDay).sort().map(function(k){
    byDay[k].regHrs = _round2(byDay[k].regHrs); byDay[k].otPayable = _round2(byDay[k].otPayable);
    return byDay[k];
  });
  return {emps: emps, days: daysArr};
}

function apiSummary(body) {
  var actor = _auth(body, 'SUPERVISOR');
  var from = _toISO(body.from), to = _toISO(body.to);
  if (!from || !to) throw new Error('ระบุช่วงวันที่');
  return Object.assign({ok: true, from: from, to: to}, _summaryRows(from, to));
}

// ───────────────────────────────────────────────────────────────────────
// EXCEL EXPORT — เอกสารตรวจรับตาม TOR §3.2.2 / §3.2.3 / §12
//   สร้าง Google Sheet ชั่วคราว → export .xlsx → คืน base64 + ลิงก์ไฟล์
// ───────────────────────────────────────────────────────────────────────
function apiExportExcel(body) {
  var actor = _auth(body, 'SUPERVISOR');
  var from = _toISO(body.from), to = _toISO(body.to);
  if (!from || !to) throw new Error('ระบุช่วงวันที่');
  if (to < from) { var s = from; from = to; to = s; }
  if (_dateRange(from, to).length > 92) throw new Error('ช่วง export ไม่เกิน 3 เดือน');

  var att = pullAttendance(from, to);
  var reqs = pullRequests();
  var sum = _summaryRows(from, to);
  var title = 'ตรวจรับ Outsource ' + from + ' ถึง ' + to;
  var ss = SpreadsheetApp.create(title);

  // ── Sheet 1: Daily Attendance (TOR §3.2.1 + §12.1) ──
  var sh1 = ss.getSheets()[0];
  sh1.setName('Daily Attendance');
  var rows1 = [['เอกสารลงเวลาปฏิบัติงานประจำวัน (Daily Attendance) ช่วงวันที่ ' + from + ' ถึง ' + to],
               ['วันที่','รหัสพนักงาน','ชื่อ-สกุล','กะ (เวลาตามแผน)','จุดปฏิบัติงาน','เที่ยวบินที่รับผิดชอบ',
                'เวลาเข้า (จริง)','เวลาออก (จริง)','ชม.ปกติ','ชม.OT ทำจริง','ชม.OT อนุมัติ','ชม.OT นับจ่าย',
                'สถานะ/ธง','หมายเหตุ','ผู้บันทึกเข้า','ผู้บันทึกออก']];
  att.slice().sort(function(a,b){
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.empId < b.empId ? -1 : 1;
  }).forEach(function(r){
    rows1.push([r.date, r.empId, r.name, r.shift, r.station, r.flights,
                _stampTime(r.inAt) || '', _stampTime(r.outAt) || (r.outAt ? r.outAt : ''),
                r.regHrs || 0, r.otActual || 0, r.otApproved || 0, r.otPayable || 0,
                r.flags.join(' '), r.note, r.inBy, r.outBy]);
  });
  rows1.push([]);
  rows1.push(['ลงชื่อผู้ควบคุมงานผู้รับจ้าง ................................................',
              '', '', '', '',
              'ลงชื่อผู้ควบคุมงาน บพท. ................................................']);
  _sheetFill(sh1, rows1, 2);

  // ── Sheet 2: Timesheet รายบุคคล (matrix วัน × คน) ──
  var days = _dateRange(from, to);
  var sh2 = ss.insertSheet('Timesheet');
  var head2 = ['รหัส','ชื่อ-สกุล'].concat(days.map(function(d){ return d.slice(8); }))
                .concat(['วันทำงาน','ชม.ปกติ','ชม.OT นับจ่าย']);
  var rows2 = [['ใบบันทึกเวลาทำงาน (Timesheet) ' + from + ' ถึง ' + to + ' — ในช่อง: เวลาเข้า-ออกจริง'], head2];
  var attByEmpDay = {};
  att.forEach(function(r){ attByEmpDay[r.empId + '|' + r.date] = r; });
  sum.emps.forEach(function(e){
    var row = [e.empId, e.name];
    days.forEach(function(d){
      var r = attByEmpDay[e.empId + '|' + d];
      row.push(r && r.inAt ? (_stampTime(r.inAt) + '-' + (_stampTime(r.outAt) || '…')) : '');
    });
    row.push(e.days, e.regHrs, e.otPayable);
    rows2.push(row);
  });
  _sheetFill(sh2, rows2, 2);

  // ── Sheet 3: OT Timesheet (TOR §3.1.3) ──
  var sh3 = ss.insertSheet('OT Timesheet');
  var rows3 = [['ใบบันทึกเวลาปฏิบัติงานล่วงเวลา (OT Timesheet) ' + from + ' ถึง ' + to],
               ['เลขที่คำขอ','วันที่','รหัสพนักงาน','ชื่อ-สกุล','เวลาเริ่ม','เวลาสิ้นสุด','ชม.OT ขอ/อนุมัติ',
                'ชม.OT ทำจริง','ชม.OT นับจ่าย','เที่ยวบิน','เหตุผลความจำเป็น','สถานะ','ผู้อนุมัติ','วันที่อนุมัติ']];
  reqs.filter(function(q){ return q.type === 'OT' && !(q.dateTo < from || q.dateFrom > to); })
      .forEach(function(q){
    _dateRange(q.dateFrom < from ? from : q.dateFrom, q.dateTo > to ? to : q.dateTo).forEach(function(d){
      var a = attByEmpDay[q.empId + '|' + d];
      rows3.push([q.reqId, d, q.empId, q.name, q.timeFrom, q.timeTo, q.hours,
                  a ? a.otActual : 0, a ? a.otPayable : 0,
                  q.flight, q.reason, q.status, q.decidedBy, _stampDate(q.decidedAt)]);
    });
  });
  _sheetFill(sh3, rows3, 2);

  // ── Sheet 4: Leave ──
  var sh4 = ss.insertSheet('Leave');
  var rows4 = [['บันทึกการลา ' + from + ' ถึง ' + to],
               ['เลขที่คำขอ','ประเภท','รหัสพนักงาน','ชื่อ-สกุล','ตั้งแต่','ถึง','จำนวนวัน',
                'เหตุผล','สถานะ','ผู้อนุมัติ','วันที่อนุมัติ']];
  reqs.filter(function(q){ return q.type === 'LEAVE' && !(q.dateTo < from || q.dateFrom > to); })
      .forEach(function(q){
    rows4.push([q.reqId, q.subType + ' ' + (ATT.LEAVE_TYPES[q.subType] || ''), q.empId, q.name,
                q.dateFrom, q.dateTo, q.days, q.reason, q.status, q.decidedBy, _stampDate(q.decidedAt)]);
  });
  _sheetFill(sh4, rows4, 2);

  // ── Sheet 5: Summary (TOR §3.2.3 + §12.2) ──
  var sh5 = ss.insertSheet('Summary');
  var rows5 = [['สรุปประกอบการตรวจรับ (ตาม TOR ข้อ 3.2.3) ' + from + ' ถึง ' + to], [],
               ['สรุปรายบุคคล'],
               ['รหัสพนักงาน','ชื่อ-สกุล','วันทำงานจริง','ชม.ทำงานปกติ','ชม.OT ทำจริง','ชม.OT อนุมัติ',
                'ชม.OT นับจ่าย','จำนวนเที่ยวบิน','มาสาย (ครั้ง)','ออกก่อน (ครั้ง)','ไม่เช็คเอาท์ (ครั้ง)','วันลา']];
  var tot = {days:0, reg:0, ota:0, otap:0, otp:0, fl:0};
  sum.emps.forEach(function(e){
    rows5.push([e.empId, e.name, e.days, e.regHrs, e.otActual, e.otApproved, e.otPayable,
                e.flightCount, e.late, e.earlyOut, e.noOut, e.leaveDays]);
    tot.days += e.days; tot.reg += e.regHrs; tot.ota += e.otActual;
    tot.otap += e.otApproved; tot.otp += e.otPayable; tot.fl += e.flightCount;
  });
  rows5.push(['รวม', '', tot.days, _round2(tot.reg), _round2(tot.ota), _round2(tot.otap), _round2(tot.otp), tot.fl, '', '', '', '']);
  rows5.push([]);
  rows5.push(['จำนวนพนักงานปฏิบัติงานจริงรายวัน']);
  rows5.push(['วันที่','จำนวนพนักงาน (คน)','ชม.ทำงานปกติรวม','ชม.OT นับจ่ายรวม']);
  sum.days.forEach(function(d){ rows5.push([d.date, d.headcount, d.regHrs, d.otPayable]); });
  _sheetFill(sh5, rows5, 4);

  SpreadsheetApp.flush();
  var fileId = ss.getId();
  var xlsxB64 = '', xlsxErr = '';
  try {
    var resp = UrlFetchApp.fetch(
      'https://docs.google.com/spreadsheets/d/' + fileId + '/export?format=xlsx',
      {headers: {Authorization: 'Bearer ' + ScriptApp.getOAuthToken()}, muteHttpExceptions: true});
    if (resp.getResponseCode() === 200) xlsxB64 = Utilities.base64Encode(resp.getBlob().getBytes());
    else xlsxErr = 'export HTTP ' + resp.getResponseCode();
  } catch (e) { xlsxErr = e.message || String(e); }

  _log(actor.id, 'exportExcel', from + '..' + to + ' rows=' + att.length + (xlsxErr ? ' xlsxErr=' + xlsxErr : ''));
  return {ok: true, from: from, to: to,
          filename: 'ตรวจรับ_Outsource_' + from + '_' + to + '.xlsx',
          sheetUrl: 'https://docs.google.com/spreadsheets/d/' + fileId + '/edit',
          xlsx: xlsxB64, xlsxError: xlsxErr};
}

function _sheetFill(sh, rows, headerRow) {
  var w = rows.reduce(function(m, r){ return Math.max(m, r.length); }, 1);
  var grid = rows.map(function(r){
    var c = r.slice(); while (c.length < w) c.push('');
    return c;
  });
  sh.getRange(1, 1, grid.length, w).setValues(grid);
  try {
    sh.getRange(headerRow, 1, 1, w).setFontWeight('bold').setBackground('#e8eaed');
    sh.setFrozenRows(headerRow);
    for (var c = 1; c <= w; c++) sh.autoResizeColumn(c);
  } catch (e) {}
}

// ───────────────────────────────────────────────────────────────────────
// Entry points
// ───────────────────────────────────────────────────────────────────────
function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || '';
  if (!action) {
    return HtmlService.createHtmlOutputFromFile('Index')
      .setTitle(CFG.APP_NAME)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  if (action === 'ping') return _json({ok: true, app: CFG.APP_NAME, now: _nowStamp()});
  return _json({error: 'unknown action'});
}

// google.script.run gateway — ทุก call ผ่านฟังก์ชันเดียว ตรวจ token ในแต่ละ api*
var API = {
  login:          apiLogin,
  bootstrap:      apiBootstrap,
  punch:          apiPunch,
  saveAttendance: apiSaveAttendance,
  submitRequest:  apiSubmitRequest,
  decideRequest:  apiDecideRequest,
  cancelRequest:  apiCancelRequest,
  saveStaff:      apiSaveStaff,
  saveUser:       apiSaveUser,
  summary:        apiSummary,
  exportExcel:    apiExportExcel
};
function api(name, body) {
  try {
    var fn = API[name];
    if (!fn) throw new Error('unknown api: ' + name);
    return fn(body || {});
  } catch (err) {
    return {error: err.message || String(err)};
  }
}

function _json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ───────────────────────────────────────────────────────────────────────
// SETUP — รันครั้งแรกจาก editor: สร้าง DB + ผู้ดูแลระบบคนแรก
// ───────────────────────────────────────────────────────────────────────
function SETUP_createAdmin() {
  var ADMIN_ID = 'ADMIN';       // แก้ได้
  var ADMIN_PIN = '123456';     // ⚠ เปลี่ยนทันทีหลัง login ครั้งแรก
  _tab(TABS.STAFF, STAFF_HEADERS); _tab(TABS.ATT, ATT_HEADERS); _tab(TABS.REQ, REQ_HEADERS);
  _upsertUser(ADMIN_ID, 'ADMIN', ADMIN_PIN, 'SETUP');
  var sh = _tab(TABS.STAFF, STAFF_HEADERS);
  if (!_staffById(ADMIN_ID)) {
    _appendRow(sh, STAFF_HEADERS, {EmpID: ADMIN_ID, Name: 'System', Surname: 'Admin', Position: 'ADMIN',
                                   Active: 'Yes', UpdatedAt: _nowStamp(), UpdatedBy: 'SETUP'});
  }
  Logger.log('DB: https://docs.google.com/spreadsheets/d/' + _dbId() + '/edit');
  Logger.log('Login: ' + ADMIN_ID + ' / PIN ' + ADMIN_PIN + '  ← เปลี่ยน PIN หลัง login');
}

function TEST_ping() { Logger.log(JSON.stringify({db: _dbId(), now: _nowStamp()})); }
